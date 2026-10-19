import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ObservedOcclusionTracker,
  RuleRunner,
  sampledOcclusionRule,
  type ObservedOcclusionOptions,
  type RulePage,
  type RuleReport,
} from '@interaction/rules';
import { fixtureServer, withFixture, type RuleFixture } from './rule-fixture.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => {
  fixture = await fixtureServer();
});
afterAll(async () => {
  await fixture.server.close();
});
const targetCheck = (report: RuleReport, identityId: string) =>
  report.checks.find(c => c.facts?.identityId === identityId)!;
async function setup(mode: string, fn: (f: RuleFixture, page: RulePage, id: string) => Promise<void>) {
  await withFixture(`${fixture.url}/observed-occlusion.html?mode=${mode}`, (f, page) =>
    fn(f, page, f.control(c => c.name === 'Target').identityId!),
  );
}
const requirement = (identityId: string): ObservedOcclusionOptions => ({
  requirements: [
    {
      identityId,
      kind: 'sampled-pointer-at-observed-position',
      reason: 'Target must have a reachable sampled point at each observed position',
      evidence: ['fixture:explicit-requirement'],
    },
  ],
});
/** Scroll a container by a fixed step, as a user would (not to the target). */
const step = (f: RuleFixture, selector = '#scroller', dy = 200, dx = 0) =>
  f.page
    .locator(selector)
    .evaluate((el, [x, y]) => el.scrollBy(x, y), [dx, dy])
    .then(() => f.inspect());

it.each([
  ['modal', 0, 200],
  ['horizontal', 200, 0],
  ['nested', 0, 200],
] as const)('rechecks %s scrolling without the inspector performing actions', async (mode, dx, dy) => {
  await setup(mode, async (f, firstPage, id) => {
    const tracker = new ObservedOcclusionTracker();
    const first = await tracker.run(firstPage);
    expect(targetCheck(first, id)).toMatchObject({
      verdict: 'unknown',
      severity: 'warning',
      facts: { lifecycle: 'suspected' },
    });
    const original = structuredClone(first);
    const after = await tracker.run(await step(f, '#scroller', dy, dx));
    expect(targetCheck(after, id)).toMatchObject({
      code: 'OCCLUSION_RECOVERED_AFTER_SCROLL',
      verdict: 'pass',
      facts: { lifecycle: 'resolved', issueId: targetCheck(first, id).facts!.issueId },
    });
    expect(targetCheck(after, id).facts!.changedScrollContainers).toHaveLength(1);
    expect(first).toEqual(original);
    await expect(tracker.run(firstPage)).rejects.toThrow('OUT_OF_ORDER');
    expect(await tracker.run(f.last!)).toEqual(after);
  });
});

it('requires an explicit current-position contract before escalating persistent obstruction', async () => {
  await setup('persistent', async (f, page, id) => {
    const strict = new ObservedOcclusionTracker(requirement(id)),
      ordinary = new ObservedOcclusionTracker();
    expect(targetCheck(await strict.run(page), id).severity).toBe('warning');
    await ordinary.run(page);
    const scrolled = await step(f);
    const confirmed = await strict.run(scrolled);
    expect(targetCheck(confirmed, id)).toMatchObject({
      verdict: 'fail',
      severity: 'error',
      code: 'OBSERVED_POINTER_REQUIREMENT_FAILED',
    });
    expect(targetCheck(await ordinary.run(scrolled), id)).toMatchObject({ verdict: 'unknown', severity: 'warning' });
    await f.page.locator('#cover').evaluate(el => el.remove());
    expect(targetCheck(await strict.run(await f.inspect()), id)).toMatchObject({
      verdict: 'pass',
      facts: { lifecycle: 'resolved', confirmedAt: confirmed.captureId },
    });
  });
});

it.each(['rebuild', 'rebind', 'grow'])('does not infer scroll recovery after %s', async mode => {
  await setup(mode, async (f, page, id) => {
    const tracker = new ObservedOcclusionTracker(requirement(id));
    await tracker.run(page);
    expect(targetCheck(await tracker.run(await step(f)), id)).toMatchObject({
      verdict: 'unknown',
      facts: { lifecycle: 'unverified' },
    });
  });
});

it('does not resolve offscreen, missing, or closed-scope targets', async () => {
  await setup('modal', async (f, page, id) => {
    const tracker = new ObservedOcclusionTracker();
    await tracker.run(page);
    await step(f, '#scroller', 600);
    expect(targetCheck(await tracker.run(f.last!), id)).toMatchObject({
      verdict: 'unknown',
      facts: { lifecycle: 'unverified' },
    });
    await f.page.evaluate(() => (window as unknown as { closeModal(): void }).closeModal());
    expect(targetCheck(await tracker.run(await f.inspect()), id).code).toBe('OCCLUSION_TARGET_UNOBSERVED');
    await f.page.evaluate(() => (window as unknown as { openModal(): void }).openModal());
    expect(targetCheck(await tracker.run(await f.inspect()), id).facts!.lifecycle).toBe('unverified');
  });
});

it('uses actual ancestor offsets rather than an unrelated scroll', async () => {
  await setup('page', async (f, page, id) => {
    const tracker = new ObservedOcclusionTracker(requirement(id));
    await tracker.run(page);
    expect(targetCheck(await tracker.run(await step(f, '#side')), id)).toMatchObject({
      verdict: 'unknown',
      severity: 'warning',
      facts: { changedScrollContainers: [] },
    });
  });
});

it('processes saved captures in order after the page has moved on', async () => {
  await setup('modal', async (f, first, id) => {
    const second = await step(f);
    const tracker = new ObservedOcclusionTracker();
    const [a, b] = await Promise.all([tracker.run(first), tracker.run(second)]);
    expect(targetCheck(a, id).facts!.lifecycle).toBe('suspected');
    expect(targetCheck(b, id).facts!.lifecycle).toBe('resolved');
  });
});

it('does not mistake a scroll cancelled by the page for actual movement', async () => {
  await setup('no-movement', async (f, page, id) => {
    const tracker = new ObservedOcclusionTracker(requirement(id));
    await tracker.run(page);
    const after = await step(f);
    expect(await f.page.locator('#scroller').evaluate(el => el.scrollTop)).toBe(0);
    expect(targetCheck(await tracker.run(after), id)).toMatchObject({
      verdict: 'unknown',
      severity: 'warning',
      facts: { changedScrollContainers: [] },
    });
  });
});

it('does not transfer a warning across an unresolved identity', async () => {
  await setup('modal', async (f, page, id) => {
    const tracker = new ObservedOcclusionTracker();
    await tracker.run(page);
    const source = structuredClone(await step(f));
    source.observation.controls.find(c => c.identityId === id)!.hypothesisId = 'pending-identity-review';
    expect(targetCheck(await tracker.run(source), id)).toMatchObject({
      verdict: 'unknown',
      actual: 'IDENTITY_UNCERTAIN',
      facts: { lifecycle: 'unverified' },
    });
  });
});

it('preserves unknown when a historical hit grid is unavailable', async () => {
  await setup('modal', async (f, page, id) => {
    const tracker = new ObservedOcclusionTracker();
    await tracker.run(page);
    const source = structuredClone(await step(f));
    const control = source.observation.controls.find(c => c.identityId === id)!;
    delete source.snapshot.dom!.nodes.find(n => n.id === control.localId)!.layout!.hitSamples;
    expect(targetCheck(await tracker.run(source), id)).toMatchObject({
      verdict: 'unknown',
      facts: { lifecycle: 'unverified' },
    });
    const fresh = await new ObservedOcclusionTracker().run({
      ...source,
      inspection: { ...source.inspection, sessionId: 'fresh' },
    });
    expect(fresh.checks.find(c => c.target?.nodeId === control.localId)).toMatchObject({
      verdict: 'unknown',
      code: 'OCCLUSION_RECHECK_UNAVAILABLE',
    });
  });
});

it('keeps confirmed historical evidence when the current target disappears', async () => {
  await setup('persistent', async (f, page, id) => {
    const tracker = new ObservedOcclusionTracker(requirement(id));
    await tracker.run(page);
    const scrolled = await step(f);
    const confirmed = targetCheck(await tracker.run(scrolled), id);
    expect(confirmed.facts!.lastObservedFinding).toMatchObject({
      captureId: scrolled.capture.id,
      label: 'Target',
      verdict: 'fail',
      severity: 'error',
      code: 'OBSERVED_POINTER_REQUIREMENT_FAILED',
    });
    await f.page.locator('#target').evaluate(el => el.remove());
    const missing = targetCheck(await tracker.run(await f.inspect()), id);
    expect(missing).toMatchObject({
      verdict: 'unknown',
      facts: { lifecycle: 'unverified', lastObservedFinding: confirmed.facts!.lastObservedFinding },
    });
    expect(missing.target).toBeUndefined();
  });
});

it('does not create background warnings for an active non-modal dialog', async () => {
  await setup('modal', async (_f, page) => {
    const source = structuredClone(page);
    const active = source.observation.overlays!.at(-1)!;
    active.kind = 'dialog';
    const outside = source.observation.controls.filter(
      c => c.visible && c.enabled && !active.controlIds.includes(c.localId),
    );
    expect(outside.length).toBeGreaterThan(0);
    const report = await new ObservedOcclusionTracker().run(source);
    for (const c of outside)
      expect(report.checks.find(check => check.target?.nodeId === c.localId)).toMatchObject({
        verdict: 'not-applicable',
        code: 'OUTSIDE_ACTIVE_SCOPE',
      });
  });
});

// False positives seen on real sites (OKX): layered page UI is not an obstruction defect.
const occlusionOf = async (html: string, viewport = { width: 800, height: 600 }) => {
  const server = await import('node:http').then(({ createServer }) =>
    createServer((_q, r) => {
      r.setHeader('content-type', 'text/html');
      r.end(html);
    }),
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await withFixture(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
      async (f, page) => {
        const [report] = await new RuleRunner([sampledOcclusionRule]).run(page, [
          { ruleId: 'sampled-occlusion', ruleVersion: '1.0.0' },
        ]);
        return report.checks.find(c => c.target?.nodeId === f.control(c => c.name === 'Target').localId)!;
      },
      viewport,
    );
  } finally {
    server.close();
  }
};

it('does not report content under a full-width sticky or fixed bar as occluded', async () => {
  const bar = (position: string) => `<!doctype html><body style="margin:0;min-height:2000px">
    <div style="position:${position};${position === 'fixed' ? 'bottom:0' : 'top:0'};left:0;width:100%;height:80px;background:#fff;z-index:100">Bar</div>
    <button style="position:absolute;top:${position === 'fixed' ? 540 : 20}px;left:40px;width:160px;height:40px">Target</button></body>`;
  expect(await occlusionOf(bar('fixed'))).toMatchObject({ verdict: 'not-applicable', code: 'COVERED_BY_PAGE_CHROME' });
  expect(await occlusionOf(bar('sticky'))).toMatchObject({ verdict: 'not-applicable', code: 'COVERED_BY_PAGE_CHROME' });
});

it('does not report page content under an open popup panel as occluded', async () => {
  const html = `<!doctype html><body style="margin:0">
    <button aria-controls="picker" onclick="">Language</button>
    <div id="picker" style="position:absolute;top:30px;left:20px;width:300px;height:200px;background:#222;z-index:20"><a href="#">English</a><a href="#">中文</a></div>
    <button style="position:absolute;top:100px;left:40px;width:160px;height:40px">Target</button></body>`;
  // The click-opened picker is recognized as a popup; the page beneath is outside its scope.
  expect(await occlusionOf(html)).toMatchObject({
    verdict: 'not-applicable',
    code: expect.stringMatching(/^(OUTSIDE_ACTIVE_SCOPE|COVERED_BY_OPEN_POPUP)$/),
  });
});

it('still reports a small positioned box placed over a static control', async () => {
  const html = `<!doctype html><body style="margin:0">
    <button style="position:absolute;top:100px;left:40px;width:160px;height:40px">Target</button>
    <div style="position:absolute;top:90px;left:30px;width:200px;height:70px;background:#a86c50;z-index:3">Cover</div></body>`;
  expect(await occlusionOf(html)).toMatchObject({
    verdict: 'unknown',
    severity: 'warning',
    code: 'SAMPLE_INTERCEPTED',
  });
});
