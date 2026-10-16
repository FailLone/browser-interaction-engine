import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionAttempt, ActionCandidate, Observation, Persistence, Transition } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { NavigationIndex } from '../packages/core/src/navigation-index.js';

const observation = (id: string): Observation => ({ id, sessionId: 's', capturedAt: '2026-10-17T00:00:00Z', instanceScope: 'page',
  controls: [], regions: [], context: {}, gaps: [], stable: true, stateId: id, visitId: id, fingerprint: id, canonical: id, ruleVersion: 'test', cause: 'action' });
const action = (id: string): ActionCandidate => ({ id, sessionId: 's', observationId: 'o1', stateId: 'o1', controlId: id,
  kind: 'click', label: id, preconditions: { context: {}, visible: true, enabled: true, identityResolved: true },
  replayable: true, risk: 'interface', source: 'fixture', excluded: false, sampleValidity: 'known' });
const attempt = (id: string, beforeId = 'o1', afterId = 'o2'): ActionAttempt => ({ id, sessionId: 's', requestId: id,
  action: action(id), startedAt: '2026-10-17T00:00:00Z', beforeId, afterId, status: 'succeeded', purpose: 'external' });
const transition = (id: string, attemptId: string): Transition => ({ id, attemptId, sessionId: 's', from: 'ignored-group', to: 'ignored-group', replayable: true });
function seed(store: Persistence) {
  for (const id of ['o1', 'o2', 'o3']) store.put('observation', observation(id));
  store.put('attempt', attempt('a')); store.put('attempt', attempt('b', 'o2', 'o3'));
  store.put('transition', transition('ta', 'a')); store.put('transition', transition('tb', 'b'));
}
const indexFor = (store: Persistence) => new NavigationIndex<Observation>(store, 's', o => o.canonical, a => `condition:${a.controlId}`);
function withSqlite(fn: (store: SqliteStore, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'navigation-index-')), store = new SqliteStore(directory);
  try { fn(store, directory); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

for (const backend of ['memory', 'sqlite'] as const) describe(`${backend} navigation fact index`, () => {
  function withStore(fn: (store: MemoryStore | SqliteStore) => void) {
    if (backend === 'sqlite') return withSqlite(fn);
    const store = new MemoryStore(); try { fn(store); } finally { store.close(); }
  }

  it('serves an unchanged graph without full lists or observation decoding', () => withStore(store => {
    seed(store); const key = vi.fn((o: Observation) => o.canonical);
    const index = new NavigationIndex(store, 's', key, a => `condition:${a.controlId}`), get = vi.spyOn(store, 'get'), list = vi.spyOn(store, 'list');
    expect(index.refresh()).toBe(true); expect(index.graph.path('o1', 'o3')).toEqual(['a', 'b']);
    expect(index.metrics).toMatchObject({ rebuilds: 1, attemptsRead: 2, observationsRead: 3 });
    expect(key).toHaveBeenCalledTimes(3);
    get.mockClear(); list.mockClear();
    for (let i = 0; i < 10; i++) expect(index.refresh()).toBe(true);
    expect(get).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    expect(index.metrics).toMatchObject({ rebuilds: 1, attemptsRead: 2, observationsRead: 3 });
  }));

  it('refreshes only a changed attempt and its two observation dependencies', () => withStore(store => {
    seed(store); const index = indexFor(store); expect(index.refresh()).toBe(true);
    const get = vi.spyOn(store, 'get'), list = vi.spyOn(store, 'list');
    store.put('attempt', { ...attempt('a'), recoverySegment: { recordedAttemptId: 'old', conditionKey: 'condition:a', mode: 'target', durationMs: 500, outcome: 'matched' } });
    expect(index.refresh()).toBe(true);
    expect(get.mock.calls).toEqual([['attempt', 'a'], ['observation', 'o1'], ['observation', 'o2']]);
    expect(list).not.toHaveBeenCalled(); expect(index.cost('a', 'target')).toBe(500);
    get.mockClear(); store.put('observation', observation('passive-new'));
    expect(index.refresh()).toBe(true); expect(get).not.toHaveBeenCalled();
  }));

  it('removes historical permissions immediately and restores them only from current stored facts', () => withStore(store => {
    seed(store); const index = indexFor(store); expect(index.refresh()).toBe(true);
    const get = vi.spyOn(store, 'get');
    store.put('transition', { ...transition('ta', 'a'), replayable: false });
    expect(index.refresh()).toBe(true); expect(index.graph.path('o1', 'o3')).toBeNull();
    expect(get.mock.calls).toEqual([['transition', 'ta']]);
    store.put('transition', transition('ta', 'a')); store.put('attempt', { ...attempt('a'), status: 'unknown' });
    expect(index.refresh()).toBe(true); expect(index.graph.path('o1', 'o3')).toBeNull();
    store.put('attempt', { ...attempt('a'), action: { ...action('a'), replayable: false } });
    expect(index.refresh()).toBe(true); expect(index.graph.path('o1', 'o3')).toBeNull();
    store.put('attempt', attempt('a'));
    expect(index.refresh()).toBe(true); expect(index.graph.path('o1', 'o3')).toEqual(['a', 'b']);
  }));

  it('does not leak a transaction-local view into queries after rollback', () => withStore(store => {
    seed(store); const index = indexFor(store); expect(index.refresh()).toBe(true);
    expect(() => store.transaction(() => {
      store.put('attempt', { ...attempt('a'), status: 'unknown' });
      expect(index.refresh()).toBe(true); expect(index.graph.path('o1', 'o3')).toBeNull();
      throw Error('rollback');
    })).toThrow('rollback');
    expect(index.refresh()).toBe(true); expect(index.graph.path('o1', 'o3')).toEqual(['a', 'b']);
    expect(index.metrics.rebuilds).toBeGreaterThan(1);
  }));

  it('isolates cost evidence by mode and conditions, removes overwritten samples, and ignores unknowns', () => withStore(store => {
    seed(store); const index = indexFor(store);
    const record = (outcome: NonNullable<ActionAttempt['recoverySegment']>['outcome'], status: ActionAttempt['status'] = 'succeeded') => store.put('attempt', {
      ...attempt('a'), status, recoverySegment: { recordedAttemptId: 'old', conditionKey: 'condition:a', mode: 'target', durationMs: 500, outcome },
    });
    record('no_progress'); expect(index.refresh()).toBe(true);
    expect(index.cost('a', 'target')).toBe(4500); expect(index.cost('a', 'checkpoint')).toBe(1000);
    expect(index.cost('a', 'target', 'changed-condition')).toBe(1000);
    record('matched'); expect(index.refresh()).toBe(true); expect(index.cost('a', 'target')).toBe(500);
    record('unknown', 'unknown'); expect(index.refresh()).toBe(true); expect(index.cost('a', 'target')).toBe(1000);
    record('unverified'); expect(index.refresh()).toBe(true); expect(index.cost('a', 'target')).toBe(1000);
  }));

  it('prefers a measured cheaper two-step route after a cold rebuild, without any failure penalty', () => withStore(store => {
    seed(store); store.put('attempt', attempt('direct', 'o1', 'o3')); store.put('transition', transition('tdirect', 'direct'));
    const index = indexFor(store); expect(index.refresh()).toBe(true);
    expect(index.graph.path('o1', 'o3', undefined, edge => index.cost(edge.attemptId, 'target'))).toEqual(['direct']);
    for (const [id, before, after, durationMs] of [['a', 'o1', 'o2', 250], ['b', 'o2', 'o3', 250], ['direct', 'o1', 'o3', 1500]] as const) {
      store.put('attempt', { ...attempt(id, before, after), recoverySegment: { recordedAttemptId: `old-${id}`, conditionKey: `condition:${id}`, mode: 'target', durationMs, outcome: 'matched' } });
    }
    const cold = indexFor(store);
    for (const current of [index, cold]) {
      expect(current.refresh()).toBe(true);
      expect(current.graph.path('o1', 'o3', undefined, edge => current.cost(edge.attemptId, 'target'))).toEqual(['a', 'b']);
    }
    store.put('attempt', { ...attempt('a'), recoverySegment: { recordedAttemptId: 'old-a', conditionKey: 'condition:a', mode: 'target', durationMs: 5000, outcome: 'matched' } });
    expect(index.refresh()).toBe(true);
    expect(index.graph.path('o1', 'o3', undefined, edge => index.cost(edge.attemptId, 'target'))).toEqual(['direct']);
  }));
});

it('supports legacy Persistence implementations with a fresh full scan on each query', () => {
  const store = new MemoryStore(); seed(store);
  const legacy = new Proxy(store, { get(target, property) {
    if (property === 'entityChanges') return undefined;
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } }) as Persistence;
  const index = indexFor(legacy), list = vi.spyOn(store, 'list');
  expect(index.refresh()).toBe(true); expect(index.graph.path('o1', 'o3')).toEqual(['a', 'b']);
  store.put('attempt', { ...attempt('a'), status: 'unknown' });
  expect(index.refresh()).toBe(true); expect(index.graph.path('o1', 'o3')).toBeNull();
  expect(list).toHaveBeenCalledTimes(4); expect(index.metrics.rebuilds).toBe(2);
});

it('retries once when a write occurs during a scan and never exposes the abandoned graph', () => {
  const store = new MemoryStore(); seed(store); const original = store.list.bind(store);
  let changed = false;
  vi.spyOn(store, 'list').mockImplementation((kind, sid) => {
    const result = original(kind, sid);
    if (kind === 'attempt' && !changed) { changed = true; store.put('attempt', { ...attempt('a'), status: 'unknown' }); }
    return result;
  });
  const index = indexFor(store); expect(index.refresh()).toBe(true);
  expect(index.metrics.rebuilds).toBe(2); expect(index.graph.path('o1', 'o3')).toBeNull();
});

it('returns no usable graph when facts change throughout both bounded retries', () => {
  const store = new MemoryStore(); seed(store); const original = store.list.bind(store);
  vi.spyOn(store, 'list').mockImplementation((kind, sid) => {
    const result = original(kind, sid);
    if (kind === 'attempt') store.put('attempt', attempt('a'));
    return result;
  });
  const index = indexFor(store); expect(index.refresh()).toBe(false);
  expect(index.metrics.rebuilds).toBe(2); expect(index.graph.size).toBe(0);
});

it('invalidates cached SQLite observations after a raw delete', () => withSqlite(store => {
  seed(store); const index = indexFor(store); expect(index.refresh()).toBe(true);
  store.db.prepare('DELETE FROM entities WHERE id=?').run('o2');
  expect(index.refresh()).toBe(true); expect(index.graph.path('o1', 'o3')).toBeNull();
  expect(index.metrics.rebuilds).toBe(2);
}));

it('rebuilds on another SQLite connection update during the first scan', () => withSqlite((store, directory) => {
  seed(store); const other = new SqliteStore(directory), original = store.list.bind(store);
  let changed = false;
  vi.spyOn(store, 'list').mockImplementation((kind, sid) => {
    const result = original(kind, sid);
    if (kind === 'attempt' && !changed) { changed = true; other.put('attempt', { ...attempt('a'), status: 'unknown' }); }
    return result;
  });
  try {
    const index = indexFor(store); expect(index.refresh()).toBe(true);
    expect(index.metrics.rebuilds).toBe(2); expect(index.graph.path('o1', 'o3')).toBeNull();
  } finally { other.close(); }
}));
