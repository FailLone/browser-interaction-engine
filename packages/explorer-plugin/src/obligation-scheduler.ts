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
  version:1; cursor?:string; localSelections:number;
  selection?:ObligationSelection;
  routes:Record<string,ScheduledRoute>;
  /** Old opaque retry keys must be associated before any new route can spend a budget. */
  legacyUnmappedRouteKeys:string[];
  deferred?:Record<string,{conditionVersion:string;reason:string}>;
}
export const localSelectionLimit=4;
export function initialSchedule(task:Pick<Task,'routeRetries'>):ObligationSchedule {
  return {version:1,localSelections:0,routes:{},legacyUnmappedRouteKeys:Object.keys(task.routeRetries?.routes||{})};
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
/** Ready in-place work has a bounded preference; a failed remote target advances
 * the same cursor as a successful one. Neither prices nor restart reset it. */
export function selectObligation(schedule:ObligationSchedule,current:ObligationSelection[],remote:ObligationSelection[]):ObligationSelection|undefined {
  return current.length&&(!remote.length||schedule.localSelections<localSelectionLimit)?current[0]:remote[0]||current[0];
}
export function reserveObligation(schedule:ObligationSchedule,selection:ObligationSelection):void {
  schedule.selection={...selection};schedule.cursor=selection.itemId;
  schedule.localSelections=selection.kind==='current'?Math.min(localSelectionLimit,schedule.localSelections+1):0;
}
export function bindScheduledRoute(schedule:ObligationSchedule,key:string,route:ScheduledRoute):void {
  schedule.routes[key]=route;
  schedule.legacyUnmappedRouteKeys=schedule.legacyUnmappedRouteKeys.filter(old=>old!==key);
}
export function routeDebtAllows(schedule:ObligationSchedule,key:string):boolean {
  return !!schedule.routes[key]||!schedule.legacyUnmappedRouteKeys.length;
}

/** Exploration order only. Conditions and target correspondence remain intact;
 * this prevents changing selector combinations from starving unseen controls.
 * Matching display names alone never share this priority hint. */
export function operationSamplePriority(plan:readonly PlanItem[]):(item:PlanItem)=>number {
  const key=(item:PlanItem)=>JSON.stringify(Object.entries(item.scope).sort(([a],[b])=>a.localeCompare(b)));
  const successes=new Map<string,number>();
  for(const item of plan)if(item.scope.kind&&item.scope.stableKey&&item.status==='succeeded'
    &&item.conditionCompletion?.status==='verified'&&item.resolvedBy?.attemptId){const k=key(item);successes.set(k,(successes.get(k)||0)+1);}
  return item=>item.scope.kind&&item.scope.stableKey?(successes.get(key(item))||0):0;
}

/** Program traversal hint for already sampled operations, including successful
 * no-effect observations whose source duties correctly remain unresolved.
 * A captured target binding can group rebuilt instances for ordering only;
 * every item/source/condition and all actual execution gates remain separate. */
export function programOperationSamplePriority(plan:readonly PlanItem[]):(item:PlanItem)=>number {
  const key=(item:PlanItem)=>{
    if(!item.scope.kind||!item.scope.targetBinding&&!item.scope.stableKey)return;
    const {stableKey,...scope}=item.scope;
    return JSON.stringify(Object.entries(item.scope.targetBinding?scope:item.scope).sort(([a],[b])=>a.localeCompare(b)));
  };
  const attempts=new Map<string,Set<string>>(),verified=operationSamplePriority(plan);
  for(const item of plan){const k=key(item);if(!k)continue;const seen=attempts.get(k)||new Set<string>();
    for(const attempt of item.attempts)if(attempt.outcome==='succeeded'&&attempt.evidence?.attemptId)seen.add(attempt.evidence.attemptId);
    attempts.set(k,seen);
  }
  return item=>Math.max(verified(item),attempts.get(key(item)||'')?.size||0);
}
