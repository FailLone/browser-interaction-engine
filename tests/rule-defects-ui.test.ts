import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { builtinRulePlugins, type RulePluginRun } from '@interaction/rules';
import { createServer } from '../apps/server/src/server.js';
import { ruleDefectPlugins } from '../examples/rule-defect-plugins.js';
import { fixtureServer, act, pageOf } from './helpers.js';

it('detects real fixture defects with sourced errors, preserves default warnings, and clears errors after repairing the same controls', async () => {
  const fixture = await fixtureServer(); const engine = new BrowserEngine({ persistence: new MemoryStore() });
  const s = await engine.createSession({ url: `${fixture.url}/rule-defects.html`, headless: true, viewport: { width: 1280, height: 1000 }, settleMs: 60, inspection: {}, evidenceRetention: { mode: 'cache' }, pageExploration: 'all' });
  const baseline = engine.observation(s.id);
  const identities = Object.fromEntries(baseline.controls.map(c => [c.selector, c.identityId]));
  const defaults = await createServer(engine);
  const app = await createServer(engine, { rulePlugins: ruleDefectPlugins(baseline) }); await app.listen({ host: '127.0.0.1', port: 0 });
  const ui = await createViteServer({ root: resolve('apps/ui'), logLevel: 'error', server: { port: 0, strictPort: false, proxy: { '/v1': `http://127.0.0.1:${(app.server.address() as any).port}` } } }); await ui.listen();
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const selection = builtinRulePlugins.map(({ id, version }) => ({ id, version }));
  const latest = () => engine.listInspections(s.id).items.at(-1)!;
  const checks = (run: RulePluginRun, id: string) => run.results.flatMap(r => r.status === 'completed' && r.plugin.id === id ? r.report.checks : []);
  const target = (run: RulePluginRun, rule: string, name: string) => {
    const result = run.results.find(r => r.plugin.id === rule)!;
    if (result.status !== 'completed') throw new Error(result.error);
    return result.report.checks.find(c => c.target && result.targetLabels[c.target.nodeId] === name)!;
  };
  try {
    await page.goto(`http://127.0.0.1:${(ui.httpServer!.address() as any).port}`);
    await page.locator('.session-item').first().click(); await page.getByRole('button', { name: 'UI 检查', exact: true }).click();
    const panel = page.getByRole('region', { name: '规则插件', exact: true });
    const runInUI = async () => {
      await page.getByLabel('选择检查任务').selectOption(latest().id);
      const before = { count: engine.session(s.id).actionCount, top: await pageOf(engine).locator('#occlusion-scroller').evaluate(el => el.scrollTop) };
      const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/rule-runs'));
      await panel.getByRole('button', { name: '运行选中规则', exact: true }).click();
      const result = await (await response).json() as RulePluginRun;
      expect(result.results.every(r => r.status === 'completed')).toBe(true);
      expect(engine.session(s.id).actionCount).toBe(before.count);
      expect(await pageOf(engine).locator('#occlusion-scroller').evaluate(el => el.scrollTop)).toBe(before.top);
      return result;
    };
    const first = await runInUI();
    expect(target(first, 'observed-clipping', '保存测试设置')).toMatchObject({ code: 'CLIPPING_REQUIREMENT_FAILED', severity: 'error', verdict: 'fail' });
    expect(target(first, 'observed-occlusion', '确认测试订单')).toMatchObject({ code: 'OCCLUSION_SUSPECTED', severity: 'warning' });
    expect(target(first, 'observed-text-truncation', '确认并保存本次测试配置')).toMatchObject({ code: 'TEXT_HARD_CLIP_SUSPECTED', severity: 'warning' });
    for (const p of builtinRulePlugins) expect(target(first, p.id, '正常测试按钮').verdict).toBe('pass');
    expect(target(first, 'observed-text-truncation', '这是一段允许省略的测试说明')).toMatchObject({ code: 'TEXT_ELISION_OBSERVED', severity: 'info', verdict: 'unknown' });
    await panel.getByText('控件被非滚动容器裁切，违反已声明的完整显示要求', { exact: true }).waitFor();

    const scroller = baseline.scrollContainers!.find(c => c.selector === '#occlusion-scroller')!;
    const scroll = engine.actions(s.id).find(a => a.kind === 'scroll' && ((a.localId === scroller.nodeId && (a.value as any).y > 0) || (a.source === 'scroll-traversal' && (a.value as any).containerNodeId === scroller.nodeId && (a.value as any).top > scroller.top)))!;
    expect(scroll).toBeDefined(); expect((await engine.execute(s.id, scroll.id, crypto.randomUUID())).status).toBe('succeeded');
    await page.getByLabel('选择检查任务').locator(`option[value="${latest().id}"]`).waitFor({ state: 'attached' });
    const second = await runInUI();
    const obstruction = target(second, 'observed-occlusion', '确认测试订单');
    expect(obstruction).toMatchObject({ code: 'OBSERVED_POINTER_REQUIREMENT_FAILED', severity: 'error', verdict: 'fail' });
    expect(obstruction.evidence).toContain('fixture-contract:rule-defects/v1#blocked-button');
    expect(obstruction.facts!.issueId).toBe(target(first, 'observed-occlusion', '确认测试订单').facts!.issueId);
    await panel.getByText('相关滚动后，全部点击采样点仍被遮挡，违反已声明的可点击要求', { exact: true }).waitFor();
    expect(await panel.locator('.rule-check.rule-severity-error').count()).toBe(2);
    const ordinaryResponse = await defaults.inject({ method: 'POST', url: `/v1/sessions/${s.id}/inspections/${latest().id}/rule-runs`, payload: { requestId: 'ordinary', plugins: selection } });
    expect(ordinaryResponse.statusCode).toBe(200); const ordinary = ordinaryResponse.json<RulePluginRun>();
    for (const p of builtinRulePlugins) expect(checks(ordinary, p.id).some(c => c.severity === 'error')).toBe(false);
    expect(target(ordinary, 'observed-clipping', '保存测试设置').severity).toBe('warning');
    expect(target(ordinary, 'observed-occlusion', '确认测试订单').severity).toBe('warning');

    await act(engine, s.id, '修复全部缺陷');
    await page.getByLabel('选择检查任务').locator(`option[value="${latest().id}"]`).waitFor({ state: 'attached' });
    const fixed = await runInUI();
    for (const [rule, name] of [['observed-occlusion', '确认测试订单'], ['observed-clipping', '保存测试设置'], ['observed-text-truncation', '确认并保存本次测试配置']]) {
      const resolved = target(fixed, rule, name);
      expect(resolved).toMatchObject({ verdict: 'pass', facts: { lifecycle: 'resolved' } });
      expect(resolved.facts!.issueId).toBe(target(second, rule, name).facts!.issueId);
    }
    for (const p of builtinRulePlugins) expect(checks(fixed, p.id).some(c => c.severity === 'error' || c.severity === 'warning')).toBe(false);
    for (const [selector, id] of Object.entries(identities)) expect(engine.observation(s.id).controls.find(c => c.selector === selector)?.identityId).toBe(id);
    expect(engine.session(s.id).actionCount).toBe(2); expect(errors).toEqual([]);
    // A historical error remains reviewable after the live page has been repaired.
    await page.getByLabel('选择检查任务').selectOption(second.inspectionId);
    await panel.getByLabel('选择检测记录').selectOption(second.id);
    await panel.getByText('相关滚动后，全部点击采样点仍被遮挡，违反已声明的可点击要求', { exact: true }).waitFor();
  } finally { await browser.close(); await ui.close(); await app.close(); await defaults.close(); await engine.close(); await fixture.server.close(); }
});
