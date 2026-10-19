import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ImageResourceTracker, RuleRunner, imageResourceRule, imageResourceOptionsSchema, imageResourceRequirementProposalSchema,
  ruleRequirementProposalSchema, type RulePage, type RuleReport, type ImageResourceRequirementProvider } from '@interaction/rules';
import { fixtureServer, withFixture, type RuleFixture } from './rule-fixture.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const plan = { ruleId: imageResourceRule.id, ruleVersion: imageResourceRule.version };
const node = (s: RulePage, id: string) => s.snapshot.dom!.nodes.find(n => n.attributes?.id === id)!;
const check = (r: RuleReport, s: RulePage, id: string) => r.checks.find(c => c.target?.nodeId === node(s, id).id)!;
const run = async (s: RulePage, options = {}) => (await new RuleRunner([imageResourceRule]).run(s, [{ ...plan, options }]))[0];
async function setup(fn: (f: RuleFixture, source: RulePage) => Promise<void>) {
  await withFixture(fixture.url + '/image-resource.html', async (f, first) => { await f.settle(80); await fn(f, first); }, { width: 1100, height: 800 });
}
const requirement = (s: RulePage) => ({ sessionId: s.inspection.sessionId, documentId: s.capture.documentId, nodeId: node(s, 'broken').id,
  resource: { currentSrc: node(s, 'broken').image!.currentSrc, sourceKey: node(s, 'broken').image!.resource!.sourceKey },
  kind: 'no-image-load-error', reason: 'This image must not have a native load error', evidence: ['fixture:required-image'] });

it('distinguishes native errors, selected responsive sources, successful zero-size SVG, missing sources and lazy requests without actions', async () => {
  await setup(async (f, s) => {
    const original = structuredClone(s), r = await run(s);
    for (const id of ['broken', 'corrupt', 'picture', 'responsive', 'decorative']) {
      expect(check(r, s, id), id).toMatchObject({ code: 'IMAGE_RESOURCE_LOAD_FAILED', verdict: 'unknown', severity: 'warning', facts: { event: 'error', observationStatus: 'current' } });
    }
    for (const id of ['healthy', 'picture-good', 'vector']) expect(check(r, s, id), id).toMatchObject({ code: 'IMAGE_RESOURCE_AVAILABLE', verdict: 'pass' });
    expect(node(s, 'vector').image).toMatchObject({ naturalWidth: 0, naturalHeight: 0, resource: { event: 'load' } });
    for (const id of ['absent', 'empty']) expect(check(r, s, id).code).toBe('IMAGE_SOURCE_ABSENT');
    expect(check(r, s, 'lazy')).toMatchObject({ code: 'IMAGE_RESOURCE_PENDING', severity: 'info' });
    expect(s.snapshot.runtime.network.some(n => n.url.endsWith('/image-resource-lazy.png'))).toBe(false);
    for (const id of ['hidden', 'modal-image']) expect(check(r, s, id).code).toBe('IMAGE_NOT_RENDERED');
    expect(check(r, s, 'css')).toMatchObject({ code: 'IMAGE_RESOURCE_RENDERING_UNSUPPORTED', facts: { observationStatus: 'unsupported' } });
    expect(s).toEqual(original);
    expect(await f.page.evaluate(() => scrollY)).toBe(0);
  });
});

it('applies only explicitly bound host requirements, exports inert provider interfaces, and ignores page claims', async () => {
  await setup(async (f, s) => {
    const req = requirement(s);
    expect(check(await run(s, { requirements: [req] }), s, 'broken')).toMatchObject({ code: 'IMAGE_RESOURCE_REQUIREMENT_FAILED', severity: 'error', verdict: 'fail', evidence: expect.arrayContaining(req.evidence) });
    expect(check(await run(s, { requirements: [{ ...req, kind: 'allow-unavailable-image' }] }), s, 'broken').code).toBe('IMAGE_UNAVAILABILITY_ALLOWED');
    for (const patch of [{ sessionId: 'other' }, { documentId: 'other' }, { nodeId: 'other' }, { resource: { ...req.resource, currentSrc: 'other' } }, { resource: { ...req.resource, sourceKey: 'other' } }]) {
      expect(check(await run(s, { requirements: [{ ...req, ...patch }] }), s, 'broken').severity).toBe('warning');
    }
    node(s, 'broken').attributes!['data-image-optional'] = 'true';
    expect(check(await run(s), s, 'broken').severity).toBe('warning');
    const proposal = { schemaVersion: 1, status: 'proposed', ...plan, ruleId: plan.ruleId, ruleVersion: plan.ruleVersion,
      target: { sessionId: s.inspection.sessionId, observationId: s.inspection.observationId, captureId: s.capture.id, documentId: req.documentId, nodeId: req.nodeId, instanceId: req.nodeId },
      source: { kind: 'agent-judgment', agentId: 'future', basis: 'inference' }, resource: req.resource,
      requirement: req.kind, reason: req.reason, evidence: req.evidence };
    expect(ruleRequirementProposalSchema.parse(proposal)).toEqual(proposal);
    const provider: ImageResourceRequirementProvider = { id: 'future', version: '1', propose: async () => [imageResourceRequirementProposalSchema.parse(proposal)] };
    for (const input of [{ requirements: [proposal] }, { requirements: [{ ...req, ...proposal }] }, { requirements: [req, req] }, { provider }]) expect(imageResourceOptionsSchema.safeParse(input).success).toBe(false);
  });
});

it('never treats incomplete, conflicting or legacy evidence and unfinished retries as a load failure', async () => {
  await setup(async (f, source) => {
    const variants: [(s: RulePage) => void, string][] = [
      [s => { delete node(s, 'broken').image!.resource; }, 'IMAGE_RESOURCE_EVIDENCE_MISSING'],
      [s => { node(s, 'broken').image!.resource!.event = 'unobserved'; node(s, 'broken').image!.resource!.eventSequence = 0; }, 'IMAGE_RESOURCE_STATE_UNCERTAIN'],
      [s => { node(s, 'broken').image!.complete = false; }, 'IMAGE_RESOURCE_PENDING'],
      [s => { node(s, 'broken').image!.naturalWidth = 100; }, 'IMAGE_RESOURCE_STATE_UNCERTAIN'],
      [s => { node(s, 'broken').image!.naturalWidth = NaN; }, 'IMAGE_RESOURCE_EVIDENCE_MISSING'],
      [s => { node(s, 'broken').gaps.push({ code: 'FIELD_TRUNCATED', message: 'image:sourceKey' }); }, 'IMAGE_RESOURCE_EVIDENCE_MISSING'],
    ];
    for (const [edit, code] of variants) { const s = structuredClone(source); edit(s); expect(check(await run(s), s, 'broken')).toMatchObject({ code, severity: 'info', verdict: 'unknown' }); }
    // Neither a 200 response nor a missing network history overrides native errors.
    source.snapshot.runtime.network = [];
    expect(check(await run(source), source, 'broken').code).toBe('IMAGE_RESOURCE_LOAD_FAILED');
  });
});

it('ignores forged load/error events and does not reuse an old native event after source declarations change', async () => {
  await setup(async (f, original) => {
    await f.page.evaluate(() => {
      document.querySelector('#broken')!.dispatchEvent(new Event('load'));
      document.querySelector('#healthy')!.dispatchEvent(new Event('error'));
      const img = document.querySelector<HTMLImageElement>('#broken')!;
      img.crossOrigin = 'anonymous'; // A new source binding, even while currentSrc still refers to the same URL.
    });
    const s = await f.inspect();
    expect(check(await run(s), s, 'healthy').code).toBe('IMAGE_RESOURCE_AVAILABLE');
    expect(node(s, 'broken').image!.resource!.sourceKey).not.toBe(node(original, 'broken').image!.resource!.sourceKey);
    expect(node(s, 'broken').image!.resource!.event).not.toBe('load');
    // Immediately after changing a declaration, the previous event cannot bind.
    const immediate = await f.page.evaluate(() => {
      const el = document.querySelector<HTMLImageElement>('#broken')!; el.setAttribute('sizes', '111px');
      return (window as any).__interactionImageResources.read(el);
    });
    expect(immediate.event).toBe('unobserved');
    const current = await f.inspect();
    const nextEvent = node(current, 'broken').image!.resource!;
    // Chromium may already have retried and failed again by the next capture.
    if (nextEvent.event === 'error') expect(nextEvent.eventSequence).toBeGreaterThan(node(s, 'broken').image!.resource!.eventSequence);
    else expect(check(await run(current), current, 'broken').severity).toBe('info');
  });
});

it('keeps a pending replacement with old intrinsic dimensions inconclusive, and discards an error after a successful fallback', async () => {
  await setup(async (f) => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    await f.page.route('**/image-resource-delayed.png', async route => { await gate; await route.fulfill({ contentType: 'image/png', body: readFileSync('apps/test-site/public/aspect-ratio-2x1.png') }); });
    try {
      await f.page.evaluate(() => { document.querySelector<HTMLImageElement>('#healthy')!.src = '/image-resource-delayed.png'; });
      const pending = await f.inspect();
      expect(check(await run(pending), pending, 'healthy')).toMatchObject({ code: 'IMAGE_RESOURCE_PENDING', severity: 'info' });
    } finally { release(); }
    await f.page.evaluate(async () => {
      const img = document.querySelector<HTMLImageElement>('#broken')!;
      const loaded = new Promise<void>(resolve => img.addEventListener('load', () => resolve(), { once: true }));
      img.onerror = () => { img.onerror = null; img.src = '/aspect-ratio-2x1.png'; };
      img.setAttribute('src', img.getAttribute('src')!); await loaded;
    });
    const fallback = await f.inspect();
    expect(check(await run(fallback), fallback, 'broken')).toMatchObject({ code: 'IMAGE_RESOURCE_AVAILABLE', facts: { event: 'load' } });
  });
});

it('resolves the same source after a later successful retry, without upgrading repeated failures or altering history', async () => {
  await setup(async (f, original) => {
    const tracker = new ImageResourceTracker(), first = await tracker.run(original), issue = check(first, original, 'broken').facts!.issueId;
    expect(await tracker.run(original)).toEqual(first);
    const repeat = await tracker.run(await f.inspect());
    expect(check(repeat, original, 'broken')).toMatchObject({ severity: 'warning', facts: { issueId: issue } });
    await f.page.route('**/image-resource-missing.png', route => route.fulfill({ contentType: 'image/png', body: readFileSync('apps/test-site/public/aspect-ratio-2x1.png') }));
    await f.page.locator('#retry').click();
    await f.page.waitForFunction(() => document.querySelector<HTMLImageElement>('#broken')!.naturalWidth > 0);
    const next = await f.inspect(), recovered = await tracker.run(next);
    expect(check(recovered, original, 'broken')).toMatchObject({ code: 'IMAGE_RESOURCE_RESTORED', verdict: 'pass', facts: { issueId: issue, lifecycle: 'resolved' } });
    expect(check(await run(original), original, 'broken').code).toBe('IMAGE_RESOURCE_LOAD_FAILED');
    await expect(tracker.run(original)).rejects.toThrow('TRACKER_OUT_OF_ORDER');
    await expect(tracker.run({ ...next, inspection: { ...next.inspection, sessionId: 'other' } })).rejects.toThrow('TRACKER_SESSION_MISMATCH');
  });
});

it.each(['replace-node', 'fallback', 'close-scope', 'rename', 'missing-event'])('preserves the original finding after %s', async mode => {
  await setup(async (f, original) => {
    const tracker = new ImageResourceTracker(), first = await tracker.run(original), issue = check(first, original, 'broken').facts!.issueId;
    if (mode === 'fallback') await f.page.locator('#fallback').click();
    if (mode === 'replace-node') await f.page.evaluate(() => { const img = document.querySelector('#broken')!; img.replaceWith(img.cloneNode()); });
    if (mode === 'rename') await f.page.evaluate(() => { document.querySelector('#broken')!.setAttribute('alt', 'Another entity'); });
    if (mode === 'close-scope') await f.page.locator('#open').click();
    const s = await f.inspect();
    if (mode === 'missing-event') { node(s, 'broken').image!.resource!.event = 'unobserved'; node(s, 'broken').image!.resource!.eventSequence = 0; }
    const report = await tracker.run(s);
    expect(report.checks.find(c => c.facts?.issueId === issue)).toMatchObject({ code: 'IMAGE_RESOURCE_NOT_RECHECKED', verdict: 'unknown', facts: { observationStatus: 'historical' } });
    expect(report.checks.some(c => c.code === 'IMAGE_RESOURCE_RESTORED')).toBe(false);
    if (mode === 'close-scope') expect(check(report, s, 'modal-image').code).toBe('IMAGE_RESOURCE_LOAD_FAILED');
    if (mode === 'fallback') expect(check(report, s, 'broken').code).toBe('IMAGE_RESOURCE_AVAILABLE');
  });
});
