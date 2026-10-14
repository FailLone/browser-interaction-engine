import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import type { FrontierItem } from '@interaction/browser';
import { createServer } from '../apps/server/src/server.js';
import { act, fixtureServer, testEngine } from './helpers.js';

it('shows completed parent work without legacy overlay duplicates and explains branch recovery failures', async () => {
  const fixture = await fixtureServer(); const t = await testEngine(fixture.url, { contextRules: [] });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  try {
    const parentState = t.engine.observation(t.sessionId).stateId;
    await act(t.engine, t.sessionId, 'Other settings');
    const action = t.engine.actions(t.sessionId).find(a => a.label === 'Amount')!;
    t.engine.store.put('frontier', { id: 'legacy-overlay-amount', sessionId: t.sessionId, key: 'legacy-overlay-amount', stateId: action.stateId, contextKey: '{}', action, status: 'blocked', reason: 'outside_active_boundary', unblock: action.preconditions.blockers![0].unblock, attempts: [], depth: 1 } satisfies FrontierItem);
    await act(t.engine, t.sessionId, 'Done'); await act(t.engine, t.sessionId, 'Amount', 'fill');
    const unreachable = t.engine.list<FrontierItem>(t.sessionId, 'frontier').find(f => f.stateId === parentState && f.action.label === 'Post only')!;
    unreachable.status = 'blocked'; unreachable.reason = 'Business state may have changed; environment reset required'; unreachable.unblock = 'Reach the branch checkpoint or repair its preconditions'; t.engine.store.put('frontier', unreachable);
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    await page.locator('.session-item').first().click();
    await page.getByRole('button', { name: '探索待办', exact: true }).click();
    const rows = page.locator('.tab-content tbody tr');
    await rows.first().waitFor();
    expect(await rows.count()).toBe(t.engine.list<FrontierItem>(t.sessionId, 'frontier').length);
    const amount = rows.filter({ has: page.getByRole('cell', { name: 'Amount fill', exact: true }) }).filter({ hasText: parentState.slice(0, 8) });
    expect(await amount.innerText()).toContain('已执行');
    expect(await page.locator('.tab-content').innerText()).not.toContain('Close and verify exit');
    expect(await rows.filter({ has: page.getByRole('cell', { name: 'Post only check', exact: true }) }).filter({ hasText: parentState.slice(0, 8) }).innerText()).toContain('无法返回所属界面');
  } finally { await browser.close(); await ui.close(); await app.close(); await t.close(); await fixture.server.close(); }
});
