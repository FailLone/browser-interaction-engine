// Read-only real-page experiment. Public material uses the existing review API.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import type { Page } from 'playwright';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient, prepareIdentityReview, includeIdentityImages } from '@interaction/client';
import { createServer } from '../apps/server/src/server.js';

const directory = resolve(process.argv[2] || 'work/component-blind/2026-10-15');
const publicDirectory = join(directory, 'public');
mkdirSync(publicDirectory, { recursive: true });
const engine = new BrowserEngine({ persistence: new MemoryStore() });
const app = await createServer(engine);
await app.listen({ host: '127.0.0.1', port: 0 });
const api = new InteractionClient(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`);
const cases: unknown[] = [];
const index: unknown[] = [];
const snapshots: unknown[] = [];
try {
  const session = await engine.createSession({ url: 'https://www.okx.com/zh-hans/convert/btc-to-usd', headless: true,
    settleMs: 400, observeTimeoutMs: 5000, evidence: { enabled: true }, contextRules: [] });
  const page = (engine as unknown as { driver: { page: Page } }).driver.page;
  const close = engine.observation(session.id).controls.find(c => c.name === '关闭' && c.visible && c.role === 'button');
  if (close) await page.locator(close.selector).click();
  await engine.observe(session.id);
  for (const phase of ['current', 'reload']) {
    if (phase === 'reload') {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const close = page.getByRole('button', { name: '关闭', exact: true });
      if (await close.count() === 1 && await close.isVisible()) await close.click();
      await engine.observe(session.id);
    }
    const observation = engine.observation(session.id);
    const targets = observation.controls.filter(c => c.visible && c.role === 'button' && !c.name && c.hypothesisId);
    assert.equal(targets.length, 5, 'Expected the five currently unresolved unnamed buttons');
    snapshots.push(await engine.observationDetails(session.id, observation.id));
    for (const control of targets) {
      const review = await includeIdentityImages(api, await prepareIdentityReview(api, session.id, control.hypothesisId!));
      const caseId = randomUUID().slice(0, 8);
      const imageFiles: Record<string, string> = {};
      for (const [oid, image] of Object.entries(review.images)) if (image.dataUrl) {
        const file = `${oid}.png`;
        writeFileSync(join(publicDirectory, file), Buffer.from(image.dataUrl.split(',')[1], 'base64'));
        imageFiles[oid] = file;
        delete image.dataUrl;
      }
      cases.push({ caseId, review, imageFiles });
      index.push({ caseId, phase, localId: control.localId, instanceId: control.instanceId, rect: control.rect });
    }
  }
} finally { await app.close(); await engine.close(); }
// Shuffle so case order is not an answer key. No component names or hints added.
for (let i = cases.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1)); [cases[i], cases[j]] = [cases[j], cases[i]];
}
const serialized = JSON.stringify(cases, null, 2);
writeFileSync(join(publicDirectory, 'cases.json'), serialized);
writeFileSync(join(directory, 'private-index.json'), JSON.stringify(index, null, 2));
writeFileSync(join(directory, 'private-snapshots.json'), JSON.stringify(snapshots));
writeFileSync(join(directory, 'protocol.json'), JSON.stringify({
  frozenAt: new Date().toISOString(), casesSha256: createHash('sha256').update(serialized).digest('hex'),
  model: 'gpt-5.6-sol', reasoningEffort: 'low', context: 'none',
  input: 'Unmodified identity-review/1 exports; embedded image bytes decoded into PNG files. No extra DOM, labels, component hints or hover evidence.',
  questions: ['Identify visible purpose and relationships among targets.', 'Give per-target action/value semantics with confidence and evidence.', 'Separate logical component grouping from DOM-node identity and historical correspondence.', 'Choose same/independent/uncertain under the supplied review contract.'],
  acceptance: ['Recognizes the group as a rating input from actual supplied evidence.', 'Keeps five simultaneous nodes distinct rather than merging their identities.', 'Treats 1–5 mapping as inferred unless declared or behaviorally verified.', 'Does not claim exact historical node correspondence from position alone.', 'Cites actual evidence and missing information.'],
  limits: 'One real component, two correlated observations; no voting or submission, no ground truth for click side effects. Procedural file-access blinding, not filesystem isolation.',
}, null, 2));
console.log(JSON.stringify({ directory, publicDirectory, cases: cases.length }));
