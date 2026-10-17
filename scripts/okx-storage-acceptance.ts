import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { readdir, lstat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { BrowserEngine, browserTargetConditions, browserOperationKey, type Observation, type ActionAttempt, type EngineEvent } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin, ExplorerStore, providersFromEnv, safeError, type Budget, type ExplorerEvent, type Provider, type Task } from '@interaction/explorer-plugin';
import { budgetSchema, createTaskSchema } from '../packages/explorer-plugin/src/schema.js';

/** Real-site runner, deliberately separate from fixture benchmarks. Merely typechecking
 * this file does not launch it. Start only after reviewing the current implementation.
 *
 * Fresh: node --import tsx --conditions=development scripts/okx-storage-acceptance.ts --dir /absolute/new-directory --url https://www.okx.com/convert/usd-to-btc
 * Resume: same command with --dir /absolute/owned-directory --resume [--extend-budget]
 * Stop: node --import tsx --conditions=development scripts/okx-storage-acceptance.ts --dir /absolute/owned-directory --request-stop
 * Use the stop command while a browser is active: Playwright's default SIGINT handler
 * can exit 130 before asynchronous evidence settlement, with either Node or tsx CLI.
 * Provider configuration comes from the launching environment; no dotenv/key file is read.
 * Each invocation is a bounded measurement window. No result claims exhaustion.
 */
// Resolve the native driver through the workspace package that declares it.
const SqliteDatabase = createRequire(new URL('../packages/storage-sqlite/package.json', import.meta.url))('better-sqlite3') as typeof Database;
const FORMAT = 'okx-storage-acceptance-v1';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const now = () => new Date().toISOString();
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const code = (error: unknown) => {
  const candidate = (error as { code?: unknown })?.code || (error as Error)?.message;
  return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(candidate) ? candidate : safeError(error);
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
function args(argv: string[]) {
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (['--resume', '--extend-budget', '--request-stop', '--help'].includes(key)) flags.add(key);
    else if (['--dir', '--url', '--rounds', '--actions', '--model-requests', '--minutes', '--sample-seconds', '--stall-minutes', '--max-disk-gib'].includes(key) && argv[index + 1] && !argv[index + 1].startsWith('--')) values.set(key, argv[++index]);
    else throw new Error('INVALID_ARGUMENT');
  }
  if (flags.has('--extend-budget') && !flags.has('--resume')) throw new Error('EXTENSION_REQUIRES_RESUME');
  if (flags.has('--request-stop') && (flags.has('--resume') || flags.has('--extend-budget') || [...values.keys()].some(key => key !== '--dir'))) throw new Error('STOP_REQUIRES_ONLY_DIRECTORY');
  const number = (key: string, fallback: number, min: number, max: number) => {
    const result = Number(values.get(key) ?? fallback);
    if (!Number.isFinite(result) || result < min || result > max) throw new Error('INVALID_ARGUMENT');
    return result;
  };
  return { directory: values.get('--dir'), url: values.get('--url'), resume: flags.has('--resume'), extend: flags.has('--extend-budget'), requestStop: flags.has('--request-stop'), help: flags.has('--help'),
    budget: budgetSchema.parse({ rounds: number('--rounds', 2, 1, 100), actions: number('--actions', 100, 1, 10000), modelRequests: number('--model-requests', 1000, 1, 10000), durationMs: number('--minutes', 30, 1, 1440) * 60000 }),
    sampleMs: number('--sample-seconds', 30, 10, 3600) * 1000, stallMs: number('--stall-minutes', 10, 2, 1440) * 60000, maxDisk: number('--max-disk-gib', 20, 1, 1000) * 1024 ** 3 };
}
interface Marker { format: typeof FORMAT; directory: string; owner: string; createdAt: string; url: string; taskId?: string }
interface Cursors { plugin: number; engine: Record<string, number> }
interface Guard { at: string; reason: string; details?: unknown; prior?: { status: string; reason?: string; usage: Budget } }
export interface AcceptanceCallMetric {
  calls: number; returned: number; threw: number; elapsedMs: number; maxMs: number;
  arrayItems: number; viewsAvailable: number; viewsUnavailable: number;
}
/** Instrument the consumer boundary, never SDK instances/prototypes. All reads
 * retain the original SDK receiver and all results/errors retain their identity.
 * Inclusive timings overlap; arrayItems is returned rows, not unique coverage.
 * The selection view itself is passed through unchanged, including its fences. */
export function acceptanceHost<T extends object>(raw: T, overrides: Partial<T>, metrics: Record<string, AcceptanceCallMetric>): T {
  const bound = new Map<PropertyKey, { method: Function; wrapper: Function }>();
  return new Proxy(raw, { get(target, key) {
    const method = Object.hasOwn(overrides, key) ? Reflect.get(overrides, key) : Reflect.get(target, key, target);
    if (typeof method !== 'function') return method;
    const previous = bound.get(key); if (previous?.method === method) return previous.wrapper;
    const wrapper = (...args: unknown[]) => {
      const name = String(key), row = metrics[name] ??= { calls: 0, returned: 0, threw: 0, elapsedMs: 0, maxMs: 0, arrayItems: 0, viewsAvailable: 0, viewsUnavailable: 0 };
      row.calls++; const began = performance.now();
      const finish = (failed: boolean, value: unknown) => {
        const elapsed = performance.now() - began; row.elapsedMs += elapsed; row.maxMs = Math.max(row.maxMs, elapsed);
        if (failed) row.threw++; else {
          row.returned++; if (Array.isArray(value)) row.arrayItems += value.length;
          if (key === 'recoverySelectionView') { if (value === undefined) row.viewsUnavailable++; else row.viewsAvailable++; }
        }
      };
      let result: unknown;
      try { result = Reflect.apply(method, target, args); }
      catch (error) { finish(true, error); throw error; }
      if (result instanceof Promise) return result.then(value => { finish(false, value); return value; }, error => { finish(true, error); throw error; });
      finish(false, result); return result;
    };
    bound.set(key, { method, wrapper }); return wrapper;
  } });
}
export type AcceptanceRecoveryApi = 'reachCheckpoint' | 'reachExplorationTarget' | 'returnToObservedSource';
export interface AcceptanceRecoveryFailure { outcome: 'threw'; api: AcceptanceRecoveryApi; sessionId: string; elapsedMs: number; code: string }
type AcceptanceRecoveryReport<T> = AcceptanceRecoveryFailure | { outcome: 'returned'; api: AcceptanceRecoveryApi; sessionId: string; elapsedMs: number; result: T };
/** Retain the SDK outcome unchanged and stop before the caller schedules more work. */
export function retainRecoveryResult<T extends { status: string }>(api: AcceptanceRecoveryApi, sessionId: string, result: T, stop: (reason: string, details: unknown) => void): T {
  const successful = api === 'reachCheckpoint' ? ['REACHED_VERIFIED', 'REACHED_ACCEPTABLE'].includes(result.status) : api === 'returnToObservedSource' ? result.status === 'SOURCE_REACHED' : result.status === 'TARGET_REACHED';
  if (!successful) stop('recovery_not_verified', { api, sessionId, result });
  return result;
}
/** Recovery exceptions can be retryable to the plugin, but this measurement
 * window stops at the first failed call. A thrown error is never an SDK result. */
export async function observeRecoveryCall<T extends { status: string }>(api: AcceptanceRecoveryApi, sessionId: string, invoke: () => Promise<T>,
  report: (record: AcceptanceRecoveryReport<T>) => void, stop: (reason: string, details: unknown) => void, clock = () => performance.now()): Promise<T> {
  const began = clock();
  let result: T;
  try { result = await invoke(); }
  catch (error) {
    const failure: AcceptanceRecoveryFailure = { outcome: 'threw', api, sessionId, elapsedMs: clock() - began, code: code(error) };
    // Even diagnostic failure must not hide the original SDK exception or skip
    // arranging settlement before a caller treats it as a retryable stale step.
    try { report(failure); }
    finally { try { stop('recovery_failed', failure); } finally { throw error; } }
  }
  report({ outcome: 'returned', api, sessionId, elapsedMs: clock() - began, result });
  return retainRecoveryResult(api, sessionId, result, stop);
}
/** These listeners are best effort; never remove another library's listeners. */
export function installAcceptanceStopSignals(stop: (reason: string) => void) {
  const onSignal = () => stop('operator_signal');
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  return () => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); };
}
/** Offline-testable integrity read. Retention hashes bind bytes AND media type. */
export async function auditProtectedArtifact(store: Pick<SqliteStore, 'get' | 'evidence'>, key: string) {
  const entry = store.get<{ status: string; bytes: number; hash: string }>('evidence-entry', `evidence:${key}`), value = await store.evidence.get(key);
  if (!entry || entry.status !== 'available' || !value || value.data.length !== entry.bytes || `${digest(value.data)}:${value.mediaType}` !== entry.hash) throw Object.assign(new Error(), { code: 'PROTECTED_EVIDENCE_UNAVAILABLE' });
}
/** Settled task status/reason are evidence. Never rewrite completed/blocked/unknown
 * history merely to stop this runner; pause only its currently active task. */
export async function settleOwnedTask(plugin: Pick<ExplorerPlugin, 'owner' | 'pause' | 'waitForIdle'>, host: Pick<BrowserEngine, 'waitForIdle'>, taskId: string) {
  if (plugin.owner() === taskId) await plugin.pause(taskId);
  await plugin.waitForIdle(taskId); await host.waitForIdle();
}
/** A scheduling/condition candidate, never semantic equivalence or coverage proof. */
export function operationConditionAssessment(attempt: ActionAttempt, observation: Observation) {
  const targets = observation.controls.filter(control => control.localId === attempt.action.localId), target = targets[0];
  const evidence = { sessionId: attempt.sessionId, beforeId: attempt.beforeId, observationId: observation.id, actionId: attempt.action.id,
    localId: attempt.action.localId, controlId: attempt.action.controlId, targetCount: targets.length, targetIdentityId: target?.identityId,
    targetHypothesisId: target?.hypothesisId, conditionPolicy: 'browser-target-arrival-v1' };
  const unkeyed = (reason: string) => ({ key: undefined, reason, evidence });
  if (targets.length !== 1) return unkeyed(targets.length ? 'target_local_id_nonunique' : 'target_missing');
  if (target.hypothesisId) return unkeyed('target_identity_unresolved');
  if (!target.identityId) return unkeyed('target_identity_missing');
  if (target.identityId !== attempt.action.controlId) return unkeyed('action_target_identity_mismatch');
  const conditions = browserTargetConditions(attempt.action, observation);
  // The SDK exposes no rejection detail here. Retain the exact source reference
  // for audit instead of inventing a partial dependency/identity algorithm.
  return conditions ? { key: digest(JSON.stringify([browserOperationKey(attempt.action, observation), conditions.policy, conditions.key])), reason: undefined, evidence }
    : unkeyed('target_conditions_unavailable');
}
export function operationConditionCandidate(attempt: ActionAttempt, observation: Observation) {
  return operationConditionAssessment(attempt, observation).key;
}
export function classifyAcceptanceAttempt(attempt: ActionAttempt) {
  const exploration = attempt.purpose !== 'recovery' && (attempt.purpose === 'exploration' || attempt.executionProfile === 'interface-exploration' || attempt.executionProfile === 'observed-ui-exploration');
  // The SDK persists the approved reentry source on the attempt. Use the same
  // retained evidence for live events and resume, rather than transient action IDs.
  const reentry = !!attempt.repetitionSource;
  return { exploration, reentry, leaf: exploration && !reentry };
}
/** Compact latest-state ledger: event delivery is not a count of unique attempts. */
export class AcceptanceProgress {
  private historical = new Set<string>();
  private attempts = new Map<string, { sessionId: string; status: ActionAttempt['status']; exploration: boolean; leaf: boolean; key?: string; finishedAt: number; unkeyedSince?: number; assessment?: ReturnType<typeof operationConditionAssessment> }>();
  constructor(private keyFor: (attempt: ActionAttempt) => string | undefined | ReturnType<typeof operationConditionAssessment>, private clock = Date.now) {}
  record(attempt: ActionAttempt, historical = false) {
    if (historical) this.historical.add(attempt.id);
    const classification = classifyAcceptanceAttempt(attempt), old = this.attempts.get(attempt.id);
    const finishedAt = Date.parse(attempt.finishedAt || attempt.startedAt);
    const result = attempt.status === 'succeeded' && classification.leaf ? this.keyFor(attempt) : undefined;
    const assessment = typeof result === 'object' ? result : undefined;
    const key = typeof result === 'string' ? result : assessment?.key, observedAt = this.clock();
    const completionMissing = attempt.status === 'succeeded' && !Number.isFinite(Date.parse(attempt.finishedAt || ''));
    const boundedFinishedAt = completionMissing ? observedAt : Number.isFinite(finishedAt) ? Math.min(finishedAt, observedAt) : old?.finishedAt ?? observedAt;
    const anchoredFinishedAt = attempt.status === 'succeeded' && old?.status === 'succeeded' ? Math.min(old.finishedAt, boundedFinishedAt) : boundedFinishedAt;
    const unkeyedSince = attempt.status === 'succeeded' && classification.leaf && !key
      ? Math.min(old?.unkeyedSince ?? Infinity, anchoredFinishedAt) : undefined;
    this.attempts.set(attempt.id, { sessionId: attempt.sessionId, status: attempt.status, ...classification,
      key, assessment, unkeyedSince, finishedAt: anchoredFinishedAt });
  }
  reconcile(attempts: ActionAttempt[]) {
    const present = new Set(attempts.map(attempt => attempt.id));
    for (const id of this.attempts.keys()) if (!present.has(id)) this.attempts.delete(id);
    for (const attempt of attempts) this.record(attempt);
  }
  snapshot(startedAt = 0) {
    const baseline = new Set<string>(), firstSuccess = new Map<string, number>();
    const counts: Record<string, number> = {}, successfulAttemptIds: string[] = [], unkeyedSuccessfulAttemptIds: string[] = [];
    type Unkeyed = { sessionId: string; attemptId: string; finishedAt: number; unkeyedSince: number; reason: string; evidence?: ReturnType<typeof operationConditionAssessment>['evidence'] };
    const unkeyedSuccessfulAttempts: Unkeyed[] = [], historicalUnkeyedSuccessfulAttempts: Unkeyed[] = [];
    const unknownAttempts: { sessionId: string; attemptId: string; status: string }[] = [];
    const inFlightAttempts: { sessionId: string; attemptId: string; status: string }[] = [];
    for (const [id, attempt] of this.attempts) {
      if (attempt.status === 'unknown') unknownAttempts.push({ sessionId: attempt.sessionId, attemptId: id, status: attempt.status });
      if (attempt.status === 'executing') inFlightAttempts.push({ sessionId: attempt.sessionId, attemptId: id, status: attempt.status });
      if (attempt.status === 'succeeded' && attempt.leaf && !attempt.key) {
        const row = { sessionId: attempt.sessionId, attemptId: id, finishedAt: attempt.finishedAt, unkeyedSince: attempt.unkeyedSince!,
          reason: attempt.assessment?.reason || 'condition_candidate_unavailable', evidence: attempt.assessment?.evidence };
        (this.historical.has(id) ? historicalUnkeyedSuccessfulAttempts : unkeyedSuccessfulAttempts).push(row);
      }
      if (this.historical.has(id)) {
        if (attempt.status === 'succeeded' && attempt.leaf && attempt.key) baseline.add(attempt.key);
        continue;
      }
      counts[attempt.status] = (counts[attempt.status] || 0) + 1;
      if (attempt.status !== 'succeeded' || !attempt.exploration) continue;
      successfulAttemptIds.push(id);
      if (!attempt.leaf) continue;
      if (!attempt.key) unkeyedSuccessfulAttemptIds.push(id);
      else firstSuccess.set(attempt.key, Math.min(firstSuccess.get(attempt.key) ?? Infinity, attempt.finishedAt));
    }
    for (const key of baseline) firstSuccess.delete(key);
    return { counts, successfulAttemptIds, unkeyedSuccessfulAttemptIds, unknownAttempts, inFlightAttempts, conditionKeys: [...firstSuccess.keys()].sort(),
      newOperationConditionCandidates: firstSuccess.size, lastProgressAt: Math.max(startedAt, ...firstSuccess.values()),
      unkeyedSuccessfulAttempts, historicalUnkeyedSuccessfulAttempts,
      progressGuardsDeferred: unkeyedSuccessfulAttempts.length + historicalUnkeyedSuccessfulAttempts.length > 0 };
  }
}
/** A bounded audit window, not evidence of no progress. Historical uncertainty
 * receives a full new window after restart; shutdown time is never charged. */
export function progressEvidenceWindow(snapshot: Pick<ReturnType<AcceptanceProgress['snapshot']>, 'unkeyedSuccessfulAttempts' | 'historicalUnkeyedSuccessfulAttempts'>, startedAt: number | undefined, stallMs: number, evaluatedAt = Date.now()) {
  const current = snapshot.unkeyedSuccessfulAttempts, historical = snapshot.historicalUnkeyedSuccessfulAttempts;
  const firstUnkeyedAt = startedAt === undefined || !current.length && !historical.length ? undefined
    : historical.length ? startedAt : Math.max(startedAt, Math.min(...current.map(row => row.unkeyedSince)));
  const deadlineAt = firstUnkeyedAt === undefined ? undefined : firstUnkeyedAt + stallMs;
  return { status: deadlineAt === undefined ? 'inactive' : evaluatedAt >= deadlineAt ? 'audit_required' : 'pending',
    classification: 'progress_audit_required', startedAt, evaluatedAt, stallMs, firstUnkeyedAt, deadlineAt,
    elapsedMs: firstUnkeyedAt === undefined ? 0 : Math.max(0, evaluatedAt - firstUnkeyedAt),
    currentAttemptIds: current.map(row => row.attemptId), historicalAttemptIds: historical.map(row => row.attemptId),
    semanticCoverageEstablished: false, exhaustive: false };
}
/** Runs independently of potentially slow disk/audit sampling. Already started
 * SDK work is allowed to settle after this review request. */
export function watchProgressEvidence(read: () => ReturnType<typeof progressEvidenceWindow>, stop: (reason: string, details: unknown) => void) {
  let requested = false;
  const timer = setInterval(() => {
    if (requested) return;
    try { const window = read(); if (window.status === 'audit_required') { requested = true; stop('progress_evidence_unavailable_window', window); } }
    catch (error) { requested = true; stop('instrumentation_failure', { source: 'progress_evidence_watch', code: code(error) }); }
  }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}
type PlanSnapshot = Pick<ReturnType<ExplorerStore['taskState']>, 'task' | 'plan'>;
export function newlyResolvedOccurrences(before: PlanSnapshot, after: PlanSnapshot) {
  return planResolutionChanges(before, after).newlyResolved;
}
export function planResolutionChanges(before: PlanSnapshot, after: PlanSnapshot) {
  const previous = new Map(before.task.plan.map((item, index) => [before.plan[index], item]));
  const rows = after.task.plan.flatMap((item, position) => {
    if (item.status !== 'succeeded' || !item.resolvedBy?.attemptId) return [];
    const occurrenceId = after.plan[position], prior = previous.get(occurrenceId);
    return [{ occurrenceId, position, item, prior }];
  });
  // Replacing the evidence of an already successful occurrence is not progress,
  // including when it previously used only historical coverage evidence.
  const newlyResolved = rows.filter(row => row.prior?.status !== 'succeeded').map(({ prior: _, ...row }) => row);
  const evidenceRefreshes = rows.filter(row => row.prior?.status === 'succeeded' &&
    JSON.stringify(row.prior.resolvedBy) !== JSON.stringify(row.item.resolvedBy)).map(({ prior, ...row }) => ({
      ...row, previousResolvedBy: prior!.resolvedBy, previousCoverageResolvedBy: prior!.coverageResolvedBy
    }));
  return { newlyResolved, evidenceRefreshes };
}
export const budgetEnforcement = {
  modelRequests: 'Hard allowance at actual provider.decide entry; SDK reservations may also count a denied call.',
  rounds: 'Hard allowance at createSession entry; resuming an existing session consumes no new slot; a failed creation still consumes its call slot.',
  actions: 'Soft threshold using distinct SDK action.started IDs, reconciled against the final attempt ledger. An in-flight recovery may dispatch multiple internal attempts and exceed it; no attempt hooks or session budgets are changed.',
  durationMs: 'Provider/session entries check the deadline and a timer requests pause. Already started SDK work, including an entire recovery call, settles normally and may exceed the window.',
  aggregateDuration: 'After an interrupted process, retained task duration may be a persisted-activity lower bound. durationUncertainty is reported; the independent current window still measures its own elapsed duration.',
  progress: 'Unkeyed successes defer no-progress/repeated-route claims. An independent stallMs audit deadline starts at the earliest still-unkeyed success; historical unkeyed successes receive a full window from this run start. Later successes never extend it. Expiry requests review and normal settlement, without changing SDK outcomes or claiming exhaustion.'
};
export class WindowBudgetExceeded extends Error {
  readonly code = 'CANCELLED';
  constructor(readonly dimension: keyof Budget) { super('CANCELLED'); }
}
/** Entry allowances do not rewrite task/session budgets or SDK attempt outcomes. */
export class AcceptanceWindow {
  private began?: number;
  private settled?: number;
  private models = 0;
  private rounds = 0;
  private attempts = new Set<string>();
  constructor(readonly budget: Budget, private clock = Date.now) {}
  start() { this.began = this.clock(); }
  finish() { if (this.began !== undefined && this.settled === undefined) this.settled = this.clock(); }
  enter(kind: 'provider' | 'round') {
    if (this.began === undefined) throw new Error('WINDOW_NOT_STARTED');
    if (this.clock() - this.began >= this.budget.durationMs) throw new WindowBudgetExceeded('durationMs');
    if (kind === 'provider') {
      if (this.models >= this.budget.modelRequests) throw new WindowBudgetExceeded('modelRequests');
      this.models++;
    } else if (kind === 'round') {
      if (this.rounds >= this.budget.rounds) throw new WindowBudgetExceeded('rounds');
      this.rounds++;
    }
  }
  actionStarted(id: string) { this.attempts.add(id); }
  reconcileActions(ids: string[]) { this.attempts = new Set(ids); }
  snapshot() {
    const usage = { actions: this.attempts.size, modelRequests: this.models, rounds: this.rounds, durationMs: this.began === undefined ? 0 : Math.max(0, (this.settled ?? this.clock()) - this.began) };
    const overshoot: Budget = { actions: Math.max(0, usage.actions - this.budget.actions), modelRequests: Math.max(0, usage.modelRequests - this.budget.modelRequests), rounds: Math.max(0, usage.rounds - this.budget.rounds), durationMs: Math.max(0, usage.durationMs - this.budget.durationMs) };
    return { usage, startedAt: this.began, overshoot };
  }
}

/** Diagnostic failure must not escape an SDK callback or skip independent cleanup. */
export function createDiagnosticLogger(write: (type: string, data: unknown) => void, failed: (failure: { code: string; at: string }) => void) {
  let failure: { code: string; at: string } | undefined;
  return {
    get failure() { return failure; },
    log(type: string, data: unknown) {
      if (failure) return;
      try { write(type, data); }
      catch (error) { failure = { code: code(error), at: now() }; try { failed(failure); } catch { /* Never throw from an SDK callback. */ } }
    }
  };
}
export async function closeAcceptanceResources(resources: { name: string; close: () => unknown | Promise<unknown> }[], failed: (failure: { resource: string; code: string }) => void) {
  for (const resource of resources) {
    try { await resource.close(); }
    catch (error) { try { failed({ resource: resource.name, code: code(error) }); } catch { /* The next resource still owns cleanup. */ } }
  }
}
/** Router cancellation can settle before the underlying provider promise. */
export async function settlePendingProviders(pending: ReadonlyMap<string, Promise<unknown>>, waitMs = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (pending.size) await Promise.race([Promise.allSettled([...pending.values()]), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
  } finally { clearTimeout(timer); }
  const remainingPendingRequestIds = [...pending.keys()].sort();
  return { settled: remainingPendingRequestIds.length === 0, remainingPendingRequestIds, sampledAt: now(), waitLimitMs: waitMs };
}

function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
}
export interface AcceptanceRunControl { format: typeof FORMAT; directory: string; owner: string; taskId: string; runId: string; pid: number; startedAt: string; state: 'active' | 'finished'; finishedAt?: string }
interface StopRequest { format: 'okx-storage-stop-v1'; owner: string; taskId: string; runId: string; requestId: string; requestedAt: string }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function readControlJson(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('INVALID_STOP_CONTROL_FILE');
  return object(JSON.parse(readFileSync(path, 'utf8')));
}
function readOwnedRunControl(directory: string): AcceptanceRunControl {
  if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink()) throw new Error('DIRECTORY_MUST_BE_CANONICAL');
  const marker = readControlJson(join(directory, 'owner.json')), run = readControlJson(join(directory, 'active-run.json'));
  if (marker.format !== FORMAT || marker.directory !== directory || !uuid(marker.owner) || typeof marker.taskId !== 'string' || !marker.taskId
    || run.format !== FORMAT || run.directory !== directory || run.owner !== marker.owner || run.taskId !== marker.taskId || !uuid(run.runId)
    || !Number.isSafeInteger(run.pid) || Number(run.pid) <= 0 || typeof run.startedAt !== 'string') throw new Error('NOT_OWNED_RUN_DIRECTORY');
  if (run.state !== 'active') throw new Error('NO_ACTIVE_OWNED_RUN');
  const runDirectory = join(directory, 'runs', run.runId);
  if (realpathSync(runDirectory) !== runDirectory || lstatSync(runDirectory).isSymbolicLink()) throw new Error('DIRECTORY_MUST_BE_CANONICAL');
  return run as unknown as AcceptanceRunControl;
}
/** Queue only for the marked run; no signal, provider, browser or database access.
 * A crashed run may leave a stale active marker. Its request cannot stop a later run. */
export function writeOwnedStopRequest(inputDirectory: string): StopRequest {
  const directory = resolve(inputDirectory), run = readOwnedRunControl(directory);
  const request: StopRequest = { format: 'okx-storage-stop-v1', owner: run.owner, taskId: run.taskId, runId: run.runId, requestId: randomUUID(), requestedAt: now() };
  atomicJson(join(directory, 'runs', run.runId, 'stop-request.json'), request);
  return request;
}
export function readOwnedStopRequest(expected: AcceptanceRunControl): StopRequest | undefined {
  const run = readOwnedRunControl(expected.directory);
  if (run.owner !== expected.owner || run.taskId !== expected.taskId || run.runId !== expected.runId || run.pid !== expected.pid) throw new Error('STOP_CONTROL_OWNERSHIP_CHANGED');
  let request: Record<string, unknown>;
  try { request = readControlJson(join(expected.directory, 'runs', expected.runId, 'stop-request.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (request.format !== 'okx-storage-stop-v1' || request.owner !== expected.owner || request.taskId !== expected.taskId || request.runId !== expected.runId
    || !uuid(request.requestId) || typeof request.requestedAt !== 'string') throw new Error('STOP_REQUEST_OWNERSHIP_MISMATCH');
  return request as unknown as StopRequest;
}
/** Independent of full metrics sampling, including while a recovery is in flight. */
export function pollOwnedStopRequests(run: AcceptanceRunControl, stop: (reason: string, details: unknown) => void, intervalMs = 1000) {
  let handled = false;
  const poll = () => {
    if (handled) return;
    try { const request = readOwnedStopRequest(run); if (request) { handled = true; stop('operator_stop_request', request); } }
    catch (error) { handled = true; stop('stop_control_integrity', { code: code(error) }); }
  };
  const timer = setInterval(poll, intervalMs); poll();
  return () => clearInterval(timer);
}
function noSymlinks(directory: string) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('OWNED_DIRECTORY_CONTAINS_SYMLINK');
    if (stat.isDirectory()) noSymlinks(path);
  }
}
function sourceIdentity() {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages', 'scripts/okx-storage-acceptance.ts', 'pnpm-lock.yaml'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const hashes = files.filter(path => /\.(ts|tsx|json|yaml)$/.test(path)).map(path => [path, digest(readFileSync(join(ROOT, path)))]);
  return { revision, treeSha256: digest(JSON.stringify(hashes)), scriptSha256: digest(readFileSync(fileURLToPath(import.meta.url))), node: process.version };
}
async function disk(directory: string) {
  const totals: Record<string, number> = { engineDatabase: 0, engineWal: 0, engineShm: 0, pluginDatabase: 0, pluginWal: 0, pluginShm: 0, evidenceManifests: 0, evidenceBlobs: 0, evidenceOther: 0, runnerAndLogs: 0, total: 0 };
  const walk = async (current: string, prefix = '') => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix + entry.name, path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('OWNED_DIRECTORY_CONTAINS_SYMLINK');
      if (entry.isDirectory()) { await walk(path, relative + '/'); continue; }
      let bytes: number;
      try { bytes = (await lstat(path)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const databases: Record<string, string> = { 'engine/engine.sqlite': 'engineDatabase', 'engine/engine.sqlite-wal': 'engineWal', 'engine/engine.sqlite-shm': 'engineShm', 'plugin/explorer.sqlite': 'pluginDatabase', 'plugin/explorer.sqlite-wal': 'pluginWal', 'plugin/explorer.sqlite-shm': 'pluginShm' };
      const category = databases[relative] || (relative.startsWith('engine/evidence/blobs/') ? 'evidenceBlobs' : relative.startsWith('engine/evidence/') ? relative.endsWith('.meta.json') ? 'evidenceManifests' : 'evidenceOther' : 'runnerAndLogs');
      totals[category] += bytes; totals.total += bytes;
    }
  };
  await walk(directory); const space = await statfs(directory);
  return { ...totals, total: totals.total, availableBytes: space.bavail * space.bsize };
}

async function main() {
  const config = args(process.argv.slice(2));
  if (config.help) { console.log('Launch with node --import tsx --conditions=development. Required: --dir NEW_DIRECTORY --url HTTPS_OKX_URL. Resume: --dir OWNED_DIRECTORY --resume [--extend-budget]. Stop safely: --dir OWNED_DIRECTORY --request-stop; this queues a request for the marked run, and its summary confirms settlement. SIGINT is best effort because Playwright may exit before settlement. Optional: --rounds 2 --actions 100 --model-requests 1000 --minutes 30 --sample-seconds 30 --stall-minutes 10 --max-disk-gib 20. Providers are supplied only by the launching environment. Provider/new-session call allowances are hard entry limits. Action/time limits may be exceeded by already running SDK recovery/settling; overshoot is reported. The stall window also bounds unresolved progress evidence: earliest unkeyed success starts a review deadline, and retained historical unkeyed successes receive a full window on resume. Expiry requests audit, not a failed action or exhaustion. No limit establishes exhaustion.'); return; }
  if (!config.directory) throw new Error('DIRECTORY_REQUIRED');
  if (config.requestStop) { const request = writeOwnedStopRequest(config.directory); console.log(JSON.stringify({ type: 'stop.request.queued', ...request, settlementPending: true })); return; }
  const directory = resolve(config.directory), markerPath = join(directory, 'owner.json');
  let marker: Marker;
  if (config.resume) {
    if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink()) throw new Error('DIRECTORY_MUST_BE_CANONICAL');
    noSymlinks(directory);
    marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Marker;
    if (marker.format !== FORMAT || marker.directory !== directory || !/^[a-f0-9-]{36}$/.test(marker.owner) || !marker.taskId || (config.url && config.url !== marker.url)) throw new Error('NOT_OWNED_RUN_DIRECTORY');
  } else {
    if (!config.url) throw new Error('URL_REQUIRED');
    const url = new URL(config.url);
    if (url.protocol !== 'https:' || !['okx.com', 'www.okx.com'].includes(url.hostname) || url.username || url.password) throw new Error('HTTPS_OKX_URL_REQUIRED');
    mkdirSync(dirname(directory), { recursive: true });
    if (realpathSync(dirname(directory)) !== dirname(directory)) throw new Error('DIRECTORY_MUST_BE_CANONICAL');
    mkdirSync(directory, { mode: 0o700 }); // Exclusive: never adopt a preexisting directory.
    marker = { format: FORMAT, directory, owner: randomUUID(), createdAt: now(), url: config.url };
    atomicJson(markerPath, marker);
  }
  // OS-owned lock releases after process death; never guess whether a PID/lease is stale.
  const lock = new SqliteDatabase(join(directory, '.runner-lock.sqlite'), { timeout: 0 });
  try { lock.exec('BEGIN IMMEDIATE'); } catch { lock.close(); throw new Error('RUN_DIRECTORY_BUSY'); }
  const runId = randomUUID(), runDirectory = join(directory, 'runs', runId);
  const diagnostics = createDiagnosticLogger((type, data) => appendFileSync(join(runDirectory, 'metrics.jsonl'), JSON.stringify({ at: now(), runId, type, data }) + '\n', { mode: 0o600 }), failure => {
    fatal ||= 'DIAGNOSTIC_WRITE_FAILED'; requestStop('diagnostic_write_failed', failure);
  });
  const log = diagnostics.log;
  let host: BrowserEngine | undefined, plugin: ExplorerPlugin | undefined, engineStore: SqliteStore | undefined, pluginStore: ExplorerStore | undefined, pluginMetrics: Database.Database | undefined;
  let taskId = marker.taskId || '', stopping = false, stopJob: Promise<void> | undefined, sampleAt = 0, evidenceOffset = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined, progressDeferralLogged = false;
  let runControl: AcceptanceRunControl | undefined, stopPolling: (() => void) | undefined, stopProgressWatch: (() => void) | undefined;
  const guards: Guard[] = [], cursors: Cursors = { plugin: 0, engine: {} }, sessions = new Set<string>();
  const pendingProviders = new Map<string, Promise<unknown>>();
  let providerSettlement: Awaited<ReturnType<typeof settlePendingProviders>> | undefined;
  const hostCalls: Record<string, AcceptanceCallMetric> = {};
  const providerCounts = { jev: { started: 0, returned: 0, failed: 0, cancelled: 0, elapsedMs: 0, usage: {} as Record<string, number> }, llm: { started: 0, returned: 0, failed: 0, cancelled: 0, elapsedMs: 0, usage: {} as Record<string, number> } };
  const baselineSuccesses = new Set<string>(), baselineAttempts = new Set<string>(), observations = new Set<string>();
  const windowBudget = new AcceptanceWindow(config.budget);
  const progress = new AcceptanceProgress(attempt => operationConditionAssessment(attempt, host!.observation(attempt.sessionId, attempt.beforeId)));
  const progressSnapshot = () => {
    const window = windowBudget.snapshot(), snapshot = progress.snapshot(window.startedAt ?? Date.now());
    return { ...snapshot, progressEvidenceWindow: progressEvidenceWindow(snapshot, window.startedAt, config.stallMs,
      window.startedAt === undefined ? Date.now() : window.startedAt + window.usage.durationMs) };
  };
  const repeatedRoutes = new Map<string, { progress: string[]; count: number }>();
  const recoveries: { api: string; sessionId: string; status: string; elapsedMs: number; observationId?: string; attemptIds: string[]; matchedActionIds?: string[]; checkpointVerified?: boolean }[] = [];
  const recoveryFailures: AcceptanceRecoveryFailure[] = [];
  let initial: Task | undefined, final: Task | undefined, initialState: ReturnType<ExplorerStore['taskState']> | undefined, fatal: string | undefined, started = false;
  const header = () => pluginStore && taskId ? pluginStore.taskHeader(taskId) : undefined;
  const requestStop = (reason: string, details?: unknown) => {
    if (guards.some(guard => guard.reason === reason)) return;
    let prior: Guard['prior'];
    try { const task = header()?.header; if (task) prior = { status: task.status, reason: task.reason, usage: task.usage }; } catch { /* Preserve the first cause even if the header is corrupt. */ }
    const guard = { at: now(), reason, details, prior }; guards.push(guard);
    if (stopping) { log('stop.requested', guard); return; } stopping = true; stopProgressWatch?.();
    // Begin pause on the next microtask, before another awaited dispatch/model call.
    stopJob = Promise.resolve().then(async () => {
      if (plugin && host && taskId) await settleOwnedTask(plugin, host, taskId);
      else if (host) await host.waitForIdle();
      windowBudget.finish();
      log('stop.settled', { reason, original: prior, paused: header()?.header.status });
    }).catch(error => { fatal ||= code(error); log('stop.failed', { code: fatal, reason }); });
    // Stopping and settlement are already arranged if this diagnostic write fails.
    log('stop.requested', guard);
  };
  const enterWindow = (kind: Parameters<AcceptanceWindow['enter']>[0]) => {
    if (stopping) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
    try { windowBudget.enter(kind); } catch (error) {
      if (error instanceof WindowBudgetExceeded) requestStop(error.dimension === 'durationMs' ? 'window_time_budget' : 'window_usage_budget', { dimension: error.dimension, entry: kind, ...windowBudget.snapshot() });
      throw error;
    }
  };
  const removeStopSignals = installAcceptanceStopSignals(requestStop);
  const watchRoute = (key: string, evidence: unknown) => {
    const snapshot = progressSnapshot();
    if (snapshot.progressGuardsDeferred) { log('route.guard_deferred', { key, reason: 'unkeyed_success_cannot_establish_no_progress', unkeyedSuccessfulAttemptIds: snapshot.unkeyedSuccessfulAttemptIds, progressEvidenceWindow: snapshot.progressEvidenceWindow }); return; }
    const old = repeatedRoutes.get(key), changed = snapshot.conditionKeys.some(condition => !old?.progress.includes(condition));
    const count = old && !changed ? old.count + 1 : 1;
    repeatedRoutes.set(key, { progress: snapshot.conditionKeys, count });
    if (count >= 3) requestStop('repeated_route_without_new_success', { key, count, evidence, classification: 'suspected_retry_requires_review' });
  };
  const provider = (actor: 'jev' | 'llm', source: Provider): Provider => ({ ...source, async decide(request, signal) {
    enterWindow('provider');
    const began = performance.now(), counters = providerCounts[actor]; counters.started++;
    try {
      const call = source.decide(request, signal); pendingProviders.set(request.id, call);
      log('provider.started', { actor, requestId: request.id, purpose: request.purpose, kind: request.kind, policy: request.policy, provider: source.name, model: source.model });
      const answer = await call; counters.returned++;
      const usage = Object.fromEntries(Object.entries(answer.usage || {}).filter(([, value]) => Number.isFinite(value) && value >= 0));
      for (const [key, value] of Object.entries(usage)) counters.usage[key] = (counters.usage[key] || 0) + value;
      log('provider.returned', { actor, requestId: request.id, purpose: request.purpose, elapsedMs: performance.now() - began, model: answer.model, usage }); return answer;
    } catch (error) {
      const failure = code(error), cancelled = signal.aborted || failure === 'CANCELLED'; counters[cancelled ? 'cancelled' : 'failed']++;
      log('provider.failed', { actor, requestId: request.id, purpose: request.purpose, code: failure, cancelled, elapsedMs: performance.now() - began });
      if (!cancelled) requestStop('provider_failure', { actor, requestId: request.id, code: failure }); throw error;
    } finally { pendingProviders.delete(request.id); counters.elapsedMs += performance.now() - began; }
  } });
  const auditEvent = (event: ExplorerEvent) => {
    const data = object(event.data);
    if (event.sessionId) sessions.add(event.sessionId);
    if (event.type === 'decision.failed') requestStop('provider_or_decision_failure', { decisionId: event.decisionId, reason: data.reason });
    if (event.type === 'recovery.selected') watchRoute(`recovery:${String(data.routeKey)}`, { sequence: event.sequence, sourceObservationId: data.sourceObservationId, itemId: data.itemId });
    if (event.type === 'branch.reentry_planned') {
      // Recorded proof is a necessity candidate. It is not successful traversal or new coverage.
      log('reentry.candidate', { sequence: event.sequence, observationId: event.observationId, ...data, necessaryConfirmed: false });
      watchRoute(`reentry:${digest(JSON.stringify([data.scope, data.target]))}`, { sequence: event.sequence, itemId: data.itemId });
    }
  };
  const auditEngineEvent = (event: EngineEvent) => {
    sessions.add(event.sessionId);
    if (event.type === 'observation.created') observations.add(String(object(event.data).observationId));
    if (!['action.started', 'action.completed', 'action.unknown'].includes(event.type)) return;
    const attempt = event.data as ActionAttempt;
    if (event.type === 'action.started') windowBudget.actionStarted(attempt.id);
    try {
      progress.record(attempt);
      const snapshot = progressSnapshot(), classification = classifyAcceptanceAttempt(attempt);
      if (attempt.status === 'succeeded' && classification.exploration) log('coverage.condition_candidate', { attemptId: attempt.id, reentry: classification.reentry,
        newConditionCount: snapshot.newOperationConditionCandidates, unkeyedSuccessfulAttemptIds: snapshot.unkeyedSuccessfulAttemptIds,
        unkeyed: snapshot.unkeyedSuccessfulAttempts.find(row => row.attemptId === attempt.id), progressEvidenceWindow: snapshot.progressEvidenceWindow, semanticUniquenessVerified: false });
      if (snapshot.progressGuardsDeferred && !progressDeferralLogged) { progressDeferralLogged = true; log('progress.guards_deferred', { reason: 'unkeyed_success_cannot_establish_no_progress', progressEvidenceWindow: snapshot.progressEvidenceWindow }); }
    } catch (error) { requestStop('observation_integrity', { attemptId: attempt.id, code: code(error) }); }
    if (event.type === 'action.started') return;
    log('attempt.completed', { engineEventType: event.type, id: attempt.id, sessionId: attempt.sessionId, status: attempt.status, purpose: attempt.purpose, executionProfile: attempt.executionProfile, beforeId: attempt.beforeId, afterId: attempt.afterId, requestId: attempt.requestId, kind: attempt.action.kind, label: attempt.action.label, elapsedMs: attempt.finishedAt ? Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt) : undefined, repetitionSource: attempt.repetitionSource, recoverySegment: attempt.recoverySegment });
    if (attempt.status === 'unknown') requestStop('unknown_attempt', { sessionId: event.sessionId, attemptId: attempt.id });
    else if (windowBudget.snapshot().usage.actions >= config.budget.actions) requestStop('window_usage_budget', { dimension: 'actions', ...windowBudget.snapshot() });
  };
  const engineEvent = (event: EngineEvent) => {
    try { auditEngineEvent(event); } catch (error) { fatal ||= code(error); requestStop('instrumentation_failure', { source: 'engine_event', code: code(error) }); }
  };
  const drain = () => {
    if (!pluginStore || !engineStore || !taskId) return;
    let advanced = false;
    for (;;) {
      const page = pluginStore.events(taskId, cursors.plugin, 500); if (!page.length) break;
      for (const event of page) {
        if (event.sessionId) sessions.add(event.sessionId);
        const data = object(event.data);
        // Full decision content stays in the source DB; metrics retain identifiers and numeric usage.
        const summary = event.type.startsWith('decision.') ? { reason: data.reason, kind: data.kind, purpose: data.purpose, policy: data.policy } : data;
        log('plugin.event', { ...event, data: summary }); cursors.plugin = event.sequence; advanced = true;
      }
    }
    for (const sessionId of sessions) for (;;) {
      const page = engineStore.events(sessionId, cursors.engine[sessionId] || 0, 500); if (!page.length) break;
      for (const event of page) { const data = object(event.data); log('engine.event', { sequence: event.sequence, sessionId, type: event.type, at: event.at, entityId: data.id, observationId: data.observationId, beforeId: data.beforeId, afterId: data.afterId, status: data.status, reason: data.reason }); cursors.engine[sessionId] = event.sequence; advanced = true; }
    }
    if (advanced) atomicJson(join(runDirectory, 'cursors.json'), cursors);
  };
  const auditProtected = async (all: boolean) => {
    if (!host || !engineStore) return;
    const keys = new Map<string, { sessionId: string; observationId: string }>();
    for (const sid of sessions) {
      const stats = await host.evidenceStats(sid);
      for (const group of stats.protected) {
        const record = engineStore.get<{ keys: string[] }>('evidence-retention', `retention:${group.observationId}`);
        if (!record) throw Object.assign(new Error(), { code: 'PROTECTED_MANIFEST_MISSING' });
        for (const key of record.keys) keys.set(key, { sessionId: sid, observationId: group.observationId });
      }
    }
    const items = [...keys.keys()].sort(), selected = all ? items : items.length ? Array.from({ length: Math.min(8, items.length) }, (_, index) => items[(evidenceOffset + index) % items.length]) : [];
    evidenceOffset += selected.length;
    for (const key of selected) {
      try {
        await auditProtectedArtifact(engineStore, key);
      } catch (error) {
        // A current-only capture may legitimately lose protection while the read awaits.
        const owner = keys.get(key)!;
        if (all || (await host.evidenceStats(owner.sessionId)).protected.some(group => group.observationId === owner.observationId)) throw error;
        log('evidence.protection_changed', { key, ...owner });
      }
    }
    log('evidence.audit', { full: all, protectedKeys: items.length, checkedKeys: selected.length, cursor: evidenceOffset });
  };
  const sample = async () => {
    drain(); const state = header(); if (!state || !pluginStore) return;
    const task = state.header;
    const planCounts = pluginMetrics!.prepare('SELECT status,required,COUNT(*) AS count FROM task_items WHERE task_id=? AND kind=\'plan\' GROUP BY status,required').all(taskId);
    const metrics = progressSnapshot(), unknown = metrics.unknownAttempts;
    const storage = await disk(directory);
    log('sample', { status: task.status, reason: task.reason, usage: task.usage, durationUncertainty: task.durationUncertainty, budget: task.budget, planCounts, planCount: state.planCount, roundCount: state.roundCount, pendingDispatch: task.pendingDispatch, unverifiedRecoveries: task.unverifiedRecoveries, unverifiedNavigations: task.unverifiedNavigations, unknown, inFlightAttempts: metrics.inFlightAttempts, cursors, providers: providerCounts, hostCalls, attempts: metrics.counts, newlySucceededExplorationAttempts: metrics.successfulAttemptIds.length, newOperationConditionCandidates: metrics.newOperationConditionCandidates, unkeyedSuccessfulAttemptIds: metrics.unkeyedSuccessfulAttemptIds, progressGuardsDeferred: metrics.progressGuardsDeferred, unkeyedSuccessfulAttempts: metrics.unkeyedSuccessfulAttempts, historicalUnkeyedSuccessfulAttempts: metrics.historicalUnkeyedSuccessfulAttempts, progressEvidenceWindow: metrics.progressEvidenceWindow, budgetEnforcement, windowBudget: windowBudget.snapshot(), newObservations: observations.size, disk: storage, exhaustive: false });
    if (unknown.length) requestStop('unknown_attempt', unknown);
    if (task.unverifiedRecoveries?.length || task.unverifiedNavigations?.length) requestStop('unverified_outcome', { recovery: task.unverifiedRecoveries, navigation: task.unverifiedNavigations });
    if (storage.total > config.maxDisk || storage.availableBytes < 1024 ** 3) requestStop('disk_guard', storage);
    try { await auditProtected(false); } catch (error) { requestStop('protected_evidence_integrity', { code: code(error) }); }
  };
  try {
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const configured = providersFromEnv();
    if (!configured.jev || !configured.llm) throw Object.assign(new Error(), { code: 'CONFIGURATION_REQUIRED' });
    log('run.preflight', { format: FORMAT, source: sourceIdentity(), resume: config.resume, extendBudget: config.extend, budget: config.budget, budgetEnforcement, url: marker.url, stallMs: config.stallMs, sampleMs: config.sampleMs, maxDiskBytes: config.maxDisk, exhaustive: false,
      metricLimits: ['Actual successful attempts and newly resolved plan rows are separate; neither deduplicates all semantic operations.', 'browserOperationKey is a scheduling hint: same-name/shared-identifier targets can still collide. Candidate keys grant no identity, uniqueness, or scope completion.', 'Missing targets, unresolved identity or unavailable conditions are unkeyed; reasons bind the retained source observation. SDK condition rejection details require source audit. Such successes defer no-progress/repeated-route claims, but an independent stallMs deadline requests progress audit. Historical uncertainty receives a new full window on resume; later success never erases it.', 'Provider counts are actual decide calls, not billable HTTP requests; usage only includes parsed provider answers.', 'Necessary reentry is a candidate backed by route evidence and requires child-progress review.', 'Repeated-route and no-progress guards identify review candidates, not a proof that every retry was unnecessary.', 'Partial live integrity audits rotate through eight protected artifacts; startup/settled audits check all protected artifacts.', 'Raw decisions, observations, unknown attempts and request ledgers remain in the owned databases.'] });
    mkdirSync(join(directory, 'plugin'), { recursive: true });
    engineStore = new SqliteStore(join(directory, 'engine'));
    host = new BrowserEngine({ persistence: engineStore });
    pluginStore = new ExplorerStore(join(directory, 'plugin', 'explorer.sqlite'));
    // Compact projections only; source-version metadata binds these schema-dependent metrics.
    pluginMetrics = new SqliteDatabase(join(directory, 'plugin', 'explorer.sqlite'), { readonly: true, fileMustExist: true });
    // Fence public entries without rewriting task/session limits or SDK outcomes.
    const createSession = host.createSession.bind(host);
    const entries: Partial<BrowserEngine> = { createSession: async (...input) => { enterWindow('round'); return createSession(...input); } };
    // A recovery API may dispatch several internal attempts. Its entry is checked,
    // but an already running recovery is not interrupted or recast as unknown.
    const reportRecovery = (completion: AcceptanceRecoveryReport<{ status: string; observationId?: string; attemptIds: string[]; matchedActionIds?: string[]; checkpointVerified?: boolean }>) => {
      if (completion.outcome === 'threw') { recoveryFailures.push(completion); log('recovery.failed', completion); return; }
      const { api, sessionId, elapsedMs, result } = completion;
      const record = { api, sessionId, elapsedMs, status: result.status, observationId: result.observationId, attemptIds: result.attemptIds,
        ...(api === 'reachExplorationTarget' ? { matchedActionIds: result.matchedActionIds } : {}),
        checkpointVerified: api === 'reachCheckpoint' ? result.status === 'REACHED_VERIFIED' : result.checkpointVerified };
      recoveries.push(record); log('recovery.returned', { ...record, result });
    };
    const checkpoint = host.reachCheckpoint.bind(host);
    entries.reachCheckpoint = async (...input) => {
      if (stopping) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
      return observeRecoveryCall('reachCheckpoint', input[0], () => checkpoint(...input), reportRecovery, requestStop);
    };
    const target = host.reachExplorationTarget.bind(host);
    entries.reachExplorationTarget = async (...input) => {
      if (stopping) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
      return observeRecoveryCall('reachExplorationTarget', input[0], () => target(...input), reportRecovery, requestStop);
    };
    const sourceReturn = host.returnToObservedSource.bind(host);
    entries.returnToObservedSource = async (...input) => {
      if (stopping) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
      return observeRecoveryCall('returnToObservedSource', input[0], () => sourceReturn(...input), reportRecovery, requestStop);
    };
    const event = pluginStore.event.bind(pluginStore);
    pluginStore.event = input => {
      const saved = event(input);
      try { auditEvent(saved); } catch (error) { fatal ||= code(error); requestStop('instrumentation_failure', { source: 'plugin_event', code: code(error) }); }
      return saved;
    };
    host.events.on('event', engineEvent);
    plugin = new ExplorerPlugin(acceptanceHost(host, entries, hostCalls), pluginStore, { ...configured, jev: provider('jev', configured.jev), llm: provider('llm', configured.llm) });
    if (!config.resume) { const created = plugin.create(createTaskSchema.parse({ url: marker.url, goal: '', coverageMode: 'all', budget: config.budget, sessionOptions: { headless: true, executionPolicy: 'interface-only' } })); taskId = created.id; marker.taskId = taskId; atomicJson(markerPath, marker); }
    runControl = { format: FORMAT, directory, owner: marker.owner, taskId, runId, pid: process.pid, startedAt: now(), state: 'active' };
    atomicJson(join(directory, 'active-run.json'), runControl);
    stopPolling = pollOwnedStopRequests(runControl, requestStop);
    initialState = pluginStore.taskState(taskId); initial = initialState.task; atomicJson(join(runDirectory, 'task-before.json'), initial);
    atomicJson(join(runDirectory, 'plan-occurrences-before.json'), initialState.plan);
    if (initial.url !== marker.url || initial.goal !== '' || initial.coverageMode !== 'all') throw Object.assign(new Error(), { code: 'OWNED_TASK_CONFIGURATION_CHANGED' });
    for (const round of initial.rounds) sessions.add(round.sessionId);
    for (const sid of sessions) for (const attempt of host.list<ActionAttempt>(sid, 'attempt')) {
      baselineAttempts.add(attempt.id); progress.record(attempt, true);
      if (attempt.status === 'succeeded') baselineSuccesses.add(attempt.id);
      else if (attempt.status === 'unknown' || attempt.status === 'executing') requestStop('preexisting_unknown_or_executing', { sessionId: sid, attemptId: attempt.id, status: attempt.status });
    }
    // Resume starts at the persisted source cursors; earlier run logs remain alongside it.
    cursors.plugin = (pluginMetrics.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE task_id=?').get(taskId) as { sequence: number }).sequence;
    for (const sid of sessions) cursors.engine[sid] = (engineStore.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?').get(sid) as { sequence: number }).sequence;
    log('run.ready', { taskId, routingVersion: plugin.status().routingVersion, cursors, priorStatus: initial.status, priorReason: initial.reason, priorUsage: initial.usage, durationUncertainty: initial.durationUncertainty, priorBudget: initial.budget, historicalSucceededAttempts: baselineSuccesses.size });
    if (initial.pendingDispatch || initial.unverifiedRecoveries?.length || initial.unverifiedNavigations?.length) requestStop('preexisting_unverified_dispatch', { pendingDispatch: initial.pendingDispatch, recoveries: initial.unverifiedRecoveries, navigations: initial.unverifiedNavigations });
    try { await auditProtected(true); } catch (error) { requestStop('protected_evidence_integrity', { code: code(error) }); }
    if (!stopping && config.extend) { plugin.extendBudget(taskId, config.budget); log('budget.extended', { add: config.budget, budget: header()?.header.budget, usageUnchanged: header()?.header.usage }); }
    if (!stopping) { const task = header()!.header; if (task.usage.actions >= task.budget.actions || task.usage.modelRequests >= task.budget.modelRequests || task.usage.durationMs >= task.budget.durationMs) requestStop('task_budget_guard', { usage: task.usage, budget: task.budget }); }
    if (!stopping) {
      if (initial.status === 'completed') requestStop('already_completed_requires_review');
      else {
        windowBudget.start(); deadlineTimer = setTimeout(() => requestStop('window_time_budget'), config.budget.durationMs);
        stopProgressWatch = watchProgressEvidence(() => progressSnapshot().progressEvidenceWindow, requestStop);
        log('progress.audit_window', { ...progressSnapshot().progressEvidenceWindow, historicalUnkeyedSuccessfulAttempts: progressSnapshot().historicalUnkeyedSuccessfulAttempts });
        log('start.requested', { taskId, priorStatus: initial.status, priorReason: initial.reason }); plugin.start(taskId); started = true;
      }
    }
    while (plugin.owner() === taskId && !stopping) {
      drain();
      if (windowBudget.snapshot().usage.actions >= config.budget.actions) requestStop('window_usage_budget', { dimension: 'actions', ...windowBudget.snapshot() });
      if (Date.now() - sampleAt >= config.sampleMs) { sampleAt = Date.now(); await sample(); }
      if (windowBudget.snapshot().usage.durationMs >= config.budget.durationMs) requestStop('window_time_budget');
      const metrics = progressSnapshot();
      if (!metrics.progressGuardsDeferred && Date.now() - metrics.lastProgressAt >= config.stallMs) requestStop('no_new_operation_condition_window', { elapsedMs: Date.now() - metrics.lastProgressAt, classification: 'stalled_or_review_only_requires_review' });
      if (!stopping) await new Promise<void>(done => setTimeout(done, 1000));
    }
    await plugin.waitForIdle(taskId);
    if (!stopping) { const task = header()!.header; requestStop(task.status === 'budget_exhausted' ? 'task_budget_guard' : 'task_halted_for_review', { status: task.status, reason: task.reason, exhaustive: false }); }
    await stopJob; await sample();
    try { await auditProtected(true); } catch (error) { requestStop('protected_evidence_integrity', { code: code(error) }); }
    const finalState = pluginStore.taskState(taskId); final = finalState.task; atomicJson(join(runDirectory, 'task-after.json'), final);
    atomicJson(join(runDirectory, 'plan-occurrences-after.json'), finalState.plan);
    const finalAttempts = [...sessions].flatMap(sid => host!.list<ActionAttempt>(sid, 'attempt'));
    progress.reconcile(finalAttempts);
    windowBudget.reconcileActions(finalAttempts.filter(attempt => !baselineAttempts.has(attempt.id)).map(attempt => attempt.id));
    const settled = progressSnapshot(), successes = new Set(settled.successfulAttemptIds), finalUnknown = [...settled.unknownAttempts, ...settled.inFlightAttempts];
    if (finalUnknown.length) requestStop('settled_unknown_or_executing', finalUnknown);
    const { newlyResolved, evidenceRefreshes } = planResolutionChanges(initialState, finalState);
    atomicJson(join(runDirectory, 'coverage-review.json'), { exhaustive: false, newlySucceededExplorationAttemptIds: [...successes], newOperationConditionCandidates: settled.newOperationConditionCandidates, unkeyedSuccessfulAttemptIds: settled.unkeyedSuccessfulAttemptIds, progressGuardsDeferred: settled.progressGuardsDeferred, unkeyedSuccessfulAttempts: settled.unkeyedSuccessfulAttempts, historicalUnkeyedSuccessfulAttempts: settled.historicalUnkeyedSuccessfulAttempts, progressEvidenceWindow: settled.progressEvidenceWindow, newlyResolvedPlanOccurrences: newlyResolved, refreshedPlanEvidence: evidenceRefreshes, planProgressIsSemanticCoverageProof: false, newlyResolvedPlanItems: newlyResolved.map(row => row.item), historicalCoverageOnly: final.plan.filter(item => item.coverageResolvedBy), unresolved: final.plan.filter(item => item.required && !['succeeded', 'excluded', 'superseded'].includes(item.status)), unknownAttempts: finalUnknown, pendingDispatch: final.pendingDispatch, unverifiedRecoveries: final.unverifiedRecoveries, unverifiedNavigations: final.unverifiedNavigations, recoveries, recoveryFailures,
      recoveryFollowup: recoveries.map(recovery => ({ ...recovery, subsequentSuccessfulAttempts: finalAttempts.filter(attempt => successes.has(attempt.id) && attempt.sessionId === recovery.sessionId && attempt.beforeId === recovery.observationId).map(attempt => ({ sessionId: attempt.sessionId, attemptId: attempt.id, beforeId: attempt.beforeId })), targetReadinessOnly: recovery.status === 'TARGET_REACHED', wholeCheckpointVerified: recovery.checkpointVerified === true })) });
  } catch (error) { fatal = code(error); requestStop('runner_failure', { code: fatal }); await stopJob; }
  finally {
    clearTimeout(deadlineTimer); stopPolling?.(); stopProgressWatch?.();
    await closeAcceptanceResources([
      { name: 'pluginMetrics', close: () => pluginMetrics?.close() },
      { name: 'plugin', close: async () => { if (plugin) { await plugin.close(); pluginStore = undefined; } } },
      { name: 'pluginStore', close: () => pluginStore?.close() },
      { name: 'host', close: async () => { if (host) { await host.close(); engineStore = undefined; } } },
      { name: 'engineStore', close: () => engineStore?.close() }
    ], failure => { fatal ||= failure.code; log('close.failed', failure); });
    windowBudget.finish();
    providerSettlement = await settlePendingProviders(pendingProviders);
    if (!providerSettlement.settled) { fatal ||= 'PROVIDER_SETTLEMENT_INCOMPLETE'; log('provider.settlement_incomplete', providerSettlement); }
    const settled = progressSnapshot();
    // Close releases SQLite WAL handles before the final physical-byte snapshot.
    try { atomicJson(join(runDirectory, 'summary.json'), { format: FORMAT, runId, taskId, finishedAt: now(), started, fatal, guards, originalStop: guards[0], finalStatus: final?.status, finalReason: final?.reason, usageBefore: initial?.usage, usageAfter: final?.usage, durationAccounting: { before: initial?.durationUncertainty, after: final?.durationUncertainty, aggregateExact: !!final && final.activeSince === undefined && !(initial?.durationUncertainty || final.durationUncertainty) }, providerCounts, hostCalls, providerSettlement, diagnosticFailure: diagnostics.failure, unknownAttempts: settled.unknownAttempts, inFlightAttempts: settled.inFlightAttempts, attemptCounts: settled.counts, newSuccessfulExplorationAttempts: settled.successfulAttemptIds.length, newOperationConditionCandidates: settled.newOperationConditionCandidates, unkeyedSuccessfulAttemptIds: settled.unkeyedSuccessfulAttemptIds, progressGuardsDeferred: settled.progressGuardsDeferred, unkeyedSuccessfulAttempts: settled.unkeyedSuccessfulAttempts, historicalUnkeyedSuccessfulAttempts: settled.historicalUnkeyedSuccessfulAttempts, progressEvidenceWindow: settled.progressEvidenceWindow, budgetEnforcement, windowBudget: windowBudget.snapshot(), overshoot: windowBudget.snapshot().overshoot, recoveryCalls: recoveries.length + recoveryFailures.length, recoveryReturnedCalls: recoveries.length, recoveryThrownCalls: recoveryFailures.length, recoveryFailures, recoveryElapsedMs: [...recoveries, ...recoveryFailures].reduce((sum, recovery) => sum + recovery.elapsedMs, 0), cursors, diskAfterClose: await disk(directory), exhaustive: false, reviewRequired: true }); }
    catch (error) { fatal ||= code(error); log('summary.failed', { code: code(error) }); }
    finally { await closeAcceptanceResources([
      { name: 'stopControl', close: () => { if (runControl) atomicJson(join(directory, 'active-run.json'), { ...runControl, state: 'finished', finishedAt: now() }); } },
      { name: 'lock.rollback', close: () => { if (lock.inTransaction) lock.exec('ROLLBACK'); } },
      { name: 'lock.close', close: () => lock.close() }
    ], failure => { fatal ||= failure.code; log('close.failed', failure); }); }
    removeStopSignals();
    console.log(JSON.stringify({ directory: runDirectory, taskId, reason: guards[0]?.reason || fatal, fatal, diagnosticFailure: diagnostics.failure, providerSettlement, exhaustive: false, reviewRequired: true }));
    if (fatal || guards.some(guard => !['operator_signal', 'operator_stop_request', 'window_time_budget', 'window_usage_budget', 'task_budget_guard', 'already_completed_requires_review'].includes(guard.reason))) process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(JSON.stringify({ code: code(error), exhaustive: false })); process.exitCode = 2; });
