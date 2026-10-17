import { canonical, hash, type ControlReviewTargetCorrespondence } from '@interaction/core';
import { classificationCorrespondenceConditions } from './classification-correspondence.js';
import { browserControlBindingKey, browserControlCorrespondence } from './exploration.js';
import { browserReviewBranchConditions } from './branch-conditions.js';
import { activeInteractionIds } from './interaction-scope.js';
import type { Control, Observation } from './types.js';

type Facts = Pick<ControlReviewTargetCorrespondence, 'targetMatched' | 'reviewable' | 'sourceEquivalent' | 'reason' | 'conditionKey' | 'currentMaterialKey' | 'evidence'>;
const locator = (c: Control) => {
  const hint = browserControlCorrespondence(c);
  return hint && canonical({ hint: hint.key, binding: browserControlBindingKey(c), tag: c.tag, role: c.role, name: c.name, label: c.label });
};
const boundaries = (o: Observation) => {
  const rows = [];
  for (const b of o.boundaries || []) {
    const overlay = o.overlays?.find(v => v.key === b.key), region = o.regions.find(r => r.key === b.region);
    if (!b.name || !overlay) return;
    rows.push({ name: b.name, kind: overlay.kind, region: region && { role: region.role, label: region.label } });
  }
  return rows;
};
/** One synchronous selection over an immutable captured observation. Build
 * document facts once and cache each target projection only within this reader;
 * callers must create a fresh reader for another observation or after await.
 * These negative scheduling keys retain missing/ambiguous mode evidence and
 * concrete instances, without certifying equivalence, execution or coverage. */
export function createBrowserControlReviewMaterialKey(o: Observation): (target: Control) => string | undefined {
  const policy = 'current-review-material/v2';
  const modeControls = o.controls.filter(c => c.checked != null || c.pressed != null || c.expanded != null || c.selected?.length
    || c.tag === 'select' || ['checkbox', 'radio', 'switch', 'tab', 'option', 'treeitem'].includes(c.role));
  const modeIds = new Set(modeControls.map(c => c.localId));
  const modes = modeControls.map(c => ({
      localId: c.localId, instanceId: c.instanceId, hint: locator(c), identityScope: c.identityScope, hypothesisId: c.hypothesisId,
      record: c.structuralItem, formOwner: c.formOwner, region: c.region, visible: c.visible, readiness: c.readiness,
      tag: c.tag, role: c.role, checked: c.checked, pressed: c.pressed, expanded: c.expanded, selected: c.selected,
    }));
  const memberships = new Map<string, { componentId: string; selected?: boolean }[]>();
  const components = o.components?.map(c => {
    const members: { localId: string; selected?: boolean }[] = [];
    for (const m of c.members) {
      const membership = { componentId: c.id, selected: m.selected }, prior = memberships.get(m.localId);
      if (prior) prior.push(membership); else memberships.set(m.localId, [membership]);
      if (modeIds.has(m.localId)) members.push({ localId: m.localId, selected: m.selected });
    }
    return { id: c.id, parentId: c.parentId, basis: c.basis.status, members };
  });
  const page = hash({ policy, instanceScope: o.instanceScope, ruleVersion: o.ruleVersion, url: o.url,
    context: o.context, modes, components,
    boundaries: o.boundaries, overlays: o.overlays?.map(c => ({ key: c.key, kind: c.kind, parentKey: c.parentKey, controlIds: c.controlIds })),
    completeness: { stable: o.stable, gaps: o.gaps.filter(g => g.critical || ['INTERACTION_STABLE', 'PARTIAL_INTERACTION_READY'].includes(g.code)) },
  });
  const targets = new WeakMap<Control, string | undefined>();
  return target => {
    if (!targets.has(target)) {
      const classification = classificationCorrespondenceConditions(target, o)?.conditionKey;
      targets.set(target, classification ? hash({ policy, page, classification,
        target: { localId: target.localId, visible: target.visible, readiness: target.readiness },
        memberships: memberships.get(target.localId) || [],
      }) : undefined);
    }
    return targets.get(target);
  };
}

/** Convenience form; multi-target callers should share one observation reader. */
export function browserControlReviewMaterialKey(target: Control, o: Observation): string | undefined {
  return createBrowserControlReviewMaterialKey(o)(target);
}

/** Match a real captured control for NEW interpretation. Historical source
 * equivalence is a separate output and keeps all observed nonlocal modes. */
export function browserControlReviewTargetCorrespondence(source: Control, before: Observation, target: Control, current: Observation): Facts {
  const result: Facts = { targetMatched: false, reviewable: false, sourceEquivalent: 'unknown', reason: 'review_target_not_corresponding', evidence: [] };
  const retained = before.sessionId === current.sessionId && before.instanceScope === current.instanceScope && source.instanceId === target.instanceId;
  const oldLocator = retained ? undefined : locator(source), targetLocator = retained ? undefined : locator(target);
  if (!retained && (!oldLocator || !targetLocator || oldLocator !== targetLocator || source.hypothesisId || target.hypothesisId
    || source.identityScope === 'instance' || target.identityScope === 'instance')) return result;
  // Eliminate unrelated candidates before any full-observation uniqueness
  // scans; recovery checks all controls, but only possible matches need these.
  const uniqueInstance = (o: Observation, c: Control) => o.controls.filter(v => v.localId === c.localId).length === 1
    && o.controls.filter(v => v.instanceId === c.instanceId).length === 1;
  if (!uniqueInstance(before, source) || !uniqueInstance(current, target)) { result.reason = 'review_target_ambiguous'; return result; }
  if (!retained) {
    // Count incomplete rivals before projecting their material. Missing subtree
    // evidence must not manufacture a unique target.
    if ([before, current].some(o => o.controls.filter(c => locator(c) === targetLocator).length !== 1)) { result.reason = 'review_target_ambiguous'; return result; }
  }
  result.targetMatched = true;
  if (before.url !== current.url || current.gaps.some(g => g.critical) || Object.values(current.context).some(c => c.status !== 'known')) {
    result.reason = 'review_context_unavailable'; return result;
  }
  const now = classificationCorrespondenceConditions(target, current);
  if (!now) { result.reason = 'review_material_incomplete'; return result; }
  result.currentMaterialKey = browserControlReviewMaterialKey(target, current);
  result.evidence = [...now.evidence, retained ? 'retained-current-instance' : 'unique-captured-control-and-owner'];
  const active = activeInteractionIds(current);
  if (current.boundaries?.length && (!active || !active.has(target.localId))) { result.reason = 'outside_active_boundary'; return result; }
  if (!target.visible || target.readiness || !current.stable && !current.gaps.some(g => ['INTERACTION_STABLE', 'PARTIAL_INTERACTION_READY'].includes(g.code))) {
    result.reason = 'review_target_unsettled'; return result;
  }
  result.reviewable = true; result.reason = 'current_review_material_available';
  const modes = browserReviewBranchConditions(target, current), boundary = boundaries(current);
  const condition = (classification: string, modes: string, boundaryFacts: NonNullable<ReturnType<typeof boundaries>>) =>
    hash({ policy: 'control-review-source/v1', classification, modes, boundaries: boundaryFacts });
  // This key is portable source evidence only. A negative material wait key
  // or same-record reflexivity must not manufacture a known branch projection.
  if (modes && boundary) result.conditionKey = condition(now.conditionKey, modes.key, boundary);
  // Reflexive evidence belongs to this one captured occurrence, even if its
  // nonlocal projection is incomplete. The core record query deliberately
  // shares objects only for an exact owned observation/localId reference.
  // Equal IDs, names or copied records do not extend this proof historically.
  if (before === current && source === target) {
    result.sourceEquivalent = 'equivalent';
    result.reason = 'same_recorded_review_occurrence'; result.evidence.push('same-owned-observation-and-control-record'); return result;
  }
  const old = classificationCorrespondenceConditions(source, before), priorModes = browserReviewBranchConditions(source, before);
  const oldBoundary = boundaries(before);
  // v8 changed only canonical state encoding, not captured classification or
  // selector evidence. Permit this explicit pair under the same complete
  // review-source projection; never migrate/checkpoint-normalize either record.
  const comparableRules = before.ruleVersion === current.ruleVersion
    || ['observable-v7', 'observable-v8'].includes(before.ruleVersion) && ['observable-v7', 'observable-v8'].includes(current.ruleVersion);
  if (!old || !priorModes || !modes || !oldBoundary || !boundary || !comparableRules) return result;
  const prior = condition(old.conditionKey, priorModes.key, oldBoundary);
  result.sourceEquivalent = old.identityKey === now.identityKey && prior === result.conditionKey ? 'equivalent' : 'different';
  result.reason = result.sourceEquivalent === 'equivalent' ? 'equivalent_review_source_conditions' : 'review_source_conditions_changed';
  return result;
}
