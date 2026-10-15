import { InteractionClient } from '@interaction/client';
import { TextTruncationTracker, textTruncationDefaultPolicy, toInspectionResults } from '@interaction/rules';

// pnpm exec tsx --conditions=development examples/text-truncation-inspector.ts URL
const [url] = process.argv.slice(2);
if (!url) throw new Error('Supply a page URL');
const client = new InteractionClient(process.env.INTERACTION_URL || 'http://127.0.0.1:4173');
const consumerId = 'text-truncation';
const session = await client.createSession({ url, headless: true, exploration: 'controls', maxActions: 100,
  inspection: { consumers: [{ id: consumerId, leaseMs: 300000, maxLeaseMs: 300000 }] },
  evidenceRetention: { mode: 'cache', ttlMs: 300000 },
});
const tracker = new TextTruncationTracker();
console.log(JSON.stringify({ sessionId: session.id, policy: textTruncationDefaultPolicy }));
// Only the explorer acts on the page. This consumer reads saved evidence as it
// arrives; the requirement-provider interfaces are not executed in this version.
await client.command(session.id, { type: 'explore' });
for await (const event of client.events(session.id)) {
  if (event.type === 'inspection.ready') {
    const { inspectionId } = event.data as { inspectionId: string };
    const { inspection, deliveries } = await client.inspection(session.id, inspectionId);
    const report = await tracker.run(client, inspection);
    if (deliveries.some(d => d.consumerId === consumerId && d.status === 'pending')) {
      await client.completeInspection(session.id, inspection.id, consumerId, toInspectionResults([report]));
    }
    console.log(JSON.stringify(report));
  }
  if (['exploration.finished', 'exploration.paused', 'session.stopped'].includes(event.type)) break;
}
