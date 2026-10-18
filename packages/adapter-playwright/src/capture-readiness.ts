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
