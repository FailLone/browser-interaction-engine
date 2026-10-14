import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { fixtureServer, testEngine, act, pageOf } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';
import type { ActionAttempt } from '@interaction/browser';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
let t: Awaited<ReturnType<typeof testEngine>>;
let app: Awaited<ReturnType<typeof createServer>>;
let ui: ViteDevServer;
let browser: Browser;
let page: Page;
let opened: ActionAttempt, market: ActionAttempt, amount: ActionAttempt;
let errors: string[];

beforeAll(async () => { fixture = await fixtureServer(); browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); await fixture.server.close(); });
beforeEach(async () => {
  t = await testEngine(fixture.url);
  opened = await act(t.engine, t.sessionId, 'Order type');
  market = await act(t.engine, t.sessionId, 'Market');
  amount = await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
  app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const apiPort = (app.server.address() as { port: number }).port;
  ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${apiPort}` } } }); await ui.listen();
  page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as { port: number }).port}`);
  await page.locator('.session-item').filter({ hasText: t.sessionId.slice(0, 8) }).click();
  await page.getByRole('button', { name: '变化比较', exact: true }).click();
  await expectDiff(amount);
});
afterEach(async () => {
  await page.close(); await ui.close(); await app.close(); await t.close();
  expect(errors).toEqual([]);
});

async function expectDiff(attempt: ActionAttempt) {
  await page.waitForFunction(afterId => {
    const text = document.querySelector('[data-testid="raw-diff"]')?.textContent;
    return text && JSON.parse(text).afterId === afterId;
  }, attempt.afterId);
  await page.waitForFunction(id => document.querySelector('[data-testid="diff-explanation"]')?.getAttribute('data-after-id') === id, attempt.afterId);
  const panel = page.getByTestId('visit-diff');
  expect(await panel.locator('.diff-title b').textContent()).toBe(attempt.action.label);
  expect(JSON.parse((await panel.getByTestId('raw-diff').textContent())!)).toEqual(attempt.diff);
  expect(await panel.getByAltText('操作前').getAttribute('src')).toContain(attempt.beforeId);
  expect(await panel.getByAltText('操作后').getAttribute('src')).toContain(attempt.afterId);
  expect(await page.getByAltText('页面观察截图').getAttribute('src')).toContain(attempt.afterId);
}

it('changes the diff and both images with the selected visit, including repeated states', async () => {
  const actionCount = t.engine.session(t.sessionId).actionCount;
  await page.locator('.visit').filter({ hasText: 'click · Order type' }).click(); await expectDiff(opened);
  await page.locator('.visit').filter({ hasText: 'click · Market' }).click(); await expectDiff(market);
  await page.locator('.visit').first().click();
  await page.getByText('入口观察没有前一步，暂无可比较的差异。').waitFor();
  expect(await page.getByTestId('visit-diff').count()).toBe(0);
  expect(t.engine.session(t.sessionId).actionCount).toBe(actionCount);

  // A second visit reaches exactly the same state, with a different incoming edge.
  const repeated = await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
  expect(t.engine.observation(t.sessionId, amount.afterId).stateId).toBe(t.engine.observation(t.sessionId, repeated.afterId).stateId);
  await page.waitForFunction(() => [...document.querySelectorAll('.visit')].filter(el => el.textContent?.includes('fill · Amount')).length === 2);
  const amountVisits = page.locator('.visit').filter({ hasText: 'fill · Amount' });
  await amountVisits.first().click(); await expectDiff(amount);
  await amountVisits.last().click(); await expectDiff(repeated);
});

it('compares supplemental observations to their parent and keeps history pinned during SSE refresh', async () => {
  await page.locator('.visit').filter({ hasText: 'click · Market' }).click(); await expectDiff(market);
  await pageOf(t.engine).locator('#amount').fill('3');
  const inspected = await t.engine.observe(t.sessionId);
  await page.locator('.visit').filter({ hasText: '补充观察' }).waitFor();
  await expectDiff(market);
  await page.getByRole('button', { name: '返回当前', exact: true }).click();
  await page.waitForFunction(id => {
    const text = document.querySelector('[data-testid="raw-diff"]')?.textContent;
    return text && JSON.parse(text).afterId === id;
  }, inspected.id);
  await page.getByTestId('diff-explanation').waitFor();
  const panel = page.getByTestId('visit-diff');
  expect(await panel.locator('.diff-title b').innerText()).toBe('补充观察');
  const diff = JSON.parse((await panel.getByTestId('raw-diff').textContent())!);
  expect(diff.beforeId).toBe(amount.afterId);
  expect(diff.changes).toContainEqual(expect.objectContaining({ field: 'value', before: '2', after: '3' }));
  expect(await panel.getByAltText('操作后').getAttribute('src')).toContain(inspected.id);
  expect(t.engine.session(t.sessionId).actionCount).toBe(3);
});

it('ignores delayed history responses after selecting another visit or returning to current', async () => {
  let release!: () => void, intercepted!: () => void, fulfilled!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { intercepted = resolve; });
  const completed = new Promise<void>(resolve => { fulfilled = resolve; });
  await page.route(`**/observation?id=${market.afterId}`, async route => {
    const response = await route.fetch(); intercepted(); await blocked;
    await route.fulfill({ response }); fulfilled();
  });
  try {
    await page.locator('.visit').filter({ hasText: 'click · Market' }).click(); await requested;
    expect(await page.getByTestId('visit-diff').count()).toBe(0);
    await page.locator('.visit').filter({ hasText: 'click · Order type' }).click(); await expectDiff(opened);
    await page.getByRole('button', { name: '返回当前', exact: true }).click(); await expectDiff(amount);
    release(); await completed;
    // Wait for the ignored observation fetch to reach React, not an arbitrary timer.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expectDiff(amount);
    expect(await page.getByRole('button', { name: '返回当前', exact: true }).count()).toBe(0);
  } finally { release(); }
});

it('clears a previous session comparison and ignores its outstanding history response', async () => {
  await t.engine.stop(t.sessionId);
  const second = await t.engine.createSession({ url: fixture.url, headless: true, settleMs: 60, observeTimeoutMs: 600 });
  await page.reload();
  await page.locator('.session-item').filter({ hasText: t.sessionId.slice(0, 8) }).click();
  await page.getByRole('button', { name: '变化比较', exact: true }).click(); await expectDiff(amount);
  let release!: () => void, intercepted!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { intercepted = resolve; });
  await page.route(`**/observation?id=${market.afterId}`, async route => { const response = await route.fetch(); intercepted(); await blocked; await route.fulfill({ response }); });
  try {
    await page.locator('.visit').filter({ hasText: 'click · Market' }).click(); await requested;
    await page.locator('.session-item').filter({ hasText: second.id.slice(0, 8) }).click();
    await page.getByText('入口观察没有前一步，暂无可比较的差异。').waitFor();
    release();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.getByTestId('visit-diff').count()).toBe(0);
    expect(await page.getByAltText('页面观察截图').getAttribute('src')).toContain(second.currentObservationId);
  } finally { release(); }
});

it('shows a failed history read without displaying the latest action as its diff', async () => {
  await page.route(`**/observation?id=${market.afterId}`, route => route.fulfill({ status: 503, json: { error: { message: 'History read unavailable' } } }));
  await page.locator('.visit').filter({ hasText: 'click · Market' }).click();
  await page.getByRole('alert').filter({ hasText: 'History read unavailable' }).waitFor();
  expect(await page.getByTestId('visit-diff').count()).toBe(0);
  await page.getByRole('button', { name: '返回当前', exact: true }).click(); await expectDiff(amount);
});

it('loads the selected attempt when it is outside the dashboard first page', async () => {
  const offsets: number[] = [];
  await page.route('**/attempts?*', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') || 0);
    offsets.push(offset);
    return route.fulfill({ json: { items: offset === 0 ? [opened, market] : [amount], total: 3 } });
  });
  await page.reload();
  await page.locator('.session-item').filter({ hasText: t.sessionId.slice(0, 8) }).click();
  await page.getByRole('button', { name: '变化比较', exact: true }).click();
  await expectDiff(amount);
  expect(offsets).toContain(2);
  await page.locator('.visit').filter({ hasText: 'click · Market' }).click(); await expectDiff(market);
});

it('shows readable field meaning, historical control evidence and matching screenshot regions', async () => {
  const explanation = page.getByTestId('diff-explanation');
  expect(await explanation.innerText()).toContain('Amount');
  expect(await explanation.innerText()).toContain('当前值的记录值发生变化');
  const control = page.getByTestId('diff-control').filter({ hasText: 'Amount' }).first();
  await control.locator('summary').first().click();
  expect(await control.innerText()).toContain('Order form');
  expect(await control.innerText()).toContain('scoped-stable-key');
  await control.getByRole('button', { name: '在前后截图中定位' }).click();
  expect(await explanation.locator('svg rect').count()).toBe(2);
  const target = t.engine.observation(t.sessionId).controls.find(c => c.identityId === amount.action.controlId)!;
  expect(await explanation.locator('svg').last().locator('rect').getAttribute('x')).toBe(String(target.rect.x));
  const apiLink = explanation.getByRole('link', { name: '完整详情 API ↗' });
  expect(await apiLink.getAttribute('href')).toContain(`/attempts/${amount.id}/diff/details`);

  await pageOf(t.engine).locator('#quick-market').evaluate(el => el.setAttribute('aria-expanded', 'false'));
  const inspected = await t.engine.observe(t.sessionId);
  await page.waitForFunction(id => document.querySelector('[data-testid="diff-explanation"]')?.getAttribute('data-after-id') === id, inspected.id);
  expect(await explanation.innerText()).toContain('不能据此认定发生了视觉展开或收起');
  await page.screenshot({ path: '.data/diff-details-ui.png', fullPage: true });
});

it('ignores a delayed detail response after selecting another visit', async () => {
  let release!: () => void, requested!: () => void, done!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  const completed = new Promise<void>(resolve => { done = resolve; });
  await page.route(`**/attempts/${market.id}/diff/details`, async route => {
    const response = await route.fetch(); requested(); await blocked; await route.fulfill({ response }); done();
  });
  try {
    await page.locator('.visit').filter({ hasText: 'click · Market' }).click(); await started;
    expect(await page.getByTestId('diff-explanation').count()).toBe(0);
    await page.locator('.visit').filter({ hasText: 'click · Order type' }).click(); await expectDiff(opened);
    release(); await completed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expectDiff(opened);
  } finally { release(); }
});
