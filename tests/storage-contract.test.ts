import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverStore, sessionSchema, type Persistence, type ActionAttempt, type Session } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';

for (const kind of ['memory', 'sqlite']) describe(`${kind} persistence contract`, () => {
  async function withStore(fn: (store: Persistence) => Promise<void> | void) {
    const directory = kind === 'sqlite' ? mkdtempSync(join(tmpdir(), 'storage-contract-')) : undefined;
    const store = directory ? new SqliteStore(directory) : new MemoryStore();
    try { await fn(store); } finally { store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); }
  }
  it('isolates read/write values and refuses observation overwrites', () => withStore(store => {
    const source = { id: 'o', sessionId: 's', value: [1] }; store.put('observation', source); source.value.push(2);
    const read = store.require<typeof source>('observation', 'o'); read.value.push(3);
    expect(store.require<typeof source>('observation', 'o').value).toEqual([1]);
    expect(() => store.put('observation', source)).toThrow('Observations cannot be overwritten');
  }));
  it('rolls back entity, request and event writes as one transaction', () => withStore(store => {
    expect(() => store.transaction(() => { store.put('state', { id: 'x', sessionId: 's' }); store.recordRequest('s', 'r', 'a', '{}'); store.event('s', 'intent', {}); throw new Error('rollback'); })).toThrow('rollback');
    expect(store.get('state', 'x')).toBeUndefined(); expect(store.request('s', 'r')).toBeUndefined(); expect(store.events('s')).toEqual([]);
    const first = store.event('s', 'first', {}); store.event('other', 'unrelated', {}); const last = store.event('s', 'last', {});
    expect(store.events('s', first.sequence).map(e => e.sequence)).toEqual([last.sequence]);
  }));
  it('keeps interrupted-result recovery independent of the persistence implementation', () => withStore(store => {
    store.put('session', { id: 's', options: sessionSchema.parse({}), status: 'running' } as Session);
    store.put('attempt', { id: 'a', sessionId: 's', status: 'executing' } as ActionAttempt);
    store.recordRequest('s', 'r', 'a', '{}'); recoverStore(store);
    expect(store.require<Session>('session', 's').status).toBe('paused'); expect(store.require<ActionAttempt>('attempt', 'a').status).toBe('unknown');
    expect(store.request('s', 'r')?.attemptId).toBe('a');
  }));
  it('stores binary evidence without exposing mutable internal buffers', () => withStore(async store => {
    const data = new Uint8Array([1, 2, 3]); await store.evidence.put('frame.png', { data, mediaType: 'image/png' }); data[0] = 9;
    const first = await store.evidence.get('frame.png'); expect(first?.data[0]).toBe(1); first!.data[0] = 8;
    expect((await store.evidence.get('frame.png'))?.data[0]).toBe(1); expect(await store.evidence.get('missing.png')).toBeUndefined();
  }));
});
