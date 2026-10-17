import { browserTargetConditions, classificationCorrespondenceConditions, type ActionCandidate, type Observation } from '@interaction/browser';
import type { ExplorerHost } from './types.js';

type Control = Observation['controls'][number];
type Transition = ReturnType<ExplorerHost['interactionTransition']>;
type Classification = ReturnType<typeof classificationCorrespondenceConditions>;
type Projection = { classification: Classification; conditions: Map<ActionCandidate['kind'], string | undefined> };
type Index = { local: Map<string, number>; instance: Map<string, number>; signature: Map<string, number>; projections: Map<string, Projection> };
const signature = (c: Control) => JSON.stringify([c.tag, c.role, c.name, c.label]);
const active = (o: Observation, c: Control) => {
  const boundary = o.boundaries?.at(-1);
  return !boundary || !!o.overlays?.find(overlay => overlay.key === boundary.key)?.controlIds.includes(c.localId);
};
const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) || 0) + 1);
function index(o: Observation): Index {
  const local = new Map<string, number>(), instance = new Map<string, number>(), signatures = new Map<string, number>();
  for (const c of o.controls) { increment(local, c.localId); increment(instance, c.instanceId); increment(signatures, signature(c)); }
  return { local, instance, signature: signatures, projections: new Map() };
}

/** Negative scheduling evidence only: a scope/retained hint locates candidates,
 * but cannot discard another source condition. No identity, review completion,
 * recovery or dispatch permission is granted here. The caller's selection epoch
 * owns this cache. Weak source keys do not extend the eight-graph retained
 * cache's lifetime; values contain only scalar indexes and bounded projections.
 */
export function createCurrentSourceExclusion(current: Observation) {
  const currentIndex = index(current), sources = new WeakMap<Observation, Index>();
  const transitions = new WeakMap<Transition, { forward: Map<string, string[]>; reverse: Map<string, string[]> }>();
  const sourceIndex = (source: Observation) => {
    let value = sources.get(source);
    if (!value) { value = index(source); sources.set(source, value); }
    return value;
  };
  const projection = (o: Observation, c: Control, kind: ActionCandidate['kind'], facts: Index) => {
    let value = facts.projections.get(c.localId);
    if (!value) {
      // Overflow preserves the candidate instead of manufacturing equivalence.
      if (facts.projections.size >= 65536) return;
      value = { classification: classificationCorrespondenceConditions(c, o), conditions: new Map() };
      facts.projections.set(c.localId, value);
    }
    if (value.classification && !value.conditions.has(kind)) value.conditions.set(kind, browserTargetConditions({ localId: c.localId, kind } as ActionCandidate, o)?.key);
    return { classification: value.classification, condition: value.conditions.get(kind) };
  };
  const equivalent = (source: Observation, before: Control, after: Control, transition: Transition, kind: ActionCandidate['kind']) => {
    if (source.ruleVersion !== current.ruleVersion || !before.visible || !after.visible || before.readiness || after.readiness
      || !active(source, before) || !active(current, after)) return false;
    const previous = sourceIndex(source);
    if (previous.local.get(before.localId) !== 1 || previous.instance.get(before.instanceId) !== 1
      || currentIndex.local.get(after.localId) !== 1 || currentIndex.instance.get(after.instanceId) !== 1) return false;
    let mapping = transitions.get(transition);
    if (!mapping) {
      mapping = { forward: new Map(), reverse: new Map() };
      for (const row of transition.retainedControls) {
        const forward = mapping.forward.get(row.beforeLocalId) || [], reverse = mapping.reverse.get(row.afterLocalId) || [];
        forward.push(row.afterLocalId); reverse.push(row.beforeLocalId);
        mapping.forward.set(row.beforeLocalId, forward); mapping.reverse.set(row.afterLocalId, reverse);
      }
      transitions.set(transition, mapping);
    }
    const forward = mapping.forward.get(before.localId) || [], reverse = mapping.reverse.get(after.localId) || [];
    const retained = forward.length === 1 && reverse.length === 1 && forward[0] === after.localId
      && reverse[0] === before.localId && source.instanceScope === current.instanceScope && before.instanceId === after.instanceId;
    // An incomplete same-name rival counts against portable uniqueness even if
    // it cannot produce its own classification projection. A retained instance
    // may be compared without granting a pending logical identity.
    if (!retained && (forward.length || reverse.length || before.hypothesisId || after.hypothesisId
      || previous.signature.get(signature(before)) !== 1 || currentIndex.signature.get(signature(after)) !== 1)) return false;
    const old = projection(source, before, kind, previous), now = projection(current, after, kind, currentIndex);
    return !!old?.classification && !!now?.classification && !!old.condition && old.condition === now.condition
      && old.classification.identityKey === now.classification.identityKey && old.classification.conditionKey === now.classification.conditionKey;
  };
  return {
    operation(source: Observation, before: ActionCandidate, after: ActionCandidate, transition: Transition) {
      if (before.kind !== after.kind || before.value !== after.value) return false;
      const old = source.controls.find(c => c.localId === before.localId), now = current.controls.find(c => c.localId === after.localId);
      return !!old && !!now && equivalent(source, old, now, transition, before.kind);
    },
    review(source: Observation, before: Control[], after: Control[], transition: Transition) {
      if (before.length !== 1) return false;
      // Click is a projection selector, not an action: retain every captured
      // mode, including the target's own checked/selected state, for review.
      return after.filter(c => c.enabled && equivalent(source, before[0], c, transition, 'click')).length === 1;
    },
  };
}
