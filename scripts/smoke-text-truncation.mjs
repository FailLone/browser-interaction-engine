// Run after pnpm build: node scripts/smoke-text-truncation.mjs
import assert from 'node:assert/strict';
import { createServer as fixtureServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { RuleRunner, textTruncationRule, TextTruncationTracker, toInspectionResults } from '@interaction/rules';
import { createServer } from '../dist/apps/server/src/server.js';

const html = readFileSync(new URL('../apps/test-site/text-truncation.html', import.meta.url), 'utf8');
const fixture = fixtureServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const engine = new BrowserEngine({ persistence: new MemoryStore() });
const app = await createServer(engine);
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${app.server.address().port}`);
  for (const mode of ['hard-x', 'ellipsis', 'ellipsis-fit', 'clamp', 'scroll', 'native-modal']) {
    const s = await client.createSession({ url: `http://127.0.0.1:${fixture.address().port}/?mode=${mode}`, headless: true,
      viewport: { width: 800, height: 600 }, settleMs: 60, inspection: { consumers: [{ id: 'text' }] } });
    const before = await client.observation(s.id), target = before.controls.find(c => c.selector === '#target');
    const task = (await client.listInspections(s.id)).items.at(-1);
    const [report] = await new RuleRunner([textTruncationRule]).run(client, task, [{ ruleId: 'text-truncation', ruleVersion: '1.0.0' }]);
    const check = report.checks.find(c => c.target?.nodeId === target.localId);
    assert.equal(check.code, { 'hard-x': 'TEXT_HARD_CLIP_SUSPECTED', ellipsis: 'TEXT_ELISION_OBSERVED',
      'ellipsis-fit': 'DOM_TEXT_BOXES_FIT', clamp: 'TEXT_ELISION_OBSERVED', scroll: 'TEXT_SCROLL_RECHECK_PENDING', 'native-modal': 'DOM_TEXT_BOXES_FIT' }[mode]);
    assert.equal(check.severity, mode === 'hard-x' ? 'warning' : 'info');
    const dom = await client.dom(s.id, before.id, { rootId: target.localId, fields: ['text', 'textLayout'] });
    assert.ok(dom.nodes.some(n => n.textLayout?.status === 'captured' && n.textLayout.rects.length));
    assert.ok(dom.nodes.every(n => n.styles === undefined));
    await client.completeInspection(s.id, task.id, 'text', toInspectionResults([report]));
    assert.equal((await client.inspection(s.id, task.id)).deliveries[0].results[0].details.ruleId, 'text-truncation');
    assert.equal((await client.session(s.id)).actionCount, 0);
    if (mode === 'scroll') {
      const tracker = new TextTruncationTracker(), first = await tracker.run(client, task);
      const viewport = before.controls.find(c => c.selector === '#outer');
      const action = (await client.actions(s.id)).find(a => a.kind === 'scroll' && a.localId === viewport.localId && a.value.y > 0);
      const attempt = await client.command(s.id, { type: 'execute', actionId: action.id, requestId: 'ordinary-scroll' });
      assert.equal(attempt.status, 'succeeded');
      const next = (await client.listInspections(s.id)).items.at(-1), after = await tracker.run(client, next);
      const recovered = after.checks.find(c => c.facts?.identityId === target.identityId);
      assert.equal(recovered.facts.lifecycle, 'resolved');
      assert.equal(recovered.facts.issueId, first.checks.find(c => c.facts?.identityId === target.identityId).facts.issueId);
      assert.equal(recovered.facts.ancestorScrollChanges.length, 1);
      await client.completeInspection(s.id, next.id, 'text', toInspectionResults([after]));
      assert.equal((await client.inspection(s.id, next.id)).deliveries[0].results[0].details.ruleId, 'observed-text-truncation');
      assert.equal((await client.session(s.id)).actionCount, 1);
      assert.equal((await client.observation(s.id)).scroll.y, 0);
    }
    await client.command(s.id, { type: 'stop' });
  }
  console.log(JSON.stringify({ compiledTextTruncation: 'passed', textFieldProjection: 'passed',
    ordinaryScrollRecovery: 'passed', httpReportPersistence: 'passed', inspectorActions: 0 }));
} finally {
  await app.close(); await engine.close(); await new Promise(resolve => fixture.close(resolve));
}
