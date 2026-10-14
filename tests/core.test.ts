import { it, expect } from 'vitest';
import { InteractionEngine, type ActionAttempt } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter } from '../examples/counter-adapter.js';

it('executes and recovers a non-web state machine using only core and memory persistence', async () => {
  const store = new MemoryStore(); const engine = new InteractionEngine({ adapter: new CounterAdapter(), persistence: store });
  try {
    const s = await engine.createSession({});
    const action = engine.actions(s.id)[0]; const once = await engine.execute(s.id, action.id, 'once');
    expect(engine.observation(s.id).count).toBe(1);
    expect((await engine.execute(s.id, action.id, 'once')).id).toBe(once.id);
    const cp = await engine.createCheckpoint(s.id, 'count one', [{ target: 'count', equals: 1 }]);
    await engine.execute(s.id, engine.actions(s.id)[0].id, 'twice');
    expect((await engine.reachCheckpoint(s.id, cp.id)).status).toBe('REACHED_VERIFIED');
    expect(engine.observation(s.id).count).toBe(1);
    expect(engine.graph(s.id).visits.length).toBeGreaterThan(engine.graph(s.id).states.length);
    expect(store.events(s.id).some(e => e.type === 'checkpoint.result')).toBe(true);
    expect(engine.list<ActionAttempt>(s.id, 'attempt').filter(a => a.purpose === 'recovery')).toHaveLength(2);
  } finally { await engine.close(); }
});

it('runs the same budgeted exploration with no browser or disk dependency', async () => {
  const engine = new InteractionEngine({ adapter: new CounterAdapter(), persistence: new MemoryStore() });
  try {
    const s = await engine.createSession({ maxActions: 3 }); await engine.explore(s.id); await engine.waitForIdle();
    expect(engine.observation(s.id).count).toBe(3); expect(engine.session(s.id).stopReason).toBe('BUDGET_EXHAUSTED');
    expect(engine.store.events(s.id).filter(e => e.type === 'action.completed')).toHaveLength(3);
  } finally { await engine.close(); }
});
