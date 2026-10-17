import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Persistence } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { RetainedPersistence } from '@interaction/storage-retained';

type Store = MemoryStore | SqliteStore;
const readMethods = ['get', 'require', 'list', 'listByObservation', 'events', 'request'] as const;

function withSqlite(fn: (store: SqliteStore, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'record-revision-'));
  const store = new SqliteStore(directory);
  try { fn(store, directory); }
  finally { if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); }
}

for (const backend of ['memory', 'sqlite'] as const) describe(`${backend} whole-record revision`, () => {
  const withStore = (fn: (store: Store) => void) => {
    if (backend === 'sqlite') return withSqlite(fn);
    const store = new MemoryStore();
    try { fn(store); } finally { store.close(); }
  };

  it('is stable and instance-scoped without materializing records', () => withStore(store => {
    store.put('action', { id: 'a', sessionId: 's', observationId: 'o' });
    const before = store.recordRevision(); expect(before).toEqual(expect.any(String));
    const spies: { mockRestore(): void }[] = [];
    try {
      if (store instanceof MemoryStore) {
        const entities = (store as unknown as { entities: Map<string, unknown> }).entities;
        spies.push(vi.spyOn(entities, 'get').mockImplementation(() => { throw Error('Unexpected record lookup'); }));
        spies.push(vi.spyOn(entities, 'values').mockImplementation(() => { throw Error('Unexpected record scan'); }));
      } else {
        // Revision statements were prepared once and read only constant-sized
        // connection metadata. No entity decoder/query may be prepared here.
        const raw = store as unknown as { recordStamp: { source: string }; tempSchemaStamp: { source: string } };
        expect(raw.recordStamp.source).not.toMatch(/\b(entities|events|requests|observation_objects|observation_packs)\b/);
        expect(raw.tempSchemaStamp.source).toBe('PRAGMA temp.schema_version');
        spies.push(vi.spyOn(store.db, 'prepare').mockImplementation(() => { throw Error('Unexpected query preparation'); }));
      }
      for (let i = 0; i < 8; i++) expect(store.recordRevision()).toBe(before);
    } finally { for (const spy of spies) spy.mockRestore(); }
    expect(store.get('action', 'a')).toMatchObject({ observationId: 'o' });
    expect(store.recordRevision()).toBe(before);
    const other = new MemoryStore();
    try { expect(other.recordRevision()).not.toBe(before); } finally { other.close(); }
  }));

  it('invalidates for every record kind, events and requests, including another session', () => withStore(store => {
    let before = store.recordRevision();
    for (const kind of ['session', 'observation', 'action', 'frontier', 'checkpoint', 'control-classification', 'region-review', 'continuation', 'hypothesis', 'attempt', 'evidence-entry', 'custom-kind']) {
      store.put(kind, { id: `id:${kind}`, sessionId: 'other', value: 1 });
      const after = store.recordRevision(); expect(after).toEqual(expect.any(String)); expect(after).not.toBe(before); before = after;
    }
    store.event('s', 'changed', { reason: 'new evidence' });
    expect(store.recordRevision()).not.toBe(before); before = store.recordRevision();
    store.recordRequest('s', 'request', 'attempt', '{}');
    expect(store.recordRevision()).not.toBe(before);
    expect(store.events('s')).toHaveLength(1); expect(store.request('s', 'request')).toEqual({ attemptId: 'attempt', payload: '{}' });
  }));

  it('never certifies transaction-local facts and does not roll the epoch back', () => withStore(store => {
    store.put('action', { id: 'a', sessionId: 's', mode: 'original' });
    const before = store.recordRevision();
    store.transaction(() => {
      expect(store.recordRevision()).toBeUndefined();
      expect(() => store.transaction(() => {
        store.put('action', { id: 'a', sessionId: 's', mode: 'speculative' });
        expect(store.recordRevision()).toBeUndefined();
        throw Error('inner rollback');
      })).toThrow('inner rollback');
      expect(store.recordRevision()).toBeUndefined();
    });
    expect(store.get('action', 'a')).toMatchObject({ mode: 'original' });
    const after = store.recordRevision(); expect(after).toEqual(expect.any(String)); expect(after).not.toBe(before);
    expect(store.recordRevision()).toBe(after);
    expect(() => store.transaction(() => { throw Error('empty rollback'); })).toThrow('empty rollback');
    expect(store.recordRevision()).not.toBe(after);
  }));

  it('withdraws its inherited promise for each overridden public read', () => withStore(store => {
    for (const method of readMethods) {
      const original = store[method];
      Object.defineProperty(store, method, { configurable: true, writable: true, value: (...args: unknown[]) => Reflect.apply(original, store, args) });
      expect(store.recordRevision(), method).toBeUndefined();
      delete (store as unknown as Record<string, unknown>)[method];
    }
    expect(store.recordRevision()).toEqual(expect.any(String));
  }));

  it('withdraws freshness after close without issuing another token', () => withStore(store => {
    expect(store.recordRevision()).toEqual(expect.any(String));
    store.close(); expect(store.recordRevision()).toBeUndefined();
  }));
});

it('SQLite sees raw writes, external commits and deletion even after normal writes', () => withSqlite((store, directory) => {
  store.put('action', { id: 'a', sessionId: 's', observationId: 'o' });
  const other = new SqliteStore(directory);
  try {
    const before = store.recordRevision();
    store.db.prepare('UPDATE entities SET json=? WHERE id=?').run(JSON.stringify({ id: 'a', sessionId: 's', observationId: 'changed' }), 'a');
    store.event('s', 'normal write after raw write', {});
    expect(store.recordRevision()).not.toBe(before);
    const external = store.recordRevision();
    other.put('action', { id: 'a', sessionId: 's', observationId: 'external' });
    expect(store.recordRevision()).not.toBe(external);
    expect(store.listByObservation('action', 's', 'external')).toHaveLength(1);
    const deleted = store.recordRevision();
    other.db.prepare('DELETE FROM entities WHERE id=?').run('a');
    expect(store.recordRevision()).not.toBe(deleted); expect(store.get('action', 'a')).toBeUndefined();
    expect(other.recordRevision()).not.toBe(store.recordRevision());
  } finally { other.close(); }
}));

it('SQLite refuses raw transaction proofs before commit and rollback', () => withSqlite(store => {
  store.put('action', { id: 'a', sessionId: 's', mode: 'original' });
  const before = store.recordRevision();
  expect(() => store.db.transaction(() => {
    store.db.prepare('UPDATE entities SET json=? WHERE id=?').run(JSON.stringify({ id: 'a', sessionId: 's', mode: 'speculative' }), 'a');
    expect(store.recordRevision()).toBeUndefined();
    throw Error('raw rollback');
  })()).toThrow('raw rollback');
  expect(store.get('action', 'a')).toMatchObject({ mode: 'original' });
  const after = store.recordRevision(); expect(after).not.toBe(before);
  store.db.transaction(() => { expect(store.recordRevision()).toBeUndefined(); })();
  expect(store.recordRevision()).not.toBe(after);
}));

it('SQLite detects main and TEMP schema changes and trigger side effects', () => withSqlite(store => {
  store.put('action', { id: 'a', sessionId: 's' });
  const before = store.recordRevision();
  store.db.exec("CREATE TRIGGER delete_action AFTER INSERT ON events BEGIN DELETE FROM entities WHERE id='a'; END;");
  const schema = store.recordRevision(); expect(schema).not.toBe(before);
  store.event('s', 'trigger', {}); expect(store.recordRevision()).not.toBe(schema);
  expect(store.get('action', 'a')).toBeUndefined();
  const temp = store.recordRevision();
  store.db.exec('CREATE TEMP TABLE entities(kind TEXT,id TEXT,session_id TEXT,json TEXT,compressed_json BLOB)');
  expect(store.recordRevision()).not.toBe(temp);
  const shadow = store.recordRevision();
  store.db.exec('DROP TABLE temp.entities'); expect(store.recordRevision()).not.toBe(shadow);
}));

it('SQLite keeps exact 64-bit change metadata and detects observation maintenance', () => withSqlite(store => {
  const raw = store as unknown as { recordStamp: { get(): { total: bigint; dataVersion: bigint; schemaVersion: bigint } } };
  const stamp = raw.recordStamp.get();
  expect(typeof stamp.total).toBe('bigint'); expect(typeof stamp.dataVersion).toBe('bigint'); expect(typeof stamp.schemaVersion).toBe('bigint');
  // A plain legacy row is deliberately inserted into this new temporary DB so
  // the explicit migration has actual work; no historical database is opened.
  const observation = { id: 'o', sessionId: 's', payload: 'legacy '.repeat(10000) };
  store.db.prepare('INSERT INTO entities(kind,id,session_id,json) VALUES(?,?,?,?)').run('observation', 'o', 's', JSON.stringify(observation));
  const before = store.recordRevision();
  expect(store.compressObservations({ limit: 1 }).compressed).toBe(1);
  expect(store.recordRevision()).not.toBe(before);
  expect(store.get('observation', 'o')).toEqual(observation);
}));

it('Retained forwards revisions while separating instances and observing backing writes', () => {
  const backing = new MemoryStore(), retained = new RetainedPersistence(backing, { sweepIntervalMs: 0 });
  try {
    const before = retained.recordRevision(); expect(before).toEqual(expect.any(String));
    expect(before).not.toBe(backing.recordRevision()); expect(retained.recordRevision()).toBe(before);
    backing.put('control-review', { id: 'review', sessionId: 's' }); expect(retained.recordRevision()).not.toBe(before);
    retained.transaction(() => { expect(retained.recordRevision()).toBeUndefined(); });
  } finally { retained.close(); }
  expect(retained.recordRevision()).toBeUndefined();
});

it('Retained withdraws when either bound reads or the backing revision method change', () => {
  const backing = new MemoryStore(), retained = new RetainedPersistence(backing, { sweepIntervalMs: 0 });
  try {
    for (const target of [backing, retained]) for (const method of readMethods) {
      const original = target[method];
      Object.defineProperty(target, method, { configurable: true, writable: true, value: (...args: unknown[]) => Reflect.apply(original!, target, args) });
      expect(retained.recordRevision(), `${target === backing ? 'backing' : 'retained'}.${method}`).toBeUndefined();
      if (target === backing) delete (target as unknown as Record<string, unknown>)[method];
      else Object.defineProperty(target, method, { configurable: true, writable: true, value: original });
    }
    const revision = backing.recordRevision;
    backing.recordRevision = () => revision.call(backing);
    expect(retained.recordRevision()).toBeUndefined();
  } finally { retained.close(); }
});

it('Retained does not invent support for legacy/custom stores or inherited overridden reads', () => {
  class ProjectedStore extends MemoryStore {
    override get<T>(kind: string, key: string): T | undefined { return super.get<T>(kind, key); }
  }
  const projected = new ProjectedStore(); expect(projected.recordRevision()).toBeUndefined(); projected.close();
  const backing = new MemoryStore();
  Object.defineProperty(backing, 'recordRevision', { value: undefined });
  const retained = new RetainedPersistence(backing as Persistence, { sweepIntervalMs: 0 });
  try { expect(retained.recordRevision()).toBeUndefined(); } finally { retained.close(); }
});
