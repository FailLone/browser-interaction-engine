// Run after pnpm build: node scripts/smoke-clipped-control.mjs
import assert from 'node:assert/strict';
import { createServer as fixtureServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { RuleRunner, clippedControlRule, ClippedControlTracker, toInspectionResults } from '@interaction/rules';
import { createServer } from '../dist/apps/server/src/server.js';

const html = readFileSync(new URL('../apps/test-site/clipped-control.html', import.meta.url), 'utf8');
const fixture = fixtureServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const engine = new BrowserEngine({ persistence: new MemoryStore() });
const app = await createServer(engine);
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${app.server.address().port}`);
  for (const mode of ['default', 'scroll', 'native-modal', 'native-modal-clipped']) {
    const s = await client.createSession({ url: `http://127.0.0.1:${fixture.address().port}/?mode=${mode}`, headless: true,
      viewport: { width: 800, height: 600 }, settleMs: 60, inspection: { consumers: [{ id: 'clipping' }] } });
    const before = await client.observation(s.id), target = before.controls.find(c => c.selector === '#target');
    const task = (await client.listInspections(s.id)).items.at(-1);
    const options = { requirements: [{ identityId: target.identityId, kind: 'unclipped-by-nonscroll-container',
      reason: 'Target must not be cut by non-scroll UI overflow', evidence: ['compiled-fixture-contract'] }] };
    const [report] = await new RuleRunner([clippedControlRule]).run(client, task, [{ ruleId: 'clipped-control', ruleVersion: '1.0.0', options }]);
    const check = report.checks.find(c => c.target?.nodeId === target.localId);
    assert.equal(check.verdict, mode === 'scroll' ? 'unknown' : mode === 'native-modal' ? 'pass' : 'fail');
    await client.completeInspection(s.id, task.id, 'clipping', toInspectionResults([report]));
    const saved = await client.inspection(s.id, task.id);
    assert.equal(saved.deliveries[0].results[0].details.ruleId, 'clipped-control');
    assert.equal((await client.session(s.id)).actionCount, 0);
    if (mode === 'scroll') {
      const tracker = new ClippedControlTracker(), first = await tracker.run(client, task);
      const viewport = before.controls.find(c => c.selector === '#clip');
      const action = (await client.actions(s.id)).find(a => a.kind === 'scroll' && a.localId === viewport.localId && a.value.y > 0);
      const attempt = await client.command(s.id, { type: 'execute', actionId: action.id, requestId: 'ordinary-scroll' });
      assert.equal(attempt.status, 'succeeded');
      const next = (await client.listInspections(s.id)).items.at(-1), after = await tracker.run(client, next);
      const recovered = after.checks.find(c => c.facts?.identityId === target.identityId);
      assert.equal(recovered.facts.lifecycle, 'resolved');
      assert.equal(recovered.facts.issueId, first.checks.find(c => c.facts?.identityId === target.identityId).facts.issueId);
      await client.completeInspection(s.id, next.id, 'clipping', toInspectionResults([after]));
      assert.equal((await client.inspection(s.id, next.id)).deliveries[0].results[0].details.ruleId, 'observed-clipping');
      assert.equal((await client.session(s.id)).actionCount, 1);
      assert.equal((await client.observation(s.id)).scroll.y, 0);
    }
    await client.command(s.id, { type: 'stop' });
  }
  console.log(JSON.stringify({ compiledClipping: 'passed', nativeTopLayer: 'passed', ordinaryScrollRecovery: 'passed', httpReportPersistence: 'passed', inspectorActions: 0 }));
} finally {
  await app.close(); await engine.close(); await new Promise(resolve => fixture.close(resolve));
}
