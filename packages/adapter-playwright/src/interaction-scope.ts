import { canonical } from '@interaction/core';
import type { Control, Observation } from './types.js';

type Snapshot = Pick<Observation, 'controls' | 'regions' | 'boundaries' | 'overlays' | 'regionCandidates' | 'structuralLists'>;

/** Only an observed exclusive boundary establishes ownership, never geometry or a label. */
export function activeInteractionIds(o: Snapshot): Set<string> | undefined {
  const active = o.overlays?.at(-1);
  if (!active || active.key !== o.boundaries?.at(-1)?.key) return;
  return new Set([...active.controlIds, ...active.exitControlIds]);
}

/** Keep full observations intact; this projection is only for dispatch freshness. */
export function interactionScope<T extends Snapshot>(o: T, ids = activeInteractionIds(o)): T {
  if (!ids) return o;
  return { ...o, controls: o.controls.filter(c => ids.has(c.localId)),
    // Mixed ancestors include background work. Their whole-page binding is not
    // a dependency of an operation inside this exclusive boundary.
    regionCandidates: o.regionCandidates?.filter(c => c.controlIds.length > 0 && c.controlIds.every(id => ids.has(id))),
    structuralLists: o.structuralLists?.filter(g => g.members.some(m => ids.has(m.localId)) || g.traversalLocalIds.some(id => ids.has(id))),
  };
}

export function boundaryBinding(o: Snapshot) {
  return canonical(o.overlays?.map(layer => ({key:layer.key,kind:layer.kind,parentKey:layer.parentKey,parentRegion:layer.parentRegion,
    ownerInstanceId:o.regions.find(r=>r.key===layer.key)?.instanceId,controlIds:layer.controlIds,exitControlIds:layer.exitControlIds})) || []);
}

/** Explicit targets include tentative and read-only controls omitted from the interactive projection. */
export function targetFacts(c: Control | undefined) {
  if (!c) return undefined;
  const {identityId:_identity,hypothesisId:_hypothesis,...facts}=c;
  return facts;
}
