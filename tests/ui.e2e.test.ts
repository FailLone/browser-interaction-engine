import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixtureServer, testEngine } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';
it('exposes the actual engine through the UI and renders a traversed Market flow', async () => {
  const fixture = await fixtureServer(); const t = await testEngine(fixture.url); const app = await createServer(t.engine);
  await app.listen({ host: '127.0.0.1', port: 0 }); const apiPort = (app.server.address() as any).port;
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${apiPort}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    await page.locator('.session-item').first().click();
    const orderType = page.locator('.action-row').filter({ has: page.locator('b', { hasText: /^Order type$/ }) });
    await orderType.getByRole('button', { name: '执行 ↗' }).click();
    await page.locator('.boundary-notice').waitFor();
    expect(await page.locator('.boundary-notice').innerText()).toContain('Order types');
    expect(await orderType.getByRole('button', { name: '执行 ↗' }).isDisabled()).toBe(true);
    const market = page.locator('.action-row').filter({ has: page.locator('b', { hasText: /^Market$/ }) });
    await market.getByRole('button', { name: '执行 ↗' }).click();
    await page.locator('.boundary-notice').waitFor({ state: 'hidden' });
    await page.getByLabel('Amount 输入样本').fill('2');
    await page.locator('.action-row').filter({ has: page.locator('b', { hasText: /^Amount$/ }) }).getByRole('button', { name: '执行 ↗' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.visit').length >= 4);
    await page.getByRole('button', { name: '变化比较', exact: true }).click();
    await page.getByAltText('操作后').waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    mkdirSync(resolve('docs/screenshots'), { recursive: true });
    await page.screenshot({ path: resolve('docs/screenshots/dashboard.png'), fullPage: true });
    expect(errors).toEqual([]); expect(t.engine.session(t.sessionId).actionCount).toBe(3);
    expect(t.engine.observation(t.sessionId).controls.find(c => c.name === 'Amount')?.value).toBe('2');
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await fixture.server.close(); }
});
