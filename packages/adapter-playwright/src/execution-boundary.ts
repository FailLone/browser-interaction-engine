import type {ActionCandidate,BrowserExecutionBoundary,Observation,Control} from './types.js';
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
 if(boundary.programNavigation&&action.risk==='unknown'&&!programNavigationCandidate(action,o))return 'unassessed_operation_outside_program_navigation';
}

/** A bounded operation domain, not a claim about the handler's effects or useful result.
 * Labels, descendant handlers and pointer styling cannot create membership. */
function programNavigationCandidate(action:ActionCandidate,o:Observation):boolean {
 const targets=o.controls.filter(c=>c.localId===action.localId),c=targets.length===1?targets[0]:undefined;
 if(!c||action.observationId!==o.id||!c.instanceId||o.controls.filter(target=>target.instanceId===c.instanceId).length!==1||c.editable||c.formOwner||(c.form&&c.form!=='document')
   ||['input','textarea','select'].includes(c.tag)||action.risk==='submission')return false;
 const attributes=c.reviewBinding?.attributes||{};
 if(action.kind==='click'&&action.basis?.status==='supported'){
  if(c.tag==='a'&&attributes.href!==undefined&&attributes.download===undefined
    &&(!attributes.target||attributes.target==='_self')&&c.actionBasis?.click?.evidence.some(e=>e.rule==='hyperlink/v1')){
   try{return ['http:','https:'].includes(new URL(attributes.href,o.url).protocol);}catch{return false;}
  }
  // The HTML details toggle is a native observation operation, not an arbitrary button.
  return !!c.landmark&&c.tag==='summary'&&!!c.actionBasis?.click?.evidence.some(e=>e.rule==='details-summary/v1');
 }
 if(!['external-probe','program-navigation-observation'].includes(action.source)||!c.landmark||action.value!==undefined||!['hover','focus'].includes(action.kind))return false;
 const events=action.kind==='hover'?['onMouseEnter','onMouseOver','onPointerEnter','onPointerOver']:['onFocus'];
 return !!c.interactionHints?.some(h=>h.source==='runtime-metadata'&&h.rule==='react-event-prop/v1'
   &&h.facts.binding==='own-data-property'&&events.includes(String(h.facts.eventProperty)));
}
/** Same current contract predicate for plugin selection, SDK dispatch and external guards. */
export function programNavigationAllowed(boundary:BrowserExecutionBoundary|undefined,action:ActionCandidate,o:Observation):boolean {
 return boundary?.programNavigation==='public-navigation-v1'&&programNavigationCandidate(action,o)&&!executionBoundaryFailure(boundary,action,o);
}
/** Current facts for one probe; never persisted as an ordinary action or review. */
export function programNavigationProbe(c:Control,o:Observation,kind:'hover'|'focus'):ActionCandidate {
 return {id:`program-probe:${o.id}:${c.localId}:${kind}`,sessionId:o.sessionId,observationId:o.id,stateId:o.stateId,
  localId:c.localId,controlId:c.identityId,kind,label:c.name,source:'external-probe',risk:'unknown',replayable:false,excluded:false,sampleValidity:'known',
  basis:{status:'supported',evidence:[{source:'browser-operation',rule:'explicit-probe/v1',facts:{kind,effects:'unknown'}}]},
  preconditions:{context:o.context,visible:c.visible,enabled:c.enabled,identityResolved:!c.hypothesisId}};
}
/** Retain semantic unknown duties, but do not use a program-authorized observation's
 * missing semantic description as a prerequisite for another authorized navigation.
 * Capability, ancestry completeness, forms, obstruction and other unknowns still gate. */
export function programNavigationDependencies(boundary:BrowserExecutionBoundary|undefined,action:ActionCandidate,o:Observation,unresolved:Control[]):Control[] {
 if(!programNavigationAllowed(boundary,action,o))return unresolved;
 return unresolved.filter(c=>{
  if(c.hypothesisId)return true;
  const native={...programNavigationProbe(c,o,'hover'),kind:'click',source:'dom',basis:c.actionBasis?.click};
  return !programNavigationAllowed(boundary,native,o)&&!(['hover','focus'] as const).some(kind=>programNavigationAllowed(boundary,programNavigationProbe(c,o,kind),o));
 });
}

/** Make only an already captured own-event observation mechanically executable.
 * Its semantic effect remains unknown and no review/classification is synthesized. */
export function prepareProgramNavigation(actions:ActionCandidate[],o:Observation,boundary:BrowserExecutionBoundary|undefined):ActionCandidate[] {
 if(!boundary?.programNavigation)return actions;
 return actions.map(action=>{
  if(action.risk!=='unknown'||action.excluded||!['hover','focus'].includes(action.kind))return action;
  const candidate:ActionCandidate={...action,source:'program-navigation-observation',replayable:false,
   basis:{status:'supported',evidence:[...(action.basis?.evidence||[]),{source:'caller-navigation-contract',rule:'bounded-observation/v1',facts:{kind:action.kind,effects:'unknown',coverageGranted:false}}]}};
  return programNavigationAllowed(boundary,candidate,o)?candidate:action;
 });
}
