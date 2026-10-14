import { expect, it } from 'vitest';
import { withFrontierStates, type BrowserFrontierCoverageGroup, type FrontierItemView, type FrontierStateSummary, type Observation } from '@interaction/browser';
import { differenceText, referenceFor, stateDifferences, sameValue } from '../apps/ui/src/frontier-comparison.js';

const item = (id: string, stateId: string, value: string, status = 'executed') => ({ id, sessionId: 'session', stateId, action: { observationId: `obs-${stateId}`, value, preconditions: { context: {} } }, status } as FrontierItemView);
const state = (stateId: string, value: string): FrontierStateSummary => ({ stateId, observationId: `obs-${stateId}`, status: 'available', facts: [{ key: 'price:value', label: 'Price', field: 'value', value, primary: true, controlId: 'price' }] });
it('compares identical input samples across actual interface conditions even when business context is empty', () => {
  const pending = item('pending', 'initial', '0.001', 'blocked');
  const otherInput = item('other-input', 'initial', '2'); const sameInput = item('same-input', 'price-filled', '0.001');
  const group = { items: [pending, otherInput, sameInput], states: [state('initial', ''), state('price-filled', '0.01')] } as BrowserFrontierCoverageGroup;
  expect(referenceFor(group, pending, 'auto')?.id).toBe('same-input');
  expect(stateDifferences(group.states[1], group.states[0])).toEqual([{ key: 'price:value', label: 'Price', field: 'value', before: '0.01', after: '' }]);
  expect(referenceFor(group, pending, 'other-input')?.stateId).toBe(pending.stateId);
  expect(sameValue(otherInput.action.value, pending.action.value)).toBe(false);
  expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
});
it('reports disappearance once and keeps late text changes visible', () => {
  const before = state('limit', '0.01'); before.facts.push({ key: 'price:visible', label: 'Price · 可见', field: 'visible', value: true, primary: false, controlId: 'price' });
  const after = { ...state('market', ''), facts: [] };
  expect(stateDifferences(before, after)).toEqual([{ key: 'price:value', label: 'Price', field: 'value', before: '0.01', after: undefined }]);
  const prefix = 'unchanged '.repeat(100);
  expect(differenceText(`${prefix}Submitted orders: 1`, `${prefix}Submitted orders: 0`)).toContain('Submitted orders: 1');
});
it('never fills missing historical state with a different state or session', () => {
  const group = { items: [item('pending', 'initial', '0.001', 'blocked')] } as BrowserFrontierCoverageGroup;
  for (const observation of [undefined, { stateId: 'other', sessionId: 'session' }, { stateId: 'initial', sessionId: 'other-session' }]) {
    const result = withFrontierStates([group], () => observation as Observation | undefined);
    expect(result[0].states).toEqual([{ stateId: 'initial', observationId: 'obs-initial', status: 'unavailable', facts: [] }]);
    expect(stateDifferences(result[0].states[0], state('initial', ''))).toEqual([]);
  }
});
