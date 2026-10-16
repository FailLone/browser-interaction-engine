import { afterEach, expect, it } from 'vitest';
import { canonical, InteractionEngine, type ActionAttempt } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter, type CounterDriver, type CounterObservation } from '../examples/counter-adapter.js';

class GroupedCounterAdapter extends CounterAdapter {
  driver?: CounterDriver;
  constructor(private readonly group: (count: number) => string) { super(); }
  override createDriver() { this.driver = super.createDriver(); return this.driver; }
  stateGrouping(observation: CounterObservation) {
    return { policy: 'counter-graph-group/v1', canonical: canonical({ group: this.group(observation.count) }),
      evidence: ['Test-only graph abstraction; every exact counter value remains an observation'] };
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(group: (count: number) => string) {
  const adapter = new GroupedCounterAdapter(group), store = new MemoryStore();
  const engine = new InteractionEngine({ adapter, persistence: store });
  cleanup.push(() => engine.close());
  const session = await engine.createSession({ exploration: 'controls' });
  const observations = [engine.observation(session.id)], attempts: ActionAttempt[] = [];
  return { engine, adapter, store, sid: session.id, observations, attempts,
    async increment() {
      const attempt = await engine.execute(session.id, engine.actions(session.id)[0].id, crypto.randomUUID());
      expect(attempt.status).toBe('succeeded');
      attempts.push(attempt); observations.push(engine.observation(session.id));
      return attempt;
    },
  };
}

const ends = (from: CounterObservation, to: CounterObservation) => ({ fromObservationId: from.id, toObservationId: to.id });
const foldedMiddle = (count: number) => count === 1 || count === 2 ? 'middle' : `count:${count}`;

it('requires exact observation endpoints for a multi-member group and never invents an empty reverse path', async () => {
  const f = await fixture(() => 'same-group');
  await f.increment();
  const [zero, one] = f.observations;
  expect(zero.stateId).toBe(one.stateId);
  expect(zero.canonical).not.toBe(one.canonical);
  expect(f.engine.navigationPath(f.sid, zero.stateId, one.stateId)).toBeNull();
  expect(f.engine.navigationPath(f.sid, one.stateId, zero.stateId, ends(one, zero))).toBeNull();
  expect(f.engine.navigationPath(f.sid, zero.stateId, one.stateId, ends(zero, one))).toEqual([f.attempts[0].id]);
  expect(f.engine.navigationPath(f.sid, one.stateId, one.stateId, ends(one, one))).toEqual([]);
});

it('does not splice disconnected exact endpoints through a shared intermediate graph group', async () => {
  const f = await fixture(foldedMiddle);
  await f.increment(); await f.increment(); await f.increment();
  const [zero, one, two, three] = f.observations, [first, bridge, last] = f.attempts;
  expect(one.stateId).toBe(two.stateId);
  expect(one.canonical).not.toBe(two.canonical);
  // The middle transition genuinely occurred, but is no longer authorized for
  // replay. Its two neighboring edges cannot fill that missing exact step.
  f.store.put('attempt', { ...bridge, action: { ...bridge.action, replayable: false } });
  expect(f.engine.navigationPath(f.sid, zero.stateId, three.stateId, ends(zero, three))).toBeNull();
  expect(f.engine.navigationPath(f.sid, zero.stateId, three.stateId)).toBeNull();
  expect(f.engine.navigationPath(f.sid, zero.stateId, one.stateId, ends(zero, one))).toEqual([first.id]);
  expect(f.engine.navigationPath(f.sid, two.stateId, three.stateId, ends(two, three))).toEqual([last.id]);
  expect(f.engine.navigationPath(f.sid, one.stateId, two.stateId, ends(one, two))).toBeNull();
});

it('finds and actually replays all exact steps, including a transition within one graph group', async () => {
  const f = await fixture(foldedMiddle);
  await f.increment(); await f.increment(); await f.increment();
  const [zero, one, two, three] = f.observations;
  const checkpoint = await f.engine.createCheckpoint(f.sid, 'Counter exactly three', [{ target: 'count', equals: 3 }]);
  expect(one.stateId).toBe(two.stateId);
  expect(f.engine.navigationPath(f.sid, zero.stateId, three.stateId, ends(zero, three))).toEqual(f.attempts.map(a => a.id));
  expect(f.engine.navigationPath(f.sid, one.stateId, two.stateId, ends(one, two))).toEqual([f.attempts[1].id]);
  // Reset the isolated in-memory driver to the original count. Recovery must
  // exercise three operations, even though the graph has only two edge hops.
  await f.adapter.driver!.reopen();
  const restarted = await f.engine.observe(f.sid);
  expect(restarted.count).toBe(0);
  const reached = await f.engine.reachCheckpoint(f.sid, checkpoint.id);
  expect(reached).toMatchObject({ status: 'REACHED_VERIFIED' });
  expect(reached.attemptIds).toHaveLength(3);
  expect(f.engine.observation(f.sid).count).toBe(3);
  const recovery = reached.attemptIds.map(id => f.store.require<ActionAttempt>('attempt', id));
  expect(recovery.every(a => a.purpose === 'recovery' && a.status === 'succeeded')).toBe(true);
  expect(recovery.map(a => [f.engine.observation(f.sid, a.beforeId).count, f.engine.observation(f.sid, a.afterId!).count]))
    .toEqual([[0, 1], [1, 2], [2, 3]]);
});

it.each(['unknown', 'failed', 'missing-after', 'nonreplayable-edge'] as const)(
  'refuses a recorded route whose intermediate evidence is %s', async fault => {
    const f = await fixture(foldedMiddle);
    await f.increment(); await f.increment(); await f.increment();
    const [zero, , , three] = f.observations, bridge = f.attempts[1];
    if (fault === 'unknown' || fault === 'failed') f.store.put('attempt', { ...bridge, status: fault });
    if (fault === 'missing-after') f.store.put('attempt', { ...bridge, afterId: undefined });
    if (fault === 'nonreplayable-edge') {
      const transition = f.engine.getGraph(f.sid).transitions.find(t => t.attemptId === bridge.id)!;
      f.store.put('transition', { ...transition, replayable: false });
    }
    expect(f.engine.navigationPath(f.sid, zero.stateId, three.stateId, ends(zero, three))).toBeNull();
  },
);

it('rejects an observation endpoint that does not belong to the requested graph node', async () => {
  const f = await fixture(foldedMiddle);
  await f.increment();
  const [zero, one] = f.observations;
  expect(zero.stateId).not.toBe(one.stateId);
  expect(f.engine.navigationPath(f.sid, zero.stateId, one.stateId, ends(one, one))).toBeNull();
  expect(f.engine.navigationPath(f.sid, zero.stateId, one.stateId, ends(zero, zero))).toBeNull();
});

it('preserves an old representative sample as an explicit policy gap when upgrading its key and graph grouping once', async () => {
  class UpgradingAdapter extends CounterAdapter {
    upgraded = false;
    stateGrouping() {
      return this.upgraded ? { policy: 'counter-group/v1', canonical: 'counter-group', evidence: ['Graph index only'] } : undefined;
    }
    explorationCase() {
      return { key: this.upgraded ? 'source-conditions-v2' : 'source-conditions-v1',
        policy: 'counter-representative', evidence: ['Versioned observed source conditions'] };
    }
  }
  const adapter = new UpgradingAdapter(), store = new MemoryStore();
  const engine = new InteractionEngine({ adapter, persistence: store, hooks: {
    // Dispatch the actual memory driver without changing its observable count,
    // so this test isolates the policy upgrade from newly encountered UI facts.
    actions: actions => actions.map(a => ({ ...a, value: { by: 0 } })),
  } });
  cleanup.push(() => engine.close());
  const session = await engine.createSession({ exploration: 'representative', maxActions: 3 });
  const original = engine.observation(session.id), oldState = engine.getGraph(session.id).states[0], oldCase = engine.getFrontier(session.id)[0];
  expect(oldState.grouping).toBeUndefined();
  expect(oldCase.attempts).toEqual([]);
  adapter.upgraded = true;
  const current = await engine.observe(session.id);
  expect(current.canonical).toBe(original.canonical);
  expect(current.stateId).not.toBe(original.stateId);
  expect(engine.getGraph(session.id).states.find(s => s.id === current.stateId)?.grouping).toBeDefined();
  await engine.explore(session.id); await engine.waitForIdle();
  expect(store.require('state', oldState.id)).toEqual(oldState);
  expect(engine.observation(session.id, original.id)).toEqual(original);
  const old = engine.getFrontier(session.id).find(f => f.id === oldCase.id)!;
  expect(old).toMatchObject({ status: 'blocked', reason: 'sampling_policy_changed', attempts: [],
    action: { id: oldCase.action.id, observationId: original.id },
    coverage: { executionStatus: 'not_attempted' } });
  expect(old.coverage.equivalentTo).toBeUndefined();
  expect(old.unblock).toBeTruthy();
  const fresh = engine.getFrontier(session.id).filter(f => f.id !== old.id);
  expect(fresh).toHaveLength(1);
  expect(fresh[0].status).toBe('executed');
  expect(fresh[0].attempts).toHaveLength(1);
  expect(engine.list<ActionAttempt>(session.id, 'attempt')).toHaveLength(1);
  expect(engine.session(session.id).actionCount).toBe(1);
  expect(engine.report(session.id).explorationAudit).toMatchObject({ status: 'blocked', counts: { blocked: 1, succeeded: 1 } });
});
