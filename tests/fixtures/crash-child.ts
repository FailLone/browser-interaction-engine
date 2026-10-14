import { SqliteStore } from '@interaction/storage-sqlite';
import { InteractionEngine } from '@interaction/browser';
let captures = 0;
const engine = new InteractionEngine({ persistence: new SqliteStore(process.argv[3]), hooks: {
  context: async () => {
    if (++captures === 3) {
      process.send?.({ phase: 'after-dispatch' });
      await new Promise(() => {});
    }
    return {};
  },
} });
const session = await engine.createSession({ url: process.argv[2], headless: true, settleMs: 100 });
const action = engine.actions(session.id).find(a => a.label === 'Commit')!;
process.send?.({ phase: 'ready', sessionId: session.id, actionId: action.id });
await engine.execute(session.id, action.id, 'durable-commit');
await engine.close();
