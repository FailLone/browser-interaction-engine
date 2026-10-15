// Opt-in real-page audit. Every interaction goes through the engine action ledger.
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { BrowserEngine, type Observation, type ComponentDetails } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';

const directory = resolve(process.argv[2] || 'work/components-okx/2026-10-15');
mkdirSync(directory, { recursive: true });
const engine = new BrowserEngine({ persistence: new MemoryStore() });
let sessionId: string | undefined; const phases: unknown[] = []; const probes: ComponentDetails[] = [];
let failure: string | undefined;
try {
  const session = await engine.createSession({ url: 'https://www.okx.com/zh-hans/convert/btc-to-usd', headless: true,
    settleMs: 400, observeTimeoutMs: 5000, actionTimeoutMs: 15000, maxActions: 30, contextRules: [],
    evidenceRetention: { mode: 'cache', ttlMs: 600000, maxBytes: 256 * 1024 ** 2, maxObservations: 50 } });
  sessionId = session.id;
  const record = (phase: string) => {
    const o = engine.observation(session.id);
    const data = { phase, observationId: o.id, controls: o.controls.length, components: o.components?.length,
      pending: o.controls.filter(c => c.hypothesisId).length, boundaries: o.boundaries, gaps: o.gaps };
    phases.push(data); console.log(JSON.stringify({ phase, controls: data.controls, pending: data.pending, boundaries: data.boundaries?.length, gaps: o.gaps.map(g => g.code) })); return o;
  };
  const perform = async (localId: string, kind = 'click', value?: string) => {
    const action = engine.actions(session.id).find(a => a.localId === localId && a.kind === kind); assert.ok(action);
    const attempt = await engine.execute(session.id, action.id, crypto.randomUUID(), value);
    assert.equal(attempt.status, 'succeeded', attempt.reason); return attempt;
  };
  record('initial');
  const close = engine.observation(session.id).controls.find(c => c.name === '关闭' && c.visible && c.role === 'button');
  if (close) { await perform(close.localId); record('close-notice'); }
  let o = engine.observation(session.id);
  const opener = o.controls.find(c => c.name === 'BTC' && c.actionBasis?.click?.evidence.some(e => e.rule === 'positioned-choice-popup-trigger/v1'));
  assert.ok(opener, 'The engine must discover the custom BTC selector');
  await perform(opener.localId); o = record('currency-open'); assert.equal(o.boundaries?.length, 1);
  const search = o.controls.find(c => c.name === '搜索' && c.tag === 'input' && c.visible); assert.ok(search);
  await perform(search.localId, 'fill', 'ETH'); o = record('currency-search-ETH');
  assert.equal(o.controls.find(c => c.instanceId === search.instanceId)?.value, 'ETH');
  await perform(opener.localId); o = record('currency-close-attempt');
  if (o.boundaries?.length) {
    const escape = engine.actions(session.id).find(a => a.kind === 'press' && a.value === 'Escape')!;
    const attempt = await engine.execute(session.id, escape.id, crypto.randomUUID()); assert.equal(attempt.status, 'succeeded');
    o = record('currency-escape');
  }
  if (o.boundaries?.length) {
    // Selecting the already-current currency closes this custom panel without a conversion change.
    await perform(search.localId, 'fill', 'BTC'); o = record('currency-search-BTC');
    const option = o.controls.find(c => c.visible && c.role === 'button' && c.name === 'BTC' && o.overlays?.at(-1)?.controlIds.includes(c.localId));
    assert.ok(option, 'Current currency must be a selectable option');
    await perform(option.localId); o = record('currency-close-current-option');
  }
  // Some choices navigate and show a new region notice. Verify the old popup is gone first.
  assert.ok(!o.overlays?.some(p => p.kind === 'listbox'));
  const newNotice = o.controls.find(c => c.visible && c.name === '关闭' && c.role === 'button');
  if (newNotice) { await perform(newNotice.localId); o = record('close-new-notice'); }
  assert.equal(o.boundaries?.length, 0);
  const amount = o.controls.find(c => c.tag === 'input' && c.name === '0' && c.identityContext?.binding?.includes('BTC')); assert.ok(amount);
  await perform(amount.localId, 'fill', '2'); o = record('continue-amount-fill');
  assert.equal(o.controls.find(c => c.instanceId === amount.instanceId)?.value, '2');
  const group = o.components?.find(c => c.members.length === 5 && c.members.every(m => {
    const control = o.controls.find(v => v.localId === m.localId); return control?.role === 'button' && !control.name;
  })); assert.ok(group, 'Expected one structural group of five unnamed buttons');
  assert.ok(group.members.every(m => m.value === undefined));
  const measured: number[] = [];
  for (const member of group.members) {
    o = engine.observation(session.id);
    const attempt = await engine.probe(session.id, o.id, member.localId, 'hover', crypto.randomUUID());
    assert.equal(attempt.status, 'succeeded', attempt.reason);
    o = record(`hover-${probes.length + 1}`);
    const details = await engine.componentDetails(session.id, o.id, group.id); probes.push(details);
    // Audit-only interpretation of recorded icon classes, never engine inference.
    measured.push(details.subtree.nodes.filter(n => /(?:^|\s)\S*filledStar\S*/.test(n.attributes?.class || '')).length);
  }
  assert.deepEqual(measured, [1, 2, 3, 4, 5]);
  const description = await engine.describeComponent(session.id, { observationId: o.id, componentId: group.id, kind: 'rating', name: 'Page rating',
    members: group.members.map((m, i) => ({ ...m, value: measured[i] })), source: 'behavior-audit', reason: 'Each member hover showed the recorded count of filled star icons; click effects were not exercised',
    evidence: probes.map(p => ({ observationId: p.observationId, componentId: group.id })) });
  writeFileSync(join(directory, 'description.json'), JSON.stringify(description, null, 2));
  writeFileSync(join(directory, 'probes.json'), JSON.stringify(probes));
  const screenshot = await engine.evidenceArtifact(session.id, o.id, 'screenshot'); writeFileSync(join(directory, 'rating-hover.png'), screenshot.data);
  console.log(JSON.stringify({ result: 'passed', measured, actions: engine.session(session.id).actionCount, descriptionId: description.id }));
} catch (error) { failure = String(error); console.error(failure); process.exitCode = 1; }
finally {
  if (sessionId) {
    const observations = engine.list<Observation>(sessionId, 'observation');
    writeFileSync(join(directory, 'observations.json'), JSON.stringify(observations));
    writeFileSync(join(directory, 'attempts.json'), JSON.stringify(engine.list(sessionId, 'attempt'), null, 2));
    const current = engine.observation(sessionId); writeFileSync(join(directory, 'last-details.json'), JSON.stringify(await engine.observationDetails(sessionId, current.id)));
  }
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), result: failure ? 'failed' : 'passed', failure, phases }, null, 2));
  await engine.close();
}
