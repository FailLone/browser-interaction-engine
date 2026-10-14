import { SqliteStore } from '@interaction/storage-sqlite';
import { createServer as createFixture } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { InteractionEngine } from '@interaction/browser';
import { createServer } from '../dist/apps/server/src/server.js';

const fixture = createFixture((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<title>Compiled runtime fixture</title><button id="open" aria-expanded="false" onclick="this.setAttribute(\'aria-expanded\',\'true\')">Open</button>');
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const engine = new InteractionEngine({ persistence: new SqliteStore(resolve('.data', `build-smoke-${Date.now()}`)) });
const app = await createServer(engine); await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
try {
  const health = await (await fetch(`${base}/v1/health`)).json(); assert.equal(health.status, 'ok');
  const html = await (await fetch(base)).text(); assert.ok(html.includes('id="root"') && html.includes('/assets/'));
  const created = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `http://127.0.0.1:${fixture.address().port}`, headless: true, inspection: { consumers: [{ id: 'smoke' }] }, evidenceRetention: { mode: 'cache' } }) });
  assert.equal(created.status, 201); const session = await created.json();
  const actions = await (await fetch(`${base}/v1/sessions/${session.id}/actions`)).json();
  const action = actions.find(a => a.label === 'Open'); assert.ok(action);
  const attempt = await (await fetch(`${base}/v1/sessions/${session.id}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'execute', actionId: action.id, requestId: 'compiled-once' }) })).json();
  assert.equal(attempt.status, 'succeeded'); assert.ok(attempt.diff.changes.some(c => c.field === 'expanded'));
  const details = await (await fetch(`${base}/v1/sessions/${session.id}/observations/${attempt.beforeId}/details`)).json();
  assert.ok(details.snapshot.dom.html.includes('Compiled runtime fixture'));
  assert.ok(details.snapshot.dom.nodes.some(n => n.attributes?.id === 'open'));
  assert.equal(details.snapshot.accessibility.status, 'captured');
  const event = engine.store.events(session.id).find(e => e.type === 'observation.created');
  const projected = await engine.projectEvent(event, 'inline');
  assert.ok(projected.data.evidence.details.snapshot.dom.nodes.length);
  assert.equal(projected.data.evidence.artifacts[0].encoding, 'base64');
  assert.ok((await engine.evidenceStats(session.id)).memoryBytes > 0);
  assert.equal(await engine.store.backing.evidence.get(projected.data.evidence.artifacts[0].key), undefined);
  const inspections = await (await fetch(`${base}/v1/sessions/${session.id}/inspections`)).json();
  assert.equal(inspections.items.length, 2);
  const inspection = inspections.items[0];
  const capture = await (await fetch(`${base}/v1/sessions/${session.id}/captures/${encodeURIComponent(inspection.captureId)}`)).json();
  assert.equal(capture.capture.quality.status, 'complete');
  assert.ok(capture.details.snapshot.dom.environment.scrollingElement);
  const completed = await (await fetch(`${base}/v1/sessions/${session.id}/inspections/${inspection.id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consumerId: 'smoke', results: [] }) })).json();
  assert.equal(completed.status, 'completed');
  const result = { inspectionContract: 'passed', at: new Date().toISOString(), node: process.version, compiledAPI: 'passed', staticUI: 'passed', chromiumExecution: 'passed', historicalEvidence: 'passed', snapshotDelivery: 'passed', cachedEvidence: 'passed', attemptId: attempt.id };
  writeFileSync(resolve('docs/build-smoke.json'), JSON.stringify(result, null, 2)); console.log(result);
} finally { await app.close(); await engine.close(); await new Promise(r => fixture.close(r)); }
