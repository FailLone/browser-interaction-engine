import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hash, type Persistence } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';

for (const kind of ['memory', 'sqlite'] as const) describe(`${kind} entity ID ownership`, () => {
  function withStore(fn: (store: Persistence) => void) {
    const directory = kind === 'sqlite' ? mkdtempSync(join(tmpdir(), 'bie-id-conflict-')) : undefined;
    const store = directory ? new SqliteStore(directory) : new MemoryStore();
    try { fn(store); } finally { store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); }
  }

  it.each(['same-session', 'other-session'])('refuses a deterministic child ID owned by another kind in %s', owner => withStore(store => {
    const id = hash({ kind: 'sampling-derived-frontier', sessionId: 'same-session', key: 'current-sample' });
    const original = { id, sessionId: owner, sentinel: 'retain source evidence' };
    store.put('unrelated-evidence', original);
    expect(() => store.put('frontier', { id, sessionId: 'same-session', key: 'current-sample' })).toThrowError(expect.objectContaining({ code: 'ID_CONFLICT' }));
    expect(store.get('unrelated-evidence', id)).toEqual(original);
    expect(store.get('frontier', id)).toBeUndefined();
    expect(store.list('unrelated-evidence', owner)).toEqual([original]);
    expect(store.list('frontier', 'same-session')).toEqual([]);
  }));

  it('refuses the same kind and ID in a different session without moving or overwriting the row', () => withStore(store => {
    const original = { id: 'derived-child', sessionId: 'source-session', key: 'old-sample' };
    store.put('frontier', original);
    expect(() => store.put('frontier', { ...original, sessionId: 'other-session', key: 'new-sample' })).toThrowError(expect.objectContaining({ code: 'ID_CONFLICT' }));
    expect(store.get('frontier', original.id)).toEqual(original);
    expect(store.list('frontier', 'source-session')).toEqual([original]);
    expect(store.list('frontier', 'other-session')).toEqual([]);
  }));

  it('retains ordinary same-kind same-session updates and idempotent writes', () => withStore(store => {
    const original = { id: 'child', sessionId: 'session', status: 'pending' };
    const updated = { ...original, status: 'executed' };
    store.put('frontier', original); store.put('frontier', updated); store.put('frontier', updated);
    expect(store.get('frontier', original.id)).toEqual(updated);
    expect(store.list('frontier', 'session')).toEqual([updated]);
  }));

  it('normalizes an omitted sessionId to the entity ID without allowing ownership to be dropped', () => withStore(store => {
    store.put('session', { id: 'self', status: 'idle' });
    store.put('session', { id: 'self', sessionId: 'self', status: 'paused' });
    store.put('session', { id: 'self', status: 'finished' });
    expect(store.list('session', 'self')).toEqual([{ id: 'self', status: 'finished' }]);
    expect(() => store.put('session', { id: 'self', sessionId: 'someone-else' })).toThrowError(expect.objectContaining({ code: 'ID_CONFLICT' }));
    store.put('frontier', { id: 'child', sessionId: 'owner', status: 'pending' });
    expect(() => store.put('frontier', { id: 'child', status: 'executed' })).toThrowError(expect.objectContaining({ code: 'ID_CONFLICT' }));
    expect(store.get('frontier', 'child')).toEqual({ id: 'child', sessionId: 'owner', status: 'pending' });
  }));

  it('rolls back adjacent writes when a transaction hits an ownership conflict', () => withStore(store => {
    const original = { id: 'reserved', sessionId: 'owner', sentinel: 'original' };
    store.put('frontier', original);
    expect(() => store.transaction(() => {
      store.put('frontier', { id: 'new-child', sessionId: 'other' });
      store.event('other', 'migration.started', {});
      store.put('frontier', { ...original, sessionId: 'other' });
    })).toThrowError(expect.objectContaining({ code: 'ID_CONFLICT' }));
    expect(store.get('frontier', original.id)).toEqual(original);
    expect(store.get('frontier', 'new-child')).toBeUndefined();
    expect(store.events('other')).toEqual([]);
  }));
});
