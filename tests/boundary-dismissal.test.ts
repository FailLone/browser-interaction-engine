import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createServer as viteServer } from 'vite';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { BrowserEngine, type BoundaryExitReviewInput, type EngineHooks, type SessionOptions } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { createServer as apiServer } from '../apps/server/src/server.js';
import { act, pageOf } from './helpers.js';

async function fixture(effect = 'panel.hidden=true', hooks: EngineHooks = {}, options: Partial<SessionOptions> = {}) {
  const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`
    <style>#safe {position:fixed;inset:0;background:#eee} #chart{position:absolute;top:20px;left:20px} #chooser{position:absolute;top:100px;left:300px} #panel{position:absolute;top:60px;left:0;width:200px;height:160px;background:white;z-index:2}</style>
    <div id="safe"></div><section id="chart"><h2>Chart</h2><button type="button" role="tab" aria-selected="false" onclick="this.dataset.done='yes';this.setAttribute('aria-selected','true')">Week</button><input aria-label="Amount" value="42"></section>
    <section id="chooser"><h2>Chooser</h2><button type="button" aria-controls="panel" onclick="panel.hidden=false">Open</button><div id="panel" role="listbox" hidden><input placeholder="Search"><button role="option" type="button" onclick="window.chosen++">Alpha</button></div></section>
    <script>window.chosen=0;document.addEventListener('click',e=>{if(e.target.id==='safe'){${effect}}});</script>`); });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const engine = new BrowserEngine({ persistence: new MemoryStore(), hooks });
  const session = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as any).port}`, headless: true, regionExploration: 'review', contextRules: [], settleMs: 30, observeTimeoutMs: 600, maxActions: 15, ...options });
  const sid = session.id;
  return { engine, sid, close: async () => { await engine.close(); await new Promise<void>(r => site.close(() => r())); } };
}
function input(t: Awaited<ReturnType<typeof fixture>>): BoundaryExitReviewInput {
  const m = t.engine.boundaryExitMaterial(t.sid), o = t.engine.observation(t.sid);
  return { observationId: m.observationId, boundaryKey: m.boundary!.key, source: 'test-reviewer', evidence: ['Reviewed outside surface and cancellation contract'],
    decision: { mode: 'attempt', candidateId: m.candidates.find(c => c.selector === '#safe')!.id, preserveControlIds: [o.controls.find(c => c.name === 'Amount')!.localId] } };
}
async function approve(t: Awaited<ReturnType<typeof fixture>>) {
  const review = await t.engine.reviewBoundaryExit(t.sid, input(t));
  expect(review.status).toBe('approved');
  return t.engine.actions(t.sid).find(a => a.kind === 'dismiss')!;
}

it('closes a deferred chooser through a reviewed point and continues the original chart sample', async () => {
  const t = await fixture(); try {
    const m = t.engine.regionReviewMaterial(t.sid);
    await t.engine.reviewRegions(t.sid, { observationId: m.observationId, source: 'fixture', evidence: ['Chart boundary'], regions: [{ key: 'chart', label: 'Chart', candidateIds: [m.candidates.find(c => c.selector === '#chart')!.id] }] });
    const g = t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.kind === 'reviewed-region')!;
    await t.engine.decideExplorationGroups(t.sid, [{ groupId: g.id, revision: g.revision, decision: { mode: 'sample', memberKeys: [g.members.find(m => m.label === 'Week')!.key], source: 'fixture', evidence: ['One chart sample'] } }]);
    const decisions = t.engine.explorationReviewMaterial(t.sid).groups.find(x => x.id === g.id)!.decisions;
    await act(t.engine, t.sid, 'Open');
    expect(t.engine.actions(t.sid).some(a => a.kind === 'dismiss')).toBe(false);
    const material = t.engine.boundaryExitMaterial(t.sid); expect(material.candidates.length).toBeGreaterThan(0); expect(material.boundary?.selector).toBe('#panel');
    expect(material.candidates.every(c => !['button', 'input'].includes(c.tag))).toBe(true);
    const exit = await approve(t); expect(exit.replayable).toBe(false); expect(exit.boundary?.intent).toBe('exit');
    await t.engine.explore(t.sid); await t.engine.waitForIdle();
    expect(t.engine.list<any>(t.sid, 'boundary-exit-result').at(-1)).toMatchObject({ status: 'verified', closed: true, parentReady: true, preserved: true });
    expect(await pageOf(t.engine).locator('#chart button').getAttribute('data-done')).toBe('yes');
    expect(await pageOf(t.engine).evaluate(() => (window as any).chosen)).toBe(0);
    expect(t.engine.explorationReviewMaterial(t.sid).groups.find(x => x.id === g.id)!.decisions).toEqual(decisions);
    expect(t.engine.regionReviewMaterial(t.sid).review!.regions[0].status).toBe('active');
    expect(t.engine.graph(t.sid).transitions.find(x => x.attemptId === t.engine.list<any>(t.sid, 'boundary-exit-result')[0].attemptId)?.replayable).toBe(false);
  } finally { await t.close(); }
});

it('reports a dispatched no-op as not_closed and does not reapprove the same failed point', async () => {
  const t = await fixture('window.noop=true'); try {
    await act(t.engine, t.sid, 'Open'); const exit = await approve(t);
    expect((await t.engine.execute(t.sid, exit.id, 'noop')).status).toBe('succeeded');
    expect(t.engine.list<any>(t.sid, 'boundary-exit-result')[0]).toMatchObject({ status: 'not_closed', closed: false, parentReady: false });
    expect(t.engine.boundaryExitMaterial(t.sid).candidates.find(c => c.id === exit.value)?.attempted).toBe(true);
    await expect(t.engine.reviewBoundaryExit(t.sid, input(t))).rejects.toMatchObject({ code: 'INVALID_BOUNDARY_EXIT_REVIEW' });
    expect(t.engine.session(t.sid).actionCount).toBe(2);
  } finally { await t.close(); }
});

it.each(['move', 'replace', 'cover', 'value', 'url'])('rejects a reviewed point before dispatch when %s changes', async change => {
  const t = await fixture(); try {
    await act(t.engine, t.sid, 'Open'); const exit = await approve(t), count = t.engine.session(t.sid).actionCount;
    await pageOf(t.engine).evaluate(change => {
      const safe = document.querySelector('#safe') as HTMLElement;
      if (change === 'move') safe.style.top = '10px';
      if (change === 'replace') safe.replaceWith(safe.cloneNode(true));
      if (change === 'cover') { const cover = document.createElement('button'); cover.style.cssText = 'position:fixed;inset:0;z-index:99'; document.body.append(cover); }
      if (change === 'value') (document.querySelector('[aria-label=Amount]') as HTMLInputElement).value = '99';
      if (change === 'url') history.pushState({}, '', '#changed');
    }, change);
    await expect(t.engine.execute(t.sid, exit.id, 'stale')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sid).actionCount).toBe(count);
    expect(t.engine.observation(t.sid).boundaries!.length).toBeGreaterThan(0);
  } finally { await t.close(); }
});

it('separates boundary disappearance from changes to caller-preserved values', async () => {
  const t = await fixture("panel.hidden=true;document.querySelector('[aria-label=Amount]').value='99'"); try {
    await act(t.engine, t.sid, 'Open'); const a = await approve(t); await t.engine.execute(t.sid, a.id, 'change');
    expect(t.engine.list<any>(t.sid, 'boundary-exit-result')[0]).toMatchObject({ status: 'changed', closed: true, preserved: false });
    const count = t.engine.session(t.sid).actionCount;
    await t.engine.explore(t.sid); await t.engine.waitForIdle();
    expect(t.engine.session(t.sid)).toMatchObject({ status: 'paused', stopReason: 'BOUNDARY_EXIT_UNVERIFIED', actionCount: count });
  } finally { await t.close(); }
});

it('supports the HTTP/SDK review workflow and rejects stale input without writing a judgment', async () => {
  const t = await fixture(); const app = await apiServer(t.engine); try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const client = new InteractionClient(`http://127.0.0.1:${(app.server.address() as any).port}`);
    await act(t.engine, t.sid, 'Open'); const m = await client.boundaryExitMaterial(t.sid); expect(m.candidates.length).toBeGreaterThan(0);
    const stale = input(t); await t.engine.observe(t.sid);
    await expect(client.reviewBoundaryExit(t.sid, stale)).rejects.toMatchObject({ code: 'STALE_BOUNDARY_EXIT_REVIEW' });
    expect(t.engine.list(t.sid, 'boundary-exit-review')).toHaveLength(0);
    const record = await client.reviewBoundaryExit(t.sid, input(t)); expect(record.status).toBe('approved');
    const a = t.engine.actions(t.sid).find(a => a.kind === 'dismiss')!; await client.execute(t.sid, a.id, 'http');
    expect((await client.boundaryExitMaterial(t.sid)).results.at(-1)?.status).toBe('verified');
  } finally { await app.close(); await t.close(); }
});

it('calls the review hook with evidence and preserves defer without authorizing an outside click', async () => {
  let calls = 0;
  const t = await fixture('panel.hidden=true', { boundaryExitReview: material => { calls++; return { observationId: material.observationId, boundaryKey: material.boundary!.key, source: 'hook', evidence: ['Leave chooser pending'], decision: { mode: 'defer' } }; } });
  try {
    await act(t.engine, t.sid, 'Open'); await t.engine.observe(t.sid);
    await t.engine.observe(t.sid); expect(calls).toBe(1);
    expect(t.engine.actions(t.sid).some(a => a.kind === 'dismiss')).toBe(false);
    expect(t.engine.boundaryExitMaterial(t.sid).review?.status).toBe('deferred');
    expect(t.engine.store.events(t.sid).some(e => e.type === 'boundary.exit_review_requested')).toBe(true);
  } finally { await t.close(); }
});

it('requires fresh approval when the same chooser is reopened', async () => {
  const t = await fixture(); try {
    await act(t.engine, t.sid, 'Open'); const first = t.engine.boundaryExitMaterial(t.sid).episodeId;
    await t.engine.execute(t.sid, (await approve(t)).id, 'first');
    await act(t.engine, t.sid, 'Open');
    expect(t.engine.boundaryExitMaterial(t.sid).episodeId).not.toBe(first);
    expect(t.engine.actions(t.sid).some(a => a.kind === 'dismiss')).toBe(false);
    await t.engine.execute(t.sid, (await approve(t)).id, 'second');
    expect(t.engine.list<any>(t.sid, 'boundary-exit-result').map(r => r.status)).toEqual(['verified', 'verified']);
  } finally { await t.close(); }
});

it('revalidates after pointer movement before issuing any click', async () => {
  const t = await fixture(); try {
    await act(t.engine, t.sid, 'Open'); const a = await approve(t);
    await pageOf(t.engine).evaluate(() => {
      (window as any).outsideClicks = 0;
      document.addEventListener('click', e => { if ((e.target as HTMLElement).id === 'safe') (window as any).outsideClicks++; });
      document.addEventListener('pointermove', () => { (document.querySelector('[aria-label=Amount]') as HTMLInputElement).value = '99'; }, { once: true });
    });
    const attempt = await t.engine.execute(t.sid, a.id, 'late-change');
    expect(attempt.status).toBe('failed'); expect(attempt.reason).toContain('Outside point or boundary changed');
    expect(await pageOf(t.engine).evaluate(() => (window as any).outsideClicks)).toBe(0);
    expect(t.engine.list<any>(t.sid, 'boundary-exit-result')[0].status).toBe('unverified');
    await t.engine.explore(t.sid); await t.engine.waitForIdle();
    expect(t.engine.session(t.sid).stopReason).toBe('BOUNDARY_EXIT_UNVERIFIED');
  } finally { await t.close(); }
});

it('offers nested exits only inside the parent and verifies that the parent remains open', async () => {
  const t = await fixture(); try {
    await pageOf(t.engine).evaluate(() => {
      const outer = document.createElement('div'); outer.id = 'outer'; outer.setAttribute('role', 'dialog');
      outer.style.cssText = 'position:fixed;inset:10px;background:white;z-index:3';
      outer.append(document.querySelector('#chart')!, document.querySelector('#chooser')!); document.body.append(outer);
      outer.addEventListener('click', e => { if (e.target === outer) (document.querySelector('#panel') as HTMLElement).hidden = true; });
    });
    await t.engine.observe(t.sid); await act(t.engine, t.sid, 'Open');
    const m = t.engine.boundaryExitMaterial(t.sid); expect(t.engine.observation(t.sid).boundaries).toHaveLength(2);
    expect(m.candidates.length).toBeGreaterThan(0); expect(m.candidates.every(c => !!c.parentBoundaryInstanceId && c.selector !== '#safe')).toBe(true);
    await t.engine.reviewBoundaryExit(t.sid, { observationId: m.observationId, boundaryKey: m.boundary!.key, source: 'fixture', evidence: ['Only the child closes on parent background'], decision: { mode: 'attempt', candidateId: m.candidates.find(c => c.selector === '#outer')!.id } });
    await t.engine.execute(t.sid, t.engine.actions(t.sid).find(a => a.kind === 'dismiss')!.id, 'nested');
    expect(t.engine.list<any>(t.sid, 'boundary-exit-result')[0]).toMatchObject({ status: 'verified', closed: true, parentReady: true });
    expect(t.engine.observation(t.sid).overlays?.map(b => b.selector)).toEqual(['#outer']);
  } finally { await t.close(); }
});

it('accepts an upper hook approval and executes the resulting current action', async () => {
  const t = await fixture('panel.hidden=true', { boundaryExitReview: (m, ctx) => ({ observationId: m.observationId, boundaryKey: m.boundary!.key,
    source: 'fixture-hook', evidence: ['Known cancellation surface'], decision: { mode: 'attempt', candidateId: m.candidates.find(c => c.selector === '#safe')!.id,
      preserveControlIds: [ctx.observation.controls.find(c => c.name === 'Amount')!.localId] } }) });
  try {
    await act(t.engine, t.sid, 'Open');
    expect(t.engine.boundaryExitMaterial(t.sid).review?.source).toBe('fixture-hook');
    await t.engine.execute(t.sid, t.engine.actions(t.sid).find(a => a.kind === 'dismiss')!.id, 'hook');
    expect(t.engine.list<any>(t.sid, 'boundary-exit-result')[0].status).toBe('verified');
  } finally { await t.close(); }
});

it('never grants historical replay through broad caller interface or replay rules', async () => {
  const t = await fixture('panel.hidden=true', {}, { interfaceActions: [{}], replayable: [{}] }); try {
    await act(t.engine, t.sid, 'Open'); const a = await approve(t);
    expect(a.replayable).toBe(false); await t.engine.execute(t.sid, a.id, 'broad-rules');
    expect(t.engine.list<any>(t.sid, 'boundary-exit-result')[0].status).toBe('verified');
  } finally { await t.close(); }
});

it('records unknown verification and stops exploration when post-action capture fails', async () => {
  const t = await fixture(); try {
    await act(t.engine, t.sid, 'Open'); const a = await approve(t);
    const spy = vi.spyOn((t.engine as any).driver, 'capture').mockRejectedValueOnce(new Error('fixture capture failure'));
    const attempt = await t.engine.execute(t.sid, a.id, 'missing-capture'); spy.mockRestore();
    expect(attempt.status).toBe('unknown'); expect(t.engine.boundaryExitMaterial(t.sid).results[0].status).toBe('unverified');
    await t.engine.observe(t.sid); await t.engine.explore(t.sid); await t.engine.waitForIdle();
    expect(t.engine.session(t.sid)).toMatchObject({ stopReason: 'BOUNDARY_EXIT_UNVERIFIED', actionCount: 2 });
  } finally { await t.close(); }
});

it('reviews an exit in the UI with a stale-draft guard and displays independent verification results', async () => {
  const t = await fixture(), app = await apiServer(t.engine);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await viteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await act(t.engine, t.sid, 'Open');
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    await page.locator('.session-item').first().click(); await page.getByRole('button', { name: '范围决策', exact: true }).click();
    const panel = page.getByRole('region', { name: '弹层退出审阅' });
    await panel.getByRole('button', { name: '查看当前退出候选' }).click();
    await panel.getByRole('radio').first().check(); await panel.getByRole('textbox', { name: '退出判断依据' }).fill('根据当前候选，点击背景取消并保留金额');
    await t.engine.observe(t.sid); await panel.getByText('观察已更新，请重新载入退出候选。').waitFor();
    expect(await panel.getByRole('button', { name: '批准一次退出尝试' }).isDisabled()).toBe(true);
    await panel.getByRole('button', { name: '查看当前退出候选' }).click();
    await panel.getByRole('radio').first().check();
    await panel.getByText('选择退出后必须保留的控件', { exact: true }).click();
    await panel.getByRole('checkbox', { name: /Amount/ }).check();
    await panel.getByRole('textbox', { name: '退出判断依据' }).fill('根据当前候选，点击背景取消并保留金额');
    await panel.getByRole('button', { name: '批准一次退出尝试' }).click();
    await panel.getByRole('button', { name: '批准一次退出尝试' }).waitFor({ state: 'detached' });
    await expect.poll(() => t.engine.boundaryExitMaterial(t.sid).review?.status).toBe('approved');
    expect(t.engine.boundaryExitMaterial(t.sid).review?.preserved).toHaveLength(1);
    await t.engine.execute(t.sid, t.engine.actions(t.sid).find(a => a.kind === 'dismiss')!.id, 'ui-approved');
    await panel.getByText(/最近结果：已验证退出/).waitFor(); expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); }
});
