import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { classificationCorrespondenceConditions, type ActionCandidate, type Checkpoint, type Control, type Observation } from '@interaction/browser';
import { ExplorerPlugin, ExplorerStore, type ExplorerHost, type PlanItem, type Task } from '@interaction/explorer-plugin';
import { scopeForControl } from '../packages/explorer-plugin/src/policy.js';
import { reviewRecoveryChanges, reviewRecoveryMaterialKey, type ReviewRecoveryChange } from '../packages/explorer-plugin/src/review-recovery.js';
import { recordRouteRetry } from '../packages/explorer-plugin/src/obligation-lifecycle.js';

const url = 'https://review-wait.fixture.invalid/source';
type Material = ReturnType<ExplorerHost['controlReviewMaterial']>['controls'][number];
type Assessment = ReturnType<NonNullable<ExplorerHost['checkpointRecoveryCandidates']>>[number];

function observation(id: string): Observation {
  const control: Control = {
    localId: `${id}:target`, instanceId: `${id}:target`, identityId: 'retained-id', tag: 'div', role: 'generic', name: 'Preference', label: '',
    region: 'settings', form: '', selector: '#target', rect: { x: 0, y: 0, width: 20, height: 20 }, value: '', displayedText: 'Preference',
    checked: null, selected: [], visible: true, enabled: true, editable: false, expanded: null, controls: null,
    constraints: { type: 'div', required: false, valid: true }, options: [], actions: [], discovery: [], actionBasis: {},
    identityContext: { scope: 'owner:settings', binding: 'preference', evidence: ['captured-owner'] },
    actionable: { visible: true, enabled: true, editable: false, hitTarget: true, unknown: [] },
    reviewBinding: { parentInstanceId: `${id}:parent`, attributes: { class: 'wrapper' } },
    reviewReuseBinding: { ancestors: [{ tag: 'section', selector: '#section', attributes: { id: 'section' }, label: 'Settings' }] },
    classificationBinding: { truncated: false, text: 'Preference', nodes: [
      { instanceId: `${id}:target`, parentInstanceId: `${id}:parent`, tag: 'div', attributes: { class: 'wrapper' } },
      { instanceId: `${id}:text`, parentInstanceId: `${id}:target`, tag: 'span', attributes: {} },
    ], references: [] },
  };
  return { id, sessionId: 'session', instanceScope: id, documentId: id, url, ruleVersion: 'observable-v7', context: {}, stable: true, gaps: [],
    controls: [control], regions: [{ key: 'settings', label: 'Settings', role: 'region', selector: '#settings', text: '', rect: control.rect }],
    boundaries: [], overlays: [], canonical: id, stateId: `state-${id}`,
    navigation: { browserSessionId: 'browser', currentIndex: 0, entries: [{ id: 1, url, method: 'GET' }] },
  } as unknown as Observation;
}

/** Pure host fixture: captured sources, mutable action/review records and a
 * tryable candidate port. No browser, driver or restore implementation exists. */
function fixture() {
  const source = observation('source'), away = observation('away');
  away.url = 'https://review-wait.fixture.invalid/away'; away.controls = [];
  away.navigation!.entries.push({ id: 2, url: away.url, method: 'GET' }); away.navigation!.currentIndex = 1;
  const observations = new Map([source, away].map(o => [o.id, o]));
  let active = source;
  const sourceActions: ActionCandidate[] = [];
  // Only these fields are consumed by reviewRecoveryMaterialKey; the fixture
  // does not pretend that this partial record grants operation authority.
  const reviews = [{ id: 'earlier-review', status: 'active', conditionKey: 'retained-review-condition' }] as Material['reviews'];
  const sourceMaterial = (): Material => ({ control: source.controls[0], actions: sourceActions, reviews, needsReview: true,
    surroundings: { version: 'control-surroundings/v1', key: 'missing-owner', ownerInstanceId: 'owner', complete: false, truncated: false,
      reasons: ['owner_too_distant'], nodes: [], controls: [] }, reuseCandidates: [],
  });
  const historicalMaterial = vi.fn((_sid: string, input: { observationId: string }) => {
    if (input.observationId !== source.id) throw Error('Unexpected historical review source');
    return { sessionId: 'session', observationId: source.id, controls: [sourceMaterial()] };
  });
  const checkpoint: Checkpoint = { id: 'source-checkpoint', sessionId: 'session', name: 'Review source', observationId: source.id,
    stateId: source.stateId, context: source.context, predicates: [], acceptable: [], path: [], createdAt: '2026-10-17T00:00:00.000Z' };
  const candidate = (): Assessment => ({ checkpointId: checkpoint.id, sourceObservationId: source.id, currentObservationId: active.id,
    status: 'tryable', strategies: [{ strategy: 'observed_source_return', status: 'tryable', reason: 'native_return_candidate' }], blockers: [],
    invalidatedBy: ['current_observation_or_captured_facts_changed'], checkpointVerified: false, executionAuthorized: false,
    currentExecution: false, coverageGranted: false, dispatchRevalidationRequired: true });
  const assess = vi.fn((_sid: string, input: { observationId: string; checkpointIds: string[] }) => input.checkpointIds.map(id => {
    if (id !== checkpoint.id || input.observationId !== active.id) throw Error('Unexpected candidate request');
    return candidate();
  }));
  const host = { events: new EventEmitter(), session: () => ({ id: 'session', options: {}, actionCount: 0, currentObservationId: active.id }),
    observation: (_sid: string, id?: string) => { const o = id ? observations.get(id) : active; if (!o) throw Error('Missing fixture observation'); return o; },
    actions: (_sid: string, id = active.id) => id === source.id ? sourceActions : [],
    actionAvailability: () => ({ observationId: active.id, revision: 'fixture-availability', actions: [] }),
    recoveryAssessment: () => ({ unknownAttempts: [], blockingBoundaryExit: undefined }),
    controlReviewMaterial: () => ({ sessionId: 'session', observationId: active.id, controls: active.id === source.id ? [sourceMaterial()] : [] }),
    recoveryReviewMaterial: historicalMaterial,
    list: (_sid: string, kind: string) => kind === 'checkpoint' ? [checkpoint] : kind === 'control-review' ? reviews : [],
    interactionTransition: () => ({ retainedControls: [] }), checkpointRecoveryCandidates: assess,
    reachCheckpoint: vi.fn(async () => { throw Error('Selection must not restore'); }),
    execute: vi.fn(async () => { throw Error('Selection must not execute'); }),
  } as unknown as ExplorerHost;
  const store = new ExplorerStore(':memory:'), plugin = new ExplorerPlugin(host, store), task = plugin.create({ url, coverageMode: 'all' });
  const item: PlanItem = { id: 'review', title: 'Review Preference', scope: scopeForControl(source.controls[0], source), prerequisites: [],
    completion: 'Review retained target', required: true, dispatchScope: false, status: 'unresolved', reason: 'classification_unresolved',
    evidence: [{ sessionId: 'session', observationId: source.id }], attempts: [] };
  task.plan = [{ ...structuredClone(item), id: 'authority', scope: { url }, dispatchScope: true, status: 'pending', reason: 'accepted scope' }, item];
  task.status = 'running'; task.rounds = [{ id: 'round', number: 1, sessionId: 'session', startedAt: '2026-10-17T00:00:00.000Z', status: 'running',
    actions: 0, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 }];
  task.routeRetries = recordRouteRetry(undefined, { routeKey: 'unrelated-retained-failure', conditionVersion: 'old-condition', outcome: 'unreachable', reason: 'Retained prior failure' });
  task.scheduling = { version: 1, localSelections: 0, legacyUnmappedRouteKeys: [], routes: { 'unrelated-retained-failure': {
    sessionId: 'session', observationId: source.id, checkpointId: checkpoint.id, targets: [{ url, label: 'Unrelated operation', kind: 'click' }],
    path: [], itemIds: ['unrelated-item'], memberKeys: ['unrelated-member'], pathKeys: [],
  } } };
  const apply = (changes: ReviewRecoveryChange[]) => { for (const change of changes) {
    const row = task.plan.find(row => row.id === change.itemId)!;
    if (change.source) row.evidence.push(change.source);
    if (change.wait) row.reviewRecoveryWait = change.wait; else if (change.clearWait) delete row.reviewRecoveryWait;
  } };
  apply(reviewRecoveryChanges(task, source, host, { rejected: [{ localId: source.controls[0].localId, decisionId: 'denied-probe', kind: 'probe' }] }));
  active = away;
  const runtime = plugin as unknown as {
    routeConditionReader(o: Observation, actions: ActionCandidate[]): (route: unknown, read?: unknown) => string | undefined;
    scheduledRecovery(task: Task, round: Task['rounds'][number], o: Observation, actions: ActionCandidate[], availability: ReturnType<ExplorerHost['actionAvailability']>,
      condition: (route: unknown, read?: unknown) => string | undefined): Promise<{ itemId: string; source: Observation; frame: { checkpointId: string }; revalidate(): void } | undefined>;
  };
  const select = (input = task) => runtime.scheduledRecovery(input, input.rounds[0], away, [], host.actionAvailability('session', away.id), runtime.routeConditionReader(away, []));
  return { source, away, sourceActions, reviews, sourceMaterial, historicalMaterial, item, task, host, assess, checkpoint, apply, select, close: () => plugin.close() };
}

it.each(['actions', 'review record'] as const)('releases an absent-target negative wait when retained %s change, preserving the legal source candidate', async changed => {
  const f = fixture();
  try {
    expect(f.item.reviewRecoveryWait).toBeDefined();
    const wait = structuredClone(f.item.reviewRecoveryWait!);
    expect(wait.materialKey).toBe(reviewRecoveryMaterialKey(f.source, f.sourceMaterial()));
    const conditions = classificationCorrespondenceConditions(f.source.controls[0], f.source);
    expect(conditions).toMatchObject({ identityKey: wait.identityKey, conditionKey: wait.conditionKey });
    const capturedSource = structuredClone(f.source), originalPlan = structuredClone(f.task.plan), debt = structuredClone(f.task.routeRetries);

    if (changed === 'actions') f.sourceActions.push({ id: 'new-source-action', sessionId: 'session', observationId: f.source.id, stateId: f.source.stateId,
      localId: f.source.controls[0].localId, kind: 'click', label: 'Preference', risk: 'interface', replayable: true, excluded: false, sampleValidity: 'known',
      preconditions: { visible: true, enabled: true, identityResolved: true, targetResolved: true, context: {} }, source: 'retained-fixture',
      basis: { status: 'supported', evidence: [{ source: 'fixture', rule: 'new-retained-action', facts: {} }] },
    });
    else f.reviews[0].status = 'revoked';
    expect(reviewRecoveryMaterialKey(f.source, f.sourceMaterial())).not.toBe(wait.materialKey);
    expect(f.source).toEqual(capturedSource); expect(f.away.controls).toEqual([]);

    // Counterfactual uses the actual scheduler and candidate port: removing only
    // the negative wait admits this exact source, without changing any route debt.
    const withoutWait = structuredClone(f.task); delete withoutWait.plan.find(item => item.id === f.item.id)!.reviewRecoveryWait;
    expect(await f.select(withoutWait)).toMatchObject({ itemId: f.item.id, source: { id: f.source.id }, frame: { checkpointId: f.checkpoint.id } });
    expect(f.assess).toHaveBeenCalled(); f.assess.mockClear();

    // This is the refresh that real step performs before scheduledRecovery.
    // The existing implementation keeps the wait when the target is absent,
    // despite the changed actions/review records, and incorrectly returns none.
    f.apply(reviewRecoveryChanges(f.task, f.away, f.host));
    const selected = await f.select();
    expect(selected).toMatchObject({ itemId: f.item.id, source: { id: f.source.id }, frame: { checkpointId: f.checkpoint.id } });
    expect(f.assess).toHaveBeenCalled();
    expect(f.task.routeRetries).toEqual(debt);
    const omitWait = (plan: PlanItem[]) => plan.map(({ reviewRecoveryWait: _wait, ...item }) => item);
    expect(omitWait(f.task.plan)).toEqual(omitWait(originalPlan));
    expect(f.item.status).toBe('unresolved'); expect(f.item.attempts).toEqual([]);
    expect(f.host.reachCheckpoint).not.toHaveBeenCalled(); expect(f.host.execute).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('retains unchanged waits and reads shared historical material once per refresh and selection', async () => {
  const f = fixture();
  try {
    f.task.plan.push({ ...structuredClone(f.item), id: 'same-source-review' });
    const plan = structuredClone(f.task.plan), debt = structuredClone(f.task.routeRetries);
    f.apply(reviewRecoveryChanges(f.task, f.away, f.host));
    expect(f.task.plan).toEqual(plan); expect(f.historicalMaterial).toHaveBeenCalledTimes(1);
    f.historicalMaterial.mockClear();
    const selected = await f.select();
    expect(selected?.itemId).not.toBe(f.item.id); expect(selected?.itemId).not.toBe('same-source-review');
    expect(f.historicalMaterial.mock.calls).toEqual([['session', { observationId: f.source.id }]]);
    expect(f.task.scheduling?.deferred).toMatchObject({ review: { reason: 'unchanged_unresolved_review' }, 'same-source-review': { reason: 'unchanged_unresolved_review' } });
    expect(f.task.plan).toEqual(plan); expect(f.task.routeRetries).toEqual(debt);
    expect(f.host.reachCheckpoint).not.toHaveBeenCalled(); expect(f.host.execute).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each(['missing', 'wrong ID', 'throws'] as const)('withdraws only a negative wait when historical material %s prevents validation', async failure => {
  const f = fixture();
  try {
    if (failure === 'missing') delete f.host.recoveryReviewMaterial;
    else if (failure === 'wrong ID') f.historicalMaterial.mockImplementation(() => ({ sessionId: 'session', observationId: 'unrelated-source', controls: [f.sourceMaterial()] }));
    else f.historicalMaterial.mockImplementation(() => { throw Error('Historical material unavailable'); });
    const debt = structuredClone(f.task.routeRetries), before = structuredClone(f.item); delete before.reviewRecoveryWait;
    f.apply(reviewRecoveryChanges(f.task, f.away, f.host));
    expect(f.item.reviewRecoveryWait).toBeUndefined(); expect(f.item).toEqual(before);
    expect(await f.select()).toMatchObject({ itemId: f.item.id, source: { id: f.source.id }, frame: { checkpointId: f.checkpoint.id } });
    expect(f.task.routeRetries).toEqual(debt); expect(f.item.status).toBe('unresolved'); expect(f.item.attempts).toEqual([]);
    expect(f.host.reachCheckpoint).not.toHaveBeenCalled(); expect(f.host.execute).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
