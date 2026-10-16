import { boundOperationCondition, schedulableObligation } from './plan-state.js';
import { digest } from './policy.js';
import type { PlanItem, Scope } from './types.js';

// These are current availability states of an unexecuted operation. Unknown
// results, permissions, sampling, semantic reviews and capability gaps remain
// independent obligations, even when their literal scopes happen to match.
const availabilityReasons=new Set(['operation_not_executed','region_review_required','pointer_intercepted','outside_active_boundary','outside_scrollable_area','not_editable','Control is not visible or enabled']);
export function availabilityObligation(plan:PlanItem[],reason:string,scope:Scope,condition:string,required:boolean,prerequisites:Scope[]=[]):PlanItem|undefined {
  if(!required||!availabilityReasons.has(reason)||!scope.kind)return;
  const scopeKey=digest(scope);
  const eligible=plan.filter(item=>item.required&&item.dispatchScope===false&&schedulableObligation(item)
    &&['pending','unresolved'].includes(item.status)&&!item.attempts.length&&!item.resolvedBy&&!item.coverageResolvedBy&&!item.reviewResolvedBy
    &&!item.reviewRecoveryWait&&!item.conditionMigration&&!item.conditionLineage
    &&(availabilityReasons.has(item.reason)||item.reason==='observed_in_scope')&&boundOperationCondition(item)===condition&&digest(item.scope)===scopeKey&&digest(item.prerequisites)===digest(prerequisites));
  // Preserve historical duplicate rows. An existing gap is the natural owner
  // of another availability update; no other row is deleted or marked covered.
  return eligible.find(item=>item.reason!=='observed_in_scope')||eligible[0];
}
