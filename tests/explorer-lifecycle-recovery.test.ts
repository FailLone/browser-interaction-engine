import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';
import type { Observation } from '@interaction/browser';
import { ExplorerStore } from '../packages/explorer-plugin/src/store.js';
import { ExplorerPlugin } from '../packages/explorer-plugin/src/runtime.js';
import { POLICY_VERSION } from '../packages/explorer-plugin/src/decision-policy.js';
import { settleInterruptedClock } from '../packages/explorer-plugin/src/task-lifecycle.js';
import type { Decision, ExplorerHost, Task } from '../packages/explorer-plugin/src/types.js';

const directories: string[] = [], stores: ExplorerStore[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const store of stores.splice(0)) try { store.close(); } catch {} for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function file() { const directory = mkdtempSync(join(tmpdir(), 'explorer-lifecycle-')); directories.push(directory); return join(directory, 'plugin.sqlite'); }
function open(path: string) { const store = new ExplorerStore(path); stores.push(store); return store; }
function task(): Task { return { id: 'task', goal: '', coverageMode: 'all', url: 'https://example.test/', createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(), revision: 1, status: 'paused', reason: 'original_reason',
  budget: { rounds: 1, actions: 100, modelRequests: 100, durationMs: 10000 }, usage: { rounds: 1, actions: 2, modelRequests: 7, durationMs: 100 }, activeSince: 1000, sessionOptions: {}, sampleExcluded: [], exhaustive: false,
  plan: [{ id: 'pending', title: 'A', scope: { label: 'A' }, prerequisites: [], completion: 'Observed', status: 'unresolved', required: true, dispatchScope: true, reason: 'unverified', evidence: [], attempts: [{ roundId: 'r', outcome: 'unknown' }] }],
  rounds: [{ id: 'r', number: 1, sessionId: 's', startedAt: new Date(1000).toISOString(), status: 'running', actions: 2, stack: [], entryPath: [], reentries: ['retained'], tried: ['retained'], reviewed: ['retained'], noProgress: 1, policyVersion: POLICY_VERSION }]
}; }
function decision(status: Decision['status']): Decision { return { id: status, taskId: 'task', revision: 1, roundId: 'r', sessionId: 's', observationId: 'o', actor: 'jev', purpose: 'region-review', provider: 'fixture', model: 'fixture', request: { id: `request-${status}`, kind: 'choice', purpose: 'region-review', instructions: 'Choose', state: {}, options: { accept: 'Accept' } }, status, startedAt: new Date(1500).toISOString(), elapsedMs: 1000, answer: { value: 'accept', model: 'fixture' } }; }
function raw(store: ExplorerStore) { return (store as unknown as { db: Database.Database }).db; }

it.each(['paused', 'running', 'stopped'] as const)('settles a persisted %s interruption at last activity, preserving all unknown and route evidence', status => {
  vi.useFakeTimers(); vi.setSystemTime(2000); const path = file(), store = open(path), source = task(); source.status = status;
  source.pauseRequestedAt = status === 'running' ? undefined : 1900;
  source.pendingDispatch = { sessionId: 's', requestId: 'unknown-request', actionId: 'a', itemIds: ['pending'], observationId: 'o' };
  source.unverifiedRecoveries = [{ sessionId: 's', attemptIds: ['unknown-recovery'] }];
  source.unverifiedNavigations = [{ sourceUrl: source.url, targetUrl: source.url + 'other', evidence: { sessionId: 's', observationId: 'o', attemptId: 'unknown-nav' } }];
  source.scheduling = { version: 1, cursor: 'pending', localSelections: 3, legacyUnmappedRouteKeys: ['old-debt'], routes: { failed: { sessionId: 's', observationId: 'o', checkpointId: 'cp', targets: [{ label: 'A' }], path: [], itemIds: ['pending'], failure: { status: 'unreachable', reason: 'retained-failure', conditionVersion: 'v', targets: [{ label: 'A' }] } } } };
  source.routeRetries = { version: 1, routes: { failed: { unknown: true, completedProgressKeys: ['old-progress'], conditions: { retained: { attempts: 2, outcome: 'unknown', reason: 'unverified', unknownSource: { sessionId: 's', attemptIds: ['unknown-recovery'] } } } } } };
  store.save(source); const refs = store.taskOrder(source.id);
  for (const state of ['requested', 'returned', 'applied'] as const) store.decision(decision(state));
  vi.setSystemTime(3000); const cursor = store.event({ taskId: source.id, actor: 'engine', type: 'action.completed', data: { status: 'unknown' } }).sequence;
  store.close(); vi.setSystemTime(100000); const reopened = open(path), recovered = reopened.task(source.id);
  expect(recovered.status).toBe(status === 'running' ? 'paused' : status);
  expect(recovered.reason).toBe(status === 'running' ? 'process_restarted' : 'original_reason');
  expect(recovered.usage).toEqual({ ...source.usage, durationMs: 2100 });
  expect(recovered.activeSince).toBeUndefined(); expect(recovered.pauseRequestedAt).toBeUndefined();
  expect(recovered.durationUncertainty).toEqual({ interruptions: 1, additionalMsUpperBound: 97000, budgetBasis: 'persisted-activity-lower-bound' });
  expect(recovered.rounds).toEqual(source.rounds.map(round => ({ ...round, status: 'paused' })));
  expect(reopened.taskOrder(source.id).rounds).toEqual(refs.rounds); expect(reopened.taskOrder(source.id).plan).toEqual(refs.plan);
  for (const field of ['plan', 'pendingDispatch', 'unverifiedRecoveries', 'unverifiedNavigations', 'scheduling', 'routeRetries'] as const) expect(recovered[field]).toEqual(source[field]);
  expect(reopened.decisions(source.id)).toEqual(['requested', 'returned', 'applied'].map(state => state === 'applied' ? decision('applied') : { ...decision(state as Decision['status']), status: 'stale', reason: 'process_restarted' }));
  const updates = reopened.updates(source.id, cursor); expect(updates.events.map(event => event.type)).toEqual(['decision.stale', 'decision.stale', 'task.recovered']);
  expect(updates.events.at(-1)?.data).toMatchObject({ prior: { status, reason: 'original_reason' }, duration: { countedMs: 2000, observedThrough: { source: `event:${cursor}`, at: 3000 }, unmeasuredMs: { lowerBound: 0, upperBound: 97000 }, exactStopTimeKnown: false } });
  const before = reopened.taskState(source.id), events = reopened.events(source.id); reopened.close(); vi.setSystemTime(200000);
  const again = open(path); expect(again.taskState(source.id)).toEqual(before); expect(again.events(source.id)).toEqual(events);
});

it('accumulates distinct interrupted windows without charging or duplicating their unknown tails', () => {
  vi.useFakeTimers(); vi.setSystemTime(2000); const path = file(), store = open(path); store.save(task()); store.close();
  vi.setSystemTime(10000); const first = open(path), source = first.task('task'); expect(source.usage.durationMs).toBe(1100);
  source.activeSince = 11000; source.status = 'running'; source.rounds[0].status = 'running'; vi.setSystemTime(12000); first.save(source); first.close();
  vi.setSystemTime(20000); const second = open(path); expect(second.task('task').usage.durationMs).toBe(2100);
  expect(second.task('task').durationUncertainty).toEqual({ interruptions: 2, additionalMsUpperBound: 16000, budgetBasis: 'persisted-activity-lower-bound' });
  const version = second.taskHeader('task').version; second.close(); vi.setSystemTime(30000); const third = open(path);
  expect(third.taskHeader('task').version).toBe(version); expect(third.task('task').durationUncertainty?.interruptions).toBe(2);
});

it('finds a clock hidden in an old packed paused header without decoding plan/history', () => {
  vi.useFakeTimers(); vi.setSystemTime(2000); const path = file(), store = open(path), source = task(); source.rounds[0].status = 'paused'; source.sampleExcluded = ['large-header'.repeat(1000)]; store.save(source);
  const row = raw(store).prepare('SELECT json,header_data FROM tasks').get() as { json: string; header_data: unknown }; expect(row.header_data).not.toBeNull(); expect(JSON.parse(row.json).activeSince).toBeUndefined(); store.close();
  vi.spyOn(ExplorerStore.prototype, 'task').mockImplementation(() => { throw new Error('FULL_TASK_READ'); }); vi.spyOn(ExplorerStore.prototype, 'taskState').mockImplementation(() => { throw new Error('FULL_HISTORY_READ'); });
  vi.setSystemTime(100000); const reopened = open(path); expect(reopened.taskHeader('task').header.usage.durationMs).toBe(1100); expect(reopened.taskHeader('task').header.activeSince).toBeUndefined();
});

it('skips historical decision reads for a settled packed task and uses the unsettled index', () => {
  const path = file(), store = open(path), source = task(); delete source.activeSince; source.rounds[0].status = 'paused'; source.sampleExcluded = ['packed-header'.repeat(1000)]; store.save(source);
  for (let index = 0; index < 20; index++) store.decision({ ...decision('applied'), id: `applied-${index}`, input: { retained: 'large-model-input'.repeat(1000) } });
  const prototype = Object.getPrototypeOf(raw(store)); store.close(); const prepares = vi.spyOn(prototype, 'prepare');
  const reopened = open(path); const sql = prepares.mock.calls.map(call => String(call[0]));
  expect(sql.filter(query => query.startsWith('SELECT json FROM decisions'))).toEqual([]);
  expect(sql.filter(query => query.startsWith('SELECT * FROM task_items'))).toEqual([]);
  const plan = raw(reopened).prepare("EXPLAIN QUERY PLAN SELECT DISTINCT task_id FROM decisions INDEXED BY decision_unsettled_task WHERE json_extract(json,'$.status') IN ('requested','returned')").all();
  expect(JSON.stringify(plan)).toContain('decision_unsettled_task'); expect(reopened.taskHeader('task').header.usage).toEqual(source.usage);
});

it('invalidates a returned decision on a settled paused task without changing its duration or original reason', () => {
  vi.useFakeTimers(); vi.setSystemTime(2000); const path = file(), store = open(path), source = task(); delete source.activeSince; source.rounds[0].status = 'paused'; store.save(source); store.decision(decision('returned')); store.close();
  vi.setSystemTime(100000); const reopened = open(path); expect(reopened.task('task').usage).toEqual(source.usage); expect(reopened.task('task').reason).toBe(source.reason); expect(reopened.task('task').durationUncertainty).toBeUndefined();
  expect(reopened.decisions('task')[0]).toMatchObject({ status: 'stale', reason: 'process_restarted', answer: decision('returned').answer });
});

it('does not invent elapsed time when persistent clock evidence is absent or invalid', () => {
  const source = task(); source.updatedAt = 'invalid'; source.activeSince = 20000;
  const audit = settleInterruptedClock(source, 10000, []); expect(source.usage.durationMs).toBe(100); expect(source.durationUncertainty?.additionalMsUpperBound).toBeNull(); expect(audit).toMatchObject({ countedMs: 0, exactStopTimeKnown: false });
  expect(settleInterruptedClock(source, 100000, [])).toBeUndefined(); expect(source.durationUncertainty?.interruptions).toBe(1);
  const missing = task(); delete missing.activeSince;
  expect(settleInterruptedClock(missing, 10000, [], true)).toMatchObject({ missingActiveSince: true, countedMs: 0, unmeasuredMs: { lowerBound: 0, upperBound: null } });
  expect(missing.usage.durationMs).toBe(100); expect(missing.durationUncertainty?.additionalMsUpperBound).toBeNull();
});

it('rolls back the entire interrupted pause repair if its audit cannot be committed', () => {
  vi.useFakeTimers(); vi.setSystemTime(2000); const path = file(), store = open(path), source = task(); store.save(source); store.decision(decision('returned')); const before = store.taskState('task');
  raw(store).exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON events WHEN json_extract(new.json,'$.type')='task.recovered' BEGIN SELECT RAISE(ABORT,'recovery rejected'); END;"); store.close(); vi.setSystemTime(100000);
  expect(() => new ExplorerStore(path)).toThrow('recovery rejected');
  // A second connection without invoking startup is only for the fixture audit.
  const audit = new DatabaseSync(path);
  try { const header = JSON.parse((audit.prepare('SELECT json FROM tasks').get() as { json: string }).json); expect(header.activeSince).toBe(1000); expect(header.usage.durationMs).toBe(100); expect((audit.prepare('SELECT version FROM tasks').get() as { version: string }).version).toBe(before.version); expect(JSON.parse((audit.prepare('SELECT json FROM decisions').get() as { json: string }).json).status).toBe('returned'); expect(audit.prepare('SELECT * FROM events').all()).toEqual([]); } finally { audit.close(); }
});

function gatedHost() {
  const observation = { id: 'o', sessionId: 's', instanceScope: 'instance', url: 'https://example.test/', context: {}, controls: [], regions: [], boundaries: [], gaps: [] } as unknown as Observation;
  let began!: () => void, finish!: (value: Observation) => void;
  const observed = new Promise<void>(resolve => { began = resolve; });
  const host = { events: new EventEmitter(), sessions: () => [{ id: 's', status: 'paused' }], session: () => ({ id: 's', actionCount: 2, elapsedMs: 0, currentObservationId: 'o', options: { maxActions: 100, maxDurationMs: 10000, executionPolicy: 'observed-ui' } }), observation: () => observation,
    observe: vi.fn(() => { began(); return new Promise<Observation>(resolve => { finish = resolve; }); }), createSession: vi.fn(() => { throw new Error('UNEXPECTED_SECOND_ROUND'); }), list: () => [], recoveryAssessment: () => ({ unknownAttempts: [] }), pause: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  for (const name of ['operationCoverageCandidates', 'actionAvailability', 'operationCorrespondences', 'explorationSnapshot', 'controlInterpretationSnapshot', 'boundaryState', 'interactionTransition', 'navigationIsolation', 'actions', 'execute', 'command', 'getFrontier', 'report', 'regionReviewMaterial', 'explorationReviewMaterial', 'controlClassificationMaterial', 'controlReviewMaterial', 'purposeReviewMaterial', 'discoveryScanMaterial', 'createCheckpoint', 'reachCheckpoint', 'pinEvidence', 'unpinEvidence']) Object.assign(host, { [name]: () => [] });
  return { host, observed, finish: () => finish?.(observation) };
}

it.each(['settled', 'interrupted'] as const)('starts a %s pause on the same round and persists new pause intent before waiting for in-flight observation', async mode => {
  vi.useFakeTimers(); vi.setSystemTime(2000); const path = file(), source = task(); let store = open(path);
  if (mode === 'settled') { delete source.activeSince; source.rounds[0].status = 'paused'; }
  source.plan = []; store.save(source);
  if (mode === 'interrupted') { store.close(); vi.setSystemTime(100000); store = open(path); }
  const before = store.task('task'), beganAt = Date.now();
  expect(before.usage.durationMs).toBe(mode === 'interrupted' ? 1100 : 100);
  const { host, observed, finish } = gatedHost();
  const plugin = new ExplorerPlugin(host as unknown as ExplorerHost, store);
  try {
    expect(() => plugin.start('task')).not.toThrow(); await observed; vi.setSystemTime(beganAt + 500); const pausing = plugin.pause('task');
    expect(store.task('task')).toMatchObject({ status: 'paused', reason: 'user_paused', activeSince: beganAt, pauseRequestedAt: beganAt + 500, rounds: [{ status: 'running' }] });
    vi.setSystemTime(beganAt + 700); finish(); await pausing;
    const settled = store.taskState('task'); expect(settled.task.usage).toEqual({ ...source.usage, durationMs: before.usage.durationMs + 700 }); expect(settled.task.activeSince).toBeUndefined(); expect(settled.task.pauseRequestedAt).toBeUndefined(); expect(settled.task.durationUncertainty).toEqual(before.durationUncertainty); expect(host.createSession).not.toHaveBeenCalled(); expect(settled.task.rounds).toHaveLength(1);
    await plugin.close(); vi.setSystemTime(beganAt + 100000); const reopened = open(path); expect(reopened.taskState('task')).toEqual(settled);
  } finally { finish(); await plugin.close(); }
});

it('still cancels in-flight work if persisting pause intent fails', async () => {
  const store = open(file()), source = task(); delete source.activeSince; source.rounds[0].status = 'paused'; source.plan = []; store.save(source);
  const { host, observed, finish } = gatedHost(), plugin = new ExplorerPlugin(host as unknown as ExplorerHost, store);
  try {
    plugin.start('task'); await observed;
    const controller = (plugin as unknown as { active: { controller: AbortController } }).active.controller;
    const abort = vi.fn(); controller.signal.addEventListener('abort', abort);
    const failure = Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); vi.spyOn(store, 'applyTaskDelta').mockImplementationOnce(() => { throw failure; });
    await expect(plugin.pause('task')).rejects.toBe(failure); expect(controller.signal.aborted).toBe(true); expect(abort).toHaveBeenCalledTimes(1);
    finish(); await plugin.waitForIdle(); expect(store.task('task').activeSince).toBeUndefined(); expect(host.createSession).not.toHaveBeenCalled();
  } finally { finish(); await plugin.close(); }
});
