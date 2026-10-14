import { InteractionClient } from '@interaction/client';
import type { ActionCandidate, IdentityHypothesis } from '@interaction/browser';

// The caller chooses paths and makes identity judgments. It never owns browser handles.
const client = new InteractionClient(process.env.ENGINE_URL || 'http://127.0.0.1:4173');
const session = await client.createSession({ url: process.argv[2] || 'http://127.0.0.1:4174', headless: true, contextRules: [{ key: 'pair', selector: '#pair' }] });
async function choose(label: string, kind: ActionCandidate['kind'] = 'click', value?: string) {
  const candidates = await client.actions(session.id);
  const action = candidates.find(a => a.label === label && a.kind === kind && !a.excluded);
  if (!action) throw new Error(`No available candidate: ${label}`);
  const result = await client.execute(session.id, action.id, crypto.randomUUID(), value);
  console.log(label, result.status, result.diff?.changes);
}
try {
  await choose('Order type'); await choose('Market'); await choose('Amount', 'fill', '2');
  await choose('Duplicate controls');
  const { items } = await client.list<IdentityHypothesis>(session.id, 'hypotheses', { status: 'pending' });
  for (const hypothesis of items) {
    console.log('Identity evidence:', hypothesis);
    // This example explicitly keeps each provisional identity independent.
    // A real caller can choose a historical candidate using its own evidence.
    await client.command(session.id, { type: 'resolveIdentity', hypothesisId: hypothesis.id, identityId: hypothesis.provisionalIdentityId, source: 'example-external-policy', evidence: ['Retain this occurrence as an independent control; no historical equivalence is asserted.'] });
  }
  console.log('Graph:', await client.graph(session.id));
} finally { await client.command(session.id, { type: 'stop' }); }
