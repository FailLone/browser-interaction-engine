import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { hashBytes } from '@interaction/core';
import { FileEvidenceStore } from '../packages/storage-sqlite/src/evidence.js';

const makeDirectory = () => mkdtemp(join(tmpdir(), 'evidence-chunking-'));
const fixture = (prefix: string) => Buffer.from(JSON.stringify({ prefix, nodes: Array.from({ length: 2000 }, (_, i) => ({
  id: `document:node-${i}`, name: i < 2 ? 'Amount' : `Market ${i}`, occurrence: i < 2 ? ['A', 'B'][i] : String(i),
  price: 1000 + i * 17, attributes: { role: 'textbox', 'data-market': `market-${i}` },
  styles: { color: 'rgb(0, 0, 0)', display: 'block', position: 'relative', 'font-size': '16px' },
})) }));
const manifest = async (directory: string, key: string) => JSON.parse(await readFile(join(directory, `${key}.meta.json`), 'utf8'));

it('shares text blocks after changing-length insertion and reconstructs exact separate A/B occurrences after restart', async () => {
  const directory = await makeDirectory();
  try {
    let store = new FileEvidenceStore(directory);
    const first = fixture('price 999.9'), second = fixture('price 1000.00; inserted message');
    await store.put('first', { data: first, mediaType: 'application/json' });
    await store.put('second', { data: second, mediaType: 'application/json' });
    const a = await manifest(directory, 'first'), b = await manifest(directory, 'second');
    const old = new Set(a.blocks.map((block: { blob: string }) => block.blob));
    const sharedBytes = b.blocks.filter((block: { blob: string }) => old.has(block.blob)).reduce((sum: number, block: { bytes: number }) => sum + block.bytes, 0);
    expect(sharedBytes).toBeGreaterThan(second.length * .8);
    store = new FileEvidenceStore(directory);
    expect(Buffer.from((await store.get('first'))!.data)).toEqual(first);
    expect(Buffer.from((await store.get('second'))!.data)).toEqual(second);
    expect(JSON.parse(Buffer.from((await store.get('second'))!.data).toString()).nodes.slice(0, 2).map((node: { occurrence: string }) => node.occurrence)).toEqual(['A', 'B']);
    await store.delete('first');
    expect(Buffer.from((await store.get('second'))!.data)).toEqual(second);
    await store.delete('second'); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('reads legacy raw, v2 compressed and v3 fixed blocks alongside new captures', async () => {
  const directory = await makeDirectory(), store = new FileEvidenceStore(directory);
  try {
    const data = fixture('legacy'), sha256 = hashBytes(data), blob = `${sha256}.gz`;
    await mkdir(join(directory, 'blobs')); await writeFile(join(directory, 'blobs', blob), gzipSync(data));
    await writeFile(join(directory, 'raw'), data); await writeFile(join(directory, 'raw.meta.json'), JSON.stringify({ mediaType: 'application/json' }));
    await writeFile(join(directory, 'v2.meta.json'), JSON.stringify({ version: 2, mediaType: 'application/json', bytes: data.length, sha256, blob, encoding: 'gzip' }));
    const blocks = [];
    for (let offset = 0; offset < data.length; offset += 16384) {
      const block = data.subarray(offset, offset + 16384), hash = hashBytes(block), name = `${hash}.gz`;
      await writeFile(join(directory, 'blobs', name), gzipSync(block)); blocks.push({ blob: name, encoding: 'gzip', bytes: block.length, sha256: hash });
    }
    await writeFile(join(directory, 'v3.meta.json'), JSON.stringify({ version: 3, mediaType: 'application/json', bytes: data.length, sha256, blocks }));
    await store.put('new', { data, mediaType: 'application/json' });
    for (const key of ['raw', 'v2', 'v3', 'new']) expect(Buffer.from((await store.get(key))!.data)).toEqual(data);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(['missing', 'corrupt', 'hash', 'length', 'codec'] as const)('refuses %s referenced blocks after restart instead of reporting the capture absent', async mode => {
  const directory = await makeDirectory();
  try {
    const store = new FileEvidenceStore(directory); await store.put('capture', { data: fixture('x'), mediaType: 'application/json' });
    const value = await manifest(directory, 'capture'), path = join(directory, 'blobs', value.blocks[0].blob);
    if (mode === 'missing') await unlink(path);
    if (mode === 'corrupt') await writeFile(path, 'bad gzip');
    if (mode === 'hash') value.blocks[0].sha256 = '0'.repeat(64);
    if (mode === 'length') value.blocks[0].bytes++;
    if (mode === 'codec') value.blocks[0].encoding = 'unknown';
    await writeFile(join(directory, 'capture.meta.json'), JSON.stringify(value));
    await expect(new FileEvidenceStore(directory).get('capture')).rejects.toMatchObject({ code: 'CORRUPT_EVIDENCE' });
    expect(await store.get('absent')).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('rechecks packing-cache file existence after collection and keeps binary/empty content byte exact', async () => {
  const directory = await makeDirectory(), store = new FileEvidenceStore(directory);
  try {
    const data = fixture('cache'); await store.put('before', { data, mediaType: 'application/json' });
    await store.delete('before'); await store.put('after', { data, mediaType: 'application/json' });
    expect(Buffer.from((await store.get('after'))!.data)).toEqual(data);
    for (const data of [Buffer.alloc(0), Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 256))]) {
      await store.put('binary', { data, mediaType: 'image/png' });
      const saved = await manifest(directory, 'binary');
      expect(saved.blocks.every((block: { encoding: string; bytes: number }) => block.encoding === 'identity' && block.bytes <= 16384)).toBe(true);
      expect(Buffer.from((await store.get('binary'))!.data)).toEqual(data);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
