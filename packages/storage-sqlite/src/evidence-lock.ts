import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineError } from '@interaction/core';

/** Coordinate filesystem publication and collection across store instances and
 * processes. SQLite owns the OS lock, so a crashed owner needs no stale-PID or
 * lease-expiry guess. This database contains no evidence or business records.
 * Never use a synchronous busy timeout while another async operation may own
 * the lock on this same event loop. */
export async function withEvidenceLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const coordination = join(directory, '.coordination');
  await mkdir(coordination, { recursive: true });
  const lock = new Database(join(coordination, 'lock.sqlite'), { timeout: 0 });
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      try { lock.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (!(error as { code?: string }).code?.startsWith('SQLITE_BUSY')) throw error;
        if (Date.now() >= deadline) throw new EngineError('EVIDENCE_STORE_BUSY', 'Evidence publication or collection is still in progress');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try { return await operation(); }
    finally { if (lock.inTransaction) lock.exec('ROLLBACK'); }
  } finally { lock.close(); }
}
