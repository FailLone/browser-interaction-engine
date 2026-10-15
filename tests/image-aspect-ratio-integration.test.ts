import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { builtinRulePlugins, type RulePluginRun, type RuleAutomation } from '@interaction/rules';
import { createServer } from '../apps/server/src/server.js';
import { fixtureServer } from './helpers.js';

it('detects images during ordinary DFS, persists their history, and displays their labels in the debug UI', async () => {
  const fixture = await fixtureServer(), engine = new BrowserEngine({ persistence: new MemoryStore() });
  const app = await createServer(engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false,
    proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const s = await engine.createSession({ url: fixture.url + '/image-aspect-ratio.html', headless: true, viewport: { width: 1100, height: 800 },
      inspection: {}, settleMs: 60, maxActions: 15, pageExploration: 'all', evidenceRetention: { mode: 'persistent' } });
    const image = builtinRulePlugins.find(p => p.id === 'image-aspect-ratio')!;
    expect((await app.inject({ method: 'POST', url: `/v1/sessions/${s.id}/rule-automation`, payload: { enabled: true, plugins: [{ id: image.id, version: image.version }] } })).statusCode).toBe(200);
    await engine.explore(s.id); await engine.waitForIdle();
    const inspections = engine.listInspections(s.id, { limit: 500 }).items;
    await expect.poll(() => engine.list<RuleAutomation>(s.id, 'rule-automation')[0]?.completedCount, { timeout: 15000 }).toBe(inspections.length);
    const saved = engine.list<RulePluginRun>(s.id, 'rule-plugin-run');
    expect(saved).toHaveLength(inspections.length);
    expect(saved.every(r => r.origin === 'automatic' && r.results.every(p => p.status === 'completed'))).toBe(true);
    const findings = saved.flatMap(r => r.results.flatMap(p => p.status === 'completed' ? p.report.checks.map(c => ({ ...c, label: c.target ? p.targetLabels[c.target.nodeId] : undefined })) : []));
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '压扁的图片', code: 'IMAGE_NON_UNIFORM_SCALING', severity: 'warning' }),
      expect.objectContaining({ label: '压扁的图片', code: 'IMAGE_ASPECT_RATIO_RESTORED', verdict: 'pass' }),
      expect.objectContaining({ label: '弹层内压扁图片', code: 'IMAGE_NON_UNIFORM_SCALING', severity: 'warning' }),
    ]));
    expect(findings.some(c => c.severity === 'error')).toBe(false);
    expect(findings.some(c => c.code === 'IMAGE_FINDING_NOT_RECHECKED')).toBe(true);
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    await page.locator('.session-item').first().click(); await page.getByRole('button', { name: 'UI 检查', exact: true }).click();
    await page.getByLabel('选择检查任务').selectOption(inspections[0].id);
    const panel = page.getByRole('region', { name: '规则插件', exact: true });
    await panel.getByRole('checkbox', { name: '图片拉伸', exact: false }).waitFor();
    await panel.getByText('压扁的图片', { exact: true }).waitFor();
    await panel.getByText('已测得图片非等比缩放；尚未提供是否允许变形的要求', { exact: true }).first().waitFor();
    const count = engine.session(s.id).actionCount;
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/rule-runs'));
    await panel.getByRole('button', { name: '运行选中规则', exact: true }).click();
    const replay = await (await response).json() as RulePluginRun;
    expect(replay.results).toHaveLength(builtinRulePlugins.length);
    expect(replay.results.every(r => r.status === 'completed')).toBe(true);
    expect(engine.session(s.id).actionCount).toBe(count);
    const first = saved.find(r => r.inspectionId === inspections[0].id)!.results[0];
    const rerun = replay.results.find(r => r.plugin.id === image.id)!;
    if (first.status !== 'completed' || rerun.status !== 'completed') throw new Error('Image plugin failed');
    expect(rerun.report).toEqual(first.report);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await ui.close(); await app.close(); await engine.close(); await fixture.server.close(); }
});
