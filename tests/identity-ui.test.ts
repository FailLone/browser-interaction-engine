import { it, expect } from 'vitest';
import { chromium, type Page } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IdentityHypothesis } from '@interaction/browser';
import { act, fixtureServer, pageOf, testEngine } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';

async function identityUI(run: (t: Awaited<ReturnType<typeof testEngine>>, page: Page, url: string) => Promise<void>) {
  const fixture = await fixtureServer();
  const t = await testEngine(fixture.url, { evidenceRetention: { mode: 'cache', ttlMs: 60000, maxBytes: 64 * 1024 ** 2, maxObservations: 100 } });
  await act(t.engine, t.sessionId, 'Duplicate controls');
  const app = await createServer(t.engine);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } });
  await ui.listen();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await run(t, page, `http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await fixture.server.close(); }
}

async function openIdentity(page: Page, url: string) {
  await page.goto(url);
  await page.locator('.session-item').first().click();
  await page.getByRole('button', { name: '身份与歧义', exact: true }).click();
  await page.getByRole('heading', { name: 'Reference · 文本输入框', exact: true }).waitFor();
  await page.getByRole('radio', { name: /这是独立控件/ }).waitFor();
}

it('explains duplicate controls with exact historical screenshot positions and records an explicit independent decision', async () => {
  await identityUI(async (t, page, url) => {
    const before = t.engine.observation(t.sessionId);
    const hypotheses = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis');
    const h = hypotheses[0];
    const count = t.engine.session(t.sessionId).actionCount;
    await openIdentity(page, url);
    const panel = page.locator('.identity-panel');
    expect(await panel.innerText()).toContain('当时页面中有多个控件具有相同的识别特征');
    expect(await panel.innerText()).toContain('当时同时出现');
    expect(await panel.innerText()).toContain('相同：名称「Reference」、类型「文本输入框」、所在区域');
    expect(await panel.innerText()).not.toContain('multiple-current-controls');
    const preview = page.getByRole('img', { name: '待确认控件「Reference」局部截图', exact: true });
    expect(await preview.locator('image').getAttribute('href')).toContain(before.id);
    const target = before.controls.find(c => c.localId === h.localId)!;
    expect(Number(await preview.locator('rect').getAttribute('x'))).toBe(Math.max(0, target.rect.x - 2));
    expect(Number(await preview.locator('rect').getAttribute('y'))).toBe(Math.max(0, target.rect.y - 2));
    await page.locator('.identity-target').getByRole('button', { name: '查看整页位置' }).click();
    const full = page.getByRole('img', { name: '待确认控件「Reference」整页位置', exact: true });
    expect(await full.getAttribute('viewBox')).toBe(`0 0 ${before.viewport.width} ${before.viewport.height}`);
    await page.locator('.identity-target').getByRole('button', { name: '返回局部截图' }).click();
    expect(t.engine.session(t.sessionId).actionCount).toBe(count);
    expect(await page.getByRole('radio', { name: /这是候选 1/ }).isDisabled()).toBe(true);
    const save = page.getByRole('button', { name: '保存身份判断', exact: true });
    expect(await save.isDisabled()).toBe(true);
    await page.getByLabel('判断理由（必填）').fill('两个输入框同时存在，这是上方的 Reference，应单独记录。');
    expect(await save.isDisabled()).toBe(true);
    await page.getByRole('radio', { name: /这是独立控件/ }).check();
    expect(await save.isEnabled()).toBe(true);
    expect(await page.locator('.identity-consequence').innerText()).toContain('将单独记录这个控件');
    mkdirSync(resolve('test-results'), { recursive: true });
    await panel.screenshot({ path: resolve('test-results/identity-confirmation.png') });
    await save.click();
    await page.getByText('已确认：作为独立控件记录', { exact: true }).waitFor();
    const saved = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis').find(x => x.id === h.id)!;
    expect(saved.revisions.at(-1)).toMatchObject({ identityId: h.provisionalIdentityId, source: 'human-ui', evidence: expect.arrayContaining(['两个输入框同时存在，这是上方的 Reference，应单独记录。']) });
    expect(t.engine.observation(t.sessionId, before.id)).toEqual(before);
    expect(t.engine.session(t.sessionId).actionCount).toBe(count);
    await t.engine.waitForIdle();
    expect(t.engine.actions(t.sessionId).some(a => a.controlId === h.provisionalIdentityId && a.preconditions.identityResolved)).toBe(true);
    expect(await page.locator('.identity-counts').innerText()).toContain('1 项待确认');
  });
});

it('keeps indistinguishable rebuilt controls pending when the reviewer explicitly lacks evidence', async () => {
  await identityUI(async (t, page, url) => {
    const older = t.engine.observation(t.sessionId);
    const prior = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis')[0];
    // Replace the nodes without changing their observable names, just as a rerender would.
    await pageOf(t.engine).getByLabel('Reference', { exact: true }).evaluateAll(elements => elements.forEach(el => el.replaceWith(el.cloneNode(true))));
    const newer = await t.engine.observe(t.sessionId);
    const all = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis');
    const h = all.find(x => x.observationId === newer.id)!;
    await openIdentity(page, url);
    await page.getByRole('navigation', { name: '待确认与已确认的控件' }).getByRole('button', { name: new RegExp(`控件 ${all.indexOf(h) + 1} ·`) }).click();
    expect(await page.locator('.identity-panel').innerText()).toContain('当前观察：2 项');
    expect(await page.locator('.identity-panel').innerText()).toContain('历史待确认：2 项');
    const candidateNumber = h.candidateIds.indexOf(prior.provisionalIdentityId) + 1;
    const option = page.getByRole('radio', { name: new RegExp(`这是候选 ${candidateNumber}「`) });
    await option.waitFor();
    expect(await option.isEnabled()).toBe(true);
    const candidate = page.locator('.identity-alternative').filter({ has: page.getByText(`候选 ${candidateNumber} · Reference`, { exact: true }) });
    expect(await candidate.innerText()).toContain('历史控件');
    expect(await candidate.locator('image').getAttribute('href')).toContain(older.id);
    expect(await page.locator('.identity-target image').getAttribute('href')).toContain(newer.id);
    const pendingBefore = all.filter(h => h.status === 'pending').length;
    const eventsBefore = t.engine.store.events(t.sessionId).length;
    await page.getByRole('radio', { name: /证据不足，暂不确认/ }).check();
    await page.getByLabel('还缺什么信息（必填）').fill('缺少重建前后两个输入框的稳定记录键；位置相同不能证明对应关系。');
    await page.getByRole('button', { name: '保留待确认', exact: true }).click();
    await page.getByText(/已保留待确认：没有提交身份裁决/).waitFor();
    expect(t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis').filter(h => h.status === 'pending')).toHaveLength(pendingBefore);
    expect(t.engine.store.events(t.sessionId)).toHaveLength(eventsBefore);
    expect(t.engine.actions(t.sessionId).filter(a => a.label === 'Reference').every(a => !a.preconditions.identityResolved)).toBe(true);
    await page.locator('.identity-panel').screenshot({ path: resolve('test-results/identity-evidence-insufficient.png') });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出完整裁决材料' }).click();
    const file = await (await download).path();
    const packet = JSON.parse(readFileSync(file!, 'utf8'));
    expect(packet.hypothesis.id).toBe(h.id);
    expect(packet.target.observationId).toBe(newer.id);
    expect(packet.candidates.find((c: any) => c.identityId === prior.provisionalIdentityId).exhibit.observationId).toBe(older.id);
    expect(packet.images[newer.id].dataUrl).toMatch(/^data:image\/png;base64,/);

  });
});

it('shows an honest fallback for expired screenshots and blocks confirmation when the original control is unavailable', async () => {
  await identityUI(async (t, page, url) => {
    const before = t.engine.observation(t.sessionId);
    await t.engine.observe(t.sessionId);
    await t.engine.releaseEvidence(t.sessionId, before.id);
    await openIdentity(page, url);
    await page.locator('.identity-target .identity-image-missing').waitFor();
    expect(await page.locator('.identity-target').innerText()).toContain('当时的截图未保存或已过期');
    expect(await page.locator('.identity-target').innerText()).toContain('文本输入框');
    expect(await page.getByRole('radio', { name: /这是独立控件/ }).isEnabled()).toBe(true);
    await page.route(`**/observation?id=${before.id}`, route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Observation not found' } }) }));
    await page.reload();
    await page.locator('.session-item').first().click();
    await page.getByRole('button', { name: '身份与歧义', exact: true }).click();
    await page.getByText('发生歧义时的控件记录不可用，暂不能确认。', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: '保存身份判断', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('radio', { name: /证据不足，暂不确认/ }).isEnabled()).toBe(true);
    await page.unrouteAll();
    await page.getByRole('button', { name: '重新加载证据', exact: true }).click();
    await page.getByRole('heading', { name: 'Reference · 文本输入框', exact: true }).waitFor();
    expect(await page.getByRole('radio', { name: /这是独立控件/ }).isEnabled()).toBe(true);
  });
});
