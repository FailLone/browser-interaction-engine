import { canonical, hash } from '@interaction/core';
import type { ActionCandidate, Control, Observation } from './types.js';
import { formBinding } from './util.js';

/** A bound on evidence, not permission to ignore additional dependencies. */
export const MAX_BRANCH_CONDITIONS = 32;
export interface BrowserBranchConditions {
  policy: 'browser-branch-conditions-v1';
  key: string;
  conditions: { binding: string; state: Record<string, string[] | boolean | 'mixed'>; relation: string }[];
  evidence: string[];
}

/** These are observed UI mode selectors, not arbitrary text/value combinations. */
function selectorState(c: Control, selections: Map<string, boolean>) {
  const state: Record<string, string[] | boolean | 'mixed'> = {};
  if (c.checked !== null && c.checked !== undefined) state.checked = c.checked;
  else if (['checkbox', 'radio', 'switch'].includes(c.role)) return null;
  if (c.pressed !== null && c.pressed !== undefined) state.pressed = c.pressed;
  if (c.expanded !== null && c.expanded !== undefined) state.expanded = c.expanded;
  if (c.tag === 'select') state.selected = [...c.selected].sort();
  else if (['tab', 'option', 'treeitem'].includes(c.role)) {
    if (c.selected.length > 0) state.selected = true;
    else if (selections.has(c.localId)) state.selected = selections.get(c.localId)!;
    // Empty selected[] alone cannot distinguish explicit aria-selected=false
    // from an absent attribute. The observed component member preserves that.
    else if (['tab', 'option'].includes(c.role)) return null;
  }
  return Object.keys(state).length ? state : undefined;
}

function binding(c: Control) {
  // Unkeyed virtual records and unresolved selectors cannot establish portable
  // source conditions. Never substitute a row/DOM instance or its index.
  if (c.identityScope === 'instance' || c.hypothesisId || c.structuralItem && !c.structuralItem.recordKey) return;
  const item = c.structuralItem;
  return canonical({ tag: c.tag, role: c.role, name: c.label || c.name, type: c.constraints.type,
    anchor: item ? { record: item.recordKey, template: item.template, slot: item.slot } : c.stableKey,
    scope: c.identityContext?.scope, binding: c.identityContext?.binding, form: formBinding(c) });
}

function componentAncestors(o: Observation) {
  const components = new Map((o.components || []).filter(c => c.basis.status === 'supported').map(c => [c.id, c]));
  const memberships = new Map<string, string[]>(), cache = new Map<string, Set<string>>();
  for (const component of components.values()) for (const member of component.members) memberships.set(member.localId, [...(memberships.get(member.localId) || []), component.id]);
  return (localId: string) => {
    if (cache.has(localId)) return cache.get(localId)!;
    const result = new Set<string>();
    for (const id of memberships.get(localId) || []) {
      let current = components.get(id);
      while (current && !result.has(current.id)) { result.add(current.id); current = current.parentId ? components.get(current.parentId) : undefined; }
    }
    cache.set(localId, result); return result;
  };
}

function regionAncestors(o: Observation) {
  const regions = new Map(o.regions.map(r => [r.key, r])), cache = new Map<string, Set<string>>();
  return (key: string) => {
    if (cache.has(key)) return cache.get(key)!;
    const original = key, result = new Set<string>();
    // The implicit document region supplies no locality evidence.
    while (regions.has(key) && regions.get(key)!.role !== 'document' && !result.has(key)) { result.add(key); key = regions.get(key)!.parentKey || ''; }
    cache.set(original, result); return result;
  };
}

/**
 * Versioned, bounded source-condition sampling. Like fragment-local comparison,
 * this avoids whole-page text equality; it does not infer causal dependencies or
 * grant identity, readiness, replay permission, or exhaustive branch coverage.
 * Nonlocal application modes still require declared context rules.
 *
 * Only captured form ownership, declared component ancestry and semantic region
 * ancestry establish locality. Missing/ambiguous/unstable selector evidence or
 * overflow declines equivalence instead of silently truncating the projection.
 */
export function browserBranchConditions(action: Pick<ActionCandidate, 'kind' | 'localId'>, o: Observation): BrowserBranchConditions | undefined {
  const target = o.controls.find(c => c.localId === action.localId);
  if (!target || o.gaps.some(g => g.critical) || Object.values(o.context).some(v => v.status !== 'known')) return;
  const components = componentAncestors(o), regions = regionAncestors(o);
  const targetComponents = components(target.localId), targetRegions = regions(target.region);
  const selections = new Map((o.components || []).flatMap(c => c.members.filter(m => typeof m.selected === 'boolean').map(m => [m.localId, m.selected!] as const)));
  const conditions: BrowserBranchConditions['conditions'] = [], bindings = new Set<string>();
  for (const c of o.controls) {
    if (!c.visible) continue;
    const state = selectorState(c, selections); if (state === undefined) continue;
    // The sample's destination value is already part of the operation key. Its
    // own starting value must not manufacture repeated fill/select/check work.
    if (c === target && ['fill', 'select', 'check'].includes(action.kind)) continue;
    let relation: string | undefined;
    if (c === target) relation = 'target-mode';
    else if (target.formOwner && c.formOwner?.instanceId === target.formOwner.instanceId) relation = 'same-native-form';
    else if ([...components(c.localId)].some(id => targetComponents.has(id))) relation = 'shared-declared-component';
    // Distinct forms remain independent even inside the same main/region. An
    // explicit common component can still supply cross-form locality above.
    else if (!target.formOwner && !c.formOwner && (targetRegions.has(c.region) || regions(c.region).has(target.region))) relation = 'shared-semantic-region';
    else if (!target.formOwner && !c.formOwner && c.region === target.region && !targetRegions.size) relation = 'same-unpartitioned-region';
    if (!relation) continue;
    if (state === null || c.readiness?.status === 'unstable') return;
    const key = binding(c); if (!key || bindings.has(key)) return;
    bindings.add(key); conditions.push({ binding: key, state, relation });
    if (conditions.length > MAX_BRANCH_CONDITIONS) return;
  }
  conditions.sort((a, b) => a.binding.localeCompare(b.binding));
  const policy = 'browser-branch-conditions-v1' as const;
  return { policy, key: hash({ policy, conditions }), conditions, evidence: [
    'Captured selector state in the target form, declared component or semantic region',
    'Passive text and free-text starting values excluded; selector values and semantic bindings retained',
    'Observed source-condition samples only; undeclared nonlocal dependencies and all combinations are not covered',
  ] };
}
