import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import type { ActionAttempt, Observation } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { RetainedPersistence } from '@interaction/storage-retained';
import { ExplorerPlugin, ExplorerStore, type ExplorerHost, type TaskStatus, type Task } from '@interaction/explorer-plugin';
import { AcceptanceProgress, AcceptanceWindow, WindowBudgetExceeded, operationConditionCandidate, operationConditionAssessment, progressEvidenceWindow, watchProgressEvidence, classifyAcceptanceAttempt, newlyResolvedOccurrences, planResolutionChanges, createDiagnosticLogger, closeAcceptanceResources, settlePendingProviders, auditProtectedArtifact, settleOwnedTask, retainRecoveryResult, writeOwnedStopRequest, readOwnedStopRequest, pollOwnedStopRequests, type AcceptanceRunControl } from '../scripts/okx-storage-acceptance.js';

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

it.each(['target_missing', 'target_local_id_nonunique', 'target_identity_unresolved', 'target_identity_missing', 'action_target_identity_mismatch', 'target_conditions_unavailable'])('retains the actual source and %s reason without substituting a scheduling key', reason => {
  const o = observation(), a = attempt('audit');
  if (reason === 'target_missing') o.controls = [];
  if (reason === 'target_local_id_nonunique') o.controls.push(structuredClone(o.controls[0]));
  if (reason === 'target_identity_unresolved') o.controls[0].hypothesisId = 'review';
  if (reason === 'target_identity_missing') delete o.controls[0].identityId;
  if (reason === 'action_target_identity_mismatch') o.controls[0].identityId = 'another';
  if (reason === 'target_conditions_unavailable') o.context = { mode: { status: 'unknown', value: null, source: 'fixture' } };
  const assessment = operationConditionAssessment(a, o);
  expect(assessment).toMatchObject({ key: undefined, reason, evidence: { sessionId: 's', beforeId: 'o', observationId: 'o', actionId: a.action.id, localId: 'c0', controlId: 'i0' } });
  const progress = new AcceptanceProgress(row => operationConditionAssessment(row, o)); progress.record(a);
  expect(progress.snapshot().unkeyedSuccessfulAttempts).toMatchObject([{ attemptId: a.id, reason, evidence: assessment.evidence }]);
  expect(operationConditionCandidate(a, o)).toBeUndefined();
});

it('allows a full audit window of active exploration but neither new unkeyed nor keyed successes extend it', () => {
  const progress = new AcceptanceProgress(a => a.id === 'keyed' ? 'new-condition' : undefined, () => 10000);
  progress.record(attempt('first'));
  const window = (at: number) => progressEvidenceWindow(progress.snapshot(100), 100, 1000, at);
  expect(window(200)).toMatchObject({ status: 'pending', firstUnkeyedAt: 200, deadlineAt: 1200, elapsedMs: 0 });
  progress.record(attempt('second', 1, { finishedAt: new Date(800).toISOString() }));
  progress.record(attempt('keyed', 1, { finishedAt: new Date(1000).toISOString() }));
  expect(progress.snapshot().newOperationConditionCandidates).toBe(1);
  expect(window(1199)).toMatchObject({ status: 'pending', deadlineAt: 1200 });
  expect(window(1200)).toMatchObject({ status: 'audit_required', classification: 'progress_audit_required', deadlineAt: 1200, semanticCoverageEstablished: false, exhaustive: false });
  expect(progress.snapshot().counts).toEqual({ succeeded: 3 });
});

it('retains historical unkeyed audit debt with a full restart window without counting downtime or new successes', () => {
  const progress = new AcceptanceProgress(a => a.id === 'keyed' ? 'known' : undefined, () => 20000);
  progress.record(attempt('historical'), true); progress.record(attempt('keyed', 1, { finishedAt: new Date(10400).toISOString() }));
  const snapshot = progress.snapshot(10000);
  expect(snapshot).toMatchObject({ counts: { succeeded: 1 }, unkeyedSuccessfulAttemptIds: [], historicalUnkeyedSuccessfulAttempts: [{ attemptId: 'historical' }], progressGuardsDeferred: true });
  expect(progressEvidenceWindow(snapshot, undefined, 1000, 9000).status).toBe('inactive');
  expect(progressEvidenceWindow(snapshot, 10000, 1000, 10999)).toMatchObject({ status: 'pending', firstUnkeyedAt: 10000, deadlineAt: 11000, historicalAttemptIds: ['historical'] });
  expect(progressEvidenceWindow(snapshot, 10000, 1000, 11000).status).toBe('audit_required');
  progress.reconcile([attempt('historical'), attempt('keyed', 1)]);
  expect(progress.snapshot().historicalUnkeyedSuccessfulAttempts).toHaveLength(1);
  expect(progressEvidenceWindow(progress.snapshot(), 10000, 1000, 11000).status).toBe('audit_required');
});

it.each(['future', 'invalid'])('does not extend the audit deadline on %s timestamps or duplicate delivery', timestamp => {
  let now = 200;
  const progress = new AcceptanceProgress(() => undefined, () => now);
  const a = attempt('a', 0, { startedAt: 'invalid', finishedAt: timestamp === 'future' ? new Date(1000000).toISOString() : 'invalid' });
  progress.record(a); now = 900; progress.record(a); progress.reconcile([a]);
  expect(progressEvidenceWindow(progress.snapshot(), 100, 1000, 1199)).toMatchObject({ status: 'pending', firstUnkeyedAt: 200, deadlineAt: 1200 });
  expect(progressEvidenceWindow(progress.snapshot(), 100, 1000, 1200).status).toBe('audit_required');
});

it.each([undefined, 'invalid'])('starts the full review window when success lacks a valid completion time (%s), not at dispatch', finishedAt => {
  let now = 0;
  const progress = new AcceptanceProgress(() => undefined, () => now);
  const a = attempt('delayed', 0, { startedAt: new Date(0).toISOString(), status: 'executing', finishedAt: undefined });
  progress.record(a); now = 5000; progress.record({ ...a, status: 'succeeded', finishedAt });
  expect(progressEvidenceWindow(progress.snapshot(), 0, 1000, now)).toMatchObject({ status: 'pending', firstUnkeyedAt: 5000, deadlineAt: 6000 });
  now = 5900; progress.record({ ...a, status: 'succeeded', finishedAt });
  expect(progressEvidenceWindow(progress.snapshot(), 0, 1000, 6000).status).toBe('audit_required');
});

it.each([undefined, 'invalid', new Date(1000000).toISOString()])('does not manufacture later keyed progress from repeated success with completion time %s', finishedAt => {
  let now = 0;
  const progress = new AcceptanceProgress(() => 'same-key', () => now);
  const a = attempt('keyed', 0, { status: 'executing', startedAt: new Date(0).toISOString(), finishedAt: undefined });
  progress.record(a); now = 200; progress.record({ ...a, status: 'succeeded', finishedAt });
  expect(progress.snapshot().lastProgressAt).toBe(200);
  now = 900; progress.record({ ...a, status: 'succeeded', finishedAt }); progress.reconcile([{ ...a, status: 'succeeded', finishedAt }]);
  expect(progress.snapshot()).toMatchObject({ newOperationConditionCandidates: 1, lastProgressAt: 200, successfulAttemptIds: ['keyed'] });
});

it('recomputes audit debt from final attempt states while preserving unknown and in-flight blockers', () => {
  const progress = new AcceptanceProgress(() => undefined, () => 10000);
  const a = attempt('a'), b = attempt('b', 1, { finishedAt: new Date(600).toISOString() });
  progress.record(a); progress.record(b);
  const unknown = { ...a, status: 'unknown' as const }; progress.record(unknown);
  expect(progress.snapshot()).toMatchObject({ counts: { unknown: 1, succeeded: 1 }, successfulAttemptIds: ['b'], unknownAttempts: [{ attemptId: 'a', status: 'unknown' }] });
  expect(progressEvidenceWindow(progress.snapshot(), 100, 1000, 1200)).toMatchObject({ status: 'pending', firstUnkeyedAt: 600, deadlineAt: 1600 });
  progress.record({ ...b, status: 'executing' });
  expect(progress.snapshot()).toMatchObject({ unkeyedSuccessfulAttemptIds: [], inFlightAttempts: [{ attemptId: 'b', status: 'executing' }], unknownAttempts: [{ attemptId: 'a' }] });
  expect(progressEvidenceWindow(progress.snapshot(), 100, 1000, 1200).status).toBe('inactive');
  progress.record(a); // Later retained evidence explicitly reclassifies the same attempt.
  expect(progress.snapshot()).toMatchObject({ successfulAttemptIds: ['a'], unknownAttempts: [] });
  expect(progressEvidenceWindow(progress.snapshot(), 100, 1000, 1200).status).toBe('audit_required');
  progress.reconcile([unknown]);
  expect(progressEvidenceWindow(progress.snapshot(), 100, 1000, 5000).status).toBe('inactive');
  expect(progress.snapshot()).toMatchObject({ counts: { unknown: 1 }, unknownAttempts: [{ attemptId: 'a' }] });
});

it('requests audit once independently of sampling and can dispose the watcher before settlement', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const progress = new AcceptanceProgress(() => undefined); progress.record(attempt('first', 0, { finishedAt: new Date(0).toISOString() }));
  const stop = vi.fn(), read = () => progressEvidenceWindow(progress.snapshot(), 0, 3000), dispose = watchProgressEvidence(read, stop);
  try {
    await vi.advanceTimersByTimeAsync(2000); expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop).toHaveBeenCalledExactlyOnceWith('progress_evidence_unavailable_window', expect.objectContaining({ status: 'audit_required', deadlineAt: 3000, exhaustive: false }));
    await vi.advanceTimersByTimeAsync(10000); expect(stop).toHaveBeenCalledOnce();
    expect(progress.snapshot().counts).toEqual({ succeeded: 1 });
    dispose(); const second = watchProgressEvidence(read, stop); second();
    await vi.advanceTimersByTimeAsync(2000); expect(stop).toHaveBeenCalledOnce();
  } finally { dispose(); vi.useRealTimers(); }
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

it('separates renewed success evidence from newly solved occurrences after resume', async () => {
  const store = new ExplorerStore(':memory:'), host = { events: new EventEmitter(), async waitForIdle() {} }, plugin = new ExplorerPlugin(host as unknown as ExplorerHost, store);
  try {
    const task = plugin.create({ url: 'https://www.okx.com/convert/usd-to-btc', goal: '', coverageMode: 'all' });
    const item = { id: 'reused-business-id', title: 'Target', scope: { label: 'Target' }, prerequisites: [], completion: 'Observed success', required: true, reason: 'fixture', evidence: [], attempts: [] };
    task.plan = [
      { ...item, status: 'succeeded', resolvedBy: { sessionId: 'old-session', observationId: 'old-observation', attemptId: 'old-attempt' } },
      { ...item, status: 'succeeded' },
      { ...item, status: 'unresolved' }
    ] as Task['plan']; store.save(task);
    const before = store.taskState(task.id), { plan: _, rounds: __, ...header } = before.task;
    const resolved = (prior: Task['plan'][number]) => ({ ...prior, status: 'succeeded' as const, resolvedBy: { sessionId: 's', observationId: 'o', attemptId: 'new' } });
    store.applyTaskDelta(task.id, before.version, { header, plan: {
      update: before.plan.map((occurrenceId, index) => ({ occurrenceId, value: resolved(before.task.plan[index]) })),
      append: [{ occurrenceId: 'a'.repeat(32), value: resolved({ ...item, status: 'pending' } as Task['plan'][number]) }],
      order: [before.plan[2], before.plan[0], before.plan[1], 'a'.repeat(32)]
    } });
    const after = store.taskState(task.id), changes = planResolutionChanges(before, after);
    expect(changes.newlyResolved.map(row => row.occurrenceId)).toEqual([before.plan[2], after.plan[3]]);
    expect(changes.evidenceRefreshes.map(row => row.occurrenceId)).toEqual([before.plan[0], before.plan[1]]);
    expect(changes.evidenceRefreshes[0].previousResolvedBy?.attemptId).toBe('old-attempt');
    expect(newlyResolvedOccurrences(after, after)).toEqual([]);
    expect(planResolutionChanges(after, after).evidenceRefreshes).toEqual([]);
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

it.each(['reachCheckpoint', 'reachExplorationTarget', 'returnToObservedSource'] as const)('stops immediately on each non-successful %s outcome while preserving its evidence', api => {
  for (const status of ['UNVERIFIED', 'UNREACHABLE', 'PRECONDITIONS_CHANGED']) {
    const stop = vi.fn(), result = { status, reason: 'replay_target_not_unique_or_missing', attemptIds: ['recovery-attempt'], checks: [{ result: 'unknown' }] };
    expect(retainRecoveryResult(api, 'session', result, stop)).toBe(result);
    expect(stop).toHaveBeenCalledExactlyOnceWith('recovery_not_verified', { api, sessionId: 'session', result });
  }
  for (const status of api === 'reachCheckpoint' ? ['REACHED_VERIFIED', 'REACHED_ACCEPTABLE'] : api === 'returnToObservedSource' ? ['SOURCE_REACHED'] : ['TARGET_REACHED']) {
    const stop = vi.fn(), result = { status };
    expect(retainRecoveryResult(api, 'session', result, stop)).toBe(result); expect(stop).not.toHaveBeenCalled();
  }
  const stop = vi.fn();
  retainRecoveryResult(api, 'session', { status: api === 'returnToObservedSource' ? 'REACHED_VERIFIED' : 'SOURCE_REACHED' }, stop);
  expect(stop).toHaveBeenCalledOnce();
});

function stopFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'okx-stop-offline-')));
  const run: AcceptanceRunControl = { format: 'okx-storage-acceptance-v1', directory, owner: randomUUID(), taskId: 'fixture-task', runId: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), state: 'active' };
  const runDirectory = join(directory, 'runs', run.runId); mkdirSync(runDirectory, { recursive: true });
  const marker = { format: run.format, directory, owner: run.owner, taskId: run.taskId, createdAt: run.startedAt, url: 'https://www.okx.com/convert/usd-to-btc' };
  writeFileSync(join(directory, 'owner.json'), JSON.stringify(marker)); writeFileSync(join(directory, 'active-run.json'), JSON.stringify(run));
  return { directory, runDirectory, marker, run, close: () => rmSync(directory, { recursive: true, force: true }) };
}

it('accepts only its marked run stop request, retains it as evidence and ignores a previous invocation', () => {
  const fixture = stopFixture();
  try {
    expect(readOwnedStopRequest(fixture.run)).toBeUndefined();
    const request = writeOwnedStopRequest(fixture.directory);
    expect(readOwnedStopRequest(fixture.run)).toEqual(request);
    const next = { ...fixture.run, runId: randomUUID() }; mkdirSync(join(fixture.directory, 'runs', next.runId));
    writeFileSync(join(fixture.directory, 'active-run.json'), JSON.stringify(next));
    expect(readOwnedStopRequest(next)).toBeUndefined();
    expect(() => readOwnedStopRequest(fixture.run)).toThrow('STOP_CONTROL_OWNERSHIP_CHANGED');
    expect(JSON.parse(readFileSync(join(fixture.runDirectory, 'stop-request.json'), 'utf8'))).toEqual(request);
    writeFileSync(join(fixture.directory, 'active-run.json'), JSON.stringify({ ...next, state: 'finished' }));
    expect(() => writeOwnedStopRequest(fixture.directory)).toThrow('NO_ACTIVE_OWNED_RUN');
  } finally { fixture.close(); }
});

it('rejects foreign owner requests, ownership changes and symlink control files', () => {
  const fixture = stopFixture();
  try {
    const request = writeOwnedStopRequest(fixture.directory), path = join(fixture.runDirectory, 'stop-request.json');
    writeFileSync(path, JSON.stringify({ ...request, owner: randomUUID() }));
    expect(() => readOwnedStopRequest(fixture.run)).toThrow('STOP_REQUEST_OWNERSHIP_MISMATCH');
    writeFileSync(join(fixture.directory, 'owner.json'), JSON.stringify({ ...fixture.marker, owner: randomUUID() }));
    expect(() => writeOwnedStopRequest(fixture.directory)).toThrow('NOT_OWNED_RUN_DIRECTORY');
    writeFileSync(join(fixture.directory, 'owner.json'), JSON.stringify(fixture.marker));
    rmSync(path); symlinkSync(join(fixture.directory, 'owner.json'), path);
    expect(() => readOwnedStopRequest(fixture.run)).toThrow('INVALID_STOP_CONTROL_FILE');
  } finally { fixture.close(); }
});

it('polls stop requests independently of slow metrics and only requests settlement once', async () => {
  const fixture = stopFixture(); vi.useFakeTimers(); const stop = vi.fn();
  const dispose = pollOwnedStopRequests(fixture.run, stop);
  try {
    const request = writeOwnedStopRequest(fixture.directory);
    await vi.advanceTimersByTimeAsync(5000);
    expect(stop).toHaveBeenCalledExactlyOnceWith('operator_stop_request', request);
  } finally { dispose(); vi.useRealTimers(); fixture.close(); }
});

it.each(['direct-node-signal', 'tsx-cli-signal', 'direct-node-stop-file'] as const)('settles delayed work and writes summary before exit using %s without a browser/provider', async mode => {
  const fixture = stopFixture(), script = join(fixture.directory, 'child.mts'), summary = join(fixture.directory, 'summary.json');
  const harness = new URL('../scripts/okx-storage-acceptance.ts', import.meta.url).href;
  writeFileSync(script, `
import { writeFileSync } from 'node:fs';
import { installAcceptanceStopSignals, settleOwnedTask, pollOwnedStopRequests } from ${JSON.stringify(harness)};
const run = ${JSON.stringify(fixture.run)}; run.pid = process.pid;
writeFileSync(${JSON.stringify(join(fixture.directory, 'active-run.json'))}, JSON.stringify(run));
const hold = setInterval(() => {}, 1000);
let job, stopPolling; const order = [];
const otherSignal = () => { order.push('other.signal'); ${mode === 'direct-node-stop-file' ? 'process.exit(130);' : ''} };
process.on('SIGINT', otherSignal);
const stop = reason => {
  if (job) return;
  order.push('stop.requested');
  job = settleOwnedTask({ owner: () => run.taskId, pause: async () => { await new Promise(r => setTimeout(r, 150)); order.push('pause.settled'); }, waitForIdle: async () => { order.push('plugin.idle'); } }, { waitForIdle: async () => { await new Promise(r => setTimeout(r, 50)); order.push('host.idle'); } }, run.taskId).then(() => {
    order.push('stop.settled'); removeSignals(); stopPolling?.();
    writeFileSync(${JSON.stringify(summary)}, JSON.stringify({ reason, order, otherListenerRetained: process.listeners('SIGINT').includes(otherSignal) }));
    console.log('summary'); clearInterval(hold);
  });
};
const removeSignals = installAcceptanceStopSignals(stop);
stopPolling = pollOwnedStopRequests(run, stop, 20);
console.log(JSON.stringify({ ready: true, pid: process.pid }));
`);
  const require = createRequire(import.meta.url), cli = require.resolve('tsx/cli');
  const child = spawn(process.execPath, mode === 'tsx-cli-signal' ? [cli, '--conditions=development', script] : ['--import', require.resolve('tsx'), '--conditions=development', script], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '', fixturePid: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal }));
      child.stdout.on('data', value => {
        output += value; const ready = output.match(/\{"ready":true,"pid":(\d+)\}/);
        if (!ready || fixturePid !== undefined) return;
        fixturePid = Number(ready[1]);
        try {
          if (mode === 'direct-node-stop-file') {
            const queued = JSON.parse(execFileSync(process.execPath, ['--import', require.resolve('tsx'), '--conditions=development', fileURLToPath(harness), '--dir', fixture.directory, '--request-stop'], { encoding: 'utf8', timeout: 5000 }));
            expect(queued).toMatchObject({ type: 'stop.request.queued', runId: fixture.run.runId, owner: fixture.run.owner, settlementPending: true });
          } else process.kill(fixturePid, 'SIGINT');
        } catch (error) { reject(error); }
      });
      child.stderr.on('data', value => { stderr += value; });
      timer = setTimeout(() => reject(new Error('CHILD_SETTLEMENT_TIMEOUT')), 10000);
    });
    expect(await completion, stderr).toEqual({ code: 0, signal: null }); expect(output).toContain('summary');
    const result = JSON.parse(readFileSync(summary, 'utf8'));
    expect(result).toEqual({ reason: mode === 'direct-node-stop-file' ? 'operator_stop_request' : 'operator_signal', order: [...(mode === 'direct-node-stop-file' ? [] : ['other.signal']), 'stop.requested', 'pause.settled', 'plugin.idle', 'host.idle', 'stop.settled'], otherListenerRetained: true });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      if (fixturePid) { try { process.kill(fixturePid, 'SIGKILL'); } catch { /* Already exited. */ } }
      child.kill('SIGKILL');
    }
    fixture.close();
  }
});
