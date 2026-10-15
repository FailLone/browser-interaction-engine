import { canonical, hash, id, type ExplorationCase, type RestorationStep } from '@interaction/core';
import type { ActionCandidate, Control, Observation, Session } from './types.js';
import { observableCanonical } from './model.js';
import { constrain } from './policy.js';
import { ruleMatches, signature, formBinding } from './util.js';

function shape(c: Control) {
  const { valid: _valid, ...constraints } = c.constraints;
  const item=c.structuralItem;
  const structuralItem=item?{ownerInstanceId:item.ownerInstanceId,template:item.template,slot:item.slot,recordKey:item.recordKey,...(item.recordKey?{}:{rowInstanceId:item.rowInstanceId})}:undefined;
  return { signature: signature(c), stableKey: c.stableKey, identityScope: c.identityScope, visible: c.visible, enabled: c.enabled, editable: c.editable, constraints, options: c.options, list: c.list, purposeBinding: c.purposeBinding, formOwner: formBinding(c), structuralItem };
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
      viewport: action.kind === 'scroll' ? (action.source === 'scroll-traversal' ? action.value : o.scroll) : undefined }), policy: 'browser-controls-live-v3',
    evidence: ['Traversal operation grouped by interaction scope and viewport, independent of form values'],
  };
  const c = o.controls.find(c => c.identityId === action.controlId && c.localId === action.localId);
  if (!c || o.gaps.some(g => g.critical)) return;
  // Review record IDs identify evidence, not a new operation. Preserve the
  // reviewed DOM conditions and risk; dispatch still validates the exact review.
  const reviewed = action.basis?.evidence.some(e => e.rule === 'reviewed-control/v1');
  const basis = reviewed ? { ...action.basis, evidence: action.basis!.evidence.map(e => e.rule === 'reviewed-control/v1'
    ? { source: e.source, rule: e.rule } : e) } : action.basis;
  const { instanceId: _formInstance, ...reviewForm } = c.reviewBinding?.form || {};
  const reviewBinding = reviewed ? { name: c.name, tag: c.tag, readOnly: c.readOnly,
    attributes: c.reviewBinding?.attributes, form: reviewForm } : undefined;
  return { key: hash({ url: o.url, boundary: o.boundaries?.map(b => b.key) || [], shape: shape(c),
    instance: c.hypothesisId || c.identityScope === 'instance' ? c.instanceId : undefined,
    basis, reviewBinding, risk: action.risk, scroll: action.kind === 'scroll' ? c.scroll : undefined }), policy: 'browser-controls-live-v3',
    evidence: ['One operation sample per encountered control, target constraints, option and declared context',
      'Current-instance targets do not assert historical identity; all combinations are outside this coverage unit'] };
}

/** Compare interaction semantics, retaining editable values and obstruction checks.
 * Geometry is checked for the selected action target at preflight; unrelated
 * movement must not require the entire page to reach visual rest. */
export function interactionProjection(o: Pick<Observation, 'documentId' | 'url' | 'controls' | 'boundaries' | 'scroll'>, targetInstance?: string) {
  return canonical({ document: o.documentId, url: o.url, boundaries: o.boundaries?.map(b => b.key) || [], scroll: o.scroll,
    controls: o.controls.filter(c => c.instanceId === targetInstance || Object.entries(c.actionBasis || {}).some(([kind, b]) => b.status === 'supported' && !(c.readOnly && kind === 'fill'))).map(c => ({
      instance: c.instanceId, formOwner: c.formOwner, shape: shape(c), value: c.value, checked: c.checked, pressed: c.pressed, selected: c.selected, expanded: c.expanded,
      text: c.liveContent?.text ?? c.displayedText, rect: targetInstance === c.instanceId ? c.rect : undefined,
      actionable: { visible: c.actionable.visible, enabled: c.actionable.enabled, editable: c.actionable.editable,
        hitTarget: c.actionable.hitTarget, outsideScrollableArea: c.actionable.outsideScrollableArea, occludedBy: c.actionable.occludedBy },
      basis: c.actionBasis, scroll: c.scroll,
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
