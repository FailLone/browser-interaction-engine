import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { ClippedControlTracker, ObservedOcclusionTracker, TextTruncationTracker } from '@interaction/rules';
import { fixtureServer, pageOf } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const latest = (e: BrowserEngine, sid: string) => e.listInspections(sid, { limit: 500 }).items.at(-1)!;
async function setup(path: string, fn: (e: BrowserEngine, sid: string, id: string) => Promise<void>) {
  const e = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const s = await e.createSession({ url: `${fixture.url}/${path}`, headless: true, viewport: { width: 800, height: 600 }, settleMs: 60, inspection: {} });
    await fn(e, s.id, e.observation(s.id).controls.find(c => c.selector === '#target')!.identityId!);
  } finally { await e.close(); }
}

const cases = [
  { path: 'observed-occlusion.html?mode=page', create: () => new ObservedOcclusionTracker(), code: 'OCCLUSION_SUSPECTED' },
  { path: 'clipped-control.html', create: () => new ClippedControlTracker(), code: 'CONTROL_CLIPPING_SUSPECTED' },
  { path: 'text-truncation.html?mode=hard-x', create: () => new TextTruncationTracker(), code: 'TEXT_HARD_CLIP_SUSPECTED' },
];
it.each(cases)('keeps the current $code after a temporary interaction boundary, without adding actions', async ({ path, create, code }) => {
  await setup(path, async (e, sid, id) => {
    const tracker = create();
    const first = await tracker.run(e, latest(e, sid)), frozen = structuredClone(first);
    const finding = first.checks.find(c => c.facts?.identityId === id)!;
    expect(finding).toMatchObject({ code, severity: 'warning', facts: { observationStatus: 'current' } });
    await pageOf(e).evaluate(() => {
      const dialog = document.createElement('dialog'); dialog.id = 'temporary-boundary';
      dialog.innerHTML = '<button>Close temporary dialog</button>'; document.body.append(dialog); dialog.showModal();
    });
    await e.observe(sid);
    const hidden = (await tracker.run(e, latest(e, sid))).checks.find(c => c.facts?.issueId === finding.facts!.issueId)!;
    expect(hidden).toMatchObject({ verdict: 'unknown', severity: 'warning', facts: { observationStatus: 'historical', lifecycle: 'unverified', lastObservedFinding: finding.facts!.lastObservedFinding } });
    await pageOf(e).evaluate(() => { const d = document.querySelector<HTMLDialogElement>('#temporary-boundary')!; d.close(); d.remove(); });
    await e.observe(sid);
    const before = { actions: e.session(sid).actionCount, scroll: await pageOf(e).evaluate(() => [scrollX, scrollY]) };
    const returned = (await tracker.run(e, latest(e, sid))).checks.find(c => c.facts?.issueId === finding.facts!.issueId)!;
    expect(returned).toMatchObject({ code, severity: 'warning', facts: { observationStatus: 'current', lifecycle: 'suspected',
      continuity: { status: 'baseline-changed', reason: 'PREVIOUS_SAMPLE_UNAVAILABLE' }, lastObservedFinding: { captureId: latest(e, sid).captureId, code } } });
    expect(returned.facts!.ancestorScrollChanges ?? returned.facts!.changedScrollContainers).toEqual([]);
    expect(returned.facts!.comparison).toBeUndefined();
    expect(e.session(sid).actionCount).toBe(before.actions);
    expect(await pageOf(e).evaluate(() => [scrollX, scrollY])).toEqual(before.scroll);
    expect(first).toEqual(frozen);
  });
});

it('does not downgrade a current clipping requirement failure when its instance is rebuilt', async () => {
  await setup('clipped-control.html', async (e, sid, id) => {
    const tracker = new ClippedControlTracker({ rule: { requirements: [{ identityId: id, kind: 'unclipped-by-nonscroll-container', reason: 'The button must fit', evidence: ['fixture:contract'] }] } });
    await tracker.run(e, latest(e, sid));
    await pageOf(e).locator('#target').evaluate(el => el.replaceWith(el.cloneNode(true))); await e.observe(sid);
    const check = (await tracker.run(e, latest(e, sid))).checks.find(c => c.facts?.identityId === id)!;
    expect(check).toMatchObject({ code: 'CLIPPING_REQUIREMENT_FAILED', verdict: 'fail', severity: 'error', facts: { observationStatus: 'current', continuity: { status: 'baseline-changed' } } });
  });
});

it.each(['button', 'generic'])('reports oversized %s targets as unsupported, including on subsequent captures', async kind => {
  await setup('text-truncation.html?mode=healthy', async (e, sid) => {
    await pageOf(e).locator('#target').evaluate((el, kind) => {
      if (kind === 'generic') {
        const replacement = document.createElement('div'); replacement.id = el.id; replacement.textContent = 'Large container';
        replacement.onclick = () => {}; el.replaceWith(replacement); el = replacement;
      }
      (el as HTMLElement).style.cssText = 'position:absolute;left:0;top:0;width:800px;height:800px;padding:0;margin:0;overflow:visible';
    }, kind);
    await e.observe(sid);
    const trackers = [new ObservedOcclusionTracker(), new ClippedControlTracker()];
    for (let n = 0; n < 2; n++) {
      const target = e.observation(sid).controls.find(c => c.selector === '#target')!;
      for (const tracker of trackers) {
        const check = (await tracker.run(e, latest(e, sid))).checks.find(c => c.target?.nodeId === target.localId)!;
        expect(check).toMatchObject({ verdict: 'unknown', code: 'TARGET_EXCEEDS_VIEWPORT', facts: { observationStatus: 'unsupported', recheck: 'requires-viewport-or-layout-change' } });
        expect(check.actual).not.toContain('wait');
      }
      await e.observe(sid);
    }
  });
});

it('recognizes an oversized scroll child without suppressing actual non-scroll clipping', async () => {
  await setup('clipped-control.html?mode=scroll', async (e, sid, id) => {
    await pageOf(e).locator('#target').evaluate(el => { (el as HTMLElement).style.height = '160px'; (el as HTMLElement).style.top = '0px'; }); await e.observe(sid);
    const nodeId = e.observation(sid).controls.find(c => c.identityId === id)!.localId;
    const tracker = new ClippedControlTracker();
    expect((await tracker.run(e, latest(e, sid))).checks.find(c => c.target?.nodeId === nodeId)).toMatchObject({ code: 'TARGET_EXCEEDS_SCROLLPORT', facts: { observationStatus: 'unsupported' } });
    expect((await new ObservedOcclusionTracker().run(e, latest(e, sid))).checks.find(c => c.target?.nodeId === nodeId)).toMatchObject({ code: 'TARGET_EXCEEDS_CLIP_BOUNDS', facts: { observationStatus: 'unsupported' } });
    await pageOf(e).locator('#clip').evaluate(el => (el as HTMLElement).style.overflow = 'hidden'); await e.observe(sid);
    expect((await tracker.run(e, latest(e, sid))).checks.find(c => c.target?.nodeId === nodeId)).toMatchObject({ code: 'CONTROL_CLIPPING_SUSPECTED', severity: 'warning', facts: { observationStatus: 'current' } });
  });
});

it('does not mistake a partly offscreen container for a container that is too small', async () => {
  await setup('observed-occlusion.html?mode=page', async (e, sid, id) => {
    await pageOf(e).evaluate(() => {
      document.querySelector<HTMLElement>('#modal')!.style.top = '500px';
      document.querySelector<HTMLElement>('#scroller')!.style.top = '80px';
      document.querySelector<HTMLElement>('#target')!.style.top = '0px';
    }); await e.observe(sid);
    const nodeId = e.observation(sid).controls.find(c => c.identityId === id)!.localId;
    const check = (await new ObservedOcclusionTracker().run(e, latest(e, sid))).checks.find(c => c.target?.nodeId === nodeId)!;
    expect(check).toMatchObject({ verdict: 'unknown', code: 'OCCLUSION_RECHECK_UNAVAILABLE', actual: 'Error: TARGET_NOT_FULLY_IN_VIEW' });
    expect(check.facts?.observationStatus).not.toBe('unsupported');
  });
});

it('keeps the old label finding historical even after repeated healthy observations of a replacement', async () => {
  await setup('text-truncation.html?mode=hard-x', async (e, sid, id) => {
    const tracker = new TextTruncationTracker();
    const first = (await tracker.run(e, latest(e, sid))).checks.find(c => c.facts?.identityId === id)!;
    await pageOf(e).locator('#target').evaluate(el => el.textContent = 'OK');
    for (let n = 0; n < 2; n++) {
      await e.observe(sid);
      const nodeId = e.observation(sid).controls.find(c => c.selector === '#target')!.localId;
      const report = await tracker.run(e, latest(e, sid));
      expect(report.checks.find(c => c.facts?.issueId === first.facts!.issueId)).toMatchObject({ verdict: 'unknown', facts: { observationStatus: 'historical', lifecycle: 'unverified', lastObservedFinding: first.facts!.lastObservedFinding } });
      expect(report.checks.find(c => c.target?.nodeId === nodeId)).toMatchObject({ verdict: 'pass', code: 'DOM_TEXT_BOXES_FIT', facts: { observationStatus: 'current' } });
    }
  });
});

it.each(cases)('does not reopen a resolved $code when a healthy control is later rebuilt', async ({ path, create, code }) => {
  await setup(path, async (e, sid, id) => {
    const tracker = create(); await tracker.run(e, latest(e, sid));
    await pageOf(e).evaluate(code => {
      if (code === 'OCCLUSION_SUSPECTED') document.querySelector('#cover')!.remove();
      if (code === 'CONTROL_CLIPPING_SUSPECTED') document.querySelector<HTMLElement>('#clip')!.style.height = '160px';
      if (code === 'TEXT_HARD_CLIP_SUSPECTED') document.querySelector<HTMLElement>('#target')!.style.width = '500px';
    }, code);
    await e.observe(sid);
    expect((await tracker.run(e, latest(e, sid))).checks.find(c => c.facts?.identityId === id)).toMatchObject({ verdict: 'pass', facts: { lifecycle: 'resolved' } });
    await pageOf(e).locator('#target').evaluate(el => el.replaceWith(el.cloneNode(true)));
    for (let n = 0; n < 2; n++) {
      await e.observe(sid);
      const nodeId = e.observation(sid).controls.find(c => c.selector === '#target')!.localId;
      const report = await tracker.run(e, latest(e, sid));
      expect(report.checks.find(c => c.target?.nodeId === nodeId)).toMatchObject({ verdict: 'pass' });
      expect(report.checks.some(c => c.facts?.identityId === id && c.facts?.observationStatus === 'historical')).toBe(false);
    }
  });
});
