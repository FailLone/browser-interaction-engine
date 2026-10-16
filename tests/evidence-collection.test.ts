import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { FileEvidenceStore } from '../packages/storage-sqlite/src/evidence.js';

const publication = vi.hoisted(() => ({ target: '', entered: undefined as (() => void) | undefined, gate: undefined as Promise<void> | undefined, manifestReads: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: ((...args: Parameters<typeof original.readFile>) => {
    if (String(args[0]).endsWith('.meta.json')) publication.manifestReads++;
    return original.readFile(...args);
  }) as typeof original.readFile, rename: async (...args: Parameters<typeof original.rename>) => {
    if (String(args[1]) === publication.target) { publication.entered?.(); await publication.gate; }
    return original.rename(...args);
  } };
});
const directories: string[] = [];
afterEach(async () => {
  publication.target = ''; publication.entered = undefined; publication.gate = undefined; publication.manifestReads = 0;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'evidence-collection-')); directories.push(directory);
  return { directory, store: new FileEvidenceStore(directory) };
}
const artifact = (text: string) => ({ data: Buffer.from(text.repeat(4000)), mediaType: 'text/plain' });

it('does not collect a second store’s blocks between publication of blobs and its manifest', async () => {
  const { directory, store } = await setup(), other = new FileEvidenceStore(directory);
  await store.put('old', artifact('old'));
  let release!: () => void;
  publication.target = join(directory, 'new.meta.json');
  publication.gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { publication.entered = resolve; });
  const put = store.put('new', artifact('new'));
  await entered;
  let collected = false;
  const collection = other.delete('old').then(() => { collected = true; });
  let blocked = false;
  let completed: PromiseSettledResult<unknown>[] = [];
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    blocked = !collected;
  } finally { release(); completed = await Promise.allSettled([put, collection]); }
  expect(completed.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(Buffer.from((await other.get('new'))!.data)).toEqual(artifact('new').data);
  expect(blocked).toBe(true);
  expect(await other.get('old')).toBeUndefined();
});

it('releases the OS lock after a separate owner process crashes', async () => {
  const { directory, store } = await setup();
  const child = fork(new URL('./fixtures/evidence-lock-owner.ts', import.meta.url), [directory], {
    execArgv: ['--import', 'tsx', '--conditions=development'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr?.on('data', chunk => { errors += String(chunk); });
  try {
    const [message] = await Promise.race([
      once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`Lock owner exited before acquiring lock: ${errors}`); }),
    ]);
    expect(message).toEqual({ locked: true });
    let written = false;
    const put = store.put('after-crash', artifact('retained')).then(() => { written = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(written).toBe(false);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await put;
    expect(Buffer.from((await store.get('after-crash'))!.data)).toEqual(artifact('retained').data);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } }
});

it('deletes multiple logical captures in one reference scan and retains shared live blocks', async () => {
  const { directory, store } = await setup();
  for (const key of ['a', 'b', 'keep']) await store.put(key, artifact('shared'));
  await store.deleteMany(['a', 'b', 'a']);
  expect(await store.get('a')).toBeUndefined(); expect(await store.get('b')).toBeUndefined();
  expect(Buffer.from((await store.get('keep'))!.data)).toEqual(artifact('shared').data);
  expect((await store.garbageCollect()).scannedManifests).toBe(1);
  await store.deleteMany(['keep']); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
});

it('reads each retained manifest once for a batch of deletions', async () => {
  const { store } = await setup();
  const keys = Array.from({ length: 10 }, (_, i) => `capture-${i}`);
  for (const key of keys) await store.put(key, artifact('shared'));
  publication.manifestReads = 0;
  await store.deleteMany(keys.slice(0, 8));
  expect(publication.manifestReads).toBe(2);
  for (const key of keys.slice(8)) expect(Buffer.from((await store.get(key))!.data)).toEqual(artifact('shared').data);
});

it.each(['json', 'version', 'layout', 'missing-block'] as const)('does not delete any orphan on a %s reference-graph failure', async mode => {
  const { directory, store } = await setup();
  await store.put('keep', artifact('required')); await store.put('orphan', artifact('orphan'));
  const metadata = join(directory, 'keep.meta.json'), original = await readFile(metadata, 'utf8');
  // Make one actual unreferenced immutable blob, without using collector code.
  await rm(join(directory, 'orphan.meta.json'));
  const value = JSON.parse(original);
  if (mode === 'json') await writeFile(metadata, '{');
  if (mode === 'version') { delete value.version; await writeFile(metadata, JSON.stringify(value)); }
  if (mode === 'layout') { value.blocks = null; await writeFile(metadata, JSON.stringify(value)); }
  if (mode === 'missing-block') await rm(join(directory, 'blobs', value.blocks[0].blob));
  const before = (await readdir(join(directory, 'blobs'))).sort();
  await expect(store.garbageCollect()).rejects.toMatchObject({ code: 'CORRUPT_EVIDENCE' });
  expect((await readdir(join(directory, 'blobs'))).sort()).toEqual(before);
});

it('rejects metadata filename collisions before deleting any requested capture', async () => {
  const { store } = await setup(); await store.put('keep', artifact('retained'));
  await expect(store.deleteMany(['keep', 'keep.meta.json'])).rejects.toMatchObject({ code: 'INVALID_EVIDENCE_KEY' });
  expect(Buffer.from((await store.get('keep'))!.data)).toEqual(artifact('retained').data);
});
