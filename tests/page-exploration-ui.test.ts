import { expect, it } from 'vitest';
import { createServer as httpServer } from 'node:http';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import type { ActionAttempt } from '@interaction/browser';
import { createServer } from '../apps/server/src/server.js';
import { testEngine } from './helpers.js';

it('shows pending destination pages and applies page permission without automatically executing them', async () => {
  const fixture = httpServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/b'
    ? '<title>Destination B</title><input aria-label="B work">' : '<a href="/b">To B</a>'); });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(fixture.address() as { port: number }).port}/a`, { exploration: 'controls', contextRules: [] });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    expect(await page.getByLabel('页面范围', { exact: true }).inputValue()).toBe('review');
    await page.locator('.session-item').first().click();
    const panel = page.getByRole('region', { name: '跳转页面范围' });
    await panel.waitFor(); expect(await panel.innerText()).toContain('等待决定');
    const count = t.engine.session(t.sessionId).actionCount;
    await page.getByRole('button', { name: '暂缓：Destination B', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.page-scope-panel .badge')?.textContent === '暂缓');
    await page.getByRole('button', { name: '允许本页：Destination B', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.page-scope-panel .badge')?.textContent === '允许本页');
    expect(t.engine.session(t.sessionId).actionCount).toBe(count);
    await page.getByRole('button', { name: '▶ DFS 探索', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.runbar .badge')?.textContent === '本轮结束');
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(a => a.action.label === 'B work' && a.status === 'succeeded')).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
});
