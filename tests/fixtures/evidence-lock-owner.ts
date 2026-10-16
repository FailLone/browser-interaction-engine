import { withEvidenceLock } from '../../packages/storage-sqlite/src/evidence-lock.js';

await withEvidenceLock(process.argv[2], async () => {
  process.send?.({ locked: true });
  // Keep the IPC event loop live until this owned test process is terminated.
  await new Promise<void>(resolve => process.once('message', () => resolve()));
});
