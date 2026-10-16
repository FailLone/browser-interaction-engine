import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evidenceRetentionSchema, type EvidenceRetentionPolicy } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { RetainedPersistence } from '@interaction/storage-retained';

const policy = (options: Partial<EvidenceRetentionPolicy> = {}) => evidenceRetentionSchema.parse({ mode: 'persistent', ttlMs: options.mode && options.mode !== 'persistent' ? 60000 : 0, maxBytes: 10_000_000, maxObservations: 10000, ...options });
const artifact = (bytes: number, fill = 1) => ({ data: new Uint8Array(bytes).fill(fill), mediaType: 'text/plain' });
async function capture(store: RetainedPersistence, id: string, bytes: number, p = policy(), sessionId = 's') {
  await store.evidence.beginObservation({ sessionId, observationId: id, policy: p });
  await store.evidence.put(id, artifact(bytes));
  await store.evidence.endObservation(id, true);
}
async function withStore(kind: 'memory' | 'sqlite', fn: (raw: MemoryStore | SqliteStore, retained: RetainedPersistence, directory?: string) => Promise<void>) {
  const directory = kind === 'sqlite' ? mkdtempSync(join(tmpdir(), 'retention-accounting-')) : undefined;
  const raw = directory ? new SqliteStore(directory) : new MemoryStore();
  const store = new RetainedPersistence(raw, { sweepIntervalMs: 0 });
  try { await fn(raw, store, directory); }
  finally { await store.evidence.flush(); store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); }
}

it.each([100, 1000])('keeps warm artifact writes independent of %i retained observations', async count => {
  await withStore('memory', async (raw, store) => {
    for (let i = 0; i < count; i++) await capture(store, `history-${i}`, 10);
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'current', policy: policy() });
    await store.evidence.put('first', artifact(12));
    const reads = vi.spyOn(raw, 'get'), lists = vi.spyOn(raw, 'list');
    await store.evidence.put('second', artifact(13));
    const measured = { history: count, gets: reads.mock.calls.length, lists: lists.mock.calls.length };
    expect(measured.lists).toBe(0); expect(measured.gets).toBeLessThanOrEqual(6);
    reads.mockRestore(); lists.mockRestore();
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: count * 10 + 25, retainedObservations: count + 1 });
    console.info(JSON.stringify({ retentionWarmPut: measured }));
  });
});

it('reads each session listing once per capacity check when the backing store has no change feed', async () => {
  const raw = new MemoryStore(); Object.defineProperty(raw, 'entityChanges', { value: undefined });
  const store = new RetainedPersistence(raw, { sweepIntervalMs: 0 });
  try {
    for (let i = 0; i < 100; i++) await capture(store, `history-${i}`, 10);
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'current', policy: policy() });
    const lists = vi.spyOn(raw, 'list'), reads = vi.spyOn(raw, 'get');
    await store.evidence.put('new', artifact(11));
    expect(lists.mock.calls.map(([kind]) => kind)).toEqual(['evidence-entry', 'evidence-retention']);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(4);
    lists.mockRestore(); reads.mockRestore();
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 1011, retainedObservations: 101 });
  } finally { await store.evidence.flush(); store.close(); }
});

it('accounts for overwrites, shared memory bytes and release without counting an empty manifest', async () => {
  await withStore('memory', async (_raw, store) => {
    const p = policy({ mode: 'cache' });
    await capture(store, 'one', 400, p); await capture(store, 'two', 400, p);
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 800, memoryBytes: 400, retainedObservations: 2 });
    await store.evidence.put('one', artifact(300, 2));
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 700, memoryBytes: 700 });
    await store.evidence.release('s', 'one');
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'empty', policy: p });
    await store.evidence.endObservation('empty', true);
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 400, memoryBytes: 400, retainedObservations: 1 });
    await store.evidence.release('s', 'two');
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 0, memoryBytes: 0, retainedObservations: 0 });
  });
});

it('does not subtract a replacement that expires during capacity validation', async () => {
  let now = 0;
  const raw = new MemoryStore(), store = new RetainedPersistence(raw, { now: () => now, sweepIntervalMs: 0 });
  try {
    const p = policy({ ttlMs: 10, maxBytes: 1024 });
    await capture(store, 'old', 400, p); await capture(store, 'pinned', 600, p);
    await store.evidence.pin(['pinned'], 'owner'); now = 11;
    await expect(store.evidence.put('old', artifact(500))).rejects.toMatchObject({ code: 'EVIDENCE_BUDGET_EXHAUSTED' });
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 600, retainedObservations: 1 });
    expect(await store.evidence.availability('old')).toMatchObject({ status: 'expired' });
  } finally { await store.evidence.flush(); store.close(); }
});

it('does not release a shared memory reference twice when capacity evicts the artifact being replaced', async () => {
  await withStore('memory', async (_raw, store) => {
    const p = policy({ mode: 'cache', maxBytes: 1024 });
    await capture(store, 'old', 400, p); await capture(store, 'second', 500, p);
    await capture(store, 'other-session', 400, p, 'other');
    await store.evidence.pin(['other-session'], 'owner');
    await store.evidence.put('old', artifact(700, 2));
    expect((await store.evidence.get('other-session'))?.data).toEqual(artifact(400).data);
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 700, retainedObservations: 1, memoryBytes: 1100 });
  });
});

for (const kind of ['memory', 'sqlite'] as const) {
  it(`${kind} invalidates counts after rollback and keeps external pin protection fresh`, async () => {
    await withStore(kind, async (raw, store, directory) => {
      const p = policy({ mode: 'cache', maxBytes: 1024, maxObservations: 2 });
      await capture(store, 'old', 400, p); await capture(store, 'current', 400, p);
      raw.put('session', { id: 's', status: 'idle', currentObservationId: 'current' });
      // Warm the accounting projection, then roll back a metadata change.
      await store.evidence.put('current', artifact(400));
      expect(() => raw.transaction(() => {
        const entry = raw.require<{ id: string; sessionId: string; status: string }>('evidence-entry', 'evidence:old');
        raw.put('evidence-entry', { ...entry, status: 'released' }); throw Error('rollback');
      })).toThrow('rollback');
      const external = directory ? new SqliteStore(directory) : raw;
      try {
        const group = external.require<{ id: string; sessionId: string; pins: string[] }>('evidence-retention', 'retention:old');
        external.put('evidence-retention', { ...group, pins: ['external-owner'] });
        await store.evidence.beginObservation({ sessionId: 's', observationId: 'third', policy: p });
        await expect(store.evidence.put('third', artifact(400, 2))).rejects.toMatchObject({ code: 'EVIDENCE_BUDGET_EXHAUSTED' });
        expect(await store.evidence.availability('old')).toMatchObject({ status: 'available' });
        expect(await store.evidence.availability('current')).toMatchObject({ status: 'available' });
        external.put('evidence-retention', { ...group, pins: [] });
        await store.evidence.put('third', artifact(400, 2));
        expect(await store.evidence.availability('old')).toMatchObject({ status: 'evicted' });
        expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 800, memoryBytes: 800, retainedObservations: 2 });
      } finally { if (external !== raw) external.close(); }
    });
  });
}

it('SQLite invalidates cached bytes after direct SQL and another connection changes entry metadata', async () => {
  await withStore('sqlite', async (backing, store, directory) => {
    const raw = backing as SqliteStore, p = policy({ maxBytes: 1024 });
    await capture(store, 'old', 600, p);
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'new', policy: p });
    await store.evidence.put('first', artifact(100));
    const other = new SqliteStore(directory!);
    try {
      const entry = other.require<{ id: string; sessionId: string; bytes: number }>('evidence-entry', 'evidence:old');
      other.put('evidence-entry', { ...entry, bytes: 900 });
      await expect(store.evidence.put('second', artifact(100))).rejects.toMatchObject({ code: 'EVIDENCE_BUDGET_EXHAUSTED' });
      raw.db.prepare('UPDATE entities SET json=? WHERE id=?').run(JSON.stringify({ ...entry, bytes: 600 }), entry.id);
      await store.evidence.put('second', artifact(100));
      expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 800, retainedObservations: 2 });
    } finally { other.close(); }
  });
});

it('tracks changed manifest membership and cold-rebuilds after the bounded change journal overflows', async () => {
  await withStore('memory', async (raw, store) => {
    const p = policy({ maxBytes: 1024 });
    await capture(store, 'old', 600, p);
    raw.put('evidence-entry', { id: 'evidence:orphan', sessionId: 's', observationId: 'old', bytes: 300, hash: 'unused', status: 'available' });
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'new', policy: p });
    await store.evidence.put('first', artifact(100));
    const group = raw.require<{ id: string; sessionId: string; keys: string[] }>('evidence-retention', 'retention:old');
    raw.put('evidence-retention', { ...group, keys: [...group.keys, 'orphan'] });
    await expect(store.evidence.put('second', artifact(100))).rejects.toMatchObject({ code: 'EVIDENCE_BUDGET_EXHAUSTED' });
    raw.put('evidence-retention', group);
    for (let i = 0; i < 4097; i++) raw.put('attempt', { id: 'journal-overflow', sessionId: 'elsewhere', i });
    const lists = vi.spyOn(raw, 'list');
    await store.evidence.put('second', artifact(100));
    expect(lists.mock.calls.map(([kind]) => kind)).toEqual(['evidence-entry', 'evidence-retention']); lists.mockRestore();
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 800 });
  });
});

it('keeps evidence change hints scoped without invalidating an unchanged navigation cursor', () => {
  const raw = new MemoryStore();
  const navigation = raw.entityChanges('attempt', 's'), entries = raw.entityChanges('evidence-entry', 's'), groups = raw.entityChanges('evidence-retention', 's');
  raw.put('evidence-entry', { id: 'evidence:a', sessionId: 's' });
  raw.put('evidence-retention', { id: 'retention:o', sessionId: 's' });
  raw.put('evidence-entry', { id: 'evidence:other', sessionId: 'other' });
  expect(raw.entityChanges('evidence-entry', 's', entries.token)).toMatchObject({ reset: false, ids: ['evidence:a'] });
  expect(raw.entityChanges('evidence-retention', 's', groups.token)).toMatchObject({ reset: false, ids: ['retention:o'] });
  expect(raw.entityChanges('attempt', 's', navigation.token)).toMatchObject({ reset: false, ids: [] });
});

it('fails capacity validation when the evidence snapshot keeps changing, then rebuilds after reads recover', async () => {
  await withStore('memory', async (raw, store) => {
    await capture(store, 'old', 600);
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'new', policy: policy() });
    await store.evidence.put('first', artifact(100));
    const original = raw.entityChanges!.bind(raw); let revision = 0;
    const feed = vi.spyOn(raw, 'entityChanges').mockImplementation((kind, sessionId, token?: string) => ({ ...original(kind, sessionId, token), token: `changed-${revision++}` }));
    await expect(store.evidence.put('second', artifact(100))).rejects.toMatchObject({ code: 'EVIDENCE_STATE_CHANGED' });
    expect(await raw.evidence.get('second')).toBeUndefined(); feed.mockRestore();
    const read = vi.spyOn(raw, 'get'); read.mockImplementationOnce(() => { throw Error('read failure'); });
    await expect(store.evidence.put('second', artifact(100))).rejects.toThrow('read failure'); read.mockRestore();
    await store.evidence.put('second', artifact(100));
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 800, retainedObservations: 2 });
  });
});

it('rebuilds capacity accounting on restart without replacing persistent history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retention-accounting-restart-'));
  let store = new RetainedPersistence(new SqliteStore(directory), { sweepIntervalMs: 0 });
  const p = policy({ maxBytes: 1024 });
  try {
    await capture(store, 'old', 700, p);
    await store.evidence.flush(); store.close();
    store = new RetainedPersistence(new SqliteStore(directory), { sweepIntervalMs: 0 });
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'new', policy: p });
    await expect(store.evidence.put('new', artifact(400))).rejects.toMatchObject({ code: 'EVIDENCE_BUDGET_EXHAUSTED' });
    await store.evidence.put('new', artifact(300));
    expect((await store.evidence.get('old'))?.data).toEqual(artifact(700).data);
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 1000, retainedObservations: 2 });
  } finally { await store.evidence.flush(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('does not retain an accounting projection above its item bound', async () => {
  await withStore('memory', async (raw, store) => {
    // One very large manifest exceeds the projection cap without allocating any
    // evidence bytes. Every represented entry is still counted for the quota.
    const keys = Array.from({ length: 17000 }, (_, i) => `large-${i}`);
    raw.put('evidence-retention', { id: 'retention:large', observationId: 'large', sessionId: 's', policy: policy(), createdAt: 0, keys, pins: [], committed: true });
    for (const key of keys) raw.put('evidence-entry', { id: `evidence:${key}`, sessionId: 's', observationId: 'large', bytes: 1, hash: 'unused', status: 'available' });
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'new', policy: policy() });
    await store.evidence.put('first', artifact(100));
    const lists = vi.spyOn(raw, 'list');
    await store.evidence.put('second', artifact(100));
    expect(lists.mock.calls.map(([kind]) => kind)).toEqual(['evidence-entry', 'evidence-retention']); lists.mockRestore();
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 17200, retainedObservations: 2 });
  });
});

it('releases a complete observation with one batch and updates statuses only after successful deletion', async () => {
  await withStore('memory', async (raw, store) => {
    await capture(store, 'one', 400);
    await store.evidence.put('another', artifact(100)); // Legacy artifact is outside the group.
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'two', policy: policy() });
    await store.evidence.put('a', artifact(100)); await store.evidence.put('b', artifact(200));
    await store.evidence.endObservation('two', true);
    const batch = vi.spyOn(raw.evidence, 'deleteMany'), single = vi.spyOn(raw.evidence, 'delete');
    await store.evidence.release('s', 'two');
    expect(batch).toHaveBeenCalledExactlyOnceWith(['a', 'b']); expect(single).not.toHaveBeenCalled();
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 400 });
    expect(await raw.evidence.get('another')).toBeDefined();
    expect(raw.require<{ status: string }>('evidence-entry', 'evidence:a').status).toBe('released');
  });
});

it('keeps partial batch failure explicit and supports legacy per-key delete without a batch API', async () => {
  for (const batch of [true, false]) await withStore('memory', async (raw, store) => {
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'one', policy: policy() });
    await store.evidence.put('a', artifact(100)); await store.evidence.put('b', artifact(200));
    await store.evidence.endObservation('one', true);
    const remove = raw.evidence.delete!.bind(raw.evidence);
    if (batch) raw.evidence.deleteMany = async keys => { await remove(keys[0]); throw Error('partial storage failure'); };
    else {
      Object.defineProperty(raw.evidence, 'deleteMany', { value: undefined });
      raw.evidence.delete = async key => { if (key === 'b') throw Error('partial storage failure'); await remove(key); };
    }
    await expect(store.evidence.release('s', 'one')).rejects.toThrow('partial storage failure');
    expect(raw.require<{ status: string }>('evidence-entry', 'evidence:a').status).toBe(batch ? 'available' : 'released');
    expect(raw.require<{ status: string }>('evidence-entry', 'evidence:b').status).toBe('available');
    expect(await store.evidence.availability('a')).toMatchObject({ status: batch ? 'missing' : 'released' });
    expect(await store.evidence.availability('b')).toMatchObject({ status: 'available' });
  });
});
