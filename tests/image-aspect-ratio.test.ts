import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserEngine, type Inspection } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { ImageAspectRatioTracker, RuleRunner, imageAspectRatioRule, imageAspectRatioOptionsSchema,
  imageAspectRatioRequirementProposalSchema, ruleRequirementProposalSchema, type CaptureReader, type RuleReport,
  type ImageAspectRatioRequirementProvider } from '@interaction/rules';
import { fixtureServer, pageOf } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const plan = { ruleId: imageAspectRatioRule.id, ruleVersion: imageAspectRatioRule.version };
const latest = (engine: BrowserEngine, sid: string) => engine.listInspections(sid).items.at(-1)!;
type Source = Awaited<ReturnType<CaptureReader['captureDetails']>>;
const node = (s: Source, id: string) => s.details!.snapshot!.dom!.nodes.find(n => n.attributes?.id === id)!;
const check = (r: RuleReport, s: Source, id: string) => r.checks.find(c => c.target?.nodeId === node(s, id).id)!;
async function setup(run: (engine: BrowserEngine, task: Inspection, source: Source) => Promise<void>) {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const session = await engine.createSession({ url: fixture.url + '/image-aspect-ratio.html', headless: true, viewport: { width: 1100, height: 800 },
      settleMs: 60, observeTimeoutMs: 1000, inspection: {}, evidenceRetention: { mode: 'persistent' } });
    const task = latest(engine, session.id); await run(engine, task, await engine.captureDetails(session.id, task.captureId));
  } finally { await engine.close(); }
}
const run = async (s: Source, task: Inspection, options = {}) => (await new RuleRunner([imageAspectRatioRule]).run({ captureDetails: async () => s }, task, [{ ...plan, options }]))[0];
const requirement = (s: Source, task: Inspection, kind: 'preserve-aspect-ratio' | 'allow-distortion' = 'preserve-aspect-ratio') => {
  const n = node(s, 'distorted'), image = n.image!;
  return { sessionId: task.sessionId, documentId: s.capture.documentId, nodeId: n.id, kind,
    resource: { currentSrc: image.currentSrc, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, loadEpoch: image.loadEpoch },
    reason: 'Fixture image must keep its circular shape', evidence: ['fixture-spec:circle/v1'] };
};

it('measures ordinary non-interactive images, real object-fit, content boxes and composed 2D transforms', async () => {
  await setup(async (engine, task, source) => {
    const before = structuredClone(source), report = await run(source, task);
    expect(source).toEqual(before);
    expect(source.details!.observation.controls.some(c => c.localId === node(source, 'distorted').id)).toBe(false);
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
    expect(engine.session(task.sessionId).actionCount).toBe(0);
    expect(await pageOf(engine).evaluate(() => scrollY)).toBe(0);
    const projected = await engine.dom(task.sessionId, task.observationId, { rootId: node(source, 'padding').id, fields: ['image'] });
    expect(projected.nodes[0].image).toEqual(node(source, 'padding').image);
    expect(projected.nodes[0].styles).toBeUndefined();
  });
});

it('enforces only explicit requirements bound to the session, node instance and selected resource', async () => {
  await setup(async (_engine, task, s) => {
    const strict = requirement(s, task);
    expect(check(await run(s, task, { requirements: [strict] }), s, 'distorted')).toMatchObject({ verdict: 'fail', severity: 'error', code: 'IMAGE_ASPECT_RATIO_REQUIREMENT_FAILED' });
    expect(check(await run(s, task, { requirements: [{ ...strict, kind: 'allow-distortion' }] }), s, 'distorted').code).toBe('IMAGE_DISTORTION_ALLOWED');
    for (const patch of [{ sessionId: 'other' }, { documentId: 'other' }, { nodeId: 'other' }, { resource: { ...strict.resource, currentSrc: 'other' } }, { resource: { ...strict.resource, naturalWidth: 123 } }, { resource: { ...strict.resource, loadEpoch: strict.resource.loadEpoch + 1 } }]) {
      expect(check(await run(s, task, { requirements: [{ ...strict, ...patch }] }), s, 'distorted').severity).toBe('warning');
    }
    node(s, 'distorted').attributes!['data-image-requirement'] = 'allow-distortion';
    expect(check(await run(s, task), s, 'distorted').severity).toBe('warning');
    const proposal = { schemaVersion: 1, status: 'proposed', ruleId: plan.ruleId, ruleVersion: plan.ruleVersion,
      target: { sessionId: task.sessionId, observationId: task.observationId, captureId: task.captureId, documentId: strict.documentId, nodeId: strict.nodeId, instanceId: strict.nodeId },
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
  await setup(async (_engine, task, original) => {
    const variants: [string, (s: Source) => void, string][] = [
      ['old image capture', s => { delete node(s, 'distorted').image; }, 'IMAGE_EVIDENCE_UNAVAILABLE'],
      ['loading', s => { node(s, 'distorted').image!.complete = false; }, 'IMAGE_LOADING'],
      ['motion', s => { node(s, 'distorted').image!.motion = 'running'; }, 'IMAGE_MOTION_UNSETTLED'],
      ['missing content box', s => { delete node(s, 'distorted').image!.contentBox; }, 'IMAGE_EVIDENCE_UNAVAILABLE'],
      ['nonfinite content', s => { node(s, 'distorted').image!.contentBox!.width = NaN; }, 'IMAGE_EVIDENCE_UNAVAILABLE'],
      ['unknown MIME', s => { s.details!.snapshot!.runtime.network = []; }, 'IMAGE_FORMAT_UNSUPPORTED'],
      ['replaced CSS content', s => { node(s, 'distorted').styles!.content = 'url("other.png")'; }, 'IMAGE_RENDERING_UNSUPPORTED'],
      ['missing styles', s => { delete node(s, 'distorted').styles!.transform; }, 'IMAGE_EVIDENCE_UNAVAILABLE'],
      ['degenerate transform', s => { node(s, 'distorted').styles!.transform = 'matrix(0,0,0,1,0,0)'; }, 'IMAGE_RENDERING_UNSUPPORTED'],
      ['truncated src', s => { node(s, 'distorted').gaps.push({ code: 'FIELD_TRUNCATED', message: 'image:currentSrc' }); }, 'IMAGE_EVIDENCE_UNAVAILABLE'],
    ];
    for (const [label, change, code] of variants) {
      const s = structuredClone(original); change(s);
      expect(check(await run(s, task), s, 'distorted'), label).toMatchObject({ verdict: 'unknown', severity: 'info', code });
    }
    const runner = new RuleRunner([imageAspectRatioRule]);
    const result = await runner.run({ captureDetails: async () => original }, task, [{ ...plan, targets: [{ captureId: 'foreign', nodeId: node(original, 'distorted').id }] }]);
    expect(result[0].checks[0].code).toBe('TARGET_UNAVAILABLE');
    const wrong = await runner.run({ captureDetails: async () => original }, task, [{ ...plan, targets: [{ captureId: task.captureId, nodeId: node(original, 'fix').id }] }]);
    expect(wrong[0].checks[0].code).toBe('TARGET_UNAVAILABLE');
    expect((await runner.run({ captureDetails: async () => original }, task, [{ ...plan, targets: [] }]))[0].checks[0].code).toBe('NO_TARGETS');
    const tiny = structuredClone(original); node(tiny, 'distorted').image!.contentBox = { width: 160.1, height: 80 };
    expect(check(await run(tiny, task), tiny, 'distorted').verdict).toBe('pass');
    expect(check(await run(tiny, task, { relativeTolerance: 0 }), tiny, 'distorted').severity).toBe('warning');
  });
});

it('resolves a measured recovery but never upgrades repeated warnings or treats a replacement as recovery', async () => {
  await setup(async (engine, task, original) => {
    const tracker = new ImageAspectRatioTracker();
    const first = await tracker.run(engine, task), issue = check(first, original, 'distorted').facts!.issueId;
    expect(await tracker.run(engine, task)).toEqual(first);
    await engine.observe(task.sessionId); let next = latest(engine, task.sessionId);
    const second = await tracker.run(engine, next);
    expect(check(second, original, 'distorted')).toMatchObject({ severity: 'warning', facts: { issueId: issue } });
    await pageOf(engine).locator('#fix').click(); await engine.observe(task.sessionId); next = latest(engine, task.sessionId);
    const fixed = await tracker.run(engine, next);
    expect(check(fixed, original, 'distorted')).toMatchObject({ verdict: 'pass', code: 'IMAGE_ASPECT_RATIO_RESTORED', facts: { lifecycle: 'resolved', issueId: issue } });
    expect(check(await run(original, task), original, 'distorted').code).toBe('IMAGE_NON_UNIFORM_SCALING');
    await expect(tracker.run(engine, task)).rejects.toThrow('TRACKER_OUT_OF_ORDER');
    await expect(tracker.run(engine, { ...next, sessionId: 'foreign' })).rejects.toThrow('TRACKER_SESSION_MISMATCH');
  });
});

it.each(['replace-node', 'replace-resource', 'reload-same-resource', 'close-scope'])('preserves the historical finding after %s', async mode => {
  await setup(async (engine, task, original) => {
    const tracker = new ImageAspectRatioTracker();
    const first = await tracker.run(engine, task), issue = check(first, original, 'distorted').facts!.issueId;
    if (mode === 'replace-node') await pageOf(engine).evaluate(() => {
      const el = document.querySelector<HTMLImageElement>('#distorted')!, clone = el.cloneNode() as HTMLImageElement;
      clone.style.width = '160px'; el.replaceWith(clone);
    });
    if (mode === 'replace-resource') {
      await pageOf(engine).evaluate(async () => { const el = document.querySelector<HTMLImageElement>('#distorted')!; el.src = '/aspect-ratio-1x1.png'; await el.decode(); });
    }
    if (mode === 'reload-same-resource') {
      await pageOf(engine).evaluate(async () => {
        const el = document.querySelector<HTMLImageElement>('#distorted')!;
        const loaded = new Promise<void>(resolve => el.addEventListener('load', () => resolve(), { once: true }));
        el.src = el.src; el.style.width = '160px'; await loaded;
      });
    }
    if (mode === 'close-scope') await pageOf(engine).locator('#open').click();
    await engine.observe(task.sessionId); const next = latest(engine, task.sessionId);
    const report = await tracker.run(engine, next);
    expect(report.checks.find(c => c.facts?.issueId === issue)).toMatchObject({ code: 'IMAGE_FINDING_NOT_RECHECKED', verdict: 'unknown', facts: { observationStatus: 'historical' } });
    if (mode === 'close-scope') {
      const current = await engine.captureDetails(task.sessionId, next.captureId);
      expect(check(report, current, 'modal-image')).toMatchObject({ code: 'IMAGE_NON_UNIFORM_SCALING', severity: 'warning' });
    } else expect(report.checks.some(c => c.verdict === 'pass' && c.facts?.label === '压扁的图片')).toBe(true);
    await engine.observe(task.sessionId);
    const again = await tracker.run(engine, latest(engine, task.sessionId));
    expect(again.checks.find(c => c.facts?.issueId === issue)?.code).toBe('IMAGE_FINDING_NOT_RECHECKED');
  });
});
