import { mkdir, readFile, writeFile, rename, unlink, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { EngineError, hashBytes, id, type Evidence, type EvidenceStore } from '@interaction/core';
interface Block { blob: string; encoding: 'identity' | 'gzip'; bytes: number; sha256: string }
interface Manifest extends Partial<Block> { version: 2 | 3; mediaType: string; bytes: number; sha256: string; blocks?: Block[] }
/** Logical references share immutable blobs. Text compression is transparent to callers. */
export class FileEvidenceStore implements EvidenceStore {
  readonly durability = 'persistent' as const;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private run<T>(fn: () => Promise<T>) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  private path(key: string) {
    if (!/^[a-zA-Z0-9._-]+$/.test(key) || key === '.' || key === '..') throw new EngineError('INVALID_EVIDENCE_KEY', 'Evidence keys must be flat filenames');
    return join(this.directory, key);
  }
  put(key: string, evidence: Evidence) {
    const data = new Uint8Array(evidence.data); const mediaType = evidence.mediaType;
    return this.run(async () => {
      const path = this.path(key); await mkdir(join(this.directory, 'blobs'), { recursive: true });
      const blocks: Block[] = [];
      // Fixed independent blocks avoid replay chains and reuse unchanged ranges.
      for (let offset = 0; offset < data.length || offset === 0; offset += 16384) {
        const block = data.slice(offset, offset + 16384); const sha256 = hashBytes(block);
        const packed = /json|text|xml|javascript|yaml/.test(mediaType) ? gzipSync(block) : block;
        const encoding = packed.length < block.length ? 'gzip' : 'identity'; const bytes = encoding === 'gzip' ? packed : block;
        const blob = `${sha256}.${encoding === 'gzip' ? 'gz' : 'bin'}`;
        const blobPath = join(this.directory, 'blobs', blob);
        try { await access(blobPath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // Never publish a partially written content-addressed block after a crash.
          const temporary = `${blobPath}.${id()}.tmp`;
          await writeFile(temporary, bytes); await rename(temporary, blobPath);
        }
        blocks.push({ blob, encoding, bytes: block.length, sha256 });
      }
      const manifest: Manifest = { version: 3, mediaType, blocks, bytes: data.length, sha256: hashBytes(data) };
      const temporary = `${path}.${id()}.tmp`; await writeFile(temporary, JSON.stringify(manifest)); await rename(temporary, `${path}.meta.json`);
      await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    });
  }
  get(key: string): Promise<Evidence | undefined> {
    return this.run(async () => {
      const path = this.path(key);
      try {
        let manifest: Partial<Manifest> | undefined;
        try { manifest = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (manifest?.version === 2 || manifest?.version === 3) {
          const chunks = manifest.version === 3 ? manifest.blocks! : [manifest as Block];
          if (!Array.isArray(chunks) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes! < 0 || chunks.reduce((n, b) => n + b.bytes, 0) !== manifest.bytes) throw new EngineError('CORRUPT_EVIDENCE', 'Invalid evidence manifest');
          const data = new Uint8Array(manifest.bytes!); let offset = 0;
          for (const chunk of chunks) {
            if (!/^[a-f0-9]{64}\.(gz|bin)$/.test(chunk.blob || '') || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0) throw new EngineError('CORRUPT_EVIDENCE', 'Invalid evidence blob reference');
            const stored = await readFile(join(this.directory, 'blobs', chunk.blob));
            const unpacked = chunk.encoding === 'gzip' ? gunzipSync(stored, { maxOutputLength: Math.max(1, chunk.bytes) }) : stored;
            if (unpacked.length !== chunk.bytes || hashBytes(unpacked) !== chunk.sha256) throw new EngineError('CORRUPT_EVIDENCE', 'Evidence block failed integrity validation');
            data.set(unpacked, offset); offset += unpacked.length;
          }
          if (hashBytes(data) !== manifest.sha256) throw new EngineError('CORRUPT_EVIDENCE', 'Evidence failed integrity validation');
          return { data, mediaType: manifest.mediaType! };
        }
        return { data: await readFile(path), mediaType: manifest?.mediaType || (key.endsWith('.png') ? 'image/png' : 'application/octet-stream') };
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    });
  }
  delete(key: string) {
    return this.run(async () => {
      const path = this.path(key);
      for (const file of [path, `${path}.meta.json`]) await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      await this.gcInternal();
    });
  }
  private async gcInternal() {
    const references = new Set<string>();
    const files = await readdir(this.directory).catch(() => [] as string[]);
    for (const name of files.filter(f => f.endsWith('.meta.json'))) {
      const metadata = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
      if (metadata.version === 2) references.add(metadata.blob);
      if (metadata.version === 3) for (const block of metadata.blocks) references.add(block.blob);
    }
    for (const name of await readdir(join(this.directory, 'blobs')).catch(() => [] as string[])) if (!references.has(name)) await unlink(join(this.directory, 'blobs', name));
  }
  garbageCollect() { return this.run(() => this.gcInternal()); }
  async flush() { await this.queue; }
}
