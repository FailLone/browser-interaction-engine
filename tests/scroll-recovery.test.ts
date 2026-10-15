import { beforeAll, afterAll, it, expect } from 'vitest';
import { BrowserEngine, type Inspection, type ScrollProbeOptions } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { inspectScrollRecovery, toInspectionResults } from '@interaction/rules';
import { fixtureServer, pageOf } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const requirement = { requiredNow: { reason: 'Fixture target must offer a sampled pointer entry now', evidence: ['fixture:declared-pointer-requirement'] } };
async function setup(mode: string, fn: (engine: BrowserEngine, task: Inspection, localId: string) => Promise<void>, maxActions = 100) {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await engine.createSession({ url: `${fixture.url}/scroll-recovery.html?mode=${mode}`, headless: true, viewport: { width: 800, height: 600 }, settleMs: 60, observeTimeoutMs: 1200, maxActions,
      inspection: { consumers: [{ id: 'rules' }] } });
    const inspection = engine.listInspections(s.id).items.at(-1)!;
    await fn(engine, inspection, engine.observation(s.id).controls.find(c => c.name === 'Target')!.localId);
  } finally { await engine.close(); }
}
it.each(['fixed', 'reverse-endpoint', 'nested', 'horizontal'])('verifies %s recovery and restores all starting scroll positions', async mode => {
  await setup(mode, async (engine, inspection, localId) => {
    const original = await engine.observationDetails(inspection.sessionId, inspection.observationId);
    const report = await inspectScrollRecovery(engine, inspection, localId, requirement);
    expect(report).toMatchObject({ verdict: 'fail', severity: 'warning' });
    const check = report.checks[0];
    expect(check).toMatchObject({ code: 'SCROLL_RECOVERED', facts: { recovered: true, restoration: { status: 'restored' } } });
    const facts = check.facts as any;
    expect(facts.attempts.some((a: any) => a.phase === 'probe')).toBe(true);
    expect(facts.attempts.some((a: any) => a.phase === 'restore')).toBe(true);
    expect(facts.samples.some((s: any) => s.reachable)).toBe(true);
    expect(new Set(facts.samples.map((s: any) => s.nodeId))).toEqual(new Set([localId]));
    expect((await engine.observationDetails(inspection.sessionId, inspection.observationId)).snapshot).toEqual(original.snapshot);
    const final = await engine.observationDetails(inspection.sessionId, engine.observation(inspection.sessionId).id);
    expect(final.snapshot!.dom!.environment!.scroll).toEqual(original.snapshot!.dom!.environment!.scroll);
    if (mode === 'nested') expect(await pageOf(engine).locator('#scroller').evaluate(el => el.scrollTop)).toBe(0);
    const attempts = engine.list<any>(inspection.sessionId, 'attempt');
    expect(attempts.every(a => a.action.source === 'external-probe' && a.action.risk === 'unknown' && !a.action.replayable && a.beforeId && a.afterId)).toBe(true);
    expect(engine.session(inspection.sessionId).actionCount).toBe(attempts.length);
  });
});

it('limits error to a declared sampled-pointer requirement with no available scroll path', async () => {
  await setup('no-scroll', async (engine, task, id) => {
    const report = await inspectScrollRecovery(engine, task, id, requirement);
    expect(report).toMatchObject({ verdict: 'fail', severity: 'error' });
    expect(report.checks[0].code).toBe('BLOCKED_WITHOUT_SCROLL_PATH');
    expect(engine.session(task.sessionId).actionCount).toBe(0);
    const current = engine.listInspections(task.sessionId).items.at(-1)!;
    const undeclared = await inspectScrollRecovery(engine, current, id);
    expect(undeclared).toMatchObject({ verdict: 'unknown', severity: 'warning' });
  });
});

it('passes a healthy sample and does not treat exhausted probes as an error', async () => {
  await setup('healthy', async (engine, task, id) => {
    expect((await inspectScrollRecovery(engine, task, id, requirement)).verdict).toBe('pass');
    expect(engine.session(task.sessionId).actionCount).toBe(0);
  });
  await setup('fixed-fixed', async (engine, task, id) => {
    const report = await inspectScrollRecovery(engine, task, id, { ...requirement, maxScrolls: 2 });
    expect(report).toMatchObject({ verdict: 'unknown', severity: 'warning' });
    expect(report.checks[0].facts).toMatchObject({ recovered: false, restoration: { status: 'restored' } });
    expect(await pageOf(engine).evaluate(() => scrollY)).toBe(0);
  });
});

it.each(['replace', 'rebind', 'resize-target', 'restore-failed'])('preserves uncertainty on %s instead of accepting recovery', async mode => {
  await setup(mode, async (engine, task, id) => {
    const report = await inspectScrollRecovery(engine, task, id, requirement);
    expect(report.verdict).toBe('unknown');
    expect(report.checks[0].facts).toMatchObject({ restoration: { status: 'failed' } });
    if (mode !== 'restore-failed') expect(report.checks[0].facts!.stopReason).toMatch(/TARGET/);
    else expect(report.checks[0].facts!.recovered).toBe(true);
  });
});

it('reserves action budget for restoration and does not mutate on a stale inspection', async () => {
  await setup('fixed', async (engine, task, id) => {
    const result = await inspectScrollRecovery(engine, task, id, requirement);
    expect(result.checks[0].facts).toMatchObject({ stopReason: 'session_budget_reserved_for_restore' });
    expect(engine.session(task.sessionId).actionCount).toBe(0);
    expect((await inspectScrollRecovery(engine, task, id, requirement)).checks[0].actual).toContain('STALE_INSPECTION');
  }, 1);
});

it('does not turn missing five-point evidence into a pass or a no-scroll error', async () => {
  await setup('no-scroll', async (engine, task, id) => {
    const source = await engine.captureDetails(task.sessionId, task.captureId);
    delete source.details!.snapshot!.dom!.nodes.find(n => n.id === id)!.layout!.hitSamples;
    const reader = {
      captureDetails: async () => source, observationDetails: engine.observationDetails.bind(engine),
      observation: engine.observation.bind(engine), session: engine.session.bind(engine), observe: engine.observe.bind(engine), scrollProbe: engine.scrollProbe.bind(engine),
    };
    const report = await inspectScrollRecovery(reader, task, id, requirement);
    expect(report.verdict).toBe('unknown');
    expect(engine.session(task.sessionId).actionCount).toBe(0);
  });
});

it('keeps unknown mutation outcomes and their request IDs when a response is lost', async () => {
  await setup('fixed', async (engine, task, id) => {
    const reader = {
      captureDetails: engine.captureDetails.bind(engine), observationDetails: engine.observationDetails.bind(engine),
      observation: engine.observation.bind(engine), session: engine.session.bind(engine), observe: engine.observe.bind(engine),
      scrollProbe: async (...args: Parameters<BrowserEngine['scrollProbe']>) => { await engine.scrollProbe(...args); throw new Error('response lost'); },
    };
    const report = await inspectScrollRecovery(reader, task, id, requirement);
    expect(report).toMatchObject({ verdict: 'unknown', severity: 'warning' });
    expect(report.checks[0].facts).toMatchObject({ restoration: { status: 'failed' }, attempts: [{ status: 'unknown', requestId: expect.any(String) }] });
    expect(engine.session(task.sessionId).actionCount).toBe(1);
    expect(await pageOf(engine).evaluate(() => scrollY)).toBeGreaterThan(0);
  });
});

it('keeps scroll probes inside the active overlay and enforces action budgets', async () => {
  await setup('fixed', async (engine, task, id) => {
    await pageOf(engine).evaluate(() => {
      const panel = document.createElement('div'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
      panel.style.cssText = 'position:fixed;top:20px;left:20px;width:300px;height:200px;z-index:20;background:white';
      panel.innerHTML = '<button>Inside</button>'; document.body.append(panel);
    });
    const o = await engine.observe(task.sessionId); const detail = await engine.observationDetails(task.sessionId, o.id);
    const root = detail.snapshot!.dom!.environment!.scrollingElement!;
    const options = { documentId: o.documentId, containerNodeId: root.nodeId, left: 0, top: 200, expectedLeft: 0, expectedTop: 0 };
    await expect(engine.scrollProbe(task.sessionId, o.id, id, options, crypto.randomUUID())).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    const inside = o.controls.find(c => c.name === 'Inside')!;
    await expect(engine.scrollProbe(task.sessionId, o.id, inside.localId, options, crypto.randomUUID())).rejects.toThrow('OUTSIDE_BOUNDARY');
    expect(engine.session(task.sessionId).actionCount).toBe(0);
    expect(await pageOf(engine).evaluate(() => scrollY)).toBe(0);
  });
  await setup('fixed', async (engine, task, id) => {
    const detail = await engine.captureDetails(task.sessionId, task.captureId); const root = detail.details!.snapshot!.dom!.environment!.scrollingElement!;
    const options = { documentId: detail.capture.documentId, containerNodeId: root.nodeId, left: 0, top: 200, expectedLeft: 0, expectedTop: 0 };
    const attempt = await engine.scrollProbe(task.sessionId, task.observationId, id, options, crypto.randomUUID());
    await expect(engine.scrollProbe(task.sessionId, attempt.afterId!, id, { ...options, top: 0, expectedTop: 200 }, crypto.randomUUID())).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(engine.session(task.sessionId).actionCount).toBe(1);
  }, 1);
});

it('exposes guarded and idempotent scroll probes over HTTP, retaining report evidence', async () => {
  await setup('fixed', async (engine, task, id) => {
    const app = await createServer(engine); await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new InteractionClient(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`);
    try {
      const details = await client.captureDetails(task.sessionId, task.captureId);
      const root = details.details!.snapshot!.dom!.environment!.scrollingElement!;
      const options: ScrollProbeOptions = { documentId: details.capture.documentId, containerNodeId: root.nodeId, left: 0, top: 200, expectedLeft: 0, expectedTop: 0 };
      const requestId = crypto.randomUUID();
      const attempt = await client.scrollProbe(task.sessionId, task.observationId, id, options, requestId);
      expect(attempt.status).toBe('succeeded');
      expect((await client.scrollProbe(task.sessionId, task.observationId, id, options, requestId)).id).toBe(attempt.id);
      await expect(client.scrollProbe(task.sessionId, task.observationId, id, { ...options, top: 300 }, requestId)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
      await expect(client.scrollProbe(task.sessionId, task.observationId, id, options, crypto.randomUUID())).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
      let current = engine.observation(task.sessionId);
      const wrong = { ...options, expectedTop: 0, top: 0 };
      await expect(client.scrollProbe(task.sessionId, current.id, id, wrong, crypto.randomUUID())).rejects.toThrow('POSITION_CHANGED');
      const cover = details.details!.snapshot!.dom!.nodes.find(n => n.attributes?.id === 'cover')!;
      await expect(client.scrollProbe(task.sessionId, current.id, id, { ...options, expectedTop: 200, containerNodeId: cover.id }, crypto.randomUUID())).rejects.toThrow('NOT_ANCESTOR');
      await client.scrollProbe(task.sessionId, current.id, id, { ...options, expectedTop: 200, top: 0 }, crypto.randomUUID());
      const inspection = engine.listInspections(task.sessionId).items.at(-1)!;
      const report = await inspectScrollRecovery(client, inspection, id, requirement);
      await client.completeInspection(task.sessionId, inspection.id, 'rules', toInspectionResults([report]));
      expect((await client.inspection(task.sessionId, inspection.id)).deliveries[0].results![0]).toMatchObject({ status: 'fail', severity: 'warning', details: { checks: [{ code: 'SCROLL_RECOVERED' }] } });
    } finally { await app.close(); }
  });
});
