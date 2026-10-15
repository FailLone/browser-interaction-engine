import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fixtureServer, testEngine } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';
it('exposes the actual engine through the UI and renders a traversed Market flow', async () => {
  const fixture = await fixtureServer(); const t = await testEngine(fixture.url); const app = await createServer(t.engine);
  await app.listen({ host: '127.0.0.1', port: 0 }); const apiPort = (app.server.address() as any).port;
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${apiPort}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    expect(await page.getByLabel('探索范围').inputValue()).toBe('controls');
    expect(await page.getByRole('button', { name: '使用测试站常规配置' }).count()).toBe(0);
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

it('shows independent control coverage and allows exact current-node actions despite historical ambiguity', async () => {
  const fixture = await fixtureServer(); const t = await testEngine(fixture.url, { exploration: 'controls', contextRules: [] });
  await act(t.engine, t.sessionId, 'Duplicate controls');
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    await page.locator('.session-item').first().click();
    await page.locator('.coverage-summary').waitFor();
    expect(await page.locator('.coverage-summary').innerText()).toContain('1 / 15');
    const completion = page.getByLabel('整页完成判定');
    expect(await completion.innerText()).toContain('整页穷尽尚未证明');
    await completion.getByText('按页面范围查看缺口', { exact: true }).click();
    expect(await completion.innerText()).toContain('EVENT_LISTENER_COVERAGE');
    const duplicates = page.locator('.action-row').filter({ has: page.locator('b', { hasText: /^Reference$/ }) });
    expect(await duplicates.count()).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(await duplicates.first().innerText()).toContain('当前节点已定位；历史身份待确认');
      expect(await duplicates.first().getByRole('button', { name: '执行 ↗' }).isEnabled()).toBe(true);
      await duplicates.first().getByRole('button', { name: '执行 ↗' }).click();
      await page.waitForFunction(count => document.querySelector('.coverage-summary')?.textContent?.includes(`${count} / 15`), i + 2);
    }
    expect(t.engine.controlCoverage(t.sessionId).counts).toMatchObject({ covered: 3, incomplete: 12 });
    expect(t.engine.list<{ status: string }>(t.sessionId, 'hypothesis').some(h => h.status === 'pending')).toBe(true);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await fixture.server.close(); }
});

it('shows evidence and explicit probes separately from observed-only elements', async () => {
  const fixture = await fixtureServer(); const t = await testEngine(`${fixture.url}/action-evidence.html`, { contextRules: [] });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    await page.locator('.session-item').first().click();
    const tentative = page.locator('.action-row').filter({ has: page.locator('b', { hasText: /^Handler with unknown purpose$/ }) });
    await tentative.getByText('疑似操作 · 默认跳过', { exact: true }).click();
    expect(await tentative.locator('pre').innerText()).toContain('click-handler/v1');
    expect(await tentative.getByRole('button', { name: '试探 ↗' }).isEnabled()).toBe(true);
    expect(await page.locator('.action-row').filter({ has: page.locator('b', { hasText: /^Focusable prose$/ }) }).count()).toBe(0);
    await page.getByText('仅观察的元素（未生成操作）', { exact: true }).click();
    expect(await page.locator('details').filter({ has: page.getByText('仅观察的元素（未生成操作）', { exact: true }) }).innerText()).toContain('Focusable prose');
    await tentative.getByRole('button', { name: '试探 ↗' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.visit').length >= 2);
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Handler with unknown purpose')?.basis?.status).toBe('tentative');
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await fixture.server.close(); }
});
