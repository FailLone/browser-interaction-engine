import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Session as Inspector } from 'node:inspector';
import { BrowserEngine } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';

const out = new URL('.', import.meta.url), prep = JSON.parse(readFileSync(new URL('preparation.json', out), 'utf8'));
const store = new SqliteStore(prep.directory), engine = new BrowserEngine({ persistence: store, retention: { sweepIntervalMs: 0 } });
const sid = '412937f3-c4f5-4799-b86c-74adf480f329';
(engine as any).adapter.createDriver = () => { throw Error('Offline query forbids browser creation'); };
const metrics: Record<string, { calls: number; returned: number; threw: number; totalMs: number; selfMs: number; rows: number; maxMs: number }> = {};
const stack: { children: number }[] = [], restore: (() => void)[] = [];
function wrap(object: any, name: string, key: (...args: any[]) => string) {
  const original = object[name];
  object[name] = function(...args: any[]) {
    const stat = metrics[key(...args)] ??= { calls: 0, returned: 0, threw: 0, totalMs: 0, selfMs: 0, rows: 0, maxMs: 0 };
    const frame = { children: 0 }, began = performance.now(); stack.push(frame); stat.calls++;
    try { const value = original.apply(this, args); assert.ok(!value?.then, 'Synchronous profile only'); stat.returned++; if (Array.isArray(value)) stat.rows += value.length; return value; }
    catch(error) { stat.threw++; throw error; }
    finally { const ms = performance.now() - began; stack.pop(); if(stack.length) stack.at(-1)!.children += ms; stat.totalMs += ms; stat.selfMs += ms - frame.children; stat.maxMs = Math.max(stat.maxMs, ms); }
  };
  restore.push(() => { object[name] = original; });
}
// Wrap the composition's retained store: its methods were bound at construction.
for(const name of ['get', 'require', 'list', 'listByObservation']) wrap(engine.store, name, kind => `store.${name}:${kind}`);
for(const name of ['interventionMaterial', 'getFrontier', 'coverageMaterial', 'reconcileMaterial', 'retainedReceiptCoverageReader',
  'observation', 'actions', 'boundaryExitMaterial', 'blockingBoundaryExit', 'regionReviewMaterial', 'controlReviewMaterial',
  'explorationReviewMaterial', 'explorationDecisionReuseMaterial', 'discoveryScanMaterial']) wrap(engine, name, () => `engine.${name}`);
wrap((engine as any).adapter, 'correspondenceCase', () => 'adapter.correspondenceCase');
const inspector = new Inspector(); inspector.connect();
const post = (method: string) => new Promise<any>((resolve, reject) => inspector.post(method as any, (error, value) => error ? reject(error) : resolve(value)));
await post('Profiler.enable'); await post('Profiler.start');
const before = store.db.prepare('SELECT total_changes() AS n').get() as { n: number }, began = performance.now();
try {
  const material = engine.interventionMaterial(sid), elapsedMs = performance.now() - began;
  const after = store.db.prepare('SELECT total_changes() AS n').get() as { n: number };
  assert.equal(after.n, before.n, 'Material query must not write');
  const { profile } = await post('Profiler.stop');
  writeFileSync(new URL('cpu.cpuprofile', out), JSON.stringify(profile), { flag: 'wx' });
  const json = JSON.stringify(material);
  const result = { status: 'completed', elapsedMs, material: { observationId: material.observationId, revision: material.revision, items: material.items.length,
    ready: material.readyIds.length, bytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex') }, metrics,
    queryDatabaseChanges: after.n - before.n, browserStarted: false, taskDatabaseOpened: false,
    limitation: 'One instrumented synchronous query on a copied frozen v8 database after normal constructor restart bookkeeping; not an end-to-end recovery benchmark. Self time excludes only wrapped children, not all callees. CPU sampling adds overhead.' };
  writeFileSync(new URL('result.json', out), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
} finally { inspector.disconnect(); for(const undo of restore.reverse()) undo(); await engine.close(); }
