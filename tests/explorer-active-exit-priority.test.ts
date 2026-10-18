const localSelectionLimit=4; // Historical saved metadata; the strategy must ignore it.
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { exitCandidateKey, type ActionAttempt, type ActionCandidate, type BoundaryExitCandidate, type Observation } from '@interaction/browser';
import { ExplorerPlugin, type ExplorerHost, ExplorerStore, type PlanItem, type Round, type Scope, type Task } from '@interaction/explorer-plugin';
import { type ObligationSelection } from '../packages/explorer-plugin/src/obligation-scheduler.js';

// Review decisions are outside this scheduling regression. All candidate
// availability, uniqueness, freshness, scope and run-entry unknown gates below
// are the real runtime code; only an in-memory task store is constructed.
// No browser or SDK engine is constructed.
vi.mock('../packages/explorer-plugin/src/reviews.js', () => ({ reviewNext: async () => false }));

const url = 'https://active-exit.fixture.invalid/';
const selected = new Error('Stop at scheduling event, before host effects');
type Control = Observation['controls'][number];
function item(id: string, scope: Scope): PlanItem {
  return { id, title: id, scope, prerequisites: [], completion: 'Actual execution', required: true, dispatchScope: true,
    status: 'pending', reason: 'accepted scope', evidence: [], attempts: [] };
}

function fixture() {
  const observation = { id: 'current', sessionId: 'current-session', documentId: 'document', instanceScope: 'document', url,
    ruleVersion: 'observable-v7', context: { account: { status: 'known', value: 'anonymous', source: 'fixture' } }, stable: true,
    gaps: [], controls: [], regions: [], boundaries: [{ key: 'modal', name: 'Modal', region: 'modal', evidence: ['fixture'] }],
    overlays: [{ key: 'modal', name: 'Modal', kind: 'modal', selector: '#modal', parentRegion: 'document', evidence: ['fixture'], controlIds: [], exitControlIds: [] }],
    components: [], canonical: 'current', stateId: 'current-state' } as unknown as Observation;
  let actions: ActionCandidate[] = [];
  const blocked = new Set<string>(), events: { type: string; data: unknown }[] = [], attempts = new Map<string, ActionAttempt[]>();
  const effect = () => vi.fn(async () => { throw Error('Scheduling fixture forbids host effects'); });
  const availability = () => ({ observationId: observation.id, revision: 'fixture-availability',
    actions: actions.map(a => ({ actionId: a.id, executable: !blocked.has(a.id), blockers: blocked.has(a.id)
      ? [{ code: 'UNKNOWN_DISPATCH_REQUIRES_REVIEW', reason: 'Unknown result' }] : [] })) });
  const host = { events: new EventEmitter(), session: () => ({ actionCount: 0, options: {} }), observation: () => observation,
    actions: () => actions, list: (sid: string, kind: string) => kind === 'attempt' ? attempts.get(sid) || [] : [],
    boundaryState: () => ({ verified: false }), recoveryAssessment: (sid: string) => ({ observationId: observation.id,
      unknownAttempts: (attempts.get(sid) || []).filter(a => a.status === 'unknown') }),
    actionAvailability: availability,
    controlInterpretationSnapshot:()=>({actions,classifications:{controls:[]},operations:{controls:[]},nonInteractive:[],retainedClassifications:[]}),
    regionReviewMaterial:()=>({enabled:false}),explorationReviewMaterial:()=>({groups:[]}),
    explorationSnapshot: () => ({ actions, operationCandidates: actions, availability: availability() }),
    createCheckpoint: effect(), reachCheckpoint: effect(), reachExplorationTarget: effect(), returnToObservedSource: effect(),
    execute: effect(), observe: effect(), createSession: effect() } as unknown as ExplorerHost;
  const persistence=new ExplorerStore(':memory:');
  const store = Object.assign(persistence,{ save: vi.fn(persistence.save.bind(persistence)), decisionCursor: () => 0, decisions: () => [],
    event: (event: { type: string; data: unknown }) => { events.push(event); if (event.type === 'obligation.selected') throw selected; } }) as unknown as ExplorerStore;
  const plugin = new ExplorerPlugin(host, store), task = plugin.create({ url, coverageMode: 'all' });
  task.status = 'running';
  const round: Round = { id: 'round', number: 1, sessionId: observation.sessionId, startedAt: new Date().toISOString(), status: 'running',
    actions: 0, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 };
  task.rounds = [round]; task.plan = [item('remote', { url, kind: 'click', label: 'Remote' })];
  task.scheduling = { version: 1, localSelections: localSelectionLimit, routes: {}, legacyUnmappedRouteKeys: [] };
  // Isolate review/ledger projection and retained route discovery. The remote
  // selector's existence models an admissible strict route; no route is executed.
  const runtime = plugin as unknown as {
    step(task: Task, round: Round, signal: AbortSignal): Promise<boolean>;
    run(task: Task, signal: AbortSignal): Promise<void>;
    attemptKey(round: Round, action: ActionCandidate, observation: Observation): string;
    retainHostLimitations: (...args: unknown[]) => Promise<void>;
    reconcileReviewLedger: (...args: unknown[]) => Promise<void>;
    applyReviewRecoveryChanges: (...args: unknown[]) => Promise<void>;
    auditRemainingScopes: (...args: unknown[]) => void;
    updateObligations: (...args: unknown[]) => void;
    normalizeScheduling: (...args: unknown[]) => boolean;
    gap: (...args: unknown[]) => PlanItem;
    scheduledRecovery: (...args: unknown[]) => { itemId: string; source: Observation; routeKey: string; revalidate: () => void };
  };
  runtime.retainHostLimitations = runtime.reconcileReviewLedger = runtime.applyReviewRecoveryChanges = async () => {};
  runtime.auditRemainingScopes = runtime.updateObligations = () => {};
  runtime.normalizeScheduling = () => false;
  runtime.gap = () => item('fixture-gap', { url });
  const remoteRevalidate = vi.fn();
  const remote = vi.spyOn(runtime, 'scheduledRecovery').mockReturnValue({ itemId: 'remote', source: { ...observation, id: 'retained' }, routeKey: 'strict-route', revalidate: remoteRevalidate });
  function add(label: string, exit = false) {
    const control = { localId: label, identityId: `identity-${label}`, instanceId: `instance-${label}`, identityScope: 'semantic',
      tag: 'button', role: 'button', name: label, label, visible: true, enabled: true, actions: ['click'], selected: [],
      constraints: { type: 'button', required: false, valid: true }, actionable: { hitTarget: true, unknown: [] } } as unknown as Control;
    observation.controls.push(control);
    observation.overlays!.at(-1)!.controlIds.push(control.localId);
    if (exit) observation.overlays!.at(-1)!.exitControlIds.push(control.localId);
    const action = { id: `action-${label}`, sessionId: observation.sessionId, observationId: observation.id, stateId: observation.stateId,
      localId: control.localId, controlId: control.identityId, kind: 'click', label, risk: 'interface', replayable: true, source: 'control',
      sampleValidity: 'valid', excluded: false, basis: { status: 'supported', evidence: [{ source: 'html', rule: 'native-button/v1', facts: { type: 'button' } }] },
      preconditions: { visible: true, enabled: true, identityResolved: true, context: observation.context },
      ...(exit ? { boundary: { key: 'modal', intent: 'exit' } } : {}) } as unknown as ActionCandidate;
    actions.push(action); task.plan.push(item(label, { url, kind: 'click', label })); return action;
  }
  async function select() {
    const revalidationsBefore = remoteRevalidate.mock.calls.length;
    const cursor=events.length;
    try{await runtime.step(task, round, new AbortController().signal);}catch(error){expect(error).toBe(selected);}
    const choice = events.slice(cursor).filter(e => e.type === 'obligation.selected').at(-1)?.data as ObligationSelection|undefined;
    expect(remoteRevalidate.mock.calls.length - revalidationsBefore).toBe(Number(choice?.kind === 'recovery' || choice?.kind === 'inspect'));
    return choice;
  }
  function noEffects() {
    for (const name of ['createCheckpoint', 'reachCheckpoint', 'reachExplorationTarget', 'returnToObservedSource', 'execute', 'observe', 'createSession'] as const)
      expect(host[name]).not.toHaveBeenCalled();
  }
  return { plugin, task, round, observation, blocked, attempts, events, host, runtime, remote, add, select, noEffects,
    replaceActions: (next: ActionCandidate[]) => { actions = next; } };
}

it('uses an admissible active boundary exit before a remote turn at the local limit, then rebuilds ordinary scheduling', async () => {
  const f = fixture(); try {
    const close = f.add('Close', true);
    expect(await f.select()).toMatchObject({ kind: 'current', actionId: close.id });
    expect(f.remote).not.toHaveBeenCalled(); expect(f.task.scheduling!.localSelections).toBe(localSelectionLimit);
    // A separate observed frame supplies the next candidates; selection itself
    // grants neither successful exit nor coverage and does not reset fairness.
    f.observation.boundaries = []; f.observation.id = 'after-exit';
    const work = f.add('Work'); f.replaceActions([work]);
    expect(await f.select()).toMatchObject({ kind: 'current', actionId:work.id });
    expect(f.remote).not.toHaveBeenCalled(); f.noEffects();
    expect(f.task.plan.every(row => row.status === 'pending' && !row.resolvedBy)).toBe(true);
  } finally { await f.plugin.close(); }
});

it.each(['no active boundary', 'different boundary', 'missing overlay', 'mismatched overlay', 'nonmember', 'blocked', 'nonexit', 'duplicate', 'already tried', 'excluded'] as const)(
  'keeps SDK availability separate from old exit quota priority for %s candidates', async variant => {
    const f = fixture(); try {
      const close = f.add('Close', variant !== 'nonexit');
      if (variant === 'no active boundary') f.observation.boundaries = [];
      if (variant === 'different boundary') close.boundary!.key = 'old-modal';
      if (variant === 'missing overlay') f.observation.overlays = [];
      if (variant === 'mismatched overlay') f.observation.overlays!.at(-1)!.key = 'other-modal';
      if (variant === 'nonmember') { f.observation.overlays!.at(-1)!.controlIds = []; f.observation.overlays!.at(-1)!.exitControlIds = []; }
      if (variant === 'blocked') f.blocked.add(close.id);
      if (variant === 'duplicate') f.replaceActions([close, { ...close, id: 'duplicate-close' }]);
      if (variant === 'already tried') f.round.tried.push(f.runtime.attemptKey(f.round, close, f.observation));
      if (variant === 'excluded') f.task.plan.push({ ...item('user-exclusion', { url, kind: 'click', label: 'Close' }), required: false, status: 'excluded', reason: 'user_excluded' });
      if(['blocked','duplicate','already tried','excluded'].includes(variant))expect(await f.select()).toBeUndefined();
      else expect(await f.select()).toMatchObject({kind:'current',actionId:close.id});
      expect(f.remote).not.toHaveBeenCalled();f.noEffects();
    } finally { await f.plugin.close(); }
  });

it.each(['Escape', 'reviewed dismissal'] as const)('keeps the existing control-free %s exit eligible for priority', async variant => {
  const f = fixture(); try {
    const close = f.add('Close', true); delete close.localId; delete close.controlId;
    if (variant === 'Escape') { close.kind = 'press'; close.value = 'Escape'; }
    else {
      const candidate: BoundaryExitCandidate = { id: 'outside', kind: 'outside-click', boundaryKey: 'modal', boundaryInstanceId: 'modal-instance',
        selector: '#outside', instanceId: 'outside-instance', parentInstanceId: 'body-instance', tag: 'div', text: '', attributes: {},
        rect: { x: 0, y: 0, width: 100, height: 100 }, point: { x: 1, y: 1 }, viewport: { width: 100, height: 100 },
        boundaryRect: { x: 10, y: 10, width: 50, height: 50 }, scroll: { x: 0, y: 0 }, boundaryStack: [], evidence: ['fixture'] };
      f.observation.boundaryExitCandidates = [candidate]; close.kind = 'dismiss'; close.value = candidate.id;
      close.source = 'boundary-exit-review'; close.replayable = false;
      close.basis = { status: 'supported', evidence: [{ source: 'fixture', rule: 'reviewed-boundary-dismissal/v1', facts: {
        candidateId: candidate.id, documentId: f.observation.documentId, url, observationId: f.observation.id, boundaryKey: 'modal',
        binding: exitCandidateKey(candidate), reviewId: 'review' } }] };
    }
    f.task.plan.find(row => row.id === 'Close')!.scope.kind = close.kind;
    expect(await f.select()).toMatchObject({ kind: 'current', actionId: close.id });
    expect(f.remote).not.toHaveBeenCalled(); f.noEffects();
  } finally { await f.plugin.close(); }
});

it.each([0, localSelectionLimit])('keeps fresh in-place work ahead of exits regardless of obsolete saved count %i', async count => {
  const f = fixture(); try {
    f.add('Close', true); const work = f.add('Work'); f.task.scheduling!.localSelections = count;
    expect(await f.select()).toMatchObject({ kind: 'current', actionId: work.id });
    expect(f.remote).not.toHaveBeenCalled(); f.noEffects();
  } finally { await f.plugin.close(); }
});

it('blocks retained unknown recovery outcomes before selecting a ready current exit after restart', async () => {
  const f = fixture(); try {
    f.add('Close', true);
    f.attempts.set('old-session', [{ id: 'old-unknown', sessionId: 'old-session', status: 'unknown' } as ActionAttempt]);
    f.task.unverifiedRecoveries = [{ sessionId: 'old-session', observationId: 'old-observation', attemptIds: ['old-unknown'] }];
    await f.runtime.run(f.task, new AbortController().signal);
    expect(f.task).toMatchObject({ status: 'blocked', reason: 'UNKNOWN_DISPATCH_REQUIRES_REVIEW',
      unverifiedRecoveries: [{ sessionId: 'old-session', attemptIds: ['old-unknown'] }] });
    expect(f.events.some(e => e.type === 'obligation.selected')).toBe(false); expect(f.remote).not.toHaveBeenCalled(); f.noEffects();
    expect(f.attempts.get('old-session')![0].status).toBe('unknown');
  } finally { await f.plugin.close(); }
});
