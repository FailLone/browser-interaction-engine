/** Run the same workload against --source-root=<archive-or-worktree>.
 * Creates and removes only its own temporary captures. No browser or service. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const root = resolve(args['source-root'] || '.'), repetitions = Number(args.repetitions || 5), count = 64, keep = 8;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const files = ['packages/storage-sqlite/src/evidence.ts', 'packages/storage-sqlite/src/evidence-lock.ts', 'packages/storage-sqlite/src/evidence-chunks.ts', 'packages/core/src/util.ts'];
const sourceHashes = Object.fromEntries(files.map(file => [file, existsSync(join(root, file)) ? hash(readFileSync(join(root, file))) : null]));
const { FileEvidenceStore } = await import(pathToFileURL(join(root, 'packages/storage-sqlite/src/evidence.ts')).href) as typeof import('../packages/storage-sqlite/src/evidence.js');
const fixture = Array.from({ length: 400 }, (_, index) => ({ id: `control-${index}`, label: `Asset ${index}`, role: 'button', text: 'Price observed without semantic normalization', attributes: { 'data-token': hash(String(index)).slice(0, 24) } }));
const captures = Array.from({ length: count }, (_, index) => ({ data: Buffer.from(JSON.stringify({ price: 1200 + index, controls: fixture })), mediaType: 'application/json' }));
function disk(directory: string) {
  let bytes = 0, allocatedBytes = 0, files = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const child = disk(path); bytes += child.bytes; allocatedBytes += child.allocatedBytes; files += child.files; }
    else { const value = statSync(path); bytes += value.size; allocatedBytes += value.blocks * 512; files++; }
  }
  return { bytes, allocatedBytes, files };
}
const runs = [];
for (let repetition = 0; repetition < repetitions; repetition++) {
  const directory = mkdtempSync(join(tmpdir(), 'bie-evidence-collection-bench-'));
  try {
    const store = new FileEvidenceStore(directory), start = performance.now();
    for (let i = 0; i < count; i++) await store.put(`capture-${i}`, captures[i]);
    const putMs = performance.now() - start, before = disk(directory);
    const readStart = performance.now();
    for (let i = 0; i < count; i++) {
      const found = await store.get(`capture-${i}`);
      if (!found || !isDeepStrictEqual(Buffer.from(found.data), captures[i].data)) throw Error('Evidence roundtrip mismatch');
    }
    const readMs = performance.now() - readStart;
    const keys = Array.from({ length: count - keep }, (_, i) => `capture-${i}`), deleteStart = performance.now();
    if (typeof store.deleteMany === 'function') await store.deleteMany(keys);
    else for (const key of keys) await store.delete(key);
    const deleteMs = performance.now() - deleteStart, after = disk(directory);
    const reopened = new FileEvidenceStore(directory);
    for (let i = 0; i < count; i++) {
      const found = await reopened.get(`capture-${i}`);
      if (i < count - keep ? !!found : !found || !isDeepStrictEqual(Buffer.from(found.data), captures[i].data)) throw Error('Deletion/restart mismatch');
    }
    runs.push({ repetition, putMs, readMs, deleteMs, before, after, deletionMode: typeof store.deleteMany === 'function' ? 'batch' : 'legacy-per-capture', exactReads: count + keep });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const result = { sourceRoot: root, sourceHashes, sourceHash: hash(JSON.stringify(sourceHashes)), benchmarkHash: hash(readFileSync(fileURLToPath(import.meta.url))), node: process.version,
  repetitions, count, keep, fixtureHash: hash(Buffer.concat(captures.map(value => value.data))), runs,
  limits: 'Isolated evidence store microbenchmark, not browser exploration. Disk includes manifests, blocks and coordination files. Elapsed reads include exact-byte assertions. No claim of multi-writer business metadata safety.' };
const output = JSON.stringify(result, null, 2) + '\n';
if (args.output) writeFileSync(args.output, output); else process.stdout.write(output);
