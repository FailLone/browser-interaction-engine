import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { browserTargetConditions, classificationCorrespondenceConditions, type ActionCandidate, type Checkpoint, type Observation } from '@interaction/browser';
import { ExplorerPlugin, type ExplorerHost, type ExplorerStore, type PlanItem, type Scope } from '@interaction/explorer-plugin';
import { createRecoverySelectionView } from '../packages/browser/src/recovery-selection-view.js';
import { recordRouteRetry, recoveryRouteKey } from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import { scopeFor, scopeForControl, schedulingKeyFor } from '../packages/explorer-plugin/src/policy.js';

type Control = Observation['controls'][number];
const url = 'https://current-source.fixture.invalid/page';
const sid = 'session';

function target(instance = 'document:target', owner = 'Owner A'): Control {
  return {
    localId: instance, instanceId: instance, identityId: `identity-${instance}`, identityScope: 'semantic',
    stableKey: 'id:shared', tag: 'button', role: 'button', name: 'Run', label: 'Run', region: 'commands',
    form: '', selector: '#shared', visible: true, enabled: true, editable: false, readOnly: false,
    value: '', displayedText: 'Run', checked: null, pressed: null, expanded: null, selected: [],
    constraints: { type: 'button', required: false, valid: true }, options: [], actions: ['click'],
    actionBasis: { click: { status: 'supported', evidence: [{ source: 'html', rule: 'native-button/v1', facts: { type: 'button' } }] } },
    identityContext: { scope: owner, binding: 'command', evidence: ['captured-owner'] },
    actionable: { visible: true, enabled: true, editable: false, hitTarget: true, unknown: [] },
    reviewBinding: { parentInstanceId: `${instance}:owner`, attributes: { id: 'shared', type: 'button' } },
    reviewReuseBinding: { ancestors: [{ tag: 'section', selector: '#owner', attributes: { 'aria-label': owner }, label: owner }] },
    classificationBinding: { truncated: false, text: 'Run', nodes: [
      { instanceId: instance, parentInstanceId: `${instance}:owner`, tag: 'button', attributes: { id: 'shared', type: 'button' } },
    ], references: [] },
  } as unknown as Control;
}

function observed(id: string, mode: 'A' | 'B', control = target()): Observation {
  const selector = {
    ...target('document:mode', 'Mode owner'), identityId: 'mode-identity', stableKey: 'id:mode',
    tag: 'select', role: 'combobox', name: 'Mode', label: 'Mode', region: 'modes', selected: [mode],
    constraints: { type: 'select', required: false, valid: true }, actions: [], actionBasis: {},
  } as Control;
  return {
    id, sessionId: sid, documentId: 'document', instanceScope: 'document', url,
    ruleVersion: 'observable-v7', context: {}, stable: true, gaps: [], controls: [control, selector],
    regions: [{ key: 'commands', label: 'Commands', role: 'region' }, { key: 'modes', label: 'Modes', role: 'region' }],
    boundaries: [], overlays: [], components: [], canonical: id, stateId: `state-${id}`,
  } as unknown as Observation;
}

function action(o: Observation): ActionCandidate {
  const c = o.controls[0];
  return {
    id: `action-${o.id}`, sessionId: sid, observationId: o.id, stateId: o.stateId, localId: c.localId,
    controlId: c.identityId, kind: 'click', label: 'Run', risk: 'interface', replayable: true, source: 'control',
    sampleValidity: 'known', excluded: false, basis: c.actionBasis!.click,
    preconditions: { visible: true, enabled: c.enabled, identityResolved: true, context: o.context },
  } as ActionCandidate;
}

function item(id: string, scope: Scope, sources: Observation[]): PlanItem {
  return { id, title: id, scope, prerequisites: [], completion: 'Retain this source condition', status: 'unresolved',
    required: true, dispatchScope: false, reason: 'classification_unresolved', attempts: [],
    evidence: sources.map(source => ({ sessionId: sid, observationId: source.id })) };
}

// Selector-only fixture: no BrowserEngine, SQLite, provider, browser or server.
// The real view lifetime and real scheduling code are used; effects are forbidden.
function fixture(sources: Observation[], current: Observation, operation = false, policyBlocked = false) {
  const frames = new Map([...sources, current].map(o => [o.id, o]));
  const rows = new Map([...sources, current].map(o => [o.id, operation ? [action(o)] : []]));
  // This independent old debt has real retained membership. A missing source
  // would correctly block every new route as unmapped debt and hide the filter
  // under test, even when the candidate itself is otherwise recoverable.
  const unknownSource = observed('old-source', 'A', { ...target('document:old-unknown', 'Old owner'),
    stableKey: 'id:old-unknown', name: 'Previous unknown operation', label: 'Previous unknown operation' });
  const unknownAction = { ...action(unknownSource), label: 'Previous unknown operation' };
  frames.set(unknownSource.id, unknownSource); rows.set(unknownSource.id, [unknownAction]);
  const transition = (source: Observation) => ({ beforeId: source.id, afterId: current.id, verified: true,
    documentChanged: false, navigated: false, retainedControls: source.controls.flatMap(before => {
      const matches = current.controls.filter(after => after.instanceId === before.instanceId);
      return matches.length === 1 ? [{ beforeLocalId: before.localId, afterLocalId: matches[0].localId }] : [];
    }), entered: [], exited: [], revealedControlIds: [] });
  const checkpoints: Checkpoint[] = sources.map(o => ({ id: `checkpoint-${o.id}`, sessionId: sid, name: o.id,
    observationId: o.id, stateId: o.stateId, context: o.context, predicates: [], acceptable: [], path: [], createdAt: '2026-10-17T00:00:00.000Z' }));
  const effect = () => vi.fn(async () => { throw Error('Selection cannot dispatch'); });
  const availability = () => ({ sessionId: sid, observationId: current.id, revision: 'availability', profile: 'interface-exploration' as const,
    dispatchRevalidationRequired: true as const, actions: (rows.get(current.id) || []).map(a => ({ actionId: a.id,
      executable: !policyBlocked && a.preconditions.enabled,
      blockers: policyBlocked ? [{ code: 'ACTION_BLOCKED' as const, reason: 'interface_risk_required', evidence: ['Owned fixture policy denial'] }] : [] })) });
  const material = vi.fn((_sessionId: string, input: { sourceObservationId: string; currentObservationId: string }) => {
    const source = frames.get(input.sourceObservationId); if (!source) throw Error('Missing fixture source');
    return { source, actions: rows.get(source.id) || [], transition: transition(source) };
  });
  const host = {
    events: new EventEmitter(), session: () => ({ id: sid, options: {}, actionCount: 0, currentObservationId: current.id }),
    observation: (_sid: string, id?: string) => frames.get(id || current.id)!, actions: (_sid: string, id?: string) => rows.get(id || current.id) || [],
    actionAvailability: availability, list: (_sid: string, kind: string) => kind === 'checkpoint' ? checkpoints : [],
    recoverySourceMaterial: material, interactionTransition: (_sid: string, beforeId: string) => transition(frames.get(beforeId)!),
    recoveryAssessment: () => ({ unknownAttempts: [] }), reachCheckpoint: effect(), reachExplorationTarget: effect(), execute: effect(),
  } as unknown as ExplorerHost;
  host.recoverySelectionView = () => createRecoverySelectionView({ supported: () => true, recordRevision: () => 'fixture-v1',
    current: () => ({ observation: current, actions: rows.get(current.id) || [], availability: availability() }),
    source: id => material(sid, { sourceObservationId: id, currentObservationId: current.id }) });
  const events: { type: string; data: unknown }[] = [];
  const store = { save: vi.fn(), close: () => {}, decisionCursor: () => 0, decisions: () => [],
    event: (event: typeof events[number]) => { events.push(event); return event; } } as unknown as ExplorerStore;
  const plugin = new ExplorerPlugin(host, store), task = plugin.create({ url, coverageMode: 'all' });
  const source = sources[0], pending = item('pending', operation ? scopeFor(rows.get(source.id)![0], source) : scopeForControl(source.controls[0], source), sources);
  if (operation) { pending.reason = 'operation_not_executed'; pending.operationConditionKey = schedulingKeyFor(rows.get(source.id)![0], source); pending.operationConditionPolicy = 'browser-operation-key-v3'; }
  const authority = { ...item('authority', { url }, []), dispatchScope: true, reason: 'accepted scope', status: 'pending' as const };
  const unknown = { ...item('unknown', scopeFor(unknownAction, unknownSource), [unknownSource]), reason: 'unknown_action_outcome', status: 'blocked' as const };
  task.plan = [authority, pending, unknown]; task.status = 'running';
  task.rounds = [{ id: 'round', number: 1, sessionId: sid, startedAt: '2026-10-17T00:00:00.000Z', status: 'running',
    actions: 0, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 }];
  const unknownRoute = recoveryRouteKey(unknownSource, [unknownAction], [unknown.scope]);
  task.routeRetries = recordRouteRetry(undefined, { routeKey: unknownRoute, conditionVersion: 'old-condition', outcome: 'unknown',
    reason: 'Earlier unknown result', unknownSource: { sessionId: sid, attemptIds: ['unknown-attempt'] } });
  task.scheduling = { version: 1, localSelections: 4, legacyUnmappedRouteKeys: [], routes: { [unknownRoute]: {
    sessionId: sid, observationId: unknownSource.id, checkpointId: 'old-checkpoint', targets: [unknown.scope], path: [], itemIds: [unknown.id],
    memberKeys: [unknownRoute], pathKeys: [] } } };
  const runtime = plugin as any;
  const select = () => runtime.scheduledRecovery(task, task.rounds[0], current, rows.get(current.id) || [], availability(),
    runtime.routeConditionReader(current, rows.get(current.id) || []));
  const retained = () => structuredClone({ plan: task.plan, debt: task.routeRetries });
  const noEffects = () => { expect(host.execute).not.toHaveBeenCalled(); expect(host.reachCheckpoint).not.toHaveBeenCalled(); expect(host.reachExplorationTarget).not.toHaveBeenCalled();
    expect(task.scheduling!.legacyUnmappedRouteKeys).toEqual([]); expect(task.scheduling!.routes[unknownRoute].membershipUnavailable).not.toBe(true); };
  const positiveControl = async () => {
    // Keep the same historical sources, nonlocal current mode, policy and old
    // unknown debt; only remove the current target/action as an exclusion hint.
    const absent = structuredClone(current); absent.controls = absent.controls.filter(c => c.localId !== current.controls[0].localId);
    const control = fixture(sources, absent, operation, policyBlocked); control.rows.set(absent.id, []);
    control.pending.scope = structuredClone(pending.scope);
    try {
      const before = control.retained(), selected = await control.select();
      expect(selected, JSON.stringify(control.task.scheduling?.deferred)).toMatchObject({ itemId: 'pending' });
      expect(control.retained()).toEqual(before); control.noEffects();
    } finally { await control.close(); }
  };
  return { host, task, pending, material, rows, events, select, retained, noEffects, positiveControl, close: () => plugin.close() };
}

it('current review presence does not erase a retained occurrence in a different captured mode', async () => {
  const source = observed('source-A', 'A'), current = observed('current-B', 'B'), f = fixture([source], current);
  try {
    await f.positiveControl();
    expect(source.controls[0].instanceId).toBe(current.controls[0].instanceId);
    expect(browserTargetConditions(action(source), source)!.key).not.toBe(browserTargetConditions(action(current), current)!.key);
    const before = f.retained();
    expect(await f.select(), JSON.stringify(f.task.scheduling?.deferred)).toMatchObject({ itemId: 'pending', source: { id: source.id } });
    expect(f.retained()).toEqual(before); f.noEffects();
  } finally { await f.close(); }
});

it('an equivalent recent review source cannot stop the older A-condition candidate', async () => {
  const older = observed('older-A', 'A'), recent = observed('recent-B', 'B'), current = observed('current-B', 'B'), f = fixture([older, recent], current);
  try {
    await f.positiveControl();
    expect(classificationCorrespondenceConditions(recent.controls[0], recent)).toEqual(classificationCorrespondenceConditions(current.controls[0], current));
    const before = f.retained();
    expect(await f.select(), JSON.stringify(f.task.scheduling?.deferred)).toMatchObject({ itemId: 'pending', source: { id: older.id }, frame: { checkpointId: `checkpoint-${older.id}` } });
    expect(f.material.mock.calls.map(([, input]) => input.sourceObservationId)).toEqual([recent.id, older.id]);
    expect(f.retained()).toEqual(before); f.noEffects();
  } finally { await f.close(); }
});

it('shared same-name hints do not let current B suppress the absent A review source', async () => {
  const source = observed('source-A', 'A', target('document:A', 'Owner A'));
  const current = observed('current-B', 'A', target('document:B', 'Owner B')), f = fixture([source], current);
  delete f.pending.scope.targetBinding; // Retained legacy scope has a shared hint, not an owner proof.
  try {
    await f.positiveControl();
    expect(source.controls[0].stableKey).toBe(current.controls[0].stableKey);
    expect(classificationCorrespondenceConditions(source.controls[0], source)!.identityKey)
      .not.toBe(classificationCorrespondenceConditions(current.controls[0], current)!.identityKey);
    const before = f.retained();
    expect(await f.select(), JSON.stringify(f.task.scheduling?.deferred)).toMatchObject({ itemId: 'pending', source: { id: source.id } });
    expect(f.retained()).toEqual(before); f.noEffects();
  } finally { await f.close(); }
});

it('verified unchanged review conditions still avoid restoring that source', async () => {
  const source = observed('source-A', 'A'), current = observed('current-A', 'A'), f = fixture([source], current);
  try {
    expect(classificationCorrespondenceConditions(source.controls[0], source)).toEqual(classificationCorrespondenceConditions(current.controls[0], current));
    const before = f.retained(); expect(await f.select()).toBeUndefined();
    expect(f.task.scheduling!.deferred!.pending.reason).toBe('current_review_occurrence_present');
    expect(f.retained()).toEqual(before); f.noEffects();
  } finally { await f.close(); }
});

it('current B policy denial cannot exclude an independently retained A operation condition', async () => {
  const source = observed('source-A', 'A'), current = observed('current-B', 'B'), f = fixture([source], current, true, true);
  try {
    await f.positiveControl();
    const before = f.retained();
    const selected = await f.select();
    expect(selected, JSON.stringify(f.task.scheduling?.deferred)).toMatchObject({ itemId: 'pending', source: { id: source.id }, targetActionIds: [`action-${source.id}`] });
    expect(f.retained()).toEqual(before); f.noEffects();
    // The corrected source filter cannot release an unknown debt on that route.
    f.task.routeRetries = recordRouteRetry(f.task.routeRetries, { routeKey: selected.routeKey, conditionVersion: selected.conditionVersion,
      outcome: 'unknown', reason: 'Source A outcome remains unknown', unknownSource: { sessionId: sid, attemptIds: ['source-A-unknown'] } });
    const unknown = f.retained(); expect(await f.select()).toBeUndefined();
    expect(f.task.scheduling!.deferred!.pending.reason).toBe('route_retry_unknown_result');
    expect(f.retained()).toEqual(unknown); f.noEffects();
  } finally { await f.close(); }
});

it('verified same-condition current policy denial still avoids pointless recovery', async () => {
  const source = observed('source-A', 'A'), current = observed('current-A', 'A'), f = fixture([source], current, true, true);
  try {
    const before = f.retained(); expect(await f.select()).toBeUndefined();
    expect(f.task.scheduling!.deferred!.pending.reason).toBe('current_target_policy_blocked');
    expect(f.retained()).toEqual(before); f.noEffects();
  } finally { await f.close(); }
});

it.each(['A', 'B'] as const)('disabled current evidence only excludes its own source condition (current mode %s)', async mode => {
  const source = observed('source-A', 'A'), current = observed(`current-${mode}`, mode);
  source.controls[0].enabled = current.controls[0].enabled = false;
  const f = fixture([source], current, true);
  try {
    if (mode === 'B') await f.positiveControl();
    const before = f.retained(), selected = await f.select();
    if (mode === 'A') { expect(selected).toBeUndefined(); expect(f.task.scheduling!.deferred!.pending.reason).toBe('source_target_already_disabled'); }
    else expect(selected, JSON.stringify(f.task.scheduling?.deferred)).toMatchObject({ itemId: 'pending', source: { id: source.id } });
    expect(f.retained()).toEqual(before); f.noEffects();
  } finally { await f.close(); }
});
