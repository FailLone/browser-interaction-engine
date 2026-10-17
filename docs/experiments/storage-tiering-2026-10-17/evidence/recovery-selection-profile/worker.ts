// One fixed candidate, externally bounded at 240 seconds. Synchronous telemetry
// survives termination; completed semantic results are stored once, separately.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const started = performance.now();
let phase = 'worker_entry', metadataLines = 0, lastProgress = started;
const emit = (event: string, data: unknown = {}) => writeSync(1, JSON.stringify({ event, phase, elapsedMs: performance.now() - started, data }) + '\n');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value: unknown) => hash(JSON.stringify(value) ?? 'undefined');
const errorData = (error: unknown) => ({ name: (error as any)?.name, code: (error as any)?.code, message: String((error as any)?.message ?? error) });
type Aggregate = { entered: number; completed: number; errors: number; totalMs: number; maxMs: number };
const aggregates: Record<string, Record<string, Aggregate>> = {};
const observationReadIds: Record<string, Record<string, Map<string, number>>> = {};
const observationIdSummary = (group: Record<string, Map<string, number>> = {}) => Object.fromEntries(Object.entries(group).map(([method, ids]) => [method, {
  calls: [...ids.values()].reduce((sum, count) => sum + count, 0), distinct: ids.size, repeatedCalls: [...ids.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0), topRepeated: [...ids].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([id, count]) => ({ id, count })),
}]));
const returnedCounts: Record<string, Record<string, number>> = {}, eventTypes: Record<string, number> = {}, events: unknown[] = [];
const deferrals = { calls: 0, uniqueItems: new Set<string>(), reasons: {} as Record<string, number> };
const idCount = (key: string, id: unknown) => { if (typeof id === 'string') { const ids = (observationReadIds[phase] ??= {})[key] ??= new Map(); ids.set(id, (ids.get(id) ?? 0) + 1); } };
const quantity = (key: string, count: number) => { const bucket = returnedCounts[phase] ??= {}; bucket[key] = (bucket[key] ?? 0) + count; };
const stack: { key: string; beganMs: number }[] = [], seen = new Set<string>(), forbidden: string[] = [];
const metadata = (event: string, data: unknown) => {
  if (metadataLines < 512) { metadataLines++; emit(event, data); }
  else if (metadataLines === 512) { metadataLines++; emit('call_metadata_capped', { limit: 512, progressAndPhaseLogsContinue: true }); }
};
const progress = (force = false) => {
  const at = performance.now();
  if (force || at - lastProgress >= 1000) {
    lastProgress = at;
    emit('progress', { active: stack.map(call => ({ key: call.key, activeMs: at - call.beganMs })), aggregates: aggregates[phase] ?? {},
      observationReadIds: observationIdSummary(observationReadIds[phase]), returnedCounts: returnedCounts[phase] ?? {}, eventTypes,
      deferrals: { calls: deferrals.calls, uniqueItems: deferrals.uniqueItems.size, reasons: deferrals.reasons }, resourceUsage: process.resourceUsage(), memory: process.memoryUsage() });
  }
};
const invoke = <T>(key: string, heavy: boolean, fn: () => T, detailData: unknown = {}): T => {
  const group = aggregates[phase] ??= {}, row = group[key] ??= { entered: 0, completed: 0, errors: 0, totalMs: 0, maxMs: 0 };
  row.entered++;
  const start = performance.now(), outer = stack.length === 0, first = !seen.has(`${phase}:${key}`);
  seen.add(`${phase}:${key}`); stack.push({ key, beganMs: start });
  const detail = first || outer && heavy;
  if (detail) (outer && heavy ? emit : metadata)('call.begin', { key, outer, input: detailData });
  progress();
  try { return fn(); }
  catch (error) { row.errors++; throw error; }
  finally {
    const ms = performance.now() - start;
    row.completed++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms);
    if (detail) (outer && heavy ? emit : metadata)('call.end', { key, elapsedMs: ms });
    progress(); stack.pop();
  }
};
const phaseTimings: Record<string, number> = {};
const stage = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
  phase = name; const start = performance.now(); emit('phase.begin');
  try { const value = await fn(); progress(true); phaseTimings[name] = performance.now() - start; emit('phase.end', { elapsedMs: phaseTimings[name] }); return value; }
  catch (error) { progress(true); emit('phase.error', errorData(error)); throw error; }
};
const deny = (operation: string): never => { forbidden.push(operation); emit('forbidden', { operation }); throw Error(`Forbidden: ${operation}`); };
emit('worker.begin', { purpose: 'One 240-second fixed candidate; no baseline rerun or percentage-speedup claim' });

let engine: any, store: any, plugin: any, adapter: any, originalCreateDriver: any, queryStart: number | undefined;
const writeCounts: Record<string, Record<string, number>> = {};
let task: any, cfg: any, originalPlan: string, originalBudget: string, originalUsage: string, originalDebt: string, originalRounds: string, beforeDebt: unknown;
const report: any = { callback: { present: false, invoked: false, status: 'not_selected' } };
let success = false, selected: any;
const totalChanges = () => store.db.prepare('SELECT total_changes() AS n').get().n;
try {
  cfg = await stage('input_validation', () => {
    const value = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const owned = resolve(value.ownedDirectory), directory = resolve(value.engineDirectory), rel = relative(owned, directory);
    assert(rel && !rel.startsWith('..') && !isAbsolute(rel));
    assert.equal(readFileSync(join(owned, 'owner.txt'), 'utf8'), value.ownershipMarker);
    assert.equal(resolve(process.cwd()), resolve(value.archiveRoot));
    const database = join(directory, 'engine.sqlite');
    assert(!existsSync(database + '-wal') && !existsSync(database + '-shm'));
    assert.equal(hash(readFileSync(database)), value.databaseSha256);
    const bytes = readFileSync(value.taskFile); assert.equal(hash(bytes), value.taskSha256);
    task = JSON.parse(bytes.toString('utf8'));
    assert.equal(task.status, 'paused'); assert.equal(task.activeSince, undefined); assert.equal(task.pendingDispatch, undefined);
    assert(!task.unverifiedRecoveries?.length);
    assert.equal(task.plan.length, 1241); assert.equal(Object.keys(task.routeRetries?.routes ?? {}).length, 8);
    assert(task.usage.actions < task.budget.actions && task.usage.durationMs < task.budget.durationMs);
    assert.equal(task.rounds.at(-1).sessionId, value.sessionId);
    assert.equal(task.rounds.at(-1).position.observationId, value.currentObservationId);
    originalPlan = jsonHash(task.plan); originalBudget = jsonHash(task.budget); originalUsage = jsonHash(task.usage);
    originalDebt = jsonHash(task.routeRetries); originalRounds = jsonHash(task.rounds); beforeDebt = structuredClone(task.routeRetries);
    task.status = 'running';
    report.inputTaskSha256 = jsonHash(task); report.revision = value.revision;
    const semanticRel = relative(owned, resolve(value.semantic)); assert(semanticRel && !semanticRel.startsWith('..') && !isAbsolute(semanticRel));
    assert(!existsSync(value.semantic) && !existsSync(value.output));
    emit('input_hashes_passed', { databaseSha256: value.databaseSha256, taskSha256: value.taskSha256,
      inputTaskAfterStatusOnlySha256: jsonHash(task), budget: task.budget, usage: task.usage, planRows: task.plan.length,
      debtRoutes: Object.keys(task.routeRetries.routes).length, sourceDatabaseConnection: false });
    return value;
  });
  const modules = await stage('module_imports', async () => ({
    browser: await import('@interaction/browser'), sqlite: await import('@interaction/storage-sqlite'),
    adapter: await import('@interaction/adapter-playwright'), explorer: await import('@interaction/explorer-plugin'),
  }));
  adapter = modules.adapter.PlaywrightAdapter;
  originalCreateDriver = adapter.prototype.createDriver;
  adapter.prototype.createDriver = () => deny('adapter.createDriver');
  store = await stage('sqlite_constructor', () => new modules.sqlite.SqliteStore(cfg.engineDirectory));
  emit('sqlite_constructor_changes', { totalChanges: totalChanges() });
  for (const method of ['get', 'require', 'list', 'listByObservation', 'events', 'request', 'entityChanges', 'decodeStoredEntity']) {
    const original = store[method]; if (typeof original !== 'function') continue;
    store[method] = (...args: any[]) => {
      const kind = ['get', 'require', 'list', 'listByObservation', 'entityChanges'].includes(method) ? args[0] : method === 'decodeStoredEntity' ? args[0]?.kind : undefined;
      // A timer (including InspectionCoordinator's independent sweep) may read
      // while the async selector is yielded. Phase alone cannot attribute it to
      // resume/current validation; keep reads outside a host call separate.
      const attribution = phase !== 'engine_constructor' && !stack.some(call => call.key.startsWith('host.')) ? 'unattributed.' : '';
      const key = `${attribution}store.${method}${typeof kind === 'string' ? ':' + kind : ''}`;
      if (kind === 'observation' && (method === 'get' || method === 'require') && typeof args[1] === 'string') {
        idCount(`${attribution}${method}:observation`, args[1]);
      }
      if (kind === 'action' && (method === 'get' || method === 'require')) idCount(`${attribution}${method}:actionId`, args[1]);
      if (kind === 'action' && method === 'listByObservation') idCount(`${attribution}${method}:actionObservationId`, args[2]);
      return invoke(key, method === 'list' || method === 'listByObservation' || kind === 'observation', () => {
        const result = Reflect.apply(original, store, args); if (Array.isArray(result)) quantity(key + '.returnedRows', result.length); return result;
      });
    };
  }
  for (const method of ['put', 'event', 'recordRequest', 'compressObservations', 'compressStates', 'garbageCollectObservations', 'compact']) {
    const original = store[method]; if (typeof original !== 'function') continue;
    store[method] = (...args: any[]) => {
      const counts = writeCounts[phase] ??= {}; counts[method] = (counts[method] ?? 0) + 1;
      if (phase !== 'engine_constructor') return deny(`store.${method}`);
      return Reflect.apply(original, store, args);
    };
  }
  for (const method of ['get', 'availability', 'put', 'delete', 'remove', 'collect', 'pin', 'unpin', 'release']) {
    if (typeof store.evidence[method] === 'function') store.evidence[method] = () => deny(`evidence.${method}`);
  }
  engine = await stage('engine_constructor', () => new modules.browser.BrowserEngine({ persistence: store, retention: { sweepIntervalMs: 0 } }));
  assert.equal(engine.store.recordReadIsolation, 'detached');
  store.db.pragma('query_only = ON'); assert.equal(store.db.pragma('query_only', { simple: true }), 1);
  queryStart = totalChanges();
  emit('query_guards_passed', { queryOnly: true, detached: true, constructorSqlChanges: queryStart,
    constructorWrites: writeCounts, retentionSweepIntervalMs: 0, driverAttached: false });
  engine.events.emit = (...args: any[]) => deny(`engine.events.emit:${String(args[0])}`);
  const allowed = new Set(['session', 'sessions', 'observation', 'actions', 'actionAvailability', 'list', 'interactionTransition', 'recoverySourceMaterial', 'recoveryAnchorMaterial', 'checkpointRecoveryCandidates']);
  const wrappers = new Map<PropertyKey, unknown>();
  const host = new Proxy(engine, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (!wrappers.has(key)) wrappers.set(key, (...args: any[]) => {
      if (!allowed.has(String(key))) return deny(`host.${String(key)}`);
      const name = String(key), input = args[1];
      if (['recoverySourceMaterial', 'recoveryAnchorMaterial'].includes(name)) idCount(`host.${name}.sourceObservationId`, input?.sourceObservationId);
      if (['observation', 'actions', 'actionAvailability'].includes(name)) idCount(`host.${name}.observationId`, typeof input === 'string' ? input : '<current>');
      if (name === 'checkpointRecoveryCandidates') { quantity(`host.${name}.requestedCheckpointIds`, input?.checkpointIds?.length ?? 0); for (const id of input?.checkpointIds ?? []) idCount(`host.${name}.checkpointId`, id); }
      return invoke(`host.${name}`, key !== 'session', () => {
        const result = Reflect.apply(value, target, args);
        if (Array.isArray(result)) quantity(`host.${name}.returnedRows`, result.length);
        if (name === 'recoverySourceMaterial') quantity(`host.${name}.returnedActions`, result?.actions?.length ?? 0);
        if (name === 'actionAvailability') quantity(`host.${name}.returnedActions`, result?.actions?.length ?? 0);
        return result;
      }, { sourceObservationId: input?.sourceObservationId, currentObservationId: input?.currentObservationId, checkpointIds: input?.checkpointIds, observationId: typeof input === 'string' ? input : undefined });
    });
    return wrappers.get(key);
  } });
  const sink = new Proxy({ event: (event: any) => { eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1; events.push(structuredClone(event)); return event; }, close: () => {} }, {
    get(target, key) { return key in target ? Reflect.get(target, key) : () => deny(`pluginStore.${String(key)}`); },
  });
  plugin = await stage('plugin_constructor', () => new modules.explorer.ExplorerPlugin(host as any, sink as any, {}));
  const defer = plugin.deferObligation;
  plugin.deferObligation = (...args: any[]) => { deferrals.calls++; deferrals.uniqueItems.add(args[1]); deferrals.reasons[args[3]] = (deferrals.reasons[args[3]] ?? 0) + 1; return Reflect.apply(defer, plugin, args); };
  const observation = await stage('setup_current_observation', () => {
    assert.equal(host.session(cfg.sessionId).currentObservationId, cfg.currentObservationId);
    return host.observation(cfg.sessionId, cfg.currentObservationId);
  });
  const actions = await stage('setup_current_actions', () => host.actions(cfg.sessionId, cfg.currentObservationId));
  const availability = await stage('setup_current_availability', () => host.actionAvailability(cfg.sessionId, cfg.currentObservationId));
  await stage('setup_fact_hashes', () => { report.inputFacts = { observationId: observation.id, observation: jsonHash(observation), actions: jsonHash(actions), availability: jsonHash(availability) }; emit('facts_passed', report.inputFacts); });
  report.resourcesBeforeSelection = { memory: process.memoryUsage(), usage: process.resourceUsage() };
  const routeCondition = await stage('route_condition_reader', () => plugin.routeConditionReader(observation, actions));
  selected = await stage('scheduled_recovery', () => plugin.scheduledRecovery(task, task.rounds.at(-1), observation, actions, availability,
    routeCondition, new AbortController().signal));
  if (selected !== undefined) await stage('selected_revalidation', () => {
    report.callback = { present: typeof selected.revalidate === 'function', invoked: false, status: 'not_invoked' };
    assert.equal(report.callback.present, true); report.callback.invoked = true;
    try { selected.revalidate(); report.callback.status = 'passed'; }
    catch (error) { report.callback.status = 'failed'; report.callback.error = errorData(error); throw error; }
  });
  report.resourcesAtSelectionEnd = { memory: process.memoryUsage(), usage: process.resourceUsage() };
  await stage('semantic_summary', () => {
    assert.equal(jsonHash(task.plan), originalPlan); assert.equal(jsonHash(task.budget), originalBudget);
    assert.equal(jsonHash(task.usage), originalUsage); assert.equal(jsonHash(task.rounds), originalRounds);
    assert.equal(jsonHash(task.routeRetries), originalDebt);
    report.invariants = { planUnchanged: true, budgetUnchanged: true, usageUnchanged: true, roundsAndCursorUnchanged: true, routeRetriesUnchanged: true };
    report.querySqlChanges = totalChanges() - queryStart!;
    assert.equal(forbidden.length, 0); assert.equal(totalChanges() - queryStart!, 0);
    emit('selection_summary', { selected: selected ? { itemId: selected.itemId, checkpointId: selected.frame.checkpointId, sourceObservationId: selected.source.id } : null,
      callbackInvoked: selected !== undefined, planUnchanged: true, budgetUnchanged: true, taskSha256: jsonHash(task), debtSha256: jsonHash(task.routeRetries), eventTypes, querySqlChanges: 0 });
  });
  await stage('semantic_serialization', () => {
    let selection: any = null;
    if (selected !== undefined) { const { revalidate, ...data } = selected; assert.equal(typeof revalidate, 'function'); selection = data; }
    const semantic = { selection, callback: report.callback, task, events, routeRetriesBefore: beforeDebt, routeRetriesAfter: task.routeRetries };
    const json = JSON.stringify(semantic, (key, value) => { if (typeof value === 'function') throw Error(`Unexpected callable semantic field: ${key}`); return value; });
    writeFileSync(cfg.semantic, json, { flag: 'wx' });
    report.completeSemanticSha256 = hash(json); report.completeSemanticBytes = Buffer.byteLength(json);
    report.selectedSummary = selected ? { itemId: selected.itemId, checkpointId: selected.frame.checkpointId, sourceObservationId: selected.source.id } : null;
  });
  success = true;
} catch (error) {
  report.error = errorData(error); emit('worker.error', report.error); process.exitCode = 1;
} finally {
  report.resourcesBeforeCleanup = { memory: process.memoryUsage(), usage: process.resourceUsage() };
  if (queryStart !== undefined && store?.db.open) report.querySqlChanges = totalChanges() - queryStart;
  try { if (plugin) await stage('plugin_close', () => plugin.close()); }
  catch (error) { success = false; emit('cleanup.error', errorData(error)); process.exitCode = 1; }
  try { if (engine) await stage('engine_close', () => engine.close()); else if (store) await stage('store_close', () => store.close()); }
  catch (error) { success = false; emit('cleanup.error', errorData(error)); process.exitCode = 1; }
  if (store?.db.open) await stage('store_close_fallback', () => store.close());
  if (adapter) adapter.prototype.createDriver = originalCreateDriver;
  if (forbidden.length) process.exitCode = 1;
  await stage('report', () => {
    Object.assign(report, { success: success && !forbidden.length, databaseHandleClosed: !store?.db.open,
      phaseTimings, aggregates, returnedCounts, eventTypes, writeCounts, forbidden, metadataLines,
      deferrals: { calls: deferrals.calls, uniqueItems: deferrals.uniqueItems.size, reasons: deferrals.reasons },
      noReadResultCollection: true, noPerformanceComparison: true,
      observationReadIds: Object.fromEntries(Object.entries(observationReadIds).map(([name, group]) => [name, observationIdSummary(group)])),
      attribution: 'Raw accessor calls are not exact SQL counts. Storage calls outside host wrappers are unattributed; inspection timer remains enabled. Inclusive nested durations must not be summed.' });
    if (cfg) writeFileSync(cfg.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    emit('terminal_summary', { success: report.success, databaseHandleClosed: report.databaseHandleClosed, output: cfg?.output, phaseTimings });
  });
}
