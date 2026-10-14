import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { testEngine, act } from './helpers.js';

async function fixture(body: string) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as {port:number}).port}`, { exploration: 'controls', contextRules: [] });
  return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it('includes sibling search and close controls in a floating virtual-list popup, including empty search results', async () => {
  const t = await fixture(`<button id="open" onclick="panel.hidden=false">Open choices</button><input aria-label="Background">
    <div id="panel" hidden style="position:absolute;top:80px;left:80px;width:260px;height:240px;z-index:9;background:white">
      <input aria-label="Find choice" oninput="choices.innerHTML=this.value==='missing'?'':'<button>Alpha</button><button>Beta</button>'">
      <button onclick="panel.hidden=true">Close</button>
      <div style="overflow:auto;height:160px;position:relative"><div style="height:1200px;position:relative;overflow:hidden">
        <div id="choices" role="listbox" style="position:absolute;left:0;right:0"><button>Alpha</button><button>Beta</button></div>
      </div></div>
    </div>`);
  try {
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    await act(t.engine, t.sessionId, 'Open choices');
    const opened = t.engine.observation(t.sessionId);
    expect(opened.overlays).toHaveLength(1);
    expect(opened.overlays![0]).toMatchObject({ selector: '#panel', evidence: expect.arrayContaining(['composite-popup-panel']) });
    const boundary = opened.boundaries![0].key;
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Find choice')).toMatchObject({ boundary: { key: boundary, intent: 'interact' }, preconditions: { blockers: [] } });
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Background')!.preconditions.blockers![0].code).toBe('outside_active_boundary');
    await act(t.engine, t.sessionId, 'Find choice', 'fill', 'missing');
    expect(t.engine.observation(t.sessionId).boundaries!.map(b => b.key)).toEqual([boundary]);
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Find choice')!.preconditions.blockers).toEqual([]);
    await act(t.engine, t.sessionId, 'Find choice', 'fill', '');
    expect(t.engine.observation(t.sessionId).boundaries!.map(b => b.key)).toEqual([boundary]);
    await act(t.engine, t.sessionId, 'Close');
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    await act(t.engine, t.sessionId, 'Background', 'fill');
  } finally { await t.close(); }
});

it('keeps an unrelated landmark search outside the list boundary', async () => {
  const t = await fixture(`<aside style="position:fixed;top:50px;left:50px;width:300px;height:300px">
    <input aria-label="Site search"><div role="listbox" style="position:absolute;top:70px"><button>Item</button></div></aside>`);
  try {
    expect(t.engine.observation(t.sessionId).overlays).toHaveLength(1);
    expect(t.engine.observation(t.sessionId).overlays![0].evidence).not.toContain('composite-popup-panel');
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Site search')!.preconditions.blockers![0].code).toBe('outside_active_boundary');
  } finally { await t.close(); }
});

it('does not combine separate popup lists through a shared positioned ancestor', async () => {
  const t = await fixture(`<div style="position:absolute;top:50px;left:50px;width:350px;height:300px">
    <input aria-label="Unrelated search"><div role="listbox" style="position:absolute;top:60px"><button>First</button></div>
    <div role="listbox" style="position:absolute;top:160px"><button>Second</button></div></div>`);
  try {
    expect(t.engine.observation(t.sessionId).overlays).toHaveLength(2);
    expect(t.engine.observation(t.sessionId).overlays!.every(b => !b.evidence.includes('composite-popup-panel'))).toBe(true);
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Unrelated search')!.preconditions.blockers![0].code).toBe('outside_active_boundary');
  } finally { await t.close(); }
});
