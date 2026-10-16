import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { RecordedNavigationGraph } from '../packages/core/src/navigation-path.js';

// In-memory algorithm comparison only: no browser, storage, task DB, or actual
// recovery latency is measured here. Each query changes one recorded edge.
const edges: { from: string; to: string; attemptId: string }[] = [];
const costs = new Map<string, number>();
const add = (from: string, to: string, attemptId: string, cost = 1) => {
  edges.push({ from, to, attemptId }); costs.set(attemptId, cost);
};
add('start', 'end', 'slow-direct', 100);
for (let i = 0; i < 20; i++) add('start', `0:${i}`, `start:${i}`);
for (let layer = 0; layer < 24; layer++) for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
  add(`${layer}:${i}`, `${layer + 1}:${j}`, `${layer}:${i}:${j}`);
}
for (let i = 0; i < 20; i++) add(`24:${i}`, 'end', `end:${i}`);
const build = () => {
  const graph = new RecordedNavigationGraph();
  for (const edge of edges) graph.add(edge.from, edge);
  return graph;
};
const measure = (fn: () => void) => {
  fn(); const samplesMs: number[] = [];
  for (let repetition = 0; repetition < 7; repetition++) {
    const started = performance.now(); fn(); samplesMs.push(performance.now() - started);
  }
  samplesMs.sort((a, b) => a - b);
  return { medianMs: samplesMs[3], samplesMs };
};
const queries = 40;
const cost = (edge: { attemptId: string }) => costs.get(edge.attemptId)!;
const reference = build(), expected = reference.path('start', 'end', undefined, cost)!;
assert.equal(expected.length, 26);
const expectedCost = expected.reduce((sum, attemptId) => sum + costs.get(attemptId)!, 0);
assert.equal(expectedCost, 26);
assert.deepEqual(reference.path('start', 'end'), ['slow-direct']);
const mutation = { from: '24:19', to: 'end', attemptId: 'end:19' };
const freshPerQuery = () => {
  for (let query = 0; query < queries; query++) {
    const graph = build();
    graph.upsert(mutation.from, { ...mutation, to: query % 2 ? 'end' : 'start' });
    assert.deepEqual(graph.path('start', 'end', undefined, cost), expected);
  }
};
const reused = build();
const incrementalPerQuery = () => {
  for (let query = 0; query < queries; query++) {
    reused.upsert(mutation.from, { ...mutation, to: query % 2 ? 'end' : 'start' });
    assert.deepEqual(reused.path('start', 'end', undefined, cost), expected);
  }
};
console.log(JSON.stringify({
  node: process.version, scope: 'pure graph rebuild versus one-edge update, identical weighted route queries',
  topology: { layers: 25, width: 20, edges: edges.length, queriesPerSample: queries }, repetitions: 7,
  route: { fewestEdges: 1, fewestEdgesEstimatedCost: 100, weightedEdges: expected.length, weightedEstimatedCost: expectedCost },
  rebuildAndQuery: measure(freshPerQuery), updateAndQuery: measure(incrementalPerQuery),
}, null, 2));
