import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ActionCandidate, Checkpoint, Observation } from '@interaction/browser';
import { ExplorerPlugin, type ExplorerHost, type ExplorerStore, type PlanItem, type Scope } from '@interaction/explorer-plugin';
import { recordRouteRetry } from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import { keyFor, scopeFor } from '../packages/explorer-plugin/src/policy.js';

// Only the step integration case enters review. Its independent review and
// ledger projections are outside this scan/dispatch cancellation contract.
vi.mock('../packages/explorer-plugin/src/reviews.js', () => ({ reviewNext: async () => false }));

type Assessment = ReturnType<NonNullable<ExplorerHost['checkpointRecoveryCandidates']>>[number];
type Control = Observation['controls'][number];
type StepSnapshot = Pick<ReturnType<ExplorerHost['explorationSnapshot']>, 'actions' | 'operationCandidates' | 'availability'>;
const url = 'https://recovery-selection.fixture.invalid/source';
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
function observation(id: string, withTarget = true): Observation {
  const control = { localId: `${id}:target`, instanceId: `${id}:target`, identityId: `identity-${id}`, identityScope: 'semantic',
    stableKey: 'id:remaining', tag: 'div', role: 'generic', name: 'Remaining', label: 'Remaining', region: 'region',
    visible: true, enabled: true, actions: [], constraints: { type: 'div', required: false, valid: true }, selected: [],
    actionable: { hitTarget: true, unknown: [] } } as unknown as Control;
  return { id, sessionId: 'session', documentId: `document-${id}`, instanceScope: `document-${id}`, url,
    ruleVersion: 'observable-v7', context: {}, stable: true, gaps: [], controls: withTarget ? [control] : [],
    regions: [{ key: 'region', label: 'Main menu', role: 'navigation' }], boundaries: [], overlays: [], components: [],
    canonical: id, stateId: `state-${id}` } as unknown as Observation;
}
function item(id: string, scope: Scope, sources: Observation[]): PlanItem {
  return { id, title: id, scope, prerequisites: [], completion: 'Review retained scope', status: 'unresolved', required: true,
    dispatchScope: false, reason: 'region_review_required', evidence: [...sources].reverse().map(source => ({
      sessionId: source.sessionId, observationId: source.id,
    })), attempts: [] };
}

// Exercise the production selector with recorded facts only. This fixture has
// no engine, browser, provider or database; selection itself must never dispatch.
function fixture(count = 64) {
  const sources = Array.from({ length: count }, (_,index) => observation(`source-${index + 1}`)), current = observation('current', false);
  const frames = new Map([...sources, current].map(source => [source.id, source]));
  const sourceActions = new Map<string, ActionCandidate[]>();
  let active = current, readinessRevision = 'ready-v1', onRead: ((id: string) => void) | undefined;
  const checkpoints: Checkpoint[] = sources.map(source => ({ id: `checkpoint-${source.id}`, sessionId: source.sessionId,
    name: 'Retained source', observationId: source.id, stateId: source.stateId, context: source.context, predicates: [],
    acceptable: [], path: [], createdAt: '2026-10-17T00:00:00.000Z' }));
  const statuses = new Map(checkpoints.map(checkpoint => [checkpoint.id, 'no_known_path' as Assessment['status']]));
  const assess = vi.fn((_sid: string, input: { observationId: string; checkpointIds: string[] }): Assessment[] =>
    input.checkpointIds.map(checkpointId => ({ checkpointId, sourceObservationId: checkpoints.find(row => row.id === checkpointId)!.observationId,
      currentObservationId: input.observationId, status: statuses.get(checkpointId)!, strategies: [], blockers: [], invalidatedBy: [],
      checkpointVerified: false, executionAuthorized: false, currentExecution: false, coverageGranted: false, dispatchRevalidationRequired: true })));
  const sourceReads: string[] = [];
  const material = vi.fn((_sid: string, input: { sourceObservationId: string; currentObservationId: string }) => {
    sourceReads.push(input.sourceObservationId); onRead?.(input.sourceObservationId);
    const source = frames.get(input.sourceObservationId); if (!source) throw Error('Source is no longer available');
    return { source, actions: sourceActions.get(source.id) || [], transition: { beforeId: source.id, afterId: current.id, verified: true,
      documentChanged: true, navigated: false, retainedControls: [], entered: [], exited: [], revealedControlIds: [] } };
  });
  const effect = () => vi.fn(async () => { throw Error('Selection must not dispatch'); });
  const host = { events: new EventEmitter(), session: () => ({ id: 'session', options: {}, actionCount: 0, currentObservationId: active.id }),
    observation: vi.fn((_sid: string, id?: string) => { const observed = id ? frames.get(id) : active;
      if (!observed) throw Error('Current observation is unavailable'); return observed; }), actions: vi.fn(() => []),
    actionAvailability: () => ({ sessionId: 'session', observationId: active.id, revision: readinessRevision, profile: 'interface-exploration',
      actions: [], dispatchRevalidationRequired: true }), list: vi.fn((_sid: string, kind: string) => kind === 'checkpoint' ? checkpoints : []),
    recoverySourceMaterial: material, interactionTransition: () => ({ retainedControls: [] }), recoveryAssessment: () => ({ unknownAttempts: [] }),
    checkpointRecoveryCandidates: assess, createCheckpoint: effect(), reachCheckpoint: effect(), reachExplorationTarget: effect(), execute: effect(),
  } as unknown as ExplorerHost;
  const events: { type: string; data: unknown; observationId?: string }[] = [];
  const store = { save: vi.fn(), close: () => {}, decisionCursor: () => 0, decisions: () => [],
    event: (event: typeof events[number]) => { events.push(event); return event; } } as unknown as ExplorerStore;
  const plugin = new ExplorerPlugin(host, store), task = plugin.create({ url, coverageMode: 'all' });
  const review = item('review', { url, region: 'Main menu', label: 'Remaining', role: 'generic', stableKey: 'id:remaining' }, sources);
  const authority = { ...item('authority', { url }, sources), dispatchScope: true, status: 'pending' as const, reason: 'accepted scope' };
  const unknown = { ...item('old-unknown', { url, label: 'Earlier uncertain operation', kind: 'click' }, sources.slice(0, 1)),
    status: 'blocked' as const, reason: 'unknown_action_outcome' };
  task.plan = [authority, review, unknown]; task.status = 'running';
  task.rounds = [{ id: 'round', number: 1, sessionId: 'session', startedAt: '2026-10-17T00:00:00.000Z', status: 'running',
    actions: 0, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 }];
  task.routeRetries = recordRouteRetry(undefined, { routeKey: 'old-failure', conditionVersion: 'old-condition', outcome: 'unreachable', reason: 'Retained failure' });
  task.routeRetries = recordRouteRetry(task.routeRetries, { routeKey: 'old-unknown', conditionVersion: 'old-condition', outcome: 'unknown', reason: 'Retained unknown',
    unknownSource: { sessionId: 'old-session', attemptIds: ['old-attempt'] } });
  task.scheduling = { version: 1, localSelections: 4, legacyUnmappedRouteKeys: [], routes: Object.fromEntries(['old-failure', 'old-unknown'].map(key => [key, {
    sessionId: 'old-session', observationId: 'old-source', checkpointId: 'old-checkpoint', targets: [{ url, label: key }], path: [],
    itemIds: [key], memberKeys: [key], pathKeys: [],
  }])) };
  const runtime = plugin as any;
  const select = (signal = new AbortController().signal) => runtime.scheduledRecovery(task, task.rounds[0], current, [],
    host.actionAvailability('session', current.id), runtime.routeConditionReader(current, []), signal);
  const noDispatch = () => { expect(host.createCheckpoint).not.toHaveBeenCalled(); expect(host.reachCheckpoint).not.toHaveBeenCalled(); expect(host.reachExplorationTarget).not.toHaveBeenCalled(); expect(host.execute).not.toHaveBeenCalled(); };
  const retained = () => structuredClone({ plan: task.plan, debt: task.routeRetries });
  const noCompletion = () => {
    expect(task.status).toBe('running'); expect(events.some(event => /^(recovery\.|action\.|task\.completed)/.test(event.type))).toBe(false);
    expect(task.scheduling?.deferred?.review?.reason).not.toBe('checkpoint_no_known_path');
  };
  return { sources, current, frames, sourceActions, checkpoints, statuses, assess, material, sourceReads, host, task, review, authority, events, runtime, select,
    noDispatch, retained, noCompletion, onRead: (callback: (id: string) => void) => { onRead = callback; },
    changeCurrent: () => { active = observation('changed-current', false); }, changeReadiness: () => { readinessRevision = 'ready-v2'; },
    changeSameIdFacts: () => { current.context = { mode: { status: 'known', value: 'changed', source: 'fixture' } }; }, close: () => plugin.close() };
}

it('allows a timer to cancel a large pending scan without losing old plan or failure/unknown debt', async () => {
  const f = fixture(1), controller = new AbortController(); let fired = false;
  f.task.plan.splice(1, 1, ...Array.from({ length: 4096 }, (_,index) => ({ ...structuredClone(f.review), id: `pending-${index}` })));
  const retained = f.retained(), timer = setTimeout(() => { fired = true; controller.abort(); }, 0);
  try {
    await expect(f.select(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fired).toBe(true); expect(f.host.list).not.toHaveBeenCalled(); expect(f.material).not.toHaveBeenCalled(); expect(f.assess).not.toHaveBeenCalled();
    expect(f.retained()).toEqual(retained); f.noDispatch(); f.noCompletion();
  } finally { clearTimeout(timer); await f.close(); }
});

it('the real step awaits selection cancellation and does not fall through to an admissible local action or recovery', async () => {
  const f = fixture(), controller = new AbortController(); let scheduled: ReturnType<typeof setImmediate> | undefined, stoppedAt = -1;
  const control = { ...observation('local').controls[0], name: 'Local', label: 'Local', tag: 'button', role: 'button', actions: ['click'],
    constraints: { type: 'button', required: false, valid: true } } as Control;
  f.current.controls.push(control);
  const action = { id: 'local-action', sessionId: 'session', observationId: f.current.id, stateId: f.current.stateId, localId: control.localId,
    controlId: control.identityId, kind: 'click', label: 'Local', risk: 'interface', replayable: true, source: 'control', sampleValidity: 'known', excluded: false,
    basis: { status: 'supported', evidence: [{ source: 'html', rule: 'native-button/v1', facts: { type: 'button' } }] },
    preconditions: { visible: true, enabled: true, identityResolved: true, context: f.current.context } } as unknown as ActionCandidate;
  f.task.plan.push({ ...item('local', scopeFor(action, f.current), [f.current]), dispatchScope: true, status: 'pending',
    reason: 'accepted scope', operationConditionKey: keyFor(action, f.current) });
  vi.mocked(f.host.observation).mockImplementation(() => f.current);
  vi.mocked(f.host.actions).mockImplementation(() => [action]);
  f.host.boundaryState = () => ({ observationId: f.current.id, verified: false, active: undefined });
  const availability = { sessionId: 'session', observationId: f.current.id, revision: 'ready-v1', profile: 'interface-exploration',
    actions: [{ actionId: action.id, executable: true, blockers: [] }], dispatchRevalidationRequired: true } as ReturnType<ExplorerHost['actionAvailability']>;
  f.host.actionAvailability = () => availability;
  // The real step consumes these typed facts; independent audit projections are
  // isolated below, so this deliberately partial SDK stub is explicit.
  f.host.explorationSnapshot = ((): StepSnapshot => ({ actions: [action], operationCandidates: [action], availability })) as unknown as ExplorerHost['explorationSnapshot'];
  f.runtime.retainHostLimitations = f.runtime.reconcileReviewLedger = f.runtime.applyReviewRecoveryChanges = async () => {};
  f.runtime.auditRemainingScopes = f.runtime.updateObligations = () => {};
  const retained = f.retained();
  f.onRead(() => { if (!scheduled) scheduled = setImmediate(() => { stoppedAt = f.sourceReads.length; controller.abort(); }); });
  try {
    await expect(f.runtime.step(f.task, f.task.rounds[0], controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stoppedAt).toBeGreaterThan(0); expect(stoppedAt).toBeLessThan(f.sources.length);
    await immediate(); expect(f.sourceReads).toHaveLength(stoppedAt);
    expect(f.events.some(event => event.type === 'obligation.selected')).toBe(false);
    expect(f.retained()).toEqual(retained); f.noDispatch(); f.noCompletion();
  } finally { if (scheduled) clearImmediate(scheduled); await f.close(); }
});

it('the real step rejects a source revoked in the short selector return microtask before recording or dispatching recovery', async () => {
  const f = fixture(1); let queued = false, revoked = false;
  f.statuses.set(f.checkpoints[0].id, 'tryable');
  f.host.boundaryState = () => ({ observationId: f.current.id, verified: false, active: undefined });
  // As above, only the step's real fact inputs are provided by this stub.
  f.host.explorationSnapshot = ((): StepSnapshot => ({ actions: [], operationCandidates: [],
    availability: f.host.actionAvailability('session', f.current.id) })) as unknown as ExplorerHost['explorationSnapshot'];
  f.runtime.retainHostLimitations = f.runtime.reconcileReviewLedger = f.runtime.applyReviewRecoveryChanges = async () => {};
  f.runtime.auditRemainingScopes = f.runtime.updateObligations = () => {};
  const retained = f.retained();
  f.onRead(() => { if (!queued) {
    queued = true;
    queueMicrotask(() => { revoked = true; f.frames.delete(f.sources[0].id); });
  } });
  try {
    await expect(f.runtime.step(f.task, f.task.rounds[0], new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_DECISION' });
    expect(revoked).toBe(true);
    expect(f.events.some(event => event.type === 'obligation.selected')).toBe(false);
    expect(f.retained()).toEqual(retained); f.noDispatch(); f.noCompletion();
  } finally { await f.close(); }
});

it.each(['anchor', 'source'] as const)('allows setImmediate cancellation during the %s scan and reads no next candidate after cancellation', async stage => {
  const f = fixture(), controller = new AbortController(); let stop: ReturnType<typeof setImmediate> | undefined;
  if (stage === 'anchor') f.review.reason = 'classification_unresolved';
  const retained = f.retained(); let stoppedAt: { sources: number; batches: number } | undefined;
  f.onRead(() => { if (stop) return; stop = setImmediate(() => { stoppedAt = { sources: f.sourceReads.length, batches: f.assess.mock.calls.length }; controller.abort(); }); });
  try {
    await expect(f.select(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stoppedAt).toBeDefined(); expect(stoppedAt!.sources).toBeGreaterThan(0); expect(stoppedAt!.sources).toBeLessThan(f.sources.length);
    await immediate(); expect(f.sourceReads).toHaveLength(stoppedAt!.sources); expect(f.assess).toHaveBeenCalledTimes(stoppedAt!.batches);
    if (stage === 'anchor') expect(f.assess).not.toHaveBeenCalled();
    expect(f.retained()).toEqual(retained); f.noDispatch(); f.noCompletion();
  } finally { if (stop) clearImmediate(stop); await f.close(); }
});

it.each(['revision', 'current observation', 'same-ID context', 'readiness'] as const)('rejects changed %s facts after a real yield instead of calling the source unreachable', async change => {
  const f = fixture(); let scheduled: ReturnType<typeof setImmediate> | undefined, stoppedAt = -1;
  const retained = f.retained();
  f.onRead(() => { if (scheduled) return; scheduled = setImmediate(() => {
    stoppedAt = f.sourceReads.length;
    if (change === 'revision') f.task.revision++; else if (change === 'current observation') f.changeCurrent();
    else if (change === 'same-ID context') f.changeSameIdFacts(); else f.changeReadiness();
  }); });
  try {
    await expect(f.select()).rejects.toMatchObject({ code: change === 'revision' ? 'CANCELLED' : 'STALE_DECISION' });
    expect(stoppedAt).toBeGreaterThan(0); expect(stoppedAt).toBeLessThan(f.sources.length);
    await immediate(); expect(f.sourceReads).toHaveLength(stoppedAt); expect(f.retained()).toEqual(retained); f.noDispatch(); f.noCompletion();
  } finally { if (scheduled) clearImmediate(scheduled); await f.close(); }
});

it('retains ordered selection across more than eight candidates and reaches the last legal candidate without dispatch', async () => {
  const f = fixture(19); let yielded = false, scheduled: ReturnType<typeof setImmediate> | undefined;
  const retained = f.retained(); f.statuses.set(f.checkpoints.at(-1)!.id, 'tryable');
  f.onRead(() => { if (!scheduled) scheduled = setImmediate(() => { yielded = true; }); });
  try {
    expect(await f.select()).toMatchObject({ itemId: 'review', source: { id: f.sources.at(-1)!.id }, frame: { checkpointId: f.checkpoints.at(-1)!.id },
      targetActionIds: [], returnToSource: false });
    expect(yielded).toBe(true);
    expect(f.assess.mock.calls.map(call => call[1].checkpointIds)).toEqual([
      f.checkpoints.slice(0, 8).map(row => row.id), f.checkpoints.slice(8, 16).map(row => row.id), f.checkpoints.slice(16).map(row => row.id),
    ]);
    expect(f.retained()).toEqual(retained); expect(f.host.observation).toHaveBeenCalled(); f.noDispatch(); f.noCompletion();
  } finally { if (scheduled) clearImmediate(scheduled); await f.close(); }
});

it.each(['unchanged', 'source missing', 'actions changed'] as const)('revalidates the review fallback across the later page scan yield: %s', async change => {
  const f = fixture(19); let scheduled: ReturnType<typeof setImmediate> | undefined, yielded = false;
  f.review.reason = 'classification_unresolved'; f.review.evidence = [{ sessionId: 'session', observationId: f.sources[0].id }];
  f.authority.evidence = []; f.current.url = 'https://recovery-selection.fixture.invalid/away';
  f.current.navigation = { browserSessionId: 'current-browser', currentIndex: 1,
    entries: [{ id: 1, url, method: 'GET' }, { id: 2, url: f.current.url, method: 'GET' }] };
  f.sources[0].navigation = { browserSessionId: 'old-browser', currentIndex: 0, entries: [{ id: 1, url, method: 'GET' }] };
  f.statuses.set(f.checkpoints[0].id, 'tryable');
  f.host.returnToObservedSource = vi.fn(async () => { throw Error('Selection must not return to source'); });
  // This isolated fallback case has no unresolved global unknown, which would
  // correctly block the page-return branch before it can test a yield boundary.
  delete f.task.routeRetries!.routes['old-unknown']; f.task.plan = f.task.plan.filter(row => row.id !== 'old-unknown');
  const retained = f.retained();
  f.onRead(id => { if (id === f.sources[0].id && !scheduled) scheduled = setImmediate(() => {
    yielded = true;
    if (change === 'source missing') f.frames.delete(f.sources[0].id);
    if (change === 'actions changed') {
      const source = f.sources[0], control = source.controls[0];
      f.sourceActions.set(source.id, [{ id: 'changed-source-action', sessionId: source.sessionId, observationId: source.id, stateId: source.stateId,
        localId: control.localId, controlId: control.identityId, kind: 'click', label: 'Remaining', risk: 'interface', replayable: false, source: 'control',
        sampleValidity: 'known', excluded: false, basis: { status: 'supported', evidence: [] },
        preconditions: { visible: true, enabled: true, identityResolved: true, context: source.context } } as ActionCandidate]);
    }
  }); });
  try {
    if (change === 'unchanged') {
      expect(await f.select()).toMatchObject({ itemId: 'review', source: { id: f.sources[0].id }, frame: { checkpointId: f.checkpoints[0].id },
        targetActionIds: [], returnToSource: false });
      expect(f.assess.mock.calls.filter(call => call[1].checkpointIds.includes(f.checkpoints[0].id)).length).toBeGreaterThanOrEqual(2);
    } else {
      await expect(f.select()).rejects.toMatchObject({ code: 'STALE_DECISION' });
      expect(Object.values(f.task.scheduling!.routes).every(route => route.observationId !== f.sources[0].id)).toBe(true);
    }
    expect(yielded).toBe(true); expect(f.retained()).toEqual(retained);
    expect(f.host.returnToObservedSource).not.toHaveBeenCalled(); f.noDispatch(); f.noCompletion();
  } finally { if (scheduled) clearImmediate(scheduled); await f.close(); }
});
