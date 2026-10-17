import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { normalizeOperationScheduling } from '../../../../../packages/explorer-plugin/src/operation-scheduling.js';
import type { ExplorerHost, Task } from '../../../../../packages/explorer-plugin/src/types.js';
import { decodeStoredEntity, type StoredEntityRow } from '../../../../../packages/storage-sqlite/src/entity-codec.js';
import { ObservationObjectStore } from '../../../../../packages/storage-sqlite/src/observation-store.js';

// One existing pure normalization call. No engine, plugin store, or browser is constructed.
const out = new URL('.', import.meta.url), root = fileURLToPath(new URL('../../../../../', out));
const databasePath = root + '.data/okx-storage-acceptance-20261017-v8/engine/engine.sqlite';
const taskPath = new URL('../plugin-loop-1/task-before.json', out);
const task: Task = JSON.parse(readFileSync(taskPath, 'utf8'));
const require = createRequire(new URL('../../../../../packages/storage-sqlite/package.json', out));
const Database = require('better-sqlite3');
assert.equal(process.env.SQLITE_USE_URI, '1');
const uri = pathToFileURL(databasePath); uri.search = 'mode=ro&immutable=1';
const db = new Database(uri.href, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
assert.equal(db.pragma('query_only', { simple: true }), 1);
assert.equal(realpathSync(db.prepare('PRAGMA database_list').get().file), realpathSync(databasePath));
assert.equal(db.prepare('SELECT total_changes() AS n').get().n, 0);
// Its constructor only prepares statements; this diagnostic calls begin/resolve/end,
// never encode/pack/collect. A write callback is also forbidden independently.
const objects = new ObservationObjectStore(db, () => { throw Error('Unexpected object-store mutation'); });
const one = db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? AND id=?');
const list = db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? AND session_id=? ORDER BY rowid');
// Same source SQL expression and fallback bucket as SqliteStore.listByObservation.
const projection = `CASE WHEN compressed_json IS NULL AND json_valid(json) THEN
  CASE WHEN json_type(json,'$.observationId')='text'
    AND json_type(json_remove(json,'$.observationId'),'$.observationId') IS NULL
    AND instr(json,'\\u')=0 AND json_type(json,'$.$interactionStorage') IS NULL
  THEN json_extract(json,'$.observationId') END END`;
const actionQuery = db.prepare(`SELECT * FROM (
  SELECT rowid AS position,kind,json,compressed_json FROM entities INDEXED BY entities_action_observation WHERE kind='action' AND session_id=? AND (${projection})=?
  UNION ALL
  SELECT rowid AS position,kind,json,compressed_json FROM entities INDEXED BY entities_action_observation WHERE kind='action' AND session_id=? AND (${projection}) IS NULL
  ) ORDER BY position`);
const counts = { observationReads: 0, directObservationReads: 0, actionsValidationObservationReads: 0,
  observationStoredBytes: 0, observationLogicalBytes: 0, observationQueryMs: 0, observationDecodeMs: 0, observationHostMs: 0,
  actionCalls: 0, actionRows: 0, actionStoredBytes: 0, actionQueryMs: 0, actionDecodeMs: 0,
  listCalls: 0, listRows: 0, listMs: 0, itemsEntered: 0, itemsCompleted: 0, errors: 0, progressWriteMs: 0 };
const reads = new Map<string, { calls: number; direct: number; actionsValidation: number; logicalBytes: number; decodeMs: number }>();
const actionSources = new Map<string, number>();
const itemReads = new Map<string, { itemId: string; observationReads: number; actionCalls: number; sourceIds: Set<string>; elapsedMs?: number; hadAudit: boolean; hasAudit?: boolean }>();
let completedSinceProgress: unknown[] = [];
const errors: { stage: string; id?: string; message: string }[] = [];
let began = performance.now(), lastProgress = 0, currentItem: string | undefined;
const metrics = () => ({ elapsedMs: performance.now() - began, counts: { ...counts },
  distinctObservations: reads.size, repeatedObservationReads: counts.observationReads - reads.size,
  distinctActionSources: actionSources.size, currentItem, rssBytes: process.memoryUsage().rss,
  maxRssKiB: process.resourceUsage().maxRSS, objectCache: objects.cacheStats(), errors });
const progress = (force = false) => {
  if (!force && performance.now() - lastProgress < 1000) return;
  const t = performance.now(), item = currentItem && itemReads.get(currentItem);
  appendFileSync(new URL('progress.jsonl', out), JSON.stringify({ ...metrics(), completedItems: completedSinceProgress,
    currentItemReads: item ? { ...item, sourceIds: [...item.sourceIds] } : undefined }) + '\n');
  completedSinceProgress = [];
  counts.progressWriteMs += performance.now() - t; lastProgress = performance.now();
};
const fail = (stage: string, id: string | undefined, e: unknown) => {
  counts.errors++; if (errors.length < 10) errors.push({ stage, id, message: String(e) }); progress(true); throw e;
};
const readObservation = (sid: string, oid: string, origin: 'direct' | 'actionsValidation') => {
  const started = performance.now(); counts.observationReads++;
  if (currentItem) { const item = itemReads.get(currentItem)!; item.observationReads++; item.sourceIds.add(oid); }
  if (origin === 'direct') counts.directObservationReads++; else counts.actionsValidationObservationReads++;
  const key = JSON.stringify([sid, oid]), entry = reads.get(key) ?? { calls: 0, direct: 0, actionsValidation: 0, logicalBytes: 0, decodeMs: 0 };
  entry.calls++; entry[origin]++; reads.set(key, entry);
  try {
    const q = performance.now(); const row: StoredEntityRow = one.get('observation', oid); counts.observationQueryMs += performance.now() - q;
    assert.ok(row); assert.equal(row.session_id, sid);
    counts.observationStoredBytes += Buffer.byteLength(row.json) + (row.compressed_json?.byteLength ?? 0);
    const logical = row.json.length < 4096 ? JSON.parse(row.json).$interactionStorage?.bytes ?? Buffer.byteLength(row.json) : Buffer.byteLength(row.json);
    counts.observationLogicalBytes += logical; entry.logicalBytes += logical;
    objects.begin(true); const d = performance.now();
    const value = decodeStoredEntity<any>(row, objects.resolve);
    const ms = performance.now() - d; counts.observationDecodeMs += ms; entry.decodeMs += ms; objects.end(true);
    assert.equal(value.id, oid); assert.equal(value.sessionId, sid); return value;
  } catch (e) { return fail('observation', oid, e); }
  finally { counts.observationHostMs += performance.now() - started; progress(); }
};
const host: Pick<ExplorerHost, 'observation' | 'actions' | 'list'> = {
  observation(sid, oid) { assert.ok(oid, 'Normalization must name its retained source'); return readObservation(sid, oid, 'direct'); },
  actions(sid, oid) {
    assert.ok(oid); counts.actionCalls++; if (currentItem) itemReads.get(currentItem)!.actionCalls++;
    const key = JSON.stringify([sid, oid]); actionSources.set(key, (actionSources.get(key) ?? 0) + 1);
    // Preserve the public CoreEngine.actions ownership read; do not optimize the diagnostic.
    readObservation(sid, oid, 'actionsValidation');
    try {
      const q = performance.now(), rows: StoredEntityRow[] = actionQuery.all(sid, oid, sid); counts.actionQueryMs += performance.now() - q;
      counts.actionRows += rows.length; counts.actionStoredBytes += rows.reduce((sum, row) => sum + Buffer.byteLength(row.json) + (row.compressed_json?.byteLength ?? 0), 0);
      const d = performance.now(), values = rows.map(row => decodeStoredEntity<any>(row)).filter(value => value.observationId === oid);
      counts.actionDecodeMs += performance.now() - d; progress(); return values;
    } catch (e) { return fail('actions', oid, e); }
  },
  list<T>(sid: string, kind: string): T[] {
    assert.equal(kind, 'attempt'); const t = performance.now(); counts.listCalls++;
    try {
      assert.ok(one.get('session', sid)); const rows: StoredEntityRow[] = list.all(kind, sid); counts.listRows += rows.length;
      return rows.map(row => decodeStoredEntity<T>(row));
    } catch (e) { return fail('list', undefined, e); }
    finally { counts.listMs += performance.now() - t; progress(); }
  },
};
const before = createHash('sha256').update(JSON.stringify(task)).digest('hex');
const measuredItems = new Proxy(task.plan, { get(target, key, receiver) {
  if (key !== Symbol.iterator) return Reflect.get(target, key, receiver);
  return function* () { for (const item of target) {
    counts.itemsEntered++; currentItem = item.id;
    const row = { itemId: item.id, observationReads: 0, actionCalls: 0, sourceIds: new Set<string>(), hadAudit: !!item.operationSchedulingNormalization };
    itemReads.set(item.id, row); const t = performance.now(); progress(); yield item; counts.itemsCompleted++;
    const result = { ...row, sourceIds: [...row.sourceIds], elapsedMs: performance.now() - t, hasAudit: !!item.operationSchedulingNormalization };
    Object.assign(row, { elapsedMs: result.elapsedMs, hasAudit: result.hasAudit });
    if (row.observationReads) completedSinceProgress.push(result);
  } };
} });
began = performance.now(); progress(true);
try {
  const changes = normalizeOperationScheduling(task, host, measuredItems); // Exactly once.
  const normalizationElapsedMs = performance.now() - began;
  progress(true);
  const result = { status: 'completed', normalizationElapsedMs, ...metrics(), totalChanges: db.prepare('SELECT total_changes() AS n').get().n,
    readsBySource: [...reads].map(([source, values]) => ({ source, ...values })), changes: changes.map(c => ({ itemId: c.itemId, reason: c.reason })),
    itemsWithReads: [...itemReads.values()].filter(row => row.observationReads).map(row => ({ ...row, sourceIds: [...row.sourceIds], changed: changes.some(c => c.itemId === row.itemId) })),
    inMemoryTaskBeforeSha256: before, inMemoryTaskAfterSha256: createHash('sha256').update(JSON.stringify(task)).digest('hex'),
    databaseReadOnly: true, immutable: true, queryOnly: true, browserStarted: false, taskDatabaseOpened: false,
    scope: 'One normalizeOperationScheduling pass, including existing public actions ownership reads. No start/run/persistence or browser.' };
  assert.equal(result.totalChanges, 0);
  writeFileSync(new URL('result.json', out), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, normalizationElapsedMs, counts, distinctObservations: reads.size, changes: changes.length }));
} finally { db.close(); }
