import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ActionAttempt, ActionCandidate, Observation } from '@interaction/browser';
import { ExplorerPlugin, type Decision, type ExplorerHost, type ExplorerStore, type PlanItem, type Round, type Scope, type Task } from '@interaction/explorer-plugin';
import { localSelectionLimit, type ObligationSelection } from '../packages/explorer-plugin/src/obligation-scheduler.js';
import { recordRouteRetry } from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import { digest, keyFor, scopeFor, schedulingKeyFor } from '../packages/explorer-plugin/src/policy.js';

const url = 'https://review-handoff.fixture.invalid/';
const remoteSelected = new Error('Remote selected; stop before reservation or browser effects');
const localSelected = new Error('Local selected; stop before browser effects');
type Control = Observation['controls'][number];
type Event = { type: string; data: unknown };

function item(id: string, scope: Scope, dispatchScope = true): PlanItem {
  return { id, title: id, scope, dispatchScope, required: true, status: 'pending', reason: 'accepted scope',
    prerequisites: [], completion: 'Retain observed work', evidence: [], attempts: [] };
}

// Real runtime.step, reviewNext, scope/availability checks, guarded apply and
// fairness selection. Only independent audit projections, durable persistence,
// retained route discovery and model answers are substituted. No provider, SDK
// engine, browser, database or server is created; all navigation is forbidden.
function fixture(count = localSelectionLimit, continueDispatch = false) {
  const control = (id: string, role: string, label: string): Control => ({ localId: id, instanceId: `instance-${id}`,
    identityId: `identity-${id}`, identityScope: 'semantic', stableKey: `id:${id}`, tag: role === 'button' ? 'button' : 'div',
    role, name: label, label, region: 'modal', form: '', selector: `#${id}`, visible: true, enabled: true, editable: false,
    value: '', displayedText: label, checked: null, selected: [], expanded: null, actions: role === 'button' ? ['click'] : [],
    actionBasis: role === 'button' ? { click: { status: 'supported', evidence: [{ source: 'html', rule: 'native-button/v1', facts: { type: 'button' } }] } } : {},
    constraints: { type: role === 'button' ? 'button' : 'div', required: false, valid: true },
    rect: { x: 0, y: 0, width: 100, height: 40 }, actionable: { visible: true, enabled: true, hitTarget: true, unknown: [] },
    reviewBinding: { parentInstanceId: 'modal-parent', attributes: { id } },
    classificationBinding: { truncated: false, text: label, nodes: [{ instanceId: `instance-${id}`, parentInstanceId: 'modal-parent', tag: 'div', attributes: { id } }], references: [] },
  } as unknown as Control);
  const dialog = control('dialog', 'dialog', 'Preferences'), button = control('local', 'button', 'Current work');
  let current = { id: 'current-observation', sessionId: 'current-session', documentId: 'document', instanceScope: 'document', url,
    ruleVersion: 'observable-v7', context: {}, stable: true, gaps: [], controls: [dialog, button], regions: [], components: [],
    boundaries: [{ key: 'modal', name: 'Preferences', region: 'modal', evidence: ['fixture'] }],
    overlays: [{ key: 'modal', name: 'Preferences', kind: 'modal', selector: '#modal', parentRegion: 'document', evidence: ['fixture'],
      controlIds: [dialog.localId, button.localId], exitControlIds: [] }], canonical: 'current', stateId: 'current-state',
  } as unknown as Observation;
  const action: ActionCandidate = { id: 'local-action', sessionId: current.sessionId, observationId: current.id, stateId: current.stateId,
    localId: button.localId, controlId: button.identityId, kind: 'click', label: button.name, risk: 'interface', replayable: true,
    source: 'control', sampleValidity: 'known', excluded: false, basis: button.actionBasis!.click,
    preconditions: { visible: true, enabled: true, identityResolved: true, context: current.context }, boundary: { key: 'modal', intent: 'interact' },
  };
  const actions = [action], events: Event[] = [], decisions: Decision[] = [], attempts = new Map<string, ActionAttempt[]>();
  let needsClassification = true, blockingBoundaryExit = false;
  const effect = () => vi.fn(async () => { throw Error('Browser effects are forbidden by this fixture'); });
  const availability = () => ({ sessionId: current.sessionId, observationId: current.id, revision: 'availability',
    actions: actions.map(a => ({ actionId: a.id, executable: true, blockers: [] })) });
  const classifications = () => ({ sessionId: current.sessionId, observationId: current.id,
    controls: [{ control: dialog, actions: [], classifications: [], needsClassification }] });
  const operations = () => ({ sessionId: current.sessionId, observationId: current.id,
    controls: current.controls.map(control => ({ control, actions: actions.filter(a => a.localId === control.localId), reviews: [], needsReview: false })) });
  const host = { events: new EventEmitter(), session: () => ({ actionCount: 0, currentObservationId: current.id, options: { executionPolicy: 'interface-only' } }),
    observation: () => current, actions: () => actions, list: (sid: string, kind: string) => kind === 'attempt' ? attempts.get(sid) || [] : [],
    boundaryState: () => ({ verified: false }), recoveryAssessment: (sid: string) => ({ observationId: current.id, blockingBoundaryExit,
      unknownAttempts: (attempts.get(sid) || []).filter(a => a.status === 'unknown') }), actionAvailability: availability,
    explorationSnapshot: () => ({ actions, operationCandidates: actions, availability: availability() }),
    controlInterpretationSnapshot: () => ({ actions, classifications: classifications(), operations: operations(), nonInteractive: [], retainedClassifications: [] }),
    controlClassificationMaterial: classifications, controlReviewMaterial: operations,
    regionReviewMaterial: () => ({ enabled: false }), explorationReviewMaterial: () => ({ groups: [] }),
    command: vi.fn(async (_sid: string, command: unknown) => {
      const row = command as { type: string; classification?: { observationId: string } };
      if (row.type !== 'classifyControls' || row.classification?.observationId !== current.id) throw Error('Unexpected or stale review command');
      needsClassification = false;
    }),
    createCheckpoint: effect(), reachCheckpoint: effect(), reachExplorationTarget: effect(), returnToObservedSource: effect(),
    execute: effect(), observe: effect(), createSession: effect(),
  } as unknown as ExplorerHost;
  const store = { save: vi.fn(), close: () => {}, decisionCursor: () => decisions.length,
    decisions: (_id: string, cursor = 0) => decisions.slice(cursor),
    decision: (decision: Decision) => { if (!decisions.includes(decision)) decisions.push(decision); },
    event: (event: Event) => { events.push(event); if (!continueDispatch && event.type === 'obligation.selected') throw localSelected; return event; },
  } as unknown as ExplorerStore;
  const plugin = new ExplorerPlugin(host, store), task = plugin.create({ url, coverageMode: 'all' });
  const review = { ...item('review', { url, label: dialog.name, role: dialog.role }, false), reason: 'classification_unresolved', status: 'unresolved' as const,
    evidence: [{ sessionId: 'old-session', observationId: 'old-dialog-A' }, { sessionId: 'old-session', observationId: 'old-dialog-B' }] };
  const remoteItem = { ...item('remote', { url, kind: 'click', label: 'Remote work' }), evidence: [{ sessionId: 'old-session', observationId: 'remote-source' }] };
  task.plan = [item('authority', { url }), remoteItem, review, { ...item('local', scopeFor(action, current)),
    operationConditionKey: schedulingKeyFor(action, current), operationConditionPolicy: 'browser-operation-key-v3' }];
  task.status = 'running';
  const round: Round = { id: 'round', number: 1, sessionId: current.sessionId, startedAt: new Date().toISOString(), status: 'running',
    actions: 0, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 };
  task.rounds = [round];
  task.routeRetries = recordRouteRetry(undefined, { routeKey: 'old-route', conditionVersion: 'old-condition', outcome: 'unverified', reason: 'Retained failure' });
  task.scheduling = { version: 1, localSelections: count, routes: { 'old-route': { sessionId: 'old-session', observationId: 'old-dialog-A',
    checkpointId: 'old-checkpoint', targets: [review.scope], path: [], itemIds: [review.id], memberKeys: ['old-route'], pathKeys: [] } }, legacyUnmappedRouteKeys: [] };
  const runtime = plugin as any;
  runtime.retainHostLimitations = runtime.reconcileReviewLedger = runtime.applyReviewRecoveryChanges = async () => {};
  runtime.auditRemainingScopes = runtime.updateObligations = () => {};
  runtime.normalizeScheduling = () => false;
  runtime.gap = () => item('fixture-gap', { url });
  let race = false;
  const choose = vi.spyOn(runtime, 'choose').mockImplementation(async (...args: unknown[]) => {
    const captured = args[2] as Observation;
    expect(args[3]).toBe('control-classification');
    const decision = { id: `decision-${decisions.length}`, taskId: task.id, sessionId: captured.sessionId, observationId: captured.id,
      revision: task.revision, actor: 'jev', purpose: 'control-classification', status: 'returned', answer: { value: 'container' },
    } as unknown as Decision;
    decisions.push(decision);
    if (race) current = { ...current, id: 'changed-during-review' };
    return { value: 'container', decision };
  });
  const revalidate = vi.fn(() => { throw remoteSelected; });
  const remote = vi.spyOn(runtime, 'scheduledRecovery').mockImplementation(async () => ({ itemId: remoteItem.id,
    source: { ...current, id: 'remote-source' }, routeKey: 'remote-route', revalidate }));
  const step = () => runtime.step(task, round, new AbortController().signal) as Promise<boolean>;
  const retained = () => structuredClone({ plan: task.plan, debt: task.routeRetries, routes: task.scheduling!.routes });
  const noBrowserEffects = () => {
    for (const name of ['createCheckpoint', 'reachCheckpoint', 'reachExplorationTarget', 'returnToObservedSource', 'execute', 'observe', 'createSession'] as const)
      expect(host[name]).not.toHaveBeenCalled();
  };
  return { host, store, plugin, task, round, review, events, decisions, attempts, choose, remote, revalidate, step, retained, noBrowserEffects,
    clearClassification: () => { needsClassification = false; },
    race: () => { race = true; }, blockExit: () => { blockingBoundaryExit = true; },
    run: () => runtime.run(task, new AbortController().signal) as Promise<void> };
}

it('reviews the current dialog at the fairness limit, then keeps the remote turn and historical work available', async () => {
  const f = fixture(); try {
    const before = f.retained();
    expect(await f.step()).toBe(true);
    expect(f.choose).toHaveBeenCalledOnce();
    expect(f.host.command).toHaveBeenCalledWith('current-session', { type: 'classifyControls', classification: {
      observationId: 'current-observation', source: 'explorer-plugin', classifications: [{ localId: 'dialog', classification: 'container',
        reason: 'Selected container', evidence: ['explorer-decision:decision-0'] }] } });
    expect(f.remote).not.toHaveBeenCalled(); expect(f.task.scheduling!.localSelections).toBe(localSelectionLimit);
    expect(f.retained()).toEqual(before); expect(f.task.usage.actions).toBe(0); f.noBrowserEffects();
    // The host now supplies reviewed current material. The unchanged fairness
    // counter must still select remote work; stop at its final revalidation.
    await expect(f.step()).rejects.toBe(remoteSelected);
    expect(f.remote).toHaveBeenCalledOnce(); expect(f.revalidate).toHaveBeenCalledOnce();
    expect(f.choose).toHaveBeenCalledOnce(); expect(f.host.command).toHaveBeenCalledOnce();
    expect(f.task.scheduling!.localSelections).toBe(localSelectionLimit); expect(f.retained()).toEqual(before); f.noBrowserEffects();
  } finally { await f.plugin.close(); }
});

it.each([0, localSelectionLimit - 1])('keeps the ordinary local-action handoff below the limit (%i)', async count => {
  const f = fixture(count); try {
    const before = f.retained();
    await expect(f.step()).rejects.toBe(localSelected);
    const choice = f.events.find(event => event.type === 'obligation.selected')!.data as ObligationSelection;
    expect(choice).toMatchObject({ kind: 'current', itemId: 'local', actionId: 'local-action' });
    expect(f.choose).not.toHaveBeenCalled(); expect(f.host.command).not.toHaveBeenCalled(); expect(f.remote).not.toHaveBeenCalled();
    expect(f.task.scheduling!.localSelections).toBe(count); expect(f.retained()).toEqual(before); f.noBrowserEffects();
  } finally { await f.plugin.close(); }
});

it('rejects current-observation changes before applying a fairness-limit review', async () => {
  const f = fixture(); try {
    const before = f.retained(); f.race();
    await expect(f.step()).rejects.toMatchObject({ code: 'STALE_DECISION' });
    expect(f.choose).toHaveBeenCalledOnce(); expect(f.decisions[0].status).toBe('stale');
    expect(f.round.reviewed).toEqual([]); expect(f.host.command).not.toHaveBeenCalled(); expect(f.remote).not.toHaveBeenCalled();
    expect(f.task.scheduling!.localSelections).toBe(localSelectionLimit); expect(f.retained()).toEqual(before); f.noBrowserEffects();
  } finally { await f.plugin.close(); }
});

it('retains unknown results across restart before any current review or remote handoff', async () => {
  const f = fixture(); try {
    f.attempts.set('old-session', [{ id: 'unknown-old-attempt', sessionId: 'old-session', status: 'unknown' } as ActionAttempt]);
    f.task.unverifiedRecoveries = [{ sessionId: 'old-session', observationId: 'old-dialog-A', attemptIds: ['unknown-old-attempt'] }];
    const before = f.retained(); await f.run();
    expect(f.task).toMatchObject({ status: 'blocked', reason: 'UNKNOWN_DISPATCH_REQUIRES_REVIEW',
      unverifiedRecoveries: [{ sessionId: 'old-session', attemptIds: ['unknown-old-attempt'] }] });
    expect(f.attempts.get('old-session')![0].status).toBe('unknown'); expect(f.retained()).toEqual(before);
    expect(f.choose).not.toHaveBeenCalled(); expect(f.host.command).not.toHaveBeenCalled(); expect(f.remote).not.toHaveBeenCalled(); f.noBrowserEffects();
  } finally { await f.plugin.close(); }
});

it('does not review through an unverified boundary exit', async () => {
  const f = fixture(); try {
    const before = f.retained(); f.blockExit();
    await expect(f.step()).rejects.toMatchObject({ code: 'BOUNDARY_EXIT_UNVERIFIED' });
    expect(f.choose).not.toHaveBeenCalled(); expect(f.host.command).not.toHaveBeenCalled(); expect(f.remote).not.toHaveBeenCalled();
    expect(f.retained()).toEqual(before); f.noBrowserEffects();
  } finally { await f.plugin.close(); }
});

// Exercise the real selection -> neededEntry -> recordEntry -> reservation ->
// recordOutcome chain. Only historical permission and the final transition /
// aggregate completion projections are supplied as independent recorded facts.
function reentryDispatchFixture(outcome: 'succeeded' | 'unknown' | 'no-attempt', explicitReentry = false) {
  const f = fixture(1, true), runtime = f.plugin as any, o = f.host.observation(f.round.sessionId);
  const action = f.host.actions(o.sessionId)[0], entry = item('entry-owner', scopeFor(action, o));
  const child = (id: string, label: string): PlanItem => ({ ...item(id, { url, label, role: 'button', kind: 'click' }),
    prerequisites: [entry.scope], evidence: [{ sessionId: 'old-session', observationId: 'old-opened' }] });
  const first = child('first-child', 'Convert'), second = child('second-child', 'Swap');
  f.task.plan = [entry, first, second];
  f.clearClassification();
  f.round.entryRoutes = [{ entry: entry.scope, targets: [first.scope, second.scope], context: digest(o.context),
    evidence: { sessionId: 'old-session', beforeId: 'old-before', observationId: 'old-opened', attemptId: 'old-entry-attempt' } }];
  const repeatedSource = { sessionId: 'old-session', attemptId: 'old-entry-attempt' };
  vi.spyOn(runtime, 'routePermission').mockReturnValue({ repeatable: true, source: repeatedSource });
  // No alternate remote route is introduced by this fixture. A previously
  // consumed local action still has the independently verified reentry route.
  f.remote.mockImplementation(async () => undefined);
  if (explicitReentry) {
    f.round.tried.push(keyFor(action, o));
    f.task.scheduling!.cursor = first.id;
    f.task.scheduling!.selection = { itemId: second.id, kind: 'reentry', actionId: action.id, source: second.evidence[0] };
  }
  const priorSchedule = structuredClone(f.task.scheduling!);
  const saved: Task[] = [];
  vi.mocked(f.store.save).mockImplementation(task => { saved.push(structuredClone(task)); return `saved-${saved.length}`; });
  f.host.createCheckpoint = vi.fn(async () => ({ id: 'entry-checkpoint' })) as unknown as ExplorerHost['createCheckpoint'];
  f.host.interactionTransition = vi.fn(() => ({ verified: false })) as unknown as ExplorerHost['interactionTransition'];
  runtime.settleScopes = () => {};
  const recorded = vi.spyOn(runtime, 'recordOutcome');
  const after = { ...o, id: 'entry-after' };
  let current = o, atDispatch: Task | undefined, dispatchGuard: unknown;
  f.host.observation = ((_sid: string, id?: string) => id === o.id ? o : id === after.id ? after : current) as ExplorerHost['observation'];
  const rejection = Object.assign(new Error('No dispatch receipt was created'), { code: 'PRECONDITIONS_CHANGED' });
  f.host.execute = vi.fn(async (sid, actionId, requestId, _value, guard) => {
    expect(sid).toBe(o.sessionId); expect(actionId).toBe(action.id);
    atDispatch = structuredClone(saved.at(-1)!); dispatchGuard = structuredClone(guard);
    if (outcome === 'no-attempt') throw rejection;
    const receipt: ActionAttempt = { id: 'new-entry-attempt', sessionId: sid, requestId, action, beforeId: o.id,
      ...(outcome === 'succeeded' ? { afterId: after.id } : {}), startedAt: '2026-10-18T00:00:00Z', status: outcome,
      purpose: 'exploration', executionProfile: 'interface-exploration', repetitionSource: repeatedSource };
    f.attempts.set(sid, [receipt]);
    if (outcome === 'succeeded') current = after;
    return receipt;
  });
  const assertDispatchBinding = (target: PlanItem, localSelections: number) => {
    expect(atDispatch?.scheduling).toMatchObject({ cursor: target.id, localSelections,
      selection: { itemId: target.id, kind: 'reentry', actionId: action.id, source: target.evidence[0] } });
    expect(atDispatch?.pendingDispatch).toMatchObject({ sessionId: o.sessionId, actionId: action.id, observationId: o.id, itemIds: [entry.id] });
    expect(dispatchGuard).toMatchObject({ observationId: o.id, profile: 'interface-exploration', repetitionSource: repeatedSource });
    expect(f.events.find(e => e.type === 'branch.reentry_planned')?.data).toMatchObject({ itemId: target.id, target: target.scope });
    for (const call of recorded.mock.calls) expect(call[2]).toEqual([entry.id]);
    for (const pending of [first, second]) {
      expect(pending.status).toBe('pending'); expect(pending.attempts).toEqual([]);
      expect(pending.resolvedBy).toBeUndefined(); expect(pending.conditionCompletion).toBeUndefined();
    }
  };
  return { ...f, entry, first, second, action, priorSchedule, recorded, rejection, assertDispatchBinding };
}

it('retains the real child before a fresh prerequisite dispatch without transferring its entry receipt or resetting fairness', async () => {
  const f = reentryDispatchFixture('succeeded'); try {
    expect(await f.step()).toBe(true);
    f.assertDispatchBinding(f.first, 2);
    expect(f.events.find(e => e.type === 'obligation.selected')?.data).toMatchObject({ itemId: f.entry.id, kind: 'current' });
    expect(f.recorded).toHaveBeenCalledOnce(); expect(f.entry.attempts).toHaveLength(1);
    expect(f.task.pendingDispatch).toBeUndefined();
  } finally { await f.plugin.close(); }
});

it('keeps an unknown prerequisite attached to the entry while the child remains only a scheduling hint', async () => {
  const f = reentryDispatchFixture('unknown'); try {
    await expect(f.step()).rejects.toMatchObject({ code: 'UNKNOWN_DISPATCH_REQUIRES_REVIEW' });
    f.assertDispatchBinding(f.first, 2);
    expect(f.task.pendingDispatch?.itemIds).toEqual([f.entry.id]);
    expect(f.entry.attempts).toEqual([expect.objectContaining({ outcome: 'unknown', evidence: expect.objectContaining({ attemptId: 'new-entry-attempt' }) })]);
    expect(f.attempts.get(f.round.sessionId)?.[0].status).toBe('unknown');
  } finally { await f.plugin.close(); }
});

it('rolls back child selection and fairness when a fresh prerequisite produces no attempt', async () => {
  const f = reentryDispatchFixture('no-attempt'); try {
    await expect(f.step()).rejects.toBe(f.rejection);
    f.assertDispatchBinding(f.first, 2);
    expect(f.task.scheduling).toEqual(f.priorSchedule); expect(f.task.pendingDispatch).toBeUndefined();
    expect(f.recorded).not.toHaveBeenCalled(); expect(f.entry.attempts).toEqual([]);
  } finally { await f.plugin.close(); }
});

it('preserves the selected reentry child when several children share the same entry', async () => {
  const f = reentryDispatchFixture('succeeded', true); try {
    expect(await f.step()).toBe(true);
    f.assertDispatchBinding(f.second, 0);
    expect(f.events.find(e => e.type === 'obligation.selected')?.data).toMatchObject({ itemId: f.second.id, kind: 'reentry' });
    expect(f.recorded).toHaveBeenCalledOnce(); expect(f.entry.attempts).toHaveLength(1);
  } finally { await f.plugin.close(); }
});
