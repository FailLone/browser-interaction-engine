import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fixtureServer, testEngine, act } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';

it('opens historical event details in the UI, switches before/after, and reads DOM, screenshots and ARIA without execution', async () => {
  const fixture = await fixtureServer(); const t = await testEngine(`${fixture.url}/evidence.html`, { contextRules: [] });
  const attempt = await act(t.engine, t.sessionId, '订单金额', 'fill', '42');
  const event = t.engine.store.events(t.sessionId).find(e => e.type === 'action.completed')!;
  const count = t.engine.session(t.sessionId).actionCount; const seq = t.engine.store.events(t.sessionId).length;
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    await page.locator('.session-item').first().click();
    await page.getByRole('button', { name: '事件', exact: true }).click();
    const row = page.locator(`[data-event-sequence="${event.sequence}"]`);
    await row.getByText('原始 data', { exact: true }).click();
    expect(await row.locator('pre').innerText()).toContain(attempt.beforeId);
    await row.getByRole('button', { name: '查看详细证据' }).click();
    await page.getByRole('heading', { name: `事件 #${event.sequence} · 历史详细数据` }).waitFor();
    await page.getByRole('button', { name: /^操作前/ }).click();
    const facts = page.locator('.control-facts'); await facts.locator('dd').filter({ hasText: /^"10"$/ }).waitFor();
    expect(await page.locator('.evidence-facts').innerText()).toContain(attempt.beforeId);
    await page.getByText('完整文案与标签关系', { exact: true }).click();
    expect(await page.locator('.evidence-section').filter({ has: page.getByText('完整文案与标签关系', { exact: true }) }).innerText()).toContain('最小为 1');
    await page.getByRole('button', { name: '查看该控件 DOM 子树' }).click();
    await page.locator('.dom-nodes').waitFor(); expect(await page.locator('.dom-nodes').innerText()).toContain('input');
    await page.getByText('原始 HTML', { exact: true }).click();
    expect(await page.locator('.evidence-section').filter({ has: page.getByText('原始 HTML', { exact: true }) }).innerText()).toContain('data-business-field="order.amount"');
    await page.getByRole('button', { name: '截图', exact: true }).click();
    const image = page.getByAltText('历史视口截图');
    expect(await image.getAttribute('src')).toContain(attempt.beforeId);
    await page.waitForFunction(() => (document.querySelector('img[alt="历史视口截图"]') as HTMLImageElement)?.naturalWidth > 0);
    await page.getByRole('button', { name: 'ARIA', exact: true }).click();
    expect(await page.locator('.evidence-inspector > pre').innerText()).toContain('订单金额');
    await page.getByRole('button', { name: /^操作后/ }).click();
    await page.locator('.control-facts dd').filter({ hasText: /^"42"$/ }).waitFor();
    expect(await page.locator('.evidence-facts').innerText()).toContain(attempt.afterId);
    await page.getByRole('button', { name: '完整 JSON', exact: true }).click();
    expect(await page.locator('.evidence-inspector > pre').innerText()).toContain('network');
    await page.getByRole('button', { name: '控件详情', exact: true }).click();
    await page.getByText('属性与实时状态', { exact: true }).click();
    mkdirSync(resolve('docs/screenshots'), { recursive: true });
    await page.locator('.tab-content').evaluate(el => { el.scrollTop = 0; });
    await page.locator('.detail-panel').screenshot({ path: resolve('docs/screenshots/evidence-inspector.png') });
    expect(t.engine.session(t.sessionId).actionCount).toBe(count);
    expect(t.engine.store.events(t.sessionId)).toHaveLength(seq); expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await fixture.server.close(); }
});

it('shows missing detailed snapshots and events without observation references explicitly', async () => {
  const fixture = await fixtureServer(); const t = await testEngine(`${fixture.url}/evidence.html`, { contextRules: [] });
  const o = t.engine.observation(t.sessionId); const { evidence, ...legacy } = o;
  const historicalId = crypto.randomUUID(); t.engine.store.put('observation', { ...legacy, id: historicalId });
  t.engine.store.put('session', { ...t.engine.session(t.sessionId), currentObservationId: historicalId });
  const event = t.engine.store.event(t.sessionId, 'plugin.notice', { note: 'No observation reference' });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`); await page.locator('.session-item').first().click();
    await page.getByRole('button', { name: '详细数据', exact: true }).click();
    await page.getByText('详细证据未保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '采集缺口', exact: true }).click();
    expect(await page.locator('.evidence-inspector').innerText()).toContain('DETAIL_NOT_CAPTURED');
    await page.getByRole('button', { name: '事件', exact: true }).click();
    await page.locator(`[data-event-sequence="${event.sequence}"]`).getByRole('button', { name: '查看详细证据' }).click();
    await page.getByText('EVENT_HAS_NO_OBSERVATION_REFERENCE', { exact: true }).waitFor();
    expect(await page.locator('.evidence-facts').count()).toBe(0);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await fixture.server.close(); }
});

it('opens an inline event snapshot after transient server evidence has been released without querying it again', async () => {
  const fixture = await fixtureServer();
  const t = await testEngine(`${fixture.url}/evidence.html`, { contextRules: [], evidenceRetention: { mode: 'transient', ttlMs: 60000, maxBytes: 64 * 1024 ** 2, maxObservations: 100 } });
  const observation = t.engine.observation(t.sessionId);
  const event = t.engine.store.events(t.sessionId).find(e => e.type === 'observation.created')!;
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    await page.getByText('详细证据留存', { exact: true }).click();
    expect(await page.getByLabel('留存方式', { exact: true }).inputValue()).toBe('cache');
    await page.getByLabel('留存方式', { exact: true }).selectOption('transient');
    expect(await page.getByLabel('保留秒数', { exact: false }).inputValue()).toBe('30');
    await page.locator('.session-item').first().click();
    await page.getByRole('button', { name: '事件', exact: true }).click();
    await page.getByLabel('事件交付', { exact: true }).selectOption('inline');
    const open = page.locator(`[data-event-sequence="${event.sequence}"]`).getByRole('button', { name: '打开事件快照', exact: true });
    await open.waitFor();
    await t.engine.releaseEvidence(t.sessionId, observation.id);
    expect((await t.engine.observationDetails(t.sessionId, observation.id)).availability.details.status).toBe('released');
    const requests: string[] = [];
    page.on('request', request => { if (/\/(details|dom|controls|artifacts|context)(\/|\?|$)/.test(new URL(request.url()).pathname)) requests.push(request.url()); });
    await open.click();
    await page.getByText('事件快照中的控件与操作；详情和 DOM 使用已交付内容，图片引用仍受服务端留存限制。', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'DOM / HTML', exact: true }).click();
    await page.getByText('原始 HTML', { exact: true }).click();
    expect(await page.locator('.evidence-inspector').innerText()).toContain('data-business-field="order.amount"');
    await page.getByRole('button', { name: '截图', exact: true }).click();
    expect(await page.getByAltText('历史视口截图').getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    await page.waitForFunction(() => (document.querySelector('img[alt="历史视口截图"]') as HTMLImageElement)?.naturalWidth > 0);
    expect(requests).toEqual([]); expect(errors).toEqual([]);
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await fixture.server.close(); }
});
