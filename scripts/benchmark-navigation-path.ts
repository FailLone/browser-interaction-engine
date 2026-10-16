import { performance } from 'node:perf_hooks';
import { RecordedNavigationGraph, type RecordedNavigationEdge } from '../packages/core/src/navigation-path.js';

// Pure route-search comparison. This does not measure observation, SQLite,
// browser actions, or end-to-end recovery latency, and opens no browser/store.
type Edge = { from: string } & RecordedNavigationEdge;
function previousPath(edges: Map<string, RecordedNavigationEdge[]>, from: string, to: string) {
  const queue = [{ state: from, path: [] as string[] }], visited = new Set<string>();
  while (queue.length) {
    const item = queue.shift()!;
    if (item.state === to) return item.path;
    if (visited.has(item.state)) continue;
    visited.add(item.state);
    for (const edge of edges.get(item.state) || []) queue.push({ state: edge.to, path: [...item.path, edge.attemptId] });
  }
  return null;
}
function compare(name: string, edges: Edge[], from: string, to: string) {
  const previous = new Map<string, RecordedNavigationEdge[]>(), current = new RecordedNavigationGraph();
  for (const { from, ...edge } of edges) {
    const outgoing = previous.get(from); if (outgoing) outgoing.push(edge); else previous.set(from, [edge]);
    current.add(from, edge);
  }
  const oldPath = previousPath(previous, from, to), newPath = current.path(from, to);
  if (JSON.stringify(oldPath) !== JSON.stringify(newPath)) throw new Error(`Different route: ${name}`);
  const measure = (fn: () => unknown) => {
    fn(); const elapsed: number[] = [];
    for (let i = 0; i < 7; i++) { const start = performance.now(); fn(); elapsed.push(performance.now() - start); }
    elapsed.sort((a, b) => a - b); return { medianMs: elapsed[3], samplesMs: elapsed };
  };
  return { name, edgeCount: edges.length, pathLength: newPath?.length, previous: measure(() => previousPath(previous, from, to)), current: measure(() => current.path(from, to)) };
}
const chain = Array.from({ length: 4000 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}`, attemptId: `a${i}` }));
const converging: Edge[] = [];
for (let i = 0; i < 40; i++) converging.push({ from: 'start', to: `0:${i}`, attemptId: `start:${i}` });
for (let layer = 0; layer < 24; layer++) for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) {
  converging.push({ from: `${layer}:${i}`, to: `${layer + 1}:${j}`, attemptId: `${layer}:${i}:${j}` });
}
for (let i = 0; i < 40; i++) converging.push({ from: `24:${i}`, to: 'end', attemptId: `end:${i}` });
console.log(JSON.stringify({ node: process.version, repetitions: 7, scope: 'pure BFS, existing adjacency, identical selected routes',
  results: [compare('4000-edge chain', chain, 's0', 's4000'), compare('25 layers with 40 converging states', converging, 'start', 'end')] }, null, 2));
