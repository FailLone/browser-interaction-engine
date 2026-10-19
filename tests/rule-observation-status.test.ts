import { afterAll, beforeAll, expect, it } from 'vitest';
import { ClippedControlTracker, ObservedOcclusionTracker, TextTruncationTracker } from '@interaction/rules';
import { fixtureServer, withFixture, type RuleFixture } from './rule-fixture.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => {
  fixture = await fixtureServer();
});
afterAll(async () => {
  await fixture.server.close();
});
async function setup(path: string, fn: (f: RuleFixture, id: string) => Promise<void>) {
  await withFixture(`${fixture.url}/${path}`, async f => fn(f, f.control(c => c.selector === '#target').identityId!));
}

const cases = [
  {
    path: 'observed-occlusion.html?mode=page',
    create: () => new ObservedOcclusionTracker(),
    code: 'OCCLUSION_SUSPECTED',
  },
  { path: 'clipped-control.html', create: () => new ClippedControlTracker(), code: 'CONTROL_CLIPPING_SUSPECTED' },
  {
    path: 'text-truncation.html?mode=hard-x',
    create: () => new TextTruncationTracker(),
    code: 'TEXT_HARD_CLIP_SUSPECTED',
  },
];
it.each(cases)(
  'keeps the current $code after a temporary interaction boundary, without adding actions',
  async ({ path, create, code }) => {
    await setup(path, async (f, id) => {
      const tracker = create();
      const first = await tracker.run(await f.inspect()),
        frozen = structuredClone(first);
      const finding = first.checks.find(c => c.facts?.identityId === id)!;
      expect(finding).toMatchObject({ code, severity: 'warning', facts: { observationStatus: 'current' } });
      await f.page.evaluate(() => {
        const dialog = document.createElement('dialog');
        dialog.id = 'temporary-boundary';
        dialog.innerHTML = '<button>Close temporary dialog</button>';
        document.body.append(dialog);
        dialog.showModal();
      });
      const hidden = (await tracker.run(await f.inspect())).checks.find(
        c => c.facts?.issueId === finding.facts!.issueId,
      )!;
      expect(hidden).toMatchObject({
        verdict: 'unknown',
        severity: 'warning',
        facts: {
          observationStatus: 'historical',
          lifecycle: 'unverified',
          lastObservedFinding: finding.facts!.lastObservedFinding,
        },
      });
      await f.page.evaluate(() => {
        const d = document.querySelector<HTMLDialogElement>('#temporary-boundary')!;
        d.close();
        d.remove();
      });
      const page = await f.inspect(),
        before = { scroll: await f.page.evaluate(() => [scrollX, scrollY]) };
      const returned = (await tracker.run(page)).checks.find(c => c.facts?.issueId === finding.facts!.issueId)!;
      expect(returned).toMatchObject({
        code,
        severity: 'warning',
        facts: {
          observationStatus: 'current',
          lifecycle: 'suspected',
          continuity: { status: 'baseline-changed', reason: 'PREVIOUS_SAMPLE_UNAVAILABLE' },
          lastObservedFinding: { captureId: page.capture.id, code },
        },
      });
      expect(returned.facts!.ancestorScrollChanges ?? returned.facts!.changedScrollContainers).toEqual([]);
      expect(returned.facts!.comparison).toBeUndefined();
      expect(await f.page.evaluate(() => [scrollX, scrollY])).toEqual(before.scroll);
      expect(first).toEqual(frozen);
    });
  },
);

it('does not downgrade a current clipping requirement failure when its instance is rebuilt', async () => {
  await setup('clipped-control.html', async (f, id) => {
    const tracker = new ClippedControlTracker({
      rule: {
        requirements: [
          {
            identityId: id,
            kind: 'unclipped-by-nonscroll-container',
            reason: 'The button must fit',
            evidence: ['fixture:contract'],
          },
        ],
      },
    });
    await tracker.run(await f.inspect());
    await f.page.locator('#target').evaluate(el => el.replaceWith(el.cloneNode(true)));
    const check = (await tracker.run(await f.inspect())).checks.find(c => c.facts?.identityId === id)!;
    expect(check).toMatchObject({
      code: 'CLIPPING_REQUIREMENT_FAILED',
      verdict: 'fail',
      severity: 'error',
      facts: { observationStatus: 'current', continuity: { status: 'baseline-changed' } },
    });
  });
});

it.each(['button', 'generic'])(
  'reports oversized %s targets as unsupported, including on subsequent captures',
  async kind => {
    await setup('text-truncation.html?mode=healthy', async f => {
      await f.page.locator('#target').evaluate((el, kind) => {
        if (kind === 'generic') {
          const replacement = document.createElement('div');
          replacement.id = el.id;
          replacement.textContent = 'Large container';
          replacement.onclick = () => {
            replacement.dataset.clicked = 'true';
          };
          el.replaceWith(replacement);
          el = replacement;
        }
        (el as HTMLElement).style.cssText =
          'position:absolute;left:0;top:0;width:800px;height:800px;padding:0;margin:0;overflow:visible';
      }, kind);
      const trackers = [new ObservedOcclusionTracker(), new ClippedControlTracker()];
      for (let n = 0; n < 2; n++) {
        const page = await f.inspect(),
          target = page.observation.controls.find(c => c.selector === '#target')!;
        for (const tracker of trackers) {
          const check = (await tracker.run(page)).checks.find(c => c.target?.nodeId === target.localId)!;
          expect(check).toMatchObject({
            verdict: 'unknown',
            code: 'TARGET_EXCEEDS_VIEWPORT',
            facts: { observationStatus: 'unsupported', recheck: 'requires-viewport-or-layout-change' },
          });
          expect(check.actual).not.toContain('wait');
        }
      }
    });
  },
);

it('recognizes an oversized scroll child without suppressing actual non-scroll clipping', async () => {
  await setup('clipped-control.html?mode=scroll', async (f, id) => {
    await f.page.locator('#target').evaluate(el => {
      (el as HTMLElement).style.height = '160px';
      (el as HTMLElement).style.top = '0px';
    });
    const page = await f.inspect(),
      nodeId = page.observation.controls.find(c => c.identityId === id)!.localId;
    const tracker = new ClippedControlTracker();
    expect((await tracker.run(page)).checks.find(c => c.target?.nodeId === nodeId)).toMatchObject({
      code: 'TARGET_EXCEEDS_SCROLLPORT',
      facts: { observationStatus: 'unsupported' },
    });
    expect(
      (await new ObservedOcclusionTracker().run(page)).checks.find(c => c.target?.nodeId === nodeId),
    ).toMatchObject({
      code: 'TARGET_EXCEEDS_CLIP_BOUNDS',
      severity: 'info',
      facts: { observationStatus: 'unsupported' },
    });
    await f.page.locator('#clip').evaluate(el => ((el as HTMLElement).style.overflow = 'hidden'));
    expect((await tracker.run(await f.inspect())).checks.find(c => c.target?.nodeId === nodeId)).toMatchObject({
      code: 'CONTROL_CLIPPING_SUSPECTED',
      severity: 'warning',
      facts: { observationStatus: 'current' },
    });
  });
});

it('does not mistake a partly offscreen container for a container that is too small', async () => {
  await setup('observed-occlusion.html?mode=page', async (f, id) => {
    await f.page.evaluate(() => {
      document.querySelector<HTMLElement>('#modal')!.style.top = '500px';
      document.querySelector<HTMLElement>('#scroller')!.style.top = '80px';
      document.querySelector<HTMLElement>('#target')!.style.top = '0px';
    });
    const page = await f.inspect(),
      nodeId = page.observation.controls.find(c => c.identityId === id)!.localId;
    const check = (await new ObservedOcclusionTracker().run(page)).checks.find(c => c.target?.nodeId === nodeId)!;
    expect(check).toMatchObject({
      verdict: 'unknown',
      code: 'OCCLUSION_RECHECK_UNAVAILABLE',
      actual: 'Error: TARGET_NOT_FULLY_IN_VIEW',
    });
    expect(check.facts?.observationStatus).not.toBe('unsupported');
  });
});

it('keeps the old label finding historical even after repeated healthy observations of a replacement', async () => {
  await setup('text-truncation.html?mode=hard-x', async (f, id) => {
    const tracker = new TextTruncationTracker();
    const first = (await tracker.run(await f.inspect())).checks.find(c => c.facts?.identityId === id)!;
    await f.page.locator('#target').evaluate(el => (el.textContent = 'OK'));
    for (let n = 0; n < 2; n++) {
      const page = await f.inspect(),
        nodeId = page.observation.controls.find(c => c.selector === '#target')!.localId;
      const report = await tracker.run(page);
      expect(report.checks.find(c => c.facts?.issueId === first.facts!.issueId)).toMatchObject({
        verdict: 'unknown',
        facts: {
          observationStatus: 'historical',
          lifecycle: 'unverified',
          lastObservedFinding: first.facts!.lastObservedFinding,
        },
      });
      expect(report.checks.find(c => c.target?.nodeId === nodeId)).toMatchObject({
        verdict: 'pass',
        code: 'DOM_TEXT_BOXES_FIT',
        facts: { observationStatus: 'current' },
      });
    }
  });
});

it.each(cases)(
  'does not reopen a resolved $code when a healthy control is later rebuilt',
  async ({ path, create, code }) => {
    await setup(path, async (f, id) => {
      const tracker = create();
      await tracker.run(await f.inspect());
      await f.page.evaluate(code => {
        if (code === 'OCCLUSION_SUSPECTED') document.querySelector('#cover')!.remove();
        if (code === 'CONTROL_CLIPPING_SUSPECTED') document.querySelector<HTMLElement>('#clip')!.style.height = '160px';
        if (code === 'TEXT_HARD_CLIP_SUSPECTED') document.querySelector<HTMLElement>('#target')!.style.width = '500px';
      }, code);
      expect((await tracker.run(await f.inspect())).checks.find(c => c.facts?.identityId === id)).toMatchObject({
        verdict: 'pass',
        facts: { lifecycle: 'resolved' },
      });
      await f.page.locator('#target').evaluate(el => el.replaceWith(el.cloneNode(true)));
      for (let n = 0; n < 2; n++) {
        const page = await f.inspect(),
          nodeId = page.observation.controls.find(c => c.selector === '#target')!.localId;
        const report = await tracker.run(page);
        expect(report.checks.find(c => c.target?.nodeId === nodeId)).toMatchObject({ verdict: 'pass' });
        expect(report.checks.some(c => c.facts?.identityId === id && c.facts?.observationStatus === 'historical')).toBe(
          false,
        );
      }
    });
  },
);
