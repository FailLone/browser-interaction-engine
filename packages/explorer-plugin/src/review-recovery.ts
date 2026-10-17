import { classificationCorrespondenceConditions, type ActionCandidate, type Checkpoint, type Observation } from '@interaction/browser';
import type { EvidenceRef, ExplorerHost, PlanItem, Task } from './types.js';
import { controlScopeMatcher, digest } from './policy.js';
import { controlReviewGapReasons } from './review-ledger.js';
import { isUnfinished } from './plan-state.js';
import { POLICY_VERSION } from './decision-policy.js';

export interface UnresolvedReview { localId:string; decisionId:string; kind:'purpose'|'probe' }
export interface ReviewRecoveryChange {
  itemId:string; source?:EvidenceRef; proof?:{source:EvidenceRef; sourceLocalId:string; localId:string; policy:string; identityKey:string; conditionKey:string};
  wait?:NonNullable<PlanItem['reviewRecoveryWait']>; clearWait?:boolean;
}
type Material=ReturnType<ExplorerHost['controlReviewMaterial']>['controls'][number];

/** Bind a negative scheduling decision to all captured review facts, including
 * missing-context reasons. Generated action/observation IDs are not new facts.
 * Real instance identity is retained: a new document must be reviewed afresh.
 */
export function reviewRecoveryMaterialKey(o:Observation,item:Material) {
  const actions=item.actions.map(({kind,label,value,risk,replayable,basis,excluded,exclusionReason,preconditions,sampleValidity})=>
    ({kind,label,value,risk,replayable,basis,excluded,exclusionReason,preconditions,sampleValidity}));
  return digest({policy:'review-recovery-material-v1',reviewPolicy:POLICY_VERSION,ruleVersion:o.ruleVersion,instance:o.instanceScope,url:o.url,context:o.context,
    gaps:o.gaps,boundaries:o.boundaries,control:item.control,surroundings:item.surroundings,actions,reviews:item.reviews.map(r=>[r.id,r.status,r.conditionKey]),needsReview:item.needsReview});
}
const known=(o:Pick<Observation,'gaps'|'context'>)=>!o.gaps.some(g=>g.critical)&&Object.values(o.context).every(c=>c.status==='known');
const signature=(c:Observation['controls'][number])=>digest({tag:c.tag,role:c.role,name:c.name,label:c.label});
const meaning=(task:Task,item:PlanItem)=>digest({goal:task.goal,coverageMode:task.coverageMode,scope:item.scope,sessionOptions:task.sessionOptions,reviewPolicy:POLICY_VERSION});
const activeTarget=(o:Observation,c:Observation['controls'][number])=>{
  const boundary=o.boundaries?.at(-1);return !boundary||!!o.overlays?.find(overlay=>overlay.key===boundary.key)?.controlIds.includes(c.localId);
};
export function validReviewRecoveryWait(task:Task,item:PlanItem,current:Observation,read:(id:string)=>Observation|undefined,
  readMaterial?:(id:string)=>ReturnType<ExplorerHost['controlReviewMaterial']>|undefined) {
  const wait=item.reviewRecoveryWait;
  if(!wait||wait.policy!=='review-recovery-wait-v1'||wait.meaningKey!==meaning(task,item)||wait.source.sessionId!==current.sessionId||!known(current)
    ||task.pendingDispatch||task.unverifiedRecoveries?.length||!task.rounds.some(r=>r.sessionId===wait.source.sessionId))return false;
  const source=read(wait.source.observationId);if(!source||source.id!==wait.source.observationId||source.sessionId!==wait.source.sessionId||!known(source)
    ||source.ruleVersion!==current.ruleVersion||digest(source.context)!==digest(current.context))return false;
  // A new browser does not inherit a negative review of an old instance.
  if(source.navigation&&current.navigation?source.navigation.browserSessionId!==current.navigation.browserSessionId:source.instanceScope!==current.instanceScope)return false;
  const targets=source.controls.filter(c=>c.localId===wait.localId),target=targets.length===1?targets[0]:undefined;
  if(!target||target.hypothesisId||!activeTarget(source,target)||source.controls.filter(c=>signature(c)===signature(target)).length!==1)return false;
  const conditions=classificationCorrespondenceConditions(target,source);
  if(conditions?.identityKey!==wait.identityKey||conditions.conditionKey!==wait.conditionKey)return false;
  // A captured control cannot certify mutable review/action records. Missing
  // historical material withdraws only this negative scheduling conclusion;
  // normal route, debt and dispatch gates remain responsible for any recovery.
  try{
    const material=readMaterial?.(source.id);
    if(material?.observationId!==source.id||material.sessionId!==source.sessionId)return false;
    const matches=material.controls.filter(row=>row.control.localId===target.localId);
    return matches.length===1&&matches[0].control.instanceId===target.instanceId&&matches[0].needsReview===true
      &&reviewRecoveryMaterialKey(source,matches[0])===wait.materialKey;
  }catch{return false;}
}

/** Scheduling evidence only. A portable SDK projection must exist on both
 * sides, including a complete subtree and captured IDREF/ownership facts.
 * Incomplete same-name rivals are counted before projection, as in the SDK's
 * classification correspondence query; they cannot manufacture uniqueness.
 */
export function reviewRecoveryChanges(task:Task,o:Observation,host:ExplorerHost,options:{checkpointId?:string;rejected?:UnresolvedReview[]}={}):ReviewRecoveryChange[] {
  const retain=!!options.checkpointId||!!options.rejected?.length;
  const items=task.plan.filter(i=>i.required&&i.dispatchScope===false&&isUnfinished(i)&&controlReviewGapReasons.has(i.reason)&&!i.scope.kind&&i.scope.value===undefined&&(retain||i.reviewRecoveryWait));
  if(!items.length)return [];
  const changes:ReviewRecoveryChange[]=[];
  if(!known(o))return items.filter(i=>i.reviewRecoveryWait).map(i=>({itemId:i.id,clearWait:true}));
  const assessment=host.recoveryAssessment(o.sessionId);
  if(assessment.unknownAttempts.length||assessment.blockingBoundaryExit||task.pendingDispatch)return [];
  const actions=host.actions(o.sessionId,o.id),inScope=controlScopeMatcher(o,actions),material=host.controlReviewMaterial(o.sessionId);
  if(material.observationId!==o.id)return [];
  const availability=host.actionAvailability(o.sessionId,o.id),sourceCache=new Map<string,{o:Observation;actions:ActionCandidate[]}|undefined>();
  const sourceFacts=(id:string)=>{
    if(!sourceCache.has(id)){
      try{sourceCache.set(id,id===o.id?{o,actions}:{o:host.observation(o.sessionId,id),actions:host.actions(o.sessionId,id)});}catch{sourceCache.set(id,undefined);}
      while(sourceCache.size>8)sourceCache.delete(sourceCache.keys().next().value!);
    }
    return sourceCache.get(id);
  };
  const materials=new Map<string,ReturnType<ExplorerHost['controlReviewMaterial']>|undefined>([[o.id,material]]);
  const readMaterial=(id:string)=>{
    if(!materials.has(id)){
      try{materials.set(id,host.recoveryReviewMaterial?.(o.sessionId,{observationId:id}));}catch{materials.set(id,undefined);}
      while(materials.size>8)materials.delete(materials.keys().next().value!);
    }
    return materials.get(id);
  };
  const projections=new WeakMap<Observation,Map<string,ReturnType<typeof classificationCorrespondenceConditions>>>(),signatureCounts=new WeakMap<Observation,Map<string,number>>();
  const projection=(observed:Observation,c:Observation['controls'][number])=>{
    let cache=projections.get(observed);if(!cache){cache=new Map();projections.set(observed,cache);}
    if(!cache.has(c.localId))cache.set(c.localId,classificationCorrespondenceConditions(c,observed));return cache.get(c.localId);
  };
  const unique=(observed:Observation,c:Observation['controls'][number])=>{
    let counts=signatureCounts.get(observed);if(!counts){counts=new Map();for(const candidate of observed.controls){const key=signature(candidate);counts.set(key,(counts.get(key)||0)+1);}signatureCounts.set(observed,counts);}
    return !c.hypothesisId&&counts.get(signature(c))===1;
  };
  const rejectedIds=new Set(options.rejected?.map(r=>r.localId));
  for(const item of items) {
    const change:ReviewRecoveryChange={itemId:item.id},targets=o.controls.filter(c=>c.visible&&inScope(item.scope,c)),target=targets.length===1?targets[0]:undefined;
    if(options.rejected?.length&&!options.checkpointId&&(!target||!rejectedIds.has(target.localId)))continue;
    if(item.reviewRecoveryWait&&!validReviewRecoveryWait(task,item,o,id=>sourceFacts(id)?.o,readMaterial))change.clearWait=true;
    // An absent target preserves only a still-verifiable negative review. An ambiguous
    // or changed current target cannot inherit that wait or become a new source.
    if(!targets.length){if(change.clearWait)changes.push(change);continue;}
    const current=target&&projection(o,target),review=target&&material.controls.find(m=>m.control.localId===target.localId);
    const ready=target&&actions.some(a=>a.localId===target.localId&&availability.actions.some(f=>f.actionId===a.id&&f.executable));
    if(!target||!activeTarget(o,target)||!unique(o,target)||!current||!review){if(item.reviewRecoveryWait)change.clearWait=true;if(change.clearWait)changes.push(change);continue;}
    const materialKey=reviewRecoveryMaterialKey(o,review);
    if(item.reviewRecoveryWait&&(ready||!review.needsReview||item.reviewRecoveryWait.materialKey!==materialKey))change.clearWait=true;
    if(!retain){if(change.clearWait)changes.push(change);continue;}
    let proof:ReviewRecoveryChange['proof'];
    for(const ref of [...item.evidence].reverse()) {
      if(ref.attemptId||ref.sessionId!==o.sessionId)continue;
      const source=sourceFacts(ref.observationId);if(!source||source.o.id!==ref.observationId||source.o.sessionId!==ref.sessionId||source.o.ruleVersion!==o.ruleVersion||!known(source.o))continue;
      const matchesScope=controlScopeMatcher(source.o,source.actions),matches=source.o.controls.filter(c=>c.visible&&matchesScope(item.scope,c));
      if(matches.length!==1||!activeTarget(source.o,matches[0])||!unique(source.o,matches[0]))continue;
      const old=projection(source.o,matches[0]);
      if(old?.identityKey!==current.identityKey||old.conditionKey!==current.conditionKey)continue;
      proof={source:{sessionId:ref.sessionId,observationId:ref.observationId},sourceLocalId:matches[0].localId,localId:target.localId,...current};break;
    }
    if(proof){
      if((options.checkpointId||options.rejected?.some(r=>r.localId===target.localId))&&!item.evidence.some(ref=>ref.sessionId===o.sessionId&&ref.observationId===o.id&&!ref.attemptId)){
        change.source={sessionId:o.sessionId,observationId:o.id};change.proof=proof;
      }
      const rejected=options.rejected?.filter(r=>r.localId===target.localId);
      if(rejected?.length&&review.needsReview&&!ready){
        change.wait={policy:'review-recovery-wait-v1',revision:task.revision,meaningKey:meaning(task,item),source:{sessionId:o.sessionId,observationId:o.id},localId:target.localId,
          identityKey:current.identityKey,conditionKey:current.conditionKey,materialKey,decisions:rejected.map(r=>({id:r.decisionId,kind:r.kind})),reason:'unchanged_unresolved_review'};
        change.proof=proof;delete change.clearWait;
      }
    }
    if(change.source||change.wait||change.clearWait)changes.push(change);
  }
  return changes;
}

/** A cost hint only; the adapter rechecks the exact native entry at dispatch. */
export type ReviewAnchorObservation=Pick<Observation,'url'|'navigation'|'context'|'gaps'>;
export function currentHistoryAnchor(source:ReviewAnchorObservation,current:ReviewAnchorObservation) {
  const from=source.navigation,live=current.navigation;
  if(!from||!live||from.browserSessionId!==live.browserSessionId||!known(source)||!known(current))return false;
  const entry=from.entries[from.currentIndex],at=live.entries[live.currentIndex];
  return !!entry&&!!at&&entry.url===source.url&&at.url===current.url&&entry.method==='GET'&&/^https?:\/\//.test(entry.url)
    &&live.entries.some(e=>e.id===entry.id&&e.url===entry.url&&e.method==='GET');
}

/** Stable native-first partition for a cooperative scan. Keep checkpoint refs,
 * not the full historical observations, after projecting each anchor boolean.
 * Short scans stay synchronous. After an actual yield the caller revalidates
 * captured inputs before the next source read, and again on awaiting the result.
 */
export function prioritizeReviewAnchors(checkpoints:Checkpoint[],current:Observation,read:(id:string)=>ReviewAnchorObservation|undefined):Checkpoint[];
export function prioritizeReviewAnchors(checkpoints:Checkpoint[],current:Observation,read:(id:string)=>ReviewAnchorObservation|undefined,scan:{checkpoint:()=>void|Promise<void>;resume:()=>void}):Checkpoint[]|Promise<Checkpoint[]>;
export function prioritizeReviewAnchors(checkpoints:Checkpoint[],current:Observation,read:(id:string)=>ReviewAnchorObservation|undefined,scan?:{checkpoint:()=>void|Promise<void>;resume:()=>void}):Checkpoint[]|Promise<Checkpoint[]> {
  const anchored:Checkpoint[]=[],other:Checkpoint[]=[];
  let index=0;
  const project=()=>{
    const candidate=checkpoints[index++],source=read(candidate.observationId);
    (source&&currentHistoryAnchor(source,current)?anchored:other).push(candidate);
  };
  const next=():Checkpoint[]|Promise<Checkpoint[]>=>{
    while(index<checkpoints.length){
      const wait=scan?.checkpoint();
      if(wait)return wait.then(()=>{scan!.resume();project();return next();});
      project();
    }
    return [...anchored,...other];
  };
  return next();
}
