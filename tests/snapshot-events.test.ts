import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserEngine, type SnapshotEventData, type SubscriptionGap, type Checkpoint } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { InteractionClient } from '@interaction/client';
import { fixtureServer, act } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';
let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); }); afterAll(async () => { await fixture.server.close(); });
const options = () => ({ url: `${fixture.url}/evidence.html`, headless: true, settleMs: 50, observeTimeoutMs: 600 });

it('delivers isolated full snapshots without writing detailed evidence to disk or inflating the durable event log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'transient-event-')); let clock = 1000;
  const engine = new BrowserEngine({ persistence: new SqliteStore(dir), retention: { now: () => clock, sweepIntervalMs: 0 } });
  try {
    const s = await engine.createSession({ ...options(), evidenceRetention: { mode: 'transient', ttlMs: 100 } });
    const o = engine.observation(s.id); let delivered!: SnapshotEventData;
    let received!: () => void; const ready = new Promise<void>(r => { received = r; });
    const sub = engine.subscribeEvents(s.id, event => { if (event.type === 'observation.created') { delivered = event.data as SnapshotEventData; received(); } });
    await ready; sub.close(); await sub.done;
    expect(delivered.evidence?.details?.snapshot?.dom?.html).toContain('订单金额');
    expect(delivered.evidence?.artifacts[0].encoding).toBe('base64');
    expect(Buffer.from(delivered.evidence!.artifacts[0].data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    delivered.evidence!.details!.observation.controls[0].name = 'subscriber edit';
    const event = engine.store.events(s.id).find(e => e.type === 'observation.created')!;
    expect(event.data).not.toHaveProperty('evidence');
    expect(((await engine.projectEvent(event)).data as SnapshotEventData).evidence?.details?.observation.controls[0].name).toBe('订单金额');
    expect(readdirSync(dir)).not.toContain('evidence');
    clock = 1101; await engine.store.evidence.sweep();
    expect((await engine.observationDetails(s.id, o.id)).availability.details.status).toBe('expired');
    expect((await engine.observationDetails(s.id, o.id)).snapshot).toBeUndefined();
    expect(delivered.evidence!.details!.snapshot?.dom?.nodes.length).toBeGreaterThan(0);
    expect(engine.observation(s.id, o.id).controls[0].name).toBe('订单金额');
    expect((await engine.evidenceStats(s.id)).memoryBytes).toBe(0);
  } finally { await engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('reports slow subscribers without affecting other subscribers or committed execution', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await engine.createSession({ ...options(), evidenceRetention: { mode: 'cache' } });
    let gap: SubscriptionGap | undefined;
    const blocked = engine.subscribeEvents(s.id, () => new Promise(() => {}), { consumerTimeoutMs: 20, onGap: value => { gap = value; } });
    await blocked.done; expect(gap?.code).toBe('SUBSCRIPTION_GAP'); expect(gap?.lastDelivered).toBe(0);
    const event = engine.store.events(s.id).find(e => e.type === 'observation.created')!;
    const limited = await engine.projectEvent(event, 'inline', 1024);
    expect((limited.data as SnapshotEventData).evidence?.gaps.some(g => g.code === 'SNAPSHOT_DELIVERY_LIMIT')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify((limited.data as SnapshotEventData).evidence))).toBeLessThanOrEqual(1024);
    const result = await act(engine, s.id, '订单金额', 'fill', '22'); expect(result.status).toBe('succeeded');
    expect((await engine.projectEvent(engine.store.events(s.id).find(e => e.type === 'action.completed')!)).data).not.toHaveProperty('evidence');
  } finally { await engine.close(); }
});

it('streams full snapshots over SSE with durable cursors and exposes retention status over HTTP', async () => {
  let clock = 0; const engine = new BrowserEngine({ persistence: new MemoryStore(), retention: { now: () => clock, sweepIntervalMs: 0 } });
  const app = await createServer(engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${(app.server.address() as any).port}`);
  try {
    const s = await client.createSession({ ...options(), evidenceRetention: { mode: 'cache', ttlMs: 100 } });
    const controller = new AbortController(); let sequence = 0;
    for await (const event of client.events(s.id, 0, controller.signal, { delivery: 'inline' })) {
      if (event.type === 'observation.created') { expect((event.data as SnapshotEventData).evidence?.details?.snapshot?.dom?.nodes.length).toBeGreaterThan(0); sequence = event.sequence; controller.abort(); break; }
    }
    const next = new AbortController();
    for await (const event of client.events(s.id, sequence, next.signal, { delivery: 'hybrid' })) { expect(event.sequence).toBeGreaterThan(sequence); next.abort(); break; }
    const o = await client.observation(s.id); await client.pinEvidence(s.id, o.id, 'review');
    await client.command(s.id, { type: 'stop' }); clock = 101;
    expect((await client.observationDetails(s.id, o.id)).availability.details.status).toBe('available');
    await client.unpinEvidence(s.id, 'review');
    expect((await client.observationDetails(s.id, o.id)).availability.details.status).toBe('expired');
    expect((await client.evidenceStats(s.id)).memoryBytes).toBe(0);
    expect((await app.inject(`/v1/sessions/${s.id}/events?delivery=bad`)).statusCode).toBe(400);
  } finally { await app.close(); await engine.close(); }
});

it('uses explicitly retained evidence for checkpoint verification and marks lost process memory unverified after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoint-evidence-')); let clock = 0;
  let engine = new BrowserEngine({ persistence: new SqliteStore(dir), retention: { now: () => clock, sweepIntervalMs: 0 } });
  try {
    const s = await engine.createSession({ ...options(), evidenceRetention: { mode: 'cache', ttlMs: 100 } });
    const pendingAction = act(engine, s.id, '订单金额', 'fill', '12');
    const pendingCheckpoint = engine.command(s.id, { type: 'createCheckpoint', name: 'pinned', retainEvidence: true });
    const [attempt, cp] = await Promise.all([pendingAction, pendingCheckpoint]) as [Awaited<ReturnType<typeof act>>, Checkpoint];
    expect(cp.observationId).toBe(attempt.afterId);
    expect(cp.evidenceKeys).toEqual(Object.values(engine.observation(s.id, cp.observationId).evidence!.artifacts).map(a => a!.key));
    expect(cp.evidenceKeys?.length).toBeGreaterThan(0);
    await act(engine, s.id, '订单金额', 'fill', '30'); clock = 101; await engine.store.evidence.sweep();
    expect((await engine.observationDetails(s.id, cp.observationId)).availability.details.status).toBe('available');
    await engine.close(); engine = new BrowserEngine({ persistence: new SqliteStore(dir), retention: { now: () => clock, sweepIntervalMs: 0 } });
    const count = engine.session(s.id).actionCount; const result = await engine.reachCheckpoint(s.id, cp.id);
    expect(result.status).toBe('UNVERIFIED'); expect(result.checks.some(c => c.name.startsWith('retained-evidence:') && c.result === 'unknown')).toBe(true);
    expect(engine.session(s.id).actionCount).toBe(count);
  } finally { await engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('returns verified checkpoints with persistent evidence after restart and preserves facts when evidence capacity is exhausted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'persistent-event-'));
  let engine = new BrowserEngine({ persistence: new SqliteStore(dir), retention: { sweepIntervalMs: 0 } });
  try {
    const s = await engine.createSession({ ...options(), evidenceRetention: { mode: 'persistent' } });
    const cp = await engine.command(s.id, { type: 'createCheckpoint', name: 'durable', retainEvidence: true }) as Checkpoint;
    await engine.close(); engine = new BrowserEngine({ persistence: new SqliteStore(dir), retention: { sweepIntervalMs: 0 } });
    expect((await engine.reachCheckpoint(s.id, cp.id)).status).toBe('REACHED_VERIFIED');
    await engine.stop(s.id);
    const tiny = await engine.createSession({ ...options(), evidenceRetention: { mode: 'cache', maxBytes: 1024 } });
    const o = engine.observation(tiny.id);
    expect(o.controls.length).toBeGreaterThan(0); expect(o.gaps.some(g => g.critical)).toBe(true);
    expect((await engine.evidenceStats(tiny.id)).logicalBytes).toBe(0);
  } finally { await engine.close(); rmSync(dir, { recursive: true, force: true }); }
});
