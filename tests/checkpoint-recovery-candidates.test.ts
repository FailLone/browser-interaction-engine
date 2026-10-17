import { afterEach, expect, it, vi } from 'vitest';
import { InteractionEngine, type ActionAttempt, type ActionCandidate, type Checkpoint, type EngineHooks,
  type Session, type Transition, type UIState } from '@interaction/core';
import type { RestorationStep } from '../packages/core/src/ports.js';
import { NavigationIndex } from '../packages/core/src/navigation-index.js';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter, type CounterObservation } from '../examples/counter-adapter.js';

const sid = 'candidate-session', timestamp = '2026-10-17T00:00:00.000Z';
const engines: InteractionEngine<CounterObservation>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) await engine.close(); });

/** All strategy probes are retained-fact ports. No driver is constructed, even
 * in fixture setup; a probe returning a candidate never executes that action. */
class CandidateAdapter extends CounterAdapter {
  exit?: ActionCandidate;
  nativeReturn?: ActionCandidate;
  localRestore?: RestorationStep;
  environmentReset?: ActionCandidate;
  override createDriver(): never { throw new Error('Candidate query must not construct a driver'); }
  returnAction() { return this.exit; }
  returnToObservation() { return this.nativeReturn; }
  restorationStep() { return this.localRestore; }
  resetAction() { return this.environmentReset; }
}

function observation(id: string, count: number, patch: Partial<CounterObservation> = {}): CounterObservation {
  return { id, sessionId: sid, capturedAt: timestamp, instanceScope: 'counter-document', count,
    controls: [{ localId: 'counter', instanceId: 'counter-instance', identityId: 'counter-identity',
      stableKey: 'counter', role: 'accumulator', name: 'Counter', label: 'Counter', region: 'machine', visible: true, enabled: true }],
    regions: [{ key: 'machine', role: 'machine', label: 'State machine' }], context: {}, stable: true, gaps: [], boundaries: [],
    stateId: `state-${id}`, visitId: `visit-${id}`, fingerprint: `count:${count}`, canonical: `count:${count}`,
    ruleVersion: 'counter-v1', cause: 'inspection', ...patch };
}

function action(o: CounterObservation, id: string, patch: Partial<ActionCandidate> = {}): ActionCandidate {
  return { id, sessionId: sid, observationId: o.id, stateId: o.stateId, localId: 'counter', controlId: 'counter-identity',
    kind: 'increment', label: 'Increment counter', value: { by: 1 },
    preconditions: { context: o.context, visible: true, enabled: true, identityResolved: true, targetResolved: true },
    risk: 'interface', replayable: true, excluded: false, source: 'counter-fixture', sampleValidity: 'known',
    basis: { status: 'supported', evidence: [{ source: 'fixture', rule: 'counter/v1', facts: { operation: 'increment' } }] }, ...patch };
}

function fixture(options: { current?: Partial<CounterObservation>; hooks?: EngineHooks<CounterObservation>; dirty?: boolean } = {}) {
  const store = new MemoryStore(), adapter = new CandidateAdapter();
  const engine = new InteractionEngine({ adapter, persistence: store, hooks: options.hooks }); engines.push(engine);
  const current = observation('current', 0, options.current), source = observation('source', 1);
  const session: Session = { id: sid, options: adapter.parseOptions({}), createdAt: timestamp, status: 'paused',
    currentObservationId: current.id, actionCount: 1, elapsedMs: 0, mode: 'manual', dirty: options.dirty ?? false };
  store.put('session', session);
  for (const o of [current, source]) {
    store.put('observation', o);
    store.put('state', { id: o.stateId, sessionId: sid, fingerprint: o.fingerprint, canonical: o.canonical,
      ruleVersion: o.ruleVersion, observationIds: [o.id], context: o.context } satisfies UIState);
  }
  const currentAction = action(current, 'current-action'); store.put('action', currentAction);
  const entry: ActionAttempt = { id: 'nonreplayable-entry', sessionId: sid, requestId: 'entry-request',
    action: action(current, 'old-entry-action', { replayable: false }), startedAt: timestamp, finishedAt: timestamp,
    beforeId: current.id, afterId: source.id, status: 'succeeded', purpose: 'external' };
  store.put('attempt', entry);
  const checkpoint: Checkpoint = { id: 'checkpoint', sessionId: sid, name: 'counter one', observationId: source.id,
    stateId: source.stateId, context: source.context, predicates: [], acceptable: [], path: [entry.id], createdAt: timestamp };
  store.put('checkpoint', checkpoint);
  const driver = vi.spyOn(adapter, 'createDriver');
  const read = (checkpointIds = [checkpoint.id], observationId = current.id) => {
    const put = vi.spyOn(store, 'put'), event = vi.spyOn(store, 'event'), request = vi.spyOn(store, 'recordRequest');
    try {
      const results = engine.checkpointRecoveryCandidates(sid, { observationId, checkpointIds });
      for (const result of results) {
        expect(result).toMatchObject({ checkpointVerified: false, executionAuthorized: false, currentExecution: false,
          coverageGranted: false, dispatchRevalidationRequired: true });
        expect(Array.isArray(result.blockers)).toBe(true); expect(Array.isArray(result.invalidatedBy)).toBe(true);
      }
      return results;
    } finally {
      expect(put).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
      expect(driver).not.toHaveBeenCalled(); put.mockRestore(); event.mockRestore(); request.mockRestore();
    }
  };
  const addRoute = (id = 'recorded-route') => {
    const attempt: ActionAttempt = { ...entry, id, requestId: `request-${id}`, action: action(current, `action-${id}`) };
    store.put('attempt', attempt);
    store.put('transition', { id: `transition-${id}`, sessionId: sid, from: current.stateId, to: source.stateId,
      attemptId: id, replayable: true } satisfies Transition);
    return attempt;
  };
  return { store, adapter, engine, current, source, session, currentAction, entry, checkpoint, read, addRoute };
}

it('reports no_known_path only after all supported strategies lack a candidate, without recording a failed recovery', () => {
  const f = fixture(), before = f.store.list('attempt', sid), result = f.read()[0];
  expect(result).toMatchObject({ checkpointId: f.checkpoint.id, sourceObservationId: f.source.id,
    currentObservationId: f.current.id, status: 'no_known_path' });
  expect(result.strategies.map(s => s.strategy)).toEqual(expect.arrayContaining([
    'verify_current', 'boundary_exit', 'observed_source_return', 'recorded_path', 'declared_local_restore',
    'reset_hook', 'configured_environment_reset', 'entry_replay',
  ]));
  expect(result.strategies.every(s => s.status === 'no_known_path')).toBe(true);
  expect(f.store.list('attempt', sid)).toEqual(before); expect(f.store.list('reach', sid)).toEqual([]);
});

it('treats an already matching observation only as a candidate for fresh verification', () => {
  const f = fixture({ current: { count: 1, canonical: 'count:1' } }), result = f.read()[0];
  expect(result.status).toBe('tryable');
  expect(result.strategies).toContainEqual(expect.objectContaining({ strategy: 'verify_current', status: 'tryable' }));
  expect(f.store.list('reach', sid)).toEqual([]);
});

it.each(['recorded_path', 'boundary_exit', 'observed_source_return', 'declared_local_restore'] as const)(
  'does not veto %s because the historical entry path is nonreplayable', strategy => {
    const f = fixture(strategy === 'boundary_exit' ? { current: { boundaries: [{ key: 'modal', name: 'Modal', region: 'machine', evidence: ['fixture'] }] } } : {});
    if (strategy === 'recorded_path') f.addRoute();
    if (strategy === 'boundary_exit') f.adapter.exit = { ...f.currentAction, boundary: { key: 'modal', intent: 'exit' } };
    if (strategy === 'observed_source_return') f.adapter.nativeReturn = f.currentAction;
    if (strategy === 'declared_local_restore') f.adapter.localRestore = { action: f.currentAction, expectedCanonical: f.source.canonical, evidence: ['Declared fixture inverse'] };
    const result = f.read()[0];
    expect(result.status).toBe('tryable');
    expect(result.strategies).toContainEqual(expect.objectContaining({ strategy, status: 'tryable' }));
    expect(result.strategies).toContainEqual(expect.objectContaining({ strategy: 'entry_replay', status: 'no_known_path' }));
  },
);

it('reassesses new graph evidence and withdrawn or restored permission at the same observation ID', () => {
  const f = fixture(); expect(f.read()[0].status).toBe('no_known_path');
  const route = f.addRoute(); expect(f.read()[0].status).toBe('tryable');
  f.store.put('action', { ...f.currentAction, replayable: false });
  expect(f.read()[0].status).toBe('no_known_path');
  f.store.put('action', f.currentAction); expect(f.read()[0].status).toBe('tryable');
  f.store.put('attempt', { ...route, action: { ...route.action, replayable: false } });
  expect(f.read()[0].status).toBe('no_known_path');
  expect(f.engine.observation(sid).id).toBe(f.current.id);
});

it.each(['checkpoint', 'source', 'current', 'stale-cursor'] as const)('keeps unavailable %s evidence unknown instead of proving no path', missing => {
  const f = fixture();
  if (missing === 'source') f.store.put('checkpoint', { ...f.checkpoint, observationId: 'missing-source' });
  if (missing === 'stale-cursor') f.store.put('session', { ...f.session, currentObservationId: f.source.id });
  const result = f.read(missing === 'checkpoint' ? ['missing-checkpoint'] : undefined, missing === 'current' ? 'missing-current' : undefined)[0];
  expect(result.status).toBe('unknown');
});

it.each(['unknown', 'executing'] as const)('does not hide or settle %s execution debt behind an available graph route', status => {
  const f = fixture(); f.addRoute();
  f.store.put('attempt', { ...f.entry, id: 'unsettled', requestId: 'unsettled-request', status });
  const before = f.store.require<ActionAttempt>('attempt', 'unsettled');
  expect(f.read()[0].status).toBe('unknown');
  expect(f.store.require('attempt', 'unsettled')).toEqual(before);
});

it.each(['verify', 'accept', 'reset'] as const)('leaves the %s hook indeterminate without invoking it', kind => {
  const hook = vi.fn(() => { throw new Error('Candidate query must not execute hooks'); });
  const f = fixture({ hooks: { [kind]: hook }, dirty: kind === 'reset' });
  expect(f.read()[0].status).toBe('unknown'); expect(hook).not.toHaveBeenCalled();
});

it('does not treat a missing adapter capability as a complete negative strategy proof', () => {
  const f = fixture(); Object.defineProperty(f.adapter, 'restorationStep', { value: undefined });
  expect(f.read()[0].status).toBe('unknown');
});

it('shares current actions and a graph refresh across eight ordered candidates and enforces the batch bound', () => {
  const f = fixture(); f.addRoute();
  const ids = Array.from({ length: 8 }, (_, index) => `checkpoint-${7 - index}`);
  for (const id of ids) f.store.put('checkpoint', { ...f.checkpoint, id });
  const actions = vi.spyOn(f.engine, 'actions'), refresh = vi.spyOn(NavigationIndex.prototype, 'refresh');
  const results = f.read(ids);
  expect(results.map(result => result.checkpointId)).toEqual(ids);
  expect(results.every(result => result.status === 'tryable')).toBe(true);
  expect(actions).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
  actions.mockClear(); refresh.mockClear(); expect(f.read([])).toEqual([]);
  expect(actions).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  expect(() => f.read([...ids, 'ninth'])).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
  expect(() => f.read(ids, '')).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
});
