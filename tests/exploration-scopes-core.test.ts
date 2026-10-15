import { expect, it } from 'vitest';
import { InteractionEngine, type EngineHooks, type ExplorationGroup, type ExplorationGroupProposal } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter, type CounterObservation } from '../examples/counter-adapter.js';

const evidence = [{ source: 'test-plan', rule: 'declared-goal/v1', facts: { goal: 'counter' } }];
const decision = { source: 'test-orchestrator', evidence: ['Explicit test objective'] };
const proposal = (ids: string[], key = 'counter', conditions: ExplorationGroupProposal['conditions'] = { goal: 'counter-v1' }): ExplorationGroupProposal => ({
  key, kind: 'business-branch', label: key, conditions, actionIds: ids, traversalActionIds: [], evidence,
});
const engineFor = (hooks: EngineHooks<CounterObservation> = {}) => new InteractionEngine({ adapter: new CounterAdapter(), persistence: new MemoryStore(), hooks });
const groups = (e: ReturnType<typeof engineFor>, sid: string) => e.list<ExplorationGroup>(sid, 'exploration-group');
const explore = async (e: ReturnType<typeof engineFor>, sid: string) => { await e.explore(sid); await e.waitForIdle(); };

it('gates a non-browser singleton and invokes the universal hook once, ahead of its compatibility alias', async () => {
  let calls = 0;
  const e = engineFor({ explorationScopes: actions => [proposal(actions.map(a => a.id))],
    explorationDecision: () => { calls++; return undefined; }, explorationGroup: () => { throw new Error('Alias should not run'); } });
  try {
    const s = await e.createSession({ maxActions: 3 });
    await e.observe(s.id); await explore(e, s.id);
    expect(calls).toBe(1); expect(groups(e, s.id)[0].members).toHaveLength(1);
    expect(e.session(s.id)).toMatchObject({ actionCount: 0, status: 'paused', stopReason: 'EXPLORATION_DECISION_REQUIRED' });
    expect(e.getFrontier(s.id)[0].coverage.executionStatus).toBe('not_attempted');
    const g = groups(e, s.id)[0]; await e.decideExplorationGroup(s.id, g.id, g.revision, { ...decision, mode: 'all' });
    await explore(e, s.id);
    expect(e.observation(s.id).count).toBe(3); expect(calls).toBe(1);
    expect(groups(e, s.id)[0].members).toHaveLength(4);
    expect(e.session(s.id).stopReason).toBe('BUDGET_EXHAUSTED');
  } finally { await e.close(); }
});

it('distinguishes defer from skip, keeps uncovered history, and permits revising skip to a sample', async () => {
  const e = engineFor({ explorationScopes: actions => [proposal(actions.map(a => a.id))], explorationDecision: () => ({ ...decision, mode: 'defer' }) });
  try {
    const s = await e.createSession({}); await explore(e, s.id);
    expect(e.session(s.id)).toMatchObject({ status: 'paused', stopReason: 'EXPLORATION_DEFERRED', actionCount: 0 });
    let g = groups(e, s.id)[0]; await e.decideExplorationGroup(s.id, g.id, g.revision, { ...decision, mode: 'skip' }); await explore(e, s.id);
    expect(e.session(s.id)).toMatchObject({ status: 'finished', stopReason: 'known_frontier_exhausted_with_gaps', actionCount: 0 });
    expect(e.getFrontier(s.id)[0]).toMatchObject({ status: 'skipped', reason: 'exploration_skipped_by_caller', coverage: { executionStatus: 'not_attempted' } });
    g = groups(e, s.id)[0]; await e.decideExplorationGroup(s.id, g.id, g.revision, { ...decision, mode: 'sample', memberKeys: [g.members[0].key] });
    await explore(e, s.id); expect(e.observation(s.id).count).toBe(1);
    expect(e.getFrontier(s.id).some(f => f.reason === 'exploration_member_not_selected')).toBe(true);
  } finally { await e.close(); }
});

it('combines overlapping scopes and does not release work until every scope permits it', async () => {
  const e = engineFor({ explorationScopes: actions => ['goal', 'cost'].map(key => proposal(actions.map(a => a.id), key)) });
  try {
    const s = await e.createSession({ maxActions: 1 });
    const [goal, cost] = groups(e, s.id);
    await e.decideExplorationGroup(s.id, goal.id, goal.revision, { ...decision, mode: 'skip' });
    expect(e.getFrontier(s.id)[0].status).toBe('skipped');
    await e.decideExplorationGroup(s.id, cost.id, cost.revision, { ...decision, mode: 'all' }); await explore(e, s.id);
    expect(e.session(s.id).actionCount).toBe(0);
    const latest = groups(e, s.id).find(g => g.id === goal.id)!;
    await e.decideExplorationGroup(s.id, latest.id, latest.revision, { ...decision, mode: 'all' }); await explore(e, s.id);
    expect(e.observation(s.id).count).toBe(1);
  } finally { await e.close(); }
});

it('invalidates changed conditions permanently and preserves the original observation and decision audit', async () => {
  let goal = 'A';
  const e = engineFor({ explorationScopes: actions => [proposal(actions.map(a => a.id), 'counter', { goal })] });
  try {
    const s = await e.createSession({}); const original = e.observation(s.id);
    let g = groups(e, s.id)[0]; await e.decideExplorationGroup(s.id, g.id, g.revision, { ...decision, mode: 'all' });
    goal = 'B'; await e.observe(s.id); await explore(e, s.id);
    const invalid = groups(e, s.id).find(x => x.id === g.id)!;
    expect(invalid.status).toBe('invalidated'); expect(invalid.decisions[0].decision.mode).toBe('all');
    await expect(e.decideExplorationGroup(s.id, invalid.id, invalid.revision, { ...decision, mode: 'all' })).rejects.toMatchObject({ code: 'EXPLORATION_SCOPE_INVALIDATED' });
    expect(e.session(s.id).actionCount).toBe(0);
    goal = 'A'; await e.observe(s.id);
    const active = groups(e, s.id).filter(x => x.status !== 'invalidated');
    expect(active).toHaveLength(1); expect(active[0].id).not.toBe(g.id); expect(active[0].status).toBe('pending');
    expect(e.observation(s.id, original.id)).toEqual(original);
    expect(e.store.events(s.id).filter(ev => ev.type === 'exploration.group_invalidated')).toHaveLength(2);
  } finally { await e.close(); }
});

it('does not treat an omitted scope as permission, and invalidates it when business context changes', async () => {
  let emit = true; let context = 'A';
  const e = engineFor({ context: () => ({ business: { value: context, status: 'known', source: 'test' } }),
    explorationScopes: actions => emit ? [proposal(actions.map(a => a.id))] : [] });
  try {
    const s = await e.createSession({}); emit = false; await e.observe(s.id); await explore(e, s.id);
    expect(e.session(s.id).actionCount).toBe(0); expect(e.getFrontier(s.id)[0].status).toBe('deferred');
    context = 'B'; emit = true; await e.observe(s.id);
    expect(groups(e, s.id).map(g => g.status).sort()).toEqual(['invalidated', 'pending']);
    expect(e.getFrontier(s.id).find(f => f.reason === 'exploration_scope_invalidated')?.coverage.executionStatus).toBe('not_attempted');
  } finally { await e.close(); }
});

it.each(['throw', 'absent-action', 'duplicate-scope', 'duplicate-member', 'malformed'] as const)('preserves facts and fails closed on %s scope output, then recovers after a valid capture', async failure => {
  let fail = true;
  const e = engineFor({ explorationScopes: actions => {
    const p = proposal(actions.map(a => a.id));
    if (!fail) return [p];
    if (failure === 'throw') throw new Error('Policy unavailable');
    if (failure === 'absent-action') return [{ ...p, actionIds: ['nonexistent'] }];
    if (failure === 'duplicate-scope') return [p, p];
    if (failure === 'duplicate-member') return [{ ...p, actionIds: [...p.actionIds, ...p.actionIds] }];
    return null as unknown as ExplorationGroupProposal[];
  } });
  try {
    const s = await e.createSession({}); await explore(e, s.id);
    expect(e.observation(s.id).controls).toHaveLength(1);
    expect(e.observation(s.id).gaps.some(g => g.code === 'EXPLORATION_SCOPE_HOOK_FAILED' && g.critical)).toBe(true);
    expect(e.session(s.id).actionCount).toBe(0); expect(groups(e, s.id)).toEqual([]);
    fail = false; await e.observe(s.id); await explore(e, s.id);
    expect(e.session(s.id).stopReason).toBe('EXPLORATION_DECISION_REQUIRED');
    expect(groups(e, s.id)).toHaveLength(1);
  } finally { await e.close(); }
});

it('cannot commit a decision returned after its hook timeout', async () => {
  let finish!: (value: { mode: 'all'; source: string; evidence: string[] }) => void;
  const e = engineFor({ explorationScopes: actions => [proposal(actions.map(a => a.id))],
    explorationDecision: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const s = await e.createSession({}); finish({ ...decision, mode: 'all' });
    await e.observe(s.id); await explore(e, s.id);
    expect(groups(e, s.id)[0].decisions).toEqual([]); expect(e.session(s.id).actionCount).toBe(0);
    expect(e.store.events(s.id).some(ev => ev.type === 'hook.error')).toBe(true);
  } finally { await e.close(); }
});

it('rechecks the selected scope after recovery opens a new instance with an unanswered decision', async () => {
  const e = engineFor({
    actions: (actions, { observation }) => observation.count === 0 ? [actions[0], { ...actions[0], value: { by: 2 }, label: 'Two' }] : [],
    explorationScopes: actions => [proposal(actions.map(a => a.id))],
  });
  try {
    const s = await e.createSession({ maxActions: 5 });
    const initial = groups(e, s.id)[0]; await e.decideExplorationGroup(s.id, initial.id, initial.revision, { ...decision, mode: 'all' });
    await e.execute(s.id, e.actions(s.id).find(a => a.label !== 'Two')!.id, 'move-away');
    await explore(e, s.id);
    expect(groups(e, s.id).find(g => g.id === initial.id)?.status).toBe('invalidated');
    expect(e.list<{ action: { label: string } }>(s.id, 'attempt').some(a => a.action.label === 'Two')).toBe(false);
    expect(e.session(s.id).stopReason).toBe('EXPLORATION_DECISION_REQUIRED');
  } finally { await e.close(); }
});
