import { InteractionClient } from '@interaction/client';
import { inspectPopup } from './popup-inspector.js';

// Run: pnpm exec tsx --conditions=development examples/external-inspector.ts URL
const url = process.argv[2];
if (!url) throw new Error('Supply the page URL to inspect');
const client = new InteractionClient(process.env.INTERACTION_URL || 'http://127.0.0.1:4173');
const session = await client.createSession({ url, headless: true, inspection: { consumers: [{ id: 'popup-checker' }] }, evidenceRetention: { mode: 'cache', ttlMs: 300000 } });
console.log(`Inspection session ${session.id}; use the UI or SDK to operate the page.`);
// Replayed events are expected. Completion is idempotent for the same rule results.
for await (const event of client.events(session.id)) {
  if (event.type !== 'inspection.ready') continue;
  const { inspectionId } = event.data as { inspectionId: string };
  const { inspection, deliveries } = await client.inspection(session.id, inspectionId);
  if (deliveries.find(d => d.consumerId === 'popup-checker')?.status !== 'pending') continue;
  await client.receiveInspection(session.id, inspectionId, 'popup-checker');
  // A long-running checker should renew its lease while working, up to maxLeaseMs.
  const result = await inspectPopup(client, inspection);
  await client.completeInspection(session.id, inspectionId, 'popup-checker', [result]);
  console.log(inspection.reasons.join(', '), result.status, result.message);
}
