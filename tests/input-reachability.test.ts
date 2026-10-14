import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { act, pageOf, testEngine } from './helpers.js';

async function setup() {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<style>.outside{position:absolute;left:-2400px;top:-2400px}body{min-height:2400px}</style>
      <input id="outside" class="outside" tabindex="-1" aria-label="Offscreen text">
      <select id="choice" class="outside" tabindex="-1" aria-label="Offscreen choice"><option value="one">One</option><option value="two">Two</option></select>
      <input id="below" aria-label="Below fold" style="position:absolute;top:2200px;left:20px">`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { exploration: 'controls', contextRules: [] });
  return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it.each([
  { kind: 'fill', label: 'Offscreen text', selector: '#outside', initial: '', value: 'reachable' },
  { kind: 'select', label: 'Offscreen choice', selector: '#choice', initial: 'one', value: 'two' },
])('blocks $kind outside the reachable scroll area and revalidates after revealing it', async ({ kind, label, selector, initial, value }) => {
  const t = await setup();
  try {
    const c = t.engine.observation(t.sessionId).controls.find(c => c.name === label)!;
    expect(c).toMatchObject({ visible: true, actionable: { outsideScrollableArea: true } });
    await expect(act(t.engine, t.sessionId, label, kind, value)).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    expect(await pageOf(t.engine).locator(selector).inputValue()).toBe(initial);
    await pageOf(t.engine).locator(selector).evaluate(el => { (el as HTMLElement).style.left = '20px'; (el as HTMLElement).style.top = '20px'; });
    await t.engine.observe(t.sessionId);
    expect((await act(t.engine, t.sessionId, label, kind, value)).status).toBe('succeeded');
    expect(await pageOf(t.engine).locator(selector).inputValue()).toBe(value);
  } finally { await t.close(); }
});

it('continues to fill an ordinary below-fold field reachable by document scrolling', async () => {
  const t = await setup();
  try {
    const c = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Below fold')!;
    expect(c.rect.y).toBeGreaterThan(t.engine.observation(t.sessionId).viewport.height);
    expect(c.actionable.outsideScrollableArea).toBe(false);
    expect((await act(t.engine, t.sessionId, 'Below fold', 'fill', 'document-scroll-reachable')).status).toBe('succeeded');
    expect(await pageOf(t.engine).locator('#below').inputValue()).toBe('document-scroll-reachable');
  } finally { await t.close(); }
});
