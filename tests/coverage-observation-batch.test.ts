import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { InteractionEngine, type ActionAttempt, type ActionCandidate, type FrontierItem, type IdentityHypothesis,
  type Observation, type Session } from '@interaction/core';
import { BrowserEngine, type PlaywrightAdapter } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { CounterAdapter, type CounterObservation } from '../examples/counter-adapter.js';

// Only new temporary databases and hand-built records. No driver/session creation,
// original task database, retained browser fixture, network or browser process.
const resources: { directory: string; store: SqliteStore; host?: { close(): Promise<void> } }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    try { if (resource.host) await resource.host.close(); }
    finally { if (resource.store.db.open) resource.store.close(); rmSync(resource.directory, { recursive: true, force: true }); }
  }
});

type ObservationGet = <O extends Observation>(id: string) => O | undefined;
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-observation-batch-')), store = new SqliteStore(directory);
  const resource: typeof resources[number] = { directory, store }; resources.push(resource);
  const original = store.readObservationBatch.bind(store), reads: string[][] = [];
  let calls = 0, supported = 0, failure: Error | undefined;
  // Do not replace get/list/require: that would withdraw SQLite's capability.
  // Install before BrowserEngine's RetainedPersistence captures this method.
  store.readObservationBatch = <T>(sid: string, read: (get: ObservationGet) => T) => {
    calls++; const ids: string[] = []; reads.push(ids);
    const result = original(sid, get => read(<O extends Observation>(id: string) => {
      ids.push(id); if (failure) throw failure; return get<O>(id);
    }));
    if (result) supported++;
    return result;
  };
  return { store, resource, reads, calls: () => calls, supported: () => supported, fail: (error: Error) => { failure = error; } };
}

const sid = 'offline-coverage', at = '2026-10-18T00:00:00.000Z';
function observation(id: string): CounterObservation {
  return { id, sessionId: sid, capturedAt: at, count: 0, instanceScope: 'document',
    controls: [{ localId: 'counter', instanceId: `node:${id}`, identityId: 'counter-identity', role: 'accumulator', name: 'Counter',
      label: 'Counter', region: 'machine', visible: true, enabled: true }],
    regions: [{ key: 'machine', role: 'machine', label: 'State machine' }], context: {}, gaps: [], stable: true,
    stateId: `state:${id}`, visitId: `visit:${id}`, fingerprint: id, canonical: id, ruleVersion: 'counter-v1', cause: 'inspection' };
}
function action(o: CounterObservation, value = 'A'): ActionCandidate {
  return { id: `action:${o.id}:${value}`, sessionId: sid, observationId: o.id, stateId: o.stateId, localId: 'counter', controlId: 'counter-identity',
    kind: 'increment', value, label: 'Increment counter', source: 'fixture', risk: 'interface', replayable: true, excluded: false,
    sampleValidity: 'known', preconditions: { context: {}, visible: true, enabled: true, identityResolved: true },
    basis: { status: 'supported', evidence: [{ source: 'fixture', rule: 'captured-counter', facts: {} }] } };
}
function frontier(id: string, a: ActionCandidate, status: FrontierItem['status'] = 'pending'): FrontierItem {
  return { id, sessionId: sid, key: id, stateId: a.stateId, contextKey: '{}', action: a, status, attempts: [], depth: 0 };
}
function session(currentId: string): Session {
  return { id: sid, options: { maxActions: 20, maxDepth: 10, maxDurationMs: 1000, context: {}, exploration: 'controls' },
    createdAt: at, status: 'paused', currentObservationId: currentId, actionCount: 1, elapsedMs: 0, mode: 'manual', dirty: false };
}
class CapturedCounterAdapter extends CounterAdapter {
  override createDriver(): never { throw new Error('This fixture cannot create a driver'); }
  correspondenceCase(_action: ActionCandidate, o: CounterObservation) {
    return { key: `count:${o.count}`, policy: 'captured-counter/v1', evidence: ['complete captured counter mode'] };
  }
}
class BatchCounterEngine extends InteractionEngine<CounterObservation> {
  protected override supportsCoverageObservationBatch() { return true; }
  full(s: string) { return super.coverageMaterial(s); }
  outstanding(s: string) { return super.outstandingFrontier(s); }
}
function seed(store: SqliteStore) {
  const before = observation('before'), after = observation('after'), current = observation('current');
  const source = action(before), a = action(current), b = { ...a, value: 'B' };
  const receipt: ActionAttempt = { id: 'receipt', sessionId: sid, requestId: 'request', action: source, beforeId: before.id, afterId: after.id,
    status: 'succeeded', purpose: 'exploration', startedAt: at, finishedAt: at };
  const items = [frontier('A', a), frontier('B', b), frontier('unknown', a, 'unknown')];
  for (const o of [before, after, current]) store.put('observation', o);
  store.put('session', session(current.id)); store.put('attempt', receipt);
  for (const item of items) store.put('frontier', item);
  return { before, after, current, receipt, items };
}
function counter(Host: typeof BatchCounterEngine = BatchCounterEngine) {
  const db = database(), host = new Host({ adapter: new CapturedCounterAdapter(), persistence: db.store });
  db.resource.host = host;
  return { ...db, host, ...seed(db.store) };
}
const covered = (rows: ReturnType<InteractionEngine['getFrontier']>) => rows.filter(row => row.coverage.equivalentTo).map(row => row.id);
function corruptUnrelated(store: SqliteStore) {
  store.db.prepare("INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES('observation',?,?,?,NULL)")
    .run('unrelated-corrupt', sid, '{bad-json');
}

it('keeps the complete A proof, B and unknown debt equal to eager material, without writing coverage', () => {
  const f = counter(), expected = f.host.full(sid), saved = f.store.list<FrontierItem>('frontier', sid);
  const changes = () => (f.store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const before = changes(), actual = f.host.getFrontier(sid);
  expect(actual).toEqual(expected.frontier);
  expect(covered(actual)).toEqual(['A']);
  expect(actual.find(row => row.id === 'A')!.coverage.equivalentTo).toEqual(expected.equivalents.get('A'));
  expect(actual.find(row => row.id === 'unknown')!.coverage.executionStatus).toBe('unknown');
  expect(f.host.outstanding(sid)).toEqual(expected.raw.filter(row => !expected.equivalents.has(row.id)));
  expect(f.host.outstanding(sid).map(row => row.id)).toEqual(['B', 'unknown']);
  expect(f.supported()).toBe(3);
  expect(f.reads.every(ids => new Set(ids).size === 3 && ids.length === 3)).toBe(true);
  expect(f.store.list('frontier', sid)).toEqual(saved); expect(changes()).toBe(before);
});

it('does not decode unrelated historical observations, while the full audit still reports their corruption', () => {
  const f = counter(); corruptUnrelated(f.store);
  expect(covered(f.host.getFrontier(sid))).toEqual(['A']);
  expect(f.host.outstanding(sid).map(row => row.id)).toEqual(['B', 'unknown']);
  expect(f.reads.flat()).not.toContain('unrelated-corrupt');
  expect(() => f.host.full(sid)).toThrow();
  expect(() => f.host.report(sid)).toThrow();
  // Narrow queries are intentionally not full historical-integrity audits.
});

it('re-reads changed identity decisions and unknown receipts on the next call', () => {
  const f = counter(); expect(covered(f.host.getFrontier(sid))).toEqual(['A']);
  const hypothesis: IdentityHypothesis = { id: 'pending-identity', sessionId: sid, observationId: f.current.id, localId: 'counter',
    provisionalIdentityId: 'counter-identity', candidateIds: [], evidence: [], conflicts: [], status: 'pending', revisions: [] };
  f.store.put('hypothesis', hypothesis);
  expect(f.host.getFrontier(sid)).toEqual(f.host.full(sid).frontier);
  expect(covered(f.host.getFrontier(sid))).toEqual([]);
  f.store.put('hypothesis', { ...hypothesis, status: 'resolved', revisions: [{ identityId: 'counter-identity', source: 'fixture', evidence: ['resolved'], at }] });
  expect(covered(f.host.getFrontier(sid))).toEqual(['A']);
  f.store.put('attempt', { ...f.receipt, status: 'unknown' });
  expect(f.host.getFrontier(sid)).toEqual(f.host.full(sid).frontier);
  expect(covered(f.host.getFrontier(sid))).toEqual([]);
  expect(f.host.outstanding(sid).map(row => row.id)).toEqual(['A', 'B', 'unknown']);
  expect(f.reads.slice(0, 4).every(ids => ids.includes('before') && ids.includes('current'))).toBe(true);
  expect(f.store.require<ActionAttempt>('attempt', f.receipt.id).status).toBe('unknown');
});

it('respects protected coverage composition and does not introduce public observation reads for history', () => {
  class CustomMaterial extends BatchCounterEngine {
    protected override coverageMaterial(s: string) {
      const material = super.coverageMaterial(s);
      return { ...material, raw: material.raw.filter(row => row.id === 'B'), frontier: material.frontier.filter(row => row.id === 'B'), equivalents: new Map() };
    }
  }
  const custom = counter(CustomMaterial);
  expect(custom.host.getFrontier(sid).map(row => row.id)).toEqual(['B']);
  expect(custom.host.outstanding(sid).map(row => row.id)).toEqual(['B']);
  expect(custom.calls()).toBe(0);
  class PublicObservation extends BatchCounterEngine {
    override observation(_sid: string, _id?: string): CounterObservation { throw new Error('Public observation must not replace historical storage facts'); }
  }
  const projected = counter(PublicObservation);
  expect(projected.host.getFrontier(sid)).toEqual(projected.host.full(sid).frontier);
  expect(covered(projected.host.getFrontier(sid))).toEqual(['A']);
  expect(projected.supported()).toBe(2);
});

it('propagates the exact batch getter failure instead of retrying an empty or eager frontier', () => {
  const f = counter(), failure = new Error('required observation decode failed');
  f.fail(failure);
  for (const query of [() => f.host.getFrontier(sid), () => f.host.outstanding(sid)]) {
    let caught: unknown;
    try { query(); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
  }
  expect(f.calls()).toBe(2); expect(f.supported()).toBe(0);
  // Eager data is valid, so an illicit eager fallback would have hidden failure.
  expect(covered(f.host.full(sid).frontier)).toEqual(['A']);
});

it.each(['default', 'engine-override', 'adapter-override'] as const)('uses the real BrowserEngine batch qualification without attaching a browser: %s', composition => {
  const f = database();
  class CustomBrowser extends BrowserEngine { override observation(s: string, id?: string) { return super.observation(s, id); } }
  const host = composition === 'engine-override' ? new CustomBrowser({ persistence: f.store, retention: { sweepIntervalMs: 0 } })
    : new BrowserEngine({ persistence: f.store, retention: { sweepIntervalMs: 0 } });
  f.resource.host = host;
  if (composition === 'adapter-override') {
    const adapter = (host as unknown as { adapter: PlaywrightAdapter }).adapter, original = adapter.constrain;
    adapter.constrain = (...args) => original.apply(adapter, args);
  }
  // Empty recorded browser frontier is sufficient to exercise the real closed
  // composition/RetainedPersistence/SQLite admission, without DOM fabrication.
  f.store.put('session', session('browser-current'));
  f.store.put('observation', { ...observation('browser-current'), controls: [] });
  corruptUnrelated(f.store);
  if (composition === 'default') {
    expect(host.getFrontier(sid)).toEqual([]); expect(f.supported()).toBe(1);
  } else {
    expect(() => host.getFrontier(sid)).toThrow(); expect(f.calls()).toBe(0);
  }
});
