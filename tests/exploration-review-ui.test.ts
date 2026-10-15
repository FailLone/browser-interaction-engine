import { expect, it } from 'vitest';
import { createServer as httpServer } from 'node:http';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import type { ActionAttempt } from '@interaction/browser';
import { createServer } from '../apps/server/src/server.js';
import { testEngine } from './helpers.js';

it('reviews overlapping scopes together, refuses stale selections, and submits explicit samples without starting exploration', async () => {
  const fixture = httpServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<section aria-label="Converter"><select aria-label="Currency"><option>A</option><option>B</option><option>C</option></select></section>'); });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(fixture.address() as { port: number }).port}`, { exploration: 'controls', contextRules: [], decisionScopes: ['input-space'] });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`); await page.locator('.session-item').first().click();
    await page.getByRole('button', { name: '范围决策', exact: true }).click();
    const panel = page.getByRole('region', { name: '探索范围决策' }); await panel.waitFor();
    expect(await panel.innerText()).toContain('重叠约束');
    await panel.getByRole('button', { name: '选择此组当前 2 项' }).click();
    const g = t.engine.explorationReviewMaterial(t.sessionId).groups[0];
    await t.engine.decideExplorationGroup(t.sessionId, g.id, g.revision, { mode: 'defer', source: 'other-consumer', evidence: ['Decision changed elsewhere'] });
    await panel.getByText('所选范围已变化，请清空后重新选择。').waitFor();
    expect(await panel.getByRole('button', { name: '穷尽所选范围', exact: true }).isDisabled()).toBe(true);
    await panel.getByRole('button', { name: '清空选择', exact: true }).click();
    await panel.getByRole('button', { name: '选择此组当前 2 项' }).click();
    await panel.getByRole('button', { name: '暂缓所选范围', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.review-scope .badge')].every(e => e.textContent === '暂缓'));
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    await panel.getByRole('button', { name: '选择此组当前 2 项' }).click();
    for (const scope of await panel.locator('.review-scope').all()) {
      await scope.getByText('查看样本与判断依据', { exact: true }).click();
      await scope.locator('.review-sample').filter({ hasText: ' · "B"' }).getByRole('checkbox').check();
    }
    await panel.getByRole('button', { name: '仅测所选样本', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.review-scope .badge')].every(e => e.textContent === '指定样本'));
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    await page.getByRole('button', { name: '▶ DFS 探索', exact: true }).click(); await t.engine.waitForIdle();
    await page.waitForFunction(() => document.querySelector('.runbar .badge')?.textContent === '本轮结束');
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').map(a => a.action.value)).toEqual(['B']);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
});
