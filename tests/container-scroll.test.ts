import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { type ActionAttempt, type Observation } from '@interaction/browser';
import { testEngine, pageOf } from './helpers.js';

async function fixture(body: string) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as {port:number}).port}`, { exploration: 'controls', contextRules: [], maxActions: 100 });
  return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it('traverses a virtual list viewport, exercises revealed inputs and returns without historical scroll recovery', async () => {
  const t = await fixture(`<style>body{margin:0}input{display:block;height:30px;box-sizing:border-box}</style>
    <div id="popup" role="dialog" style="position:absolute;top:40px;left:40px;width:300px;height:210px;background:white">
    <button onclick="document.getElementById('popup').remove()">Close</button>
    <div id="viewport" aria-label="Records" style="height:120px;overflow:auto;position:relative">
      <div style="height:701px;position:relative"><div id="rows" style="position:absolute;left:0;right:0"></div></div>
    </div></div><script>
    const view=document.getElementById('viewport'),list=document.getElementById('rows');
    function render(){const start=Math.min(6,Math.floor(view.scrollTop/90));list.style.top=start*90+'px';
      list.innerHTML=[start,start+1].map(i=>'<div data-item-key="'+i+'"><input aria-label="Record '+i+'"></div>').join('');}
    view.addEventListener('scroll',render);render();</script>`);
  try {
    const first = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Records')!;
    expect(t.engine.observation(t.sessionId).controls.map(c => c.name)).toContain('Record 0');
    expect(first.scroll).toMatchObject({ y: 0, maxY: 581, height: 120 });
    expect(first.actionBasis?.scroll).toMatchObject({ status: 'supported' });
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    const names = new Set(attempts.filter(a => a.action.kind === 'fill' && a.status === 'succeeded').map(a => a.action.label));
    expect([...names].sort(), JSON.stringify({ stop: t.engine.session(t.sessionId).stopReason, attempts: attempts.map(a => ({ label: a.action.label, kind: a.action.kind, status: a.status, reason: a.reason })), frontier: t.engine.getFrontier(t.sessionId).map(f => ({ label: f.action.label, reason: f.reason })) })).toEqual(Array.from({ length: 8 }, (_, i) => `Record ${i}`));
    const scrolls = attempts.filter(a => a.action.kind === 'scroll');
    expect(scrolls.length).toBeGreaterThan(6); expect(scrolls.length).toBeLessThan(20);
    expect(scrolls.every(a => a.status === 'succeeded' && a.action.controlId === first.identityId)).toBe(true);
    expect(t.engine.list<Observation>(t.sessionId, 'observation').every(o => o.scroll.y === 0)).toBe(true);
    expect(t.engine.list(t.sessionId, 'reach')).toEqual([]);
    expect(t.engine.session(t.sessionId).stopReason).toBe('known_frontier_exhausted');
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    expect(t.engine.getFrontier(t.sessionId).filter(f => f.status === 'superseded' && f.action.kind === 'scroll').every(f => !f.attempts.length)).toBe(true);
  } finally { await t.close(); }
}, 30000);

it('supports horizontal scroll and detects stale scroll positions even when text stays identical', async () => {
  const t = await fixture('<div id="strip" aria-label="Strip" style="width:160px;overflow:auto"><div style="width:600px;height:40px">Constant</div></div>');
  try {
    const before = t.engine.observation(t.sessionId);
    const a = t.engine.actions(t.sessionId).find(a => a.kind === 'scroll' && a.controlId)!;
    expect(a.value).toEqual({ x: 120, y: 0 });
    await t.engine.execute(t.sessionId, a.id, 'horizontal');
    expect(t.engine.observation(t.sessionId).controls.find(c => c.name === 'Strip')!.scroll!.x).toBe(120);
    expect(t.engine.observation(t.sessionId).stateId).not.toBe(before.stateId);
    const stale = t.engine.actions(t.sessionId).find(a => a.kind === 'scroll' && a.controlId)!;
    await pageOf(t.engine).locator('#strip').evaluate(el => { el.scrollLeft = 40; });
    await expect(t.engine.execute(t.sessionId, stale.id, 'stale')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
  } finally { await t.close(); }
});

it('does not treat clipped content or text editing scrollbars as traversal targets, and blocks an occluded viewport', async () => {
  const t = await fixture(`<textarea style="height:20px">one\ntwo\nthree</textarea><div style="overflow:hidden;height:20px"><div style="height:200px">Clip</div></div>
    <div id="viewport" aria-label="Hidden viewport" style="position:absolute;top:100px;left:100px;width:100px;height:100px;overflow:auto"><div style="height:400px">Content</div></div>
    <div style="position:absolute;top:100px;left:100px;width:100px;height:100px;background:black;z-index:9"></div>`);
  try {
    const scrolls = t.engine.actions(t.sessionId).filter(a => a.kind === 'scroll' && a.controlId);
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0].label).toBe('Hidden viewport');
    expect(scrolls[0].preconditions.blockers![0].code).toBe('pointer_intercepted');
    await expect(t.engine.execute(t.sessionId, scrolls[0].id, 'occluded')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
  } finally { await t.close(); }
});
