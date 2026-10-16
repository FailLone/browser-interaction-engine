import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { readdir, lstat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { BrowserEngine, browserTargetConditions, type ActionAttempt, type EngineEvent } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin, ExplorerStore, providersFromEnv, safeError, type Budget, type ExplorerEvent, type Provider, type Task } from '@interaction/explorer-plugin';
import { budgetSchema, createTaskSchema } from '../packages/explorer-plugin/src/schema.js';

/** Real-site runner, deliberately separate from fixture benchmarks. Merely typechecking
 * this file does not launch it. Start only after reviewing the current implementation.
 *
 * Fresh: pnpm exec tsx --conditions=development scripts/okx-storage-acceptance.ts --dir /absolute/new-directory --url https://www.okx.com/convert/usd-to-btc
 * Resume: same command with --dir /absolute/owned-directory --resume [--extend-budget]
 * Provider configuration comes from the launching environment; no dotenv/key file is read.
 * Each invocation is a bounded measurement window. No result claims exhaustion.
 */
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
    if (['--resume', '--extend-budget', '--help'].includes(key)) flags.add(key);
    else if (['--dir', '--url', '--rounds', '--actions', '--model-requests', '--minutes', '--sample-seconds', '--stall-minutes', '--max-disk-gib'].includes(key) && argv[index + 1] && !argv[index + 1].startsWith('--')) values.set(key, argv[++index]);
    else throw new Error('INVALID_ARGUMENT');
  }
  if (flags.has('--extend-budget') && !flags.has('--resume')) throw new Error('EXTENSION_REQUIRES_RESUME');
  const number = (key: string, fallback: number, min: number, max: number) => {
    const result = Number(values.get(key) ?? fallback);
    if (!Number.isFinite(result) || result < min || result > max) throw new Error('INVALID_ARGUMENT');
    return result;
  };
  return { directory: values.get('--dir'), url: values.get('--url'), resume: flags.has('--resume'), extend: flags.has('--extend-budget'), help: flags.has('--help'),
    budget: budgetSchema.parse({ rounds: number('--rounds', 2, 1, 100), actions: number('--actions', 100, 1, 10000), modelRequests: number('--model-requests', 1000, 1, 10000), durationMs: number('--minutes', 30, 1, 1440) * 60000 }),
    sampleMs: number('--sample-seconds', 30, 10, 3600) * 1000, stallMs: number('--stall-minutes', 10, 2, 1440) * 60000, maxDisk: number('--max-disk-gib', 20, 1, 1000) * 1024 ** 3 };
}
interface Marker { format: typeof FORMAT; directory: string; owner: string; createdAt: string; url: string; taskId?: string }
interface Cursors { plugin: number; engine: Record<string, number> }
interface Guard { at: string; reason: string; details?: unknown; prior?: { status: string; reason?: string; usage: Budget } }
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
function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
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
  if (config.help) { console.log('Required: --dir NEW_DIRECTORY --url HTTPS_OKX_URL. Resume: --dir OWNED_DIRECTORY --resume [--extend-budget]. Optional: --rounds 2 --actions 100 --model-requests 1000 --minutes 30 --sample-seconds 30 --stall-minutes 10 --max-disk-gib 20. Providers are supplied only by the launching environment. Budgets bound a window; they never establish exhaustion.'); return; }
  if (!config.directory) throw new Error('DIRECTORY_REQUIRED');
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
  const lock = new Database(join(directory, '.runner-lock.sqlite'), { timeout: 0 });
  try { lock.exec('BEGIN IMMEDIATE'); } catch { lock.close(); throw new Error('RUN_DIRECTORY_BUSY'); }
  const runId = randomUUID(), runDirectory = join(directory, 'runs', runId);
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const log = (type: string, data: unknown) => appendFileSync(join(runDirectory, 'metrics.jsonl'), JSON.stringify({ at: now(), runId, type, data }) + '\n', { mode: 0o600 });
  let host: BrowserEngine | undefined, plugin: ExplorerPlugin | undefined, engineStore: SqliteStore | undefined, pluginStore: ExplorerStore | undefined, pluginMetrics: Database.Database | undefined;
  let taskId = marker.taskId || '', stopping = false, stopJob: Promise<void> | undefined, sampleAt = 0, lastProgress = Date.now(), evidenceOffset = 0;
  const guards: Guard[] = [], cursors: Cursors = { plugin: 0, engine: {} }, sessions = new Set<string>();
  const providerCounts = { jev: { started: 0, returned: 0, failed: 0, cancelled: 0, elapsedMs: 0, usage: {} as Record<string, number> }, llm: { started: 0, returned: 0, failed: 0, cancelled: 0, elapsedMs: 0, usage: {} as Record<string, number> } };
  const attemptCounts: Record<string, number> = {}, successes = new Set<string>(), baselineSuccesses = new Set<string>(), observations = new Set<string>();
  const unknownAttempts = new Map<string, { sessionId: string; attemptId: string }>();
  const reentryActions = new Set<string>(), successfulConditions = new Set<string>(); let newConditions = 0;
  const repeatedRoutes = new Map<string, { progress: number; count: number }>();
  const recoveries: { api: string; sessionId: string; status: string; elapsedMs: number; observationId?: string; attemptIds: string[]; matchedActionIds?: string[]; checkpointVerified?: boolean }[] = [];
  let initial: Task | undefined, final: Task | undefined, fatal: string | undefined, started = false;
  const header = () => pluginStore && taskId ? pluginStore.taskHeader(taskId) : undefined;
  const requestStop = (reason: string, details?: unknown) => {
    if (guards.some(guard => guard.reason === reason)) return;
    let prior: Guard['prior'];
    try { const task = header()?.header; if (task) prior = { status: task.status, reason: task.reason, usage: task.usage }; } catch { /* Preserve the first cause even if the header is corrupt. */ }
    const guard = { at: now(), reason, details, prior }; guards.push(guard); log('stop.requested', guard);
    if (stopping) return; stopping = true;
    // Begin pause on the next microtask, before another awaited dispatch/model call.
    stopJob = Promise.resolve().then(async () => {
      if (plugin && host && taskId) await settleOwnedTask(plugin, host, taskId);
      else if (host) await host.waitForIdle();
      log('stop.settled', { reason, original: prior, paused: header()?.header.status });
    }).catch(error => { fatal = code(error); log('stop.failed', { code: fatal, reason }); });
  };
  const onSignal = () => requestStop('operator_signal');
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const watchRoute = (key: string, evidence: unknown) => {
    const old = repeatedRoutes.get(key), count = old?.progress === newConditions ? old.count + 1 : 1;
    repeatedRoutes.set(key, { progress: newConditions, count });
    if (count >= 3) requestStop('repeated_route_without_new_success', { key, count, evidence, classification: 'suspected_retry_requires_review' });
  };
  const provider = (actor: 'jev' | 'llm', source: Provider): Provider => ({ ...source, async decide(request, signal) {
    if (stopping) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
    const began = performance.now(), counters = providerCounts[actor]; counters.started++;
    log('provider.started', { actor, requestId: request.id, purpose: request.purpose, kind: request.kind, policy: request.policy, provider: source.name, model: source.model });
    try {
      const answer = await source.decide(request, signal); counters.returned++;
      const usage = Object.fromEntries(Object.entries(answer.usage || {}).filter(([, value]) => Number.isFinite(value) && value >= 0));
      for (const [key, value] of Object.entries(usage)) counters.usage[key] = (counters.usage[key] || 0) + value;
      log('provider.returned', { actor, requestId: request.id, purpose: request.purpose, elapsedMs: performance.now() - began, model: answer.model, usage }); return answer;
    } catch (error) {
      const failure = code(error), cancelled = signal.aborted || failure === 'CANCELLED'; counters[cancelled ? 'cancelled' : 'failed']++;
      log('provider.failed', { actor, requestId: request.id, purpose: request.purpose, code: failure, cancelled, elapsedMs: performance.now() - began });
      if (!cancelled) requestStop('provider_failure', { actor, requestId: request.id, code: failure }); throw error;
    } finally { counters.elapsedMs += performance.now() - began; }
  } });
  const auditEvent = (event: ExplorerEvent) => {
    const data = object(event.data);
    if (event.sessionId) sessions.add(event.sessionId);
    if (event.type === 'action.selected' && data.reentry === true && typeof data.actionId === 'string') reentryActions.add(data.actionId);
    if (event.type === 'decision.failed') requestStop('provider_or_decision_failure', { decisionId: event.decisionId, reason: data.reason });
    if (event.type === 'recovery.selected') watchRoute(`recovery:${String(data.routeKey)}`, { sequence: event.sequence, sourceObservationId: data.sourceObservationId, itemId: data.itemId });
    if (event.type === 'branch.reentry_planned') {
      // Recorded proof is a necessity candidate. It is not successful traversal or new coverage.
      log('reentry.candidate', { sequence: event.sequence, observationId: event.observationId, ...data, necessaryConfirmed: false });
      watchRoute(`reentry:${digest(JSON.stringify([data.scope, data.target]))}`, { sequence: event.sequence, itemId: data.itemId });
    }
  };
  const conditionKey = (attempt: ActionAttempt) => {
    const observation = host!.observation(attempt.sessionId, attempt.beforeId), conditions = browserTargetConditions(attempt.action, observation);
    return conditions ? digest(JSON.stringify([conditions.policy, conditions.key, attempt.action.kind, attempt.action.value])) : undefined;
  };
  const engineEvent = (event: EngineEvent) => {
    sessions.add(event.sessionId);
    if (event.type === 'observation.created') observations.add(String(object(event.data).observationId));
    if (event.type !== 'action.completed' && event.type !== 'action.unknown') return;
    const attempt = event.data as ActionAttempt;
    attemptCounts[attempt.status] = (attemptCounts[attempt.status] || 0) + 1;
    if (attempt.status === 'unknown') unknownAttempts.set(attempt.id, { sessionId: attempt.sessionId, attemptId: attempt.id });
    else unknownAttempts.delete(attempt.id);
    // Plugin commands remain purpose=external in the SDK ledger. Their explicit
    // exploration profile distinguishes them from recovery and hover/focus probes.
    if (attempt.status === 'succeeded' && attempt.purpose !== 'recovery' && (attempt.purpose === 'exploration' || attempt.executionProfile === 'interface-exploration' || attempt.executionProfile === 'observed-ui-exploration')) {
      successes.add(attempt.id);
      try {
        const key = conditionKey(attempt), entry = reentryActions.has(attempt.action.id) || !!attempt.repetitionSource;
        if (key && !entry && !successfulConditions.has(key)) { successfulConditions.add(key); newConditions++; lastProgress = Date.now(); }
        log('coverage.condition_candidate', { attemptId: attempt.id, conditionKey: key, reentry: entry, newConditionCount: newConditions, semanticUniquenessVerified: false });
      } catch (error) { requestStop('observation_integrity', { attemptId: attempt.id, code: code(error) }); }
    }
    log('attempt.completed', { engineEventType: event.type, id: attempt.id, sessionId: attempt.sessionId, status: attempt.status, purpose: attempt.purpose, executionProfile: attempt.executionProfile, beforeId: attempt.beforeId, afterId: attempt.afterId, requestId: attempt.requestId, kind: attempt.action.kind, label: attempt.action.label, elapsedMs: attempt.finishedAt ? Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt) : undefined, repetitionSource: attempt.repetitionSource, recoverySegment: attempt.recoverySegment });
    if (attempt.status === 'unknown') requestStop('unknown_attempt', { sessionId: event.sessionId, attemptId: attempt.id });
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
    const unknown = [...unknownAttempts.values()];
    const storage = await disk(directory);
    log('sample', { status: task.status, reason: task.reason, usage: task.usage, budget: task.budget, planCounts, planCount: state.planCount, roundCount: state.roundCount, pendingDispatch: task.pendingDispatch, unverifiedRecoveries: task.unverifiedRecoveries, unverifiedNavigations: task.unverifiedNavigations, unknown, cursors, providers: providerCounts, attempts: attemptCounts, newlySucceededExplorationAttempts: successes.size, newOperationConditionCandidates: newConditions, newObservations: observations.size, disk: storage, exhaustive: false });
    if (unknown.length) requestStop('unknown_attempt', unknown);
    if (task.unverifiedRecoveries?.length || task.unverifiedNavigations?.length) requestStop('unverified_outcome', { recovery: task.unverifiedRecoveries, navigation: task.unverifiedNavigations });
    if (storage.total > config.maxDisk || storage.availableBytes < 1024 ** 3) requestStop('disk_guard', storage);
    try { await auditProtected(false); } catch (error) { requestStop('protected_evidence_integrity', { code: code(error) }); }
  };
  try {
    const configured = providersFromEnv();
    if (!configured.jev || !configured.llm) throw Object.assign(new Error(), { code: 'CONFIGURATION_REQUIRED' });
    log('run.preflight', { format: FORMAT, source: sourceIdentity(), resume: config.resume, extendBudget: config.extend, budget: config.budget, url: marker.url, stallMs: config.stallMs, sampleMs: config.sampleMs, maxDiskBytes: config.maxDisk, exhaustive: false,
      metricLimits: ['Actual successful attempts and newly resolved plan rows are separate; neither deduplicates all semantic operations.', 'Necessary reentry is a candidate backed by route evidence and requires child-progress review.', 'Repeated-route and no-progress guards identify review candidates, not a proof that every retry was unnecessary.', 'Partial live integrity audits rotate through eight protected artifacts; startup/settled audits check all protected artifacts.', 'Raw decisions, observations, unknown attempts and request ledgers remain in the owned databases.'] });
    mkdirSync(join(directory, 'plugin'), { recursive: true });
    engineStore = new SqliteStore(join(directory, 'engine'));
    host = new BrowserEngine({ persistence: engineStore });
    pluginStore = new ExplorerStore(join(directory, 'plugin', 'explorer.sqlite'));
    // Compact projections only; source-version metadata binds these schema-dependent metrics.
    pluginMetrics = new Database(join(directory, 'plugin', 'explorer.sqlite'), { readonly: true, fileMustExist: true });
    // Instrument public evidence-producing calls without changing their inputs/results.
    const checkpoint = host.reachCheckpoint.bind(host);
    host.reachCheckpoint = async (...input) => {
      const began = performance.now();
      try { const result = await checkpoint(...input); const record = { api: 'reachCheckpoint', sessionId: input[0], status: result.status, elapsedMs: performance.now() - began, observationId: result.observationId, attemptIds: result.attemptIds, checkpointVerified: result.status === 'REACHED_VERIFIED' }; recoveries.push(record); log('recovery.returned', { ...record, result }); return result; }
      catch (error) { log('recovery.failed', { api: 'reachCheckpoint', sessionId: input[0], elapsedMs: performance.now() - began, code: code(error) }); throw error; }
    };
    const target = host.reachExplorationTarget.bind(host);
    host.reachExplorationTarget = async (...input) => {
      const began = performance.now();
      try { const result = await target(...input); const record = { api: 'reachExplorationTarget', sessionId: input[0], status: result.status, elapsedMs: performance.now() - began, observationId: result.observationId, attemptIds: result.attemptIds, matchedActionIds: result.matchedActionIds, checkpointVerified: result.checkpointVerified }; recoveries.push(record); log('recovery.returned', { ...record, result }); return result; }
      catch (error) { log('recovery.failed', { api: 'reachExplorationTarget', sessionId: input[0], elapsedMs: performance.now() - began, code: code(error) }); throw error; }
    };
    const event = pluginStore.event.bind(pluginStore);
    pluginStore.event = input => { const saved = event(input); auditEvent(saved); return saved; };
    host.events.on('event', engineEvent);
    plugin = new ExplorerPlugin(host, pluginStore, { ...configured, jev: provider('jev', configured.jev), llm: provider('llm', configured.llm) });
    if (!config.resume) { const created = plugin.create(createTaskSchema.parse({ url: marker.url, goal: '', coverageMode: 'all', budget: config.budget, sessionOptions: { headless: true, executionPolicy: 'interface-only' } })); taskId = created.id; marker.taskId = taskId; atomicJson(markerPath, marker); }
    initial = pluginStore.task(taskId); atomicJson(join(runDirectory, 'task-before.json'), initial);
    if (initial.url !== marker.url || initial.goal !== '' || initial.coverageMode !== 'all') throw Object.assign(new Error(), { code: 'OWNED_TASK_CONFIGURATION_CHANGED' });
    for (const round of initial.rounds) sessions.add(round.sessionId);
    for (const sid of sessions) for (const attempt of host.list<ActionAttempt>(sid, 'attempt')) {
      if (attempt.status === 'succeeded') { baselineSuccesses.add(attempt.id); const key = conditionKey(attempt); if (key) successfulConditions.add(key); }
      else if (attempt.status === 'unknown' || attempt.status === 'executing') { unknownAttempts.set(attempt.id, { sessionId: sid, attemptId: attempt.id }); requestStop('preexisting_unknown_or_executing', { sessionId: sid, attemptId: attempt.id, status: attempt.status }); }
    }
    // Resume starts at the persisted source cursors; earlier run logs remain alongside it.
    cursors.plugin = (pluginMetrics.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE task_id=?').get(taskId) as { sequence: number }).sequence;
    for (const sid of sessions) cursors.engine[sid] = (engineStore.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?').get(sid) as { sequence: number }).sequence;
    log('run.ready', { taskId, routingVersion: plugin.status().routingVersion, cursors, priorStatus: initial.status, priorReason: initial.reason, priorUsage: initial.usage, priorBudget: initial.budget, historicalSucceededAttempts: baselineSuccesses.size });
    if (initial.pendingDispatch || initial.unverifiedRecoveries?.length || initial.unverifiedNavigations?.length) requestStop('preexisting_unverified_dispatch', { pendingDispatch: initial.pendingDispatch, recoveries: initial.unverifiedRecoveries, navigations: initial.unverifiedNavigations });
    try { await auditProtected(true); } catch (error) { requestStop('protected_evidence_integrity', { code: code(error) }); }
    if (!stopping && config.extend) { plugin.extendBudget(taskId, config.budget); log('budget.extended', { add: config.budget, budget: header()?.header.budget, usageUnchanged: header()?.header.usage }); }
    if (!stopping) { const task = header()!.header; if (task.usage.actions >= task.budget.actions || task.usage.modelRequests >= task.budget.modelRequests || task.usage.durationMs >= task.budget.durationMs) requestStop('task_budget_guard', { usage: task.usage, budget: task.budget }); }
    if (!stopping) {
      if (initial.status === 'completed') requestStop('already_completed_requires_review');
      else { log('start.requested', { taskId, priorStatus: initial.status, priorReason: initial.reason }); plugin.start(taskId); started = true; }
    }
    const deadline = Date.now() + config.budget.durationMs;
    while (plugin.owner() === taskId && !stopping) {
      drain();
      const current = header()!;
      if (current.header.usage.actions - initial.usage.actions >= config.budget.actions || current.header.usage.modelRequests - initial.usage.modelRequests >= config.budget.modelRequests || current.roundCount - initial.rounds.length > config.budget.rounds) requestStop('window_usage_budget', { usage: current.header.usage, before: initial.usage, windowBudget: config.budget });
      if (Date.now() - sampleAt >= config.sampleMs) { sampleAt = Date.now(); await sample(); }
      if (Date.now() >= deadline) requestStop('window_time_budget');
      if (Date.now() - lastProgress >= config.stallMs) requestStop('no_new_operation_condition_window', { elapsedMs: Date.now() - lastProgress, classification: 'stalled_or_review_only_requires_review' });
      if (!stopping) await new Promise<void>(done => setTimeout(done, 1000));
    }
    await plugin.waitForIdle(taskId);
    if (!stopping) { const task = header()!.header; requestStop(task.status === 'budget_exhausted' ? 'task_budget_guard' : 'task_halted_for_review', { status: task.status, reason: task.reason, exhaustive: false }); }
    await stopJob; await sample();
    try { await auditProtected(true); } catch (error) { requestStop('protected_evidence_integrity', { code: code(error) }); }
    final = pluginStore.task(taskId); atomicJson(join(runDirectory, 'task-after.json'), final);
    const finalAttempts = [...sessions].flatMap(sid => host!.list<ActionAttempt>(sid, 'attempt'));
    const finalUnknown = finalAttempts.filter(attempt => attempt.status === 'unknown' || attempt.status === 'executing').map(attempt => ({ sessionId: attempt.sessionId, attemptId: attempt.id, status: attempt.status }));
    if (finalUnknown.length) requestStop('settled_unknown_or_executing', finalUnknown);
    const beforeResolved = new Set(initial.plan.filter(item => item.status === 'succeeded' && item.resolvedBy?.attemptId).map(item => item.id));
    const newlyResolved = final.plan.filter(item => item.status === 'succeeded' && item.resolvedBy?.attemptId && !beforeResolved.has(item.id));
    atomicJson(join(runDirectory, 'coverage-review.json'), { exhaustive: false, newlySucceededExplorationAttemptIds: [...successes], newOperationConditionCandidates: newConditions, newlyResolvedPlanItems: newlyResolved, historicalCoverageOnly: final.plan.filter(item => item.coverageResolvedBy), unresolved: final.plan.filter(item => item.required && !['succeeded', 'excluded', 'superseded'].includes(item.status)), unknownAttempts: finalUnknown, pendingDispatch: final.pendingDispatch, unverifiedRecoveries: final.unverifiedRecoveries, unverifiedNavigations: final.unverifiedNavigations, recoveries,
      recoveryFollowup: recoveries.map(recovery => ({ ...recovery, subsequentSuccessfulAttempts: finalAttempts.filter(attempt => successes.has(attempt.id) && attempt.beforeId === recovery.observationId).map(attempt => ({ sessionId: attempt.sessionId, attemptId: attempt.id, beforeId: attempt.beforeId })), targetReadinessOnly: recovery.status === 'TARGET_REACHED', wholeCheckpointVerified: recovery.checkpointVerified === true })) });
  } catch (error) { fatal = code(error); requestStop('runner_failure', { code: fatal }); await stopJob; }
  finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    pluginMetrics?.close();
    try { if (plugin) { await plugin.close(); pluginStore = undefined; } else pluginStore?.close(); } catch (error) { fatal ||= code(error); log('close.plugin_failed', { code: code(error) }); }
    try { if (host) await host.close(); else engineStore?.close(); } catch (error) { fatal ||= code(error); log('close.engine_failed', { code: code(error) }); }
    // Close releases SQLite WAL handles before the final physical-byte snapshot.
    try { atomicJson(join(runDirectory, 'summary.json'), { format: FORMAT, runId, taskId, finishedAt: now(), started, fatal, guards, originalStop: guards[0], finalStatus: final?.status, finalReason: final?.reason, usageBefore: initial?.usage, usageAfter: final?.usage, providerCounts, attemptCounts, newSuccessfulExplorationAttempts: successes.size, recoveryCalls: recoveries.length, recoveryElapsedMs: recoveries.reduce((sum, recovery) => sum + recovery.elapsedMs, 0), cursors, diskAfterClose: await disk(directory), exhaustive: false, reviewRequired: true }); } finally { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close(); }
    console.log(JSON.stringify({ directory: runDirectory, taskId, reason: guards[0]?.reason || fatal, exhaustive: false, reviewRequired: true }));
    if (fatal || guards.some(guard => !['operator_signal', 'window_time_budget', 'window_usage_budget', 'task_budget_guard', 'already_completed_requires_review'].includes(guard.reason))) process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(JSON.stringify({ code: code(error), exhaustive: false })); process.exitCode = 2; });
