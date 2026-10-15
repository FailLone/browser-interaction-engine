import { createServer as httpServer } from 'node:http';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import type { ActionAttempt } from '@interaction/browser';
import { createServer } from '../apps/server/src/server.js';
import { testEngine } from './helpers.js';

it('shows upstream causes, opens existing review, and verifies the current scene before continuing', async () => {
  const fixture = httpServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<section aria-label="Area"><input aria-label="Amount"><input aria-label="Search"></section>'); });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  const t = await testEngine(`http://127.0.0.1:${(fixture.address() as { port: number }).port}`, { exploration: 'controls', contextRules: [], regionExploration: 'review' });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`); await page.locator('.session-item').first().click();
    await page.getByRole('button', { name: '上游待办', exact: true }).click();
    const panel = page.getByRole('region', { name: '上游待处理事项' });
    await panel.getByText('确认尚未划分的探索区域', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '打开范围与退出审阅' }).click();
    await page.getByRole('region', { name: '探索范围决策' }).waitFor();
    const m = t.engine.regionReviewMaterial(t.sessionId), reason = { source: 'upper', evidence: ['One current input sample'] };
    await t.engine.reviewRegions(t.sessionId, { ...reason, observationId: m.observationId, regions: [{ key: 'area', label: 'Area', candidateIds: [m.candidates.find(c => c.label === 'Area')!.id] }] });
    const g = t.engine.explorationReviewMaterial(t.sessionId).groups.find(g => g.kind === 'reviewed-region')!;
    await t.engine.decideExplorationGroup(t.sessionId, g.id, g.revision, { ...reason, mode: 'sample', memberKeys: [g.members.find(m => m.label === 'Amount')!.key] });
    await page.getByRole('button', { name: '上游待办', exact: true }).click();
    const current = t.engine.interventionMaterial(t.sessionId);
    await expect.poll(() => panel.getAttribute('data-revision')).toBe(current.revision);
    for (const item of current.items) expect(await panel.innerText()).toContain(item.title);
    await panel.getByRole('button', { name: '重新验证并继续' }).click();
    await panel.getByText('已完成本次恢复前验证，探索已启动；仍待决定的范围继续保留。').waitFor();
    await t.engine.waitForIdle();
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').map(a => a.action.label)).toEqual(['Amount']);
    expect(t.engine.list(t.sessionId, 'continuation')).toHaveLength(1); expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await new Promise<void>(r => fixture.close(() => r())); }
});
