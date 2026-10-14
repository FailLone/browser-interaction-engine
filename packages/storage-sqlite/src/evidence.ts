import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineError, type Evidence, type EvidenceStore } from '@interaction/core';
export class FileEvidenceStore implements EvidenceStore {
  constructor(readonly directory: string) {}
  private path(key: string) {
    if (!/^[a-zA-Z0-9._-]+$/.test(key) || key === '.' || key === '..') throw new EngineError('INVALID_EVIDENCE_KEY', 'Evidence keys must be flat filenames');
    return join(this.directory, key);
  }
  async put(key: string, evidence: Evidence) {
    const path = this.path(key); await mkdir(this.directory, { recursive: true });
    await writeFile(path, evidence.data);
    await writeFile(`${path}.meta.json`, JSON.stringify({ mediaType: evidence.mediaType }));
  }
  async get(key: string): Promise<Evidence | undefined> {
    const path = this.path(key);
    try {
      const data = await readFile(path);
      let mediaType = key.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      try { mediaType = JSON.parse(await readFile(`${path}.meta.json`, 'utf8')).mediaType; } catch { /* V0.1 evidence had no metadata sidecar. */ }
      return { data, mediaType };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
}
