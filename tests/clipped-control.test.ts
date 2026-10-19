import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  clippedControlRule,
  ClippedControlTracker,
  RuleRunner,
  type ClippedControlOptions,
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
const targetCheck = (r: RuleReport, id: string) =>
  r.checks.find(c => c.facts?.identityId === id || c.target?.nodeId === id)!;
const requirement = (identityId: string): ClippedControlOptions => ({
  requirements: [
    {
      identityId,
      kind: 'unclipped-by-nonscroll-container',
      reason: 'Target must not be cut by a non-scroll UI container',
      evidence: ['fixture:target-contract'],
    },
  ],
});
const run = async (page: RulePage, options: ClippedControlOptions = {}) =>
  (
    await new RuleRunner([clippedControlRule]).run(page, [{ ruleId: 'clipped-control', ruleVersion: '1.0.0', options }])
  )[0];
async function setup(mode: string, fn: (f: RuleFixture, page: RulePage, nodeId: string, id: string) => Promise<void>) {
  await withFixture(`${fixture.url}/clipped-control.html?mode=${mode}`, async (f, page) => {
    const c = f.control(c => c.selector === '#target');
    await fn(f, page, c?.localId, c?.identityId as string);
  });
}
const scroll = (f: RuleFixture) => f.scroll('#clip');

it.each(['healthy', 'covered', 'fixed', 'native-modal', 'popover'])('does not invent clipping for %s', async mode => {
  await setup(mode, async (_f, page, node) => {
    expect(targetCheck(await run(page), node)).toMatchObject({
      verdict: 'pass',
      code: 'CONTROL_BOX_UNCLIPPED',
      facts: { rectangularIntersectionRatio: 1 },
    });
  });
});
it.each(['default', 'clip', 'nested', 'modal', 'native-modal-clipped', 'popover-clipped'])(
  'records %s clipping with bounds and a sourced opt-in failure',
  async mode => {
    await setup(mode, async (f, page, node, id) => {
      const initial = targetCheck(await run(page), node);
      expect(initial).toMatchObject({ verdict: 'unknown', severity: 'warning', code: 'CONTROL_CLIPPING_SUSPECTED' });
      expect(Number(initial.facts!.rectangularIntersectionRatio)).toBeLessThan(1);
      expect(initial.facts!.clips).not.toEqual([]);
      expect(targetCheck(await run(page, requirement(id)), node)).toMatchObject({
        verdict: 'fail',
        severity: 'error',
        code: 'CLIPPING_REQUIREMENT_FAILED',
      });
      if (mode === 'default') expect(initial.facts!.rectangularIntersectionRatio).toBe(0.5); // Client edge excludes the 6px border.
      if (mode === 'modal')
        expect(targetCheck(await run(page), f.control(c => c.name === 'Background').localId)).toMatchObject({
          verdict: 'not-applicable',
          code: 'OUTSIDE_ACTIVE_SCOPE',
        });
    });
  },
);
it.each(['transform', 'zoom', 'mask', 'rounded', 'clip-margin', 'absolute-escape', 'svg', 'fragments'])(
  'keeps %s geometry unverified even under a strict requirement',
  async mode => {
    await setup(mode, async (_f, page, node, id) => {
      const c = targetCheck(await run(page, requirement(id)), node);
      expect(c.verdict).toBe('unknown');
      expect(c.severity).not.toBe('error');
      expect(c.code).toBe(
        mode === 'absolute-escape'
          ? 'POSITIONED_CLIP_UNVERIFIED'
          : mode === 'svg'
            ? 'CLIP_BOX_UNSUPPORTED'
            : 'COMPLEX_CLIP_UNVERIFIED',
      );
    });
  },
);
it('keeps ordinary viewport overflow pending and skips disabled controls by default', async () => {
  await setup('offscreen', async (_f, page, node, id) =>
    expect(targetCheck(await run(page, requirement(id)), node)).toMatchObject({
      verdict: 'unknown',
      severity: 'info',
      code: 'VIEWPORT_RECHECK_PENDING',
    }),
  );
  await setup('disabled', async (_f, page, node) => {
    expect(targetCheck(await run(page), node).verdict).toBe('not-applicable');
    expect(targetCheck(await run(page, { includeDisabled: true }), node).severity).toBe('warning');
  });
});
it.each(['scroll', 'horizontal'])('rechecks %s after ordinary scrolling', async mode => {
  await setup(mode, async (f, firstPage, _node, id) => {
    const tracker = new ClippedControlTracker({ rule: requirement(id) });
    const first = await tracker.run(firstPage),
      immutable = structuredClone(first);
    expect(targetCheck(first, id)).toMatchObject({
      verdict: 'unknown',
      severity: 'info',
      code: 'SCROLL_CLIP_RECHECK_PENDING',
      facts: { lifecycle: 'pending' },
    });
    const { page } = await scroll(f);
    const report = await tracker.run(page),
      check = targetCheck(report, id);
    expect(check, JSON.stringify(check)).toMatchObject({
      verdict: 'pass',
      code: 'CLIPPING_NO_LONGER_OBSERVED',
      facts: { lifecycle: 'resolved', issueId: targetCheck(first, id).facts!.issueId },
    });
    expect(check.facts!.ancestorScrollChanges).toHaveLength(1);
    expect(first).toEqual(immutable);
    expect(await tracker.run(page)).toEqual(report);
    await expect(tracker.run(firstPage)).rejects.toThrow('OUT_OF_ORDER');
  });
});
it.each(['rebuild', 'rebind'])('does not claim recovery after %s', async mode => {
  await setup(mode, async (f, page, _node, id) => {
    const tracker = new ClippedControlTracker();
    await tracker.run(page);
    expect(targetCheck(await tracker.run((await scroll(f)).page), id)).toMatchObject({
      verdict: 'unknown',
      facts: { lifecycle: 'unverified' },
    });
  });
});
it('retains warnings while offscreen or missing, and resolves a comparable layout correction', async () => {
  await setup('default', async (f, page, _node, id) => {
    const tracker = new ClippedControlTracker();
    const first = await tracker.run(page);
    await f.page.locator('#clip').evaluate(el => {
      (el as HTMLElement).style.marginTop = '900px';
    });
    expect(targetCheck(await tracker.run(await f.inspect()), id)).toMatchObject({
      verdict: 'unknown',
      severity: 'warning',
      facts: { lifecycle: 'unverified' },
    });
    await f.page.locator('#clip').evaluate(el => {
      (el as HTMLElement).style.marginTop = '0';
      (el as HTMLElement).style.height = '160px';
    });
    expect(targetCheck(await tracker.run(await f.inspect()), id).code).toBe('CLIPPING_BASELINE_CHANGED');
    expect(targetCheck(await tracker.run(await f.inspect()), id)).toMatchObject({
      verdict: 'pass',
      facts: { lifecycle: 'resolved', issueId: targetCheck(first, id).facts!.issueId },
    });
  });
  await setup('default', async (f, page, _node, id) => {
    const tracker = new ClippedControlTracker();
    await tracker.run(page);
    await f.page.locator('#target').evaluate(el => el.remove());
    expect(targetCheck(await tracker.run(await f.inspect()), id)).toMatchObject({
      code: 'CLIPPING_TARGET_UNOBSERVED',
      verdict: 'unknown',
      facts: { lifecycle: 'unverified' },
    });
  });
});
it('does not infer a scroll or escalate when the page cancels movement', async () => {
  await setup('cancel', async (f, page, _node, id) => {
    const tracker = new ClippedControlTracker({ rule: requirement(id) });
    await tracker.run(page);
    const check = targetCheck(await tracker.run((await scroll(f)).page), id);
    expect(check).toMatchObject({ verdict: 'unknown', severity: 'info', facts: { ancestorScrollChanges: [] } });
  });
});
it('treats missing and truncated evidence as unknown and validates rule configuration', async () => {
  await setup('default', async (_f, page, node) => {
    const runner = new RuleRunner([clippedControlRule]),
      source = structuredClone(page);
    delete source.snapshot.dom!.nodes.find(n => n.id === node)!.layout!.clipping;
    const [report] = await runner.run(source, [{ ruleId: 'clipped-control', ruleVersion: '1.0.0' }]);
    expect(targetCheck(report, node)).toMatchObject({ verdict: 'unknown', code: 'CLIP_EVIDENCE_UNAVAILABLE' });
    source.snapshot.dom!.nodesTruncated = true;
    expect((await runner.run(source, [{ ruleId: 'clipped-control', ruleVersion: '1.0.0' }]))[0].checks[0].code).toBe(
      'EVIDENCE_INCOMPLETE',
    );
    expect(runner.catalog()[0].optionsSchema).toBeDefined();
    await expect(run(page, { tolerancePx: 50 })).rejects.toThrow();
    await expect(
      run(page, {
        requirements: [{ identityId: 'a', kind: 'unclipped-by-nonscroll-container', reason: '', evidence: [] }],
      }),
    ).rejects.toThrow();
  });
});
it('keeps an existing warning until ordinary scrolling actually reveals the whole control, and reopens it on recurrence', async () => {
  await setup('default', async (f, page, _node, id) => {
    const tracker = new ClippedControlTracker(),
      first = await tracker.run(page),
      issueId = targetCheck(first, id).facts!.issueId;
    await f.page.locator('#clip').evaluate(el => {
      (el as HTMLElement).style.overflow = 'auto';
    });
    expect(targetCheck(await tracker.run(await f.inspect()), id)).toMatchObject({
      verdict: 'unknown',
      severity: 'warning',
      facts: { lifecycle: 'unverified', issueId },
    });
    expect(targetCheck(await tracker.run((await scroll(f)).page), id)).toMatchObject({
      verdict: 'pass',
      facts: { lifecycle: 'resolved', issueId },
    });
    await f.page.locator('#clip').evaluate(el => {
      el.scrollTop = 0;
      (el as HTMLElement).style.overflow = 'hidden';
    });
    expect(targetCheck(await tracker.run(await f.inspect()), id)).toMatchObject({
      verdict: 'unknown',
      severity: 'warning',
      facts: { lifecycle: 'suspected', issueId },
    });
  });
});
it('does not transfer resolved geometry through ambiguous identity or another crawl', async () => {
  await setup('scroll', async (f, page, _node, id) => {
    const tracker = new ClippedControlTracker();
    await tracker.run(page);
    const source = structuredClone((await scroll(f)).page);
    source.observation.controls.find(c => c.identityId === id)!.hypothesisId = 'unresolved';
    expect(targetCheck(await tracker.run(source), id)).toMatchObject({
      verdict: 'unknown',
      actual: 'IDENTITY_UNCERTAIN',
      facts: { lifecycle: 'unverified' },
    });
    await expect(
      tracker.run({
        ...source,
        inspection: { ...source.inspection, id: 'other', sessionId: 'different-crawl', sequence: 99 },
      }),
    ).rejects.toThrow('SESSION_MISMATCH');
  });
  await setup('modal', async (f, page, _node, id) => {
    const tracker = new ClippedControlTracker(),
      first = await tracker.run(page),
      issue = targetCheck(first, id).facts!.issueId;
    await f.page.locator('#frame').evaluate(el => {
      el.removeAttribute('role');
      el.removeAttribute('aria-modal');
    });
    expect((await tracker.run(await f.inspect())).checks.find(c => c.facts?.issueId === issue)).toMatchObject({
      verdict: 'unknown',
      code: 'CLIPPING_TARGET_UNOBSERVED',
      facts: { lifecycle: 'unverified' },
    });
  });
});
it('does not partly revise issues when the tracker capacity is exceeded', async () => {
  await setup('default', async (f, page, _node, id) => {
    const tracker = new ClippedControlTracker({ maxTracked: 1 });
    await tracker.run(page);
    await f.page.locator('#target').evaluate(el => {
      const other = el.cloneNode(true) as HTMLElement;
      other.id = 'other';
      other.dataset.testid = 'other';
      other.textContent = 'Other';
      other.style.cssText = 'position:absolute;top:80px;left:160px;width:100px;height:40px';
      el.after(other);
    });
    const next = await f.inspect();
    await expect(tracker.run(next)).rejects.toThrow('CAPACITY_EXCEEDED');
    // A retry after the caller supplies a reduced capture target set.
    const reduced = structuredClone(next);
    reduced.observation.controls = reduced.observation.controls.filter(c => c.selector !== '#other');
    expect(targetCheck(await tracker.run(reduced), id).facts!.revision).toBe(2);
  });
});
it('preserves confirmed clipping bounds separately from unavailable current evidence', async () => {
  await setup('default', async (f, page, _node, id) => {
    const tracker = new ClippedControlTracker({ rule: requirement(id) });
    const confirmed = targetCheck(await tracker.run(page), id);
    expect(confirmed.facts!.lastObservedFinding).toMatchObject({
      verdict: 'fail',
      severity: 'error',
      code: 'CLIPPING_REQUIREMENT_FAILED',
      facts: { rectangularIntersectionRatio: 0.5 },
    });
    await f.page.locator('#target').evaluate(el => el.remove());
    expect(targetCheck(await tracker.run(await f.inspect()), id)).toMatchObject({
      code: 'CLIPPING_TARGET_UNOBSERVED',
      verdict: 'unknown',
      facts: { lastObservedFinding: confirmed.facts!.lastObservedFinding },
    });
  });
});
