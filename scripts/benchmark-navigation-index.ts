/** Common-API engine benchmark: copy this exact script to each source revision.
 * Uses only a fresh MemoryStore and the non-browser CounterAdapter. It creates
 * one genuine counter action, then synthetic retained graph records from that
 * template. These graph queries do not prove browser replay or UI restoration.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { InteractionEngine, hash, type ActionAttempt, type Transition, type UIState, type Visit } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter, type CounterObservation } from '../examples/counter-adapter.js';

const { values } = parseArgs({ options: {
  variant: { type: 'string' }, revision: { type: 'string' }, output: { type: 'string' },
  edges: { type: 'string', default: '1000' }, 'passive-observations': { type: 'string', default: '1000' },
  batches: { type: 'string', default: '7' }, queries: { type: 'string', default: '20' },
}, strict: true });
function integer(value: string | undefined, name: string, minimum: number, maximum: number) {
  const result = Number(value);
  assert(Number.isSafeInteger(result) && result >= minimum && result <= maximum, `${name} must be an integer in [${minimum}, ${maximum}]`);
  return result;
}
const edgeCount = integer(values.edges, 'edges', 2, 10000);
const passiveCount = integer(values['passive-observations'], 'passive-observations', 0, 10000);
const batches = integer(values.batches, 'batches', 1, 100);
const queriesPerBatch = integer(values.queries, 'queries', 1, 1000);
type Counts = { get: Record<string, number>; list: Record<string, number>; listedRows: Record<string, number> };
const emptyCounts = (): Counts => ({ get: {}, list: {}, listedRows: {} });
class CountingMemoryStore extends MemoryStore {
  counting = false;
  counts = emptyCounts();
  override get<T>(kind: string, id: string): T | undefined {
    if (this.counting) this.counts.get[kind] = (this.counts.get[kind] || 0) + 1;
    return super.get<T>(kind, id);
  }
  override list<T>(kind: string, sessionId?: string): T[] {
    const rows = super.list<T>(kind, sessionId);
    if (this.counting) {
      this.counts.list[kind] = (this.counts.list[kind] || 0) + 1;
      this.counts.listedRows[kind] = (this.counts.listedRows[kind] || 0) + rows.length;
    }
    return rows;
  }
  startCounting() { this.counts = emptyCounts(); this.counting = true; }
  finishCounting(queryCount: number) {
    this.counting = false;
    return {
      raw: structuredClone(this.counts), queryCount,
      // Each query reads its two endpoint observations independently of graph
      // indexing. Subtract only this public-path fixed cost, retaining raw data.
      endpointObservationReadFloor: 2 * queryCount,
      historicalObservationReads: Math.max(0, (this.counts.get.observation || 0) - 2 * queryCount),
      attemptListCalls: this.counts.list.attempt || 0,
      transitionListCalls: this.counts.list.transition || 0,
    };
  }
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = ['packages/core/src/engine.ts', 'packages/core/src/navigation-path.ts', 'packages/storage-memory/src/index.ts', 'examples/counter-adapter.ts'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, sha(readFileSync(resolve(root, path)))]));
const memory = () => {
  const usage = process.memoryUsage();
  return { rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal, external: usage.external, arrayBuffers: usage.arrayBuffers };
};
const memorySamples: Record<string, ReturnType<typeof memory>> = { beforeFixture: memory() };
const store = new CountingMemoryStore(), adapter = new CounterAdapter();
const engine = new InteractionEngine({ adapter, persistence: store });
try {
  const session = await engine.createSession({});
  const templateAttempt = await engine.execute(session.id, engine.actions(session.id)[0].id, 'benchmark-template-action');
  assert.equal(templateAttempt.status, 'succeeded');
  assert(templateAttempt.afterId && templateAttempt.transitionId);
  const templateObservation = engine.observation(session.id, templateAttempt.afterId);
  const templateState = store.require<UIState>('state', templateObservation.stateId);
  const templateVisit = store.require<Visit>('visit', templateObservation.visitId);
  const templateTransition = store.require<Transition>('transition', templateAttempt.transitionId);
  const observations: CounterObservation[] = [];
  function seedObservation(index: number, passive = false): CounterObservation {
    const prefix = passive ? 'passive' : 'chain';
    const observation: CounterObservation = {
      ...structuredClone(templateObservation), id: `benchmark-${prefix}-observation-${index}`,
      stateId: `benchmark-${prefix}-state-${index}`, visitId: `benchmark-${prefix}-visit-${index}`,
      count: (passive ? 1_000_000 : 10_000) + index, cause: passive ? 'inspection' : index ? 'action' : 'initial',
    };
    observation.canonical = adapter.normalize(observation); observation.fingerprint = hash(observation.canonical);
    const state: UIState = { ...structuredClone(templateState), id: observation.stateId, canonical: observation.canonical,
      fingerprint: observation.fingerprint, observationIds: [observation.id] };
    const visit: Visit = { ...structuredClone(templateVisit), id: observation.visitId, observationId: observation.id,
      stateId: observation.stateId, depth: passive ? 0 : index,
      parentId: !passive && index ? `benchmark-chain-visit-${index - 1}` : undefined,
      viaAttemptId: !passive && index ? `benchmark-attempt-${index - 1}` : undefined };
    store.put('state', state); store.put('observation', observation); store.put('visit', visit);
    return observation;
  }
  for (let index = 0; index <= edgeCount; index++) observations.push(seedObservation(index));
  const expectedPath: string[] = [];
  for (let index = 0; index < edgeCount; index++) {
    const before = observations[index], after = observations[index + 1];
    const attempt: ActionAttempt = {
      ...structuredClone(templateAttempt), id: `benchmark-attempt-${index}`, requestId: `benchmark-request-${index}`,
      beforeId: before.id, afterId: after.id, transitionId: `benchmark-transition-${index}`,
      action: { ...structuredClone(templateAttempt.action), id: `benchmark-action-${index}`, observationId: before.id, stateId: before.stateId },
      diff: adapter.compare(before, after),
    };
    const transition: Transition = { ...structuredClone(templateTransition), id: attempt.transitionId!,
      from: before.stateId, to: after.stateId, attemptId: attempt.id };
    store.put('action', attempt.action); store.put('attempt', attempt); store.put('transition', transition);
    expectedPath.push(attempt.id);
  }
  for (let index = 0; index < passiveCount; index++) seedObservation(index, true);
  memorySamples.afterFixture = memory();
  const retainedRows = Object.fromEntries(['observation', 'state', 'visit', 'action', 'attempt', 'transition'].map(kind => [kind, store.list(kind, session.id).length]));
  const endpoints = { fromObservationId: observations[0].id, toObservationId: observations[edgeCount].id };
  const query = () => engine.navigationPath(session.id, observations[0].stateId, observations[edgeCount].stateId, endpoints);
  store.startCounting();
  const warmupStarted = performance.now();
  assert.deepEqual(query(), expectedPath);
  const warmup = { elapsedMs: performance.now() - warmupStarted, io: store.finishCounting(1), exactPathVerified: true };
  memorySamples.afterWarmup = memory();
  const samplesMs: number[] = [];
  store.startCounting();
  for (let batch = 0; batch < batches; batch++) {
    const started = performance.now();
    for (let queryNumber = 0; queryNumber < queriesPerBatch; queryNumber++) assert.deepEqual(query(), expectedPath);
    samplesMs.push(performance.now() - started);
  }
  const steadyIO = store.finishCounting(batches * queriesPerBatch);
  memorySamples.afterRepeatedQueries = memory();
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const medianBatchMs = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const middleAttemptId = expectedPath[Math.floor(expectedPath.length / 2)];
  const permitted = store.require<ActionAttempt>('attempt', middleAttemptId), withdrawn = structuredClone(permitted);
  withdrawn.action.replayable = false; store.put('attempt', withdrawn);
  store.startCounting();
  const withdrawalStarted = performance.now();
  assert.equal(query(), null);
  const withdrawnPermission = { elapsedMs: performance.now() - withdrawalStarted, io: store.finishCounting(1), pathAbsent: true };
  store.put('attempt', permitted); store.startCounting();
  const restorationStarted = performance.now();
  assert.deepEqual(query(), expectedPath);
  const restoredPermission = { elapsedMs: performance.now() - restorationStarted, io: store.finishCounting(1), exactPathVerified: true };
  memorySamples.afterInvalidationChecks = memory();
  const report = {
    benchmark: 'engine-navigation-index-common-api-v1', variant: values.variant || 'unspecified', revision: values.revision || 'unspecified',
    node: process.version, recordedAt: new Date().toISOString(), scriptSha256: sha(readFileSync(fileURLToPath(import.meta.url))), sourceHashes,
    scope: 'Synthetic retained chain queried through actual InteractionEngine.navigationPath; no browser, disk database, service, replay, or recovery execution',
    fixture: { actualCounterExecutions: 1, syntheticChainEdges: edgeCount, syntheticChainObservations: edgeCount + 1,
      syntheticPassiveObservations: passiveCount, retainedRows, pathLength: expectedPath.length, pathSha256: hash(expectedPath) },
    protocol: { warmupQueries: 1, batches, queriesPerBatch, timedSection: 'navigationPath plus exact full-path equality assertion',
      storeInstrumentation: 'Counts get/list API calls and listed rows; excludes record writes and fixture setup' },
    warmup, steady: { samplesMs, medianBatchMs, medianPerQueryMs: medianBatchMs / queriesPerBatch,
      io: steadyIO, verifiedIdenticalPaths: batches * queriesPerBatch },
    invalidation: { withdrawnPermission, restoredPermission },
    memory: { caveat: 'Whole-process snapshots include fixture, source runtime, results and GC timing; not isolated index footprint or retained-memory measurements', samples: memorySamples },
  };
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (values.output) { const output = resolve(values.output); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, serialized); }
  process.stdout.write(serialized);
} finally { store.counting = false; await engine.close(); }
