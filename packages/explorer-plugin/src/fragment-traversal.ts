import {browserTraversalFragments,browserFragmentObservedEffect,fragmentProjectionPolicy,type ActionCandidate,type ActionAttempt,type Observation} from '@interaction/browser';
import {digest} from './policy.js';
import {observationActionIndex} from './observation-action-index.js';
import {boundOperationCondition} from './plan-state.js';
import {ExplorerError,type PlanItem} from './types.js';
import {FragmentSession} from './fragment-session.js';
import {bestFragmentCandidate,bestFragmentState,fragmentWasExplored,fragmentCandidateInfluence,fragmentDuplicationFactor} from './fragment-traversal-core.js';
export type {FragmentTraversalLedger} from './fragment-records.js';
export interface FragmentFrontier {observationId:string;byAction:Map<string,{fragmentId:string;candidateId:string}>;pruned:string[];registered:number;mapped:number;unmapped:number;elapsedMs:number}
/** Registration imports existing access before admission. Durable records have
 * no coverage-count ceiling; material/cache budgets never erase pending work. */
export function registerFragmentObservation(l:FragmentSession,o:Observation,actions:readonly ActionCandidate[],authority:string,eligibleIds:ReadonlySet<string>):FragmentFrontier {
  const start=performance.now(),byAction:FragmentFrontier['byAction']=new Map();let registered=0,mapped=0;
  if(l.root.policy!==fragmentProjectionPolicy)return {observationId:o.id,byAction,pruned:[],registered,mapped,unmapped:actions.length,elapsedMs:performance.now()-start};
  l.authority(authority);
  for(const projection of browserTraversalFragments(o,actions,authority)){
    const record=l.register(o.url,projection,{sessionId:o.sessionId,observationId:o.id,regionId:projection.regionId},projection.parentRegionId);
    if(record.created)registered++;mapped+=record.mapped;
    for(const [index,current] of projection.candidates.entries()){
      const c=record.candidates[index];
      // Ambiguous candidates are retained, but never admitted as a unique map.
      if(record.candidates.filter(other=>other.path===c.path&&other.operation===c.operation&&other.guard===c.guard).length===1)byAction.set(current.actionId,{fragmentId:record.fragment.id,candidateId:c.id});
    }
  }
  const candidateIds=[...new Set([...byAction].filter(([id])=>eligibleIds.has(id)).map(([,ref])=>ref.candidateId))].sort();
  const state={id:digest({url:o.url,context:o.context,candidateIds}),url:o.url,context:digest(o.context),candidateIds,source:{sessionId:o.sessionId,observationId:o.id},navigation:o.navigation};
  const prior=l.get('states',state.id);
  if(!prior||prior.source.sessionId!==o.sessionId||JSON.stringify(prior.navigation)!==JSON.stringify(o.navigation))l.put('states',state);
  const pruned=[...byAction].filter(([,ref])=>fragmentWasExplored(l.counts(ref.candidateId))).map(([id])=>id);
  return {observationId:o.id,byAction,pruned,registered,mapped,unmapped:actions.length-byAction.size,elapsedMs:performance.now()-start};
}
/** A durable succeeded SDK receipt precedes this idempotent ingest. The two
 * databases are not one transaction; missing ingest never means unexecuted. */
export function recordFragmentOutcome(l:FragmentSession,frontier:FragmentFrontier,attempt:ActionAttempt,observations?:{before:Observation;after:Observation}):boolean {
  if(l.root.policy!==fragmentProjectionPolicy)return false;
  if(attempt.status!=='succeeded'||!attempt.afterId||attempt.beforeId!==frontier.observationId)return false;
  const ref=frontier.byAction.get(attempt.action.id);if(!ref)return false;
  const effect=observations&&observations.before.id===attempt.beforeId&&observations.after.id===attempt.afterId&&observations.before.sessionId===attempt.sessionId&&observations.after.sessionId===attempt.sessionId?browserFragmentObservedEffect(observations.before,observations.after):undefined;
  const event={id:attempt.id,...ref,sessionId:attempt.sessionId,observationId:attempt.beforeId,afterId:attempt.afterId,actionId:attempt.action.id,...(effect?{effect:l.material('effect',effect.material)}:{})},prior=l.get('events',attempt.id);
  if(prior){if(JSON.stringify(prior)!==JSON.stringify(event))throw new ExplorerError('FRAGMENT_ORIGIN_CONFLICT');return false;}
  return l.put('events',event);
}
export function fragmentSamplingDecision(l:FragmentSession,candidateId:string){return l.root.policy===fragmentProjectionPolicy?l.sampling(candidateId):undefined;}
export function revokeFragmentMappings(l:FragmentSession,candidateId:string,reason:string){l.put('revocations',{id:candidateId,reason});}
/** Compact stable reference. Full origin receipts are paginated by origins();
 * ordinary logs never duplicate growing source sets. */
export function fragmentActionEvidence(l:FragmentSession,f:FragmentFrontier,actionId:string){
  if(l.root.policy!==fragmentProjectionPolicy)return;
  const ref=f.byAction.get(actionId);if(!ref)return;const access=l.counts(ref.candidateId);
  return {...ref,pruned:fragmentWasExplored(access),access,sampling:fragmentSamplingDecision(l,ref.candidateId),originCount:access.equivalent,evidenceRef:{rootKey:l.root.rootKey,candidateId:ref.candidateId,epoch:l.root.epoch},coverageGranted:false as const};
}
export function linkFragmentObligations(l:FragmentSession,f:FragmentFrontier,o:Observation,actions:readonly ActionCandidate[],plan:readonly PlanItem[]){
  if(l.root.policy!==fragmentProjectionPolicy)return;
  // One synchronous observation owns this index. Repeated obligation rows do
  // not need to rebuild each action's captured scope or condition; ambiguity
  // and the exact literal/condition comparison remain unchanged.
  const index=observationActionIndex(o,actions);
  for(const item of plan){
    if(!item.scope.kind||item.dispatchScope===true)continue;
    const condition=boundOperationCondition(item),current=index.matching(item.scope).filter(a=>!condition||condition===index.condition(a));
    if(current.length!==1)continue;const ref=f.byAction.get(current[0].id);if(!ref)continue;
    const scopeKey=digest({scope:item.scope,condition}),old=l.get('obligations',item.id);
    if(old?.scopeKey===scopeKey&&old.authority===l.root.authority&&old.candidateIds.includes(ref.candidateId))continue;
    l.put('obligations',{id:item.id,scopeKey,authority:l.root.authority!,candidateIds:[...new Set([...(old?.scopeKey===scopeKey&&old.authority===l.root.authority?old.candidateIds:[]),ref.candidateId])]});
  }
}
export function fragmentObligationSampled(l:FragmentSession|undefined,item:PlanItem){
  if(!l||l.root.policy!==fragmentProjectionPolicy||item.dispatchScope===true)return false;
  const ref=l.get('obligations',item.id);if(!ref||ref.authority!==l.root.authority||ref.scopeKey!==digest({scope:item.scope,condition:boundOperationCondition(item)}))return false;
  return ref.candidateIds.length>0&&ref.candidateIds.every(id=>!!l.get('candidates',id)&&fragmentWasExplored(l.counts(id)));
}
/** Ordinary historical targets are sampled; selected restore entries retain
 * their independent SDK arrival and child execution contract in the caller. */
export function sampledFragmentAction(l:FragmentSession,o:Observation,actions:readonly ActionCandidate[],authority:string,actionId:string):boolean {
  if(l.root.policy!==fragmentProjectionPolicy)return false;
  for(const projection of browserTraversalFragments(o,actions,authority)){
    const index=projection.candidates.findIndex(c=>c.actionId===actionId);if(index<0)continue;
    const found=l.find(o.url,projection);return !!found&&fragmentWasExplored(l.counts(found.candidates[index].id));
  }
  return false;
}
export function preferFragmentCandidate<T extends {actionId?:string}>(l:FragmentSession,f:FragmentFrontier,choices:readonly T[]):T|undefined {
  if(l.root.policy!==fragmentProjectionPolicy)return choices[0];
  const peers=new Map<string,number>();
  return bestFragmentCandidate(choices.map(choice=>{const ref=choice.actionId?f.byAction.get(choice.actionId):undefined;
    if(ref&&!peers.has(ref.fragmentId))peers.set(ref.fragmentId,l.reusablePeers(ref.fragmentId));
    return {choice,access:ref?l.counts(ref.candidateId):{direct:false,duplicate:0,equivalent:0},factor:fragmentDuplicationFactor(0,ref?peers.get(ref.fragmentId)!:0)};
  }))?.choice;
}
export function fragmentStateOrder(l:FragmentSession,o:Observation){
  if(l.root.policy!==fragmentProjectionPolicy)return {order:[],deferred:[]};
  const rows=[...l.rows('states')].filter(s=>s.url!==o.url).map(s=>{
    const candidates=s.candidateIds.map(id=>l.counts(id)),nav=s.navigation,entry=nav?.entries[nav.currentIndex];
    const reachable=!!entry&&entry.method==='GET'&&nav?.browserSessionId===o.navigation?.browserSessionId&&o.navigation.entries.some(e=>e.id===entry.id&&e.url===entry.url&&e.method==='GET')&&s.context===digest(o.context);
    return {stateId:s.id,url:s.url,source:s.source,fresh:candidates.filter(c=>!fragmentWasExplored(c)).length,influence:candidates.reduce((sum,c)=>sum+fragmentCandidateInfluence(c),0),reachable,cost:reachable?1:undefined};
  });
  const order:typeof rows=[];let rest=[...rows];for(let best=bestFragmentState(rest);best;best=bestFragmentState(rest)){order.push(best);rest=rest.filter(r=>r!==best);}
  return {order,deferred:rest};
}
