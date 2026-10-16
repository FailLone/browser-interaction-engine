import { isObservedUIOperation, canonical, contextKey, EngineError, hash, id, now, type Persistence, type FrontierItem } from '@interaction/core';
import { controlReviewSchema, revokeControlReviewSchema, reuseControlReviewsSchema, controlReviewConditions, controlReviewKey, controlReuseConditions, controlSurroundingsReader,
  type ActionCandidate, type ActionAttempt, type Control, type Observation, type ControlReviewInput, type ControlReviewRecord, type ControlReviewMaterial, type RevokeControlReviewInput, type ReuseControlReviewsInput } from '@interaction/adapter-playwright';

const rule = 'reviewed-control/v1';
const references = (a: ActionCandidate) => a.basis?.evidence.filter(e=>e.rule===rule).map(e=>e.facts.reviewId) || [];
/** Instance-bound external judgments. No native capability, identity or result is rewritten. */
export class ControlReviews {
  constructor(private store:Persistence,private emit:(sid:string,type:string,data:unknown)=>unknown,private nonInteractive:(o:Observation)=>Set<string>=()=>new Set()) {}
  private records(sid:string) { return this.store.list<ControlReviewRecord>('control-review',sid); }
  private sourceAvailable(r: ControlReviewRecord, seen = new Set<string>()): boolean {
    if (seen.size >= 64 || seen.has(r.id) || ['revoked', 'superseded'].includes(r.status)) return false;
    seen.add(r.id);
    if (!r.reusedFrom) return true;
    const source = this.store.get<ControlReviewRecord>('control-review', r.reusedFrom.reviewId);
    return !!source && source.sessionId === r.sessionId && this.sourceAvailable(source, seen);
  }
  private reuseKey(r: ControlReviewRecord) { return hash({ businessScope: r.reuse?.businessScope, conditions: r.reuseConditions }); }
  private reusable(r: ControlReviewRecord, c: Control, o: Observation) {
    return r.sessionId === o.sessionId && !!r.reuse && !!r.reuseConditions && this.sourceAvailable(r)
      && r.conditions.target.instanceId !== c.instanceId && canonical(r.reuseConditions) === canonical(controlReuseConditions(c, o, r.kind));
  }
  private reuseCandidates(c: Control, o: Observation, records: ControlReviewRecord[]) {
    return records.filter(r => this.reusable(r, c, o) && o.controls.filter(other => canonical(r.reuseConditions) === canonical(controlReuseConditions(other, o, r.kind))).length === 1)
      .map(review => ({ review, conditionKey: this.reuseKey(review), conditions: review.reuseConditions! }));
  }
  private matches(r:ControlReviewRecord,c:Control,o:Observation) {
    const conditions=controlReviewConditions(c,o,r.kind,r.exitBoundary,r.surroundingContextKey);
    return !!conditions && r.status==='active' && r.conditionKey===controlReviewKey(conditions)
      && this.sourceAvailable(r) && (!r.reusedFrom || canonical(r.reuseConditions) === canonical(controlReuseConditions(c,o,r.kind)))
      && (!r.exitBoundary || o.boundaries?.at(-1)?.key===r.exitBoundary);
  }
  /** Clarify an earlier unknown operation using the exact review consumed by a
   * real successful execution. This does not reuse that review for dispatch,
   * change captured actions, or equate a reconstructed DOM instance. */
  coverageProjection(action:ActionCandidate,o:Observation,attempt:ActionAttempt,before:Observation):{risk:'interface';basis:NonNullable<ActionCandidate['basis']>;evidence:string[]}|undefined {
    const prior=attempt.action;
    if(attempt.status!=='succeeded'||!attempt.afterId||attempt.sessionId!==o.sessionId||before.sessionId!==o.sessionId||attempt.beforeId!==before.id
      ||action.sessionId!==o.sessionId||action.observationId!==o.id||prior.sessionId!==before.sessionId||prior.observationId!==before.id
      ||prior.risk!=='interface'||prior.basis?.status!=='supported'||action.kind!==prior.kind||!['unknown','interface'].includes(action.risk)
      ||action.risk==='interface'&&action.basis?.status==='supported'||!o.instanceScope||o.instanceScope!==before.instanceScope||!o.ruleVersion||o.ruleVersion!==before.ruleVersion)return;
    const times=[o.capturedAt,before.capturedAt,attempt.startedAt].map(Date.parse);
    if(times.some(time=>!Number.isFinite(time))||times[0]>times[1]||times[1]>times[2])return;
    const proofs=prior.basis.evidence.filter(e=>e.rule===rule);if(proofs.length!==1)return;
    const proof=proofs[0],review=typeof proof.facts.reviewId==='string'&&this.store.get<ControlReviewRecord>('control-review',proof.facts.reviewId);
    if(!review||review.sessionId!==o.sessionId||review.localId!==prior.localId||review.kind!==action.kind||review.risk!=='interface'||review.conditionKey!==proof.facts.conditionKey
      ||proof.facts.sourceObservationId!==review.observationId||proof.source!==review.source||controlReviewKey(review.conditions)!==review.conditionKey
      ||!['active','invalidated'].includes(review.status)||!this.sourceAvailable(review)||!Number.isFinite(Date.parse(review.at))||Date.parse(review.at)>times[2]
      ||review.status==='invalidated'&&review.invalidation?.observationId!==attempt.afterId)return;
    const old=before.controls.find(c=>c.localId===prior.localId),target=o.controls.find(c=>c.localId===action.localId);
    if(!old?.instanceId||old.instanceId!==target?.instanceId||[before,o].some(observation=>observation.controls.filter(c=>c.instanceId===old.instanceId).length!==1))return;
    const source=this.store.get<Observation>('observation',review.observationId),sourceTime=Date.parse(source?.capturedAt||'');
    if(!source||source.id!==review.observationId||source.sessionId!==o.sessionId||source.instanceScope!==o.instanceScope||source.ruleVersion!==o.ruleVersion
      ||!Number.isFinite(sourceTime)||sourceTime>Date.parse(review.at)||sourceTime>times[1])return;
    const reviewed=source.controls.find(c=>c.localId===review.localId&&c.instanceId===old.instanceId);
    if(!reviewed||source.controls.filter(c=>c.instanceId===old.instanceId).length!==1)return;
    // Captured data/name bindings participate in live target validation but
    // are not all present in the portable operation sample. A/B rebinding
    // cannot be hidden by a later clarification of the operation's purpose.
    if([target,reviewed].some(control=>canonical(control.reviewAttributes||{})!==canonical(old.reviewAttributes||{})))return;
    for(const [control,observation] of [[old,before],[target,o],[reviewed,source]] as const){
      const conditions=controlReviewConditions(control,observation,review.kind,review.exitBoundary,review.surroundingContextKey);
      if(!conditions||controlReviewKey(conditions)!==review.conditionKey)return;
    }
    if(action.basis?.evidence.some(e=>e.rule===rule&&e.facts.reviewId!==review.id))return;
    return {risk:'interface',basis:{status:'supported',evidence:[...(action.basis?.evidence||[]),proof]},
      evidence:[`historical-control-review:${review.id}`,'same-instance-exact-review-conditions','coverage-only-review-clarification']};
  }
  material(o:Observation,actions:ActionCandidate[],nonInteractive=this.nonInteractive(o)):ControlReviewMaterial {
    const observedUI=this.store.get<import('@interaction/adapter-playwright').Session>('session',o.sessionId)?.options.executionPolicy==='observed-ui';
    const records=this.records(o.sessionId),surroundings=controlSurroundingsReader(o);
    const controls=o.controls.filter(c=>c.visible).map(control=>{
      const candidates=actions.filter(a=>a.localId===control.localId);
      const reviews=records.filter(r=>r.conditions.target.instanceId===control.instanceId && r.conditions.instanceScope===o.instanceScope);
      const reviewed=(kind:string)=>reviews.some(r=>r.kind===kind&&this.matches(r,control,o));
      const needsReview=!control.readOnly && !nonInteractive.has(control.localId) && (!candidates.some(a=>a.basis?.status==='supported') && !Object.values(control.actionBasis||{}).some(b=>b.status==='supported') && !reviews.some(r=>this.matches(r,control,o))
        || candidates.some(a=>(a.basis?.status!=='supported'||a.risk==='unknown'&&!(observedUI&&isObservedUIOperation(a,o))||['operation_requires_review','navigation_requires_review'].includes(a.exclusionReason||''))&&!reviewed(a.kind)));
      return {control,...(needsReview?{surroundings:surroundings(control)}:{}),actions:candidates,reviews,needsReview,reuseCandidates:this.reuseCandidates(control,o,records)};
    });
    return {sessionId:o.sessionId,observationId:o.id,url:o.url,instanceScope:o.instanceScope,context:o.context,gaps:o.gaps,controls,pendingControlIds:controls.filter(c=>c.needsReview).map(c=>c.control.localId)};
  }
  request(o:Observation,actions:ActionCandidate[],channel:'event'|'hook'='event') {
    if (o.gaps.some(g=>g.critical)) return false;
    const m=this.material(o,actions);
    const requestId=`control-request:${o.sessionId}:${channel}`;
    if(!m.pendingControlIds.length){this.store.put('control-review-request',{id:requestId,sessionId:o.sessionId,key:null});return false;}
    const key=hash({document:o.instanceScope,url:o.url,context:o.context,controls:m.controls.filter(c=>c.needsReview).map(({control:c,actions,surroundings})=>({
      instance:c.instanceId,name:c.name,binding:c.reviewBinding,region:c.regionInstanceId,basis:c.actionBasis,surroundingContextKey:surroundings?.key,
      actions:actions.map(a=>[a.kind,a.risk,a.exclusionReason]),
    }))});
    if(this.store.get<{key:string}>('control-review-request',requestId)?.key===key)return false;
    this.store.put('control-review-request',{id:requestId,sessionId:o.sessionId,key});
    if(channel==='event')this.emit(o.sessionId,'control.review_requested',{observationId:o.id,localIds:m.pendingControlIds});return true;
  }
  record(o:Observation,input:ControlReviewInput, provenance?: ControlReviewRecord['reusedFrom'][]) {
    const parsed=controlReviewSchema.parse(input);
    if(parsed.observationId!==o.id||o.gaps.some(g=>g.critical))throw new EngineError('STALE_CONTROL_REVIEW','Review the latest complete observation');
    if(Object.values(o.context).some(v=>v.status!=='known'))throw new EngineError('UNKNOWN_REVIEW_CONTEXT','Resolve declared context before recording a control judgment');
    const seen=new Set<string>();
    // Validate the entire batch before replacing any active judgment.
    const records: ControlReviewRecord[]=parsed.reviews.map((review,index)=>{
      const key=canonical([review.localId,review.kind]);const c=o.controls.find(c=>c.localId===review.localId);
      if(seen.has(key)||!c?.visible)throw new EngineError('INVALID_CONTROL_REVIEW','Review distinct visible current control operations');seen.add(key);
      if(review.exitBoundary && o.boundaries?.at(-1)?.key!==review.exitBoundary)throw new EngineError('INVALID_CONTROL_REVIEW','Exit judgment must name the current boundary');
      if(review.kind==='click' && c.actionBasis?.click?.evidence.some(e=>e.facts.submitsForm===true))throw new EngineError('INVALID_CONTROL_REVIEW','A native submission cannot be reclassified by an interface judgment');
      const conditions=controlReviewConditions(c,o,review.kind,review.exitBoundary,review.surroundingContextKey);
      if(!conditions)throw new EngineError('INVALID_CONTROL_REVIEW','Current dispatch binding is unavailable');
      const reuseConditions = review.reuse ? controlReuseConditions(c,o,review.kind) : undefined;
      if(review.reuse && !reuseConditions)throw new EngineError('INVALID_CONTROL_REVIEW','Reusable purposes require complete ordinary-control evidence outside lists and active boundaries');
      return {...review,id:id(),sessionId:o.sessionId,observationId:o.id,source:parsed.source,at:now(),status:'active' as const,conditions,conditionKey:controlReviewKey(conditions),...(reuseConditions?{reuseConditions}:{}),...(provenance?.[index]?{reusedFrom:provenance[index]}:{})};
    });
    const existing=this.records(o.sessionId);
    for(const record of records){
      for(const old of existing.filter(r=>r.status==='active'&&r.conditions.instanceScope===o.instanceScope&&r.conditions.target.instanceId===record.conditions.target.instanceId&&r.kind===record.kind)){
        old.status='superseded';old.replacedBy=record.id;this.store.put('control-review',old);this.emit(o.sessionId,'control.review_superseded',old);
      }
      this.store.put('control-review',record);this.emit(o.sessionId,'control.review_recorded',record);
    }
    return records;
  }
  /** Explicitly issue new instance-bound judgments, never revive old approvals. */
  reuse(o: Observation, input: ReuseControlReviewsInput) {
    const parsed = reuseControlReviewsSchema.parse(input);
    if (parsed.observationId !== o.id) throw new EngineError('STALE_CONTROL_REVIEW', 'Read current reuse material before deciding');
    const sourceRecords = this.records(o.sessionId);
    const sources = parsed.reviews.map(ref => {
      const c = o.controls.find(c => c.localId === ref.localId);
      const match = c && this.reuseCandidates(c,o,sourceRecords).find(m => m.review.id === ref.reviewId && m.conditionKey === ref.conditionKey);
      if (!match || match.review.reuse!.businessScope !== parsed.businessScope) throw new EngineError('CONTROL_REVIEW_REUSE_MISMATCH','Source, business scope or current target conditions do not match; obtain a fresh judgment');
      return match.review;
    });
    const records = this.record(o, { observationId:o.id, source:parsed.source, reviews:sources.map((r,i) => ({
      localId:parsed.reviews[i].localId,kind:r.kind,risk:r.risk,replayable:false,reason:r.reason,
      evidence:parsed.evidence,samples:r.samples,reuse:r.reuse,
    })) }, sources.map((r,i)=>({reviewId:r.id,conditionKey:parsed.reviews[i].conditionKey,evidence:parsed.evidence})));
    for (const record of records) this.emit(o.sessionId,'control.review_reused',record);
    return records;
  }
  revoke(sid:string,input:RevokeControlReviewInput) {
    const {reviewId,source,reason}=revokeControlReviewSchema.parse(input);const r=this.store.get<ControlReviewRecord>('control-review',reviewId);
    if(!r||r.sessionId!==sid)throw new EngineError('NOT_FOUND','Control review not found');
    if(r.status==='revoked')return r;
    r.status='revoked';r.revocation={source,reason,at:now()};this.store.put('control-review',r);this.emit(sid,'control.review_revoked',r);
    for(const child of this.records(sid).filter(c=>c.status==='active'&&!this.sourceAvailable(c))){
      child.status='invalidated';child.invalidation={observationId:child.observationId,reason:'reuse_source_unavailable',at:now()};this.store.put('control-review',child);this.emit(sid,'control.review_invalidated',child);
    }
    return r;
  }
  reconcile(o:Observation) {
    if(o.gaps.some(g=>g.critical))return;
    for(const r of this.records(o.sessionId).filter(r=>r.status==='active')){
      const c=o.controls.find(c=>c.instanceId===r.conditions.target.instanceId);
      // Hidden nodes cannot be operated; recheck their complete binding when visible.
      const changed=r.conditions.instanceScope!==o.instanceScope||r.conditions.url!==o.url||contextKey(r.conditions.context)!==contextKey(o.context)
        || !c || c.visible&&!this.matches(r,c,o) || r.exitBoundary&&o.boundaries?.at(-1)?.key!==r.exitBoundary;
      if(changed){r.status='invalidated';r.invalidation={observationId:o.id,reason:'control_conditions_changed',at:now()};this.store.put('control-review',r);this.emit(o.sessionId,'control.review_invalidated',r);}
    }
  }
  apply(actions:ActionCandidate[],o:Observation) {
    let result=[...actions];
    for(const review of this.records(o.sessionId).filter(r=>r.status==='active')){
      const c=o.controls.find(c=>c.instanceId===review.conditions.target.instanceId);
      if(!c?.visible||!this.matches(review,c,o))continue;
      const existing=result.filter(a=>a.localId===c.localId&&a.kind===review.kind);
      // Adapter-level exclusions (such as invalid input) still require a valid supplied sample.
      const values=review.samples || (existing.length?existing.map(a=>a.value):['click','hover'].includes(review.kind)?[undefined]:[]);
      result=result.filter(a=>!existing.includes(a));
      for(const value of values){
        const base=existing.find(a=>canonical(a.value)===canonical(value));
        const action:ActionCandidate=base ? {...base,id:id()} : {id:id(),sessionId:o.sessionId,observationId:o.id,stateId:o.stateId,controlId:c.identityId,localId:c.localId,
          kind:review.kind,label:c.name||`Unnamed ${c.role}`,value,risk:review.risk,replayable:review.replayable,source:'control-review',excluded:false,sampleValidity:'shape_only',
          preconditions:{context:o.context,visible:c.visible,enabled:c.enabled,identityResolved:!c.hypothesisId}};
        const evidence:NonNullable<ActionCandidate['basis']>['evidence']=[...action.basis?.evidence||[],{source:review.source,rule,facts:{reviewId:review.id,conditionKey:review.conditionKey,sourceObservationId:review.observationId,reason:review.reason,evidence:review.evidence,...(review.surroundingContextKey?{surroundingContextKey:review.surroundingContextKey}:{})}}];
        if(review.reusedFrom)evidence.push({source:review.source,rule:'reused-control-review/v1',facts:{reviewId:review.id,sourceReviewId:review.reusedFrom.reviewId,conditionKey:review.reusedFrom.conditionKey,businessScope:review.reuse!.businessScope}});
        if(review.exitBoundary)evidence.push({source:review.source,rule:'declared-boundary-exit/v1',facts:{reviewId:review.id,boundaryKey:review.exitBoundary,observationId:o.id,localId:c.localId,evidence:review.evidence}});
        result.push({...action,risk:review.risk,replayable:review.replayable,source:'control-review',basis:{status:'supported',evidence}});
      }
    }
    return result;
  }
  validate(a:ActionCandidate,o:Observation) {
    for(const ref of references(a)){
      const r=typeof ref==='string'&&this.store.get<ControlReviewRecord>('control-review',ref);const c=o.controls.find(c=>c.localId===a.localId);
      if(!r||r.sessionId!==o.sessionId||r.kind!==a.kind||!c||!this.matches(r,c,o))throw new EngineError('CONTROL_REVIEW_EXPIRED','Observe and review this control again before dispatch');
    }
  }
  retire(o:Observation,actions:ActionCandidate[]) {
    const reviews=new Map(this.records(o.sessionId).map(r=>[r.id,r]));if(!reviews.size)return;
    const retired:string[]=[];
    for(const f of this.store.list<FrontierItem>('frontier',o.sessionId)){
      if(f.attempts.length)continue;
      const old=references(f.action);let reason=old.some(ref=>typeof ref!=='string'||reviews.get(ref)?.status!=='active')?'control_review_invalidated':undefined;
      if(!reason){
        const replacements=actions.filter(a=>a.localId===f.action.localId&&a.kind===f.action.kind&&references(a).length);
        const source=this.store.get<Observation>('observation',f.action.observationId);const c=source?.controls.find(c=>c.localId===f.action.localId);
        for(const a of replacements){
          if(canonical(old)===canonical(references(a)))continue;
          const r=reviews.get(references(a)[0] as string)!;
          const conditions=source&&c&&controlReviewConditions(c,source,r.kind,r.exitBoundary,r.surroundingContextKey);
          if(conditions&&controlReviewKey(conditions)===r.conditionKey){reason='control_review_replaced';break;}
        }
      }
      if(reason&&f.reason!==reason){f.status='superseded';f.reason=reason;f.unblock=undefined;this.store.put('frontier',f);retired.push(f.id);}
    }
    if(retired.length)this.emit(o.sessionId,'frontier.updated',{reason:'control_review_changed',frontierIds:retired});
  }
}
