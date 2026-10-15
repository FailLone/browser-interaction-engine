// Run from the repository root after pnpm build, without development conditions:
// node docs/experiments/upstream-interventions-2026-10-16/built-contract.mjs
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { createServer } from '../../../dist/apps/server/src/server.js';

const fixture = httpServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<section aria-label="Area"><input aria-label="Amount"><input aria-label="Search"></section>');
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const engine = new BrowserEngine({ persistence: new MemoryStore() });
const app = await createServer(engine); await app.listen({ host: '127.0.0.1', port: 0 });
const client = new InteractionClient(`http://127.0.0.1:${app.server.address().port}`);
try {
  const session = await client.createSession({ url: `http://127.0.0.1:${fixture.address().port}`, headless: true,
    regionExploration: 'review', contextRules: [], settleMs: 20, observeTimeoutMs: 600, storageState: { cookies: [], origins: [] } });
  const sid = session.id, reason = { source: 'compiled-contract', evidence: ['Inspect the Amount sample and leave Search unexecuted'] };
  let material = await client.interventionMaterial(sid);
  assert.equal(material.version, 'interventions/v1');
  const region = await client.regionReviewMaterial(sid), item = material.items.find(i => i.kind === 'region');
  const partition = await client.respondToIntervention(sid, { requestId: 'partition-once', interventionId: item.id, conditionKey: item.conditionKey,
    command: { type: 'reviewRegions', review: { ...reason, observationId: material.observationId,
      regions: [{ key: 'area', label: 'Area', candidateIds: [region.candidates.find(c => c.label === 'Area').id], pageTraversal: false }] } } });
  assert.equal(partition.response.status, 'applied');
  const group = (await client.explorationReviewMaterial(sid)).groups.find(g => g.kind === 'reviewed-region');
  material = await client.interventionMaterial(sid);
  const depth = material.items.find(i => i.subject.groupId === group.id);
  const answer = await client.respondToIntervention(sid, { requestId: 'sample-once', interventionId: depth.id, conditionKey: depth.conditionKey,
    command: { type: 'decideExplorationGroup', groupId: group.id, revision: group.revision,
      decision: { ...reason, mode: 'sample', memberKeys: [group.members.find(m => m.label === 'Amount').key] } } });
  assert.equal(answer.response.status, 'applied');
  material = await client.interventionMaterial(sid);
  const request = { ...reason, requestId: 'continue-once', observationId: material.observationId };
  const continued = await client.continueExploration(sid, request);
  assert.equal(continued.continuation.status, 'started');
  assert.equal(continued.session.options.storageState, '[configured]');
  await engine.waitForIdle();
  const duplicate = await client.continueExploration(sid, request);
  assert.equal(duplicate.continuation.id, continued.continuation.id);
  assert.deepEqual(engine.list(sid, 'attempt').map(a => a.action.label), ['Amount']);
  assert.equal((await client.list(sid, 'intervention-responses')).total, 2);
  assert.equal((await client.list(sid, 'continuations')).total, 1);
  assert.ok(engine.store.events(sid).some(e => e.type === 'interventions.updated'));
  console.log(JSON.stringify({ compiledSDK: 'passed', compiledHTTP: 'passed', currentAnswer: 'passed',
    verifiedContinuation: 'passed', duplicateNoReplay: 'passed', sessionStorageRedaction: 'passed',
    executed: ['Amount'], responses: 2, continuations: 1 }, null, 2));
} finally { await app.close(); await engine.close(); await new Promise(r => fixture.close(r)); }
