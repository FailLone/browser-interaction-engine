import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, type RegionReviewInput } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { pageOf } from './helpers.js';

async function fixture(ticking = false) {
  const html = `<button id="background">Background 1</button><div id="modal" role="dialog" aria-modal="true" style="position:fixed;left:100px;top:100px;width:300px;height:180px;background:white;z-index:5">
    <h2>Settings</h2><input aria-label="Inside"><button id="close" onclick="clearInterval(window.timer);document.querySelector('#modal').remove();window.closedCount++">Close</button></div>
    <script>window.closedCount=0;window.bump=()=>background.textContent='Background '+Math.random();${ticking ? 'window.timer=setInterval(window.bump,20)' : ''}</script>`;
  const site = createServer((_q, r) => { r.setHeader('Content-Type', 'text/html'); r.end(html); });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  const s = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}`, headless: true,
    exploration: 'controls', regionExploration: 'review', settleMs: 80, observeTimeoutMs: 800 });
  return { engine, sid: s.id, close: async () => { await engine.close(); await new Promise<void>(r => site.close(() => r())); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function region(t: Fixture, page = false): RegionReviewInput {
  const o = t.engine.observation(t.sid);
  const c = o.regionCandidates!.find(c => page ? c.basis === 'document' : c.label === 'Settings' && c.selector === '#modal')!;
  return { observationId: o.id, source: 'test', evidence: ['Observed exact container and its controls'],
    regions: [{ key: 'settings', label: 'Settings', candidateIds: [c.id], pageTraversal: false }], rejectedCandidateIds: [] };
}

it('observes, reviews and exits a stable modal while unrelated region candidates keep changing', async () => {
  const t = await fixture(true);
  try {
    const o = t.engine.observation(t.sid);
    expect(o.stable).toBe(false);
    expect(await pageOf(t.engine).locator('input').getAttribute('style')).toBeNull();
    expect(o.gaps.some(g => g.critical)).toBe(false);
    expect(o.gaps.some(g => g.code === 'INTERACTION_STABLE')).toBe(true);
    const reviewed = await t.engine.reviewRegions(t.sid, region(t));
    expect(reviewed.status).toBe('active');
    const current = t.engine.observation(t.sid), close = current.controls.find(c => c.name === 'Close')!;
    await t.engine.reviewControls(t.sid, { observationId: current.id, source: 'test', reviews: [{ localId: close.localId,
      kind: 'click', risk: 'interface', reason: 'Close observed modal', evidence: ['Current close handler'] }] });
    const action = t.engine.actions(t.sid).find(a => a.label === 'Close' && a.kind === 'click')!;
    expect((await t.engine.execute(t.sid, action.id, 'close-modal')).status).toBe('succeeded');
    expect(t.engine.observation(t.sid).boundaries).toEqual([]);
    expect(t.engine.session(t.sid).actionCount).toBe(1);
    expect(t.engine.observation(t.sid, o.id)).toEqual(o);
  } finally { await t.close(); }
});

it.each(['heading', 'member', 'owner'] as const)('rejects a modal region decision when its %s changes', async change => {
  const t = await fixture();
  try {
    const input = region(t);
    await pageOf(t.engine).evaluate(change => {
      const modal = document.querySelector('#modal')!;
      if (change === 'heading') modal.querySelector('h2')!.textContent = 'Different settings';
      if (change === 'member') { const button = document.createElement('button'); button.textContent = 'New operation'; modal.append(button); }
      if (change === 'owner') modal.replaceWith(modal.cloneNode(true));
    }, change);
    await expect(t.engine.reviewRegions(t.sid, input)).rejects.toMatchObject({ code: 'STALE_REGION_REVIEW' });
    expect(t.engine.list(t.sid, 'region-review')).toEqual([]);
  } finally { await t.close(); }
});

it('does not use modal readiness to approve a mixed page region', async () => {
  const t = await fixture();
  try {
    const input = region(t, true);
    await pageOf(t.engine).evaluate(() => (window as any).bump());
    await expect(t.engine.reviewRegions(t.sid, input)).rejects.toMatchObject({ code: 'STALE_REGION_REVIEW' });
    expect(t.engine.list(t.sid, 'region-review')).toEqual([]);
  } finally { await t.close(); }
});
