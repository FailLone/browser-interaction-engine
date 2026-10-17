import {hash} from '@interaction/core';
import type {ActionCandidate,Control,Observation} from './types.js';
import {formBinding} from './util.js';

/** Explicit sampling contract, not causal independence or business equivalence.
 * All mode combinations remain in immutable observations. Only the finite
 * operation unit is mandatory under this opt-in policy; unknown dependencies
 * are outside its claim and must be reported separately. */
export const finiteCoveragePolicy='finite-ui-v1' as const;
export function finiteOperationConditions(action:Pick<ActionCandidate,'kind'|'localId'>,o:Observation) {
  if(o.coveragePolicy!==finiteCoveragePolicy)return;
  const c=o.controls.find(c=>c.localId===action.localId);
  if(!c||o.gaps.some(g=>g.critical)||Object.values(o.context).some(v=>v.status!=='known')||c.readiness)return;
  const {valid:_valid,...constraints}=c.constraints;
  const input=['fill','select','check'].includes(action.kind);
  const state:Record<string,boolean|'mixed'|string[]>={};
  if(!input){
    if(c.expanded!=null)state.expanded=c.expanded;
    if(c.pressed!=null)state.pressed=c.pressed;
    if(c.checked!=null)state.checked=c.checked;
    if(c.selected.length)state.selected=[...c.selected].sort();
  }
  const binding=hash({tag:c.tag,role:c.role,name:c.label||c.name,form:formBinding(c),
    owner:c.identityContext&&{scope:c.identityContext.scope,binding:c.identityContext.binding},constraints,options:c.options,readOnly:c.readOnly});
  const conditions=[{binding,state,relation:'finite-target-operation'}];
  return {policy:finiteCoveragePolicy,key:hash({policy:finiteCoveragePolicy,conditions}),conditions,identityLocalIds:[c.localId],evidence:[
    'Caller-selected finite-ui-v1: control, operation, input sample, constraints/options and target activation mode',
    'Other captured selectors are retained condition-combination evidence, not proven independent or covered',
    'Unknown JavaScript dependencies, free-input combinations and all business-state combinations remain unproved',
  ]};
}

/** A same-document node reference disambiguates symmetric controls. No ordinal
 * or label is promoted into historical identity; a rebuild requires new proof. */
export function finiteInstanceBinding(c:Control,o:Observation):string|undefined {
  if(o.coveragePolicy!==finiteCoveragePolicy)return;
  // Anonymous native fields have no stable address even while currently unique.
  // Choose the reference class from intrinsic captured facts, never sibling count.
  if(!['input','textarea','select'].includes(c.tag)||c.stableKey||c.structuralItem?.recordKey)return;
  if(!o.instanceScope||!c.instanceId||o.controls.filter(x=>x.instanceId===c.instanceId).length!==1)return;
  return `browser-target-binding:v1:${hash({policy:'document-target-instance-v1',document:o.instanceScope,instance:c.instanceId})}`;
}

/** Graph equality only. Raw observations, target correspondence, preflight and
 * receipts stay separate. No text-number heuristic or site-specific URL rule. */
export function finiteNavigationState(o:Observation) {
  const controls=o.controls.filter(c=>Object.values(c.actionBasis||{}).some(b=>b.status==='supported')).map(c=>{
    const passive=c.nativeReadOnly===true&&c.readOnly&&['input','textarea'].includes(c.tag)&&c.actions.length>0&&c.actions.every(k=>k==='fill');
    return {tag:c.tag,role:c.role,name:passive?undefined:c.liveContent?.name??(c.label||c.name),
      key:passive?undefined:c.stableKey,form:formBinding(c),owner:c.identityContext?.scope,
      attributes:passive?undefined:c.reviewBinding?.attributes,
      visible:c.visible,enabled:c.enabled,editable:c.editable,readOnly:c.readOnly,
      constraints:c.constraints,options:c.options,expanded:c.expanded,pressed:c.pressed,checked:c.checked,selected:c.selected,
      value:passive?undefined:c.value,readiness:c.readiness?.status};
  });
  return {policy:'finite-ui-navigation-v1',url:o.url,context:o.context,controls,
    boundaries:(o.boundaries||[]).map(b=>({name:b.name,kind:o.overlays?.find(x=>x.key===b.key)?.kind,text:o.regions.find(r=>r.key===b.region)?.text})),
    unknown:o.gaps.filter(g=>g.critical).map(g=>g.code)};
}
