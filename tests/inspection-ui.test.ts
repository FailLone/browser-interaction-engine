import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import { fixtureServer, act } from './helpers.js';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { createServer } from '../apps/server/src/server.js';

it('shows the stored scope, baseline, required evidence and external verdict without operating the page', async () => {
  const fixture = await fixtureServer(); const engine = new BrowserEngine({ persistence: new MemoryStore() });
  const s = await engine.createSession({ url: `${fixture.url}/inspection.html`, headless: true, settleMs: 50, inspection: { consumers: [{ id: 'checker' }] }, evidenceRetention: { mode: 'cache' } });
  await act(engine, s.id, 'Open oversized popup'); const inspection = engine.listInspections(s.id).items.at(-1)!;
  const app = await createServer(engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }); const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message)); const count = engine.session(s.id).actionCount;
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    await page.locator('.session-item').first().click(); await page.getByRole('button', { name: 'UI 检查', exact: true }).click();
    await page.getByText('checker · 等待检查', { exact: false }).waitFor();
    await engine.completeInspection(s.id, inspection.id, 'checker', [{ ruleId: 'containment', ruleVersion: '1', status: 'fail', severity: 'error', message: '弹层超出视口', details: { checks: [{ code: 'POPUP_OUTSIDE_VIEWPORT' }] } }]);
    await page.getByText('弹层超出视口', { exact: false }).waitFor();
    expect(await page.locator('.inspection-panel').innerText()).toContain('发现问题 · 错误');
    await page.getByText('逐控件规则结果 · containment', { exact: true }).click();
    await page.getByText('POPUP_OUTSIDE_VIEWPORT', { exact: false }).waitFor();
    expect(await page.locator('.inspection-panel').innerText()).toContain('进入弹层前：可比较');
    expect(await page.locator('.inspection-panel').innerText()).toContain('采集完整');
    await page.getByLabel('选择检查任务').selectOption(engine.listInspections(s.id).items[0].id);
    await page.getByText('上次采集：不可用', { exact: false }).waitFor();
    expect(engine.session(s.id).actionCount).toBe(count); expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await engine.close(); await fixture.server.close(); }
});
