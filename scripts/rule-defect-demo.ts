import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { BrowserEngine } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { type RulePluginRun } from '@interaction/rules';
import { createServer } from '../apps/server/src/server.js';
import { ruleDefectPlugins } from '../examples/rule-defect-plugins.js';

// Separate demo host: explicit fixture contracts never change the normal server.
const port = Number(process.env.RULE_DEMO_PORT || 4185);
const fixture = process.env.RULE_FIXTURE_URL ? undefined : await createViteServer({ root: resolve('apps/test-site'), server: { host: '127.0.0.1', port: 4186, strictPort: true } });
await fixture?.listen();
const url = process.env.RULE_FIXTURE_URL || 'http://127.0.0.1:4186/rule-defects.html';
const engine = new BrowserEngine({ persistence: new SqliteStore(resolve(process.env.RULE_DEMO_DATA_DIR || 'work/rule-defect-demo/data')) });
let app: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  const session = await engine.createSession({ url, headless: true, viewport: { width: 1280, height: 1000 }, settleMs: 100,
    inspection: {}, evidenceRetention: { mode: 'persistent' }, pageExploration: 'all', maxActions: 20 });
  const baseline = engine.observation(session.id);
  const plugins = ruleDefectPlugins(baseline);
  app = await createServer(engine, { rulePlugins: plugins });
  const inspect = async () => {
    const task = engine.listInspections(session.id).items.at(-1)!;
    const response = await app!.inject({ method: 'POST', url: `/v1/sessions/${session.id}/inspections/${task.id}/rule-runs`,
      payload: { requestId: crypto.randomUUID(), plugins: plugins.map(({ id, version }) => ({ id, version })) } });
    if (response.statusCode !== 200) throw new Error(response.body);
    return response.json<RulePluginRun>();
  };
  await inspect();
  const scroller = baseline.scrollContainers!.find(c => c.selector === '#occlusion-scroller')!;
  const scroll = engine.actions(session.id).find(a => {
    if (a.kind !== 'scroll' || !a.value || typeof a.value !== 'object' || Array.isArray(a.value)) return false;
    const value = a.value as Record<string, unknown>;
    return (a.localId === scroller.nodeId && typeof value.y === 'number' && value.y > 0) ||
      (a.source === 'scroll-traversal' && value.containerNodeId === scroller.nodeId && typeof value.top === 'number' && value.top > scroller.top);
  });
  if (!scroll) throw new Error('Fixture scroll action unavailable');
  const attempt = await engine.execute(session.id, scroll.id, crypto.randomUUID());
  if (attempt.status !== 'succeeded') throw new Error('Fixture scroll did not succeed');
  const confirmed = await inspect();
  const errors = confirmed.results.flatMap(r => r.status === 'completed' ? r.report.checks.filter(c => c.severity === 'error') : []);
  if (errors.length !== 2) throw new Error(`Expected two sourced fixture errors, received ${errors.length}`);
  await app.listen({ host: '127.0.0.1', port });
  console.log(JSON.stringify({ debugPage: `http://127.0.0.1:${port}`, testPage: url, sessionId: session.id,
    inspectionId: confirmed.inspectionId, errors: errors.map(c => c.code), note: '选择此会话 → UI 检查。修复全部缺陷可从操作候选执行。' }, null, 2));
} catch (e) {
  await app?.close(); await engine.close(); await fixture?.close(); throw e;
}
let closing = false;
const close = async () => { if (closing) return; closing = true; await app?.close(); await engine.close(); await fixture?.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
