import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ActionAttempt, Observation } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { RetainedPersistence } from '@interaction/storage-retained';
import { ExplorerPlugin, ExplorerStore, type ExplorerHost, type TaskStatus, type Task } from '@interaction/explorer-plugin';
import { AcceptanceProgress, AcceptanceWindow, WindowBudgetExceeded, operationConditionCandidate, classifyAcceptanceAttempt, newlyResolvedOccurrences, createDiagnosticLogger, closeAcceptanceResources, settlePendingProviders, auditProtectedArtifact, settleOwnedTask } from '../scripts/okx-storage-acceptance.js';

it('audits retained bytes and media type without starting providers or a browser', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'okx-audit-offline-'));
  const raw = new SqliteStore(directory), retained = new RetainedPersistence(raw, { sweepIntervalMs: 0 });
  try {
    await retained.evidence.beginObservation({ sessionId: 's', observationId: 'o', policy: { mode: 'persistent', ttlMs: 0, maxBytes: 1024, maxObservations: 10 } });
    const artifact = { data: new TextEncoder().encode('retained evidence'), mediaType: 'text/plain' };
    await retained.evidence.put('artifact', artifact);
    await expect(auditProtectedArtifact(raw, 'artifact')).resolves.toBeUndefined();
    await raw.evidence.put('artifact', { ...artifact, mediaType: 'application/octet-stream' });
    await expect(auditProtectedArtifact(raw, 'artifact')).rejects.toMatchObject({ code: 'PROTECTED_EVIDENCE_UNAVAILABLE' });
    await raw.evidence.delete!('artifact');
    await expect(auditProtectedArtifact(raw, 'artifact')).rejects.toMatchObject({ code: 'PROTECTED_EVIDENCE_UNAVAILABLE' });
  } finally { await retained.evidence.flush(); retained.close(); rmSync(directory, { recursive: true, force: true }); }
});

it.each(['completed', 'blocked', 'budget_exhausted', 'paused'] satisfies TaskStatus[])('preserves an inactive %s task and its original reason', async status => {
  const store = new ExplorerStore(':memory:');
  // No engine/provider is constructed; these methods are the only idle-settle dependencies.
  const host = { events: new EventEmitter(), async waitForIdle() {} };
  const plugin = new ExplorerPlugin(host as unknown as ExplorerHost, store);
  try {
    const task = plugin.create({ url: 'https://www.okx.com/convert/usd-to-btc', goal: '', coverageMode: 'all' });
    store.save({ ...task, status, reason: 'original_cause', pendingDispatch: { sessionId: 's', requestId: 'unknown', itemIds: [], observationId: 'o', actionId: 'a' } });
    const before = store.task(task.id);
    await settleOwnedTask(plugin, host, task.id);
    expect(store.task(task.id)).toEqual(before);
  } finally { await plugin.close(); }
});

function observation(): Observation {
  return { id: 'o', sessionId: 's', url: 'https://www.okx.com/convert/usd-to-btc', context: {}, gaps: [], regions: [], components: [], boundaries: [], overlays: [],
    controls: ['First', 'Second'].map((name, index) => ({ localId: `c${index}`, identityId: `i${index}`, stableKey: `id:${index}`, tag: 'button', role: 'button', name, label: name,
      region: 'main', form: '', visible: true, enabled: true, checked: null, pressed: null, expanded: null, selected: [], constraints: { type: 'button', valid: true }, actions: ['click'] })) } as unknown as Observation;
}
function attempt(id: string, target = 0, overrides: Partial<ActionAttempt> = {}): ActionAttempt {
  const o = observation(), c = o.controls[target];
  return { id, sessionId: 's', requestId: id, beforeId: 'o', afterId: 'after', startedAt: new Date(100).toISOString(), finishedAt: new Date(200).toISOString(), status: 'succeeded', purpose: 'external', executionProfile: 'interface-exploration',
    action: { id: `a-${id}`, sessionId: 's', observationId: 'o', stateId: 'state', kind: 'click', controlId: c.identityId, localId: c.localId, label: c.label, source: 'fixture', risk: 'interface', replayable: true, excluded: false, sampleValidity: 'known', preconditions: { context: {}, visible: true, enabled: true, identityResolved: true } }, ...overrides };
}
const metrics = () => new AcceptanceProgress(a => operationConditionCandidate(a, observation()));

it('distinguishes targets but not repeated discoveries of one target, without claiming semantic uniqueness', () => {
  const a = attempt('a'), repeated = attempt('repeated'), b = attempt('b', 1);
  expect(operationConditionCandidate(a, observation())).toBe(operationConditionCandidate(repeated, observation()));
  expect(operationConditionCandidate(a, observation())).not.toBe(operationConditionCandidate(b, observation()));
  const progress = metrics(); progress.record(a); progress.record(repeated); progress.record(b);
  expect(progress.snapshot()).toMatchObject({ counts: { succeeded: 3 }, newOperationConditionCandidates: 2, progressGuardsDeferred: false });
});

it('uses one classification for resume and live recovery, probes and necessary reentry', () => {
  const recovery = attempt('recovery', 0, { purpose: 'recovery' }), probe = attempt('probe', 0, { executionProfile: 'observed-ui-probe' });
  const reentry = attempt('entry', 0, { repetitionSource: { sessionId: 's', attemptId: 'old' } });
  const resumed = metrics(), live = metrics();
  for (const row of [recovery, probe, reentry]) { resumed.record(row, true); live.record(row); }
  expect(classifyAcceptanceAttempt(reentry)).toEqual({ exploration: true, reentry: true, leaf: false });
  expect(live.snapshot().newOperationConditionCandidates).toBe(0);
  const leaf = attempt('leaf'); resumed.record(leaf); live.record(leaf);
  expect(resumed.snapshot().conditionKeys).toEqual(live.snapshot().conditionKeys);
  expect(resumed.snapshot().newOperationConditionCandidates).toBe(1);
  const priorLeaf = metrics(); priorLeaf.record(leaf, true); priorLeaf.record(attempt('same-leaf'));
  expect(priorLeaf.snapshot().newOperationConditionCandidates).toBe(0);
});

it('retracts success and progress when the same attempt later becomes unknown, with final-ledger reconciliation', () => {
  const progress = metrics(), a = attempt('a'); progress.record(a); progress.record(a);
  expect(progress.snapshot(100).counts).toEqual({ succeeded: 1 });
  expect(progress.snapshot(100).lastProgressAt).toBe(200);
  const unknown = { ...a, status: 'unknown' as const, finishedAt: new Date(300).toISOString() };
  progress.record(unknown);
  expect(progress.snapshot(100)).toMatchObject({ counts: { unknown: 1 }, successfulAttemptIds: [], newOperationConditionCandidates: 0, lastProgressAt: 100, unknownAttempts: [{ sessionId: 's', attemptId: 'a', status: 'unknown' }] });
  progress.record(attempt('second', 1));
  progress.reconcile([unknown]); // The final source ledger supersedes stale callback state.
  expect(progress.snapshot().successfulAttemptIds).toEqual([]);
  expect(progress.snapshot().counts).toEqual({ unknown: 1 });
});

it('does not refresh the progress clock for repeated successes under the same candidate key', () => {
  const progress = metrics(); progress.record(attempt('a')); progress.record(attempt('repeat', 0, { finishedAt: new Date(900).toISOString() }));
  expect(progress.snapshot(100).lastProgressAt).toBe(200);
  progress.record(attempt('other', 1, { finishedAt: new Date(400).toISOString() }));
  expect(progress.snapshot(100).lastProgressAt).toBe(400);
});

it('reports a normal live executing attempt as in flight rather than unknown', () => {
  const progress = metrics(), running = attempt('running', 0, { status: 'executing', finishedAt: undefined });
  progress.record(running);
  expect(progress.snapshot()).toMatchObject({ counts: { executing: 1 }, unknownAttempts: [], inFlightAttempts: [{ sessionId: 's', attemptId: 'running', status: 'executing' }] });
  progress.record({ ...running, status: 'succeeded', finishedAt: new Date(250).toISOString() });
  expect(progress.snapshot()).toMatchObject({ counts: { succeeded: 1 }, unknownAttempts: [], inFlightAttempts: [] });
});

it.each(['missing-target', 'identity-pending', 'conditions-unavailable'])('reports %s success as unkeyed and defers progress guards', missing => {
  const o = observation();
  if (missing === 'missing-target') o.controls = [];
  else if (missing === 'identity-pending') o.controls[0].hypothesisId = 'needs-review';
  else o.context = { mode: { status: 'unknown', value: null, source: 'fixture' } };
  const progress = new AcceptanceProgress(a => operationConditionCandidate(a, o)), a = attempt('unkeyed'); progress.record(a);
  expect(progress.snapshot()).toMatchObject({ successfulAttemptIds: ['unkeyed'], unkeyedSuccessfulAttemptIds: ['unkeyed'], newOperationConditionCandidates: 0, progressGuardsDeferred: true });
  progress.record({ ...a, status: 'unknown' });
  expect(progress.snapshot()).toMatchObject({ successfulAttemptIds: [], unkeyedSuccessfulAttemptIds: [], progressGuardsDeferred: false });
});

it('counts newly resolved duplicate business IDs independently using persisted occurrence handles', async () => {
  const store = new ExplorerStore(':memory:'), host = { events: new EventEmitter(), async waitForIdle() {} }, plugin = new ExplorerPlugin(host as unknown as ExplorerHost, store);
  try {
    const task = plugin.create({ url: 'https://www.okx.com/convert/usd-to-btc', goal: '', coverageMode: 'all' });
    const item = { id: 'same-business-id', title: 'Target', scope: { label: 'Target' }, prerequisites: [], completion: 'Observed success', required: true, reason: 'fixture', evidence: [], attempts: [] };
    task.plan = [{ ...item, status: 'succeeded', resolvedBy: { sessionId: 's', observationId: 'o', attemptId: 'old' } }, { ...item, status: 'pending' }] as Task['plan']; store.save(task);
    const before = store.taskState(task.id), { plan: _, rounds: __, ...header } = before.task;
    store.applyTaskDelta(task.id, before.version, { header, plan: { update: [{ occurrenceId: before.plan[1], value: { ...before.task.plan[1], status: 'succeeded', resolvedBy: { sessionId: 's', observationId: 'o', attemptId: 'new' } } }], order: [before.plan[1], before.plan[0]] } });
    const result = newlyResolvedOccurrences(before, store.taskState(task.id));
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ occurrenceId: before.plan[1], position: 0, item: { id: 'same-business-id', resolvedBy: { attemptId: 'new' } } });
  } finally { await plugin.close(); }
});

it('enforces provider/session entry allowances without changing cumulative budgets and reports action/time overshoot', () => {
  let now = 0; const budget = { rounds: 1, actions: 1, modelRequests: 1, durationMs: 1000 }, original = structuredClone(budget), window = new AcceptanceWindow(budget, () => now);
  window.start(); window.enter('provider'); window.enter('round');
  expect(() => window.enter('provider')).toThrow(WindowBudgetExceeded);
  expect(() => window.enter('round')).toThrow(WindowBudgetExceeded);
  window.actionStarted('a'); window.actionStarted('a'); window.actionStarted('internal-recovery-b');
  now = 1200; expect(() => window.enter('provider')).toThrow(WindowBudgetExceeded); window.finish(); now = 2000;
  expect(window.snapshot()).toMatchObject({ usage: { actions: 2, modelRequests: 1, rounds: 1, durationMs: 1200 }, overshoot: { actions: 1, modelRequests: 0, rounds: 0, durationMs: 200 } });
  expect(budget).toEqual(original);
});

it('contains diagnostic I/O failure and schedules settlement once even when failure handling logs again', async () => {
  let pauseCount = 0, settled: Promise<void> | undefined;
  const diagnostics = createDiagnosticLogger(() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }, () => {
    settled = Promise.resolve().then(() => { pauseCount++; });
    diagnostics.log('stop.requested', {});
  });
  const events = new EventEmitter(); events.on('event', () => diagnostics.log('attempt.completed', {}));
  expect(() => events.emit('event')).not.toThrow(); expect(() => events.emit('event')).not.toThrow();
  await settled; expect(pauseCount).toBe(1); expect(diagnostics.failure).toMatchObject({ code: 'ENOSPC' });
});

it('closes independent resources even when earlier closes and failure diagnostics throw', async () => {
  const closed: string[] = [];
  await closeAcceptanceResources(['metrics', 'plugin', 'host', 'store', 'lock'].map(name => ({ name, close: async () => { closed.push(name); if (name === 'metrics' || name === 'plugin') throw new Error('CLOSE_FAILED'); } })), () => { throw new Error('ENOSPC'); });
  expect(closed).toEqual(['metrics', 'plugin', 'host', 'store', 'lock']);
});

it('waits for an underlying delayed request after cancellation without declaring it failed or complete early', async () => {
  const pending = new Map<string, Promise<unknown>>(); let reject!: (error: Error) => void, cancelled = 0;
  const raw = new Promise((_, fail) => { reject = fail; });
  const tracked = raw.catch(() => { cancelled++; }).finally(() => pending.delete('request'));
  pending.set('request', tracked);
  const settlement = settlePendingProviders(pending, 1000); let done = false; void settlement.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  expect(await settlement).toMatchObject({ settled: true, remainingPendingRequestIds: [] }); expect(cancelled).toBe(1);
});

it('bounds waiting for a request that ignores cancellation and explicitly reports its ID', async () => {
  vi.useFakeTimers();
  try {
    const pending = new Map<string, Promise<unknown>>([['ignored-abort', new Promise(() => {})]]);
    const settlement = settlePendingProviders(pending, 5000); await vi.advanceTimersByTimeAsync(5000);
    expect(await settlement).toMatchObject({ settled: false, remainingPendingRequestIds: ['ignored-abort'], waitLimitMs: 5000 });
  } finally { vi.useRealTimers(); }
});
