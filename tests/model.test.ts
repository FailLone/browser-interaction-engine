import { observableCanonical } from '@interaction/adapter-playwright';
import { signature } from '../packages/adapter-playwright/src/util.js';
import { it, expect } from 'vitest';
import { assignState, matchIdentities } from '@interaction/core';
import type { Observation, Control, ControlIdentity, IdentityHypothesis } from '@interaction/browser';
function observation(): Observation {
  return { id: 'one', sessionId: 'session', url: 'http://example.test/', controls: [], context: {}, scroll: { x: 0, y: 0, maxY: 0 }, gaps: [], ruleVersion: 'observable-v1', documentId: 'doc', instanceScope: 'doc' } as unknown as Observation;
}
it('never merges incomplete observations or a fingerprint collision without content equality', () => {
  const a = observation(); const first = assignState(a, [], o => observableCanonical(o as Observation));
  const collision = { ...first, canonical: 'different normalized content' };
  expect(assignState(observation(), [collision], o => observableCanonical(o as Observation)).id).not.toBe(first.id);
  const partial = { ...observation(), gaps: [{ code: 'TRUNCATED', message: 'Incomplete DOM', critical: true }] };
  const state = assignState(partial, [], o => observableCanonical(o as Observation));
  expect(assignState(structuredClone(partial), [state], o => observableCanonical(o as Observation)).id).not.toBe(state.id);
});
it('retains anonymous historical identities as ambiguous instead of trusting DOM continuity alone', () => {
  const c = { localId: 'doc:1', instanceId: 'doc:1', name: '', label: '', region: 'document', form: 'document', role: 'button', actions: ['click'], constraints: { type: 'button' } } as Control;
  const first = { ...observation(), controls: [structuredClone(c)] };
  const identities: ControlIdentity[] = []; const hypotheses: IdentityHypothesis[] = [];
  matchIdentities(first, identities, hypotheses, signature); const oldId = first.controls[0].identityId;
  const next = { ...observation(), id: 'two', controls: [structuredClone(c)] };
  const result = matchIdentities(next, identities, hypotheses, signature);
  expect(next.controls[0].identityId).not.toBe(oldId);
  expect(result.identities.some(i => i.id === oldId)).toBe(true);
  expect(result.hypotheses[0].candidateIds).toContain(oldId);
});
