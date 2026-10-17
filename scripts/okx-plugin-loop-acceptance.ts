/** One owned, bounded plugin continuation. Importing this module does not run it.
 * No task edits, action selection, input replacement, or SDK result rewriting.
 */
import assert from 'node:assert/strict';
import { appendFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BrowserEngine, type ActionAttempt } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin, ExplorerStore, providersFromEnv, safeError, type ExplorerEvent, type PlanItem, type Provider } from '@interaction/explorer-plugin';
import { matches } from '../packages/explorer-plugin/src/policy.js';
import { acceptanceHost, observeRecoveryCall, settleOwnedTask, settlePendingProviders, closeAcceptanceResources,
  installAcceptanceStopSignals, AcceptanceWindow, planResolutionChanges, type AcceptanceCallMetric } from './okx-storage-acceptance.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVIDENCE_ROOT = join(ROOT, 'docs/experiments/storage-tiering-2026-10-17/evidence');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(code) ? code : safeError(error);
};
type Data = Record<string, any>; // SDK event variants are retained verbatim, never interpreted as executable instructions.
type Recovery = { selected: Data; selectedSequence: number; baseline?: PlanItem; occurrenceId?: string; result?: Data; resultSequence?: number };
type Dispatch = { sessionId: string; actionId: string; requestId: string; guard: unknown; value: unknown; selected: Data;
  scheduled: Data; recovery?: Recovery; correspondence?: unknown; correspondenceVerified: boolean; receipt?: ActionAttempt };

export async function runPluginLoopAcceptance(argv: string[]) {
  assert.ok(argv.length === 2 || argv.length === 4); assert.equal(argv[0], '--run');
  if (argv.length === 4) assert.equal(argv[2], '--evidence');
  const OUT = argv.length === 4 ? resolve(argv[3]) : join(EVIDENCE_ROOT, 'plugin-loop-1');
  assert.equal(dirname(OUT), EVIDENCE_ROOT); assert.match(basename(OUT), /^plugin-loop-[1-9][0-9]*$/);
  const began = performance.now(), elapsed = () => performance.now() - began;
  const write = (name: string, value: unknown) => writeFileSync(join(OUT, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const log = (type: string, data: unknown) => appendFileSync(join(OUT, 'timeline.jsonl'), JSON.stringify({ at: new Date().toISOString(), elapsedMs: elapsed(), type, data }) + '\n', { mode: 0o600 });
  const prep = JSON.parse(readFileSync(join(OUT, 'preparation.json'), 'utf8')) as Data;
  const directory = resolve(argv[1]);
  assert.equal(directory, prep.destination); assert.notEqual(directory, prep.source);
  assert.equal(realpathSync(directory), directory); assert.equal(lstatSync(directory).isSymbolicLink(), false);
  assert.equal(resolve(directory, '..'), join(ROOT, '.data'));
  assert.equal(prep.pluginDatabaseCopied, true); assert.equal(prep.sourceUnchangedAfterPreparation, true);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(revision, prep.productCommit);
  for (const relative of ['engine', 'plugin', 'engine/engine.sqlite', 'plugin/explorer.sqlite']) {
    const path = join(directory, relative), stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false); assert.equal(realpathSync(path), path);
    if (stat.isFile()) assert.equal(stat.nlink, 1, 'Mutable databases must be independent byte copies');
  }
  const marker = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')) as Data;
  assert.equal(marker.format, 'okx-storage-acceptance-v1'); assert.equal(marker.directory, directory);
  assert.equal(typeof marker.taskId, 'string'); assert.ok(marker.taskId); assert.equal(typeof marker.owner, 'string');
  assert.equal(new URL(marker.url).hostname, 'www.okx.com'); assert.equal(new URL(marker.url).protocol, 'https:');
  const taskId = marker.taskId as string;
  // Exclusive admission belongs to this new directory and this evidence set.
  writeFileSync(join(directory, 'plugin-loop-invocation.json'), JSON.stringify({ taskId, owner: marker.owner, revision, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  write('invocation.json', { directory, source: prep.source, taskId, productCommit: revision, limitMs: 240000, internalStopMs: 235000,
    runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))), protocolSha256: sha(readFileSync(join(OUT, 'protocol.json'))),
    importedInstrumentationSha256: sha(readFileSync(join(ROOT, 'scripts/okx-storage-acceptance.ts'))), providerValuesRecorded: false });

  let engine: BrowserEngine | undefined, engineStore: SqliteStore | undefined, store: ExplorerStore | undefined, plugin: ExplorerPlugin | undefined;
  let before: ReturnType<ExplorerStore['taskState']> | undefined, after: ReturnType<ExplorerStore['taskState']> | undefined;
  let stopping = false, stopJob: Promise<void> | undefined, fatal: string | undefined, closed = false, started = false;
  let loop: Data | undefined, activeRecovery: Recovery | undefined, currentSelection: Data | undefined;
  const guards: Data[] = [], recoveries: Data[] = [], newAttempts = new Map<string, ActionAttempt>();
  let pluginEventCount = 0;
  const baselineAttempts = new Set<string>(), baselinePending = new Map<string, { item: PlanItem; occurrenceId: string }>();
  const sessions = new Set<string>(), scheduled = new Map<string, Data>(), dispatches = new Map<string, Dispatch>();
  const pendingProviders = new Map<string, Promise<unknown>>(), hostCalls: Record<string, AcceptanceCallMetric> = {};
  let lastMetricsAt = 0;
  const checkpointMetrics = () => {
    if (elapsed() - lastMetricsAt < 1000) return;
    lastMetricsAt = elapsed(); log('host.metrics', { hostCalls, providerCounts });
  };
  const providerCounts = { jev: { started: 0, returned: 0, failed: 0, cancelled: 0, elapsedMs: 0 }, llm: { started: 0, returned: 0, failed: 0, cancelled: 0, elapsedMs: 0 } };
  const budget = new AcceptanceWindow({ rounds: 1, actions: 20, modelRequests: 80, durationMs: 235000 }, elapsed);
  budget.start();
  const requestStop = (reason: string, details?: unknown) => {
    guards.push({ reason, details, elapsedMs: elapsed() });
    if (stopping) return;
    stopping = true;
    stopJob = Promise.resolve().then(async () => {
      if (plugin && engine) await settleOwnedTask(plugin, engine, taskId);
      else if (engine) await engine.waitForIdle();
      budget.finish(); log('stop.settled', { reason });
    }).catch(error => { fatal ||= errorCode(error); log('stop.failed', { code: fatal }); });
    log('stop.requested', { reason, details });
  };
  const fence = () => {
    if (stopping || elapsed() >= 235000) {
      if (!stopping) requestStop('window_time_budget');
      throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
    }
  };
  const removeSignals = installAcceptanceStopSignals(requestStop);
  const timer = setTimeout(() => requestStop('window_time_budget'), Math.max(0, 235000 - elapsed()));
  const provider = (actor: 'jev' | 'llm', source: Provider): Provider => ({ ...source, async decide(request, signal) {
    fence(); budget.enter('provider'); const began = elapsed(), count = providerCounts[actor]; count.started++;
    try {
      const call = source.decide(request, signal); pendingProviders.set(request.id, call);
      const answer = await call; count.returned++; return answer;
    } catch (error) {
      if (signal.aborted) count.cancelled++; else { count.failed++; requestStop('provider_failure', { actor, code: errorCode(error) }); }
      throw error;
    } finally { count.elapsedMs += elapsed() - began; pendingProviders.delete(request.id); }
  } });

  const verifyLoop = (event: ExplorerEvent) => {
    if (stopping || !engine || !engineStore || !store || !before) return;
    const data = event.data as Data, dispatch = dispatches.get(data.requestId), recovery = dispatch?.recovery;
    if (!dispatch || !recovery?.result || !recovery.baseline || !recovery.occurrenceId || !dispatch.receipt) return;
    const itemId = recovery.baseline.id, result = recovery.result, receipt = dispatch.receipt;
    if (dispatch.selected.selectedItemId !== itemId || !dispatch.scheduled.itemIds?.includes(itemId)) return;
    const header = store.taskHeader(taskId), rows = store.taskItems(taskId, 'plan', { occurrenceIds: [recovery.occurrenceId], expectedVersion: header.version, limit: 2 });
    const item = rows.items[0]?.value;
    const condition = engine.operationReceiptCondition(receipt.sessionId, { attemptId: receipt.id });
    const assessment = engine.recoveryAssessment(receipt.sessionId);
    const durable = engineStore.get<ActionAttempt>('attempt', receipt.id);
    const beforeObservation = engine.observation(receipt.sessionId, receipt.beforeId), afterObservation = receipt.afterId ? engine.observation(receipt.sessionId, receipt.afterId) : undefined;
    const guard = dispatch.guard as Data | undefined;
    const checks = {
      samePendingItem: item?.id === itemId && rows.items.length === 1 && dispatch.correspondenceVerified,
      boundRecovery: result.sessionId === receipt.sessionId && (!result.checkpointId || result.checkpointId === recovery.selected.checkpointId)
        && (!result.targetObservationId || result.targetObservationId === recovery.selected.sourceObservationId)
        && (!result.sourceObservationId || result.sourceObservationId === recovery.selected.sourceObservationId),
      actualRecovery: result.attemptIds.length > 0 && result.attemptIds.some((id: string) => engineStore!.get<ActionAttempt>('attempt', id)?.status === 'succeeded'),
      actualNewAttempt: !baselineAttempts.has(receipt.id) && receipt.status === 'succeeded' && receipt.purpose !== 'recovery' && !receipt.repetitionSource,
      guarded: guard?.observationId === receipt.beforeId && ['interface-exploration', 'observed-ui-exploration'].includes(guard?.profile)
        && receipt.executionProfile === guard?.profile,
      boundDispatch: receipt.requestId === dispatch.requestId && receipt.sessionId === dispatch.sessionId && receipt.action.id === dispatch.actionId
        && data.attemptId === receipt.id && data.actionId === receipt.action.id
        && dispatch.selected.actionId === receipt.action.id && dispatch.selected.reentry === false
        && dispatch.scheduled.actionId === receipt.action.id && dispatch.scheduled.requestId === receipt.requestId && dispatch.scheduled.purpose === 'target'
        && receipt.action.observationId === receipt.beforeId && matches(recovery.baseline.scope, receipt.action, beforeObservation),
      durable: !!durable && JSON.stringify(durable) === JSON.stringify(receipt),
      observed: !!afterObservation && receipt.afterId === afterObservation.id && !beforeObservation.gaps.some(g => g.critical) && !afterObservation.gaps.some(g => g.critical),
      clean: !assessment.dirty && assessment.unknownAttempts.length === 0 && !header.header.pendingDispatch
        && !header.header.unverifiedRecoveries?.length && !header.header.unverifiedNavigations?.length,
      completed: item?.status === 'succeeded' && item.resolvedBy?.attemptId === receipt.id && item.conditionCompletion?.status === 'verified'
        && item.conditionCompletion.source?.attemptId === receipt.id && item.attempts.some(a => a.outcome === 'succeeded' && a.evidence?.attemptId === receipt.id),
      receiptConditions: condition.actualSuccess && condition.conditionVerified,
    };
    log('loop.candidate', { itemId, occurrenceId: recovery.occurrenceId, attemptId: receipt.id, checks, condition, assessment });
    if (!Object.values(checks).every(Boolean)) return;
    loop = { itemId, occurrenceId: recovery.occurrenceId, selectedSequence: recovery.selectedSequence, resultSequence: recovery.resultSequence,
      actionVerifiedSequence: event.sequence, recovery: result, dispatch: { ...dispatch, recovery: undefined }, receipt, condition, assessment,
      itemBefore: recovery.baseline, itemAfter: item, persistedTaskVersion: header.version, checks, elapsedMs: elapsed() };
    write('loop.json', loop); requestStop('plugin_loop_verified', { itemId, attemptId: receipt.id });
  };

  let providerSettlement: Awaited<ReturnType<typeof settlePendingProviders>> | undefined;
  try {
    const configured = providersFromEnv();
    if (!configured.jev || !configured.llm) throw Object.assign(new Error('CONFIGURATION_REQUIRED'), { code: 'CONFIGURATION_REQUIRED' });
    fence(); engineStore = new SqliteStore(join(directory, 'engine')); store = new ExplorerStore(join(directory, 'plugin/explorer.sqlite'));
    engine = new BrowserEngine({ persistence: engineStore });
    before = store.taskState(taskId);
    write('task-before.json', before.task); write('plan-occurrences-before.json', before.plan);
    assert.equal(before.task.url, marker.url); assert.equal(before.task.goal, ''); assert.equal(before.task.coverageMode, 'all');
    assert.ok(!['running', 'completed'].includes(before.task.status));
    assert.ok(!before.task.pendingDispatch && !before.task.unverifiedRecoveries?.length && !before.task.unverifiedNavigations?.length);
    const itemCounts = new Map<string, number>();
    for (const item of before.task.plan) itemCounts.set(item.id, (itemCounts.get(item.id) || 0) + 1);
    before.task.plan.forEach((item, index) => {
      if (item.required && item.scope.kind && ['pending', 'untested', 'blocked', 'unresolved'].includes(item.status)
        && itemCounts.get(item.id) === 1 && !item.resolvedBy && !item.coverageResolvedBy && !item.reviewResolvedBy
        && !item.attempts.some(a => ['succeeded', 'unknown', 'executing'].includes(a.outcome)))
        baselinePending.set(item.id, { item: structuredClone(item), occurrenceId: before!.plan[index] });
    });
    for (const round of before.task.rounds) sessions.add(round.sessionId);
    for (const sid of sessions) {
      const assessment = engine.recoveryAssessment(sid); assert.ok(!assessment.dirty && assessment.unknownAttempts.length === 0);
      for (const attempt of engine.list<ActionAttempt>(sid, 'attempt')) { assert.ok(!['unknown', 'executing'].includes(attempt.status)); baselineAttempts.add(attempt.id); }
    }
    write('preflight.json', { candidateItemCount: baselinePending.size, priorBudget: before.task.budget, priorUsage: before.task.usage,
      candidateItemIds: [...baselinePending.keys()], taskId, taskStatus: before.task.status, baselineAttemptCount: baselineAttempts.size,
      taskBudgetUnchanged: true, permissionsUnchanged: true, failureDebtUnchangedByHarness: true });
    if (!baselinePending.size) throw Object.assign(new Error('NO_RETAINED_UNEXECUTED_OPERATION'), { code: 'NO_RETAINED_UNEXECUTED_OPERATION' });
    const raw = engine;
    const entries: Partial<BrowserEngine> = {
      // Flush aggregate counters at read boundaries even when synchronous work
      // prevents timers and final cleanup from running before the hard limit.
      observation: (...args) => { checkpointMetrics(); return raw.observation(...args); },
      createSession: async (...args) => { fence(); budget.enter('round'); const result = await raw.createSession(...args); sessions.add(result.id); return result; },
      execute: async (...args) => {
        fence(); const [sessionId, actionId, requestId, value, guard] = args;
        const schedule = scheduled.get(requestId), selection = currentSelection;
        const dispatch: Dispatch = { sessionId, actionId, requestId, value, guard, selected: selection || {}, scheduled: schedule || {}, correspondenceVerified: false };
        if (activeRecovery?.result && activeRecovery.baseline && selection?.selectedItemId === activeRecovery.baseline.id && schedule?.itemIds?.includes(activeRecovery.baseline.id)) {
          dispatch.recovery = activeRecovery;
          try {
            const sourceId = activeRecovery.selected.sourceObservationId, source = raw.observation(sessionId, sourceId);
            const sourceActions = raw.actions(sessionId, source.id).filter(action => matches(activeRecovery!.baseline!.scope, action, source));
            if (sourceActions.length === 1 && guard) {
              const proof = raw.explorationTargetCorrespondences(sessionId, { observationId: guard.observationId, requests: [{ actionId, source: { sessionId, observationId: source.id, actionId: sourceActions[0].id } }] });
              dispatch.correspondence = proof; dispatch.correspondenceVerified = proof.results.length === 1 && proof.results[0].equivalent;
            }
          } catch (error) { dispatch.correspondence = { available: false, code: errorCode(error) }; }
        }
        dispatches.set(requestId, dispatch);
        const receipt = await raw.execute(...args); dispatch.receipt = receipt; return receipt;
      },
      reachCheckpoint: async (...args) => { fence(); return observeRecoveryCall('reachCheckpoint', args[0], () => raw.reachCheckpoint(...args), record => { recoveries.push(record); log('recovery.api', record); }, requestStop); },
      reachExplorationTarget: async (...args) => { fence(); return observeRecoveryCall('reachExplorationTarget', args[0], () => raw.reachExplorationTarget(...args), record => { recoveries.push(record); log('recovery.api', record); }, requestStop); },
      reachControlReviewTarget: async (...args) => { fence(); return observeRecoveryCall('reachControlReviewTarget', args[0], () => raw.reachControlReviewTarget(...args), record => { recoveries.push(record); log('recovery.api', record); }, requestStop); },
      returnToObservedSource: async (...args) => { fence(); return observeRecoveryCall('returnToObservedSource', args[0], () => raw.returnToObservedSource(...args), record => { recoveries.push(record); log('recovery.api', record); }, requestStop); },
    };
    const saveEvent = store.event.bind(store);
    store.event = input => {
      const saved = saveEvent(input);
      try {
        if (saved.taskId !== taskId) return saved;
        pluginEventCount++;
        // Provider response bodies remain in the ordinary owned plugin ledger;
        // this acceptance exports event correlation and counters only.
        log('plugin.event', saved.type.startsWith('decision.') ? { ...saved, data: { providerPayloadRecorded: false } } : saved);
        const data = saved.data as Data;
        if (saved.type === 'recovery.selected') {
          const pending = baselinePending.get(data.itemId);
          activeRecovery = { selected: structuredClone(data), selectedSequence: saved.sequence, baseline: pending?.item, occurrenceId: pending?.occurrenceId };
        }
        if (saved.type === 'recovery.result' && activeRecovery) {
          if (['REACHED_VERIFIED', 'REACHED_ACCEPTABLE', 'TARGET_REACHED', 'CURRENT_REVIEWABLE', 'SOURCE_REACHED'].includes(data.status)) {
            activeRecovery.result = structuredClone(data); activeRecovery.resultSequence = saved.sequence;
          } else requestStop('plugin_recovery_not_verified', data);
        }
        if (saved.type === 'recovery.contract_rejected' || saved.type === 'recovery.blocked' || saved.type === 'decision.failed') requestStop(saved.type, data);
        // Dismissal verification occurs synchronously after action.verified and
        // its persistence. Reject it before the queued loop audit can pass.
        if (saved.type === 'boundary.exit_verified' && (!data.result || ['changed', 'unverified'].includes(data.result.status)))
          requestStop('boundary_exit_not_verified', data);
        if (saved.type === 'action.selected') currentSelection = structuredClone(data);
        if (saved.type === 'action.scheduled') scheduled.set(data.requestId, structuredClone(data));
        // recordOutcome emits this before its caller flushes pendingDispatch and
        // item deltas. A microtask observes that durable flush, never an in-memory success.
        if (saved.type === 'action.verified' && data.status === 'succeeded') queueMicrotask(() => {
          try { verifyLoop(saved); } catch (error) { fatal ||= errorCode(error); requestStop('loop_audit_failed', { code: fatal }); }
        });
      } catch (error) { fatal ||= errorCode(error); requestStop('event_audit_failed', { code: fatal }); }
      return saved;
    };
    raw.events.on('event', event => {
      try {
        sessions.add(event.sessionId);
        if (!['action.started', 'action.completed', 'action.unknown'].includes(event.type)) return;
        const attempt = event.data as ActionAttempt;
        if (baselineAttempts.has(attempt.id)) return;
        newAttempts.set(attempt.id, attempt);
        if (event.type === 'action.started') budget.actionStarted(attempt.id);
        log('engine.action', { type: event.type, attempt });
        if (attempt.status === 'unknown') requestStop('unknown_attempt', { sessionId: event.sessionId, attemptId: attempt.id });
        else if (event.type !== 'action.started' && budget.snapshot().usage.actions >= 20) requestStop('window_action_budget');
      } catch (error) { fatal ||= errorCode(error); requestStop('engine_audit_failed', { code: fatal }); }
    });
    plugin = new ExplorerPlugin(acceptanceHost(raw, entries, hostCalls), store, { ...configured, jev: provider('jev', configured.jev), llm: provider('llm', configured.llm) });
    fence(); plugin.start(taskId); started = true; await plugin.waitForIdle(taskId);
    if (!stopping) requestStop('task_halted_before_loop', store.taskHeader(taskId).header.reason);
    await stopJob;
  } catch (error) { fatal ||= errorCode(error); requestStop('runner_failed', { code: fatal }); await stopJob; }
  finally {
    clearTimeout(timer);
    providerSettlement = await settlePendingProviders(pendingProviders, Math.max(0, Math.min(5000, 239000 - elapsed())));
    if (!providerSettlement.settled) fatal ||= 'PROVIDER_PENDING';
    try {
      if (store && before) {
        after = store.taskState(taskId); write('task-after.json', after.task); write('plan-occurrences-after.json', after.plan);
        write('plan-changes.json', planResolutionChanges(before, after));
      }
      if (engine) {
        const assessments = [...sessions].map(sid => engine!.recoveryAssessment(sid));
        const unsettled = assessments.some(a => a.dirty || a.unknownAttempts.length > 0);
        if (unsettled || after?.task.pendingDispatch || after?.task.unverifiedRecoveries?.length || after?.task.unverifiedNavigations?.length) fatal ||= 'UNSETTLED_EXECUTION';
        write('settled-assessments.json', assessments);
      }
    } catch (error) { fatal ||= errorCode(error); }
    let closeFailed = false;
    await closeAcceptanceResources([
      { name: 'plugin', close: () => plugin ? plugin.close() : store?.close() },
      { name: 'engine', close: () => engine ? engine.close() : engineStore?.close() },
    ], failure => { closeFailed = true; fatal ||= failure.code; log('close.failed', failure); });
    closed = !closeFailed; removeSignals(); budget.finish();
    write('outcome.json', { productCommit: revision, taskId, directory, started, verdict: loop && !fatal && closed && elapsed() < 240000 && guards[0]?.reason === 'plugin_loop_verified' ? 'plugin_loop_passed' : 'not_accepted',
      elapsedMs: elapsed(), limitMs: 240000, fatal, closed, guards, loop: loop ? { itemId: loop.itemId, occurrenceId: loop.occurrenceId, attemptId: loop.receipt.id } : undefined,
      providerCounts, providerSettlement, hostCalls, windowBudget: budget.snapshot(), recoveries, newAttempts: [...newAttempts.values()].map(a => ({ id: a.id, status: a.status, purpose: a.purpose, executionProfile: a.executionProfile })),
      pluginEventCount, exhaustive: false, originalDatabasesOpened: false, harnessChangedPermissions: false, harnessChangedInput: false, harnessChangedPlan: false });
    process.exitCode = loop && !fatal && closed && elapsed() < 240000 && guards[0]?.reason === 'plugin_loop_verified' ? 0 : 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runPluginLoopAcceptance(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ code: errorCode(error), verdict: 'not_accepted', browserRunAuthorizedByInvocationOnly: true })); process.exitCode = 2;
});
