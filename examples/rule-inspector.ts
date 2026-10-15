import { InteractionClient } from '@interaction/client';
import { RuleRunner, sampledOcclusionRule, toInspectionResults, type RuleSelection } from '@interaction/rules';

// pnpm exec tsx --conditions=development examples/rule-inspector.ts URL
const url = process.argv[2];
if (!url) throw new Error('Supply the page URL to inspect');
const client = new InteractionClient(process.env.INTERACTION_URL || 'http://127.0.0.1:4173');
const runner = new RuleRunner([sampledOcclusionRule]);
// An upper-level agent can read catalog() and provide this JSON plan per inspection.
const plan: RuleSelection[] = [{ ruleId: 'sampled-occlusion', ruleVersion: '1.0.0', options: { includeDisabled: false } }];
const session = await client.createSession({ url, headless: true, inspection: { consumers: [{ id: 'rules' }] }, evidenceRetention: { mode: 'cache', ttlMs: 300000 } });
console.log(`Rule inspection session ${session.id}. Operate this session in the UI or SDK.`, runner.catalog());
for await (const event of client.events(session.id)) {
  if (event.type !== 'inspection.ready') continue;
  const { inspectionId } = event.data as { inspectionId: string };
  const { inspection, deliveries } = await client.inspection(session.id, inspectionId);
  if (deliveries.find(d => d.consumerId === 'rules')?.status !== 'pending') continue;
  await client.receiveInspection(session.id, inspectionId, 'rules');
  const reports = await runner.run(client, inspection, plan);
  await client.completeInspection(session.id, inspectionId, 'rules', toInspectionResults(reports));
  console.log(JSON.stringify(reports, null, 2));
}
