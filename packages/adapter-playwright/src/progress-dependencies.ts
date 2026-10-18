import type {ActionCandidate,Control,Observation} from './types.js';
import {historyTarget} from './navigation.js';
import {hasReviewedDismissal} from './boundary-exit.js';

/** Additional finite UI scheduling gate. Never overrides SDK executability,
 * current hit testing, review revocation, critical gaps or receipt conditions.
 * DOM independence is not a claim about unobserved JavaScript/business effects. */
export function progressDependencies(o:Observation,action:ActionCandidate,unresolved:readonly Control[]) {
 const blockers:{reason:string;reference:string}[]=[],independent:string[]=[];
 const block=(reason:string,reference:string)=>blockers.push({reason,reference});
 const current=o.controls.filter(c=>c.localId===action.localId);
 for(const g of o.gaps.filter(g=>g.critical))block('critical_observation_gap',g.code);
 if(action.observationId!==o.id||action.sessionId!==o.sessionId)block('stale_action',action.id);
 // Browser-owned GET history/entry and a freshly reviewed boundary exit do not
 // address unknown subtree contents. Their existing SDK context, dirty-state,
 // repetition and exit guards still apply; no arbitrary control-free action fits.
 if(current.length!==1){
   const navigation=!action.localId&&!action.controlId&&action.basis?.status==='supported'&&!!historyTarget(action,o.navigation);
   const entry=!action.localId&&!action.controlId&&action.kind==='navigate'&&['recovery-entry','recovery-reset'].includes(action.source)&&action.risk==='interface'&&typeof action.value==='string';
   const exit=!action.localId&&!action.controlId&&action.boundary?.intent==='exit'&&action.boundary.key===o.boundaries?.at(-1)?.key&&hasReviewedDismissal(action,o);
   if(navigation||entry||exit)independent.push('sdk_owned_navigation_or_reviewed_exit');
   else if(unresolved.length||o.gaps.some(g=>g.code.startsWith('UNSUPPORTED_')))block('target_dependency_unproved',action.id);
   return {allowed:!blockers.length,blockers,independent};
 }
 const target=current[0],ancestry=target.domAncestry;
 if(!target.visible||!target.enabled||target.readiness)block('target_not_ready',target.localId);
 if(o.boundaries?.length&&action.boundary?.key!==o.boundaries.at(-1)?.key)block('outside_active_boundary',target.localId);
 if(['click','hover'].includes(action.kind)&&target.actionable?.hitTarget!==true)block('target_hit_unproved',target.localId);
 const ancestryKnown=ancestry?.complete&&ancestry.documentId===o.documentId;
 for(const gap of o.gaps.filter(g=>!g.critical&&(g.code.startsWith('UNSUPPORTED_')||g.code.endsWith('_UNSUPPORTED')))){
   const scope=gap.coverageScope,ref=scope?.rootInstanceId||gap.reference||gap.code;
   if(!ancestryKnown||!scope?.complete||scope.documentId!==o.documentId){block('capability_dependency_unproved',ref);continue;}
   if(scope.affectedControlIds.includes(target.localId)||scope.rootInstanceId===target.instanceId||ancestry!.instanceIds.includes(scope.rootInstanceId)||scope.ancestorInstanceIds.includes(target.instanceId))block('capability_dependency',ref);
   else independent.push(ref);
 }
 for(const other of unresolved){
   if(!other.visible)continue;
   if(other.localId===target.localId){block('target_review_unresolved',other.localId);continue;}
   const ancestors=other.domAncestry;
   if(!ancestryKnown||!ancestors?.complete||ancestors.documentId!==o.documentId){block('review_dependency_unproved',other.localId);continue;}
   const sharedForm=target.formOwner?.instanceId&&target.formOwner.instanceId===other.formOwner?.instanceId;
   const references=[...(target.classificationBinding?.references||[]),...(other.classificationBinding?.references||[])];
   if(ancestry!.instanceIds.includes(other.instanceId)||ancestors.instanceIds.includes(target.instanceId)||sharedForm
     ||references.some(ref=>ref.missing||ref.ambiguous||[target.instanceId,other.instanceId].includes(ref.targetInstanceId||'')
       ||ref.target?.nodes.some(node=>[target.instanceId,other.instanceId].includes(node.instanceId))))block('review_dependency',other.localId);
   else independent.push(other.localId);
 }
 return {allowed:!blockers.length,blockers,independent};
}
