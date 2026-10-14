import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserEngine, type EvidenceOptions, type Observation } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { InteractionClient } from '@interaction/client';
import { fixtureServer, act, pageOf } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
async function session(engine: BrowserEngine, evidence: Partial<EvidenceOptions> = {}) {
  return engine.createSession({ url: `${fixture.url}/evidence.html`, headless: true, settleMs: 60, observeTimeoutMs: 600, actionTimeoutMs: 2000, evidence });
}

it.each(['memory', 'sqlite'])('keeps detailed evidence and control meaning queryable after changes and browser shutdown (%s)', async backend => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-query-'));
  const store = backend === 'memory' ? new MemoryStore() : new SqliteStore(dir);
  const engine = new BrowserEngine({ persistence: store });
  try {
    const s = await session(engine, { fullPageScreenshot: true }); const o = engine.observation(s.id);
    const c = o.controls.find(c => c.name === '订单金额')!;
    const details = await engine.observationDetails(s.id, o.id);
    expect(details.snapshot?.dom?.page.language).toBe('zh-CN'); expect(details.snapshot?.dom?.html).toContain('data-business-field="order.amount"');
    expect(details.snapshot?.accessibility.status).toBe('captured'); expect(details.snapshot?.accessibility.text).toContain('订单金额');
    expect(details.snapshot?.runtime.network.some(n => n.url.endsWith('/capture.html') && n.status === 200)).toBe(true);
    expect(details.snapshot?.runtime.console.some(n => n.text === 'evidence fixture ready')).toBe(true);
    const control = await engine.controlDetails(s.id, o.id, c.identityId!);
    expect(control.node?.properties?.value).toBe('10'); expect(control.node?.attributes?.['data-business-field']).toBe('order.amount');
    expect(control.node?.styles?.display).toBeTruthy(); expect(control.relations.labels[0].content.text).toContain('订单金额');
    expect(control.relations['aria-describedby'][0].content.text).toContain('最小为 1');
    expect(control.form?.label).toBe('订单表单'); expect(control.businessIntent.status).toBe('unknown');
    expect(control.actions.some(a => a.kind === 'fill')).toBe(true);
    const beforeEvent = store.events(s.id).find(e => e.type === 'observation.created')!;
    const beforeImage = await engine.evidenceArtifact(s.id, o.id, 'screenshot');
    const count = engine.session(s.id).actionCount; const events = store.events(s.id).length;
    await engine.controlDetails(s.id, o.id, c.localId); await engine.regionDetails(s.id, o.id, c.region);
    expect(engine.session(s.id).actionCount).toBe(count); expect(store.events(s.id)).toHaveLength(events);
    expect(await pageOf(engine).evaluate(() => (window as any).submissions)).toBe(0);
    await act(engine, s.id, '订单金额', 'fill', '35');
    expect(engine.observation(s.id).controls.find(c => c.name === '订单金额')?.value).toBe('35');
    expect((await engine.controlDetails(s.id, o.id, c.localId)).control.value).toBe('10');
    const replay = await engine.eventContext(s.id, beforeEvent.sequence);
    expect(replay.observations[0].details.snapshot).toEqual(details.snapshot);
    await engine.stop(s.id);
    expect((await engine.observationDetails(s.id, o.id)).snapshot).toEqual(details.snapshot);
    expect((await engine.evidenceArtifact(s.id, o.id, 'screenshot')).data).toEqual(beforeImage.data);
    expect((await engine.evidenceArtifact(s.id, o.id, 'fullPageScreenshot')).data.length).toBeGreaterThan(1000);
    if (backend === 'sqlite') {
      await engine.close(); const restored = new BrowserEngine({ persistence: new SqliteStore(dir) });
      try { expect((await restored.eventContext(s.id, beforeEvent.sequence)).observations[0].details.snapshot).toEqual(details.snapshot); }
      finally { await restored.close(); }
    }
  } finally { if (backend === 'memory' || (store as SqliteStore).db.open) await engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('exposes HTTP/client queries, paginated DOM and before/after event evidence with session isolation', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() }); const app = await createServer(engine);
  await app.listen({ host: '127.0.0.1', port: 0 }); const client = new InteractionClient(`http://127.0.0.1:${(app.server.address() as any).port}`);
  try {
    const s = await client.createSession({ url: `${fixture.url}/evidence.html`, headless: true, evidence: { styles: 'all' } });
    expect((await client.evidenceCapabilities()).queriesChangePage).toBe(false);
    const o = await client.observation(s.id); const c = o.controls.find(c => c.name === '订单金额')!;
    const control = await client.controlDetails(s.id, o.id, c.identityId!); expect(control.node?.styles?.['box-sizing']).toBeTruthy();
    const region = await client.regionDetails(s.id, o.id, c.region); expect(region.controls.some(c => c.name === '计价单位')).toBe(true);
    const tree = await client.dom(s.id, o.id, { rootId: region.rootId, limit: 2 });
    expect(tree.nodes).toHaveLength(2); expect(tree.nextOffset).toBe(2);
    const next = await client.dom(s.id, o.id, { rootId: region.rootId, offset: tree.nextOffset!, limit: 2 }); expect(next.nodes[0].id).not.toBe(tree.nodes[0].id);
    const shallow = await client.dom(s.id, o.id, { rootId: region.rootId, depth: 0 }); expect(shallow.depthLimited).toBe(true);
    const attempt = await client.execute(s.id, control.actions[0].id, 'fill-once', '42');
    const event = engine.store.events(s.id).find(e => e.type === 'action.completed')!;
    const context = await client.eventContext(s.id, event.sequence);
    expect(context.observations.map(o => o.observationId)).toEqual([attempt.beforeId, attempt.afterId]);
    expect(context.observations.map(o => o.details.observation.controls.find(c => c.name === '订单金额')!.value)).toEqual(['10', '42']);
    expect((await client.evidenceArtifact(s.id, o.id)).mediaType).toContain('image/png');
    const seq = engine.store.events(s.id).length; await client.observationDetails(s.id, o.id); expect(engine.store.events(s.id)).toHaveLength(seq);
    expect((await app.inject(`/v1/sessions/other/observations/${o.id}/details`)).statusCode).toBe(404);
    expect((await app.inject(`/v1/sessions/other/events/${event.sequence}/context`)).statusCode).toBe(404);
    expect((await app.inject(`/v1/sessions/${s.id}/observations/${o.id}/dom?depth=-1`)).statusCode).toBe(400);
    expect((await app.inject(`/v1/sessions/${s.id}/observations/${o.id}/artifacts/anything`)).statusCode).toBe(400);
    const evidence = await app.inject(`/v1/sessions/${s.id}/observations/${o.id}/artifacts/details`);
    expect(evidence.headers['content-type']).toContain('application/json'); expect(evidence.headers['content-security-policy']).toContain('sandbox');
  } finally { await app.close(); await engine.close(); }
});

it('reports capture truncation, disabled and legacy evidence without ever substituting live data', async () => {
  const store = new MemoryStore(); const engine = new BrowserEngine({ persistence: store });
  try {
    const s = await session(engine, { maxNodes: 8, maxHtmlLength: 30, maxTextLength: 8, maxAttributeLength: 5 });
    const o = engine.observation(s.id); const detail = await engine.observationDetails(s.id, o.id);
    expect(detail.snapshot?.dom?.nodesTruncated).toBe(true); expect(detail.snapshot?.dom?.htmlTruncated).toBe(true);
    expect(detail.snapshot?.dom?.nodes.some(n => n.gaps.some(g => g.code === 'FIELD_TRUNCATED'))).toBe(true);
    const c = o.controls.find(c => c.name === '订单金额')!;
    expect((await engine.controlDetails(s.id, o.id, c.localId)).gaps.some(g => g.code === 'CONTROL_DOM_UNAVAILABLE')).toBe(true);
    const { evidence, ...old } = o; const legacy: Observation = { ...old, id: crypto.randomUUID() }; store.put('observation', legacy);
    expect((await engine.observationDetails(s.id, legacy.id)).gaps.some(g => g.code === 'DETAIL_NOT_CAPTURED')).toBe(true);
    await expect(engine.observationDetails(s.id, '')).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await engine.stop(s.id); const disabled = await session(engine, { enabled: false });
    expect((await engine.observationDetails(disabled.id, engine.observation(disabled.id).id)).gaps.some(g => g.code === 'DETAIL_CAPTURE_DISABLED')).toBe(true);
  } finally { await engine.close(); }
});

it('preserves primary observation when detailed storage fails and reports missing or corrupted evidence', async () => {
  const store = new MemoryStore(); const put = store.evidence.put.bind(store.evidence);
  store.evidence.put = async (key, evidence) => { if (key.endsWith('.json')) throw new Error('detail storage unavailable'); return put(key, evidence); };
  const engine = new BrowserEngine({ persistence: store });
  try {
    const s = await session(engine); const o = engine.observation(s.id);
    expect(o.controls.length).toBeGreaterThan(0); expect(o.screenshot).toBeTruthy();
    expect(o.evidence?.gaps.some(g => g.code === 'DETAIL_STORAGE_FAILED')).toBe(true);
    store.evidence.put = put; const fresh = await engine.observe(s.id);
    await put(fresh.evidence!.artifacts.details!.key, { data: new TextEncoder().encode('{}'), mediaType: 'application/json' });
    expect((await engine.observationDetails(s.id, fresh.id)).gaps.some(g => g.code === 'DETAIL_EVIDENCE_UNAVAILABLE')).toBe(true);
    const bareEvent = store.event(s.id, 'plugin.notice', { message: 'No observation specified' });
    expect((await engine.eventContext(s.id, bareEvent.sequence)).gaps.some(g => g.code === 'EVENT_HAS_NO_OBSERVATION_REFERENCE')).toBe(true);
  } finally { await engine.close(); }
});

it('bounds aggregate DOM data and exposes runtime drops rather than presenting a complete capture', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await session(engine, { maxDomCharacters: 3000, maxRuntimeEntries: 2, maxTextLength: 8 });
    await pageOf(engine).evaluate(() => { for (let i = 0; i < 5; i++) console.info(`Long runtime evidence message ${i}`); });
    const o = await engine.observe(s.id); const detail = await engine.observationDetails(s.id, o.id);
    const dom = detail.snapshot!.dom!;
    expect(dom.nodesTruncated).toBe(true);
    expect(dom.nodes.reduce((sum, n) => sum + JSON.stringify(n).length, 0)).toBeLessThanOrEqual(3000);
    expect(detail.snapshot!.runtime.console.length).toBeLessThanOrEqual(2);
    expect(detail.snapshot!.runtime.dropped.console).toBeGreaterThan(0);
    expect(detail.snapshot!.runtime.truncatedFields).toBeGreaterThan(0);
    expect(detail.gaps.some(g => g.code === 'RUNTIME_TRUNCATED')).toBe(true);
    expect(o.evidence?.status).toBe('partial');
  } finally { await engine.close(); }
});
