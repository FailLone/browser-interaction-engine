// The same dependency predicate is enforced by SDK dispatch, including replay.
export {progressDependencies} from '@interaction/browser';

import type {Observation,IdentityHypothesis} from '@interaction/browser';
import type {ExplorerHost} from './types.js';

/** Same current review/identity dependencies for selection and continuation. */
export function unresolvedDependencyControls(host:ExplorerHost,o:Observation){
 const interpretations=host.controlInterpretationSnapshot(o.sessionId,o.id);
 const pending=new Set(host.list<IdentityHypothesis>(o.sessionId,'hypothesis').filter(h=>h.status==='pending').map(h=>h.id));
 const ids=new Set([...interpretations.classifications.controls.filter(c=>c.needsClassification).map(c=>c.control.localId),
   ...interpretations.operations.controls.filter(c=>c.needsReview).map(c=>c.control.localId),
   ...o.controls.filter(c=>c.hypothesisId&&pending.has(c.hypothesisId)).map(c=>c.localId)]);
 return o.controls.filter(c=>ids.has(c.localId));
}
