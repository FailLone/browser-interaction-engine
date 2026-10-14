import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { InteractionClient, prepareIdentityReview, includeIdentityImages } from '@interaction/client';
import type { IdentityHypothesis } from '@interaction/browser';
import { fixtureServer, testEngine, pageOf } from '../tests/helpers.js';
import { createServer } from '../apps/server/src/server.js';

// Oracle generation is separate from the public directory. Run this before asking a blind judge.
const directory = resolve('work/identity-blind', new Date().toISOString().replaceAll(':', '-'));
const publicDirectory = join(directory, 'public'); mkdirSync(publicDirectory, { recursive: true });
const protocol = { cases: 12, model: 'gpt-5.6-sol', reasoningEffort: 'low', context: 'none',
  acceptance: '12/12 exact decisions including exact candidate for same; no unsupported historical merges; every decision cites real evidence refs; uncertain states missing evidence.',
  limitations: 'Controlled local fixture, six sessions with two correlated cases each; procedural file-access blinding, not filesystem isolation; results do not estimate real-world accuracy.' };
writeFileSync(join(directory, 'protocol.json'), JSON.stringify(protocol, null, 2));
const fixture = await fixtureServer();
const cases: any[] = []; const oracle: any[] = [];
try {
  for (const scenario of ['initial', 'virtual', 'reorder-a', 'reorder-b', 'opaque', 'expired']) {
    const t = await testEngine(`${fixture.url}/identity-review.html`, { contextRules: [], evidenceRetention: { mode: 'cache', ttlMs: 600000, maxBytes: 64 * 1024 ** 2, maxObservations: 100 } });
    const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
    const api = new InteractionClient(`http://127.0.0.1:${(app.server.address() as any).port}`);
    try {
      const record = `R-${randomUUID().slice(0, 6)}`;
      const operations = [randomUUID().slice(0, 6), randomUUID().slice(0, 6)];
      await pageOf(t.engine).evaluate(({ record, operations, declared }) => (window as any).renderReview(record, operations, false, declared), { record, operations, declared: scenario !== 'opaque' });
      const before = await t.engine.observe(t.sessionId);
      let current = before;
      if (scenario !== 'initial') {
        await pageOf(t.engine).evaluate(({ record, operations, virtual, declared }) => (window as any).renderReview(record, operations, virtual, declared), { record: scenario === 'virtual' ? `R-${randomUUID().slice(0, 6)}` : record, operations: [...operations].reverse(), virtual: scenario === 'virtual', declared: scenario !== 'opaque' });
        current = await t.engine.observe(t.sessionId);
      }
      if (scenario === 'expired') await t.engine.releaseEvidence(t.sessionId, before.id);
      const hypotheses = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis').filter(h => h.observationId === current.id);
      if (hypotheses.length !== 2) throw new Error(`${scenario}: expected two genuine pending hypotheses, found ${hypotheses.length}`);
      for (const h of hypotheses) {
        const review = await includeIdentityImages(api, await prepareIdentityReview(api, t.sessionId, h.id));
        const caseId = randomUUID().slice(0, 8);
        const imageFiles: Record<string, string> = {};
        for (const [oid, image] of Object.entries(review.images)) if (image.dataUrl) {
          const file = `${caseId}-${oid}.png`; writeFileSync(join(publicDirectory, file), Buffer.from(image.dataUrl.split(',')[1], 'base64')); imageFiles[oid] = file; delete image.dataUrl;
        }
        const decision = scenario === 'initial' || scenario === 'virtual' ? 'independent' : scenario.startsWith('reorder') ? 'same' : 'uncertain';
        const operation = review.target.node?.attributes?.['data-operation-key'];
        const candidate = review.candidates.find(c => !c.simultaneous && c.exhibit.node?.attributes?.['data-operation-key'] === operation);
        if (decision === 'same' && !candidate) throw new Error('Oracle target absent from candidates');
        cases.push({ caseId, review, imageFiles });
        oracle.push({ caseId, scenario, decision, ...(decision === 'same' ? { candidateId: candidate!.identityId } : {}),
          rationale: decision === 'same' ? 'Same declared record and immutable operation; position reversed.' : decision === 'independent' ? 'Every listed candidate coexists with target; virtual old record excluded by its different record key.' : scenario === 'opaque' ? 'Historical twins have no observable operation distinction; position cannot recover mapping.' : 'Historical detailed operation evidence expired; matching names and screenshots cannot recover mapping.' });
      }
    } finally { await app.close(); await t.close(); }
  }
} finally { await fixture.server.close(); }
for (let i = cases.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cases[i], cases[j]] = [cases[j], cases[i]]; }
writeFileSync(join(publicDirectory, 'cases.json'), JSON.stringify(cases, null, 2));
writeFileSync(join(directory, 'oracle.json'), JSON.stringify(oracle, null, 2));
const hash = createHash('sha256').update(JSON.stringify(oracle)).digest('hex');
writeFileSync(join(directory, 'frozen.json'), JSON.stringify({ frozenAt: new Date().toISOString(), oracleSha256: hash, casesSha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex') }, null, 2));
writeFileSync(resolve('work/identity-blind/latest.json'), JSON.stringify({ directory, publicDirectory, count: cases.length, oracleSha256: hash }, null, 2));
console.log(JSON.stringify({ directory, publicDirectory, count: cases.length, oracleSha256: hash }));
