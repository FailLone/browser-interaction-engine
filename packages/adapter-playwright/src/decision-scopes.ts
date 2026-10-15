import { reviewCollection } from './review-collection.js';
import { canonical, type ExplorationGroupProposal, type Json } from '@interaction/core';
import type { ActionCandidate, Observation, Region, Session } from './types.js';

/** Optional producers. These describe observed work, never infer business value. */
export function decisionScopes(actions: ActionCandidate[], o: Observation, session: Session): ExplorationGroupProposal[] {
  const enabled = new Set(session.options.decisionScopes || []);
  if (!enabled.size) return [];
  const controls = new Map(o.controls.map(c => [c.localId, c]));
  const groups = new Map<string, ExplorationGroupProposal>();
  const owner = (r?: Region) => r && ({ key: r.key, instanceId: r.instanceId, selector: r.selector, role: r.role, label: r.label, parentKey: r.parentKey });
  const propose = (kind: string, key: string, label: string, conditions: unknown, a: ActionCandidate, region?: Region, boundary?: Region) => {
    const identity = canonical([kind, key]);
    let group = groups.get(identity);
    if (!group) {
      group = { key, kind, collection: reviewCollection(o, region, boundary), label: label.trim() || kind, conditions: JSON.parse(canonical(conditions)) as Json, actionIds: [], traversalActionIds: [],
        evidence: [{ source: 'adapter-playwright', rule: `observed-${kind}-scope/v1`, facts: { observationId: o.id,
          meaning: kind === 'region' ? 'Operations directly owned by this observed region; nested regions are independent scopes'
            : kind === 'branch' ? 'Observed entry operation only; destination behavior remains undiscovered'
            : 'Currently generated input samples; not exhaustive values or combinations' } }] };
      groups.set(identity, group);
    }
    if (a.kind === 'scroll') group.traversalActionIds.push(a.id); else group.actionIds.push(a.id);
  };
  for (const a of actions) {
    if (a.boundary?.intent === 'exit' || !a.preconditions.visible) continue;
    const c = controls.get(a.localId || '');
    const boundary = o.regions.find(r => r.key === a.boundary?.key);
    const region = o.regions.find(r => c?.regionInstanceId ? r.instanceId === c.regionInstanceId : r.key === (c?.region || 'document'));
    if (enabled.has('region')) {
      if (region) propose('region', canonical([region.key, region.selector, a.boundary?.key]), (region.key === 'document' ? boundary?.label : '') || region.label || region.role,
        { url: o.url, owner: owner(region), boundary: owner(boundary) }, a, region, boundary);
    }
    if (!c) continue;
    const target = { instanceId: c.instanceId, role: c.role, tag: c.tag, label: c.label, name: c.name, selector: c.selector, region: c.region,
      controls: c.controls, operation: a.kind, basis: c.actionBasis?.[a.kind], purposeBinding: c.purposeBinding, boundary: owner(boundary) };
    if (enabled.has('branch') && a.kind === 'click' && (c.tag === 'a' || c.tag === 'summary' || c.expanded !== null || c.controls || ['tab', 'menuitem'].includes(c.role))) {
      propose('branch', canonical([c.selector, a.kind, a.boundary?.key]), a.label || c.role, { url: o.url, target }, a, region, boundary);
    }
    if (enabled.has('input-space') && ['fill', 'select', 'check'].includes(a.kind)) {
      const { valid: _valid, ...constraints } = c.constraints;
      propose('input-space', canonical([c.selector, a.kind, a.boundary?.key]), a.label || c.role,
        { url: o.url, target, constraints, options: c.options }, a, region, boundary);
    }
  }
  return [...groups.values()];
}
