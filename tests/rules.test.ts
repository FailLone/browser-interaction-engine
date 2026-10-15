import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { BrowserEngine, type Inspection } from '@interaction/browser';
import { InteractionClient } from '@interaction/client';
import { MemoryStore } from '@interaction/storage-memory';
import { RuleRunner, sampledOcclusionRule, toInspectionResults, type ControlRule, type RuleAssessment, type RuleSelection } from '@interaction/rules';
import { fixtureServer, pageOf } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const runner = new RuleRunner([sampledOcclusionRule]);
const plan: RuleSelection[] = [{ ruleId: 'sampled-occlusion', ruleVersion: '1.0.0' }];
const latest = (engine: BrowserEngine, sid: string) => engine.listInspections(sid).items.at(-1)!;
async function withFixture(mode: string, run: (engine: BrowserEngine, inspection: Inspection) => Promise<void>) {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const session = await engine.createSession({ url: `${fixture.url}/rules.html?mode=${mode}`, headless: true, viewport: { width: 800, height: 600 }, settleMs: 40, observeTimeoutMs: 800, inspection: { consumers: [{ id: 'rules' }] } });
    await run(engine, latest(engine, session.id));
  } finally { await engine.close(); }
}
function targetPlan(engine: BrowserEngine, inspection: Inspection, name = 'Target'): RuleSelection[] {
  const control = engine.observation(inspection.sessionId, inspection.observationId).controls.find(c => c.name === name)!;
  expect(control).toBeDefined();
  return [{ ...plan[0], targets: [{ captureId: inspection.captureId, nodeId: control.localId }] }];
}

it.each(['healthy', 'pointer-transparent'])('passes only the sampled hit for %s, including descendant hits', async mode => {
  await withFixture(mode, async (engine, inspection) => {
    const [report] = await runner.run(engine, inspection, targetPlan(engine, inspection));
    expect(report).toMatchObject({ verdict: 'pass', severity: 'info' });
    expect(report.checks[0]).toMatchObject({ code: 'SAMPLE_REACHABLE', facts: { coverage: 'one-point-only' } });
    const [disabled] = await runner.run(engine, inspection, targetPlan(engine, inspection, 'Disabled'));
    expect(disabled.verdict).toBe('not-applicable');
  });
});

it.each(['fixed', 'sticky', 'endpoint', 'non-scrollable', 'tooltip', 'popover'])('keeps %s interception unresolved instead of inventing a permanent defect', async mode => {
  await withFixture(mode, async (engine, inspection) => {
    const [report] = await runner.run(engine, inspection, targetPlan(engine, inspection));
    expect(report).toMatchObject({ verdict: 'unknown', severity: 'warning' });
    expect(report.checks[0]).toMatchObject({ code: 'SAMPLE_INTERCEPTED', facts: { recovery: 'unverified' } });
    if (['fixed', 'sticky', 'endpoint', 'non-scrollable'].includes(mode)) expect(report.checks[0].facts!.positionedAncestors).not.toEqual([]);
    if (mode === 'endpoint') {
      const o = engine.observation(inspection.sessionId); expect(o.scroll.y).toBe(o.scroll.maxY);
    }
  });
});

it('excludes modal background while still inspecting controls in the modal', async () => {
  await withFixture('modal', async (engine, inspection) => {
    const [background] = await runner.run(engine, inspection, targetPlan(engine, inspection));
    expect(background.checks[0].code).toBe('MODAL_BACKGROUND');
    expect(background.verdict).toBe('not-applicable');
    const [inside] = await runner.run(engine, inspection, targetPlan(engine, inspection, 'Inside'));
    expect(inside.verdict).toBe('pass');
  });
});

it.each(['nested-modal', 'nested-popover'])('checks portalled %s controls inside the logical modal scope', async mode => {
  await withFixture(mode, async (engine, inspection) => {
    const [child] = await runner.run(engine, inspection, targetPlan(engine, inspection, 'Child'));
    expect(child.verdict).toBe('pass');
    const [background] = await runner.run(engine, inspection, targetPlan(engine, inspection));
    expect(background.verdict).toBe('not-applicable');
    if (mode === 'nested-modal') {
      const [parent] = await runner.run(engine, inspection, targetPlan(engine, inspection, 'Inside'));
      expect(parent.verdict).toBe('not-applicable');
    }
  });
});

it('uses fresh captures after caller-controlled scrolling and never changes or substitutes historical evidence', async () => {
  await withFixture('fixed', async (engine, inspection) => {
    const initialPlan = targetPlan(engine, inspection);
    const original = await runner.run(engine, inspection, initialPlan);
    const count = engine.session(inspection.sessionId).actionCount;
    await pageOf(engine).evaluate(() => window.scrollTo(0, 200)); // Test fixture action, not a rule side effect.
    await engine.observe(inspection.sessionId); const current = latest(engine, inspection.sessionId);
    expect((await runner.run(engine, current, targetPlan(engine, current)))[0].verdict).toBe('pass');
    expect(await runner.run(engine, inspection, initialPlan)).toEqual(original);
    expect((await runner.run(engine, current, initialPlan))[0].checks[0].code).toBe('TARGET_UNAVAILABLE');
    expect(engine.session(inspection.sessionId).actionCount).toBe(count);
    expect(await pageOf(engine).evaluate(() => scrollY)).toBe(200);
  });
});

it('validates plans before execution, isolates failures, and does not turn empty selection into pass', async () => {
  await withFixture('healthy', async (engine, inspection) => {
    const read = vi.fn(engine.captureDetails.bind(engine)); const reader = { captureDetails: read };
    expect(runner.catalog()[0].optionsSchema).toMatchObject({ properties: { includeDisabled: { type: 'boolean', default: false } } });
    expect(await runner.run(reader, inspection, [])).toEqual([]);
    expect(await runner.run(reader, inspection, [{ ...plan[0], enabled: false }])).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    await expect(runner.run(reader, inspection, [{ ...plan[0], ruleVersion: 'wrong' }])).rejects.toThrow('Unknown rule/version');
    await expect(runner.run(reader, inspection, [{ ...plan[0], options: { execute: 'arbitrary code' } }])).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    await expect(runner.run(reader, inspection, [plan[0], plan[0]])).rejects.toThrow('Select each rule once');
    expect((await runner.run(reader, inspection, [{ ...plan[0], targets: [] }]))[0].verdict).toBe('not-applicable');
    const bad: ControlRule = { ...sampledOcclusionRule, id: 'bad', configure: () => context => { context.node.tag = 'mutated'; throw new Error('should not get here'); } };
    const isolated = new RuleRunner([bad, sampledOcclusionRule]);
    const results = await isolated.run(engine, inspection, [{ ...targetPlan(engine, inspection)[0], ruleId: 'bad' }, ...targetPlan(engine, inspection)]);
    expect(results[0].checks[0].code).toBe('RULE_ERROR'); expect(results[1].verdict).toBe('pass');
    const slow = new RuleRunner([{ ...bad, id: 'slow', configure: () => () => new Promise<RuleAssessment>(() => {}) }], { timeoutMs: 10 });
    expect((await slow.run(engine, inspection, [{ ...plan[0], ruleId: 'slow' }]))[0].checks[0].code).toBe('RULE_TIMEOUT');
    const partial = new RuleRunner([{ ...bad, id: 'partial', configure: () => {
      let calls = 0;
      return () => ++calls === 1
        ? { verdict: 'fail', severity: 'error', code: 'KNOWN_FAILURE', expected: 'Test contract', actual: 'Known failure before timeout', evidence: [] }
        : new Promise<RuleAssessment>(() => {});
    } }], { timeoutMs: 10 });
    const [partialReport] = await partial.run(engine, inspection, [{ ...plan[0], ruleId: 'partial' }]);
    expect(partialReport).toMatchObject({ verdict: 'fail', severity: 'error' });
    expect(partialReport.checks.map(c => c.code)).toEqual(['KNOWN_FAILURE', 'RULE_TIMEOUT']);
  });
});

it('does not pass missing, incompatible, unstable, truncated or incorrectly bound evidence', async () => {
  await withFixture('healthy', async (engine, inspection) => {
    const original = await engine.captureDetails(inspection.sessionId, inspection.captureId);
    for (const mutate of [
      (s: typeof original) => { s.details!.snapshot = undefined; },
      (s: typeof original) => { s.compatibility.protocolSupported = false; },
      (s: typeof original) => { s.compatibility.unknownComponents.push('web.layout'); },
      (s: typeof original) => { s.details!.snapshot!.dom!.nodesTruncated = true; },
      (s: typeof original) => { s.details!.observation.stable = false; },
      (s: typeof original) => { s.capture.sessionId = 'another-session'; },
      (s: typeof original) => { s.availability.find(a => a.kind === 'web.layout')!.availability.status = 'missing'; },
    ]) {
      const source = structuredClone(original); mutate(source);
      const [result] = await runner.run({ captureDetails: async () => source }, inspection, plan);
      expect(result.verdict).toBe('unknown');
    }
  });
});

it('preserves four verdicts, warning/error severity and per-control evidence through HTTP and replay', async () => {
  await withFixture('fixed', async (engine, inspection) => {
    const custom: ControlRule = { ...sampledOcclusionRule, id: 'declared-policy', configure: input => {
      expect(input).toEqual({ expected: 'fixture-specific requirement' });
      return () => ({ verdict: 'fail', severity: 'error', code: 'DECLARED_POLICY_VIOLATED', expected: 'fixture-specific requirement', actual: 'Synthetic policy violation for transport testing', evidence: [inspection.captureId] });
    } };
    const app = await createServer(engine); await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = new InteractionClient(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`);
      const consumer = new RuleRunner([sampledOcclusionRule, custom]);
      const reports = await consumer.run(client, inspection, [
        ...targetPlan(engine, inspection),
        { ...targetPlan(engine, inspection)[0], ruleId: custom.id, options: { expected: 'fixture-specific requirement' } },
      ]);
      const results = toInspectionResults(reports);
      await client.receiveInspection(inspection.sessionId, inspection.id, 'rules');
      await client.completeInspection(inspection.sessionId, inspection.id, 'rules', results);
      await client.completeInspection(inspection.sessionId, inspection.id, 'rules', results);
      const stored = (await client.inspection(inspection.sessionId, inspection.id)).deliveries[0].results;
      expect(stored).toEqual(results);
      expect(stored![0]).toMatchObject({ status: 'inconclusive', severity: 'warning', details: { verdict: 'unknown' } });
      expect(stored![1]).toMatchObject({ status: 'fail', severity: 'error' });
      await engine.observe(inspection.sessionId); const next = latest(engine, inspection.sessionId);
      const na = toInspectionResults(await runner.run(client, next, targetPlan(engine, next, 'Disabled')));
      await client.completeInspection(next.sessionId, next.id, 'rules', na);
      expect((await client.inspection(next.sessionId, next.id)).deliveries[0].results![0].status).toBe('not-applicable');
    } finally { await app.close(); }
  });
});
