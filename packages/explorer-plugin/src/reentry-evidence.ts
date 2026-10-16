import type {ActionAttempt,Observation} from '@interaction/browser';
import type {EntryRoute,Scope,Task} from './types.js';
import {digest,keyFor,matches,scopeForControl} from './policy.js';

// Review-assigned region labels may change without moving an occurrence. This
// projection is route evidence only, never scope permission or identity approval.
export function routeControl(scope:Scope):Scope {
  const {url,label,role,stableKey}=scope;
  return {url,...label?{label}:{},...role?{role}:{},...stableKey?{stableKey}:{}};
}
export function routeMatches(expected:Scope,actual:Scope) {
  const target=routeControl(expected),candidate=routeControl(actual);
  return !!(target.label||target.stableKey)&&Object.entries(target).every(([k,v])=>candidate[k as keyof Scope]===v);
}
function boundaryConditionKey(o:Observation):string|undefined {
  const conditions=[];
  for(const boundary of o.boundaries||[]){
    const overlay=o.overlays?.find(candidate=>candidate.key===boundary.key),region=o.regions.find(candidate=>candidate.key===boundary.region);
    if(!boundary.name||!overlay||!region)return;
    conditions.push({name:boundary.name,kind:overlay.kind,region:{label:region.label,role:region.role}});
  }
  return digest(conditions);
}
function routeBasisKey(attempt:ActionAttempt):string {
  const basis=attempt.action.basis;if(!basis)return digest(null);
  const reviewRules=new Set(['reviewed-control/v1','reused-control-review/v1','conditional-purpose-review/v1']);
  return digest({...basis,evidence:basis.evidence.map(e=>{
    if(!reviewRules.has(e.rule))return e;
    const {reviewId:_review,sourceReviewId:_sourceReview,sourceObservationId:_observation,evidence:_references,...facts}=e.facts;
    // Preserve opaque condition hashes and unknown rule facts conservatively.
    // They can retain extra revisions, but must not erase a newly valid source.
    return {...e,facts};
  })});
}
export function capturedRoute(entry:Scope,before:Observation,after:Observation,revealedIds:string[],attempt?:ActionAttempt):EntryRoute|undefined {
  if(attempt&&(attempt.status!=='succeeded'||attempt.sessionId!==before.sessionId||attempt.beforeId!==before.id||attempt.afterId!==after.id
    ||attempt.action.observationId!==before.id||!matches(entry,attempt.action,before)))return;
  if(before.sessionId!==after.sessionId||before.gaps.some(g=>g.critical)||after.gaps.some(g=>g.critical)||digest(before.context)!==digest(after.context)
    ||Object.values(before.context).some(c=>c.status!=='known')||Object.values(after.context).some(c=>c.status!=='known'))return;
  if(before.controls.filter(c=>routeMatches(entry,scopeForControl(c,before))).length!==1)return;
  const revealed=new Set(revealedIds),targets=after.controls.filter(c=>revealed.has(c.localId)&&c.visible).flatMap(c=>{
    const scope=routeControl(scopeForControl(c,after));
    if(!(scope.label||scope.stableKey)||after.controls.filter(other=>routeMatches(scope,scopeForControl(other,after))).length!==1)return [];
    return [scope];
  });
  if(!targets.length)return;
  return {entry,targets,context:digest(after.context),evidence:{sessionId:after.sessionId,beforeId:before.id,observationId:after.id,...(attempt?{attemptId:attempt.id}:{})},...(attempt?{
    sourceConditionKey:keyFor(attempt.action,before),sourcePolicy:{replayable:attempt.action.replayable,risk:attempt.action.risk,basisKey:routeBasisKey(attempt),
      ...(attempt.effectsAssessment?{effectsAssessment:attempt.effectsAssessment}:{}),...(attempt.executionProfile?{executionProfile:attempt.executionProfile}:{})},
    expected:{url:after.url,boundaryKeys:after.boundaries?.map(b=>b.key)||[],boundaryConditionKey:boundaryConditionKey(after)}}:{})};
}

/** Deduplicate the same observed route revision, not just its visible names.
 * A later source mode or replay-policy/basis revision must remain available to
 * fresh SDK assessment even when entry and revealed target labels are unchanged.
 * Direct evidence IDs and known named-boundary instance keys do not create a
 * revision. Opaque review conditions/unknown rule facts stay conservative.
 */
export function routeKey(route:EntryRoute):string {
  return digest({policy:'observed-route-revision-v1',entry:route.entry,targets:[...new Set(route.targets.map(digest))].sort(),context:route.context,
    sourceConditionKey:route.sourceConditionKey,sourcePolicy:route.sourcePolicy,expected:route.expected&&{url:route.expected.url,
      boundary:route.expected.boundaryConditionKey??route.expected.boundaryKeys}});
}
/** Prove a chain of actually observed reveals. Stored prerequisite prose alone
 * cannot justify replay; repeated cycles cannot manufacture a route. */
export function routeFinder(task:Task,entry:Scope,o:Pick<Observation,'context'>,firstEdgeAllowed?:(route:EntryRoute)=>boolean) {
  const context=digest(o.context),routes=task.rounds.flatMap(r=>r.entryRoutes||[]).filter(r=>r.context===context);
  let reachable:{scope:Scope;proof:EntryRoute[]}[]|undefined;
  return (target:Scope):EntryRoute[]|undefined=>{
    if(!(target.label||target.stableKey))return;
    if(!reachable){
      reachable=[];
      const queue:{scope:Scope;proof:EntryRoute[]}[]=[{scope:entry,proof:[]}],seen=new Set<string>();
      for(let index=0;index<queue.length;index++){
        const node=queue[index],key=digest(node.scope);if(seen.has(key))continue;seen.add(key);
        for(const route of routes.filter(r=>routeMatches(r.entry,node.scope)&&(!node.scope.kind||r.entry.region===node.scope.region)&&(!node.scope.kind||r.entry.kind===node.scope.kind)&&(node.scope.value===undefined||r.entry.value===node.scope.value))){
          // Only the current entry can be assessed against the current browser.
          // Filtering deeper edges with current facts would reject valid nested
          // routes; each later edge must be revalidated when it becomes current.
          if(!node.proof.length&&firstEdgeAllowed&&!firstEdgeAllowed(route))continue;
          const proof=[...node.proof,route];
          for(const child of route.targets){const next={scope:child,proof};reachable.push(next);queue.push(next);}
        }
      }
    }
    return reachable.find(r=>routeMatches(target,r.scope))?.proof;
  };
}
export function routeToTarget(task:Task,entry:Scope,target:Scope,o:Pick<Observation,'context'>,firstEdgeAllowed?:(route:EntryRoute)=>boolean):EntryRoute[]|undefined {
  return routeFinder(task,entry,o,firstEdgeAllowed)(target);
}
