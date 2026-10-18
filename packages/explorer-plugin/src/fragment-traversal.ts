import {browserTraversalFragments,fragmentProjectionPolicy,type ActionCandidate,type ActionAttempt,type Observation} from '@interaction/browser';
import {digest,matches,schedulingKeyFor} from './policy.js';
import {boundOperationCondition} from './plan-state.js';
import type {PlanItem} from './types.js';
import {encodeFragmentMaterial} from './fragment-material.js';
import {bestFragmentCandidate,bestFragmentState,emptyFragmentAccess,fragmentWasExplored,fragmentCandidateInfluence,fragmentDuplicationFactor,mapFragmentCandidates,recordFragmentAccess,transferFragmentAccess,type TraversalFragment,type FragmentMapping} from './fragment-traversal-core.js';

export interface FragmentTraversalLedger {
  policy:typeof fragmentProjectionPolicy;epoch:number;authority?:string;bounded?:true;
  revokedCandidates:Record<string,string>;
  obligations:Record<string,{scopeKey:string;authority:string;candidateIds:string[]}>;
  fragments:(TraversalFragment&{url:string;source:{sessionId:string;observationId:string;regionId:string};parentRegionId?:string})[];
  mappings:FragmentMapping[];
  events:{id:string;fragmentId:string;candidateId:string;sessionId:string;observationId:string;afterId:string;actionId:string}[];
  states:{id:string;url:string;context:string;candidateIds:string[];source:{sessionId:string;observationId:string};navigation?:Observation['navigation']}[];
}
export interface FragmentFrontier {observationId:string;byAction:Map<string,{fragmentId:string;candidateId:string}>;pruned:string[];registered:number;mapped:number;unmapped:number;elapsedMs:number}
export const initialFragmentLedger=():FragmentTraversalLedger=>({policy:fragmentProjectionPolicy,epoch:0,revokedCandidates:{},obligations:{},fragments:[],mappings:[],events:[],states:[]});
const size=(value:unknown)=>JSON.stringify(value).length*2;
const MAX_BYTES=2*1024*1024;
const candidate=(l:FragmentTraversalLedger,id:string)=>l.fragments.flatMap(f=>f.candidates).find(c=>c.id===id);
function propagate(l:FragmentTraversalLedger){
  const all=new Map(l.fragments.flatMap(f=>f.candidates).map(c=>[c.id,c]));
  for(const c of all.values())c.access=emptyFragmentAccess();
  for(const e of l.events){const c=all.get(e.candidateId);if(c)c.access=recordFragmentAccess(c.access,e.id);}
  // All edges require identical full guards, so event sets converge and cycles
  // never count an actual attempt twice. No setter is invoked while loading.
  for(let pass=0;pass<=l.fragments.length;pass++){
    let changed=false;
    const byId=new Map(l.fragments.flatMap(f=>f.candidates).map(c=>[c.id,c]));
    for(const edge of l.mappings){if(edge.revoked||l.revokedCandidates[edge.sourceCandidateId]||l.revokedCandidates[edge.targetCandidateId])continue;const a=byId.get(edge.sourceCandidateId),b=byId.get(edge.targetCandidateId);if(!a||!b)continue;
      const next=transferFragmentAccess(a.access,b.access,edge.kind);
      if(JSON.stringify(next)!==JSON.stringify(b.access)){b.access=next;changed=true;}}
    if(!changed)break;
  }
}
/** Registration imports existing access BEFORE a candidate enters the local
 * frontier. Durable bounds disable new mapping, never erase old pending work. */
export function registerFragmentObservation(l:FragmentTraversalLedger,o:Observation,actions:readonly ActionCandidate[],authority:string,eligibleIds:ReadonlySet<string>):FragmentFrontier {
  const start=performance.now(),byAction:FragmentFrontier['byAction']=new Map();let registered=0,mapped=0;
  if(l.policy!==fragmentProjectionPolicy)return {observationId:o.id,byAction,pruned:[],registered,mapped,unmapped:actions.length,elapsedMs:performance.now()-start};
  if(l.authority!==authority){l.authority=authority;l.epoch++;}
  for(const projection of browserTraversalFragments(o,actions,authority)){
    const material={structure:projection.structure,owner:encodeFragmentMaterial(projection.owner),revision:projection.revision,
      candidates:projection.candidates.map(({actionId,...c})=>({...c,guard:encodeFragmentMaterial(c.guard)}))},id=digest({url:o.url,...material});
    let f=l.fragments.find(f=>f.id===id);
    if(f&&(f.structure!==material.structure||f.owner!==material.owner||f.revision!==material.revision
      ||JSON.stringify(f.candidates.map(({id,access,...c})=>c))!==JSON.stringify(material.candidates)))continue;
    if(!f){
      // A rejected large record is not a permanent stop latch. Later smaller
      // records can still fit; old evidence is never evicted to make room.
      if(l.fragments.length>=128){l.bounded=true;continue;}
      const next={id,...material,candidates:material.candidates.map(c=>({...c,id:digest({fragment:id,...c}),access:emptyFragmentAccess()})),url:o.url,
        source:{sessionId:o.sessionId,observationId:o.id,regionId:projection.regionId},parentRegionId:projection.parentRegionId};
      const edges=l.fragments.flatMap(old=>[...mapFragmentCandidates(old,next),...mapFragmentCandidates(next,old)]).filter(edge=>!l.revokedCandidates[edge.sourceCandidateId]&&!l.revokedCandidates[edge.targetCandidateId]);
      // Account for late-imported event IDs before admitting metadata. A new
      // fragment has no direct events, hence cannot introduce any new origin.
      for(const edge of edges.filter(e=>e.targetFragmentId===id)){
        const source=candidate(l,edge.sourceCandidateId),target=next.candidates.find(c=>c.id===edge.targetCandidateId);
        if(source&&target)target.access=transferFragmentAccess(source.access,target.access,edge.kind);
      }
      if(l.mappings.length+edges.length>4096||size(l)+size(next)+size(edges)>MAX_BYTES){l.bounded=true;continue;}
      l.fragments.push(next);l.mappings.push(...edges);f=next;registered++;mapped+=edges.length;l.epoch++;
    }
    for(const [index,current] of projection.candidates.entries()){const guard=material.candidates[index].guard,matches=f.candidates.filter(c=>c.path===current.path&&c.operation===current.operation&&c.guard===guard);
      if(matches.length===1)byAction.set(current.actionId,{fragmentId:f.id,candidateId:matches[0].id});}
  }
  propagate(l);
  const candidateIds=[...new Set([...byAction].filter(([id])=>eligibleIds.has(id)).map(([,ref])=>ref.candidateId))].sort();
  const state={id:digest({url:o.url,context:o.context,candidateIds}),url:o.url,context:digest(o.context),candidateIds,
    source:{sessionId:o.sessionId,observationId:o.id},navigation:o.navigation};
  const priorState=l.states.find(s=>s.id===state.id);
  if(!priorState&&l.states.length<256&&size(l)+size(state)<MAX_BYTES){l.states.push(state);l.epoch++;}
  else if(priorState&&(priorState.source.sessionId!==o.sessionId||JSON.stringify(priorState.navigation)!==JSON.stringify(o.navigation))&&size(l)-size(priorState)+size(state)<MAX_BYTES){Object.assign(priorState,state);l.epoch++;}
  const pruned=[...byAction].filter(([,ref])=>fragmentWasExplored(candidate(l,ref.candidateId)!.access)).map(([id])=>id);
  return {observationId:o.id,byAction,pruned,registered,mapped,unmapped:actions.length-byAction.size,elapsedMs:performance.now()-start};
}
/** Only a durable actual succeeded receipt with a subsequent observation emits
 * access. This still means sampled, NOT verified functional coverage. */
export function recordFragmentOutcome(l:FragmentTraversalLedger,frontier:FragmentFrontier,attempt:ActionAttempt):boolean {
  if(attempt.status!=='succeeded'||!attempt.afterId||attempt.beforeId!==frontier.observationId||l.events.some(e=>e.id===attempt.id))return false;
  const ref=frontier.byAction.get(attempt.action.id);if(!ref)return false;
  const event={id:attempt.id,...ref,sessionId:attempt.sessionId,observationId:attempt.beforeId,afterId:attempt.afterId,actionId:attempt.action.id};
  // Reserve propagation space conservatively. Refusing a new access event
  // loses an optimization only; the original attempt remains in its store.
  if(size(l)+size(event)*(l.fragments.length+1)>MAX_BYTES){l.bounded=true;return false;}
  l.events.push(event);const c=candidate(l,ref.candidateId)!;c.access=recordFragmentAccess(c.access,attempt.id);propagate(l);l.epoch++;return true;
}
/** Keep the rejected edge and its reason for audit; reconstruct all derived
 * access so revocation cannot leave a stale pruned flag or influence cache. */
export function revokeFragmentMappings(l:FragmentTraversalLedger,targetCandidateId:string,reason:string){
  l.revokedCandidates[targetCandidateId]=reason.slice(0,512);
  for(const edge of l.mappings)if(edge.targetCandidateId===targetCandidateId)edge.revoked={reason};
  propagate(l);l.epoch++;
}
export function fragmentActionEvidence(l:FragmentTraversalLedger,f:FragmentFrontier,actionId:string){
  const ref=f.byAction.get(actionId),c=ref&&candidate(l,ref.candidateId);if(!c)return;
  const events=[...new Set([...c.access.direct,...c.access.duplicate,...c.access.equivalent])];
  return {...ref,pruned:fragmentWasExplored(c.access),access:c.access,originAttemptIds:events,
    mapping:l.mappings.filter(e=>e.targetCandidateId===c.id),coverageGranted:false as const};
}
/** Link immutable obligation scopes to sampled candidate records, without
 * changing plan status, identity, discovery source or completion conditions. */
export function linkFragmentObligations(l:FragmentTraversalLedger,f:FragmentFrontier,o:Observation,actions:readonly ActionCandidate[],plan:readonly PlanItem[]){
  const additions:FragmentTraversalLedger['obligations']={};
  for(const item of plan){
    if(!item.scope.kind||item.dispatchScope===true)continue;
    const condition=boundOperationCondition(item),matchesCurrent=actions.filter(a=>matches(item.scope,a,o)&&(!condition||condition===schedulingKeyFor(a,o)));
    if(matchesCurrent.length!==1)continue;
    const ref=f.byAction.get(matchesCurrent[0].id);if(!ref)continue;
    const scopeKey=digest({scope:item.scope,condition}),old=l.obligations[item.id];
    if(old?.scopeKey===scopeKey&&old.authority===l.authority&&old.candidateIds.includes(ref.candidateId))continue;
    additions[item.id]={scopeKey,authority:l.authority!,candidateIds:[...new Set([...(old?.scopeKey===scopeKey&&old.authority===l.authority?old.candidateIds:[]),ref.candidateId])]};
  }
  if(Object.keys(l.obligations).length+Object.keys(additions).length<=4096&&size(l)+size(additions)<=MAX_BYTES){Object.assign(l.obligations,additions);if(Object.keys(additions).length)l.epoch++;}
  else l.bounded=true;
}
export function fragmentObligationSampled(l:FragmentTraversalLedger|undefined,item:PlanItem){
  if(!l||item.dispatchScope===true)return false;
  const ref=l.obligations[item.id];if(!ref||ref.authority!==l.authority||ref.scopeKey!==digest({scope:item.scope,condition:boundOperationCondition(item)}))return false;
  return ref.candidateIds.length>0&&ref.candidateIds.every(id=>{const c=candidate(l,id);return !!c&&fragmentWasExplored(c.access);});
}
/** Historical ordinary targets obey the same projection as current targets.
 * This declines recovery work only; entries inside an already selected restore
 * route still execute under the SDK's independent arrival contract. */
export function sampledFragmentAction(l:FragmentTraversalLedger,o:Observation,actions:readonly ActionCandidate[],authority:string,actionId:string):boolean {
  for(const projection of browserTraversalFragments(o,actions,authority)){
    const current=projection.candidates.find(c=>c.actionId===actionId);if(!current)continue;
    const owner=encodeFragmentMaterial(projection.owner),f=l.fragments.find(f=>f.url===o.url&&f.revision===projection.revision&&f.structure===projection.structure&&f.owner===owner);
    const guard=encodeFragmentMaterial(current.guard),c=f?.candidates.find(c=>c.path===current.path&&c.operation===current.operation&&c.guard===guard);
    return !!c&&fragmentWasExplored(c.access);
  }
  return false;
}
export function preferFragmentCandidate<T extends {actionId?:string}>(l:FragmentTraversalLedger,f:FragmentFrontier,choices:readonly T[]):T|undefined {
  // Upstream calculateDuplicationFactor belongs to the closest FRAGMENT,
  // not the number of guarded mappings for this particular action. Partial
  // host mappings must not give old siblings a larger score than a newly
  // revealed child in that same fragment.
  const peersByFragment=new Map<string,Set<string>>();
  for(const edge of l.mappings){
    if(edge.revoked||l.revokedCandidates[edge.sourceCandidateId]||l.revokedCandidates[edge.targetCandidateId])continue;
    const peers=peersByFragment.get(edge.sourceFragmentId)||new Set<string>();peers.add(edge.targetFragmentId);peersByFragment.set(edge.sourceFragmentId,peers);
  }
  const candidates=choices.map(choice=>{const ref=choice.actionId?f.byAction.get(choice.actionId):undefined,c=ref?candidate(l,ref.candidateId):undefined;
    const peers=ref?peersByFragment.get(ref.fragmentId)?.size||0:0;
    return {choice,access:c?.access||emptyFragmentAccess(),factor:fragmentDuplicationFactor(0,peers)};});
  return bestFragmentCandidate(candidates)?.choice;
}
/** Recompute state work and native history reachability for every selection.
 * States with no known native route are deferred here and remain eligible for
 * the host's independently verified strict replay fallback. */
export function fragmentStateOrder(l:FragmentTraversalLedger,o:Observation){
  const rows=l.states.filter(s=>s.url!==o.url).map(s=>{
    const candidates=s.candidateIds.flatMap(id=>{const c=candidate(l,id);return c?[c]:[];});
    const nav=s.navigation,entry=nav?.entries[nav.currentIndex];
    const reachable=!!entry&&entry.method==='GET'&&nav?.browserSessionId===o.navigation?.browserSessionId
      &&o.navigation.entries.some(e=>e.id===entry.id&&e.url===entry.url&&e.method==='GET')&&s.context===digest(o.context);
    return {stateId:s.id,url:s.url,source:s.source,fresh:candidates.filter(c=>!fragmentWasExplored(c.access)).length,
      influence:candidates.reduce((sum,c)=>sum+fragmentCandidateInfluence(c.access),0),reachable,cost:reachable?1:undefined};
  });
  const order:typeof rows=[];let rest=[...rows];for(let best=bestFragmentState(rest);best;best=bestFragmentState(rest)){order.push(best);rest=rest.filter(r=>r!==best);}
  return {order,deferred:rest};
}
