import {canonical} from '@interaction/core';
import {hasObservedBoundaryExit,hasDeclaredBoundaryExit} from './policy.js';
import {hasReviewedDismissal} from './boundary-exit.js';
import type {ActionCandidate,Observation} from './types.js';

type View=Pick<Observation,'documentId'|'url'|'boundaries'|'overlays'|'regions'|'gaps'>;
/** A closed exclusive layer is independent of changing controls in its parent.
 * This proves the observed exit only, never readiness of parent operations. */
export function boundaryExitTransition(action:ActionCandidate,before:Observation,after:View):boolean {
 const active=before.boundaries?.at(-1),overlay=before.overlays?.at(-1);
 if(!active||overlay?.key!==active.key||action.boundary?.intent!=='exit'||action.boundary.key!==active.key
   ||action.observationId!==before.id||action.sessionId!==before.sessionId||action.risk!=='interface'||action.basis?.status!=='supported'
   ||before.documentId!==after.documentId||before.url!==after.url||after.gaps.some(g=>g.critical))return false;
 if(!(hasObservedBoundaryExit(action,before)||hasDeclaredBoundaryExit(action,before)||hasReviewedDismissal(action,before)
   ||action.kind==='press'&&action.value==='Escape'&&!action.localId&&!action.controlId))return false;
 const parents=(view:View)=>view.overlays?.map(o=>({key:o.key,kind:o.kind,parentKey:o.parentKey,parentRegion:o.parentRegion,
   instanceId:view.regions.find(r=>r.key===o.key)?.instanceId}));
 return canonical(after.boundaries||[])===canonical(before.boundaries!.slice(0,-1))
   &&canonical(parents(after)||[])===canonical(parents(before)!.slice(0,-1));
}

/** Current DOM acquisition gaps, separate from operation effects and identity.
 * A live placeholder is unknown; aria-busy/progress are positive pending signals. */
export function unresolvedContentScopes(view: Pick<Observation,'navigationScopes'|'controls'|'overlays'|'boundaries'>) {
 const active=view.overlays?.at(-1),ids=active&&active.key===view.boundaries?.at(-1)?.key?new Set(active?.controlIds):undefined;
 return (view.navigationScopes||[]).filter(s=>(!ids||s.controlIds.some(id=>ids.has(id)))
  &&(s.contentSignals?.length||s.kind==='disclosure'&&s.triggerIds?.some(id=>view.controls.some(c=>c.localId===id&&c.visible))&&(!s.complete||s.triggerIds?.some(id=>s.blockedControlIds.includes(id)))));
}

export function contentBlockedControls(view: Pick<Observation,'navigationScopes'|'controls'|'overlays'|'boundaries'>) {
 return new Set(unresolvedContentScopes(view).flatMap(s=>s.complete?s.blockedControlIds:s.controlIds));
}

/** The observed opening is separate from acquisition of its asynchronous children.
 * This can finish the opener's observation, never a child or business outcome. */
export function disclosureTransition(action:ActionCandidate,before:Observation,after:Pick<Observation,'documentId'|'url'|'controls'|'navigationScopes'|'boundaries'|'gaps'>) {
 if(before.coveragePolicy!=='finite-ui-v1'||action.observationId!==before.id||action.sessionId!==before.sessionId
  ||action.basis?.status!=='supported'||!['click','hover','focus'].includes(action.kind)||action.risk==='submission'
  ||before.documentId!==after.documentId||before.url!==after.url||canonical(before.boundaries||[])!==canonical(after.boundaries||[])
  ||after.gaps.some(g=>g.critical))return;
 const targets=before.controls.filter(c=>c.localId===action.localId),fresh=after.controls.filter(c=>c.localId===action.localId);
 if(targets.length!==1||fresh.length!==1||targets[0].instanceId!==fresh[0].instanceId||!fresh[0].visible)return;
 const scopes=before.navigationScopes?.filter(s=>s.kind==='disclosure'&&s.complete&&s.expanded===false&&s.triggerIds?.includes(action.localId!))||[];
 if(scopes.length!==1)return;
 const current=after.navigationScopes?.filter(s=>s.rootId===scopes[0].rootId&&s.kind==='disclosure'&&s.complete&&s.expanded===true&&s.triggerIds?.includes(action.localId!));
 return current?.length===1?current[0]:undefined;
}

export function disclosureObservationReady(action:ActionCandidate,before:Observation,after:Observation) {
 const proof=after.disclosureCapture,scope=disclosureTransition(action,before,after);
 return !!proof&&proof.version===1&&proof.beforeId===before.id&&proof.actionId===action.id&&proof.rootId===scope?.rootId
  &&proof.samples>=2&&proof.settledMs>=0&&canonical(before.context)===canonical(after.context);
}
