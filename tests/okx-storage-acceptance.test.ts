import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { SqliteStore } from '@interaction/storage-sqlite';
import { RetainedPersistence } from '@interaction/storage-retained';
import { ExplorerPlugin, ExplorerStore, type ExplorerHost, type TaskStatus } from '@interaction/explorer-plugin';
import { auditProtectedArtifact, settleOwnedTask } from '../scripts/okx-storage-acceptance.js';

it('audits retained bytes and media type without starting providers or a browser', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'okx-audit-offline-'));
  const raw = new SqliteStore(directory), retained = new RetainedPersistence(raw, { sweepIntervalMs: 0 });
  try {
    await retained.evidence.beginObservation({ sessionId: 's', observationId: 'o', policy: { mode: 'persistent', ttlMs: 0, maxBytes: 1024, maxObservations: 10 } });
    const artifact = { data: new TextEncoder().encode('retained evidence'), mediaType: 'text/plain' };
    await retained.evidence.put('artifact', artifact);
    await expect(auditProtectedArtifact(raw, 'artifact')).resolves.toBeUndefined();
    await raw.evidence.put('artifact', { ...artifact, mediaType: 'application/octet-stream' });
    await expect(auditProtectedArtifact(raw, 'artifact')).rejects.toMatchObject({ code: 'PROTECTED_EVIDENCE_UNAVAILABLE' });
    await raw.evidence.delete!('artifact');
    await expect(auditProtectedArtifact(raw, 'artifact')).rejects.toMatchObject({ code: 'PROTECTED_EVIDENCE_UNAVAILABLE' });
  } finally { await retained.evidence.flush(); retained.close(); rmSync(directory, { recursive: true, force: true }); }
});

it.each(['completed', 'blocked', 'budget_exhausted', 'paused'] satisfies TaskStatus[])('preserves an inactive %s task and its original reason', async status => {
  const store = new ExplorerStore(':memory:');
  // No engine/provider is constructed; these methods are the only idle-settle dependencies.
  const host = { events: new EventEmitter(), async waitForIdle() {} };
  const plugin = new ExplorerPlugin(host as unknown as ExplorerHost, store);
  try {
    const task = plugin.create({ url: 'https://www.okx.com/convert/usd-to-btc', goal: '', coverageMode: 'all' });
    store.save({ ...task, status, reason: 'original_cause', pendingDispatch: { sessionId: 's', requestId: 'unknown', itemIds: [], observationId: 'o', actionId: 'a' } });
    const before = store.task(task.id);
    await settleOwnedTask(plugin, host, task.id);
    expect(store.task(task.id)).toEqual(before);
  } finally { await plugin.close(); }
});
