import { mkdir, readFile, writeFile, rename, unlink, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { EngineError, hashBytes, id, type Evidence, type EvidenceStore } from '@interaction/core';
import { evidenceChunks } from './evidence-chunks.js';
interface Block { blob: string; encoding: 'identity' | 'gzip'; bytes: number; sha256: string }
interface Manifest extends Partial<Block> { version: 2 | 3; mediaType: string; bytes: number; sha256: string; blocks?: Block[] }
/** Logical references share immutable blobs. Text compression is transparent to callers. */
export class FileEvidenceStore implements EvidenceStore {
  readonly durability = 'persistent' as const;
  private queue: Promise<unknown> = Promise.resolve();
  // Only packing metadata is cached, never evidence bytes or a claim that a file
  // still exists. Bounded independently of history and rechecked before reuse.
  private packing = new Map<string, Block>();
  private layouts = new Map<string, { bytes: number; blocks: Block[] }>();
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
      const text = /json|text|xml|javascript|yaml/.test(mediaType);
      const sha256 = hashBytes(data), layoutKey = `${text ? 'text' : 'binary'}:${sha256}`;
      const layout = this.layouts.get(layoutKey);
      let reuseLayout = !!layout && layout.bytes === data.length;
      if (reuseLayout) {
        for (const block of layout!.blocks) {
          try { await access(join(this.directory, 'blobs', block.blob)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; reuseLayout = false; break; }
        }
      }
      if (reuseLayout) blocks.push(...layout!.blocks);
      else {
        // High-entropy text (for example encoded random assets) gets little sharing
        // benefit. A bounded sample avoids scanning it with the rolling hash. This
        // selects an encoding only; every source byte is retained and verified.
        const sample = data.subarray(0, 4096);
        const contentDefined = text && data.length >= 32768 && gzipSync(sample).length < sample.length * .72;
        // Text insertions no longer shift every following block boundary. The v3
        // manifest already supports arbitrary independent ranges, so old readers
        // can reconstruct new captures and no historical migration is necessary.
        for (const block of evidenceChunks(data, contentDefined)) {
          const sha256 = hashBytes(block), cacheKey = `${text ? 'text' : 'binary'}:${sha256}`;
          const cached = this.packing.get(cacheKey);
          if (cached && cached.bytes === block.length && cached.sha256 === sha256) {
            try {
              await access(join(this.directory, 'blobs', cached.blob));
              this.packing.delete(cacheKey); this.packing.set(cacheKey, cached);
              blocks.push(cached); continue;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          const packed = text ? gzipSync(block) : block;
          const encoding = packed.length < block.length ? 'gzip' : 'identity'; const bytes = encoding === 'gzip' ? packed : block;
          const blob = `${sha256}.${encoding === 'gzip' ? 'gz' : 'bin'}`;
          const blobPath = join(this.directory, 'blobs', blob);
          try { await access(blobPath); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            // Never publish a partially written content-addressed block after a crash.
            const temporary = `${blobPath}.${id()}.tmp`;
            await writeFile(temporary, bytes); await rename(temporary, blobPath);
          }
          const descriptor: Block = { blob, encoding, bytes: block.length, sha256 };
          this.packing.delete(cacheKey); this.packing.set(cacheKey, descriptor);
          if (this.packing.size > 2048) this.packing.delete(this.packing.keys().next().value!);
          blocks.push(descriptor);
        }
      }
      // At most 16 layouts of 128 descriptors each; a large capture cannot make
      // this cache grow with the retained history. No uncompressed data is held.
      if (blocks.length <= 128) {
        this.layouts.delete(layoutKey); this.layouts.set(layoutKey, { bytes: data.length, blocks });
        if (this.layouts.size > 16) this.layouts.delete(this.layouts.keys().next().value!);
      }
      const manifest: Manifest = { version: 3, mediaType, blocks, bytes: data.length, sha256 };
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
          try {
            const chunks = manifest.version === 3 ? manifest.blocks! : [manifest as Block];
            if (!Array.isArray(chunks) || typeof manifest.mediaType !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') || !Number.isSafeInteger(manifest.bytes) || manifest.bytes! < 0 || chunks.reduce((n, b) => n + b.bytes, 0) !== manifest.bytes) throw new EngineError('CORRUPT_EVIDENCE', 'Invalid evidence manifest');
            const data = new Uint8Array(manifest.bytes!); let offset = 0;
            for (const chunk of chunks) {
              if (!/^[a-f0-9]{64}\.(gz|bin)$/.test(chunk.blob || '') || !/^[a-f0-9]{64}$/.test(chunk.sha256 || '') || !['identity', 'gzip'].includes(chunk.encoding) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0) throw new EngineError('CORRUPT_EVIDENCE', 'Invalid evidence blob reference');
              const stored = await readFile(join(this.directory, 'blobs', chunk.blob));
              const unpacked = chunk.encoding === 'gzip' ? gunzipSync(stored, { maxOutputLength: Math.max(1, chunk.bytes) }) : stored;
              if (unpacked.length !== chunk.bytes || hashBytes(unpacked) !== chunk.sha256) throw new EngineError('CORRUPT_EVIDENCE', 'Evidence block failed integrity validation');
              data.set(unpacked, offset); offset += unpacked.length;
            }
            if (hashBytes(data) !== manifest.sha256) throw new EngineError('CORRUPT_EVIDENCE', 'Evidence failed integrity validation');
            return { data, mediaType: manifest.mediaType! };
          } catch (error) {
            if (error instanceof EngineError && error.code === 'CORRUPT_EVIDENCE') throw error;
            // A missing referenced blob is corruption, not a missing logical
            // capture. Never silently downgrade a retained manifest to absent.
            throw new EngineError('CORRUPT_EVIDENCE', 'Evidence block is missing or cannot be decoded');
          }
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
