import { afterAll, beforeAll, expect, it } from 'vitest';
import { RuleRunner, textBackgroundRule, textBackgroundOptionsSchema, TextBackgroundTracker,
  textBackgroundRequirementProposalSchema, ruleRequirementProposalSchema, type RulePage, type RuleReport } from '@interaction/rules';
import { fixtureServer, withFixture, type RuleFixture } from './rule-fixture.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const node = (s: RulePage, id: string) => s.snapshot.dom!.nodes.find(n => n.attributes?.id === id)!;
const check = (r: RuleReport, s: RulePage, id: string) => r.checks.find(c => c.target?.nodeId === node(s, id).id)!;
const plan = { ruleId: textBackgroundRule.id, ruleVersion: textBackgroundRule.version };
const run = async (s: RulePage, options = {}) => (await new RuleRunner([textBackgroundRule]).run(s, [{ ...plan, options }]))[0];
async function setup(fn: (f: RuleFixture, s: RulePage) => Promise<void>) {
  await withFixture(fixture.url + '/text-background.html', fn, { width: 1100, height: 900 });
}

it('measures solid label colors, transparency, fill overrides and visible associated labels without acting', async () => {
  await setup(async (f, s) => {
    const report = await run(s);
    for (const id of ['target', 'rounded', 'transparent', 'inherited', 'fill', 'alpha', 'field', 'mixed']) {
      expect(check(report, s, id), id).toMatchObject({ code: 'TEXT_BACKGROUND_MATCH', verdict: 'unknown', severity: 'warning', facts: { observationStatus: 'current' } });
    }
    for (const id of ['healthy', 'alpha-healthy', 'low-contrast', 'opaque-over-gradient']) expect(check(report, s, id), id).toMatchObject({ code: 'TEXT_BACKGROUND_DISTINCT', verdict: 'pass' });
    for (const id of ['gradient', 'shadow', 'stroke', 'pseudo', 'emoji', 'covered', 'native']) expect(check(report, s, id), id).toMatchObject({ code: 'TEXT_BACKGROUND_UNSUPPORTED', severity: 'info', verdict: 'unknown', facts: { observationStatus: 'unsupported' } });
    for (const id of ['disabled', 'hidden', 'modal-text']) if (check(report, s, id)) expect(check(report, s, id), id).toMatchObject({ verdict: 'not-applicable' });
    const samples = check(report, s, 'alpha-healthy').facts!.samples as any[];
    expect(samples[0]).toMatchObject({ compositedForeground: [127.5, 127.5, 127.5, 1], background: [255, 255, 255, 1] });
    expect(await f.page.evaluate(() => scrollY)).toBe(0);
    expect(node(s, 'pseudo').paint?.pseudoElements).toEqual([{ kind: 'before', position: 'static' }]);
  });
});

it('uses exact host requirements and keeps proposed agent judgments inert', async () => {
  await setup(async (f, s) => {
    const base = check(await run(s), s, 'target');
    const req = { sessionId: s.inspection.sessionId, documentId: s.capture.documentId, nodeId: node(s, 'target').id,
      label: base.facts!.labelBinding, kind: 'distinct-solid-label-colors', reason: 'Fixture label colors must differ', evidence: ['fixture-spec:label-color'] };
    expect(check(await run(s, { requirements: [req] }), s, 'target')).toMatchObject({ code: 'TEXT_BACKGROUND_REQUIREMENT_FAILED', verdict: 'fail', severity: 'error', evidence: expect.arrayContaining(req.evidence) });
    expect(check(await run(s, { requirements: [{ ...req, kind: 'allow-matching-label-colors' }] }), s, 'target').code).toBe('TEXT_BACKGROUND_MATCH_ALLOWED');
    for (const patch of [{ sessionId: 'other' }, { documentId: 'other' }, { nodeId: 'other' }, { label: [{ nodeId: 'other', text: 'same text' }] }]) {
      expect(check(await run(s, { requirements: [{ ...req, ...patch }] }), s, 'target').severity).toBe('warning');
    }
    const proposal = { schemaVersion: 1, status: 'proposed', ruleId: plan.ruleId, ruleVersion: plan.ruleVersion,
      target: { sessionId: s.inspection.sessionId, observationId: s.inspection.observationId, captureId: s.capture.id, documentId: req.documentId, nodeId: req.nodeId, instanceId: 'instance' },
      source: { kind: 'agent-judgment', agentId: 'future-agent', basis: 'inference' }, requirement: req.kind, label: req.label, reason: req.reason, evidence: req.evidence };
    expect(textBackgroundRequirementProposalSchema.parse(proposal)).toEqual(proposal);
    expect(ruleRequirementProposalSchema.parse(proposal)).toEqual(proposal);
    for (const input of [{ requirements: [proposal] }, { requirements: [{ ...req, ...proposal }] }, { requirements: [req, req] }, { channelTolerance: -1 }, { channelTolerance: 3 }, { provider: 'agent' }]) {
      expect(textBackgroundOptionsSchema.safeParse(input).success).toBe(false);
    }
    node(s, 'target').attributes!['data-colors-approved'] = 'true';
    expect(check(await run(s), s, 'target').severity).toBe('warning');
    expect(check(await run(s, { channelTolerance: 1 }), s, 'low-contrast').severity).toBe('warning');
  });
});

it('does not certify incomplete evidence, unknown backgrounds or unsettled/effected rendering', async () => {
  await setup(async (f, original) => {
    const variants: [string, (s: RulePage) => void, string][] = [
      ['legacy', s => { delete s.snapshot.dom!.paintEnvironment; }, 'TEXT_BACKGROUND_UNAVAILABLE'],
      ['forced colors', s => { s.snapshot.dom!.paintEnvironment!.forcedColors = true; }, 'TEXT_BACKGROUND_UNSUPPORTED'],
      ['missing paint', s => { delete node(s, 'target').paint; }, 'TEXT_BACKGROUND_UNAVAILABLE'],
      ['animation', s => { node(s, 'target').paint!.motion = 'running'; }, 'TEXT_BACKGROUND_UNAVAILABLE'],
      ['group opacity', s => { node(s, 'target').styles!.opacity = '.5'; }, 'TEXT_BACKGROUND_UNSUPPORTED'],
      ['blend', s => { node(s, 'target').styles!['mix-blend-mode'] = 'difference'; }, 'TEXT_BACKGROUND_UNSUPPORTED'],
      ['wide gamut', s => { node(s, 'target').styles!['-webkit-text-fill-color'] = 'color(display-p3 1 1 1)'; }, 'TEXT_BACKGROUND_UNSUPPORTED'],
      ['missing fill', s => { delete node(s, 'target').styles!['-webkit-text-fill-color']; }, 'TEXT_BACKGROUND_UNAVAILABLE'],
      ['unknown canvas', s => { for (const n of s.snapshot.dom!.nodes) if(n.styles) n.styles['background-color'] = 'rgba(0, 0, 0, 0)'; }, 'TEXT_BACKGROUND_UNAVAILABLE'],
      ['truncated field', s => { node(s, 'target').gaps.push({ code: 'FIELD_TRUNCATED', message: 'color' }); }, 'TEXT_BACKGROUND_UNAVAILABLE'],
    ];
    for (const [label, change, code] of variants) {
      const source = structuredClone(original); change(source);
      expect(check(await run(source), source, 'target'), label).toMatchObject({ code, verdict: 'unknown', severity: 'info' });
    }
  });
});

it('resolves only the same label and keeps the original capture immutable', async () => {
  await setup(async (f, original) => {
    const tracker = new TextBackgroundTracker(), first = await tracker.run(original);
    const issue = check(first, original, 'target').facts!.issueId;
    expect(await tracker.run(original)).toEqual(first);
    expect(check(await tracker.run(await f.inspect()), original, 'target')).toMatchObject({ severity: 'warning', facts: { issueId: issue } });
    await f.page.locator('#fix').click();
    const fixed = await tracker.run(await f.inspect());
    expect(check(fixed, original, 'target')).toMatchObject({ code: 'TEXT_BACKGROUND_RESTORED', verdict: 'pass', facts: { lifecycle: 'resolved', issueId: issue } });
    expect(check(await run(original), original, 'target').code).toBe('TEXT_BACKGROUND_MATCH');
  });
});

it.each(['text', 'node', 'scope'])('does not confuse a %s change with recovery', async mode => {
  await setup(async (f, original) => {
    const tracker = new TextBackgroundTracker(), first = await tracker.run(original), issue = check(first, original, 'target').facts!.issueId;
    if (mode === 'scope') await f.page.locator('#open').click();
    else await f.page.evaluate(mode => {
      const target = document.querySelector<HTMLButtonElement>('#target')!;
      if (mode === 'text') { target.textContent = '新的标签'; target.style.color = 'black'; }
      else { const clone = target.cloneNode(true) as HTMLButtonElement; clone.style.color = 'black'; target.replaceWith(clone); }
    }, mode);
    const next = await f.inspect();
    const report = await tracker.run(next);
    expect(report.checks.find(c => c.facts?.issueId === issue)).toMatchObject({ verdict: 'unknown', facts: { observationStatus: 'historical' } });
    if (mode === 'scope') {
      expect(check(report, next, 'modal-text').code).toBe('TEXT_BACKGROUND_MATCH');
    }
    expect((await tracker.run(await f.inspect())).checks.find(c => c.facts?.issueId === issue)?.facts?.lifecycle).not.toBe('resolved');
  });
});
