import { EngineError, hash, id, now, type Persistence, type FrontierItem } from '@interaction/core';
import { classifyControlsSchema, revokeControlClassificationSchema, controlClassificationConditions, controlClassificationKey, classificationMatches, isNonInteractiveClassification, classificationCorrespondenceConditions,
  type Control, type Observation, type ActionCandidate, type ClassifyControlsInput, type ControlClassificationRecord, type ControlClassificationMaterial, type RevokeControlClassificationInput } from '@interaction/adapter-playwright';

export interface ClassificationEvidenceRef {
  sessionId: string; observationId: string; classificationId: string; classification: 'display' | 'container';
}
export interface RetainedClassificationEvidence {
  source: ClassificationEvidenceRef;
  retained: boolean;
  /** Unique target in the exact retained observation; absent when unverified. */
  localId?: string;
  reason: 'historical_classification_retained' | 'classification_revoked_or_replaced' | 'classification_evidence_unavailable';
  /** Retention is historical evidence only. Current applicability requires a fresh interpretation. */
  currentApplicability: false; executionAuthorized: false;
}
export interface ClassificationCorrespondenceRequest { localId:string;source:ClassificationEvidenceRef }
export interface ClassificationCorrespondence {
  applicable:boolean;reason:string;source:ClassificationEvidenceRef;target:{sessionId:string;observationId:string;localId:string};classification:'display'|'container';
  identityAuthorized:false;executionAuthorized:false;currentExecution:false;evidence:string[];
}

/** Classifies one observed node. Descendants and supported capabilities are never suppressed. */
export class ControlClassifications {
  constructor(private store: Persistence, private emit: (sid: string, type: string, data: unknown) => unknown) {}
  private sourceRetained(record:ControlClassificationRecord) {
    if(!record.reuseFrom)return true;
    const source=this.store.get<ControlClassificationRecord>('control-classification',record.reuseFrom.classificationId);
    if(!source||source.reuseFrom||source.sessionId!==record.reuseFrom.sessionId||source.classification!==record.classification||['revoked','superseded'].includes(source.status))return false;
    const o=this.store.get<Observation>('observation',record.reuseFrom.observationId);
    return !!o&&o.sessionId===source.sessionId&&!o.gaps.some(g=>g.critical)&&o.controls.filter(c=>classificationMatches({...source,status:'active'},c,o)).length===1;
  }
  records(sid: string) {
    const validity=new Map<string,boolean>();
    return this.store.list<ControlClassificationRecord>('control-classification', sid).map(r=>{
      if(r.status!=='active'||!r.reuseFrom)return r;
      const key=hash(r.reuseFrom);if(!validity.has(key))validity.set(key,this.sourceRetained(r));
      return validity.get(key)?r:{...r,status:'invalidated' as const};
    });
  }
  private supported(c: Control, actions: ActionCandidate[]) {
    return Object.values(c.actionBasis || {}).some(b => b.status === 'supported') || actions.some(a => a.localId === c.localId && a.basis?.status === 'supported');
  }
  negative(c: Control, o: Observation, records = this.records(o.sessionId)) {
    return records.find(r => isNonInteractiveClassification(r.classification) && classificationMatches(r, c, o));
  }
  retainedEvidence(sources: ClassificationEvidenceRef[], current: Observation): RetainedClassificationEvidence[] {
    const groups=new Map<string,number[]>(),results:RetainedClassificationEvidence[]=[];
    sources.forEach((source,index)=>{const key=JSON.stringify([source.sessionId,source.observationId]),group=groups.get(key);if(group)group.push(index);else groups.set(key,[index]);});
    for(const indices of groups.values()){
      const records=new Map<string,ControlClassificationRecord|undefined>(),retained=new Map<string,boolean>();
      // Resolve reused classification ancestry before loading this group's
      // observation. Its temporary source graph must not add a third held
      // graph beside current + this group. Cache only record facts/booleans.
      for(const index of indices){
        const source=sources[index];
        if(!records.has(source.classificationId))records.set(source.classificationId,this.store.get<ControlClassificationRecord>('control-classification',source.classificationId));
        const record=records.get(source.classificationId);
        if(record?.sessionId===source.sessionId&&record.classification===source.classification&&!retained.has(record.id))
          retained.set(record.id,!['revoked','superseded'].includes(record.status)&&this.sourceRetained(record));
      }
      const ref=sources[indices[0]],o=[...retained.values()].some(Boolean)
        ? ref.observationId===current.id?current:this.store.get<Observation>('observation',ref.observationId):undefined;
      const targetsByRecord=new Map<string,string|undefined>();
      for(const index of indices){
        const source=sources[index],record=records.get(source.classificationId);
        let reason:RetainedClassificationEvidence['reason']='classification_evidence_unavailable',localId:string|undefined;
        if(record?.sessionId===source.sessionId&&record.classification===source.classification){
          if(!retained.get(record.id))reason='classification_revoked_or_replaced';
          // Invalidated by a later scene is still evidence about this retained scene.
          // Reuse the original condition matcher; it cannot authorize the current scene.
          else if(o?.sessionId===source.sessionId&&!o.gaps.some(g=>g.critical)){
            if(!targetsByRecord.has(record.id)){
              const targets=o.controls.filter(c=>classificationMatches({...record,status:'active'},c,o));
              targetsByRecord.set(record.id,targets.length===1?targets[0].localId:undefined);
            }
            localId=targetsByRecord.get(record.id);
            if(localId!==undefined)reason='historical_classification_retained';
          }
        }
        results[index]={source:{...source},retained:reason==='historical_classification_retained',...(localId?{localId}:{}),reason,currentApplicability:false,executionAuthorized:false};
      }
    }
    return results;
  }
  correspondences(o:Observation,actions:ActionCandidate[],requests:ClassificationCorrespondenceRequest[]) {
    const observations=new Map<string,Observation|undefined>([[o.id,o]]),projections=new Map<Observation,Map<string,ReturnType<typeof classificationCorrespondenceConditions>>>();
    const projection=(observed:Observation,c:Control)=>{let values=projections.get(observed);if(!values){values=new Map();projections.set(observed,values);}if(!values.has(c.localId))values.set(c.localId,classificationCorrespondenceConditions(c,observed));return values.get(c.localId);};
    const sourceKeys=requests.map(r=>hash(r.source)),sources=new Map(requests.map((r,i)=>[sourceKeys[i],r.source]));
    const retainedResults=this.retainedEvidence([...sources.values()],o);
    const retained=new Map([...sources.keys()].map((key,index)=>[key,retainedResults[index]])),sourceStates:unknown[]=[];
    const originalTargets=new Map<string,Control[]>();
    const results=requests.map(({localId,source},index):ClassificationCorrespondence=>{
      const result:ClassificationCorrespondence={applicable:false,reason:'classification_evidence_unavailable',source:{...source},target:{sessionId:o.sessionId,observationId:o.id,localId},classification:source.classification,identityAuthorized:false,executionAuthorized:false,currentExecution:false,evidence:[]};
      const record=this.store.get<ControlClassificationRecord>('control-classification',source.classificationId);sourceStates.push(record&&[record.id,record.status,record.reuseFrom]);
      if(!isNonInteractiveClassification(source.classification)||!record||record.reuseFrom){result.reason='original_negative_classification_required';return result;}
      const retainedSource=retained.get(sourceKeys[index])!;
      if(!retainedSource.retained){result.reason=retainedSource.reason;return result;}
      if(!observations.has(source.observationId))observations.set(source.observationId,this.store.get<Observation>('observation',source.observationId));
      const before=observations.get(source.observationId),target=o.controls.filter(c=>c.localId===localId);
      if(!before||before.sessionId!==source.sessionId||target.length!==1){result.reason='target_missing_or_ambiguous';return result;}
      if(!originalTargets.has(sourceKeys[index]))originalTargets.set(sourceKeys[index],before.controls.filter(c=>classificationMatches({...record,status:'active'},c,before)));
      const originals=originalTargets.get(sourceKeys[index])!;
      if(originals.length!==1){result.reason='source_classification_ambiguous';return result;}
      if(this.supported(target[0],actions)){result.reason='supported_operation_present';return result;}
      const a=projection(before,originals[0]),b=projection(o,target[0]);
      if(!a||!b){result.reason='classification_conditions_incomplete';return result;}
      if(a.identityKey!==b.identityKey){result.reason='target_correspondence_missing';return result;}
      // Missing/truncated evidence must not erase a rival target. Count semantic
      // candidates before requiring a portable projection, conservatively across
      // regions; a complete subtree cannot manufacture uniqueness on its own.
      const signature=(c:Control)=>hash({tag:c.tag,role:c.role,name:c.name,label:c.label}),candidate=signature(target[0]);
      if([before,o].some(observed=>observed.controls.filter(c=>signature(c)===candidate).length!==1)){result.reason='target_correspondence_ambiguous';return result;}
      if(a.conditionKey!==b.conditionKey){result.reason='classification_conditions_changed';return result;}
      result.applicable=true;result.reason='equivalent_classification_conditions';result.evidence=[...b.evidence,`classification:${record.id}`,`observation:${before.id}`,`observation:${o.id}`];return result;
    });
    return {sessionId:o.sessionId,observationId:o.id,revision:hash({observationId:o.id,sourceStates,results}),results};
  }
  negativeTargets(o: Observation, records = this.records(o.sessionId)) {
    return new Set(o.controls.filter(c => this.negative(c, o, records)).map(c => c.localId));
  }
  material(o: Observation, actions: ActionCandidate[], records = this.records(o.sessionId)): ControlClassificationMaterial {
    const controls = o.controls.filter(c => c.visible).map(control => {
      const candidates = actions.filter(a => a.localId === control.localId);
      const classifications = records.filter(r => r.conditions.target.instanceScope === o.instanceScope && r.conditions.target.target.instanceId === control.instanceId);
      return { control, actions: candidates, classifications,
        needsClassification: !control.readOnly && !this.supported(control, candidates) && !classifications.some(r => classificationMatches(r, control, o)) };
    });
    return { sessionId: o.sessionId, observationId: o.id, url: o.url, instanceScope: o.instanceScope, context: o.context, gaps: o.gaps,
      controls, pendingControlIds: controls.filter(c => c.needsClassification).map(c => c.control.localId) };
  }
  request(o: Observation, actions: ActionCandidate[], channel: 'event' | 'hook' = 'event') {
    if (o.gaps.some(g => g.critical)) return false;
    const m = this.material(o, actions), requestId = `classification-request:${o.sessionId}:${channel}`;
    const key = m.pendingControlIds.length ? hash(m.controls.filter(c => c.needsClassification).map(c => controlClassificationConditions(c.control, o))) : null;
    const previous = this.store.get<{ key: string | null }>('control-classification-request', requestId);
    if (previous?.key === key) return false;
    this.store.put('control-classification-request', { id: requestId, sessionId: o.sessionId, key });
    if (key && channel === 'event') this.emit(o.sessionId, 'control.classification_requested', { observationId: o.id, localIds: m.pendingControlIds });
    return key !== null;
  }
  record(o: Observation, actions: ActionCandidate[], input: ClassifyControlsInput) {
    const parsed = classifyControlsSchema.parse(input);
    if (parsed.observationId !== o.id || o.gaps.some(g => g.critical)) throw new EngineError('STALE_CONTROL_CLASSIFICATION', 'Classify the latest complete observation');
    if (Object.values(o.context).some(c => c.status !== 'known')) throw new EngineError('UNKNOWN_REVIEW_CONTEXT', 'Resolve declared context before classifying controls');
    const seen = new Set<string>();
    const records = parsed.classifications.map(classification => {
      const c = o.controls.find(c => c.localId === classification.localId);
      if (!c?.visible || seen.has(c.localId)) throw new EngineError('INVALID_CONTROL_CLASSIFICATION', 'Classify distinct visible current controls');
      seen.add(c.localId);
      if(classification.reuseFrom){
        if(classification.classification!==classification.reuseFrom.classification||!this.correspondences(o,actions,[{localId:c.localId,source:classification.reuseFrom}]).results[0].applicable)
          throw new EngineError('CLASSIFICATION_REUSE_INVALID','Retained classification does not apply to this current target');
      }
      if (isNonInteractiveClassification(classification.classification) && (this.supported(c, actions) || !c.classificationBinding || c.classificationBinding.truncated)) {
        throw new EngineError('INVALID_CONTROL_CLASSIFICATION', 'A negative classification requires complete bounded target structure and no supported operation');
      }
      const conditions = controlClassificationConditions(c, o);
      if (!conditions) throw new EngineError('INVALID_CONTROL_CLASSIFICATION', 'Current classification binding is unavailable');
      return { ...classification, id: id(), sessionId: o.sessionId, observationId: o.id, source: parsed.source, at: now(), status: 'active' as const,
        conditions, conditionKey: controlClassificationKey(conditions) };
    });
    const existing = this.records(o.sessionId);
    for (const record of records) {
      for (const old of existing.filter(r => r.status === 'active' && r.conditions.target.instanceScope === o.instanceScope && r.conditions.target.target.instanceId === record.conditions.target.target.instanceId)) {
        old.status = 'superseded'; old.replacedBy = record.id; this.store.put('control-classification', old); this.emit(o.sessionId, 'control.classification_superseded', old);
      }
      this.store.put('control-classification', record); this.emit(o.sessionId, 'control.classified', record);
    }
    return records;
  }
  revoke(sid: string, input: RevokeControlClassificationInput) {
    const { classificationId, source, reason } = revokeControlClassificationSchema.parse(input);
    const r = this.store.get<ControlClassificationRecord>('control-classification', classificationId);
    if (!r || r.sessionId !== sid) throw new EngineError('NOT_FOUND', 'Control classification not found');
    if (r.status === 'revoked') return r;
    r.status = 'revoked'; r.revocation = { source, reason, at: now() }; this.store.put('control-classification', r); this.emit(sid, 'control.classification_revoked', r); return r;
  }
  reconcile(o: Observation, actions: ActionCandidate[]) {
    if (o.gaps.some(g => g.critical)) return;
    for (const r of this.store.list<ControlClassificationRecord>('control-classification',o.sessionId).filter(r => r.status === 'active')) {
      const c = o.controls.find(c => c.instanceId === r.conditions.target.target.instanceId);
      if (!this.sourceRetained(r)||!c || !classificationMatches(r, c, o) || isNonInteractiveClassification(r.classification) && this.supported(c, actions)) {
        r.status = 'invalidated'; r.invalidation = { observationId: o.id, reason: 'classification_conditions_changed', at: now() };
        this.store.put('control-classification', r); this.emit(o.sessionId, 'control.classification_invalidated', r);
      }
    }
  }
  apply(actions: ActionCandidate[], o: Observation) {
    const negative = this.negativeTargets(o);
    return actions.filter(a => {
      const c = o.controls.find(c => c.localId === a.localId);
      return a.basis?.status === 'supported' || !c || !negative.has(c.localId);
    });
  }
  validate(a: ActionCandidate, o: Observation, records?:ControlClassificationRecord[]) {
    const c = o.controls.find(c => c.localId === a.localId);
    if (a.basis?.status !== 'supported' && c && this.negative(c, o, records)) throw new EngineError('CONTROL_CLASSIFIED_NONINTERACTIVE', 'Revoke or replace the classification before probing this target');
  }
  retire(o: Observation) {
    const negatives = this.records(o.sessionId).filter(r => r.status === 'active' && isNonInteractiveClassification(r.classification));
    if (!negatives.length) return;
    const retired: string[] = [];
    for (const f of this.store.list<FrontierItem>('frontier', o.sessionId)) {
      if (f.attempts.length || f.action.basis?.status === 'supported') continue;
      const source = this.store.get<Observation>('observation', f.action.observationId), c = source?.controls.find(c => c.localId === f.action.localId);
      const r = source && c && negatives.find(r => classificationMatches(r, c, source));
      if (!r || f.status === 'superseded' && f.reason === 'control_classified_noninteractive') continue;
      f.status = 'superseded'; f.reason = 'control_classified_noninteractive'; f.unblock = undefined;
      f.action = { ...f.action, basis: { status: 'tentative', evidence: [...f.action.basis?.evidence || [], { source: r.source, rule: 'classified-control/v1', facts: { classificationId: r.id, conditionKey: r.conditionKey, classification: r.classification, reason: r.reason, evidence: r.evidence } }] } };
      this.store.put('frontier', f); retired.push(f.id);
    }
    if (retired.length) this.emit(o.sessionId, 'frontier.updated', { reason: 'control_classification_changed', frontierIds: retired });
  }
}
