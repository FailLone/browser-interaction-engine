import type {PlanItem,Scope} from './types.js';
import {schedulingOperationCondition} from './plan-state.js';
import {digest} from './policy.js';

const exactKey=(reason:string,scope:Scope,condition?:string)=>JSON.stringify({reason,scope,operationConditionKey:condition});
const availabilityKey=(scope:Scope,condition:string|undefined,prerequisites:Scope[])=>digest({scope,condition,prerequisites});
/** One synchronous audit owns this index. Every changed/new item must be
 * refreshed after source append and normalization, before the next lookup.
 * Buckets narrow the original predicates; they never supply scope authority,
 * source correspondence, coverage, or a new retry allowance. */
export function auditGapIndex(plan:PlanItem[]) {
  const exact=new Map<string,Set<PlanItem>>(),availability=new Map<string,Set<PlanItem>>();
  const positions=new Map<PlanItem,number>(),prior=new Map<PlanItem,{exact:string;availability:string}>();
  const authority=plan.filter(item=>item.required&&item.dispatchScope===true);
  const ordered=(bucket:Set<PlanItem>|undefined)=>bucket?[...bucket].sort((a,b)=>positions.get(a)!-positions.get(b)!):[];
  const add=(index:Map<string,Set<PlanItem>>,key:string,item:PlanItem)=>{let bucket=index.get(key);if(!bucket)index.set(key,bucket=new Set());bucket.add(item);};
  const remove=(index:Map<string,Set<PlanItem>>,key:string,item:PlanItem)=>{const bucket=index.get(key);if(bucket){bucket.delete(item);if(!bucket.size)index.delete(key);}};
  const refresh=(item:PlanItem)=>{
    if(!positions.has(item))positions.set(item,positions.size);
    // Always validate the persisted audit at this explicit mutation boundary.
    const condition=schedulingOperationCondition(item),keys={exact:exactKey(item.reason,item.scope,condition),availability:availabilityKey(item.scope,condition,item.prerequisites)},old=prior.get(item);
    if(old?.exact!==keys.exact){if(old)remove(exact,old.exact,item);add(exact,keys.exact,item);}
    if(old?.availability!==keys.availability){if(old)remove(availability,old.availability,item);add(availability,keys.availability,item);}
    prior.set(item,keys);
  };
  for(const item of plan)refresh(item);
  return {
    exact:(reason:string,scope:Scope,condition?:string)=>ordered(exact.get(exactKey(reason,scope,condition))),
    availability:(scope:Scope,condition:string,prerequisites:Scope[])=>ordered(availability.get(availabilityKey(scope,condition,prerequisites))),
    authority,refresh,
  };
}
export type AuditGapIndex=ReturnType<typeof auditGapIndex>;
