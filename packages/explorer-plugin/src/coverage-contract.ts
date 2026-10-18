import type {ActionCandidate,Observation} from '@interaction/browser';
import type {CoverageContract,Scope} from './types.js';
import {matches} from './policy.js';

/** Set containment of exact semantic predicates, never label similarity. */
export function scopeWithin(scope:Scope,root:Scope):boolean {
  return Object.entries(root).every(([key,value])=>scope[key as keyof Scope]===value);
}
export function contractProposalError(contract:CoverageContract,proposal:{scope:Scope;prerequisites:Scope[]}):string|undefined {
  for(const scope of [proposal.scope,...proposal.prerequisites]) {
    if(!contract.roots.some(root=>scopeWithin(scope,root)))return 'outside_contract_root';
    if(scope.kind&&!contract.allowedOperations.includes(scope.kind))return 'operation_not_authorized';
    // Overlapping an excluded predicate cannot be turned into an authority row.
    if(contract.exclusions.some(ex=>scopeWithin(scope,ex.scope)||scopeWithin(ex.scope,scope)))return 'excluded_scope_overlap';
  }
}
/** Coverage roots remain unchanged even if an operation cannot be authorized.
 * This filter is additional to current SDK availability, never its replacement. */
export function contractOperationAllowed(contract:CoverageContract|undefined,action:ActionCandidate,o:Observation):boolean {
  if(!contract)return true;
  return contract.allowedOperations.includes(action.kind)&&!contract.exclusions.some(ex=>matches(ex.scope,action,o));
}
