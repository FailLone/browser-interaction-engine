import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import { fixtureServer, pageOf } from './helpers.js';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { createServer } from '../apps/server/src/server.js';

it('selects installed plugins, shows warnings, keeps saved runs on reload and isolates a late result from a different task', async () => {
  const fixture = await fixtureServer(); const engine = new BrowserEngine({ persistence: new MemoryStore() });
  const app = await createServer(engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  let release: (() => void) | undefined;
  try {
    const session = await engine.createSession({ url: `${fixture.url}/text-truncation.html`, headless: true, settleMs: 50, inspection: {} });
    const first = engine.listInspections(session.id).items[0];
    await pageOf(engine).locator('#target').evaluate(el => { (el as HTMLElement).style.width = '800px'; });
    await engine.observe(session.id);
    const second = engine.listInspections(session.id).items.at(-1)!;
    const count = engine.session(session.id).actionCount;
    const open = async () => { await page.locator('.session-item').first().click(); await page.getByRole('button', { name: 'UI 检查', exact: true }).click(); };
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`); await open();
    await page.getByLabel('选择检查任务').selectOption(first.id);
    const panel = page.getByRole('region', { name: '规则插件', exact: true });
    await panel.getByRole('button', { name: '运行选中规则' }).click();
    await panel.getByText('文字可能被直接裁断', { exact: true }).waitFor();
    expect(await panel.locator('.rule-result').count()).toBe(3);
    expect(await panel.innerText()).toContain('1 项警告');
    expect(engine.session(session.id).actionCount).toBe(count);
    for (const name of ['控件遮盖', '控件裁切', '文字截断']) await panel.getByRole('checkbox', { name, exact: false }).uncheck();
    expect(await panel.getByRole('button', { name: '运行选中规则' }).isDisabled()).toBe(true);
    await panel.getByRole('checkbox', { name: '文字截断', exact: false }).check();
    await panel.getByRole('button', { name: '运行选中规则' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.rule-result').length === 1);
    await page.reload(); await open(); await page.getByLabel('选择检查任务').selectOption(first.id);
    await panel.getByText('文字可能被直接裁断', { exact: true }).waitFor();
    expect(await panel.getByLabel('选择检测记录').locator('option').count()).toBe(2);
    expect(await panel.locator('.rule-result').count()).toBe(1);
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    await page.route('**/rule-runs', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      entered(); await gate; await route.continue();
    });
    await panel.getByRole('button', { name: '运行选中规则' }).click(); await ready;
    await page.getByLabel('选择检查任务').selectOption(second.id);
    await panel.getByText('此任务尚未运行规则检测。', { exact: true }).waitFor();
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/rule-runs'));
    release!(); await response;
    await panel.getByRole('button', { name: '运行选中规则' }).click();
    await panel.getByRole('heading', { name: '文字截断 · 通过', exact: true }).waitFor();
    expect(await panel.getByText('文字可能被直接裁断', { exact: true }).count()).toBe(0);
    expect(engine.session(session.id).actionCount).toBe(count);
    expect(errors).toEqual([]);
  } finally { release?.(); await browser.close(); await ui.close(); await app.close(); await engine.close(); await fixture.server.close(); }
});
