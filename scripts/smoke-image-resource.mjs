// pnpm build && node scripts/smoke-image-resource.mjs
import assert from 'node:assert/strict';
import { createServer as fixtureServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { RuleRunner, imageResourceRule } from '@interaction/rules';
import { createServer } from '../dist/apps/server/src/server.js';

const html = readFileSync(new URL('../apps/test-site/public/image-resource.html', import.meta.url));
const png = readFileSync(new URL('../apps/test-site/public/aspect-ratio-2x1.png', import.meta.url));
const fixture = fixtureServer((req, res) => {
  if (req.url.startsWith('/aspect-ratio-2x1.png')) { res.setHeader('Content-Type', 'image/png'); res.end(png); }
  else if (req.url.startsWith('/?')) { res.setHeader('Content-Type', 'text/html'); res.end(html); }
  else { res.statusCode = 404; res.end('Fixture image missing'); }
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const engine = new BrowserEngine({ persistence: new MemoryStore() }), app = await createServer(engine);
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${app.server.address().port}`);
  const { plugins } = await client.rulePlugins(), plugin = plugins.find(p => p.id === 'image-resource'); assert.ok(plugin);
  const s = await client.createSession({ url: `http://127.0.0.1:${fixture.address().port}/?mode=traversal`, headless: true,
    viewport: { width: 1100, height: 800 }, settleMs: 60, inspection: {}, maxActions: 15, pageExploration: 'all', evidenceRetention: { mode: 'persistent' } });
  const first = (await client.listInspections(s.id)).items[0], source = await client.captureDetails(s.id, first.captureId);
  const target = source.details.snapshot.dom.nodes.find(n => n.attributes?.id === 'broken');
  const projected = await client.captureNodes(s.id, first.captureId, { rootId: target.id, fields: ['image'] });
  assert.deepEqual(projected.nodes[0].image.resource, target.image.resource); assert.equal(projected.nodes[0].styles, undefined);
  const runner = new RuleRunner([imageResourceRule]), selection = { ruleId: imageResourceRule.id, ruleVersion: imageResourceRule.version };
  const [ordinary] = await runner.run(client, first, [selection]), candidate = ordinary.checks.find(c => c.target?.nodeId === target.id);
  assert.equal(candidate.code, 'IMAGE_RESOURCE_LOAD_FAILED'); assert.equal(candidate.severity, 'warning');
  const [strict] = await runner.run(client, first, [{ ...selection, options: { requirements: [{
    sessionId: s.id, documentId: source.capture.documentId, nodeId: target.id, resource: candidate.facts.resource,
    kind: 'no-image-load-error', reason: 'Fixture image must load', evidence: ['fixture-spec:image-resource/v1'],
  }] } }]);
  assert.equal(strict.checks.find(c => c.target?.nodeId === target.id).code, 'IMAGE_RESOURCE_REQUIREMENT_FAILED');
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
  for (const code of ['IMAGE_RESOURCE_LOAD_FAILED', 'IMAGE_RESOURCE_AVAILABLE', 'IMAGE_RESOURCE_NOT_RECHECKED']) assert.ok(checks.some(c => c.code === code), code);
  assert.ok(runs.some(r => r.results.some(p => p.report.checks.some(c => c.code === 'IMAGE_RESOURCE_LOAD_FAILED' && p.targetLabels[c.target.nodeId] === '弹层缺图'))));
  const count = (await client.session(s.id)).actionCount;
  const replay = await client.runRules(s.id, first.id, { requestId: 'compiled-image-resource-replay', plugins: [{ id: plugin.id, version: plugin.version }] });
  assert.equal((await client.session(s.id)).actionCount, count);
  assert.deepEqual(replay.results[0].report, runs.find(r => r.inspectionId === first.id).results[0].report);
  console.log(JSON.stringify({ compiledImageResource: 'passed', httpResourceProjection: 'passed', explicitError: 'passed',
    passiveReplay: 'passed', ordinaryDfsActions: count, automaticCaptures: runs.length, modalDetection: 'passed', fallbackTrackedSeparately: 'passed' }));
} finally { await app.close(); await engine.close(); await new Promise(resolve => fixture.close(resolve)); }
