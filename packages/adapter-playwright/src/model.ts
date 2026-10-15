import type { Observation, Diff, Control } from './types.js';
import { canonical, signature } from './util.js';
export function observableCanonical(o: Pick<Observation, 'url' | 'controls' | 'context' | 'scroll' | 'scrollContainers' | 'gaps' | 'overlays' | 'components'>) {
  const components = o.components?.map(c => ({ kind: c.kind, name: c.name, status: c.basis.status,
    parent: o.components?.filter(p => p.id === c.parentId).map(p => ({ kind: p.kind, name: p.name })),
    members: c.members.map(({ localId, ...semantics }) => { const control = o.controls.find(v => v.localId === localId); return { ...semantics, signature: control && signature(control), stableKey: control?.stableKey }; }) })) || [];
  return canonical({ url: o.url, context: o.context, scroll: o.scroll, scrollContainers: o.scrollContainers?.map(({ nodeId: _, ...c }) => c) || [], components, overlays: o.overlays?.map(layer => ({ key: layer.key, kind: layer.kind, parentKey: layer.parentKey })) || [], incomplete: o.gaps.filter(g => g.critical).map(g => g.code).sort(), controls: o.controls.map(c => ({ signature: signature(c), stableKey: c.stableKey, value: c.value, displayedText: c.displayedText, checked: c.checked, selected: c.selected, visible: c.visible, enabled: c.enabled, editable: c.editable, expanded: c.expanded, constraints: c.constraints, options: c.options, actionBasis: c.actionBasis, hitTarget: c.actionable?.hitTarget, outsideScrollableArea: c.actionable?.outsideScrollableArea })) });
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
    for (const field of ['value', 'displayedText', 'checked', 'selected', 'visible', 'enabled', 'editable', 'expanded', 'constraints', 'actionBasis'] as const) if (canonical(old[field]) !== canonical(next[field])) diff.changes.push({ controlId: old.identityId, kind: 'changed', field, before: old[field], after: next[field] });
    if (next.hypothesisId || old.hypothesisId) diff.gaps.push({ code: 'IDENTITY_UNCERTAIN', message: next.identityId! });
  }
  for (const c of right) if (!before.gaps.some(g => g.critical) && !left.some(x => x.identityId === c.identityId)) diff.changes.push({ controlId: c.identityId, kind: 'appeared', after: c.name });
  if (canonical(before.context) !== canonical(after.context)) diff.changes.push({ kind: 'context', before: before.context, after: after.context });
  diff.gaps.push(...before.gaps.filter(g => g.critical), ...after.gaps.filter(g => g.critical));
  return diff;
}
