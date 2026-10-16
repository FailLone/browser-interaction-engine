import type { ActionCandidate, Observation } from './types.js';

export interface ExecutionBlocker {
  code: string; reason: string; evidence: string[];
  /** The current scope decision, not a fact inferred from a frontier reason string. */
  selection?: {
    state: 'pending' | 'invalidated' | 'skipped' | 'deferred' | 'unselected';
    groupId: string; revision?: number; memberKey?: string;
  };
}
export interface ExecutionGuard {
  observationId: string;
  /** A required historical repetition proof, rechecked inside queued dispatch. */
  repetitionSource?: { sessionId: string; attemptId: string };
  /** Conservative autonomous interaction; ordinary external execution keeps its existing policy. */
  profile: 'interface-exploration' | 'observed-ui-exploration';
}
/** An explicitly bounded observation operation, not ordinary action authorization. */
export interface ProbeGuard { observationId: string; profile: 'observed-ui-probe' }
export type DispatchGuard = ExecutionGuard | ProbeGuard;
export interface ProbeAvailability {
  sessionId: string; observationId: string; localId: string; kind: string;
  profile: 'observed-ui-probe'; revision: string; executable: boolean;
  blockers: ExecutionBlocker[]; dispatchRevalidationRequired: true;
}
export interface ActionAvailability {
  sessionId: string; observationId: string; revision: string;
  profile: ExecutionGuard['profile'];
  actions: { actionId: string; executable: boolean; blockers: ExecutionBlocker[] }[];
  /** A read is not a reservation. The queued dispatch checks again, then performs live preflight. */
  dispatchRevalidationRequired: true;
}

/** Eligibility for a caller-authorized UI operation, not a statement about business effects.
 * Current target resolution, boundaries, reviews and execution state are checked separately.
 * In particular this never authorizes probing missing capabilities or arbitrary driver actions.
 */
export function isObservedUIOperation(action: ActionCandidate, observation: Observation): boolean {
  return action.observationId === observation.id && action.basis?.status === 'supported'
    && action.risk === 'unknown' && action.source !== 'external-probe'
    && ['click', 'fill', 'select', 'check', 'hover', 'focus', 'press', 'scroll'].includes(action.kind)
    && !!action.localId && observation.controls.filter(c => c.localId === action.localId).length === 1;
}

/** Only the dedicated probe interface may consume this policy. Ordinary execute still rejects it. */
export function isObservedUIProbe(action: ActionCandidate, observation: Observation): boolean {
  const targets=observation.controls.filter(c=>c.localId===action.localId);
  return action.source==='external-probe' && ['hover','focus'].includes(action.kind) && action.value===undefined
    && action.observationId===observation.id && targets.length===1 && !!targets[0].instanceId
    && observation.controls.filter(c=>c.instanceId===targets[0].instanceId).length===1
    && action.target?.kind==='instance' && action.target.instanceScope===observation.instanceScope
    && action.target.instanceId===targets[0].instanceId && action.risk==='unknown';
}
