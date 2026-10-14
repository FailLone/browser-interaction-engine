import { beforeAll, afterAll, it, expect } from 'vitest';
import { BrowserEngine, inspectionCapabilities, validateCaptureProfile, type Inspection, type InspectionDelivery, type InspectionResult } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { InteractionClient } from '@interaction/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureServer, act, pageOf } from './helpers.js';
import { inspectPopup } from '../examples/popup-inspector.js';
import { createServer } from '../apps/server/src/server.js';
let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); }); afterAll(async () => { await fixture.server.close(); });
const options = () => ({ url: `${fixture.url}/inspection.html`, headless: true, viewport: { width: 800, height: 600 }, settleMs: 50, observeTimeoutMs: 800, inspection: { consumers: [{ id: 'checker' }] }, evidenceRetention: { mode: 'cache', ttlMs: 100 } });
const latest = (engine: BrowserEngine, sid: string) => engine.listInspections(sid).items.at(-1)!;

it('publishes after persisted evidence, focuses popup scopes and compares restored parent with scope entry', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await engine.createSession(options()); const initial = latest(engine, s.id);
    expect(initial.reasons).toEqual(['initial']); expect(initial.focus.kind).toBe('document'); expect(initial.quality.status).toBe('complete');
    const original = await engine.captureDetails(s.id, initial.captureId);
    expect(original.details?.snapshot?.dom?.environment?.scrollingElement?.scrollHeight).toBe(600);
    const task = await engine.inspection(s.id, initial.id); expect(task.deliveries[0].status).toBe('pending');
    await act(engine, s.id, 'Open oversized popup'); const popup = latest(engine, s.id);
    expect(popup.reasons).toEqual(expect.arrayContaining(['scope_entered', 'after_action'])); expect(popup.focus.kind).toBe('overlay');
    expect(popup.baselines.find(b => b.role === 'scopeEntry')?.captureId).toBe(initial.captureId);
    const detail = await engine.captureDetails(s.id, popup.captureId); const context = await engine.nodeContext(s.id, popup.captureId, popup.focus.rootIds[0]);
    expect(context.node.layout!.scroll.height).toBe(context.node.layout!.client.height);
    expect(context.node.styles!['max-height']).toBe('none'); expect(context.node.rect!.height).toBeGreaterThan(600);
    expect(detail.details?.snapshot?.dom?.environment?.scrollingElement?.scrollHeight).toBeGreaterThan(600);
    expect((await inspectPopup(engine, popup)).status).toBe('fail');
    await act(engine, s.id, 'Open child'); const child = latest(engine, s.id);
    expect(child.focus.regionKey).not.toBe(popup.focus.regionKey);
    expect(child.baselines.find(b => b.role === 'scopeEntry')?.captureId).toBe(popup.captureId);
    const childContext = await engine.nodeContext(s.id, child.captureId, child.focus.rootIds[0]);
    expect(childContext.ancestors.some(n => n.attributes?.id === 'bad')).toBe(false); // DOM parent differs from logical owner.
    await act(engine, s.id, 'Close child'); const restoredPopup = latest(engine, s.id);
    expect(restoredPopup.focus.regionKey).toBe(popup.focus.regionKey);
    expect(restoredPopup.baselines.find(b => b.role === 'scopeEntry')?.captureId).toBe(popup.captureId);
    await act(engine, s.id, 'Close bad'); const restored = latest(engine, s.id);
    expect(restored.focus.kind).toBe('document'); expect(restored.reasons).toContain('scope_exited');
    expect(restored.baselines.find(b => b.role === 'scopeEntry')?.captureId).toBe(initial.captureId);
    // Multiple async consumers can still query the original captures after page changes.
    expect((await engine.captureDetails(s.id, initial.captureId)).details?.snapshot).toEqual(original.details?.snapshot);
    const event = engine.store.events(s.id).find(e => e.type === 'inspection.ready')!;
    expect((await engine.projectEvent(event)).data).toHaveProperty('evidence.details.snapshot');
    const count = engine.session(s.id).actionCount;
    await engine.captureNodes(s.id, popup.captureId, { rootId: popup.focus.rootIds[0], limit: 2 });
    await engine.regionContext(s.id, popup.captureId, popup.focus.regionKey);
    expect(engine.session(s.id).actionCount).toBe(count);
  } finally { await engine.close(); }
});

it('accepts a child scroll container, handles preexisting scroll and emits checks for style-only changes', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await engine.createSession(options()); const original = engine.observation(s.id);
    await act(engine, s.id, 'Change color'); const changed = latest(engine, s.id);
    expect(engine.observation(s.id).stateId).toBe(original.stateId); expect(changed.observationId).not.toBe(original.id);
    expect(changed.reasons).toContain('after_action');
    await act(engine, s.id, 'Open scrolling popup');
    expect((await inspectPopup(engine, latest(engine, s.id))).status).toBe('pass');
    await engine.stop(s.id);
    const other = await engine.createSession({ ...options(), url: `${fixture.url}/inspection.html?preexisting` });
    await act(engine, other.id, 'Open oversized popup');
    const result = await inspectPopup(engine, latest(engine, other.id)); expect(result.status).toBe('fail'); expect(result.message).toContain('already');
  } finally { await engine.close(); }
});

it('reports an initially open popup without inventing a before-entry baseline, and marks navigation/viewport changes', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await engine.createSession({ ...options(), url: `${fixture.url}/inspection.html?already-open` });
    const initial = latest(engine, s.id); expect(initial.focus.kind).toBe('overlay');
    expect(initial.baselines.find(b => b.role === 'scopeEntry')).toMatchObject({ comparison: 'missing', reason: 'scope_already_open' });
    expect((await inspectPopup(engine, initial)).status).toBe('inconclusive');
    await pageOf(engine).setViewportSize({ width: 900, height: 700 }); await engine.observe(s.id);
    expect(latest(engine, s.id).reasons).toContain('environment_changed');
    expect(latest(engine, s.id).baselines.find(b => b.role === 'previous')?.reason).toBe('viewport_changed');
    await pageOf(engine).goto(`${fixture.url}/inspection.html`); await engine.observe(s.id);
    expect(latest(engine, s.id).reasons).toContain('navigation'); expect(latest(engine, s.id).baselines[0].comparison).toBe('incomparable');
  } finally { await engine.close(); }
});

it('keeps finite independent leases, separates receipt from completion, bounds renewal and rejects conflicting results', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await engine.createSession({ ...options(), inspection: { consumers: [{ id: 'one', leaseMs: 1000, maxLeaseMs: 2000 }, { id: 'two' }] } });
    const initial = latest(engine, s.id); await engine.receiveInspection(s.id, initial.id, 'one');
    expect((await engine.inspection(s.id, initial.id)).deliveries.find(d => d.consumerId === 'one')).toMatchObject({ status: 'pending', receivedAt: expect.any(String) });
    const renewed = await engine.renewInspection(s.id, initial.id, 'one'); expect(Date.parse(renewed.leaseUntil)).toBeLessThanOrEqual(Date.parse(renewed.maxLeaseUntil));
    const result: InspectionResult = { ruleId: 'demo', ruleVersion: '1', status: 'pass', message: 'complete evidence' };
    await engine.completeInspection(s.id, initial.id, 'one', [result]);
    await expect(engine.completeInspection(s.id, initial.id, 'one', [result])).resolves.toMatchObject({ status: 'completed' });
    await expect(engine.completeInspection(s.id, initial.id, 'one', [{ ...result, status: 'fail' }])).rejects.toMatchObject({ code: 'INSPECTION_RESULT_CONFLICT' });
    await act(engine, s.id, 'Change color');
    const protectedEvidence = (await engine.evidenceStats(s.id)).protected.find(p => p.observationId === initial.observationId)!;
    expect(protectedEvidence.owners).not.toContain(`inspection:${initial.id}:one`); expect(protectedEvidence.owners).toContain(`inspection:${initial.id}:two`);
    await engine.cancelInspection(s.id, initial.id, 'two');
    expect((await engine.inspection(s.id, initial.id)).deliveries.find(d => d.consumerId === 'two')?.status).toBe('cancelled');
    const pending = latest(engine, s.id); const d = engine.list<InspectionDelivery>(s.id, 'inspection-delivery').find(d => d.inspectionId === pending.id && d.consumerId === 'one')!;
    engine.store.put('inspection-delivery', { ...d, leaseUntil: new Date(0).toISOString() });
    expect((await engine.inspection(s.id, pending.id)).deliveries.find(d => d.consumerId === 'one')?.status).toBe('expired');
    await expect(engine.completeInspection(s.id, pending.id, 'one')).rejects.toMatchObject({ code: 'INSPECTION_LEASE_CLOSED' });
  } finally { await engine.close(); }
});

it('validates required capabilities and retention before navigation, and reports truncated required data without pass', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    expect(inspectionCapabilities.phases).not.toContain('intermediate'); expect(validateCaptureProfile({ required: ['unknown'] }).valid).toBe(false);
    await expect(engine.createSession({ ...options(), inspection: { profile: { required: ['unknown'] } } })).rejects.toMatchObject({ code: 'INSPECTION_UNSUPPORTED' });
    await expect(engine.createSession({ ...options(), evidenceRetention: { mode: 'transient' } })).rejects.toMatchObject({ code: 'INSPECTION_RETENTION_REQUIRED' });
    expect(engine.sessions()).toHaveLength(0);
    const s = await engine.createSession({ ...options(), evidence: { maxNodes: 3 }, inspection: { profile: { optional: ['unknown'], onIncomplete: 'pause' }, consumers: [{ id: 'checker' }] } });
    const current = latest(engine, s.id); expect(current.quality.status).toBe('incomplete');
    expect((await engine.captureDetails(s.id, current.captureId)).capture.components.find(c => c.kind === 'unknown')?.status).toBe('unsupported');
    await expect(act(engine, s.id, 'Open oversized popup')).rejects.toMatchObject({ code: 'INSPECTION_INCOMPLETE' });
    await expect(engine.completeInspection(s.id, current.id, 'checker', [{ ruleId: 'x', ruleVersion: '1', status: 'pass', message: '' }])).rejects.toMatchObject({ code: 'INSPECTION_INCOMPLETE' });
    await engine.completeInspection(s.id, current.id, 'checker', [{ ruleId: 'x', ruleVersion: '1', status: 'inconclusive', message: 'DOM truncated' }]);
  } finally { await engine.close(); }
});

it.each(['cache', 'persistent'] as const)('restores durable delivery metadata with honest %s evidence availability', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'inspection-restart-')); let engine = new BrowserEngine({ persistence: new SqliteStore(directory) });
  try {
    const s = await engine.createSession({ ...options(), evidenceRetention: { mode, ttlMs: 100 } }); const initial = latest(engine, s.id);
    await engine.close(); engine = new BrowserEngine({ persistence: new SqliteStore(directory) });
    const restored = await engine.inspection(s.id, initial.id); expect(restored.deliveries[0].status).toBe(mode === 'cache' ? 'unavailable' : 'pending');
    const capture = await engine.captureDetails(s.id, initial.captureId);
    expect(!!capture.details?.snapshot).toBe(mode === 'persistent');
    expect(capture.capture.observationId).toBe(initial.observationId);
  } finally { await engine.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('exposes replayable inspection and immutable capture queries through HTTP and SDK', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() }); const app = await createServer(engine);
  await app.listen({ host: '127.0.0.1', port: 0 }); const client = new InteractionClient(`http://127.0.0.1:${(app.server.address() as any).port}`);
  try {
    const s = await client.createSession({ ...options(), evidenceRetention: { mode: 'cache' } });
    const first = (await client.listInspections(s.id, { limit: 1 })).items[0];
    expect((await client.inspectionCapabilities()).protocolVersion).toBe(1); expect((await client.validateCaptureProfile({ required: ['unknown'] })).valid).toBe(false);
    const details = await client.captureDetails(s.id, first.captureId); expect(details.details?.snapshot?.dom?.spatialVersion).toBe(1);
    const tree = await client.captureNodes(s.id, first.captureId, { limit: 2 }); expect(tree.nodes).toHaveLength(2);
    const projected = await client.captureNodes(s.id, first.captureId, { limit: 1, fields: ['layout'] }); expect(projected.nodes[0].layout).toBeTruthy(); expect(projected.nodes[0].styles).toBeUndefined();
    const identifiers = await client.captureNodes(s.id, first.captureId, { limit: 1, fields: [] }); expect(identifiers.nodes[0].id).toBeTruthy(); expect(identifiers.nodes[0].layout).toBeUndefined();
    expect((await client.nodeContext(s.id, first.captureId, tree.nodes[0].id)).captureId).toBe(first.captureId);
    expect((await client.regionContext(s.id, first.captureId, 'document')).page?.scrollingElement).toBeTruthy();
    await client.observe(s.id); const next = await client.listInspections(s.id, { after: first.sequence }); expect(next.items).toHaveLength(1);
    await client.receiveInspection(s.id, first.id, 'checker'); await client.renewInspection(s.id, first.id, 'checker');
    await client.completeInspection(s.id, first.id, 'checker'); expect((await client.inspection(s.id, first.id)).deliveries[0].status).toBe('completed');
    expect((await app.inject(`/v1/sessions/wrong/captures/${encodeURIComponent(first.captureId)}`)).statusCode).toBe(404);
    expect((await app.inject(`/v1/sessions/${s.id}/captures/${encodeURIComponent(first.captureId)}/nodes?limit=0`)).statusCode).toBe(400);
    expect((await app.inject(`/v1/sessions/${s.id}/inspections?after=-1`)).statusCode).toBe(400);
  } finally { await app.close(); await engine.close(); }
});

it('reports disabled, missing screenshots, capacity failures and unstable captures explicitly', async () => {
  const raw = new MemoryStore(); const engine = new BrowserEngine({ persistence: raw });
  try {
    const disabled = await engine.createSession({ ...options(), evidence: { enabled: false } });
    expect(latest(engine, disabled.id).quality.missingRequired).toContain('web.dom'); await engine.stop(disabled.id);
    const photo = await engine.createSession({ ...options(), inspection: { profile: { required: ['web.screenshot'] }, consumers: [{ id: 'checker' }] } });
    const page = pageOf(engine); const screenshot = page.screenshot.bind(page); page.screenshot = async () => { throw new Error('simulated screenshot failure'); };
    await engine.observe(photo.id); const missing = latest(engine, photo.id);
    expect(missing.quality.missingRequired).toEqual(['web.screenshot']);
    page.screenshot = screenshot;
    await page.evaluate(() => { let n = 0; const move = () => { document.getElementById('openBad')!.style.transform = `translateX(${n++ / 10}px)`; requestAnimationFrame(move); }; move(); });
    await engine.observe(photo.id);
    expect((await engine.captureDetails(photo.id, latest(engine, photo.id).captureId)).capture.phase).toBe('timeout');
    expect(latest(engine, photo.id).quality.status).toBe('incomplete'); await engine.stop(photo.id);
    const limited = await engine.createSession({ ...options(), evidenceRetention: { mode: 'cache', maxBytes: 1024 } });
    const insufficient = latest(engine, limited.id); expect(insufficient.quality.status).toBe('incomplete');
    expect((await engine.inspection(limited.id, insufficient.id)).deliveries[0].status).toBe('unavailable');
    expect(engine.observation(limited.id).gaps.some(g => g.critical)).toBe(true);
  } finally { await engine.close(); }
});

it('handles background growth and scroll normalization, supports field projections and does not reinterpret unknown schemas', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await engine.createSession(options()); await act(engine, s.id, 'Open scrolling popup');
    await pageOf(engine).evaluate(() => { document.getElementById('preexisting')!.style.height = '2000px'; }); await engine.observe(s.id);
    expect((await inspectPopup(engine, latest(engine, s.id))).status).toBe('inconclusive');
    const current = latest(engine, s.id); const beforeCount = engine.session(s.id).actionCount;
    const nodes = await engine.captureNodes(s.id, current.captureId, { fields: ['layout'], limit: 1 });
    expect(nodes.nodes[0].layout).toBeTruthy(); expect(nodes.nodes[0].styles).toBeUndefined();
    expect(engine.session(s.id).actionCount).toBe(beforeCount);
    const { capture } = await engine.captureDetails(s.id, current.captureId);
    engine.store.put('capture', { ...capture, id: 'future-capture', protocolVersion: 2, components: [{ ...capture.components[0], schemaVersion: 99 }] });
    expect((await engine.captureDetails(s.id, 'future-capture')).compatibility).toMatchObject({ protocolSupported: false, unknownComponents: [capture.components[0].kind] });
    const { capture: original } = await engine.captureDetails(s.id, current.captureId); expect(original.protocolVersion).toBe(1);
    // Contract-only temporal fixture: a frame need not create observations/states/actions.
    const observations = engine.list(s.id, 'observation').length; const states = engine.getGraph(s.id).states.length;
    engine.store.put('capture', { ...capture, id: 'intermediate-contract', observationId: undefined, phase: 'intermediate', components: [], segmentId: 'segment', sampleIndex: 2 });
    expect((await engine.captureDetails(s.id, 'intermediate-contract')).details).toBeUndefined();
    expect(engine.list(s.id, 'observation')).toHaveLength(observations); expect(engine.getGraph(s.id).states).toHaveLength(states);
  } finally { await engine.close(); }
});

it('still emits an inspection when an action changed the page and then failed', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await engine.createSession(options());
    const driver = (engine as any).driver; const execute = driver.execute.bind(driver);
    driver.execute = async (...args: any[]) => { await execute(...args); throw new Error('failure after page effect'); };
    const attempt = await act(engine, s.id, 'Open oversized popup');
    expect(attempt.status).toBe('failed'); expect(latest(engine, s.id).reasons).toContain('after_action');
    expect(latest(engine, s.id).focus.kind).toBe('overlay');
  } finally { await engine.close(); }
});

it('rechecks strict delivery guarantees after a slow preflight and before starting the action', async () => {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await engine.createSession({ ...options(), inspection: { profile: { onIncomplete: 'pause' }, consumers: [{ id: 'checker' }] } });
    const initial = latest(engine, s.id); const driver = (engine as any).driver; const validate = driver.validate.bind(driver);
    driver.validate = async (...args: any[]) => {
      await validate(...args); const d = engine.list<InspectionDelivery>(s.id, 'inspection-delivery')[0];
      engine.store.put('inspection-delivery', { ...d, leaseUntil: new Date(0).toISOString() });
    };
    await expect(act(engine, s.id, 'Open oversized popup')).rejects.toMatchObject({ code: 'INSPECTION_INCOMPLETE' });
    expect(engine.session(s.id).actionCount).toBe(0); expect(engine.observation(s.id).overlays).toHaveLength(0);
    driver.validate = validate; await engine.cancelInspection(s.id, initial.id, 'checker');
    await act(engine, s.id, 'Open oversized popup'); expect(latest(engine, s.id).focus.kind).toBe('overlay');
  } finally { await engine.close(); }
});
