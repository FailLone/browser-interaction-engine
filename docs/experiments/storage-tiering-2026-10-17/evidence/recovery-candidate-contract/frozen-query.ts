// Single-use retained-facts check. Opens only its exclusive temporary DB copy;
// the frozen run and the original testing browser/task database stay untouched.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { BrowserEngine } from '@interaction/browser';
import { PlaywrightAdapter } from '@interaction/adapter-playwright';
import { SqliteStore } from '@interaction/storage-sqlite';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../../../..');
const closurePath = join(here, '../real-okx-11/closed-evidence.json');
const closure = JSON.parse(readFileSync(closurePath, 'utf8'));
const source = join(closure.source, 'engine/engine.sqlite'), output = join(here, 'frozen-query.json');
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
if (existsSync(output)) throw Error('Single-use checkpoint: do not overwrite prior evidence');
if (closure.source !== join(root, '.data/okx-storage-acceptance-20261017-v4')) throw Error('Unexpected frozen source');
if (sha(source) !== closure.sourceDatabase.sha256) throw Error('Frozen source hash changed');
for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) throw Error('Frozen source has live sidecars');
const owned = mkdtempSync(join(tmpdir(), 'bie-candidate-query-'));
const marker = 'recovery-candidate-contract/run11-closed-facts';
writeFileSync(join(owned, 'owner.txt'), marker);
const directory = join(owned, 'engine'); mkdirSync(directory);
copyFileSync(source, join(directory, 'engine.sqlite'));
const files = ['packages/core/src/engine.ts', 'packages/core/src/types.ts',
  'packages/explorer-plugin/src/runtime.ts', 'packages/explorer-plugin/src/types.ts'];
const inputs = Object.fromEntries(files.map(path => [path, sha(join(root, path))]));
let engine: BrowserEngine | undefined, store: SqliteStore | undefined, phase = 'constructor';
const writes: Record<string, number> = { constructor: 0, query: 0 }, counts: Record<string, number> = {};
let driverCalls = 0;
const createDriver = PlaywrightAdapter.prototype.createDriver;
PlaywrightAdapter.prototype.createDriver = () => { driverCalls++; throw Error('No driver in retained-facts query'); };
const record: Record<string, unknown> = {
  at: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  inputs, closureReference: '../real-okx-11/closed-evidence.json', closureSha256: sha(closurePath),
  sourceDatabaseSha256: closure.sourceDatabase.sha256, temporaryDirectory: owned,
  scope: 'One strict-checkpoint candidate query on closed run11 final facts; not a pre-dispatch counterfactual, receipt audit, performance test or arrival proof.',
};
try {
  store = new SqliteStore(directory);
  for (const method of ['put', 'event', 'recordRequest'] as const) {
    const original = store[method].bind(store) as (...args: any[]) => any;
    (store as any)[method] = (...args: any[]) => {
      writes[phase]++; if (phase === 'query') throw Error(`Query attempted write: ${method}`);
      return original(...args);
    };
  }
  engine = new BrowserEngine({ persistence: store });
  for (const method of ['get', 'require', 'list', 'listActions', 'entityChanges'] as const) {
    const original = (store as any)[method]; if (typeof original !== 'function') continue;
    (store as any)[method] = (...args: any[]) => { counts[method] = (counts[method] || 0) + 1; return original.apply(store, args); };
  }
  phase = 'query';
  const total = () => (store!.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const before = total();
  record.results = engine.checkpointRecoveryCandidates('412937f3-c4f5-4799-b86c-74adf480f329', {
    observationId: '582d5629-76ff-421b-8886-7fb426b2ff12',
    checkpointIds: ['d43e6f7d-2d7d-4b84-82df-962f68aa9455'],
  });
  record.querySqlChanges = total() - before;
  record.readCalls = counts; record.writeCalls = writes; record.driverCalls = driverCalls;
  if (record.querySqlChanges !== 0 || writes.query || driverCalls) throw Error('Read-only contract violated');
} catch (error) {
  record.error = String(error); process.exitCode = 1;
} finally {
  if (engine) await engine.close(); else store?.close();
  PlaywrightAdapter.prototype.createDriver = createDriver;
  record.inputsUnchanged = files.every(path => inputs[path] === sha(join(root, path)));
  record.sourceUnchanged = sha(source) === closure.sourceDatabase.sha256;
  record.copyDatabaseUnchanged = sha(join(directory, 'engine.sqlite')) === closure.sourceDatabase.sha256;
  if (readFileSync(join(owned, 'owner.txt'), 'utf8') !== marker) throw Error('Cleanup ownership mismatch');
  rmSync(owned, { recursive: true }); record.temporaryCopyRemoved = !existsSync(owned);
  writeFileSync(output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ output, results: record.results, error: record.error,
  sourceUnchanged: record.sourceUnchanged, temporaryCopyRemoved: record.temporaryCopyRemoved }, null, 2));
