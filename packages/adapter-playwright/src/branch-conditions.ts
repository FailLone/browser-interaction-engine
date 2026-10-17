import { canonical, hash, type ReviewConditionAssessment } from '@interaction/core';
import type { ActionCandidate, Control, Observation } from './types.js';
import { formBinding } from './util.js';
import { modeStructureReader } from './mode-structure.js';

/** A bound on evidence, not permission to ignore additional dependencies. */
export const MAX_BRANCH_CONDITIONS = 32;
export interface BrowserBranchConditions {
  policy: 'browser-branch-conditions-v1' | 'browser-branch-conditions-v2' | 'browser-branch-conditions-v4';
  key: string;
  conditions: { binding: string; state: Record<string, string[] | boolean | 'mixed'>; relation: string }[];
  evidence: string[];
}
export interface BrowserBranchConditionsAssessment {
  conditions?: BrowserBranchConditions;
  assessment: ReviewConditionAssessment;
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

function binding(c: Control, includeHypothesis = false) {
  // Unkeyed virtual records and unresolved selectors cannot establish portable
  // source conditions. Never substitute a row/DOM instance or its index.
  if (c.identityScope === 'instance' || !includeHypothesis && c.hypothesisId || c.structuralItem && !c.structuralItem.recordKey) return;
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
 * Versioned, bounded source-condition sampling. This avoids whole-page text
 * equality; it does not infer causal dependencies or grant identity, readiness,
 * replay permission, or exhaustive branch coverage. Structure cannot prove
 * that a mode is behaviorally independent: event handlers can read selectors
 * across forms/regions, including hidden controls. Include every observed mode
 * until a separate, explicit independence contract can prove one irrelevant.
 *
 * Form/component/region ancestry describes the evidence rather than filtering
 * it. Missing/ambiguous/unstable selector evidence or overflow declines
 * equivalence instead of silently truncating the projection. Unobserved JS state
 * and free-text dependencies still require declared context rules.
 */
export function browserBranchConditions(action: Pick<ActionCandidate, 'kind' | 'localId'>, o: Observation, version: 'v1' | 'v2' = 'v2'): BrowserBranchConditions | undefined {
  const target = o.controls.find(c => c.localId === action.localId);
  return target && observedModeConditions(target, o, ['fill', 'select', 'check'].includes(action.kind), version).conditions;
}

/** Portable operation/arrival conditions use the same observed mode references
 * as review. Scheduling and retained v1/v2 keys remain unchanged. This only
 * supplies prerequisites; a target's identity and replay rights are separate. */
export function browserPortableBranchConditions(action: Pick<ActionCandidate, 'kind' | 'localId'>, o: Observation): BrowserBranchConditions | undefined {
  const target=o.controls.find(c=>c.localId===action.localId);
  if(!target)return;
  const conditions=observedModeConditions(target,o,['fill','select','check'].includes(action.kind),'v3').conditions;
  // The new structural dependency proof must not authorize its own unresolved
  // operation target. Older nonstructural sampling retains its prior contract.
  return conditions?.policy==='browser-branch-conditions-v4'&&(target.identityScope==='instance'||target.hypothesisId)?undefined:conditions;
}

/** Interpretation has no destination input: retain the target's own mode too. */
export function browserReviewBranchConditions(target: Control, o: Observation): BrowserBranchConditions | undefined {
  return assessBrowserReviewBranchConditions(target, o).conditions;
}

/** The same projection and first rejection, without a second selector scan. */
export function assessBrowserReviewBranchConditions(target: Control, o: Observation, structure?: ReturnType<typeof modeStructureReader>): BrowserBranchConditionsAssessment {
  return observedModeConditions(target, o, false, 'v3', structure);
}

function observedModeConditions(target: Control, o: Observation, omitTargetMode: boolean, version: 'v1' | 'v2' | 'v3', structure?: ReturnType<typeof modeStructureReader>): BrowserBranchConditionsAssessment {
  const unavailable = (reason: string, localId?: string): BrowserBranchConditionsAssessment =>
    ({ assessment: { status: 'unavailable', reason, ...(localId ? { localId } : {}) } });
  if (!target) return unavailable('review_target_missing');
  if (o.gaps.some(g => g.critical)) return unavailable('observation_critical_gap');
  if (Object.values(o.context).some(v => v.status !== 'known')) return unavailable('declared_context_unknown');
  const components = componentAncestors(o), regions = regionAncestors(o);
  const targetComponents = components(target.localId), targetRegions = regions(target.region);
  const selections = new Map((o.components || []).flatMap(c => c.members.filter(m => typeof m.selected === 'boolean').map(m => [m.localId, m.selected!] as const)));
  const conditions: BrowserBranchConditions['conditions'] = [], bindings = new Set<string>();
  const rows:{c:Control;state:Exclude<ReturnType<typeof selectorState>,undefined>;base?:string}[]=[],counts=new Map<string,number>();
  for (const c of o.controls) {
    // v1 exists only to verify persisted scheduling keys against their retained
    // source. Operations retain v2; review conditions may use structural v3.
    if (version === 'v1' && !c.visible) continue;
    const state = selectorState(c, selections); if (state === undefined) continue;
    // The sample's destination value is already part of the operation key. Its
    // own starting value must not manufacture repeated fill/select/check work.
    if (c === target && omitTargetMode) continue;
    const base=binding(c,true);if(base)counts.set(base,(counts.get(base)||0)+1);
    rows.push({c,state,base});
  }
  let usedStructure=false;
  for(const {c,state,base} of rows){
    let relation: string;
    if (c === target) relation = 'target-mode';
    else if (target.formOwner && c.formOwner?.instanceId === target.formOwner.instanceId) relation = 'same-native-form';
    else if ([...components(c.localId)].some(id => targetComponents.has(id))) relation = 'shared-declared-component';
    else if (!target.formOwner && !c.formOwner && (targetRegions.has(c.region) || regions(c.region).has(target.region))) relation = 'shared-semantic-region';
    else if (!target.formOwner && !c.formOwner && c.region === target.region && !targetRegions.size) relation = 'same-unpartitioned-region';
    else if (version === 'v1') continue;
    else relation = 'observed-document-mode';
    if (state === null) return unavailable('selector_state_missing', c.localId);
    if (c.readiness?.status === 'unstable') return unavailable('selector_unstable', c.localId);
    let key = binding(c);
    // Use one reference scheme whenever complete structure supports it. Capture
    // may bind visible list descendants to instances but leave hidden ones
    // unbound; neither that metadata nor a hypothesis may rename the mode.
    // Operation v1/v2 and saved retry keys retain their prior projection.
    if(version==='v3'){
      const reference=(structure??=modeStructureReader(o))(c);
      if(reference){key=canonical({policy:reference.policy,structure:reference.key,
        selector:{tag:c.tag,role:c.role,name:c.label||c.name,type:c.constraints.type,form:formBinding(c)}});usedStructure=true;}
      else if(base&&(counts.get(base)||0)>1)return unavailable('selector_binding_duplicate',c.localId);
    }
    if (!key) return unavailable(c.identityScope === 'instance' ? 'selector_instance_bound'
      : c.hypothesisId ? 'selector_identity_hypothesis' : c.structuralItem && !c.structuralItem.recordKey ? 'selector_record_key_missing'
      : 'selector_binding_unavailable', c.localId);
    if (bindings.has(key)) return unavailable('selector_binding_duplicate', c.localId);
    bindings.add(key); conditions.push({ binding: key, state, relation });
    if (conditions.length > MAX_BRANCH_CONDITIONS) return unavailable('selector_limit_exceeded', c.localId);
  }
  conditions.sort((a, b) => a.binding.localeCompare(b.binding));
  const policy = version === 'v1' ? 'browser-branch-conditions-v1' as const : usedStructure?'browser-branch-conditions-v4' as const:'browser-branch-conditions-v2' as const;
  return { assessment: { status: 'available', reason: 'observed_branch_conditions_available' },
    conditions: { policy, key: hash({ policy, conditions }), conditions, evidence: [
    version === 'v1' ? 'Legacy visible selectors within the historical form/component/region projection; source-key decoding only'
      : 'All captured selector states, including cross-form, cross-region and hidden modes; structure does not prove independence',
    'Passive text and free-text starting values excluded; selector values and semantic bindings retained',
    'Observed source-condition samples only; unobserved JavaScript state, free-text dependencies and all combinations are not covered',
    ...(usedStructure?['Unique anchored fragments in complete captured trees resolve mode references; identity and execution authority remain unchanged']:[]),
  ] } };
}
