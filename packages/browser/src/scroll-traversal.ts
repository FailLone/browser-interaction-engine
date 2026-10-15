import { canonical, type ActionAttempt, type FrontierItem } from '@interaction/core';
import { traversalScrollSchema, type ActionCandidate, type Observation } from '@interaction/adapter-playwright';

/** Absolute traversal actions bind a DOM container; relative actions retain their
 * existing page/control scope. A missing localId is not a shared container ID. */
function targetKey(a: ActionCandidate): string | undefined {
  if (a.source === 'scroll-traversal') {
    const value = a.value;
    if (a.localId || !value || typeof value !== 'object' || Array.isArray(value)) return;
    return typeof value.containerNodeId === 'string' ? `container:${value.containerNodeId}` : undefined;
  }
  return a.localId ? `control:${a.localId}` : 'page';
}

function viewport(o: Observation, a: ActionCandidate) {
  if (a.source === 'scroll-traversal') {
    const parsed = traversalScrollSchema.safeParse(a.value);
    if (!parsed.success || parsed.data.documentId !== o.documentId || a.localId) return;
    const matches = o.scrollContainers?.filter(c => c.nodeId === parsed.data.containerNodeId) || [];
    if (matches.length !== 1 || matches[0].boundaryKey !== o.overlays?.at(-1)?.key) return;
    const c = matches[0];
    return { x: c.left, y: c.top, width: c.width, height: c.height, maxX: c.maxLeft, maxY: c.maxTop,
      root: c.root, boundaryKey: c.boundaryKey };
  }
  return a.localId ? o.controls.find(c => c.localId === a.localId)?.scroll : { ...o.scroll, ...o.viewport };
}

function scope(o: Observation) {
  return canonical({ document: o.documentId, instance: o.instanceScope, url: o.url,
    context: o.context, boundaries: o.boundaries?.map(b => b.key) || [] });
}

function axisDirection(x: unknown, y: unknown): ['x' | 'y', number] | undefined {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
  if (y && !x) return ['y', Math.sign(y)];
  if (x && !y) return ['x', Math.sign(x)];
}

function direction(a: ActionCandidate, o: Observation): ['x' | 'y', number] | undefined {
  if (a.source === 'scroll-traversal') {
    const parsed = traversalScrollSchema.safeParse(a.value), live = viewport(o, a);
    if (!parsed.success || !live) return;
    const v = parsed.data;
    if (Math.abs(v.expectedLeft - live.x) > .5 || Math.abs(v.expectedTop - live.y) > .5
      || v.width !== live.width || v.height !== live.height || v.maxLeft !== ('maxX' in live ? live.maxX : undefined) || v.maxTop !== live.maxY
      || v.left < 0 || v.left > v.maxLeft || v.top < 0 || v.top > v.maxTop) return;
    return axisDirection(v.left - live.x, v.top - live.y);
  }
  if (!a.localId && typeof a.value === 'number') return axisDirection(0, a.value);
  if (!a.value || typeof a.value !== 'object' || Array.isArray(a.value)) return;
  return axisDirection(a.value.x ?? 0, a.value.y ?? 0);
}

/** Preserve a successful sweep among already eligible live scroll candidates.
 * Changing position retires historical scroll intents. Always choosing forward
 * again after reaching an edge can strand the unvisited half of a viewport.
 * This changes only ordering, never approval, coverage, or historical recovery.
 */
export function continueScrollTraversal(items: FrontierItem[], current: Observation, attempts: ActionAttempt[], observation: (id: string) => Observation | undefined) {
  const slots = new Map<string, number[]>();
  items.forEach((f, i) => {
    if (f.action.kind !== 'scroll' || f.action.observationId !== current.id) return;
    const key = targetKey(f.action); if (!key) return;
    const indices = slots.get(key) || []; indices.push(i); slots.set(key, indices);
  });
  const ordered = [...items];
  for (const [key, indices] of slots) {
    if (indices.length < 2) continue;
    // A failed/malformed latest attempt must not expose an earlier direction.
    const last = attempts.findLast(a => a.action.kind === 'scroll' && targetKey(a.action) === key);
    if (last?.status !== 'succeeded' || !last.afterId) continue;
    const before = observation(last.beforeId), after = observation(last.afterId);
    if (!before || !after || [before, after, current].some(o => o.gaps.some(g => g.critical))
      || scope(before) !== scope(current) || scope(after) !== scope(current)) continue;
    const start = viewport(before, last.action), end = viewport(after, last.action), live = viewport(current, last.action);
    if (!start || !end || !live || canonical(end) !== canonical(live)) continue;
    const shape = ({ x: _x, y: _y, ...rest }: typeof start) => canonical(rest);
    if (shape(start) !== shape(end)) continue;
    // Validate the intent at its original position, then verify actual movement.
    // Unrelated displacement or the opposite result is not a successful sweep.
    const intended = direction(last.action, before), moved = axisDirection(end.x - start.x, end.y - start.y);
    if (!intended || !moved || intended[0] !== moved[0] || intended[1] !== moved[1]) continue;
    const continuing = (f: FrontierItem) => {
      const d = direction(f.action, current); return d?.[0] === moved[0] && d[1] === moved[1];
    };
    const candidates = indices.map(i => items[i]).sort((a, b) => Number(continuing(b)) - Number(continuing(a)));
    // Keep non-scroll work and other viewports in their original priority slots.
    indices.forEach((i, n) => { ordered[i] = candidates[n]; });
  }
  return ordered;
}
