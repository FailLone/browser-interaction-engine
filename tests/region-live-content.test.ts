import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, type ActionAttempt, type EngineHooks } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { pageOf } from './helpers.js';

const reason = { source: 'test-plan', evidence: ['Current container heading and native control semantics'] };
const records = `<section><h2>Records</h2><a href="/record">Instrument <span id="quote">$10.00</span></a>
<button type="button" id="inspect" onclick="window.inspections=(window.inspections||0)+1">Inspect 1</button></section>`;
const background = `<ul><li>North <span data-readout>$10.00</span><a href="/north">Details</a></li></ul>
<table><tr onclick="window.rowCalls=(window.rowCalls||0)+1"><td>South</td><td data-readout>$10.00</td><td><a href="/south">Details</a></td></tr></table>`;
const ticker = `<script>window.ticks=0;setInterval(()=>{window.ticks++;document.querySelectorAll('#quote,[data-readout]').forEach(el=>el.textContent='$'+(10+window.ticks/100).toFixed(2))},10)</script>`;
async function fixture(html: string, hooks: EngineHooks = {}) {
  const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const engine = new BrowserEngine({ persistence: new MemoryStore(), hooks });
  try {
    const session = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as {port:number}).port}`,
      headless: true, exploration: 'controls', regionExploration: 'review', settleMs: 100, observeTimeoutMs: 1200 });
    return { engine, sid: session.id, close: async () => { await engine.close(); await new Promise<void>(r => site.close(() => r())); } };
  } catch (error) { await engine.close(); site.close(); throw error; }
}
const reviewRecords = async (t: Awaited<ReturnType<typeof fixture>>) => {
  const m = t.engine.regionReviewMaterial(t.sid);
  return t.engine.reviewRegions(t.sid, { observationId: m.observationId, ...reason,
    regions: [{ key: 'records', label: 'Records', candidateIds: [m.candidates.filter(c => c.label === 'Records').sort((a, b) => a.controlIds.length - b.controlIds.length)[0].id] }] });
};

it('exits an obstruction and retains reviewed regions while background quotes never settle', async () => {
  const t = await fixture(`${records}${background}<dialog open><h2>Notice</h2><button type="button" onclick="this.closest('dialog').close()">Dismiss</button></dialog>${ticker}`);
  try {
    const initial = t.engine.observation(t.sid);
    expect(initial.gaps.some(g => g.critical)).toBe(false);
    const exit = t.engine.actions(t.sid).find(a => a.label === 'Dismiss' && a.boundary?.intent === 'exit')!;
    expect((await t.engine.execute(t.sid, exit.id, 'exit-live-background')).status).toBe('succeeded');
    expect(await pageOf(t.engine).locator('dialog').evaluate(el => (el as HTMLDialogElement).open)).toBe(false);
    const reviewed = await reviewRecords(t);
    expect(reviewed.status).toBe('active');
    const group = t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.kind === 'reviewed-region')!;
    await t.engine.decideExplorationGroups(t.sid, [{ groupId: group.id, revision: group.revision, decision: { ...reason, mode: 'all' } }]);
    const approved = t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.id === group.id)!;
    const before = t.engine.observation(t.sid);
    await t.engine.observe(t.sid);
    const after = t.engine.observation(t.sid);
    expect(after.controls.find(c => c.tag === 'a')!.displayedText).not.toBe(before.controls.find(c => c.tag === 'a')!.displayedText);
    expect(after.controls.find(c => c.tag === 'a')!.liveContent?.name).toBe('Instrument');
    expect(t.engine.regionReviewMaterial(t.sid).review?.regions[0].status).toBe('active');
    const currentGroup = t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.id === group.id)!;
    expect(currentGroup.revision).toBe(approved.revision);
    const inspect = t.engine.actions(t.sid).find(a => a.label === 'Inspect 1')!;
    expect((await t.engine.execute(t.sid, inspect.id, 'inspect-live-background')).status).toBe('succeeded');
    expect(await pageOf(t.engine).evaluate(() => (window as any).inspections)).toBe(1);
    expect(t.engine.list<ActionAttempt>(t.sid, 'attempt').map(a => a.status)).toEqual(['succeeded', 'succeeded']);
  } finally { await t.close(); }
});

it('does not repeatedly request the same unassigned regions for passive quote updates', async () => {
  const calls: string[] = [];
  const t = await fixture(records + background + ticker, { regionReview: m => { calls.push(m.observationId); return undefined; } });
  try {
    await t.engine.observe(t.sid); await t.engine.observe(t.sid);
    expect(calls).toHaveLength(1);
    await pageOf(t.engine).locator('a[href="/record"]').evaluate(el => el.setAttribute('href', '/other-record'));
    await t.engine.observe(t.sid);
    expect(calls).toHaveLength(2);
  } finally { await t.close(); }
});

it.each(['destination', 'explicit-label', 'readout-meaning', 'operation-label'] as const)(
  'invalidates a reviewed region and refuses dispatch when %s changes', async change => {
    const t = await fixture(records);
    try {
      await reviewRecords(t);
      const action = t.engine.actions(t.sid).find(a => a.label === 'Inspect 1')!;
      await pageOf(t.engine).evaluate(change => {
        if (change === 'destination') document.querySelector('a')!.setAttribute('href', '/other-record');
        if (change === 'explicit-label') document.querySelector('a')!.setAttribute('aria-label', 'Different instrument');
        if (change === 'readout-meaning') document.querySelector('#quote')!.textContent = 'Unavailable';
        if (change === 'operation-label') document.querySelector('#inspect')!.textContent = 'Inspect 2';
      }, change);
      await expect(t.engine.execute(t.sid, action.id, `changed-${change}`)).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
      expect(t.engine.regionReviewMaterial(t.sid).review?.regions[0].status).toBe('invalidated');
      expect(t.engine.list<ActionAttempt>(t.sid, 'attempt')).toEqual([]);
      expect(await pageOf(t.engine).evaluate(() => (window as any).inspections || 0)).toBe(0);
    } finally { await t.close(); }
  });

it('still expires an externally reviewed tentative target when its raw text changes', async () => {
  const t = await fixture('<section><h2>Records</h2><div id="custom" onclick="window.calls=(window.calls||0)+1">Inspect <span id="quote">$10.00</span></div></section>');
  try {
    await reviewRecords(t);
    const o = t.engine.observation(t.sid), target = o.controls.find(c => c.name === 'Inspect $10.00')!;
    await t.engine.reviewControls(t.sid, { observationId: o.id, source: reason.source, reviews: [{
      localId: target.localId, kind: 'click', risk: 'interface', reason: 'Fixture inspection counter', evidence: reason.evidence,
    }] });
    const action = t.engine.actions(t.sid).find(a => a.localId === target.localId && a.kind === 'click')!;
    expect(action.source).toBe('control-review');
    await pageOf(t.engine).locator('#quote').evaluate(el => el.textContent = '$20.00');
    await expect(t.engine.execute(t.sid, action.id, 'changed-reviewed-target')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.controlReviewMaterial(t.sid).controls.find(c => c.control.localId === target.localId)!.reviews[0].status).toBe('invalidated');
    expect(t.engine.list<ActionAttempt>(t.sid, 'attempt')).toEqual([]);
    expect(await pageOf(t.engine).evaluate(() => (window as any).calls || 0)).toBe(0);
  } finally { await t.close(); }
});
