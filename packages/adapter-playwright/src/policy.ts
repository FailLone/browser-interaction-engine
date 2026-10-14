import { EngineError } from '@interaction/core';
import type { ActionCandidate, Observation, Session } from './types.js';
import { ruleMatches } from './util.js';

/** A current, sourced exit intent; never a proof of exit or a historical replay grant. */
export function hasDeclaredBoundaryExit(action: ActionCandidate, observation: Observation) {
  const active = observation.overlays?.at(-1);
  const control = observation.controls.find(c => c.identityId === action.controlId && c.localId === action.localId);
  return !!active && !!control && action.kind === 'click' && action.risk === 'interface' && action.basis?.status === 'supported'
    && !control.actionBasis?.click?.evidence.some(e => e.rule === 'native-button/v1' && e.facts.submitsForm === true)
    && action.basis.evidence.some(e => e.rule === 'declared-boundary-exit/v1' && !!e.source.trim()
      && e.facts.boundaryKey === active.key && e.facts.observationId === observation.id && e.facts.localId === control.localId
      && Array.isArray(e.facts.evidence) && e.facts.evidence.length > 0 && e.facts.evidence.every(value => typeof value === 'string' && !!value.trim()));
}

export function constrain(action: ActionCandidate, observation: Observation, session: Session) {
  const control = observation.controls.find(c => c.identityId === action.controlId && c.localId === action.localId);
  if (session.options.exploration === 'controls' && control?.hypothesisId) {
    action.target = { kind: 'instance', instanceScope: observation.instanceScope, instanceId: control.instanceId,
      evidence: ['Unique current node instance; historical logical identity remains unresolved', `observation:${observation.id}`] };
    action.replayable = false;
  }
  action.basis ??= control?.actionBasis?.[action.kind] || { status: 'tentative', evidence: [{ source: action.source || 'external', rule: 'missing-operation-evidence/v1', facts: { kind: action.kind } }] };
  // Caller judgments may add semantics, but cannot erase a native submission.
  const submitsForm = action.kind === 'click' && control?.actionBasis?.click?.evidence.some(e => e.rule === 'native-button/v1' && e.facts.submitsForm === true);
  if (submitsForm) action.risk = 'submission';
  const active = observation.overlays?.at(-1);
  let declaredExit = false;
  action.preconditions.blockers = [];
  action.boundary = undefined;
  if (active) {
    // Some popups close through an external toggle without DOM ownership hints.
    // This is a sourced intent for this observation, not evidence of an exit.
    declaredExit = hasDeclaredBoundaryExit(action, observation);
    const exit = action.kind === 'press' && action.value === 'Escape' && !control || !!control && active.exitControlIds.includes(control.localId) || declaredExit;
    const inside = !!control && active.controlIds.includes(control.localId);
    if (inside || exit) action.boundary = { key: active.key, intent: exit ? 'exit' : 'interact' };
    else action.preconditions.blockers.push({ code: 'outside_active_boundary', boundaryKey: active.key, evidence: active.evidence, unblock: `Close and verify exit from ${active.name} before interacting with its parent` });
  }
  if (control && ['click', 'check', 'scroll'].includes(action.kind)) {
    if (control.actionable.outsideScrollableArea) action.preconditions.blockers.push({ code: 'outside_scrollable_area', evidence: ['target-outside-scrollable-viewport'], unblock: 'Make the control reachable in the viewport' });
    else if (control.actionable.hitTarget === false) action.preconditions.blockers.push({ code: 'pointer_intercepted', evidence: [control.actionable.occludedBy || 'hit-test-failed'], unblock: 'Remove the obstruction and observe again' });
  }
  if (control && action.kind === 'fill' && !control.editable) action.preconditions.blockers.push({ code: 'not_editable', evidence: ['observed-editable=false'], unblock: 'Wait until the field is editable and observe again' });
  if (!['click', 'fill', 'select', 'check', 'scroll', 'press'].includes(action.kind)) throw new EngineError('INVALID_PLUGIN_ACTION', 'Unsupported browser action kind');
  if (session.options.exclude.some(rule => ruleMatches(rule, action, control, observation.url))) { action.excluded = true; action.exclusionReason = 'excluded_by_rule'; }
  if (control?.constraints.type === 'file') { action.excluded = true; action.exclusionReason = 'unsupported_file_input'; }
  if (session.options.replayable.some(rule => ruleMatches(rule, action, control, observation.url))) action.replayable = true;
  if (action.risk !== 'submission' && action.basis.status === 'supported' && session.options.interfaceActions?.some(rule => ruleMatches(rule, action, control, observation.url))) {
    action.risk = 'interface'; action.replayable = true;
  }
  if (declaredExit) action.replayable = false;
  return action;
}
