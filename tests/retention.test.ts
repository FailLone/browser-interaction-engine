import { it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { RetainedPersistence } from '@interaction/storage-retained';
import { evidenceRetentionSchema, type Session, type InteractionScope } from '@interaction/core';

it('bounds cache storage, deduplicates bytes and protects current observations, scopes and explicit pins', async () => {
  let clock = 0; const raw = new MemoryStore(); const store = new RetainedPersistence(raw, { now: () => clock, sweepIntervalMs: 0 });
  const policy = evidenceRetentionSchema.parse({ mode: 'cache', ttlMs: 100, maxBytes: 1400, maxObservations: 2 });
  const data = new Uint8Array(600).fill(7);
  const capture = async (id: string) => { await store.evidence.beginObservation({ sessionId: 's', observationId: id, policy }); await store.evidence.put(`${id}.png`, { data, mediaType: 'image/png' }); store.put('session', { id: 's', status: 'idle', currentObservationId: id } as Session); await store.evidence.endObservation(id, true); };
  try {
    await capture('one'); await store.evidence.pin(['one.png'], 'pin'); await capture('two');
    expect(await raw.evidence.get('one.png')).toBeUndefined();
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 1200, memoryBytes: 600, retainedObservations: 2 });
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'three', policy });
    await expect(store.evidence.put('three.png', { data, mediaType: 'image/png' })).rejects.toMatchObject({ code: 'EVIDENCE_BUDGET_EXHAUSTED' });
    await store.evidence.endObservation('three', false);
    await store.evidence.unpin('pin');
    raw.put('scope', { id: 'scope', sessionId: 's', beforeId: 'one', status: 'open' } as InteractionScope);
    clock = 200; await store.evidence.sweep(); expect((await store.evidence.availability('one.png')).status).toBe('available');
    await expect(store.evidence.release('s', 'one')).rejects.toMatchObject({ code: 'EVIDENCE_PINNED' });
    raw.put('scope', { id: 'scope', sessionId: 's', beforeId: 'one', status: 'closed' } as InteractionScope);
    await store.evidence.sweep(); expect((await store.evidence.availability('one.png')).status).toBe('expired');
    expect((await store.evidence.availability('two.png')).status).toBe('available');
    store.put('session', { id: 's', status: 'stopped', currentObservationId: 'two' } as Session); await store.evidence.sweep();
    expect(await store.evidence.stats('s')).toMatchObject({ logicalBytes: 0, memoryBytes: 0 });
  } finally { await store.evidence.flush(); store.close(); }
});

it('evicts unprotected history by capacity and does not implicitly extend a transient delivery window', async () => {
  let clock = 0; const raw = new MemoryStore(); const store = new RetainedPersistence(raw, { now: () => clock, sweepIntervalMs: 0 });
  const policy = evidenceRetentionSchema.parse({ mode: 'transient', ttlMs: 50, maxBytes: 1024, maxObservations: 1 });
  try {
    for (const id of ['one', 'two']) { await store.evidence.beginObservation({ sessionId: 's', observationId: id, policy }); await store.evidence.put(id, { data: new Uint8Array(800), mediaType: 'text/plain' }); await store.evidence.endObservation(id, true); }
    expect((await store.evidence.availability('one')).status).toBe('evicted');
    await expect(store.evidence.pin(['two'], 'pin')).rejects.toMatchObject({ code: 'EVIDENCE_RETENTION_UNSUPPORTED' });
    clock = 51; expect((await store.evidence.availability('two')).status).toBe('expired');
    expect((await store.evidence.stats('s')).memoryBytes).toBe(0);
  } finally { await store.evidence.flush(); store.close(); }
});

it('starts the transient delivery window after a slow observation commits', async () => {
  let clock = 0; const store = new RetainedPersistence(new MemoryStore(), { now: () => clock, sweepIntervalMs: 0 });
  try {
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'slow', policy: evidenceRetentionSchema.parse({ mode: 'transient', ttlMs: 50 }) });
    await store.evidence.put('slow.json', { data: new TextEncoder().encode('{}'), mediaType: 'application/json' });
    clock = 100; await store.evidence.endObservation('slow', true);
    expect((await store.evidence.availability('slow.json')).status).toBe('available');
    clock = 151; expect((await store.evidence.availability('slow.json')).status).toBe('expired');
  } finally { await store.evidence.flush(); store.close(); }
});

it('compresses and deduplicates persistent blocks, keeps legacy files readable, and only collects unreferenced blocks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-blobs-')); const store = new SqliteStore(directory);
  const content = new TextEncoder().encode(JSON.stringify({ text: 'repeat '.repeat(10000) }));
  try {
    await store.evidence.put('a.json', { data: content, mediaType: 'application/json' });
    const first = readdirSync(join(directory, 'evidence/blobs'));
    await store.evidence.put('b.json', { data: content, mediaType: 'application/json' });
    expect(readdirSync(join(directory, 'evidence/blobs'))).toEqual(first);
    const bytes = first.reduce((n, name) => n + statSync(join(directory, 'evidence/blobs', name)).size, 0); expect(bytes).toBeLessThan(content.length / 10);
    expect((await store.evidence.get('a.json'))?.data).toEqual(content);
    await store.evidence.delete!('a.json'); expect((await store.evidence.get('b.json'))?.data).toEqual(content);
    await store.evidence.delete!('b.json'); expect(readdirSync(join(directory, 'evidence/blobs'))).toEqual([]);
    writeFileSync(join(directory, 'evidence/old.png'), new Uint8Array([1, 2, 3]));
    expect((await store.evidence.get('old.png'))?.mediaType).toBe('image/png');
    expect([...((await store.evidence.get('old.png'))!.data)]).toEqual([1, 2, 3]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('persists retention manifests across restart and records lost memory snapshots without substituting disk data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retention-restart-'));
  let store = new RetainedPersistence(new SqliteStore(directory), { sweepIntervalMs: 0 });
  try {
    for (const mode of ['cache', 'persistent'] as const) {
      await store.evidence.beginObservation({ sessionId: mode, observationId: mode, policy: evidenceRetentionSchema.parse({ mode }) });
      await store.evidence.put(`${mode}.json`, { data: new TextEncoder().encode(mode), mediaType: 'application/json' }); await store.evidence.endObservation(mode, true);
    }
    expect(readdirSync(join(directory, 'evidence')).some(n => n.startsWith('cache.'))).toBe(false);
    await store.evidence.flush(); store.close(); store = new RetainedPersistence(new SqliteStore(directory), { sweepIntervalMs: 0 });
    expect(await store.evidence.availability('cache.json')).toMatchObject({ status: 'not_retained', reason: 'process_restarted' });
    expect(await store.evidence.availability('persistent.json')).toMatchObject({ status: 'available', durability: 'persistent' });
    await store.evidence.release('persistent', 'persistent'); expect((await store.evidence.availability('persistent.json')).status).toBe('released');
  } finally { await store.evidence.flush(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('reads and sweeps without rescanning permanent history, preserving TTL and finite pins across restart', async () => {
  const directory=mkdtempSync(join(tmpdir(),'retention-expiry-index-'));let clock=0;
  let raw=new SqliteStore(directory),store=new RetainedPersistence(raw,{now:()=>clock,sweepIntervalMs:0});
  const capture=async(id:string,ttlMs=0)=>{
    await store.evidence.beginObservation({sessionId:id,observationId:id,policy:evidenceRetentionSchema.parse({mode:'persistent',ttlMs})});
    await store.evidence.put(id,{data:new Uint8Array([1,2,3]),mediaType:'image/png'});await store.evidence.endObservation(id,true);
  };
  try {
    for(let i=0;i<40;i++)await capture(`history-${i}`);
    await capture('finite',10);await store.evidence.pin(['finite'],'reservation',{expiresAt:20});
    await store.evidence.flush();store.close();
    raw=new SqliteStore(directory);store=new RetainedPersistence(raw,{now:()=>clock,sweepIntervalMs:0});
    const lists=vi.spyOn(raw,'list'),reads=vi.spyOn(raw,'get');
    expect(await store.evidence.get('history-0')).toBeDefined();await store.evidence.sweep();
    expect(lists.mock.calls.filter(([kind])=>kind==='evidence-retention')).toHaveLength(0);
    expect(new Set(reads.mock.calls.filter(([kind])=>kind==='evidence-retention').map(([,id])=>id))).toEqual(new Set(['retention:history-0','retention:finite']));
    lists.mockRestore();reads.mockRestore();
    // A finite pin added after restart must enter the expiry index even with TTL 0.
    await store.evidence.pin(['history-1'],'short',{expiresAt:5});clock=6;await store.evidence.sweep();
    expect(raw.require<{pins:string[]}>('evidence-retention','retention:history-1').pins).toEqual([]);
    expect(await store.evidence.get('history-1')).toBeDefined();
    clock=11;expect((await store.evidence.availability('finite')).status).toBe('available');
    clock=21;expect((await store.evidence.availability('finite')).status).toBe('expired');
    expect(await raw.evidence.get('finite')).toBeUndefined();
    expect(await store.evidence.get('history-0')).toBeDefined();
  } finally {await store.evidence.flush();store.close();rmSync(directory,{recursive:true,force:true});}
});

it('expires finite pins independently and drops abandoned reservations without an inspection process', async () => {
  let clock = 0; const store = new RetainedPersistence(new MemoryStore(), { now: () => clock, sweepIntervalMs: 0 });
  try {
    await store.evidence.beginObservation({ sessionId: 's', observationId: 'o', policy: evidenceRetentionSchema.parse({ mode: 'cache', ttlMs: 10 }) });
    await store.evidence.put('o.json', { data: new TextEncoder().encode('saved'), mediaType: 'text/plain' });
    await store.evidence.pin(['o.json'], 'short', { expiresAt: 20 }); await store.evidence.pin(['o.json'], 'long', { expiresAt: 40 });
    await store.evidence.endObservation('o', true);
    clock = 25; expect((await store.evidence.stats('s')).protected[0].owners).toEqual(['long']);
    expect((await store.evidence.availability('o.json')).status).toBe('available');
    clock = 41; expect((await store.evidence.availability('o.json')).status).toBe('expired');
    await expect(store.evidence.pin(['o.json'], 'late', { expiresAt: 100 })).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
    expect((await store.evidence.stats('s')).memoryBytes).toBe(0);
  } finally { await store.evidence.flush(); store.close(); }
});
