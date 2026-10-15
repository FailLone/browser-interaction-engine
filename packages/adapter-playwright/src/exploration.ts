import { canonical, hash, id, type ExplorationCase, type RestorationStep } from '@interaction/core';
import type { ActionCandidate, Control, Observation, Session } from './types.js';
import { observableCanonical } from './model.js';
import { constrain } from './policy.js';
import { ruleMatches, signature } from './util.js';

function shape(c: Control) {
  const { valid: _valid, ...constraints } = c.constraints;
  return { signature: signature(c), visible: c.visible, enabled: c.enabled, editable: c.editable, constraints, options: c.options, list: c.list, purposeBinding: c.purposeBinding };
}

/** Deliberate representative sampling, not a proof that other values are irrelevant. */
export function explorationCase(action: ActionCandidate, o: Observation): ExplorationCase | undefined {
  const c = o.controls.find(c => c.identityId === action.controlId && c.localId === action.localId);
  if (!c || c.hypothesisId || o.gaps.some(g => g.critical)) return undefined;
  const input = ['fill', 'select', 'check'].includes(action.kind);
  const structuralScope = o.controls.filter(c => c.visible && c.actions.length).map(c => ({ key: c.stableKey || signature(c), role: c.role })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const projection = { url: o.url, boundary: o.boundaries?.map(b => b.key) || [], structuralScope, target: shape(c), valid: c.constraints.valid,
    ...(input ? {} : { text: c.displayedText, expanded: c.expanded }),
    risk: action.risk, replayable: action.replayable, basis: action.basis,
    excluded: action.excluded, exclusionReason: action.exclusionReason,
    blockers: action.preconditions.blockers?.map(b => b.code) || [] };
  return { key: hash(projection), policy: 'browser-representative-v1', evidence: [
    'Same logical control, operation, input sample and declared business context',
    'Same URL, boundary, visible control structure and target constraints/options',
    'Other field values and input starting values are sampled; combinations are not exhaustive',
  ] };
}

/** Control/operation coverage, independent of other controls' input combinations. */
export function controlCase(action: ActionCandidate, o: Observation): ExplorationCase | undefined {
  if (!action.controlId && ['scroll', 'press'].includes(action.kind)) return {
    key: hash({ url: o.url, boundaries: o.boundaries?.map(b => b.key) || [], kind: action.kind,
      viewport: action.kind === 'scroll' ? o.scroll : undefined }), policy: 'browser-controls-v1',
    evidence: ['Traversal operation grouped by interaction scope and viewport, independent of form values'],
  };
  const c = o.controls.find(c => c.identityId === action.controlId && c.localId === action.localId);
  if (!c || o.gaps.some(g => g.critical)) return;
  return { key: hash({ url: o.url, boundary: o.boundaries?.map(b => b.key) || [], shape: shape(c),
    instance: action.target?.instanceId, basis: action.basis, scroll: action.kind === 'scroll' ? c.scroll : undefined }), policy: 'browser-controls-v1',
    evidence: ['One operation sample per encountered control, target constraints, option and declared context',
      'Current-instance targets do not assert historical identity; all combinations are outside this coverage unit'] };
}

/** A changing read-only display is evidence, not an unstable editable target. */
export function interactionProjection(o: Pick<Observation, 'documentId' | 'url' | 'controls' | 'boundaries' | 'scroll'>) {
  return canonical({ document: o.documentId, url: o.url, boundaries: o.boundaries?.map(b => b.key) || [], scroll: o.scroll,
    controls: o.controls.filter(c => Object.entries(c.actionBasis || {}).some(([kind, b]) => b.status === 'supported' && !(c.readOnly && kind === 'fill'))).map(c => ({
      instance: c.instanceId, shape: shape(c), value: c.value, checked: c.checked, selected: c.selected, expanded: c.expanded,
      text: c.displayedText, rect: c.rect, actionable: c.actionable, basis: c.actionBasis, scroll: c.scroll,
    })) });
}

/** Only application-declared reversibility permits synthesizing an inverse operation. */
export function restorationStep(target: Observation, current: Observation, session: Session): RestorationStep | undefined {
  if (!session.options.reversible?.length || target.url !== current.url || canonical(target.context) !== canonical(current.context)
    || canonical(target.boundaries) !== canonical(current.boundaries) || target.gaps.some(g => g.critical) || current.gaps.some(g => g.critical)) return;
  for (const c of current.controls) {
    if (!c.identityId || c.hypothesisId || !c.visible || !c.enabled) continue;
    const matches = target.controls.filter(t => t.identityId === c.identityId && !t.hypothesisId);
    if (matches.length !== 1 || current.controls.filter(t => t.identityId === c.identityId).length !== 1) continue;
    const old = matches[0];
    if (canonical(shape(old)) !== canonical(shape(c))) continue;
    const kind = c.actions.includes('fill') && c.value !== old.value ? 'fill'
      : c.actions.includes('select') && c.value !== old.value ? 'select'
      : c.actions.includes('check') && c.checked !== old.checked && old.checked !== null ? 'check' : undefined;
    if (!kind || c.actionBasis?.[kind]?.status !== 'supported') continue;
    const action: ActionCandidate = { id: id(), sessionId: current.sessionId, observationId: current.id, stateId: current.stateId,
      controlId: c.identityId, localId: c.localId, kind, label: c.name, value: kind === 'check' ? old.checked : old.value,
      preconditions: { context: current.context, visible: true, enabled: true, identityResolved: true }, basis: c.actionBasis[kind],
      risk: 'interface', replayable: true, source: 'recovery-local', excluded: false, sampleValidity: 'known' };
    if (!session.options.reversible.some(rule => ruleMatches(rule, action, c, current.url))) continue;
    const constrained = constrain(action, current, session);
    if (constrained.excluded || constrained.preconditions.blockers?.length) continue;
    // Predict exactly this field's inverse. Unexpected effects on other controls
    // invalidate the step even if its target field was successfully restored.
    const restored: Control = { ...c, value: old.value, checked: old.checked, selected: old.selected, constraints: old.constraints };
    const expectedCanonical = observableCanonical({ ...current, controls: current.controls.map(x => x === c ? restored : x) });
    return { action: constrained, expectedCanonical, evidence: ['Application-declared reversible operation', `Restore ${c.identityId} from observation ${target.id}`, 'Verify complete observable projection after the inverse operation'] };
  }
}
