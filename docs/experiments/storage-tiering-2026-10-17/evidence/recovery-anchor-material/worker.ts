// Prepared only. runner.py owns the one temporary copy and invokes this worker
// only after explicit --run authorization. No original database is opened here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BrowserEngine } from '@interaction/browser';
import { PlaywrightAdapter } from '@interaction/adapter-playwright';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin } from '@interaction/explorer-plugin';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(value) ?? 'undefined');
const errorValue = (error: unknown) => ({ name: (error as any)?.name ?? 'Error', code: (error as any)?.code ?? null, message: String((error as any)?.message ?? error) });
const owned = resolve(cfg.ownedDirectory), directory = resolve(cfg.engineDirectory);
const within = (path: string) => { const rel = relative(owned, resolve(path)); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
assert(within(directory) && within(cfg.semantic));
assert.equal(readFileSync(join(owned, 'owner.txt'), 'utf8'), cfg.ownershipMarker);
assert.equal(resolve(process.cwd()), resolve(cfg.archiveRoot));
assert(!existsSync(cfg.output) && !existsSync(cfg.semantic), 'Never overwrite worker evidence');
const database = join(directory, 'engine.sqlite');
const fingerprints = () => Object.fromEntries(['', '-wal', '-shm'].map(suffix => {
  const path = database + suffix;
  return [suffix || 'main', existsSync(path) ? { bytes: statSync(path).size, sha256: sha(readFileSync(path)) } : null];
}));
const beforeConstructor = fingerprints();
assert.equal((beforeConstructor.main as any).sha256, cfg.databaseSha256);
assert.equal(beforeConstructor['-wal'], null); assert.equal(beforeConstructor['-shm'], null);
const inputBytes = readFileSync(cfg.taskFile);
assert.equal(sha(inputBytes), cfg.taskSha256);
const task = JSON.parse(inputBytes.toString('utf8'));
assert.equal(task.status, 'paused'); assert.equal(task.id, cfg.taskId);
assert.equal(task.plan.length, 1241);
assert.equal(Object.keys(task.routeRetries?.routes ?? {}).length, 8);
assert.equal(task.activeSince, undefined); assert.equal(task.pendingDispatch, undefined);
assert(!task.unverifiedRecoveries?.length);
assert(task.usage.actions < task.budget.actions && task.usage.durationMs < task.budget.durationMs, 'Original task budget is exhausted; do not alter it');
const originalBudget = hash(task.budget), originalPlan = hash(task.plan), originalDebt = hash(task.routeRetries);
task.status = 'running'; // The sole input transformation. Do not call start/resume.
const inputTaskHash = hash(task), beforeDebt = structuredClone(task.routeRetries ?? null);

type Phase = 'constructor' | 'setup' | 'selection' | 'revalidation' | 'report' | 'cleanup';
let phase: Phase = 'constructor', store: SqliteStore | undefined, engine: BrowserEngine | undefined, plugin: ExplorerPlugin | undefined;
const reads: Record<string, Record<string, number>> = {}, calls: Record<string, Record<string, number>> = {}, writes: Record<string, Record<string, number>> = {};
const forbidden: { phase: Phase; operation: string }[] = [], events: unknown[] = [];
const constructorWrites = createHash('sha256');
const count = (table: Record<string, Record<string, number>>, key: string) => { const bucket = table[phase] ??= {}; bucket[key] = (bucket[key] ?? 0) + 1; };
const deny = (operation: string): never => { forbidden.push({ phase, operation }); throw Error(`Forbidden in retained-facts comparison: ${operation}`); };
const createDriver = PlaywrightAdapter.prototype.createDriver;
PlaywrightAdapter.prototype.createDriver = () => deny('adapter.createDriver');
const report: any = {
  protocol: 'recovery-anchor-material-single-pair-v1', variant: cfg.variant, revision: cfg.revision,
  taskFile: cfg.taskFile, taskFileSha256: cfg.taskSha256, inputTaskSha256: inputTaskHash,
  inputTransformation: "task.status = 'running' only; original paused terminal task, budget, usage, cursor, plan and all debt retained",
  scope: 'One closed run12 terminal-state selector call plus selected callback revalidation, using retained SDK facts. Not the original live pre-selection state, end-to-end resume, browser recovery, coverage, or throughput.',
  semanticMetadataExclusions: [],
  instrumentation: 'Same host proxy applies public methods to the unmodified real engine; raw store wrappers installed before retention composition. Counts only, no material map or per-return JSON serialization. Nested require/get counts are separate, not summed as unique SQL calls.',
  retention: { sweepIntervalMs: 0, reason: 'Disable unrelated timed evidence expiry in both fixed-facts processes; no driver or background services.' },
  copy: { beforeConstructor }, callback: { present: false, invoked: false, status: 'not_selected' },
};
let selected: any, failure: unknown, queryStartChanges: number | undefined;
const totalChanges = () => (store!.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
try {
  store = new SqliteStore(directory);
  report.copy.sqliteConstructorChanges = totalChanges();
  // These wrappers exist before RetainedPersistence captures method identities.
  // They aggregate small counters and never keep a decoded return value alive.
  for (const method of ['get', 'require', 'list', 'listByObservation', 'events', 'request', 'entityChanges', 'decodeStoredEntity']) {
    const original = (store as any)[method]; if (typeof original !== 'function') continue;
    (store as any)[method] = function (...args: any[]) {
      const kind = ['get', 'require', 'list', 'listByObservation', 'entityChanges'].includes(method) ? args[0]
        : method === 'decodeStoredEntity' ? args[0]?.kind : undefined;
      count(reads, `${method}${typeof kind === 'string' ? ':' + kind : ''}`);
      return Reflect.apply(original, store, args);
    };
  }
  for (const method of ['put', 'event', 'recordRequest', 'compressObservations', 'compressStates', 'garbageCollectObservations', 'compact']) {
    const original = (store as any)[method]; if (typeof original !== 'function') continue;
    (store as any)[method] = function (...args: any[]) {
      count(writes, method);
      if (phase !== 'constructor') return deny(`store.${method}`);
      constructorWrites.update(JSON.stringify([method, args]) + '\n');
      return Reflect.apply(original, store, args);
    };
  }
  // No evidence file is copied or read. If the selector starts depending on one,
  // fail this protocol rather than treating the absent file as negative proof.
  for (const method of ['get', 'availability', 'put', 'delete', 'remove', 'collect', 'pin', 'unpin', 'release']) {
    if (typeof (store.evidence as any)[method] === 'function') (store.evidence as any)[method] = () => deny(`evidence.${method}`);
  }
  engine = new BrowserEngine({ persistence: store, retention: { sweepIntervalMs: 0 } });
  report.copy.afterConstructor = fingerprints();
  report.copy.constructorChanges = totalChanges();
  report.copy.constructorWritesSha256 = constructorWrites.digest('hex');
  assert.equal(engine.store.recordReadIsolation, 'detached', 'Instrumentation withdrew SDK detached-read contract');
  store.db.pragma('query_only = ON');
  report.queryOnly = store.db.pragma('query_only', { simple: true });
  assert.equal(report.queryOnly, 1);
  queryStartChanges = totalChanges();
  const emit = engine.events.emit;
  engine.events.emit = function (...args: any[]) { return deny(`engine.events.emit:${String(args[0])}`); } as typeof emit;
  const readonlyMethods = new Set(['session', 'sessions', 'observation', 'actions', 'actionAvailability', 'list', 'interactionTransition', 'recoverySourceMaterial', 'recoveryAnchorMaterial', 'checkpointRecoveryCandidates']);
  const wrappers = new Map<PropertyKey, unknown>();
  const host = new Proxy(engine, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (!wrappers.has(key)) wrappers.set(key, (...args: any[]) => {
      if (!readonlyMethods.has(String(key))) return deny(`host.${String(key)}`);
      count(calls, String(key));
      // Applying to the actual engine preserves all default-method identity
      // gates inside the new lightweight projection and the old material API.
      return Reflect.apply(value, target, args);
    });
    return wrappers.get(key);
  } });
  const sink = new Proxy({ event: (event: unknown) => { events.push(structuredClone(event)); return event; }, close: () => {} }, {
    get(target, key) { if (key in target) return Reflect.get(target, key); return () => deny(`pluginStore.${String(key)}`); },
  });
  phase = 'setup';
  plugin = new ExplorerPlugin(host as any, sink as any, {});
  const round = task.rounds.at(-1); assert.equal(round.sessionId, cfg.sessionId);
  assert.equal(round.position.observationId, cfg.currentObservationId);
  assert.equal(host.session(cfg.sessionId).currentObservationId, cfg.currentObservationId);
  const observation = host.observation(cfg.sessionId, cfg.currentObservationId), actions = host.actions(cfg.sessionId, cfg.currentObservationId);
  const availability = host.actionAvailability(cfg.sessionId, cfg.currentObservationId);
  report.inputFacts = { observation: hash(observation), actions: hash(actions), availability: hash(availability), session: hash(host.session(cfg.sessionId)) };
  report.originalTaskBudget = structuredClone(task.budget); report.originalTaskUsage = structuredClone(task.usage);
  report.resourcesBeforeSelection = { memory: process.memoryUsage(), usage: process.resourceUsage() };
  const cpuBefore = process.cpuUsage(), start = performance.now();
  phase = 'selection';
  const routeCondition = (plugin as any).routeConditionReader(observation, actions), readerEnd = performance.now();
  selected = await (plugin as any).scheduledRecovery(task, round, observation, actions, availability, routeCondition, new AbortController().signal);
  const selectedAt = performance.now();
  phase = 'revalidation';
  if (selected !== undefined) {
    report.callback = { present: typeof selected.revalidate === 'function', invoked: false, status: 'not_invoked' };
    assert.equal(report.callback.present, true, 'Selected recovery lacks its final boundary validator');
    report.callback.invoked = true;
    try { selected.revalidate(); report.callback.status = 'passed'; }
    catch (error) { report.callback.status = 'failed'; report.callback.error = errorValue(error); throw error; }
  }
  const end = performance.now(), cpu = process.cpuUsage(cpuBefore);
  // Capture all reported memory/resource figures before any output, deep copy,
  // semantic JSON encoding, hashes, DB fingerprinting, or compression.
  report.resourcesAtSelectionEnd = { memory: process.memoryUsage(), usage: process.resourceUsage() };
  report.timingsMs = { readerConstruction: readerEnd - start, selector: selectedAt - readerEnd, revalidation: end - selectedAt, total: end - start, cpuUser: cpu.user / 1000, cpuSystem: cpu.system / 1000 };
  phase = 'report';
  assert.equal(hash(task.budget), originalBudget, 'Selector changed task budget');
  assert.equal(hash(task.plan), originalPlan, 'Selector changed plan');
  assert.equal(forbidden.length, 0, 'A swallowed forbidden read/write invalidates the comparison');
  report.querySqlChanges = totalChanges() - queryStartChanges;
  assert.equal(report.querySqlChanges, 0, 'Read-only selector changed SQL records');
  report.copy.afterQuery = fingerprints();
  report.planUnchanged = true; report.budgetUnchanged = true;
  report.routeRetriesBeforeSha256 = originalDebt; report.routeRetriesAfterSha256 = hash(task.routeRetries);
  let selectionData: any = null;
  if (selected !== undefined) {
    const { revalidate, ...data } = selected;
    assert.equal(typeof revalidate, 'function');
    selectionData = data;
  }
  const semantic = { selection: selectionData, callback: report.callback, task, events, routeRetriesBefore: beforeDebt, routeRetriesAfter: task.routeRetries ?? null };
  // Never silently omit another callable field. Only revalidate is excluded,
  // represented by its independently invoked result above.
  const json = JSON.stringify(semantic, (key, value) => { if (typeof value === 'function') throw Error(`Unexpected callable semantic field: ${key}`); return value; });
  writeFileSync(cfg.semantic, json, { flag: 'wx' });
  report.completeSemanticSha256 = sha(json); report.completeSemanticBytes = Buffer.byteLength(json);
  report.selectedSummary = selected ? { itemId: selected.itemId, routeKey: selected.routeKey, checkpointId: selected.frame.checkpointId, sourceObservationId: selected.source.id, returnToSource: selected.returnToSource, targetActionIds: selected.targetActionIds } : null;
  report.events = { count: events.length, sha256: hash(events) };
} catch (error) {
  failure = error; report.error = errorValue(error); process.exitCode = 1;
} finally {
  // Even failures disclose resources before report serialization; never disguise
  // a timeout/error as a normal performance sample.
  if (!report.resourcesAtSelectionEnd) report.resourcesAtFailure = { memory: process.memoryUsage(), usage: process.resourceUsage() };
  if (store && queryStartChanges !== undefined && store.db.open) report.querySqlChanges = totalChanges() - queryStartChanges;
  phase = 'cleanup';
  try { await plugin?.close(); if (engine) await engine.close(); else store?.close(); }
  catch (error) { report.cleanupError = errorValue(error); process.exitCode = 1; }
  finally { if (store?.db.open) store.close(); }
  PlaywrightAdapter.prototype.createDriver = createDriver;
  report.databaseHandleClosed = !store?.db.open;
  report.copy.afterClose = fingerprints();
  report.reads = reads; report.hostCalls = calls; report.writes = writes; report.forbidden = forbidden;
  report.taskInputUnchanged = sha(readFileSync(cfg.taskFile)) === cfg.taskSha256;
  if (forbidden.length || !report.taskInputUnchanged) process.exitCode = 1;
  report.success = !failure && !report.cleanupError && !forbidden.length && report.querySqlChanges === 0 && report.taskInputUnchanged;
  writeFileSync(cfg.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ output: cfg.output, success: report.success, timingsMs: report.timingsMs, callback: report.callback, selected: report.selectedSummary, error: report.error }));
