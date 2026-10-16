/** Owned temporary storage only; no browser, server, task database or migration.
 * Run with: pnpm exec tsx --conditions=development scripts/benchmark-evidence-chunking.ts
 * The baseline is the exact pre-change writer loaded from Git, not an estimate
 * based on JSON length. Every stored capture is verified on warm reads and reads through a reopened store.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SqliteStore } from '@interaction/storage-sqlite';
import { FileEvidenceStore } from '../packages/storage-sqlite/src/evidence.js';

const baselineCommit = '075b3fc03c7b446795bf4f792c2495608d52bcdc';
const root = resolve(import.meta.dirname, '..');
const sourcePath = 'packages/storage-sqlite/src/evidence.ts';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const temporary = await mkdtemp(join(tmpdir(), 'evidence-chunking-benchmark-'));
const baselineSource = execFileSync('git', ['show', `${baselineCommit}:${sourcePath}`], { cwd: root, encoding: 'utf8' });
const baselineModule = join(temporary, 'baseline.ts');
await writeFile(baselineModule, baselineSource.replace("'@interaction/core'", JSON.stringify(pathToFileURL(join(root, 'packages/core/src/index.ts')).href)));
const Baseline = (await import(pathToFileURL(baselineModule).href)).FileEvidenceStore as typeof FileEvidenceStore;

const nodes = Array.from({ length: 2000 }, (_, i) => ({ id: `doc:node-${i}`, parentId: `doc:node-${Math.floor(i / 8)}`,
  tag: 'input', name: i < 2 ? 'Amount' : `Market ${i}`, occurrence: i < 2 ? ['A', 'B'][i] : `${i}`,
  attributes: { 'data-symbol': `asset-${hash(`asset-${i}`).slice(0, 12)}`, role: 'textbox', value: String(1000 + i * 17) },
  styles: { display: 'block', position: 'relative', color: 'rgb(0, 0, 0)', 'font-size': '16px', 'font-family': 'Arial', opacity: '1' },
  rect: { x: i % 5 * 60, y: Math.floor(i / 5) * 20, width: 40, height: 20 }, gaps: [],
}));
const frames = 12, repetitions = 3;
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
let random = 0xa341316c;
const randomBytes = (length: number) => Uint8Array.from({ length }, () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random & 255; });
const workloads = [
  { name: 'price-and-list-insertion', mediaType: 'application/json', data: Array.from({ length: frames }, (_, frame) => json({ capturedAt: `2026-10-17T00:00:${String(frame).padStart(2, '0')}Z`,
    quote: `${999 + frame * 91}.${frame}`, nodes: [...nodes.slice(0, 300), ...Array.from({ length: frame }, (_, i) => ({ id: `insert:${i}`, text: `New list item ${i}` })), ...nodes.slice(300)] })) },
  { name: 'identical-json', mediaType: 'application/json', data: Array.from({ length: frames }, () => json({ nodes })) },
  { name: 'full-price-churn', mediaType: 'application/json', data: Array.from({ length: frames }, (_, frame) => json({ nodes: nodes.map(node => ({ ...node, attributes: { ...node.attributes, value: hash(`${frame}:${node.id}`).slice(0, 10) } })) })) },
  { name: 'incompressible-text', mediaType: 'text/plain', data: Array.from({ length: frames }, () => Buffer.from(randomBytes(524288)).toString('base64')).map(value => Buffer.from(value)) },
  { name: 'binary-control', mediaType: 'image/png', data: Array.from({ length: frames }, () => randomBytes(524288)) },
];

async function disk(directory: string) {
  const result = { databaseBytes: 0, walBytes: 0, sharedMemoryBytes: 0, manifestBytes: 0, blobBytes: 0, files: 0, fileBytes: 0, allocatedBytes: 0 };
  async function visit(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name); if (entry.isDirectory()) { await visit(path); continue; }
      const value = await stat(path); result.files++; result.fileBytes += value.size; result.allocatedBytes += value.blocks * 512;
      if (entry.name === 'engine.sqlite') result.databaseBytes += value.size;
      else if (entry.name === 'engine.sqlite-wal') result.walBytes += value.size;
      else if (entry.name === 'engine.sqlite-shm') result.sharedMemoryBytes += value.size;
      else if (entry.name.endsWith('.meta.json')) result.manifestBytes += value.size;
      else result.blobBytes += value.size;
    }
  }
  await visit(directory); return result;
}
const runs = [];
try {
  for (let repetition = 0; repetition < repetitions; repetition++) for (const workload of workloads) {
    // Alternate order to reduce a systematic filesystem/cache order advantage.
    for (const mode of repetition % 2 ? ['new', 'baseline'] : ['baseline', 'new']) {
      const directory = join(temporary, `${repetition}-${workload.name}-${mode}`), Store = mode === 'baseline' ? Baseline : FileEvidenceStore;
      let sqlite = new SqliteStore(directory), evidence = new Store(join(directory, 'evidence'));
      const cpuStart = process.cpuUsage(), start = performance.now();
      for (let frame = 0; frame < workload.data.length; frame++) {
        await evidence.put(`capture-${frame}`, { data: workload.data[frame], mediaType: workload.mediaType });
        // The same DB observations are intentionally retained for both codecs.
        sqlite.put('observation', { id: `o-${frame}`, sessionId: 'benchmark', capturedAt: `frame-${frame}`, controls: nodes.slice(0, 32), evidence: `capture-${frame}` });
      }
      const writeMs = performance.now() - start, cpu = process.cpuUsage(cpuStart), activeDisk = await disk(directory);
      async function verify() {
        const start = performance.now();
        for (let frame = 0; frame < workload.data.length; frame++) {
          const found = await evidence.get(`capture-${frame}`);
          if (!found || found.mediaType !== workload.mediaType || !Buffer.from(found.data).equals(Buffer.from(workload.data[frame]))) throw Error(`Exact reconstruction failed: ${mode} ${workload.name} ${frame}`);
          const observation = sqlite.require<{ controls: typeof nodes }>('observation', `o-${frame}`);
          if (observation.controls[0].occurrence !== 'A' || observation.controls[1].occurrence !== 'B') throw Error('Distinct occurrence lost');
        }
        return performance.now() - start;
      }
      const warmReadMs = await verify(); sqlite.close();
      const closedDisk = await disk(directory);
      sqlite = new SqliteStore(directory); evidence = new Store(join(directory, 'evidence'));
      const restartReadMs = await verify(); sqlite.close();
      runs.push({ repetition, mode, workload: workload.name, frames, writeMs, writeCpuMs: (cpu.user + cpu.system) / 1000, warmReadMs, restartReadMs, activeDisk, closedDisk, verifiedCaptures: frames * 2 });
      await rm(directory, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ protocol: 'evidence-chunking-v1', baselineCommit, baselineSourceSha256: hash(baselineSource),
    currentSourceSha256: hash(await readFile(join(root, sourcePath))), chunkerSourceSha256: hash(await readFile(join(root, 'packages/storage-sqlite/src/evidence-chunks.ts'))),
    node: process.version, repetitions, workloads: workloads.map(({ name, data, mediaType }) => ({ name, mediaType, captures: data.length, inputBytes: data.reduce((n, value) => n + value.length, 0), inputSha256: hash(Buffer.concat(data)) })),
    measurement: 'Temporary real SQLite DB, WAL, shared-memory, evidence manifests and blobs. File sizes and allocated blocks separately reported; no production DB, browser or service. No observation compression change. Synthetic DOM-shaped data, not a live-site performance claim.', runs }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
