import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserEngine, type Inspection } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { RuleRunner, textBackgroundRule, textBackgroundOptionsSchema, TextBackgroundTracker,
  textBackgroundRequirementProposalSchema, ruleRequirementProposalSchema, type CaptureReader, type RuleReport } from '@interaction/rules';
import { fixtureServer, pageOf } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
type Source = Awaited<ReturnType<CaptureReader['captureDetails']>>;
const latest = (e: BrowserEngine, sid: string) => e.listInspections(sid).items.at(-1)!;
const node = (s: Source, id: string) => s.details!.snapshot!.dom!.nodes.find(n => n.attributes?.id === id)!;
const check = (r: RuleReport, s: Source, id: string) => r.checks.find(c => c.target?.nodeId === node(s, id).id)!;
const plan = { ruleId: textBackgroundRule.id, ruleVersion: textBackgroundRule.version };
const run = async (s: Source, t: Inspection, options = {}) => (await new RuleRunner([textBackgroundRule]).run({ captureDetails: async () => s }, t, [{ ...plan, options }]))[0];
async function setup(fn: (e: BrowserEngine, t: Inspection, s: Source) => Promise<void>) {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const session = await engine.createSession({ url: fixture.url + '/text-background.html', viewport: { width: 1100, height: 900 }, headless: true,
      settleMs: 60, inspection: {}, evidenceRetention: { mode: 'persistent' } });
    const task = latest(engine, session.id); await fn(engine, task, await engine.captureDetails(session.id, task.captureId));
  } finally { await engine.close(); }
}

it('measures solid label colors, transparency, fill overrides and visible associated labels without acting', async () => {
  await setup(async (engine, task, s) => {
    const report = await run(s, task);
    for (const id of ['target', 'rounded', 'transparent', 'inherited', 'fill', 'alpha', 'field', 'mixed']) {
      expect(check(report, s, id), id).toMatchObject({ code: 'TEXT_BACKGROUND_MATCH', verdict: 'unknown', severity: 'warning', facts: { observationStatus: 'current' } });
    }
    for (const id of ['healthy', 'alpha-healthy', 'low-contrast', 'opaque-over-gradient']) expect(check(report, s, id), id).toMatchObject({ code: 'TEXT_BACKGROUND_DISTINCT', verdict: 'pass' });
    for (const id of ['gradient', 'shadow', 'stroke', 'pseudo', 'emoji', 'covered', 'native']) expect(check(report, s, id), id).toMatchObject({ code: 'TEXT_BACKGROUND_UNSUPPORTED', severity: 'info', verdict: 'unknown', facts: { observationStatus: 'unsupported' } });
    for (const id of ['disabled', 'hidden', 'modal-text']) if (check(report, s, id)) expect(check(report, s, id), id).toMatchObject({ verdict: 'not-applicable' });
    const samples = check(report, s, 'alpha-healthy').facts!.samples as any[];
    expect(samples[0]).toMatchObject({ compositedForeground: [127.5, 127.5, 127.5, 1], background: [255, 255, 255, 1] });
    expect(engine.session(task.sessionId).actionCount).toBe(0);
    expect(await pageOf(engine).evaluate(() => scrollY)).toBe(0);
    const fields = await engine.dom(task.sessionId, task.observationId, { rootId: node(s, 'pseudo').id, fields: ['paint'] });
    expect(fields.nodes[0].paint?.pseudoElements).toEqual([{ kind: 'before', position: 'static' }]);
    expect(fields.nodes[0].styles).toBeUndefined();
  });
});

it('uses exact host requirements and keeps proposed agent judgments inert', async () => {
  await setup(async (_engine, task, s) => {
    const base = check(await run(s, task), s, 'target');
    const req = { sessionId: task.sessionId, documentId: s.capture.documentId, nodeId: node(s, 'target').id,
      label: base.facts!.labelBinding, kind: 'distinct-solid-label-colors', reason: 'Fixture label colors must differ', evidence: ['fixture-spec:label-color'] };
    expect(check(await run(s, task, { requirements: [req] }), s, 'target')).toMatchObject({ code: 'TEXT_BACKGROUND_REQUIREMENT_FAILED', verdict: 'fail', severity: 'error', evidence: expect.arrayContaining(req.evidence) });
    expect(check(await run(s, task, { requirements: [{ ...req, kind: 'allow-matching-label-colors' }] }), s, 'target').code).toBe('TEXT_BACKGROUND_MATCH_ALLOWED');
    for (const patch of [{ sessionId: 'other' }, { documentId: 'other' }, { nodeId: 'other' }, { label: [{ nodeId: 'other', text: 'same text' }] }]) {
      expect(check(await run(s, task, { requirements: [{ ...req, ...patch }] }), s, 'target').severity).toBe('warning');
    }
    const proposal = { schemaVersion: 1, status: 'proposed', ruleId: plan.ruleId, ruleVersion: plan.ruleVersion,
      target: { sessionId: task.sessionId, observationId: task.observationId, captureId: task.captureId, documentId: req.documentId, nodeId: req.nodeId, instanceId: 'instance' },
      source: { kind: 'agent-judgment', agentId: 'future-agent', basis: 'inference' }, requirement: req.kind, label: req.label, reason: req.reason, evidence: req.evidence };
    expect(textBackgroundRequirementProposalSchema.parse(proposal)).toEqual(proposal);
    expect(ruleRequirementProposalSchema.parse(proposal)).toEqual(proposal);
    for (const input of [{ requirements: [proposal] }, { requirements: [{ ...req, ...proposal }] }, { requirements: [req, req] }, { channelTolerance: -1 }, { channelTolerance: 3 }, { provider: 'agent' }]) {
      expect(textBackgroundOptionsSchema.safeParse(input).success).toBe(false);
    }
    node(s, 'target').attributes!['data-colors-approved'] = 'true';
    expect(check(await run(s, task), s, 'target').severity).toBe('warning');
    expect(check(await run(s, task, { channelTolerance: 1 }), s, 'low-contrast').severity).toBe('warning');
  });
});

it('does not certify incomplete evidence, unknown backgrounds or unsettled/effected rendering', async () => {
  await setup(async (_engine, task, original) => {
    const variants: [string, (s: Source) => void, string][] = [
      ['legacy', s => { delete s.details!.snapshot!.dom!.paintEnvironment; }, 'TEXT_BACKGROUND_UNAVAILABLE'],
      ['forced colors', s => { s.details!.snapshot!.dom!.paintEnvironment!.forcedColors = true; }, 'TEXT_BACKGROUND_UNSUPPORTED'],
      ['missing paint', s => { delete node(s, 'target').paint; }, 'TEXT_BACKGROUND_UNAVAILABLE'],
      ['animation', s => { node(s, 'target').paint!.motion = 'running'; }, 'TEXT_BACKGROUND_UNAVAILABLE'],
      ['group opacity', s => { node(s, 'target').styles!.opacity = '.5'; }, 'TEXT_BACKGROUND_UNSUPPORTED'],
      ['blend', s => { node(s, 'target').styles!['mix-blend-mode'] = 'difference'; }, 'TEXT_BACKGROUND_UNSUPPORTED'],
      ['wide gamut', s => { node(s, 'target').styles!['-webkit-text-fill-color'] = 'color(display-p3 1 1 1)'; }, 'TEXT_BACKGROUND_UNSUPPORTED'],
      ['missing fill', s => { delete node(s, 'target').styles!['-webkit-text-fill-color']; }, 'TEXT_BACKGROUND_UNAVAILABLE'],
      ['unknown canvas', s => { for (const n of s.details!.snapshot!.dom!.nodes) if(n.styles) n.styles['background-color'] = 'rgba(0, 0, 0, 0)'; }, 'TEXT_BACKGROUND_UNAVAILABLE'],
      ['truncated field', s => { node(s, 'target').gaps.push({ code: 'FIELD_TRUNCATED', message: 'color' }); }, 'TEXT_BACKGROUND_UNAVAILABLE'],
    ];
    for (const [label, change, code] of variants) {
      const source = structuredClone(original); change(source);
      expect(check(await run(source, task), source, 'target'), label).toMatchObject({ code, verdict: 'unknown', severity: 'info' });
    }
  });
});

it('resolves only the same label and keeps the original capture immutable', async () => {
  await setup(async (engine, task, original) => {
    const tracker = new TextBackgroundTracker(), first = await tracker.run(engine, task);
    const issue = check(first, original, 'target').facts!.issueId;
    expect(await tracker.run(engine, task)).toEqual(first);
    await engine.observe(task.sessionId);
    expect(check(await tracker.run(engine, latest(engine, task.sessionId)), original, 'target')).toMatchObject({ severity: 'warning', facts: { issueId: issue } });
    await pageOf(engine).locator('#fix').click(); await engine.observe(task.sessionId);
    const fixed = await tracker.run(engine, latest(engine, task.sessionId));
    expect(check(fixed, original, 'target')).toMatchObject({ code: 'TEXT_BACKGROUND_RESTORED', verdict: 'pass', facts: { lifecycle: 'resolved', issueId: issue } });
    expect(check(await run(original, task), original, 'target').code).toBe('TEXT_BACKGROUND_MATCH');
  });
});

it.each(['text', 'node', 'scope'])('does not confuse a %s change with recovery', async mode => {
  await setup(async (engine, task, original) => {
    const tracker = new TextBackgroundTracker(), first = await tracker.run(engine, task), issue = check(first, original, 'target').facts!.issueId;
    if (mode === 'scope') await pageOf(engine).locator('#open').click();
    else await pageOf(engine).evaluate(mode => {
      const target = document.querySelector<HTMLButtonElement>('#target')!;
      if (mode === 'text') { target.textContent = '新的标签'; target.style.color = 'black'; }
      else { const clone = target.cloneNode(true) as HTMLButtonElement; clone.style.color = 'black'; target.replaceWith(clone); }
    }, mode);
    await engine.observe(task.sessionId); const next = latest(engine, task.sessionId);
    const report = await tracker.run(engine, next);
    expect(report.checks.find(c => c.facts?.issueId === issue)).toMatchObject({ verdict: 'unknown', facts: { observationStatus: 'historical' } });
    if (mode === 'scope') {
      const source = await engine.captureDetails(task.sessionId, next.captureId);
      expect(check(report, source, 'modal-text').code).toBe('TEXT_BACKGROUND_MATCH');
    }
    await engine.observe(task.sessionId);
    expect((await tracker.run(engine, latest(engine, task.sessionId))).checks.find(c => c.facts?.issueId === issue)?.facts?.lifecycle).not.toBe('resolved');
  });
});
