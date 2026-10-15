// pnpm build && node scripts/smoke-text-background.mjs
import assert from 'node:assert/strict';
import { createServer as fixtureServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { RuleRunner, textBackgroundRule } from '@interaction/rules';
import { createServer } from '../dist/apps/server/src/server.js';

const html = readFileSync(new URL('../apps/test-site/public/text-background.html', import.meta.url));
const fixture = fixtureServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const engine = new BrowserEngine({ persistence: new MemoryStore() }), app = await createServer(engine);
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${app.server.address().port}`);
  const { plugins } = await client.rulePlugins(), plugin = plugins.find(p => p.id === 'observed-text-background'); assert.ok(plugin);
  const s = await client.createSession({ url: `http://127.0.0.1:${fixture.address().port}/?mode=traversal`, headless: true,
    viewport: { width: 1100, height: 800 }, settleMs: 60, inspection: {}, maxActions: 15, pageExploration: 'all', evidenceRetention: { mode: 'persistent' } });
  const first = (await client.listInspections(s.id)).items[0], source = await client.captureDetails(s.id, first.captureId);
  const target = source.details.snapshot.dom.nodes.find(n => n.attributes?.id === 'target');
  const projected = await client.captureNodes(s.id, first.captureId, { rootId: target.id, fields: ['paint'] });
  assert.deepEqual(projected.nodes[0].paint, target.paint); assert.equal(projected.nodes[0].styles, undefined);
  const runner = new RuleRunner([textBackgroundRule]), selection = { ruleId: textBackgroundRule.id, ruleVersion: textBackgroundRule.version };
  const [ordinary] = await runner.run(client, first, [selection]), candidate = ordinary.checks.find(c => c.target?.nodeId === target.id);
  assert.equal(candidate.code, 'TEXT_BACKGROUND_MATCH'); assert.equal(candidate.severity, 'warning');
  const [strict] = await runner.run(client, first, [{ ...selection, options: { requirements: [{
    sessionId: s.id, documentId: source.capture.documentId, nodeId: target.id, label: candidate.facts.labelBinding,
    kind: 'distinct-solid-label-colors', reason: 'Fixture label colors must differ', evidence: ['fixture-spec:label-colors/v1'],
  }] } }]);
  assert.equal(strict.checks.find(c => c.target?.nodeId === target.id).code, 'TEXT_BACKGROUND_REQUIREMENT_FAILED');
  assert.equal((await client.session(s.id)).actionCount, 0);
  await client.setRuleAutomation(s.id, { enabled: true, plugins: [{ id: plugin.id, version: plugin.version }] });
  await engine.explore(s.id); await engine.waitForIdle();
  const tasks = (await client.listInspections(s.id, { limit: 500 })).items, deadline = Date.now() + 15000;
  while ((await client.ruleAutomation(s.id)).automation.completedCount !== tasks.length) {
    if (Date.now() > deadline) throw new Error('Automatic rules did not catch up');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const runs = (await Promise.all(tasks.map(t => client.ruleRuns(s.id, t.id)))).flatMap(r => r.items);
  const checks = runs.flatMap(r => r.results.flatMap(p => { assert.equal(p.status, 'completed'); return p.report.checks; }));
  for (const code of ['TEXT_BACKGROUND_MATCH', 'TEXT_BACKGROUND_RESTORED', 'TEXT_BACKGROUND_TARGET_UNOBSERVED']) assert.ok(checks.some(c => c.code === code), code);
  assert.ok(runs.some(r => r.results.some(p => p.report.checks.some(c => c.code === 'TEXT_BACKGROUND_MATCH' && p.targetLabels[c.target.nodeId] === '关闭同色弹层'))));
  const count = (await client.session(s.id)).actionCount;
  const replay = await client.runRules(s.id, first.id, { requestId: 'compiled-text-replay', plugins: [{ id: plugin.id, version: plugin.version }] });
  assert.equal((await client.session(s.id)).actionCount, count);
  assert.deepEqual(replay.results[0].report, runs.find(r => r.inspectionId === first.id).results[0].report);
  console.log(JSON.stringify({ compiledTextBackground: 'passed', httpPaintProjection: 'passed', explicitError: 'passed',
    passiveReplay: 'passed', ordinaryDfsActions: count, automaticCaptures: runs.length, modalDetection: 'passed', sameLabelRecovery: 'passed' }));
} finally { await app.close(); await engine.close(); await new Promise(resolve => fixture.close(resolve)); }
