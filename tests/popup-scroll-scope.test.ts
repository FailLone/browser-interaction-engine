import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { act, pageOf, testEngine } from './helpers.js';

it('scrolls a popup viewport outside its inner list and reaches every finite option', async () => {
  const html = `<div role="dialog" aria-modal="true" style="position:absolute;left:40px;top:40px;width:400px;height:300px;background:white">
    <button type="button">Parent operation</button><button role="combobox" aria-expanded="true" aria-controls="choices">Choices</button>
    <div id="panel" style="position:absolute;left:40px;top:70px;width:260px;height:120px;background:white">
    <div id="viewport" style="height:120px;overflow:auto"><div id="choices" role="listbox">
    ${Array.from({ length: 12 }, (_, i) => `<div role="option" style="height:30px" onclick="window.chosen.push(${i})">Option ${i}</div>`).join('')}
    </div></div></div></div><script>window.chosen=[]</script>`;
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
    contextRules: [], exploration: 'controls', listExploration: 'all', settleMs: 40, observeTimeoutMs: 1000,
  });
  try {
    const o = t.engine.observation(t.sessionId), viewport = o.controls.find(c => c.selector === '#viewport')!;
    const active = o.overlays!.at(-1)!;
    expect(active.controlIds).toContain(viewport.localId);
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Parent operation')!.preconditions.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'outside_active_boundary' })]));
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Option 11')!.preconditions.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'pointer_intercepted' })]));
    for (let i = 0; i < 12; i++) {
      for (let scrolls = 0; ; scrolls++) {
        const option = t.engine.actions(t.sessionId).find(a => a.label === `Option ${i}`)!;
        if (!option.preconditions.blockers?.length) break;
        expect(scrolls).toBeLessThan(4);
        const scroll = t.engine.actions(t.sessionId).find(a => a.localId === viewport.localId && a.kind === 'scroll' && typeof a.value === 'object' && a.value !== null && Number((a.value as { y?: number }).y) > 0)!;
        expect(scroll).toBeDefined();
        expect(scroll.preconditions.blockers).toEqual([]);
        expect((await t.engine.execute(t.sessionId, scroll.id, `scroll-${i}-${scrolls}`)).status).toBe('succeeded');
      }
      expect((await act(t.engine, t.sessionId, `Option ${i}`)).status).toBe('succeeded');
    }
    expect(await pageOf(t.engine).evaluate(() => (window as any).chosen)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(t.engine.observation(t.sessionId).controls.find(c => c.localId === viewport.localId)!.scroll!.y).toBeGreaterThan(0);
  } finally { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
