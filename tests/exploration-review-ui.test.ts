import { expect, it } from 'vitest';
import { createServer as httpServer } from 'node:http';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import type { ActionAttempt } from '@interaction/browser';
import { createServer } from '../apps/server/src/server.js';
import { pageOf, testEngine } from './helpers.js';

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

it('shows withdrawn depth reuse as pending and resumes only after a fresh UI decision', async () => {
  const fixture = httpServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<section aria-label="Area"><input aria-label="Amount"><input aria-label="Search"></section>'); });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/a`;
  const t = await testEngine(url, { exploration: 'controls', contextRules: [], regionExploration: 'review' });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  const reason = { source: 'upper', evidence: ['Current public UI scope'] }, businessScope = 'Public UI inspection';
  const group = () => t.engine.explorationReviewMaterial(t.sessionId).groups.find(g => g.kind === 'reviewed-region')!;
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const material = t.engine.regionReviewMaterial(t.sessionId);
    await t.engine.reviewRegions(t.sessionId, { ...reason, observationId: material.observationId, regions: [{ key: 'area', label: 'Area', candidateIds: [material.candidates.find(c => c.label === 'Area')!.id], reuse: { binding: 'same-url-context', businessScope } }] });
    let g = group();
    await t.engine.decideExplorationGroup(t.sessionId, g.id, g.revision, { ...reason, mode: 'sample', memberKeys: [g.members.find(m => m.label === 'Amount')!.key] });
    g = group();
    const source = await t.engine.reviewExplorationDecisionReuse(t.sessionId, { ...reason, observationId: t.engine.observation(t.sessionId).id, groupId: g.id, revision: g.revision, businessScope });
    await pageOf(t.engine).goto(url.replace('/a', '/b')); await t.engine.observe(t.sessionId);
    await pageOf(t.engine).goto(url); await t.engine.observe(t.sessionId);
    const current = t.engine.regionReviewMaterial(t.sessionId), region = current.reuseCandidates![0];
    await t.engine.reuseRegionReviews(t.sessionId, { ...reason, observationId: current.observationId, baseReviewId: current.review!.id, businessScope, regions: [{ reviewId: region.reviewId, regionKey: region.regionKey, conditionKey: region.conditionKey }] });
    for (const destination of t.engine.explorationReviewMaterial(t.sessionId).groups.filter(g => g.kind === 'page')) await t.engine.decideExplorationGroup(t.sessionId, destination.id, destination.revision, { ...reason, mode: 'skip' });
    const depth = t.engine.explorationDecisionReuseMaterial(t.sessionId), candidate = depth.candidates[0];
    await t.engine.reuseExplorationDecisions(t.sessionId, { ...reason, observationId: depth.observationId, businessScope, decisions: [{ reviewId: candidate.reviewId, groupId: candidate.groupId, revision: candidate.revision, conditionKey: candidate.conditionKey }] });
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`); await page.locator('.session-item').first().click();
    await page.getByRole('button', { name: '范围决策', exact: true }).click();
    const panel = page.getByRole('region', { name: '探索范围决策' });
    const area = panel.locator('.review-scope').filter({ has: page.getByRole('checkbox', { name: '选择范围：Area', exact: true }) });
    await area.locator('.badge').getByText('指定样本', { exact: true }).waitFor();
    await area.getByRole('checkbox', { name: '选择范围：Area', exact: true }).check();
    await t.engine.revokeExplorationDecisionReuse(t.sessionId, { reviewId: source.id, source: 'upper', reason: 'Scope changed' });
    await area.getByText('等待重新决定', { exact: true }).waitFor();
    await area.getByText('原决定已失效，请重新确认。', { exact: false }).waitFor();
    await panel.getByText('所选范围已变化，请清空后重新选择。').waitFor();
    expect(await panel.getByRole('button', { name: '穷尽所选范围', exact: true }).isDisabled()).toBe(true);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    await panel.getByRole('button', { name: '清空选择', exact: true }).click();
    await area.getByRole('checkbox', { name: '选择范围：Area', exact: true }).check();
    await area.getByText('查看样本与判断依据', { exact: true }).click();
    await area.locator('.review-sample').filter({ hasText: 'Amount' }).getByRole('checkbox').check();
    await panel.getByRole('button', { name: '仅测所选样本', exact: true }).click();
    await area.locator('.badge').getByText('指定样本', { exact: true }).waitFor();
    expect(await area.getByText('原决定已失效，请重新确认。', { exact: false }).count()).toBe(0);
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    await page.getByRole('button', { name: '▶ DFS 探索', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.runbar .badge')?.textContent === '本轮结束');
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').map(a => a.action.label)).toEqual(['Amount']);
    expect(group().decisions.at(-2)?.invalidation).toBeDefined();
    expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
});
