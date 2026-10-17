import { expect, it, vi } from 'vitest';
import { InteractionEngine, type ActionAttempt, type ActionCandidate, type ReceiptCoverageReader, type Session } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter, type CounterObservation } from '../examples/counter-adapter.js';

// The core only accepts a composition's explicit proof contract. These fixtures
// exercise that port; browser raw evidence is tested separately at its reader.
function fixture(declared: boolean, portable: boolean, identity: 'pending' | 'missing' | 'resolved') {
  const store = new MemoryStore(), at = '2026-10-17T00:00:00.000Z';
  const observation = (id: string): CounterObservation => ({
    id, sessionId: 'session', capturedAt: at, instanceScope: 'fixture-lifetime', count: 0,
    controls: [{ localId: 'counter', instanceId: 'counter-instance', identityId: 'counter-identity', hypothesisId: 'identity-review',
      role: 'accumulator', name: 'Counter', label: 'Counter', region: 'machine', visible: true, enabled: true }],
    regions: [], context: {}, stable: true, gaps: [], stateId: `state-${id}`, visitId: `visit-${id}`,
    fingerprint: id, canonical: id, ruleVersion: 'counter-v1', cause: 'inspection',
  });
  const before = observation('before'), after = observation('after');
  const action: ActionCandidate = {
    id: 'source-action', sessionId: 'session', observationId: before.id, stateId: before.stateId,
    localId: 'counter', controlId: 'counter-identity', kind: 'increment', label: 'Increment', value: { by: 1 },
    preconditions: { context: {}, visible: true, enabled: true, identityResolved: false },
    target: { kind: 'instance', instanceScope: before.instanceScope!, instanceId: 'counter-instance', evidence: [] },
    basis: { status: 'supported', evidence: [] }, risk: 'interface', replayable: false,
    source: 'fixture', excluded: false, sampleValidity: 'known',
  };
  const attempt: ActionAttempt = { id: 'receipt', sessionId: 'session', requestId: 'request', action,
    beforeId: before.id, afterId: after.id, status: 'succeeded', purpose: 'exploration', startedAt: at, finishedAt: at };
  const session: Session = { id: 'session', options: { maxActions: 10, maxDepth: 10, maxDurationMs: 1000, context: {}, exploration: 'controls' },
    createdAt: at, status: 'paused', currentObservationId: after.id, actionCount: 1, elapsedMs: 0, mode: 'manual', dirty: false };
  class Adapter extends CounterAdapter {
    correspondenceCase = vi.fn(() => portable ? { key: 'portable', policy: 'fixture-portable', evidence: [] } : undefined);
    override createDriver(): never { throw new Error('A receipt query must not create a driver'); }
  }
  const adapter = new Adapter(), retained = vi.fn<ReceiptCoverageReader<CounterObservation>>(() => ({
    key: 'instance-proof', policy: 'fixture-retained', evidence: ['fixture-declared-instance-proof'],
  }));
  const reader: ReceiptCoverageReader<CounterObservation> = declared
    ? Object.assign(retained, { identityBasis: 'same-document-instance-v1' as const }) : retained;
  class Host extends InteractionEngine<CounterObservation> {
    protected override retainedReceiptCoverageReader() { return reader; }
  }
  const host = new Host({ adapter, persistence: store });
  store.put('session', session); store.put('observation', before); store.put('observation', after); store.put('attempt', attempt);
  if (identity !== 'missing') store.put('hypothesis', { id: 'identity-review', sessionId: session.id, status: identity });
  const put = vi.spyOn(store, 'put'), event = vi.spyOn(store, 'event');
  return { store, retained, adapter, put, event, query: () => host.operationReceiptCondition(session.id, { attemptId: attempt.id }) };
}

it.each(['pending', 'missing'] as const)('retains the default identity gate for undeclared readers: %s', identity => {
  const f = fixture(false, false, identity);
  try {
    expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: false, status: 'unavailable',
      reason: identity === 'pending' ? 'identity_pending' : 'source_identity_unverified' });
    expect(f.retained).not.toHaveBeenCalled(); expect(f.adapter.correspondenceCase).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled(); expect(f.event).not.toHaveBeenCalled();
  } finally { f.store.close(); }
});

it.each(['pending', 'missing'] as const)('accepts explicitly instance-bound coverage without granting logical authority: %s', identity => {
  const f = fixture(true, false, identity);
  try {
    expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: true, status: 'document', policy: 'fixture-retained',
      identityAuthorized: false, arrivalVerified: false, replayAuthorized: false, currentExecution: false });
    expect(f.retained).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled(); expect(f.event).not.toHaveBeenCalled();
  } finally { f.store.close(); }
});

it.each(['pending', 'missing'] as const)('never turns an identity-rejected portable sample into document coverage: %s', identity => {
  const f = fixture(true, true, identity);
  try {
    expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: false, status: 'unavailable',
      reason: identity === 'pending' ? 'identity_pending' : 'source_identity_unverified' });
    expect(f.adapter.correspondenceCase).toHaveBeenCalledOnce(); expect(f.retained).not.toHaveBeenCalled();
  } finally { f.store.close(); }
});

it.each([false, true])('preserves portable coverage once the identity gate passes, declared reader: %s', declared => {
  const f = fixture(declared, true, 'resolved');
  try { expect(f.query()).toMatchObject({ conditionVerified: true, status: 'portable', policy: 'fixture-portable' }); expect(f.retained).not.toHaveBeenCalled(); }
  finally { f.store.close(); }
});
