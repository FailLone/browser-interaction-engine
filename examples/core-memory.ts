import { InteractionEngine } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter } from './counter-adapter.js';

const engine = new InteractionEngine({ adapter: new CounterAdapter(), persistence: new MemoryStore() });
try {
  const session = await engine.createSession({ maxActions: 3 });
  await engine.explore(session.id); await engine.waitForIdle();
  console.log({ count: engine.observation(session.id).count, report: engine.report(session.id) });
} finally { await engine.close(); }
