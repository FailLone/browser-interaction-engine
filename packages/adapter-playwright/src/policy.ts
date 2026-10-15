import { EngineError } from '@interaction/core';
import type { ActionCandidate, Observation, Session } from './types.js';
import { ruleMatches } from './util.js';
export function constrain(action: ActionCandidate, observation: Observation, session: Session) {
  const control = observation.controls.find(c => c.identityId === action.controlId && c.localId === action.localId);
  if (session.options.exploration === 'controls' && control?.hypothesisId) {
    action.target = { kind: 'instance', instanceScope: observation.instanceScope, instanceId: control.instanceId,
      evidence: ['Unique current node instance; historical logical identity remains unresolved', `observation:${observation.id}`] };
    action.replayable = false;
  }
  action.basis ??= control?.actionBasis?.[action.kind] || { status: 'tentative', evidence: [{ source: action.source || 'external', rule: 'missing-operation-evidence/v1', facts: { kind: action.kind } }] };
  const active = observation.overlays?.at(-1);
  action.preconditions.blockers = [];
  action.boundary = undefined;
  if (active) {
    const exit = action.kind === 'press' && action.value === 'Escape' && !control || !!control && ['click', 'press', 'check'].includes(action.kind) && active.exitControlIds.includes(control.localId);
    const inside = !!control && active.controlIds.includes(control.localId);
    if (inside || exit) action.boundary = { key: active.key, intent: exit ? 'exit' : 'interact' };
    else action.preconditions.blockers.push({ code: 'outside_active_boundary', boundaryKey: active.key, evidence: active.evidence, unblock: `Close and verify exit from ${active.name} before interacting with its parent` });
  }
  if (control && ['click', 'check', 'hover'].includes(action.kind)) {
    if (control.actionable.outsideScrollableArea) action.preconditions.blockers.push({ code: 'outside_scrollable_area', evidence: ['target-outside-scrollable-viewport'], unblock: 'Make the control reachable in the viewport' });
    else if (control.actionable.hitTarget === false) action.preconditions.blockers.push({ code: 'pointer_intercepted', evidence: [control.actionable.occludedBy || 'hit-test-failed'], unblock: 'Remove the obstruction and observe again' });
  }
  if (control && action.kind === 'fill' && !control.editable) action.preconditions.blockers.push({ code: 'not_editable', evidence: ['observed-editable=false'], unblock: 'Wait until the field is editable and observe again' });
  if (!['click', 'fill', 'select', 'check', 'scroll', 'press', 'hover', 'focus'].includes(action.kind)) throw new EngineError('INVALID_PLUGIN_ACTION', 'Unsupported browser action kind');
  if (session.options.exclude.some(rule => ruleMatches(rule, action, control, observation.url))) { action.excluded = true; action.exclusionReason = 'excluded_by_rule'; }
  if (control?.constraints.type === 'file') { action.excluded = true; action.exclusionReason = 'unsupported_file_input'; }
  if (session.options.replayable.some(rule => ruleMatches(rule, action, control, observation.url))) action.replayable = true;
  if (action.risk !== 'submission' && action.basis.status === 'supported' && session.options.interfaceActions?.some(rule => ruleMatches(rule, action, control, observation.url))) {
    action.risk = 'interface'; action.replayable = true;
  }
  if (['hover', 'focus'].includes(action.kind)) { action.risk = 'unknown'; action.replayable = false; }
  return action;
}
