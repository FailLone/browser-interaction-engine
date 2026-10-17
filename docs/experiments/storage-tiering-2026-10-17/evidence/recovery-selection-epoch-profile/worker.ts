// Prepared for one fixed selection-epoch integration sample, bounded at 240s.
// Only outer facades are instrumented; SDK/store/adapter methods stay original.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

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
const viewStats = { requested: 0, acquired: 0, closed: 0 };
const launcherGuards: { target: any; key: string; descriptor?: PropertyDescriptor }[] = [];
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
      viewStats, resourceUsage: process.resourceUsage(), memory: process.memoryUsage() });
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

let engine: any, store: any, plugin: any, queryStart: number | undefined;
let task: any, cfg: any, originalPlan: string, originalBudget: string, originalUsage: string, originalDebt: string, originalRounds: string, beforeDebt: unknown;
const report: any = {
  scope: 'One frozen terminal-task scheduledRecovery call and, only if selected, its revalidate callback. Not the real step dispatch boundary, browser recovery, arrival or new coverage.',
  background: 'InspectionCoordinator immediate sweep and one-second timer remain enabled as in prior samples. They may attempt writes and incur unattributed background costs; query_only and post-construction total_changes check writes, not purity of every query. Constructor changes are reported separately.',
  callback: { present: false, invoked: false, status: 'not_selected' },
};
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
  await stage('browser_launcher_guards', () => {
    // Resolve Playwright from its actual adapter dependency. Patching only the
    // BrowserType instances leaves SDK adapter/store prototypes and functions
    // unchanged, including the selection-view composition certificate.
    const require = createRequire(import.meta.url);
    const playwright = createRequire(require.resolve('@interaction/adapter-playwright'))('playwright');
    for (const name of ['chromium', 'firefox', 'webkit']) for (const key of ['launch', 'launchPersistentContext', 'connect', 'connectOverCDP']) {
      const target = playwright[name]; if (typeof target?.[key] !== 'function') continue;
      launcherGuards.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
      Object.defineProperty(target, key, { configurable: true, writable: true, value: () => deny(`browser.${name}.${key}`) });
    }
    assert(launcherGuards.length >= 9);
    emit('browser_entrypoints_blocked', { count: launcherGuards.length, sdkMethodsChanged: false });
  });
  const modules = await stage('module_imports', async () => ({
    browser: await import('@interaction/browser'), sqlite: await import('@interaction/storage-sqlite'),
    explorer: await import('@interaction/explorer-plugin'),
  }));
  store = await stage('sqlite_constructor', () => new modules.sqlite.SqliteStore(cfg.engineDirectory));
  report.sqliteConstructorSqlChanges = totalChanges();
  emit('sqlite_constructor_changes', { totalChanges: totalChanges() });
  engine = await stage('engine_constructor', () => new modules.browser.BrowserEngine({ persistence: store, retention: { sweepIntervalMs: 0 } }));
  assert.equal(engine.store.recordReadIsolation, 'detached');
  store.db.pragma('query_only = ON'); assert.equal(store.db.pragma('query_only', { simple: true }), 1);
  queryStart = totalChanges();
  report.allConstructorSqlChanges = queryStart;
  emit('query_guards_passed', { queryOnly: true, detached: true, constructorSqlChanges: queryStart,
    retentionSweepIntervalMs: 0, driverAttached: engine.driver !== undefined });
  assert.equal(engine.driver, undefined);
  assert.equal(typeof engine.store.recordRevision?.(), 'string');
  const allowed = new Set(['session', 'sessions', 'observation', 'actions', 'actionAvailability', 'list', 'interactionTransition', 'recoverySourceMaterial', 'recoveryAnchorMaterial', 'recoverySelectionView', 'checkpointRecoveryCandidates']);
  const wrapView = (view: any) => {
    viewStats.requested++;
    assert(view, 'Required SDK selection view unavailable; do not measure the legacy fallback');
    assert.equal(typeof view.source, 'function'); assert.equal(typeof view.assertCurrent, 'function'); assert.equal(typeof view.close, 'function');
    viewStats.acquired++;
    quantity('view.current.materializations', 1);
    quantity('view.current.availabilityMaterializations', 1);
    emit('selection_view_acquired', { observationId: view.current.observation.id, actions: view.current.actions.length, availabilityActions: view.current.availability.actions.length });
    const read = (method: 'source' | 'anchor', observationId: string) => {
      idCount(`view.${method}.sourceObservationId`, observationId);
      return invoke(`view.${method}`, true, () => {
        const result = view[method](observationId);
        if (method === 'source') quantity('view.source.returnedActions', result.actions.length);
        return result;
      }, { observationId });
    };
    // The SDK view is frozen. A separate facade, not a Proxy over its immutable
    // properties, preserves that object and forwards every validation call.
    return Object.freeze({ current: view.current, source: (id: string) => read('source', id),
      ...(view.anchor ? { anchor: (id: string) => read('anchor', id) } : {}),
      assertCurrent: () => invoke('view.assertCurrent', false, () => view.assertCurrent()),
      close: () => invoke('view.close', false, () => { view.close(); viewStats.closed++; }),
    });
  };
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
        if (name === 'recoverySelectionView') return wrapView(result);
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
    assert.equal(engine.driver, undefined); assert.equal(viewStats.requested, 1); assert.equal(viewStats.acquired, 1); assert.equal(viewStats.closed, 1);
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
  for (const { target, key, descriptor } of launcherGuards) { if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key]; }
  if (forbidden.length) process.exitCode = 1;
  await stage('report', () => {
    Object.assign(report, { success: success && !forbidden.length, databaseHandleClosed: !store?.db.open,
      phaseTimings, aggregates, returnedCounts, eventTypes, forbidden, metadataLines,
      viewStats,
      noReadResultCollection: true, noPerformanceComparison: true,
      observationReadIds: Object.fromEntries(Object.entries(observationReadIds).map(([name, group]) => [name, observationIdSummary(group)])),
      attribution: 'Only external host/view facade calls are counted; internally composed SDK reads and SQL counts are not measured. View creation includes its current observation/actions/availability work. Deferrals are staged by the product, so events count only published output, not every examined item. Inclusive timings must not be summed across nesting.' });
    if (cfg) writeFileSync(cfg.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    emit('terminal_summary', { success: report.success, databaseHandleClosed: report.databaseHandleClosed, output: cfg?.output, phaseTimings });
  });
}
