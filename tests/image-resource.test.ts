import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BrowserEngine, type Inspection } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { ImageResourceTracker, RuleRunner, imageResourceRule, imageResourceOptionsSchema, imageResourceRequirementProposalSchema,
  ruleRequirementProposalSchema, type CaptureReader, type RuleReport, type ImageResourceRequirementProvider } from '@interaction/rules';
import { fixtureServer, pageOf } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const plan = { ruleId: imageResourceRule.id, ruleVersion: imageResourceRule.version };
const latest = (e: BrowserEngine, id: string) => e.listInspections(id).items.at(-1)!;
type Source = Awaited<ReturnType<CaptureReader['captureDetails']>>;
const node = (s: Source, id: string) => s.details!.snapshot!.dom!.nodes.find(n => n.attributes?.id === id)!;
const check = (r: RuleReport, s: Source, id: string) => r.checks.find(c => c.target?.nodeId === node(s, id).id)!;
const run = async (s: Source, task: Inspection, options = {}) => (await new RuleRunner([imageResourceRule]).run({ captureDetails: async () => s }, task, [{ ...plan, options }]))[0];
async function setup(fn: (engine: BrowserEngine, task: Inspection, source: Source) => Promise<void>) {
  const e = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await e.createSession({ url: fixture.url + '/image-resource.html', headless: true, viewport: { width: 1100, height: 800 },
      settleMs: 80, observeTimeoutMs: 1200, inspection: {}, evidenceRetention: { mode: 'persistent' } });
    const task = latest(e, s.id); await fn(e, task, await e.captureDetails(s.id, task.captureId));
  } finally { await e.close(); }
}
const requirement = (s: Source, t: Inspection) => ({ sessionId: t.sessionId, documentId: s.capture.documentId, nodeId: node(s, 'broken').id,
  resource: { currentSrc: node(s, 'broken').image!.currentSrc, sourceKey: node(s, 'broken').image!.resource!.sourceKey },
  kind: 'no-image-load-error', reason: 'This image must not have a native load error', evidence: ['fixture:required-image'] });

it('distinguishes native errors, selected responsive sources, successful zero-size SVG, missing sources and lazy requests without actions', async () => {
  await setup(async (e, t, s) => {
    const original = structuredClone(s), r = await run(s, t);
    for (const id of ['broken', 'corrupt', 'picture', 'responsive', 'decorative']) {
      expect(check(r, s, id), id).toMatchObject({ code: 'IMAGE_RESOURCE_LOAD_FAILED', verdict: 'unknown', severity: 'warning', facts: { event: 'error', observationStatus: 'current' } });
    }
    for (const id of ['healthy', 'picture-good', 'vector']) expect(check(r, s, id), id).toMatchObject({ code: 'IMAGE_RESOURCE_AVAILABLE', verdict: 'pass' });
    expect(node(s, 'vector').image).toMatchObject({ naturalWidth: 0, naturalHeight: 0, resource: { event: 'load' } });
    for (const id of ['absent', 'empty']) expect(check(r, s, id).code).toBe('IMAGE_SOURCE_ABSENT');
    expect(check(r, s, 'lazy')).toMatchObject({ code: 'IMAGE_RESOURCE_PENDING', severity: 'info' });
    expect(s.details!.snapshot!.runtime.network.some(n => n.url.endsWith('/image-resource-lazy.png'))).toBe(false);
    for (const id of ['hidden', 'modal-image']) expect(check(r, s, id).code).toBe('IMAGE_NOT_RENDERED');
    expect(check(r, s, 'css')).toMatchObject({ code: 'IMAGE_RESOURCE_RENDERING_UNSUPPORTED', facts: { observationStatus: 'unsupported' } });
    expect(s).toEqual(original); expect(e.session(t.sessionId).actionCount).toBe(0);
    expect(await pageOf(e).evaluate(() => scrollY)).toBe(0);
  });
});

it('applies only explicitly bound host requirements, exports inert provider interfaces, and ignores page claims', async () => {
  await setup(async (_e, t, s) => {
    const req = requirement(s, t);
    expect(check(await run(s, t, { requirements: [req] }), s, 'broken')).toMatchObject({ code: 'IMAGE_RESOURCE_REQUIREMENT_FAILED', severity: 'error', verdict: 'fail', evidence: expect.arrayContaining(req.evidence) });
    expect(check(await run(s, t, { requirements: [{ ...req, kind: 'allow-unavailable-image' }] }), s, 'broken').code).toBe('IMAGE_UNAVAILABILITY_ALLOWED');
    for (const patch of [{ sessionId: 'other' }, { documentId: 'other' }, { nodeId: 'other' }, { resource: { ...req.resource, currentSrc: 'other' } }, { resource: { ...req.resource, sourceKey: 'other' } }]) {
      expect(check(await run(s, t, { requirements: [{ ...req, ...patch }] }), s, 'broken').severity).toBe('warning');
    }
    node(s, 'broken').attributes!['data-image-optional'] = 'true';
    expect(check(await run(s, t), s, 'broken').severity).toBe('warning');
    const proposal = { schemaVersion: 1, status: 'proposed', ...plan, ruleId: plan.ruleId, ruleVersion: plan.ruleVersion,
      target: { sessionId: t.sessionId, observationId: t.observationId, captureId: t.captureId, documentId: req.documentId, nodeId: req.nodeId, instanceId: req.nodeId },
      source: { kind: 'agent-judgment', agentId: 'future', basis: 'inference' }, resource: req.resource,
      requirement: req.kind, reason: req.reason, evidence: req.evidence };
    expect(ruleRequirementProposalSchema.parse(proposal)).toEqual(proposal);
    const provider: ImageResourceRequirementProvider = { id: 'future', version: '1', propose: async () => [imageResourceRequirementProposalSchema.parse(proposal)] };
    for (const input of [{ requirements: [proposal] }, { requirements: [{ ...req, ...proposal }] }, { requirements: [req, req] }, { provider }]) expect(imageResourceOptionsSchema.safeParse(input).success).toBe(false);
  });
});

it('never treats incomplete, conflicting or legacy evidence and unfinished retries as a load failure', async () => {
  await setup(async (_e, t, source) => {
    const variants: [(s: Source) => void, string][] = [
      [s => { delete node(s, 'broken').image!.resource; }, 'IMAGE_RESOURCE_EVIDENCE_MISSING'],
      [s => { node(s, 'broken').image!.resource!.event = 'unobserved'; node(s, 'broken').image!.resource!.eventSequence = 0; }, 'IMAGE_RESOURCE_STATE_UNCERTAIN'],
      [s => { node(s, 'broken').image!.complete = false; }, 'IMAGE_RESOURCE_PENDING'],
      [s => { node(s, 'broken').image!.naturalWidth = 100; }, 'IMAGE_RESOURCE_STATE_UNCERTAIN'],
      [s => { node(s, 'broken').image!.naturalWidth = NaN; }, 'IMAGE_RESOURCE_EVIDENCE_MISSING'],
      [s => { node(s, 'broken').gaps.push({ code: 'FIELD_TRUNCATED', message: 'image:sourceKey' }); }, 'IMAGE_RESOURCE_EVIDENCE_MISSING'],
    ];
    for (const [edit, code] of variants) { const s = structuredClone(source); edit(s); expect(check(await run(s, t), s, 'broken')).toMatchObject({ code, severity: 'info', verdict: 'unknown' }); }
    // Neither a 200 response nor a missing network history overrides native errors.
    source.details!.snapshot!.runtime.network = [];
    expect(check(await run(source, t), source, 'broken').code).toBe('IMAGE_RESOURCE_LOAD_FAILED');
  });
});

it('ignores forged load/error events and does not reuse an old native event after source declarations change', async () => {
  await setup(async (e, t, original) => {
    await pageOf(e).evaluate(() => {
      document.querySelector('#broken')!.dispatchEvent(new Event('load'));
      document.querySelector('#healthy')!.dispatchEvent(new Event('error'));
      const img = document.querySelector<HTMLImageElement>('#broken')!;
      img.crossOrigin = 'anonymous'; // A new source binding, even while currentSrc still refers to the same URL.
    });
    await e.observe(t.sessionId); const next = latest(e, t.sessionId), s = await e.captureDetails(t.sessionId, next.captureId);
    expect(check(await run(s, next), s, 'healthy').code).toBe('IMAGE_RESOURCE_AVAILABLE');
    expect(node(s, 'broken').image!.resource!.sourceKey).not.toBe(node(original, 'broken').image!.resource!.sourceKey);
    expect(node(s, 'broken').image!.resource!.event).not.toBe('load');
    // Immediately after changing a declaration, the previous event cannot bind.
    const immediate = await pageOf(e).evaluate(() => {
      const el = document.querySelector<HTMLImageElement>('#broken')!; el.setAttribute('sizes', '111px');
      return (window as any).__interactionImageResources.read(el);
    });
    expect(immediate.event).toBe('unobserved');
    await e.observe(t.sessionId); const changed = latest(e, t.sessionId), current = await e.captureDetails(t.sessionId, changed.captureId);
    const nextEvent = node(current, 'broken').image!.resource!;
    // Chromium may already have retried and failed again by the next capture.
    if (nextEvent.event === 'error') expect(nextEvent.eventSequence).toBeGreaterThan(node(s, 'broken').image!.resource!.eventSequence);
    else expect(check(await run(current, changed), current, 'broken').severity).toBe('info');
  });
});

it('keeps a pending replacement with old intrinsic dimensions inconclusive, and discards an error after a successful fallback', async () => {
  await setup(async (e, t) => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    await pageOf(e).route('**/image-resource-delayed.png', async route => { await gate; await route.fulfill({ contentType: 'image/png', body: readFileSync('apps/test-site/public/aspect-ratio-2x1.png') }); });
    try {
      await pageOf(e).evaluate(() => { document.querySelector<HTMLImageElement>('#healthy')!.src = '/image-resource-delayed.png'; });
      await e.observe(t.sessionId); const task = latest(e, t.sessionId), pending = await e.captureDetails(t.sessionId, task.captureId);
      expect(check(await run(pending, task), pending, 'healthy')).toMatchObject({ code: 'IMAGE_RESOURCE_PENDING', severity: 'info' });
    } finally { release(); }
    await pageOf(e).evaluate(async () => {
      const img = document.querySelector<HTMLImageElement>('#broken')!;
      const loaded = new Promise<void>(resolve => img.addEventListener('load', () => resolve(), { once: true }));
      img.onerror = () => { img.onerror = null; img.src = '/aspect-ratio-2x1.png'; };
      img.setAttribute('src', img.getAttribute('src')!); await loaded;
    });
    await e.observe(t.sessionId); const task = latest(e, t.sessionId), fallback = await e.captureDetails(t.sessionId, task.captureId);
    expect(check(await run(fallback, task), fallback, 'broken')).toMatchObject({ code: 'IMAGE_RESOURCE_AVAILABLE', facts: { event: 'load' } });
  });
});

it('resolves the same source after a later successful retry, without upgrading repeated failures or altering history', async () => {
  await setup(async (e, t, original) => {
    const tracker = new ImageResourceTracker(), first = await tracker.run(e, t), issue = check(first, original, 'broken').facts!.issueId;
    expect(await tracker.run(e, t)).toEqual(first);
    await e.observe(t.sessionId); const repeat = await tracker.run(e, latest(e, t.sessionId));
    expect(check(repeat, original, 'broken')).toMatchObject({ severity: 'warning', facts: { issueId: issue } });
    await pageOf(e).route('**/image-resource-missing.png', route => route.fulfill({ contentType: 'image/png', body: readFileSync('apps/test-site/public/aspect-ratio-2x1.png') }));
    await pageOf(e).locator('#retry').click();
    await pageOf(e).waitForFunction(() => document.querySelector<HTMLImageElement>('#broken')!.naturalWidth > 0);
    await e.observe(t.sessionId); const next = latest(e, t.sessionId), recovered = await tracker.run(e, next);
    expect(check(recovered, original, 'broken')).toMatchObject({ code: 'IMAGE_RESOURCE_RESTORED', verdict: 'pass', facts: { issueId: issue, lifecycle: 'resolved' } });
    expect(check(await run(original, t), original, 'broken').code).toBe('IMAGE_RESOURCE_LOAD_FAILED');
    await expect(tracker.run(e, t)).rejects.toThrow('TRACKER_OUT_OF_ORDER');
    await expect(tracker.run(e, { ...next, sessionId: 'other' })).rejects.toThrow('TRACKER_SESSION_MISMATCH');
  });
});

it.each(['replace-node', 'fallback', 'close-scope', 'rename', 'missing-event'])('preserves the original finding after %s', async mode => {
  await setup(async (e, t, original) => {
    const tracker = new ImageResourceTracker(), first = await tracker.run(e, t), issue = check(first, original, 'broken').facts!.issueId;
    if (mode === 'fallback') await pageOf(e).locator('#fallback').click();
    if (mode === 'replace-node') await pageOf(e).evaluate(() => { const img = document.querySelector('#broken')!; img.replaceWith(img.cloneNode()); });
    if (mode === 'rename') await pageOf(e).evaluate(() => { document.querySelector('#broken')!.setAttribute('alt', 'Another entity'); });
    if (mode === 'close-scope') await pageOf(e).locator('#open').click();
    await e.observe(t.sessionId); const next = latest(e, t.sessionId), s = await e.captureDetails(t.sessionId, next.captureId);
    if (mode === 'missing-event') { node(s, 'broken').image!.resource!.event = 'unobserved'; node(s, 'broken').image!.resource!.eventSequence = 0; }
    const report = await tracker.run({ captureDetails: async () => s }, next);
    expect(report.checks.find(c => c.facts?.issueId === issue)).toMatchObject({ code: 'IMAGE_RESOURCE_NOT_RECHECKED', verdict: 'unknown', facts: { observationStatus: 'historical' } });
    expect(report.checks.some(c => c.code === 'IMAGE_RESOURCE_RESTORED')).toBe(false);
    if (mode === 'close-scope') expect(check(report, s, 'modal-image').code).toBe('IMAGE_RESOURCE_LOAD_FAILED');
    if (mode === 'fallback') expect(check(report, s, 'broken').code).toBe('IMAGE_RESOURCE_AVAILABLE');
  });
});
