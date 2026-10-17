import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ActionAttempt, ActionCandidate, Observation } from '@interaction/browser';
import { ExplorerPlugin, type Decision, type ExplorerHost, type ExplorerStore, type PlanItem, type Round, type Scope, type Task } from '@interaction/explorer-plugin';
import { localSelectionLimit, type ObligationSelection } from '../packages/explorer-plugin/src/obligation-scheduler.js';
import { recordRouteRetry } from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import { scopeFor, schedulingKeyFor } from '../packages/explorer-plugin/src/policy.js';

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
function fixture(count = localSelectionLimit) {
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
    event: (event: Event) => { events.push(event); if (event.type === 'obligation.selected') throw localSelected; return event; },
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
  return { host, plugin, task, round, review, events, decisions, attempts, choose, remote, revalidate, step, retained, noBrowserEffects,
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
