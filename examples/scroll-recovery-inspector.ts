import { InteractionClient } from '@interaction/client';
import { inspectScrollRecovery, toInspectionResults } from '@interaction/rules';

// pnpm exec tsx --conditions=development examples/scroll-recovery-inspector.ts URL 'Target' 'This control must be operable now'
const [url, targetName, reason] = process.argv.slice(2);
if (!url || !targetName || !reason) throw new Error('Supply URL, exact target name, and the current operability requirement');
const client = new InteractionClient(process.env.INTERACTION_URL || 'http://127.0.0.1:4173');
const session = await client.createSession({ url, headless: true,
  inspection: { consumers: [{ id: 'scroll-rules', leaseMs: 300000, maxLeaseMs: 300000 }] },
  evidenceRetention: { mode: 'cache', ttlMs: 300000 },
});
const inspection = (await client.listInspections(session.id)).items[0];
const targets = (await client.observation(session.id)).controls.filter(c => c.name === targetName);
if (targets.length !== 1) throw new Error(`Expected one target named ${targetName}; found ${targets.length}. Bind a unique current node instead.`);
await client.receiveInspection(session.id, inspection.id, 'scroll-rules');
const report = await inspectScrollRecovery(client, inspection, targets[0].localId, {
  requiredNow: { reason, evidence: ['caller:explicit-cli-requirement'] }, maxScrolls: 8,
});
await client.completeInspection(session.id, inspection.id, 'scroll-rules', toInspectionResults([report]));
console.log(JSON.stringify({ sessionId: session.id, report }, null, 2));
// Run once for this explicit target. Do not feed probe-created inspection.ready
// events back into the active rule: that would create an investigation loop.
