import { hash, type ExplorationCase, type ExecutionBlocker } from '@interaction/core';
import { browserPortableBranchConditions } from './branch-conditions.js';
import { formBinding } from './util.js';
import type { ActionCandidate, Observation } from './types.js';
import { nativeNavigationOperationReference } from './native-navigation.js';

/** Portable target preconditions. This deliberately does not claim DOM or business-state equality. */
export function browserTargetConditions(action:ActionCandidate,o:Observation):ExplorationCase|undefined {
  const target=o.controls.find(c=>c.localId===action.localId),branch=browserPortableBranchConditions(action,o);
  if(!target||!branch)return;
  const boundaries=[];
  for(const boundary of o.boundaries||[]){
    const region=o.regions.find(r=>r.key===boundary.region),overlay=o.overlays?.find(b=>b.key===boundary.key);
    // A name plus type/region is evidence, not a guessed mapping of anonymous layers.
    if(!boundary.name||!overlay)return;
    boundaries.push({name:boundary.name,kind:overlay.kind,region:region?{label:region.label,role:region.role}:boundary.region});
  }
  const navigation=action.kind==='click'&&nativeNavigationOperationReference(target,o);
  const policy=navigation?'browser-native-navigation-target-v1':branch.policy==='browser-branch-conditions-v4'?'browser-target-arrival-v2':'browser-target-arrival-v1';
  return {policy,key:hash({policy,url:o.url,branch:branch.key,boundaries,form:formBinding(target),
    ...(navigation?{operationReference:navigation.key}:{}),
    binding:target.identityContext&&{scope:target.identityContext.scope,binding:target.identityContext.binding}}),
    evidence:[...branch.evidence,'Matching observed URL, boundary stack, native form and semantic binding; passive text excluded']};
}

export function browserTargetReady(action:ActionCandidate,o:Observation):boolean {
  const target=o.controls.find(c=>c.localId===action.localId);
  if(!target||target.readiness||!target.visible||!target.enabled||o.gaps.some(g=>g.critical))return false;
  // Generic event-handler/business uncertainty is retained in the observation;
  // it is not a claim that this native UI operation is unsettled. Availability
  // separately enforces execution policy and supported operation evidence.
  if(action.preconditions.blockers?.length)return false;
  if(['click','hover'].includes(action.kind)&&target.actionable.hitTarget!==true)return false;
  return o.stable||o.gaps.some(g=>g.code==='INTERACTION_STABLE'||g.code==='PARTIAL_INTERACTION_READY');
}

/** Known reachability failure is different from an unsettled/unknown target.
 * Recovery may remove these obstructions, but must observe readiness afterwards. */
export function browserTargetRecoverable(action:ActionCandidate,o:Observation,blockers:ExecutionBlocker[]):boolean {
  const target=o.controls.find(c=>c.localId===action.localId);
  if(!target||target.readiness||o.gaps.some(g=>g.critical)||action.excluded||action.basis?.status!=='supported')return false;
  if(!o.stable&&!o.gaps.some(g=>g.code==='INTERACTION_STABLE'||g.code==='PARTIAL_INTERACTION_READY'))return false;
  const mechanical=new Set(['outside_scrollable_area','pointer_intercepted','outside_active_boundary','not_editable','Control is not visible or enabled']);
  return blockers.length>0&&blockers.every(b=>b.code==='ACTION_BLOCKED'&&mechanical.has(b.reason));
}
