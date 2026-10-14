import { expect, it } from 'vitest';
import { InteractionEngine, type FrontierItem } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter } from '../examples/counter-adapter.js';

class MeasuredStore extends MemoryStore {
  frontierScans = 0;
  observationReads = 0;
  override list<T>(kind: string, sessionId?: string): T[] {
    if (kind === 'frontier') this.frontierScans++;
    return super.list<T>(kind, sessionId);
  }
  override get<T>(kind: string, id: string): T | undefined {
    if (kind === 'observation') this.observationReads++;
    return super.get<T>(kind, id);
  }
  resetMeasurements() { this.frontierScans = 0; this.observationReads = 0; }
}

function setup() {
  const store = new MeasuredStore();
  const engine = new InteractionEngine({ adapter: new CounterAdapter(), persistence: store, hooks: {
    actions: actions => {
      const sampled = Array.from({ length: 200 }, (_, i) => ({ ...actions[0], value: { by: i + 1 } }));
      // A later judgment of the same operation must update its single frontier
      // record even while a capture is inserting hundreds of other samples.
      return [...sampled, { ...sampled[0], excluded: true, exclusionReason: 'fixture_review' }];
    },
  } });
  return { engine, store };
}

it('refreshes a large candidate batch without one complete frontier scan per candidate', async () => {
  const { engine, store } = setup();
  try {
    const s = await engine.createSession({});
    const before = engine.list<FrontierItem>(s.id, 'frontier');
    store.resetMeasurements(); await engine.observe(s.id);
    expect(store.frontierScans).toBeLessThan(10);
    const after = engine.list<FrontierItem>(s.id, 'frontier');
    expect(after).toHaveLength(200);
    expect(after.map(f => f.id)).toEqual(before.map(f => f.id));
    expect(after.find(f => (f.action.value as { by: number }).by === 1)).toMatchObject({ status: 'blocked', reason: 'fixture_review' });
    expect(after.filter(f => f.status === 'pending')).toHaveLength(199);
    expect(after.every(f => f.action.observationId === engine.observation(s.id).id)).toBe(true);
  } finally { await engine.close(); }
});

it('updates one executed sample without rereading its observation for every other frontier item', async () => {
  const { engine, store } = setup();
  try {
    const s = await engine.createSession({});
    const action = engine.actions(s.id).find(a => (a.value as { by: number }).by === 100)!;
    store.resetMeasurements(); const attempt = await engine.execute(s.id, action.id, 'sample-100');
    expect(store.observationReads).toBeLessThan(30);
    expect(store.frontierScans).toBeLessThan(10);
    expect(attempt.status).toBe('succeeded'); expect(engine.observation(s.id).count).toBe(100);
    const frontier = engine.list<FrontierItem>(s.id, 'frontier');
    expect(frontier).toHaveLength(400);
    expect(frontier.filter(f => f.status === 'executed')).toMatchObject([{ attempts: [attempt.id], action: { id: action.id } }]);
    expect((await engine.execute(s.id, action.id, 'sample-100')).id).toBe(attempt.id);
    expect(engine.observation(s.id).count).toBe(100);
  } finally { await engine.close(); }
});
