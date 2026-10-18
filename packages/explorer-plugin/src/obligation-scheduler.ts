import type { EvidenceRef, PlanItem, Scope, Task } from './types.js';
import { isUnfinished, schedulableObligation } from './plan-state.js';

/** Scheduling metadata is not identity, replay permission, arrival or coverage. */
export interface ScheduledRoute {
  sessionId:string; observationId:string; checkpointId:string;
  targets:Scope[]; path:Scope[]; itemIds:string[];
  /** Semantic budget membership from each retained source, not row IDs/names. */
  memberKeys?:string[];
  /** Verified retained goal conditions separate new A/B routes; absent on legacy debt. */
  sourceCondition?:string;
  /** Position arrival is separate from checkpoint/operation restoration. */
  arrivalMode?:'observed-source'|'control-review';
  /** Already interpreted current material cannot satisfy a missing source condition. */
  requireSourceEquivalent?:boolean;
  pathKeys?:string[];
  membershipUnavailable?:boolean;
  failure?:{status:'unreachable'|'invalidated';reason:string;conditionVersion:string;targets:Scope[]};
}
export interface ObligationSelection {
  itemId:string; kind:'current'|'reentry'|'recovery'|'inspect';
  actionId?:string; source?:EvidenceRef; routeKey?:string;
}
export interface ObligationSchedule {
  version:1; cursor?:string;
  /** Ignored historical metadata; no current strategy uses an action quota. */
  localSelections?:number;
  selection?:ObligationSelection;
  routes:Record<string,ScheduledRoute>;
  /** Old opaque retry keys must be associated before any new route can spend a budget. */
  legacyUnmappedRouteKeys:string[];
  deferred?:Record<string,{conditionVersion:string;reason:string}>;
}
export function initialSchedule(task:Pick<Task,'routeRetries'>):ObligationSchedule {
  return {version:1,routes:{},legacyUnmappedRouteKeys:Object.keys(task.routeRetries?.routes||{})};
}
export function unfinishedObligations(plan:PlanItem[]):PlanItem[] {
  return plan.filter(item=>item.required&&isUnfinished(item)&&schedulableObligation(item));
}
/** Rotate the durable ledger, not the current browser's candidate order. */
export function orderedObligations(plan:PlanItem[],schedule:ObligationSchedule):PlanItem[] {
  const pending=unfinishedObligations(plan),index=pending.findIndex(item=>item.id===schedule.cursor);
  // A completed cursor may no longer be pending. Its place in the immutable
  // discovery order still matters, including after a process restart.
  const positions=new Map(plan.map((item,index)=>[item.id,index])),cursor=positions.get(schedule.cursor||'')??-1;
  const pivot=index>=0?index+1:Math.max(0,pending.findIndex(item=>positions.get(item.id)!>cursor));
  const rotated=[...pending.slice(pivot),...pending.slice(0,pivot)];
  return [...rotated.filter(item=>!!item.scope.kind||!!item.scope.label||!!item.scope.stableKey),
    ...rotated.filter(item=>!item.scope.kind&&!item.scope.label&&!item.scope.stableKey)];
}
export function reserveObligation(schedule:ObligationSchedule,selection:ObligationSelection):void {
  schedule.selection={...selection};schedule.cursor=selection.itemId;
}
export function bindScheduledRoute(schedule:ObligationSchedule,key:string,route:ScheduledRoute):void {
  schedule.routes[key]=route;
  schedule.legacyUnmappedRouteKeys=schedule.legacyUnmappedRouteKeys.filter(old=>old!==key);
}
export function routeDebtAllows(schedule:ObligationSchedule,key:string):boolean {
  return !!schedule.routes[key]||!schedule.legacyUnmappedRouteKeys.length;
}

/** Unified fragment exploration: current fresh work precedes retained routes.
 * Candidates without a mapping remain ordinary fresh candidates. No quota,
 * mode switch, identity authority or coverage inference is supplied here. */
export function selectFragmentWork(input:{
  boundaryActive:boolean;
  continuation?:ObligationSelection;
  current:{selection:ObligationSelection;untried:boolean}[];
  remote:ObligationSelection[];
}):{selection?:ObligationSelection;reason:string;needsRecovery:boolean} {
  if(input.boundaryActive){
    const local=[...input.current.map(c=>c.selection),...input.remote.filter(c=>c.kind==='reentry'&&c.actionId)];
    return {selection:local.find(c=>c===input.continuation)||local[0],reason:'active_boundary',needsRecovery:false};
  }
  if(input.continuation)return {selection:input.continuation,reason:'selected_route_continuation',needsRecovery:false};
  const fresh=input.current.find(candidate=>candidate.untried);
  if(fresh)return {selection:fresh.selection,reason:'untried_current_candidate',needsRecovery:false};
  if(input.remote.length)return {selection:input.remote[0],reason:'retained_work_after_current_samples',needsRecovery:false};
  return {selection:input.current[0]?.selection,reason:input.current.length?'sampled_current_fallback':'current_candidates_exhausted',needsRecovery:true};
}
