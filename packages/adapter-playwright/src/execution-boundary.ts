import type {ActionCandidate,BrowserExecutionBoundary,Observation} from './types.js';
import {browserControlBindingKey,browserControlCorrespondence} from './exploration.js';
import {historyTarget,navigationIntent} from './navigation.js';

/** URL authorization only. Never used for state equality, target identity or receipts. */
export function executionURLAllowed(boundary:BrowserExecutionBoundary,url:string,networkRequest=false):boolean {
 return boundary.urls.some(rule=>{
  if(rule.match==='route'){
    try{const a=new URL(url);return ['http:','https:'].includes(a.protocol)&&a.origin===rule.origin&&new RegExp(rule.pathnamePattern).test(a.pathname);}catch{return false;}
  }
  if(rule.match==='exact'){
    if(!networkRequest)return url===rule.url;
    try{const a=new URL(url),b=new URL(rule.url);a.hash='';b.hash='';return a.href===b.href;}catch{return false;}
  }
  try{const a=new URL(url),b=new URL(rule.url);return ['http:','https:'].includes(a.protocol)&&a.origin===b.origin&&a.pathname===b.pathname;}catch{return false;}
 });
}
export function executionBoundaryFailure(boundary:BrowserExecutionBoundary|undefined,action:ActionCandidate,o:Observation):string|undefined {
 if(!boundary)return;
 if(!boundary.allowedOperations.includes(action.kind))return 'operation_outside_execution_boundary';
 if(!executionURLAllowed(boundary,o.url))return 'page_outside_execution_boundary';
 const control=o.controls.find(c=>c.localId===action.localId),scope:BrowserExecutionBoundary['exclusions'][number]={url:o.url,region:o.regions.find(r=>r.key===control?.region)?.label,landmark:control?.landmark,label:action.label,role:control?.role,
   stableKey:control&&browserControlCorrespondence(control)?.key,targetBinding:control&&browserControlBindingKey(control,o),kind:action.kind,
   ...(['string','boolean','number'].includes(typeof action.value)?{value:action.value as string|boolean|number}:{})};
 if(boundary.exclusions.some(ex=>Object.entries(ex).every(([key,value])=>scope[key as keyof typeof scope]===value)))return 'target_excluded_by_execution_boundary';
 const href=control?.tag==='a'?control.reviewBinding?.attributes.href:undefined;
 let target=navigationIntent(action,o)?.targetUrl||historyTarget(action,o.navigation)?.url;
 if(href!==undefined&&['click','press'].includes(action.kind)){try{target=new URL(href,o.url).href;}catch{return 'destination_unproved';}}
 if(target&&!executionURLAllowed(boundary,target))return 'destination_outside_execution_boundary';
 // Reset and recorded-entry navigation have an explicit URL without a DOM node.
 if(['recovery-reset','recovery-entry'].includes(action.source)&&!executionURLAllowed(boundary,typeof action.value==='string'?action.value:o.url))return 'recovery_outside_execution_boundary';
}
