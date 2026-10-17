import { expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Observation, Persistence } from '@interaction/core';
import { SqliteStore, type StoredEntityRow } from '@interaction/storage-sqlite';
import { MemoryStore } from '@interaction/storage-memory';
import { RetainedPersistence } from '@interaction/storage-retained';

type Getter = <O extends Observation>(id: string) => O | undefined;
const observation = (id: string, sessionId = 's'): Observation => ({
  id, sessionId, capturedAt: '2026-10-17T00:00:00Z', instanceScope: 'document',
  controls: Array.from({ length: 48 }, (_, i) => ({ localId: `c${i}`, instanceId: `node${i}`, identityId: `identity${i}`,
    role: 'button', name: `Captured material ${i} ${'retained source facts '.repeat(40)}`, label: `Control ${i}`, region: 'root', visible: true, enabled: true })),
  regions: [], context: {}, gaps: [], stable: true, stateId: 'state', visitId: `visit:${id}`,
  fingerprint: 'facts', canonical: 'facts', ruleVersion: 'fixture', cause: 'inspection',
});
function withStore(fn: (store: SqliteStore, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'observation-batch-')), store = new SqliteStore(directory);
  try { fn(store, directory); }
  finally { if (store.db.open) store.close(); rmSync(directory, { recursive: true, force: true }); }
}

it('reads detached session-owned observations from one batch without decoding unrelated corrupt history', () => withStore(store => {
  const source = observation('source'); store.put('observation', source); store.put('observation', observation('foreign', 'other'));
  store.put('action', { id: 'action', sessionId: 's' });
  store.db.prepare("INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES('observation','broken','s','{broken',NULL)").run();
  let expired!: Getter;
  const result = store.readObservationBatch('s', get => {
    expired = get;
    expect(get('foreign')).toBeUndefined(); expect(get('action')).toBeUndefined(); expect(get('missing')).toBeUndefined();
    const first = get('source')!; expect(first).toEqual(source); first.controls[0].name = 'caller mutation';
    expect(get('source')).toEqual(source); expect(store.get('observation', 'source')).toEqual(source);
    return get('source');
  });
  expect(result).toEqual({ value: source }); expect(() => expired('source')).toThrow('expired');
  expect(store.readObservationBatch('s', () => undefined)).toEqual({ value: undefined });
  expect(() => store.readObservationBatch('s', get => get('broken'))).toThrow(/corrupt/);
  expect(() => store.list('observation', 's')).toThrow(/corrupt/);
}));

it('pins the snapshot before the callback and retains it across an external SQLite commit', () => withStore((store, directory) => {
  const source = observation('source'), changed = { ...source, canonical: 'external change' };
  store.put('observation', source);
  const other = new DatabaseSync(join(directory, 'engine.sqlite'));
  try {
    const result = store.readObservationBatch('s', get => {
      // Commit on the other connection before this batch's first getter.
      other.prepare("UPDATE entities SET json=?,compressed_json=NULL WHERE id='source'").run(JSON.stringify(changed));
      other.prepare("INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES('observation','new','s',?,NULL)").run(JSON.stringify(observation('new')));
      expect(get('source')).toEqual(source); expect(get('new')).toBeUndefined();
      expect(store.get('observation', 'source')).toEqual(source);
      expect(store.list('observation', 's')).toEqual([source]);
      return get('source');
    });
    expect(result).toEqual({ value: source });
    expect(store.get('observation', 'source')).toEqual(changed); expect(store.get('observation', 'new')).toBeDefined();
  } finally { other.close(); }
}));

it('opens one observation-object lifecycle for batch getters and ordinary nested reads', () => withStore(store => {
  const source = observation('source'); store.put('observation', source);
  const objects = (store as unknown as { observations: { begin(cacheable: boolean): void; end(cacheable: boolean): void } }).observations;
  const begin = vi.spyOn(objects, 'begin'), end = vi.spyOn(objects, 'end');
  try {
    store.readObservationBatch('s', get => {
      expect(get('source')).toEqual(source); expect(store.require('observation', 'source')).toEqual(source);
      expect(store.list('observation', 's')).toEqual([source]);
      const row = store.db.prepare("SELECT kind,id,session_id,json,compressed_json FROM entities WHERE id='source'").get() as StoredEntityRow;
      expect(store.decodeStoredEntity(row)).toEqual(source);
      expect(store.readObservationBatch('s', nested => nested('source'))).toEqual({ value: source });
      expect(get('source')).toEqual(source);
    });
    expect(begin).toHaveBeenCalledTimes(1); expect(end).toHaveBeenCalledTimes(1);
  } finally { begin.mockRestore(); end.mockRestore(); }
}));

it('supports an existing write transaction without committing it or changing later write semantics', () => withStore(store => {
  store.transaction(() => {
    store.put('observation', observation('inside'));
    expect(store.readObservationBatch('s', get => get('inside')?.id)).toEqual({ value: 'inside' });
    expect(store.db.inTransaction).toBe(true); expect(store.db.pragma('query_only', { simple: true })).toBe(0);
    store.put('action', { id: 'after-batch', sessionId: 's' });
  });
  expect(store.get('action', 'after-batch')).toBeDefined();
  expect(() => store.transaction(() => {
    store.put('observation', observation('rolled-back'));
    expect(store.readObservationBatch('s', get => get('rolled-back')?.id)).toEqual({ value: 'rolled-back' });
    throw Error('outer rollback');
  })).toThrow('outer rollback');
  expect(store.get('observation', 'rolled-back')).toBeUndefined();
}));

it('propagates callback errors unchanged and expires the getter after failure', () => withStore(store => {
  const failure = new Error('original callback error'); let expired!: Getter;
  try { store.readObservationBatch('s', get => { expired = get; throw failure; }); throw Error('Expected failure'); }
  catch (error) { expect(error).toBe(failure); }
  expect(() => expired('anything')).toThrow('expired'); expect(store.db.inTransaction).toBe(false);
  expect(store.db.pragma('query_only', { simple: true })).toBe(0);
  expect(store.readObservationBatch('s', () => 'usable')).toEqual({ value: 'usable' });
  for (const kind of ['promise', 'thenable']) {
    expect(() => store.readObservationBatch('s', get => { expired = get; return kind === 'promise' ? Promise.resolve(1) : { then() {} }; })).toThrow('synchronous');
    expect(() => expired('anything')).toThrow('expired'); expect(store.db.inTransaction).toBe(false);
    expect(store.db.pragma('query_only', { simple: true })).toBe(0);
  }
}));

it('rejects normal record and raw SQL writes and restores the original connection policy', () => withStore(store => {
  for (const kind of ['put', 'event', 'request', 'raw-sql']) {
    expect(() => store.readObservationBatch('s', () => {
      if (kind === 'put') store.put('action', { id: 'written', sessionId: 's' });
      else if (kind === 'event') store.event('s', 'written', {});
      else if (kind === 'request') store.recordRequest('s', 'written', 'attempt', '{}');
      else store.db.prepare("INSERT INTO entities(kind,id,session_id,json) VALUES('action','written','s','{}')").run();
    })).toThrow(/readonly/i);
    expect(store.get('action', 'written')).toBeUndefined(); expect(store.events('s')).toEqual([]); expect(store.request('s', 'written')).toBeUndefined();
    expect(store.db.pragma('query_only', { simple: true })).toBe(0);
  }
  store.put('action', { id: 'allowed-after', sessionId: 's' }); expect(store.get('action', 'allowed-after')).toBeDefined();
}));

it('detects writes after callback withdrawal of query_only and rolls back only the batch savepoint', () => withStore(store => {
  store.transaction(() => {
    store.put('action', { id: 'outer-before', sessionId: 's' });
    expect(() => store.readObservationBatch('s', () => {
      store.db.pragma('query_only = OFF'); store.put('action', { id: 'rejected', sessionId: 's' });
    })).toThrow('must not write');
    expect(store.get('action', 'rejected')).toBeUndefined(); expect(store.get('action', 'outer-before')).toBeDefined();
    expect(store.db.inTransaction).toBe(true); store.put('action', { id: 'outer-after', sessionId: 's' });
  });
  expect(store.list<{ id: string }>('action', 's').map(row => row.id)).toEqual(['outer-before', 'outer-after']);
}));

it('rejects connection transaction replacement even when inTransaction becomes true again', () => withStore(store => {
  expect(() => store.readObservationBatch('s', () => { store.db.exec('COMMIT; BEGIN'); return 'invalid snapshot'; })).toThrow(/savepoint/);
  expect(store.db.inTransaction).toBe(false); expect(store.db.pragma('query_only', { simple: true })).toBe(0);
}));

it('does not invoke the callback for overridden reads', () => withStore(store => {
  for (const method of ['get', 'require', 'list', 'listByObservation', 'events', 'request'] as const) {
    const callback = vi.fn(), original = store[method];
    Object.defineProperty(store, method, { configurable: true, value: (...args: unknown[]) => Reflect.apply(original, store, args) });
    expect(store.readObservationBatch('s', callback)).toBeUndefined(); expect(callback).not.toHaveBeenCalled();
    delete (store as unknown as Record<string, unknown>)[method];
    expect(store.readObservationBatch('s', callback)).toEqual({ value: undefined }); expect(callback).toHaveBeenCalledTimes(1);
  }
}));

it('rejects a read composition changed during the callback and refuses mismatched stored ownership', () => withStore(store => {
  expect(() => store.readObservationBatch('s', () => {
    const original = store.get; store.get = <T>(kind: string, id: string) => original.call(store, kind, id) as T | undefined;
  })).toThrow('composition');
  delete (store as unknown as Record<string, unknown>).get;
  store.db.prepare("INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES('observation','bad-owner','s',?,NULL)")
    .run(JSON.stringify(observation('bad-owner', 'another')));
  expect(() => store.readObservationBatch('s', get => get('bad-owner'))).toThrow('ownership');
}));

it('withdraws retained forwarding when a bound read or its backing batch changes', () => {
  for (const change of ['backing-read', 'bound-read', 'backing-batch']) withStore(store => {
  store.put('observation', observation('source'));
  const retained = new RetainedPersistence(store, { sweepIntervalMs: 0 }), callback = vi.fn((get: Getter) => get('source')?.id);
  expect(retained.readObservationBatch('s', callback)).toEqual({ value: 'source' }); callback.mockClear();
  if (change === 'backing-read') {
    const original = store.get; store.get = <T>(kind: string, id: string) => original.call(store, kind, id) as T | undefined;
  } else if (change === 'bound-read') {
    const original = retained.get; retained.get = <T>(kind: string, id: string) => original.call(retained, kind, id) as T | undefined;
  } else {
    const original = store.readObservationBatch;
    store.readObservationBatch = <T>(sid: string, read: (get: Getter) => T) => original.call(store, sid, read) as { value: T } | undefined;
  }
  expect(retained.readObservationBatch('s', callback)).toBeUndefined(); expect(callback).not.toHaveBeenCalled();
  retained.close();
  });
});

it('allows a transparent batch wrapper bound before retained construction', () => withStore(store => {
  store.put('observation', observation('source'));
  const original = store.readObservationBatch; let reads = 0;
  store.readObservationBatch = <T>(sid: string, read: (get: Getter) => T) => original.call(store, sid, get => read(id => { reads++; return get(id); })) as { value: T } | undefined;
  const retained = new RetainedPersistence(store, { sweepIntervalMs: 0 });
  expect(retained.readObservationBatch('s', get => get('source')?.id)).toEqual({ value: 'source' }); expect(reads).toBe(1); retained.close();
  const callback = vi.fn(); expect(store.readObservationBatch('s', callback)).toBeUndefined(); expect(callback).not.toHaveBeenCalled();
  const memory: Persistence = new MemoryStore(), memoryRetained = new RetainedPersistence(memory, { sweepIntervalMs: 0 });
  try { expect(memory.readObservationBatch).toBeUndefined(); expect(memoryRetained.readObservationBatch('s', callback)).toBeUndefined(); expect(callback).not.toHaveBeenCalled(); }
  finally { memoryRetained.close(); }
}));
