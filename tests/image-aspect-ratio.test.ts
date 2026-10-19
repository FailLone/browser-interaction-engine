import { afterAll, beforeAll, expect, it } from 'vitest';
import { ImageAspectRatioTracker, RuleRunner, imageAspectRatioRule, imageAspectRatioOptionsSchema,
  imageAspectRatioRequirementProposalSchema, ruleRequirementProposalSchema, type RulePage, type RuleReport,
  type ImageAspectRatioRequirementProvider } from '@interaction/rules';
import { fixtureServer, withFixture, type RuleFixture } from './rule-fixture.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const plan = { ruleId: imageAspectRatioRule.id, ruleVersion: imageAspectRatioRule.version };
const node = (s: RulePage, id: string) => s.snapshot.dom!.nodes.find(n => n.attributes?.id === id)!;
const check = (r: RuleReport, s: RulePage, id: string) => r.checks.find(c => c.target?.nodeId === node(s, id).id)!;
async function setup(fn: (f: RuleFixture, page: RulePage) => Promise<void>) {
  await withFixture(fixture.url + '/image-aspect-ratio.html', fn, { width: 1100, height: 800 });
}
const run = async (s: RulePage, options = {}) => (await new RuleRunner([imageAspectRatioRule]).run(s, [{ ...plan, options }]))[0];
const requirement = (s: RulePage, kind: 'preserve-aspect-ratio' | 'allow-distortion' = 'preserve-aspect-ratio') => {
  const n = node(s, 'distorted'), image = n.image!;
  return { sessionId: s.inspection.sessionId, documentId: s.capture.documentId, nodeId: n.id, kind,
    resource: { currentSrc: image.currentSrc, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, loadEpoch: image.loadEpoch },
    reason: 'Fixture image must keep its circular shape', evidence: ['fixture-spec:circle/v1'] };
};

it('measures ordinary non-interactive images, real object-fit, content boxes and composed 2D transforms', async () => {
  await setup(async (f, source) => {
    const before = structuredClone(source), report = await run(source);
    expect(source).toEqual(before);
    expect(source.observation.controls.some(c => c.localId === node(source, 'distorted').id)).toBe(false);
    for (const id of ['distorted', 'ancestor', 'shear', 'contain-stretch']) expect(check(report, source, id), id).toMatchObject({ code: 'IMAGE_NON_UNIFORM_SCALING', severity: 'warning', verdict: 'unknown', facts: { observationStatus: 'current' } });
    expect(check(report, source, 'distorted').facts!.stretchRatio).toBe(2);
    for (const id of ['healthy', 'contain', 'cover', 'none', 'scale-down', 'padding', 'rotate', 'cancel', 'compensate', 'density', 'fractional', 'flip']) {
      expect(check(report, source, id), id).toMatchObject({ verdict: 'pass', code: 'IMAGE_ASPECT_RATIO_PRESERVED' });
    }
    expect(check(report, source, 'padding').facts!.contentBox).toEqual({ width: 160, height: 80 });
    expect(node(source, 'density').image).toMatchObject({ naturalWidth: 100, naturalHeight: 50 });
    for (const id of ['hidden', 'transparent', 'modal-image']) expect(check(report, source, id), id).toMatchObject({ verdict: 'not-applicable' });
    for (const id of ['vector', 'three-d', 'independent']) expect(check(report, source, id), id).toMatchObject({ verdict: 'unknown', severity: 'info', facts: { observationStatus: 'unsupported' } });
    expect(check(report, source, 'broken')).toMatchObject({ code: 'IMAGE_RESOURCE_UNAVAILABLE', verdict: 'unknown', severity: 'info' });
    expect(await f.page.evaluate(() => scrollY)).toBe(0);
  });
});

it('enforces only explicit requirements bound to the session, node instance and selected resource', async () => {
  await setup(async (_f, s) => {
    const strict = requirement(s);
    expect(check(await run(s, { requirements: [strict] }), s, 'distorted')).toMatchObject({ verdict: 'fail', severity: 'error', code: 'IMAGE_ASPECT_RATIO_REQUIREMENT_FAILED' });
    expect(check(await run(s, { requirements: [{ ...strict, kind: 'allow-distortion' }] }), s, 'distorted').code).toBe('IMAGE_DISTORTION_ALLOWED');
    for (const patch of [{ sessionId: 'other' }, { documentId: 'other' }, { nodeId: 'other' }, { resource: { ...strict.resource, currentSrc: 'other' } }, { resource: { ...strict.resource, naturalWidth: 123 } }, { resource: { ...strict.resource, loadEpoch: strict.resource.loadEpoch + 1 } }]) {
      expect(check(await run(s, { requirements: [{ ...strict, ...patch }] }), s, 'distorted').severity).toBe('warning');
    }
    node(s, 'distorted').attributes!['data-image-requirement'] = 'allow-distortion';
    expect(check(await run(s), s, 'distorted').severity).toBe('warning');
    const proposal = { schemaVersion: 1, status: 'proposed', ruleId: plan.ruleId, ruleVersion: plan.ruleVersion,
      target: { sessionId: s.inspection.sessionId, observationId: s.inspection.observationId, captureId: s.capture.id, documentId: strict.documentId, nodeId: strict.nodeId, instanceId: strict.nodeId },
      source: { kind: 'agent-judgment', agentId: 'future-agent', basis: 'inference' }, resource: strict.resource,
      requirement: 'preserve-aspect-ratio', reason: strict.reason, evidence: strict.evidence };
    expect(ruleRequirementProposalSchema.parse(proposal)).toEqual(proposal);
    const provider: ImageAspectRatioRequirementProvider = { id: 'future', version: '1', propose: async () => [imageAspectRatioRequirementProposalSchema.parse(proposal)] };
    expect(provider.id).toBe('future');
    for (const input of [{ requirements: [proposal] }, { requirements: [{ ...strict, ...proposal }] }, { requirements: [strict, strict] }, { provider }, { relativeTolerance: -1 }, { relativeTolerance: Infinity }]) {
      expect(imageAspectRatioOptionsSchema.safeParse(input).success).toBe(false);
    }
    expect(imageAspectRatioRequirementProposalSchema.safeParse({ ...proposal, resource: undefined }).success).toBe(false);
  });
});

it('keeps missing, legacy, loading, animated, complex and truncated evidence distinct from healthy results', async () => {
  await setup(async (_f, original) => {
    const variants: [string, (s: RulePage) => void, string][] = [
      ['old image capture', s => { delete node(s, 'distorted').image; }, 'IMAGE_EVIDENCE_UNAVAILABLE'],
      ['loading', s => { node(s, 'distorted').image!.complete = false; }, 'IMAGE_LOADING'],
      ['motion', s => { node(s, 'distorted').image!.motion = 'running'; }, 'IMAGE_MOTION_UNSETTLED'],
      ['missing content box', s => { delete node(s, 'distorted').image!.contentBox; }, 'IMAGE_EVIDENCE_UNAVAILABLE'],
      ['nonfinite content', s => { node(s, 'distorted').image!.contentBox!.width = NaN; }, 'IMAGE_EVIDENCE_UNAVAILABLE'],
      ['unknown MIME', s => { s.snapshot.runtime.network = []; }, 'IMAGE_FORMAT_UNSUPPORTED'],
      ['replaced CSS content', s => { node(s, 'distorted').styles!.content = 'url("other.png")'; }, 'IMAGE_RENDERING_UNSUPPORTED'],
      ['missing styles', s => { delete node(s, 'distorted').styles!.transform; }, 'IMAGE_EVIDENCE_UNAVAILABLE'],
      ['degenerate transform', s => { node(s, 'distorted').styles!.transform = 'matrix(0,0,0,1,0,0)'; }, 'IMAGE_RENDERING_UNSUPPORTED'],
      ['truncated src', s => { node(s, 'distorted').gaps.push({ code: 'FIELD_TRUNCATED', message: 'image:currentSrc' }); }, 'IMAGE_EVIDENCE_UNAVAILABLE'],
    ];
    for (const [label, change, code] of variants) {
      const s = structuredClone(original); change(s);
      expect(check(await run(s), s, 'distorted'), label).toMatchObject({ verdict: 'unknown', severity: 'info', code });
    }
    const runner = new RuleRunner([imageAspectRatioRule]);
    const result = await runner.run(original, [{ ...plan, targets: [{ captureId: 'foreign', nodeId: node(original, 'distorted').id }] }]);
    expect(result[0].checks[0].code).toBe('TARGET_UNAVAILABLE');
    const wrong = await runner.run(original, [{ ...plan, targets: [{ captureId: original.capture.id, nodeId: node(original, 'fix').id }] }]);
    expect(wrong[0].checks[0].code).toBe('TARGET_UNAVAILABLE');
    expect((await runner.run(original, [{ ...plan, targets: [] }]))[0].checks[0].code).toBe('NO_TARGETS');
    const tiny = structuredClone(original); node(tiny, 'distorted').image!.contentBox = { width: 160.1, height: 80 };
    expect(check(await run(tiny), tiny, 'distorted').verdict).toBe('pass');
    expect(check(await run(tiny, { relativeTolerance: 0 }), tiny, 'distorted').severity).toBe('warning');
  });
});

it('resolves a measured recovery but never upgrades repeated warnings or treats a replacement as recovery', async () => {
  await setup(async (f, original) => {
    const tracker = new ImageAspectRatioTracker();
    const first = await tracker.run(original), issue = check(first, original, 'distorted').facts!.issueId;
    expect(await tracker.run(original)).toEqual(first);
    const second = await tracker.run(await f.inspect());
    expect(check(second, original, 'distorted')).toMatchObject({ severity: 'warning', facts: { issueId: issue } });
    await f.page.locator('#fix').click(); const next = await f.inspect();
    const fixed = await tracker.run(next);
    expect(check(fixed, original, 'distorted')).toMatchObject({ verdict: 'pass', code: 'IMAGE_ASPECT_RATIO_RESTORED', facts: { lifecycle: 'resolved', issueId: issue } });
    expect(check(await run(original), original, 'distorted').code).toBe('IMAGE_NON_UNIFORM_SCALING');
    await expect(tracker.run(original)).rejects.toThrow('TRACKER_OUT_OF_ORDER');
    await expect(tracker.run({ ...next, inspection: { ...next.inspection, sessionId: 'foreign' } })).rejects.toThrow('TRACKER_SESSION_MISMATCH');
  });
});

it.each(['replace-node', 'replace-resource', 'reload-same-resource', 'close-scope'])('preserves the historical finding after %s', async mode => {
  await setup(async (f, original) => {
    const tracker = new ImageAspectRatioTracker();
    const first = await tracker.run(original), issue = check(first, original, 'distorted').facts!.issueId;
    if (mode === 'replace-node') await f.page.evaluate(() => {
      const el = document.querySelector<HTMLImageElement>('#distorted')!, clone = el.cloneNode() as HTMLImageElement;
      clone.style.width = '160px'; el.replaceWith(clone);
    });
    if (mode === 'replace-resource') {
      await f.page.evaluate(async () => { const el = document.querySelector<HTMLImageElement>('#distorted')!; el.src = '/aspect-ratio-1x1.png'; await el.decode(); });
    }
    if (mode === 'reload-same-resource') {
      await f.page.evaluate(async () => {
        const el = document.querySelector<HTMLImageElement>('#distorted')!;
        const loaded = new Promise<void>(resolve => el.addEventListener('load', () => resolve(), { once: true }));
        el.src = el.src; el.style.width = '160px'; await loaded;
      });
    }
    if (mode === 'close-scope') await f.page.locator('#open').click();
    const next = await f.inspect();
    const report = await tracker.run(next);
    expect(report.checks.find(c => c.facts?.issueId === issue)).toMatchObject({ code: 'IMAGE_FINDING_NOT_RECHECKED', verdict: 'unknown', facts: { observationStatus: 'historical' } });
    if (mode === 'close-scope') {
      expect(check(report, next, 'modal-image')).toMatchObject({ code: 'IMAGE_NON_UNIFORM_SCALING', severity: 'warning' });
    } else expect(report.checks.some(c => c.verdict === 'pass' && c.facts?.label === '压扁的图片')).toBe(true);
    const again = await tracker.run(await f.inspect());
    expect(again.checks.find(c => c.facts?.issueId === issue)?.code).toBe('IMAGE_FINDING_NOT_RECHECKED');
  });
});
