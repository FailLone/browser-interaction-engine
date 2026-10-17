import { expect, it, vi } from 'vitest';
import { InteractionEngine, operationSample, type ActionAttempt, type ActionCandidate, type ReceiptCoverageReader, type Session } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter, type CounterObservation } from '../examples/counter-adapter.js';

function fixture(projectedSampleAvailable: boolean) {
  const store = new MemoryStore();
  const at = '2026-10-17T00:00:00.000Z';
  const context = { tenant: { status: 'known' as const, value: 'one', source: 'fixture' } };
  const observation = (id: string): CounterObservation => ({
    id, sessionId: 'session', capturedAt: at, instanceScope: 'document', count: 0,
    controls: [{ localId: 'counter', instanceId: 'counter-instance', identityId: 'counter-identity',
      role: 'accumulator', name: 'Counter', label: 'Counter', region: 'machine', visible: true, enabled: true }],
    regions: [{ key: 'machine', role: 'machine', label: 'State machine' }], context,
    stable: true, gaps: [], stateId: `state-${id}`, visitId: `visit-${id}`,
    fingerprint: id, canonical: id, ruleVersion: 'counter-v1', cause: 'inspection',
  });
  const before = observation('before'), after = observation('after'), current = observation('current');
  const action = (id: string, o: CounterObservation): ActionCandidate => ({
    id, sessionId: o.sessionId, observationId: o.id, stateId: o.stateId,
    localId: 'counter', controlId: 'counter-identity', kind: 'increment', label: 'Increment counter', value: { by: 1 },
    preconditions: { context, visible: true, enabled: true, identityResolved: true },
    basis: { status: 'supported', evidence: [] }, risk: 'interface', replayable: true,
    source: 'counter-adapter', excluded: false, sampleValidity: 'known',
  });
  const sourceAction = action('source-action', before), target = action('target-action', current);
  const attempt: ActionAttempt = {
    id: 'successful-attempt', sessionId: 'session', requestId: 'request', action: sourceAction,
    beforeId: before.id, afterId: after.id, status: 'succeeded', purpose: 'exploration', startedAt: at, finishedAt: at,
  };
  const session: Session = {
    id: 'session', options: { maxActions: 10, maxDepth: 10, maxDurationMs: 1000, context: {}, exploration: 'controls' },
    createdAt: at, status: 'paused', currentObservationId: current.id, actionCount: 1, elapsedMs: 0, mode: 'manual', dirty: false,
  };
  class Adapter extends CounterAdapter {
    correspondenceCase = vi.fn((candidate: ActionCandidate, o: CounterObservation) => {
      const projected = candidate.basis?.evidence.some(e => e.rule === 'fixture-review-projection');
      if (projected && !projectedSampleAvailable) return;
      return { key: o.id === before.id || projected ? 'source-case' : 'different-target-case',
        policy: 'fixture-portable', evidence: ['fixture-portable-conditions'] };
    });
  }
  const adapter = new Adapter();
  const projection = vi.fn((): {risk: 'interface'; basis: NonNullable<ActionCandidate['basis']>; evidence: string[]} => ({
    risk: 'interface', basis: { status: 'supported', evidence: [{ source: 'fixture', rule: 'fixture-review-projection', facts: {} }] },
    evidence: ['fixture-historical-review'],
  }));
  const retained = vi.fn<ReceiptCoverageReader<CounterObservation>>(() => ({
    key: 'retained-would-accept', policy: 'fixture-retained', evidence: ['must-not-be-consulted'],
  }));
  class Host extends InteractionEngine<CounterObservation> {
    protected override historicalReviewProjection() { return projection(); }
    protected override retainedReceiptCoverageReader() { return retained; }
  }
  const host = new Host({ adapter, persistence: store });
  for (const o of [before, after, current]) store.put('observation', o);
  store.put('session', session); store.put('action', target); store.put('attempt', attempt);
  return { store, adapter, projection, retained, before, current, sourceAction, target, attempt,
    query: () => host.operationCorrespondence(session.id, {
      observationId: current.id, actionId: target.id, source: { sessionId: session.id, attemptId: attempt.id },
    }) };
}

it.each([false, true])('keeps known portable mismatch separate from retained fallback when projected sample exists: %s', projectedSampleAvailable => {
  const f = fixture(projectedSampleAvailable);
  try {
    const source = operationSample(f.sourceAction, f.before, f.adapter.correspondenceCase);
    const target = operationSample(f.target, f.current, f.adapter.correspondenceCase);
    expect(source).toBeDefined(); expect(target).toBeDefined(); expect(source!.key).not.toBe(target!.key);
    f.adapter.correspondenceCase.mockClear();
    const writes = vi.spyOn(f.store, 'put'), events = vi.spyOn(f.store, 'event');
    const result = f.query();
    expect(f.projection).toHaveBeenCalledOnce();
    expect(f.adapter.correspondenceCase).toHaveBeenCalledTimes(3);
    expect(f.adapter.correspondenceCase.mock.results[2].value === undefined).toBe(!projectedSampleAvailable);
    expect(f.retained).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      equivalent: projectedSampleAvailable,
      reason: projectedSampleAvailable ? 'equivalent_reviewed_operation_sample' : 'operation_conditions_unavailable',
      identityAuthorized: false, replayAuthorized: false, currentExecution: false,
    });
    if (projectedSampleAvailable) expect(result.evidence).toContain('fixture-historical-review');
    expect(f.store.require('action', f.target.id)).toEqual(f.target);
    expect(f.store.require('attempt', f.attempt.id)).toEqual(f.attempt);
    expect(writes).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
  } finally { f.store.close(); }
});
