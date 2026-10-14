import { recoverStore } from '@interaction/core';
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore as Store } from '@interaction/storage-sqlite';
import { sessionSchema } from '@interaction/browser';
import type { ActionAttempt, FrontierItem, Session } from '@interaction/browser';
describe('durable execution ledger', () => {
  it('marks an interrupted intent unknown, retains deduplication and pauses the session', () => {
    const directory = mkdtempSync(join(tmpdir(), 'engine-store-')); let store = new Store(directory);
    try {
      const session: Session = { id: 's', createdAt: '', options: sessionSchema.parse({ url: 'http://localhost' }), status: 'running', actionCount: 1, elapsedMs: 0, mode: 'dfs', dirty: true };
      store.put('session', session);
      store.put('attempt', { id: 'a', sessionId: 's', requestId: 'same', status: 'executing' } as ActionAttempt);
      store.put('frontier', { id: 'f', sessionId: 's', status: 'executing' } as FrontierItem);
      store.recordRequest('s', 'same', 'a', '{}'); store.event('s', 'action.started', { attemptId: 'a' }); store.close();
      store = new Store(directory); recoverStore(store);
      expect(store.require<Session>('session', 's').status).toBe('paused'); expect(store.require<ActionAttempt>('attempt', 'a').status).toBe('unknown');
      expect(store.require<FrontierItem>('frontier', 'f').status).toBe('unknown'); expect(store.request('s', 'same')?.attemptId).toBe('a');
      expect(store.events('s', 1).map(e => e.type)).toContain('action.unknown');
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('rolls back records and events together and refuses observation overwrites', () => {
    const directory = mkdtempSync(join(tmpdir(), 'engine-store-')); const store = new Store(directory);
    try {
      expect(() => store.transaction(() => { store.put('state', { id: 'x', sessionId: 's' }); store.event('s', 'test', {}); throw new Error('crash'); })).toThrow();
      expect(store.get('state', 'x')).toBeUndefined(); expect(store.events('s')).toHaveLength(0);
      store.put('observation', { id: 'o', sessionId: 's', value: 1 } as any);
      expect(() => store.put('observation', { id: 'o', sessionId: 's', value: 2 } as any)).toThrow('Observations cannot be overwritten');
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
