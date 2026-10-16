import { mkdir, readFile, writeFile, rename, unlink, readdir, access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { EngineError, hashBytes, id, type Evidence, type EvidenceStore } from '@interaction/core';
import { evidenceChunks } from './evidence-chunks.js';
import { withEvidenceLock } from './evidence-lock.js';
interface Block { blob: string; encoding: 'identity' | 'gzip'; bytes: number; sha256: string }
interface Manifest extends Partial<Block> { version: 2 | 3; mediaType: string; bytes: number; sha256: string; blocks?: Block[] }
export interface EvidenceCollectionResult { scannedManifests: number; retainedBlobs: number; deletedBlobs: number; deletedBytes: number }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function names(directory: string) {
  try { return await readdir(directory); } catch (error) { if (missing(error)) return []; throw error; }
}
function parseManifest(json: string): Partial<Manifest> {
  try {
    const value = JSON.parse(json) as Partial<Manifest>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest');
    if (value.version === undefined) {
      if ('blocks' in value || 'blob' in value || 'encoding' in value) throw new Error('version');
      return value; // Legacy raw-file metadata.
    }
    if (value.version !== 2 && value.version !== 3) throw new Error('version');
    const blocks = value.version === 3 ? value.blocks : [value as Block];
    if (!Array.isArray(blocks) || typeof value.mediaType !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256 || '')
      || !Number.isSafeInteger(value.bytes) || value.bytes! < 0) throw new Error('header');
    for (const block of blocks) {
      if (!block || !['identity', 'gzip'].includes(block.encoding) || !Number.isSafeInteger(block.bytes) || block.bytes < 0
        || !/^[a-f0-9]{64}$/.test(block.sha256) || block.blob !== `${block.sha256}.${block.encoding === 'gzip' ? 'gz' : 'bin'}`) throw new Error('block');
    }
    if (blocks.reduce((sum, block) => sum + block.bytes, 0) !== value.bytes) throw new Error('length');
    return value;
  } catch { throw new EngineError('CORRUPT_EVIDENCE', 'Invalid evidence manifest'); }
}
/** Logical references share immutable blobs. Text compression is transparent to callers. */
export class FileEvidenceStore implements EvidenceStore {
  readonly durability = 'persistent' as const;
  private queue: Promise<unknown> = Promise.resolve();
  // Only packing metadata is cached, never evidence bytes or a claim that a file
  // still exists. Bounded independently of history and rechecked before reuse.
  private packing = new Map<string, Block>();
  private layouts = new Map<string, { bytes: number; blocks: Block[] }>();
  constructor(readonly directory: string) {}
  private run<T>(fn: () => Promise<T>) { const result = this.queue.then(() => withEvidenceLock(this.directory, fn)); this.queue = result.catch(() => {}); return result; }
  private path(key: string) {
    if (!/^[a-zA-Z0-9._-]+$/.test(key) || ['.', '..', 'blobs', '.coordination'].includes(key) || key.endsWith('.meta.json')) throw new EngineError('INVALID_EVIDENCE_KEY', 'Evidence keys must be flat filenames outside the storage metadata namespace');
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
        try { manifest = parseManifest(await readFile(`${path}.meta.json`, 'utf8')); } catch (error) { if (!missing(error)) throw error; }
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
    return this.deleteMany([key]);
  }
  deleteMany(keys: string[]) {
    return this.run(async () => {
      const paths = [...new Set(keys)].map(key => this.path(key));
      for (const path of paths) for (const file of [path, `${path}.meta.json`]) await unlink(file).catch(error => { if (!missing(error)) throw error; });
      await this.gcInternal();
    });
  }
  private async gcInternal(): Promise<EvidenceCollectionResult> {
    const references = new Set<string>();
    const result = { scannedManifests: 0, retainedBlobs: 0, deletedBlobs: 0, deletedBytes: 0 };
    const files = await names(this.directory);
    // Validate every manifest before deleting any blob. Incomplete metadata or
    // an unreadable directory must never look like an empty reference graph.
    for (const name of files.filter(f => f.endsWith('.meta.json'))) {
      const metadata = parseManifest(await readFile(join(this.directory, name), 'utf8')); result.scannedManifests++;
      if (metadata.version === undefined) {
        try { await access(join(this.directory, name.slice(0, -'.meta.json'.length))); }
        catch { throw new EngineError('CORRUPT_EVIDENCE', 'Legacy evidence metadata has no corresponding raw artifact'); }
      }
      if (metadata.version === 2) references.add(metadata.blob!);
      if (metadata.version === 3) for (const block of metadata.blocks!) references.add(block.blob);
    }
    result.retainedBlobs = references.size;
    for (const name of references) {
      try { await access(join(this.directory, 'blobs', name)); }
      catch { throw new EngineError('CORRUPT_EVIDENCE', 'Referenced evidence block is unavailable during collection'); }
    }
    for (const name of await names(join(this.directory, 'blobs'))) {
      if (references.has(name) || !/^[a-f0-9]{64}\.(gz|bin)(\.[a-f0-9-]+\.tmp)?$/.test(name)) continue;
      const path = join(this.directory, 'blobs', name), bytes = (await stat(path)).size;
      await unlink(path); result.deletedBlobs++; result.deletedBytes += bytes;
    }
    return result;
  }
  garbageCollect() { return this.run(() => this.gcInternal()); }
  async flush() { await this.queue; }
}
