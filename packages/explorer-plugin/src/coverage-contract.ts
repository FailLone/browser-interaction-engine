import {executionBoundaryFailure,executionURLAllowed,type BrowserExecutionBoundary,type ActionCandidate,type Observation} from '@interaction/browser';
import type {CoverageContract,Scope} from './types.js';
import {matches} from './policy.js';

/** Set containment of exact semantic predicates, never label similarity. */
export function scopeWithin(scope:Scope,root:Scope,urlMatching:'exact'|'origin-path'='exact'):boolean {
  return Object.entries(root).every(([key,value])=>key==='url'&&urlMatching==='origin-path'&&scope.url
    ?executionURLAllowed({version:1,allowedOperations:[],exclusions:[],urls:[{url:String(value),match:urlMatching}]},scope.url):scope[key as keyof Scope]===value);
}
export function contractProposalError(contract:CoverageContract,proposal:{scope:Scope;prerequisites:Scope[]}):string|undefined {
  for(const scope of [proposal.scope,...proposal.prerequisites]) {
    if(!contract.roots.some(root=>scopeWithin(scope,root,contract.urlMatching))&&!observedContractRoots(contract,scope.url||'').some(root=>scopeWithin(scope,root.scope)))return 'outside_contract_root';
    if(scope.kind&&!contract.allowedOperations.includes(scope.kind))return 'operation_not_authorized';
    // Overlapping an excluded predicate cannot be turned into an authority row.
    if(contract.exclusions.some(ex=>scopeWithin(scope,ex.scope)||scopeWithin(ex.scope,scope)))return 'excluded_scope_overlap';
  }
}
/** Coverage roots remain unchanged even if an operation cannot be authorized.
 * This filter is additional to current SDK availability, never its replacement. */
export function contractOperationAllowed(contract:CoverageContract|undefined,action:ActionCandidate,o:Observation):boolean {
  if(!contract)return true;
  return !executionBoundaryFailure(contractExecutionBoundary(contract),action,o)&&!contract.exclusions.some(ex=>matches(ex.scope,action,o));
}
export function contractExecutionBoundary(contract:CoverageContract):BrowserExecutionBoundary {
 return {version:1,...(contract.programNavigation?{programNavigation:contract.programNavigation}:{}),...(contract.noticePreferences?{noticePreferences:[...contract.noticePreferences]}:{}),allowedOperations:[...contract.allowedOperations],urls:[...[...new Set(contract.roots.flatMap(scope=>scope.url?[scope.url]:[]))].map(url=>({url,match:contract.urlMatching||'exact' as const})),...(contract.routes||[]).map(({origin,pathnamePattern})=>({origin,pathnamePattern,match:'route' as const}))],exclusions:contract.exclusions.map(ex=>({...ex.scope}))};
}

/** Bind authority only to an actually observed URL. Does not navigate, complete
 * a root, enumerate a route language, or alter original source URLs. */
export function observedContractRoots(contract:CoverageContract,url:string):{scope:Scope;declaration:{kind:'root'|'route';index:number}}[] {
 const result:{scope:Scope;declaration:{kind:'root'|'route';index:number}}[]=[];
 if(contract.urlMatching==='origin-path')contract.roots.forEach((root,index)=>{
  if(root.url!==url&&scopeWithin({...root,url},root,'origin-path'))result.push({scope:{...root,url},declaration:{kind:'root',index}});
 });
 (contract.routes||[]).forEach((route,index)=>{
  if(executionURLAllowed({version:1,allowedOperations:[],exclusions:[],urls:[{...route,match:'route'}]},url))result.push({scope:{...route.scope,url},declaration:{kind:'route',index}});
 });
 return result;
}
