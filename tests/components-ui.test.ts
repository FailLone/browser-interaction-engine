import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fixtureServer, testEngine } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';

it('shows a composite group, independent members and historical evidence through public read queries', async () => {
  const fixture = await fixtureServer();
  const t = await testEngine(`${fixture.url}/components.html`, { contextRules: [], evidenceRetention: { mode: 'cache', ttlMs: 60000, maxBytes: 64 * 1024 ** 2, maxObservations: 100 } });
  const seq = t.engine.store.events(t.sessionId).length;
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`); await page.locator('.session-item').first().click();
    await page.getByRole('button', { name: '详细数据', exact: true }).click();
    await page.getByRole('button', { name: '复合控件', exact: true }).click();
    await page.getByRole('button', { name: /Page feedback/ }).click();
    const section = page.getByRole('region', { name: '复合控件详情' });
    await section.getByRole('heading', { name: 'Page feedback' }).waitFor();
    expect(await section.locator('tbody tr').count()).toBe(5);
    expect(await section.innerText()).toContain('结构推测，待验证');
    expect(await section.locator('tbody tr td:nth-child(3)').allTextContents()).toEqual(['未知', '未知', '未知', '未知', '未知']);
    await section.getByRole('img', { name: '复合控件局部截图' }).waitFor();
    await section.getByText('外部解释（保留来源）', { exact: true }).click();
    mkdirSync(resolve('work/components-ui'), { recursive: true });
    await page.locator('.detail-panel').screenshot({ path: resolve('work/components-ui/panel.png') });
    await section.getByRole('button', { name: '查看组件 DOM 子树' }).click();
    await page.locator('.dom-nodes').waitFor(); expect(await page.locator('.dom-nodes').innerText()).toContain('★');
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    expect(t.engine.store.events(t.sessionId)).toHaveLength(seq); expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await fixture.server.close(); }
});
