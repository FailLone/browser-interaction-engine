import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import { createServer } from '../apps/server/src/server.js';
import { act, fixtureServer, testEngine } from './helpers.js';

it('shows actual recovery origins and creates generic coverage sessions without application declarations', async () => {
  const fixture = await fixtureServer(); let initialState = '';
  // Force historical work to exercise recovery; entry-page scheduling has separate coverage.
  const t = await testEngine(fixture.url, { contextRules: [], pageExploration: 'all' }, { choose: items => items.find(f => f.stateId === initialState && f.action.label === 'Amount' && f.action.value === '0.001')?.id || null });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    initialState = t.engine.observation(t.sessionId).stateId;
    await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
    await act(t.engine, t.sessionId, 'Rebuild inputs');
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const blocked = t.engine.getFrontier(t.sessionId).find(f => f.recovery)!;
    expect(blocked.recovery?.diagnostics.dirtyActions[0].label).toBe('Rebuild inputs');
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    expect(await page.getByLabel('探索范围', { exact: true }).inputValue()).toBe('controls');
    await page.locator('.session-item').first().click();
    await page.getByRole('button', { name: '探索待办', exact: true }).click();
    const row = page.locator(`tr[data-frontier-id="${blocked.id}"]`);
    await row.locator('.recovery-details summary').click();
    expect(await row.innerText()).toContain('Rebuild inputs');
    expect(await row.innerText()).toContain('副作用未知');
    expect(await row.innerText()).toContain('未配置环境重置');
    await page.getByLabel('起始网址').fill(fixture.url);
    await t.engine.stop(t.sessionId);
    await page.getByRole('button', { name: '＋ 创建探索会话', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.session-item').length === 2);
    expect(t.engine.sessions().at(-1)?.options).toMatchObject({ exploration: 'controls', pageExploration: 'review', environmentReset: 'none', interfaceActions: [], reversible: [], exclude: [] });
    expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await fixture.server.close(); }
});
