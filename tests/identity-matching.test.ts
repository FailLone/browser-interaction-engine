import { expect, it } from 'vitest';
import { canonical, matchIdentities, type Control, type ControlIdentity, type IdentityHypothesis, type Observation } from '@interaction/core';

const signature = (c: Control) => canonical({ role: c.role, name: c.name, label: c.label, region: c.region });
const control = (instance: string, stableKey?: string, name = 'Edit'): Control => ({ localId: `doc:${instance}`, instanceId: `doc:${instance}`, stableKey, name, label: name, role: 'button', region: 'orders', visible: true, enabled: true });
function tracker() {
  const identities: ControlIdentity[] = []; const hypotheses: IdentityHypothesis[] = []; let count = 0;
  const observe = (controls: Control[]) => {
    const o: Observation = { id: `o${++count}`, sessionId: 'session', capturedAt: new Date().toISOString(), instanceScope: 'doc:', controls: structuredClone(controls), regions: [], context: {}, gaps: [], stable: true, stateId: '', visitId: '', fingerprint: '', canonical: '', ruleVersion: 'test', cause: 'inspection' };
    const result = matchIdentities(o, identities, hypotheses, signature);
    hypotheses.push(...result.hypotheses);
    expect(new Set(o.controls.map(c => c.identityId)).size).toBe(o.controls.length);
    return o;
  };
  const resolve = (h: IdentityHypothesis, chosen = h.provisionalIdentityId) => { h.status = 'resolved'; h.revisions.push({ identityId: chosen, source: 'test', evidence: ['Verified record'], at: new Date().toISOString() }); };
  return { identities, hypotheses, observe, resolve };
}

it('tracks keyed duplicate labels across reorder, rebuild, insertion, removal and reappearance without cross-key candidates', () => {
  const t = tracker();
  const a = control('a', 'order:a'); const b = control('b', 'order:b');
  const first = t.observe([a, b]);
  expect(t.hypotheses).toHaveLength(0);
  const reordered = t.observe([control('rebuilt-b', 'order:b'), control('new-c', 'order:c'), control('rebuilt-a', 'order:a')]);
  expect(reordered.controls.map(c => c.identityId)).toEqual([first.controls[1].identityId, expect.any(String), first.controls[0].identityId]);
  expect(reordered.controls[1].identityId).not.toBe(first.controls[0].identityId);
  expect(t.hypotheses).toHaveLength(0);
  t.observe([control('a-only', 'order:a')]);
  const returned = t.observe([control('return-b', 'order:b')]);
  expect(returned.controls[0].identityId).toBe(first.controls[1].identityId);
});

it.each([false, true])('makes duplicate matching independent of iteration order (reversed=%s)', reversed => {
  const t = tracker(); const pair = [control('a'), control('b')];
  const first = t.observe(reversed ? pair.toReversed() : pair);
  expect(t.hypotheses).toHaveLength(2);
  for (const h of t.hypotheses) expect(h.candidateIds).toEqual(first.controls.filter(c => c.localId !== h.localId).map(c => c.identityId));
  const second = t.observe(first.controls.toReversed());
  expect(t.hypotheses).toHaveLength(2);
  for (const c of second.controls) expect(c).toMatchObject(first.controls.find(previous => previous.localId === c.localId)!);
  const rebuilt = t.observe([control('c'), control('d')]);
  expect(rebuilt.controls.every(c => c.hypothesisId)).toBe(true);
  for (const h of t.hypotheses.slice(2)) expect(h.candidateIds).toEqual(expect.arrayContaining(first.controls.map(c => c.identityId)));
});

it('does not let node continuity or traversal order steal an identity when a same-name duplicate appears', () => {
  const t = tracker(); const first = t.observe([control('a')]);
  const next = t.observe([control('b'), control('a')]);
  expect(next.controls.every(c => c.identityId !== first.controls[0].identityId && c.hypothesisId)).toBe(true);
  expect(t.hypotheses.every(h => h.candidateIds.includes(first.controls[0].identityId!))).toBe(true);
  const alone = t.observe([control('a')]);
  expect(alone.controls[0].hypothesisId).toBe(next.controls[1].hypothesisId);
});

it('does not transfer a pending hypothesis or human decision to a recycled node with a different record key', () => {
  const t = tracker();
  const first = t.observe([control('slot', 'order:a'), control('duplicate', 'order:a')]);
  t.resolve(t.hypotheses[0]);
  const next = t.observe([control('slot', 'order:b'), control('duplicate', 'order:c')]);
  expect(next.controls.every(c => !c.hypothesisId && first.controls.every(old => old.identityId !== c.identityId))).toBe(true);
  expect(t.hypotheses).toHaveLength(2);
});

it('invalidates a no-key human decision when a recycled node changes its semantic binding', () => {
  const t = tracker(); t.observe([control('slot'), control('other')]);
  t.resolve(t.hypotheses[0]);
  const next = t.observe([control('slot', undefined, 'Delete')]);
  expect(next.controls[0].identityId).not.toBe(t.hypotheses[0].provisionalIdentityId);
  expect(next.controls[0].hypothesisId).toBeUndefined();
});

it('retains sourced duplicate decisions across reordering while keeping unresolved peers blocked', () => {
  const t = tracker(); const first = t.observe([control('a'), control('b')]);
  t.resolve(t.hypotheses[0]);
  const next = t.observe([control('b'), control('a')]);
  expect(next.controls[1].identityId).toBe(first.controls[0].identityId);
  expect(next.controls[1].hypothesisId).toBeUndefined();
  expect(next.controls[0].hypothesisId).toBe(first.controls[1].hypothesisId);
});

it('keeps one-to-one assignment when conflicting external decisions choose the same historical identity', () => {
  const t = tracker(); t.observe([control('a'), control('b')]);
  const chosen = t.hypotheses[0].provisionalIdentityId;
  t.resolve(t.hypotheses[0], chosen); t.resolve(t.hypotheses[1], chosen);
  const next = t.observe([control('b'), control('a')]);
  expect(next.controls.every(c => c.hypothesisId && c.identityId !== chosen)).toBe(true);
  expect(t.hypotheses.slice(2).every(h => h.evidence.includes('competing-current-matches') && h.candidateIds.includes(chosen))).toBe(true);
});

it('excludes a resolved provisional alias from future historical candidates', () => {
  const t = tracker(); const first = t.observe([control('original')]);
  t.observe([control('a'), control('b')]);
  t.resolve(t.hypotheses[0], first.controls[0].identityId);
  // The other duplicate remains a genuine alternative; only the merged alias is excluded.
  const next = t.observe([control('rebuilt')]);
  const h = t.hypotheses.find(h => h.id === next.controls[0].hypothesisId)!;
  expect(h.candidateIds).toContain(first.controls[0].identityId);
  expect(h.candidateIds).not.toContain(t.hypotheses[0].provisionalIdentityId);
});

it('scopes keys by role and region, rejects key changes, and never falls back across keyed and unkeyed records', () => {
  const t = tracker();
  const first = t.observe([control('a', 'same'), { ...control('b', 'same'), region: 'archive' }, { ...control('c', 'same'), role: 'link' }]);
  expect(t.hypotheses).toHaveLength(0);
  const second = t.observe([{ ...control('c2', 'same'), role: 'link' }, { ...control('b2', 'same'), region: 'archive' }, control('a2', 'same')]);
  expect(second.controls.map(c => c.identityId)).toEqual(first.controls.toReversed().map(c => c.identityId));
  const changed = t.observe([control('a2', 'different'), control('unkeyed')]);
  expect(changed.controls.every(c => !c.hypothesisId && first.controls.every(old => old.identityId !== c.identityId))).toBe(true);
});

it('matches a large keyed list without repeatedly recomputing semantic signatures for every pair', () => {
  const t = tracker(); const first = t.observe(Array.from({ length: 1500 }, (_, i) => control(String(i), `item:${i}`)));
  let calls = 0;
  const next = { ...first, id: 'large-reorder', controls: structuredClone(first.controls).reverse() };
  const result = matchIdentities(next, t.identities, [], c => { calls++; return signature(c); });
  expect(calls).toBe(1500); expect(result.hypotheses).toHaveLength(0);
  expect(next.controls.map(c => c.identityId)).toEqual(first.controls.toReversed().map(c => c.identityId));
});

it('limits weak identity continuity to a present instance, including disappearance and node reuse', () => {
  const t = tracker(); const weak = { ...control('slot', 'description:Package'), identityScope: 'instance' as const };
  const first = t.observe([weak]);
  expect(t.observe([weak]).controls[0].identityId).toBe(first.controls[0].identityId);
  const rebuilt = t.observe([{ ...weak, localId: 'doc:new', instanceId: 'doc:new' }]);
  expect(rebuilt.controls[0].identityId).not.toBe(first.controls[0].identityId);
  t.observe([]);
  const reused = t.observe([weak]);
  expect(reused.controls[0].identityId).not.toBe(first.controls[0].identityId);
  expect(reused.controls[0].hypothesisId).toBeUndefined();
});
