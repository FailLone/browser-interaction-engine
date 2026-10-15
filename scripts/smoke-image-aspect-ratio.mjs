// Run after pnpm build. Uses only compiled packages and real HTTP clients.
import assert from 'node:assert/strict';
import { createServer as fixtureServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { RuleRunner, imageAspectRatioRule } from '@interaction/rules';
import { createServer } from '../dist/apps/server/src/server.js';

const files = new Map(['image-aspect-ratio.html', 'aspect-ratio-2x1.png', 'aspect-ratio-1x1.png'].map(name =>
  [`/${name}`, { bytes: readFileSync(new URL(`../apps/test-site/public/${name}`, import.meta.url)), mime: name.endsWith('.png') ? 'image/png' : 'text/html' }]));
const fixture = fixtureServer((req, res) => {
  const file = files.get(new URL(req.url, 'http://localhost').pathname);
  if (!file) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.mime); res.end(file.bytes);
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const engine = new BrowserEngine({ persistence: new MemoryStore() }), app = await createServer(engine);
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${app.server.address().port}`);
  const { plugins } = await client.rulePlugins(); assert.equal(plugins.length, 4);
  const plugin = plugins.find(p => p.id === 'image-aspect-ratio'); assert.ok(plugin);
  const s = await client.createSession({ url: `http://127.0.0.1:${fixture.address().port}/image-aspect-ratio.html`, headless: true,
    viewport: { width: 1100, height: 800 }, settleMs: 60, inspection: {}, maxActions: 15, pageExploration: 'all', evidenceRetention: { mode: 'persistent' } });
  const first = (await client.listInspections(s.id)).items[0];
  const source = await client.captureDetails(s.id, first.captureId);
  const node = source.details.snapshot.dom.nodes.find(n => n.attributes?.id === 'distorted'), image = node.image;
  const projected = await client.captureNodes(s.id, first.captureId, { rootId: node.id, fields: ['image'] });
  assert.deepEqual(projected.nodes[0].image, image); assert.equal(projected.nodes[0].styles, undefined);
  const [strict] = await new RuleRunner([imageAspectRatioRule]).run(client, first, [{ ruleId: plugin.id, ruleVersion: plugin.version, options: {
    requirements: [{ sessionId: s.id, documentId: source.capture.documentId, nodeId: node.id,
      resource: { currentSrc: image.currentSrc, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, loadEpoch: image.loadEpoch },
      kind: 'preserve-aspect-ratio', reason: 'Fixture circle must remain circular', evidence: ['fixture-contract:image/v1'] }],
  } }]);
  assert.equal(strict.checks.find(c => c.target?.nodeId === node.id).code, 'IMAGE_ASPECT_RATIO_REQUIREMENT_FAILED');
  assert.equal((await client.session(s.id)).actionCount, 0);
  await client.setRuleAutomation(s.id, { enabled: true, plugins: [{ id: plugin.id, version: plugin.version }] });
  await engine.explore(s.id); await engine.waitForIdle();
  const tasks = (await client.listInspections(s.id, { limit: 500 })).items;
  const deadline = Date.now() + 15000;
  while ((await client.ruleAutomation(s.id)).automation.completedCount !== tasks.length) {
    if (Date.now() > deadline) throw new Error('Automatic rules did not catch up');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const saved = (await Promise.all(tasks.map(t => client.ruleRuns(s.id, t.id)))).flatMap(r => r.items);
  const checks = saved.flatMap(r => r.results.flatMap(p => {
    assert.equal(p.status, 'completed'); return p.report.checks;
  }));
  assert.equal(saved.length, tasks.length);
  for (const code of ['IMAGE_NON_UNIFORM_SCALING', 'IMAGE_ASPECT_RATIO_RESTORED', 'IMAGE_FINDING_NOT_RECHECKED']) assert.ok(checks.some(c => c.code === code), code);
  assert.ok(checks.some(c => c.code === 'IMAGE_NON_UNIFORM_SCALING' && c.facts.label === '弹层内压扁图片'));
  const count = (await client.session(s.id)).actionCount;
  const replay = await client.runRules(s.id, first.id, { requestId: 'compiled-replay', plugins: [{ id: plugin.id, version: plugin.version }] });
  assert.equal((await client.session(s.id)).actionCount, count);
  assert.deepEqual(replay.results[0].report, saved.find(r => r.inspectionId === first.id).results[0].report);
  console.log(JSON.stringify({ compiledImageRule: 'passed', httpImageProjection: 'passed', explicitError: 'passed',
    passiveReplay: 'passed', ordinaryDfsActions: count, automaticCaptures: saved.length, modalDetection: 'passed', resourceRecovery: 'passed' }));
} finally { await app.close(); await engine.close(); await new Promise(resolve => fixture.close(resolve)); }
