import {finiteNavigationState} from './finite-coverage.js';
import type { Observation, Diff, Control, Session, StateGrouping } from './types.js';
import { canonical, signature, formBinding } from './util.js';
import { structuralStateKeys } from './structural-state-key.js';
type ObservableFrame = Pick<Observation, 'url' | 'controls' | 'context' | 'scroll' | 'gaps' | 'overlays' | 'components' | 'scrollContainers'>
  & Partial<Pick<Observation, 'ruleVersion' | 'regionCandidates'>>;
// Raw captures have no ruleVersion yet. Explicit old observations retain their
// original canonical encoding; stored checkpoints are never upgraded in place.
const currentRules = (o: Pick<ObservableFrame, 'ruleVersion'>) => o.ruleVersion === undefined || o.ruleVersion === 'observable-v8';
export function observableCanonical(o: ObservableFrame) {
  const portable = currentRules(o) ? structuralStateKeys(o) : undefined;
  const key = (control: Control | undefined) => control && (portable?.get(control) || control.stableKey);
  const components = o.components?.map(c => ({ kind: c.kind, name: c.name, status: c.basis.status,
    parent: o.components?.filter(p => p.id === c.parentId).map(p => ({ kind: p.kind, name: p.name })),
    members: c.members.map(({ localId, ...semantics }) => { const control = o.controls.find(v => v.localId === localId); return { ...semantics, signature: control && signature(control), stableKey: key(control) }; }) })) || [];
  return canonical({ ...(currentRules(o) ? { policy: 'browser-observable-v8' } : {}), url: o.url, context: o.context, scroll: o.scroll, scrollContainers: o.scrollContainers?.map(({ nodeId: _, ...c }) => c) || [], components, overlays: o.overlays?.map(layer => ({ key: layer.key, kind: layer.kind, parentKey: layer.parentKey })) || [], incomplete: o.gaps.filter(g => g.critical).map(g => g.code).sort(), controls: o.controls.map(c => ({ signature: signature(c), stableKey: key(c), identityScope: c.identityScope, formOwner: formBinding(c), readiness: c.readiness, scroll: c.scroll, pressed: c.pressed, value: c.value, displayedText: c.displayedText, checked: c.checked, selected: c.selected, visible: c.visible, enabled: c.enabled, editable: c.editable, expanded: c.expanded, constraints: c.constraints, options: c.options, actionBasis: c.actionBasis, hitTarget: c.actionable?.hitTarget, outsideScrollableArea: c.actionable?.outsideScrollableArea })) });
}

/** Historical readout grouping predicate. Restoration additionally requires
 * captured nativeReadOnly: aria-readonly alone is not native enforcement. */
export function readonlyReadout(c: Control): boolean {
  return ['input', 'textarea'].includes(c.tag) && c.readOnly === true && !c.editable
    && c.actions.every(kind => kind === 'fill') && !c.interactionHints?.length
    && !Object.keys(c.reviewBinding?.attributes || {}).some(key => /^on/i.test(key))
    && !c.controls && !c.structuralItem && !c.hypothesisId && c.identityScope !== 'instance'
    && c.checked === null && c.pressed == null && c.expanded === null && !c.selected.length && !c.options.length;
}

/** Compact graph membership, never operation equivalence or a restorable checkpoint.
 * Read-only readouts can still influence application behavior: their exact values
 * remain in observations, strict path checks and stateful traversal samples. */
export function browserStateGrouping(o: Observation, session: Session): StateGrouping | undefined {
  if (!['controls', 'representative'].includes(session.options.exploration || '') || o.gaps.some(g => g.critical)) return;
  if(o.coveragePolicy==='finite-ui-v1')return {policy:'finite-ui-navigation-v1',canonical:canonical(finiteNavigationState(o)),evidence:['Finite observable navigation state; never identity, arrival, coverage or business equivalence','Native passive readonly field names/values omitted; enabled state, controls, modes, editable values, options, constraints, URL and boundaries preserved']};
  const controls = o.controls.map(c => {
    const readout = readonlyReadout(c);
    return { ...c, ...(readout ? { value: '' } : {}),
      ...(c.liveContent ? { name: c.liveContent.name, displayedText: c.liveContent.text } : {}) };
  });
  // Preserve portable semantic bindings that can change without a label change.
  // Geometry, document/node IDs and passive readout evidence are not group keys.
  const bindings = controls.map(c => ({ readOnly: c.readOnly, attributes: c.reviewBinding?.attributes, declared: c.reviewAttributes,
    record: c.structuralItem && { recordKey: c.structuralItem.recordKey, template: c.structuralItem.template, slot: c.structuralItem.slot },
    unresolved: c.hypothesisId ? c.localId : undefined, instance: c.identityScope === 'instance' ? c.instanceId : undefined }));
  return { policy: currentRules(o) ? 'browser-state-grouping-v2' : 'browser-state-grouping-v1', canonical: canonical({ observable: observableCanonical({ ...o, controls }), bindings }),
    evidence: ['Graph membership only; strict observation facts retained separately',
      'Read-only noninteractive values and captured native-link readouts omitted from this index only',
      'Modes, editable values, bindings, constraints, visibility and readiness retained; no execution or coverage permission'] };
}
export function compareObservations(before: Observation, after: Observation, region?: string): Diff {
  const diff: Diff = { beforeId: before.id, afterId: after.id, changes: [], gaps: [], attribution: 'observed_during_interval', region };
  if (region && (!before.regions.some(r => r.key === region) || !after.regions.some(r => r.key === region))) diff.gaps.push({ code: 'PARENT_REGION_UNMATCHED', message: 'Parent region is not present in both observations', critical: true });
  const included = (c: Control, o: Observation) => {
    if (!region || region === 'document') return true;
    let key = c.region; const seen = new Set<string>();
    while (key && !seen.has(key)) { if (key === region) return true; seen.add(key); key = o.regions.find(r => r.key === key)?.parentKey || ''; }
    return false;
  };
  const left = before.controls.filter(c => included(c, before)); const right = after.controls.filter(c => included(c, after));
  for (const old of left) {
    const next = right.find(c => c.identityId === old.identityId);
    if (!next) {
      if (!after.gaps.some(g => g.critical)) diff.changes.push({ controlId: old.identityId, kind: 'disappeared', before: old.name });
      continue;
    }
    if (next.instanceId !== old.instanceId) diff.changes.push({ controlId: old.identityId, kind: 'rebuilt' });
    for (const field of ['value', 'displayedText', 'checked', 'pressed', 'selected', 'visible', 'enabled', 'editable', 'expanded', 'constraints', 'actionBasis', 'scroll'] as const) if (canonical(old[field]) !== canonical(next[field])) diff.changes.push({ controlId: old.identityId, kind: 'changed', field, before: old[field], after: next[field] });
    if (next.hypothesisId || old.hypothesisId) diff.gaps.push({ code: 'IDENTITY_UNCERTAIN', message: next.identityId! });
  }
  for (const c of right) if (!before.gaps.some(g => g.critical) && !left.some(x => x.identityId === c.identityId)) diff.changes.push({ controlId: c.identityId, kind: 'appeared', after: c.name });
  if (canonical(before.context) !== canonical(after.context)) diff.changes.push({ kind: 'context', before: before.context, after: after.context });
  diff.gaps.push(...before.gaps.filter(g => g.critical), ...after.gaps.filter(g => g.critical));
  return diff;
}
