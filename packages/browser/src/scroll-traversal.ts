import { canonical, type ActionAttempt, type FrontierItem } from '@interaction/core';
import type { ActionCandidate, Observation } from '@interaction/adapter-playwright';

function viewport(o: Observation, localId?: string) {
  return localId ? o.controls.find(c => c.localId === localId)?.scroll : { ...o.scroll, ...o.viewport };
}

function scope(o: Observation) {
  return canonical({ document: o.documentId, instance: o.instanceScope, url: o.url,
    context: o.context, boundaries: o.boundaries?.map(b => b.key) || [] });
}

function direction(a: ActionCandidate): [string, number] | undefined {
  if (!a.localId && typeof a.value === 'number' && Number.isFinite(a.value)) return ['y', Math.sign(a.value)];
  if (!a.value || typeof a.value !== 'object' || Array.isArray(a.value)) return;
  const { x, y } = a.value as { x?: number; y?: number };
  if (typeof y === 'number' && Number.isFinite(y) && y && !x) return ['y', Math.sign(y)];
  if (typeof x === 'number' && Number.isFinite(x) && x && !y) return ['x', Math.sign(x)];
}

/** Preserve a successful sweep among already eligible live scroll candidates.
 * Changing position retires historical scroll intents. Always choosing forward
 * again after reaching an edge can strand the unvisited half of a viewport.
 * This changes only ordering, never approval, coverage, or historical recovery.
 */
export function continueScrollTraversal(items: FrontierItem[], current: Observation, attempts: ActionAttempt[], observation: (id: string) => Observation | undefined) {
  const slots = new Map<string | undefined, number[]>();
  items.forEach((f, i) => {
    if (f.action.kind !== 'scroll' || f.action.observationId !== current.id) return;
    const indices = slots.get(f.action.localId) || [];
    indices.push(i); slots.set(f.action.localId, indices);
  });
  const ordered = [...items];
  for (const [localId, indices] of slots) {
    if (indices.length < 2) continue;
    // Do not revive an earlier direction after a failed scroll, another document,
    // changed context, external displacement, resized viewport, or replaced node.
    const last = attempts.findLast(a => a.action.kind === 'scroll' && a.action.localId === localId);
    if (last?.status !== 'succeeded' || !last.afterId) continue;
    const before = observation(last.beforeId), after = observation(last.afterId);
    if (!before || !after || [before, after, current].some(o => o.gaps.some(g => g.critical))
      || scope(before) !== scope(current) || scope(after) !== scope(current)) continue;
    const start = viewport(before, localId), end = viewport(after, localId), live = viewport(current, localId);
    if (!start || !end || !live || canonical(end) !== canonical(live)) continue;
    const dx = end.x - start.x, dy = end.y - start.y;
    // Only actual movement on one axis is evidence of a sweep direction.
    const axis = dy && !dx ? 'y' : dx && !dy ? 'x' : undefined;
    if (!axis) continue;
    const sign = Math.sign(axis === 'x' ? dx : dy);
    const continuing = (f: FrontierItem) => {
      const d = direction(f.action); return d?.[0] === axis && d[1] === sign;
    };
    const candidates = indices.map(i => items[i]).sort((a, b) => Number(continuing(b)) - Number(continuing(a)));
    // Keep non-scroll work and other viewports in their original priority slots.
    indices.forEach((i, n) => { ordered[i] = candidates[n]; });
  }
  return ordered;
}
