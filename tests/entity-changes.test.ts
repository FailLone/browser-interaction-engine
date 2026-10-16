import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedEntityChanges } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';

function withSqlite(fn: (store: SqliteStore, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'entity-changes-'));
  const store = new SqliteStore(directory);
  try { fn(store, directory); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

for (const backend of ['memory', 'sqlite'] as const) describe(`${backend} navigation change hints`, () => {
  function withStore(fn: (store: MemoryStore | SqliteStore) => void) {
    if (backend === 'sqlite') return withSqlite(fn);
    const store = new MemoryStore();
    try { fn(store); } finally { store.close(); }
  }

  it('starts with a reset and returns only changed scoped IDs, without entity bodies', () => withStore(store => {
    const initial = store.entityChanges('attempt', 's');
    expect(initial).toEqual({ token: expect.any(String), reset: true, ids: [] });
    expect(store.entityChanges('attempt', 's', initial.token)).toEqual({ ...initial, reset: false });
    store.put('attempt', { id: 'a', sessionId: 's', status: 'pending' });
    store.put('attempt', { id: 'b', sessionId: 'other' });
    store.put('transition', { id: 't', sessionId: 's' });
    store.put('attempt', { id: 'a', sessionId: 's', status: 'unknown' });
    const changed = store.entityChanges('attempt', 's', initial.token);
    expect(changed).toEqual({ token: expect.any(String), reset: false, ids: ['a'] });
    expect(store.get('attempt', changed.ids[0])).toMatchObject({ status: 'unknown' });
    expect(store.entityChanges('attempt', 's', changed.token)).toEqual({ ...changed, ids: [] });
    expect(store.entityChanges('attempt', 'other', changed.token).reset).toBe(true);
    expect(store.entityChanges('transition', 's', changed.token).reset).toBe(true);
    expect(store.entityChanges('custom', 's').reset).toBe(true);
    expect(store.entityChanges('attempt', 's', 'invalid').reset).toBe(true);
  }));

  it('ignores event/request/unsupported writes and unchanged immutable observations', () => withStore(store => {
    const value = { id: 'o', sessionId: 's', value: 1 };
    store.put('observation', value);
    const before = store.entityChanges('observation', 's');
    store.put('observation', { ...value });
    store.put('session', { id: 's' });
    store.event('s', 'read', {}); store.recordRequest('s', 'request', 'attempt', '{}');
    expect(() => store.put('observation', { ...value, value: 2 })).toThrow('Observations cannot be overwritten');
    expect(() => store.put('attempt', { id: 'o', sessionId: 's' })).toThrow('ID already belongs');
    expect(store.entityChanges('observation', 's', before.token)).toEqual({ ...before, reset: false });
  }));

  it('retains committed transaction deltas and invalidates every pre-rollback cursor', () => withStore(store => {
    const before = store.entityChanges('attempt', 's');
    store.transaction(() => store.put('attempt', { id: 'a', sessionId: 's', status: 'completed' }));
    expect(store.entityChanges('attempt', 's', before.token)).toMatchObject({ reset: false, ids: ['a'] });
    const committed = store.entityChanges('attempt', 's');
    let inside = '';
    expect(() => store.transaction(() => {
      store.put('attempt', { id: 'a', sessionId: 's', status: 'unknown' });
      inside = store.entityChanges('attempt', 's').token;
      throw Error('rollback');
    })).toThrow('rollback');
    expect(store.get('attempt', 'a')).toMatchObject({ status: 'completed' });
    const after = store.entityChanges('attempt', 's', committed.token);
    expect(after.reset).toBe(true); expect(after.token).not.toBe(committed.token); expect(after.token).not.toBe(inside);
    expect(store.entityChanges('attempt', 's', inside).reset).toBe(true);
    expect(store.entityChanges('attempt', 's', after.token)).toEqual({ ...after, reset: false });
  }));

  it('invalidates nested rollback cursors even when the outer transaction commits', () => withStore(store => {
    const before = store.entityChanges('attempt', 's');
    store.transaction(() => {
      store.put('attempt', { id: 'outer', sessionId: 's' });
      expect(() => store.transaction(() => {
        store.put('attempt', { id: 'inner', sessionId: 's' });
        throw Error('inner rollback');
      })).toThrow('inner rollback');
      store.put('attempt', { id: 'last', sessionId: 's' });
    });
    expect(store.get('attempt', 'inner')).toBeUndefined();
    expect(store.entityChanges('attempt', 's', before.token).reset).toBe(true);
    expect(store.list('attempt', 's')).toEqual([{ id: 'outer', sessionId: 's' }, { id: 'last', sessionId: 's' }]);
  }));

  it('requires a full reread once a consumer falls behind the bounded journal', () => withStore(store => {
    const before = store.entityChanges('attempt', 's');
    for (let i = 0; i < 4097; i++) store.put('attempt', { id: 'reused', sessionId: 's', version: i });
    const after = store.entityChanges('attempt', 's', before.token);
    expect(after).toMatchObject({ reset: true, ids: [] });
    expect(store.list('attempt', 's')).toEqual([{ id: 'reused', sessionId: 's', version: 4096 }]);
    store.put('attempt', { id: 'next', sessionId: 's' });
    expect(store.entityChanges('attempt', 's', after.token)).toMatchObject({ reset: false, ids: ['next'] });
  }));
});

it('the bounded journal rejects cross-instance cursors and retains exactly its capacity of deltas', () => {
  const journal = new BoundedEntityChanges(2), other = new BoundedEntityChanges(2);
  const before = journal.changes('attempt', 's');
  journal.record('attempt', 's', 'a'); journal.record('attempt', 's', 'b');
  expect(journal.changes('attempt', 's', before.token)).toMatchObject({ reset: false, ids: ['a', 'b'] });
  journal.record('attempt', 's', 'c');
  expect(journal.changes('attempt', 's', before.token).reset).toBe(true);
  const current = journal.changes('attempt', 's');
  expect(other.changes('attempt', 's', current.token).reset).toBe(true);
  journal.invalidate();
  expect(journal.changes('attempt', 's', current.token).reset).toBe(true);
  expect(() => new BoundedEntityChanges(0)).toThrow(RangeError);
});

it('SQLite detects direct updates and deletes even when followed by known writes', () => withSqlite(store => {
  store.put('observation', { id: 'o', sessionId: 's', value: 1 });
  const before = store.entityChanges('observation', 's');
  store.db.prepare('UPDATE entities SET json=? WHERE id=?').run(JSON.stringify({ id: 'o', sessionId: 's', value: 2 }), 'o');
  store.put('attempt', { id: 'a', sessionId: 's' });
  const changed = store.entityChanges('observation', 's', before.token);
  expect(changed.reset).toBe(true); expect(store.get('observation', 'o')).toMatchObject({ value: 2 });
  store.db.prepare('DELETE FROM entities WHERE id=?').run('o');
  store.event('s', 'after delete', {});
  expect(store.entityChanges('observation', 's', changed.token).reset).toBe(true);
  expect(store.list('observation', 's')).toEqual([]);
}));

it('SQLite detects another connection commit without relying on local write counts', () => withSqlite((store, directory) => {
  const other = new SqliteStore(directory);
  try {
    store.put('attempt', { id: 'a', sessionId: 's', status: 'completed' });
    const before = store.entityChanges('attempt', 's');
    other.put('attempt', { id: 'a', sessionId: 's', status: 'unknown' });
    const changed = store.entityChanges('attempt', 's', before.token);
    expect(changed.reset).toBe(true); expect(store.get('attempt', 'a')).toMatchObject({ status: 'unknown' });
    other.db.prepare('DELETE FROM entities WHERE id=?').run('a');
    expect(store.entityChanges('attempt', 's', changed.token).reset).toBe(true);
    expect(store.list('attempt', 's')).toEqual([]);
  } finally { other.close(); }
}));

it('SQLite detects trigger side effects and direct schema changes', () => withSqlite(store => {
  store.put('attempt', { id: 'a', sessionId: 's' });
  const before = store.entityChanges('attempt', 's');
  store.db.exec("CREATE TRIGGER delete_attempt AFTER INSERT ON events BEGIN DELETE FROM entities WHERE id='a'; END;");
  const schema = store.entityChanges('attempt', 's', before.token);
  expect(schema.reset).toBe(true);
  store.event('s', 'trigger', {});
  expect(store.entityChanges('attempt', 's', schema.token).reset).toBe(true);
  expect(store.get('attempt', 'a')).toBeUndefined();
}));

it('SQLite prevents facts queried in raw transactions from surviving rollback or commit', () => withSqlite(store => {
  store.put('attempt', { id: 'a', sessionId: 's', status: 'completed' });
  const before = store.entityChanges('attempt', 's');
  let speculative = '';
  expect(() => store.db.transaction(() => {
    store.put('attempt', { id: 'a', sessionId: 's', status: 'unknown' });
    const inside = store.entityChanges('attempt', 's', before.token);
    expect(inside.reset).toBe(true); expect(inside.cacheable).toBe(false); speculative = inside.token;
    throw Error('raw rollback');
  })()).toThrow('raw rollback');
  const outside = store.entityChanges('attempt', 's', speculative);
  expect(outside.reset).toBe(true); expect(outside.cacheable).toBeUndefined();
  expect(store.get('attempt', 'a')).toMatchObject({ status: 'completed' });
  store.db.transaction(() => { speculative = store.entityChanges('attempt', 's').token; })();
  expect(store.entityChanges('attempt', 's', speculative).reset).toBe(true);
}));

it('SQLite cursors do not survive reopening a store instance', () => withSqlite((store, directory) => {
  const before = store.entityChanges('attempt', 's');
  const reopened = new SqliteStore(directory);
  try { expect(reopened.entityChanges('attempt', 's', before.token).reset).toBe(true); }
  finally { reopened.close(); }
}));
