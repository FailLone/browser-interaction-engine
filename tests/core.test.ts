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

it('keeps tentative operations out of automatic exploration and recovery without platform knowledge', async () => {
  const engine = new InteractionEngine({ adapter: new CounterAdapter(), persistence: new MemoryStore(), hooks: {
    actions: actions => actions.map(a => ({ ...a, basis: { status: 'tentative', evidence: [{ source: 'counter-signal', rule: 'unknown-purpose/v1', facts: { receiver: 'counter' } }] } })),
  } });
  try {
    const s = await engine.createSession({});
    await engine.explore(s.id); await engine.waitForIdle();
    expect(engine.session(s.id).actionCount).toBe(0);
    const attempt = await engine.execute(s.id, engine.actions(s.id)[0].id, 'probe');
    expect(attempt.action.replayable).toBe(false);
    expect(engine.observation(s.id).count).toBe(1);
    expect(engine.graph(s.id).transitions[0].replayable).toBe(false);
  } finally { await engine.close(); }
});

it('preserves observations when a hook supplies malformed operation evidence', async () => {
  const engine = new InteractionEngine({ adapter: new CounterAdapter(), persistence: new MemoryStore(), hooks: {
    actions: actions => actions.map(a => ({ ...a, basis: { status: 'supported', evidence: [] } })),
  } });
  try {
    const s = await engine.createSession({});
    expect(engine.observation(s.id).controls).toHaveLength(1);
    expect(engine.observation(s.id).gaps.some(g => g.code === 'ACTION_HOOK_FAILED')).toBe(true);
    expect(engine.actions(s.id)[0].exclusionReason).toBe('action_hook_failed');
    expect(engine.store.events(s.id).some(e => e.type === 'hook.error')).toBe(true);
  } finally { await engine.close(); }
});
