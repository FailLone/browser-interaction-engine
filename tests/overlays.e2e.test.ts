import { beforeAll, afterAll, it, expect } from 'vitest';
import { fixtureServer, testEngine, act, pageOf } from './helpers.js';
import type { ActionAttempt, FrontierItem, InteractionScope } from '@interaction/browser';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });

it.each(['modal', 'aria', 'custom', 'popover'])('explores the initially open %s before parent controls and defers its close button', async initial => {
  const t = await testEngine(`${fixture.url}/overlays.html?initial=${initial}`, { contextRules: [], maxActions: 3, exclude: [{ name: 'Open details' }, { name: 'Open portal details' }] });
  try {
    const o = t.engine.observation(t.sessionId); expect(o.boundaries).toHaveLength(1);
    const parent = t.engine.actions(t.sessionId).find(a => a.label === 'Parent operation')!;
    expect(parent.preconditions.blockers?.[0].code).toBe('outside_active_boundary');
    await expect(t.engine.execute(t.sessionId, parent.id, 'parent-while-open')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts).toHaveLength(3);
    expect(attempts[0].action.kind).toBe('fill');
    expect(attempts[1].action.boundary?.intent).toBe('exit');
    expect(t.engine.observation(t.sessionId, attempts[1].afterId).boundaries).toEqual([]);
    expect(attempts[2].action.label).toBe('Parent operation');
    expect(attempts.every(a => a.status === 'succeeded')).toBe(true);
    const scope = t.engine.list<InteractionScope>(t.sessionId, 'scope')[0];
    expect(scope.status).toBe('closed'); expect(scope.baseline).toBe('already_open');
    expect(scope.diff?.gaps.some(g => g.code === 'SCOPE_ENTRY_BASELINE_UNAVAILABLE')).toBe(true);
    expect(t.engine.store.events(t.sessionId).some(e => e.type === 'interaction.boundary_changed')).toBe(true);
  } finally { await t.close(); }
});

it('tracks nested portalled popovers and returns to their modal before the page', async () => {
  const t = await testEngine(`${fixture.url}/overlays.html?initial=aria`, { contextRules: [], maxActions: 9 });
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts.slice(0, 4).map(a => a.action.label)).toEqual(['Panel value', 'Open portal details', 'Detail value', 'Close details']);
    const parentIndex = attempts.findIndex(a => a.action.label === 'Parent operation');
    expect(parentIndex).toBeGreaterThan(attempts.findIndex(a => a.action.label === 'Close panel'));
    expect(parentIndex).toBeGreaterThan(0);
    expect(t.engine.observation(t.sessionId, attempts[parentIndex].beforeId).boundaries).toEqual([]);
    expect(attempts.every(a => a.status === 'succeeded')).toBe(true);
    const opened = t.engine.observation(t.sessionId, attempts[1].afterId);
    expect(opened.overlays).toHaveLength(2);
    const nested = opened.overlays!.at(-1)!; expect(nested.parentKey).toBe(opened.overlays![0].key);
    const scopes = t.engine.list<InteractionScope>(t.sessionId, 'scope');
    const inner = scopes.find(s => s.boundaryKey === nested.key)!;
    expect(inner.parentScopeId).toBe(scopes[0].id); expect(inner.status).toBe('closed');
    expect(t.engine.observation(t.sessionId, attempts[3].afterId).boundaries).toHaveLength(1);
  } finally { await t.close(); }
});

it('keeps parent exploration suspended when no operation can close a modal', async () => {
  const t = await testEngine(`${fixture.url}/overlays.html?initial=stuck`, { contextRules: [], maxActions: 10 });
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId).stopReason).toBe('ACTIVE_BOUNDARY_BLOCKED');
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts).toHaveLength(1); expect(attempts[0].action.value).toBe('Escape');
    expect(t.engine.observation(t.sessionId).boundaries).toHaveLength(1);
    expect(t.engine.list<InteractionScope>(t.sessionId, 'scope')[0].status).toBe('open');
    expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').find(f => f.action.label === 'Parent operation')?.status).toBe('blocked');
  } finally { await t.close(); }
});

it('offers an exit at the depth limit, but still respects the action budget', async () => {
  const t = await testEngine(`${fixture.url}/overlays.html`, { contextRules: [], maxDepth: 1, maxActions: 2 });
  try {
    await act(t.engine, t.sessionId, 'Open modal');
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts).toHaveLength(2); expect(attempts[1].action.boundary?.intent).toBe('exit');
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    expect(t.engine.session(t.sessionId).stopReason).toBe('BUDGET_EXHAUSTED');
  } finally { await t.close(); }
});

it('detects newly opened overlays before using an old parent action', async () => {
  const t = await testEngine(`${fixture.url}/overlays.html`, { contextRules: [] });
  try {
    const old = t.engine.actions(t.sessionId).find(a => a.label === 'Parent operation')!;
    await pageOf(t.engine).evaluate(() => (document.querySelector('#modal') as HTMLDialogElement).showModal());
    await expect(t.engine.execute(t.sessionId, old.id, 'old-parent')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    const fresh = t.engine.actions(t.sessionId).find(a => a.label === 'Parent operation')!;
    await expect(t.engine.execute(t.sessionId, fresh.id, 'fresh-parent')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
  } finally { await t.close(); }
});

it('closes a popover and verifies the parent checkpoint during recovery', async () => {
  const t = await testEngine(`${fixture.url}/overlays.html`, { contextRules: [] });
  try {
    const cp = await t.engine.createCheckpoint(t.sessionId, 'parent');
    await act(t.engine, t.sessionId, 'Open independent popover');
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).toBe('REACHED_VERIFIED'); expect(result.attemptIds).toHaveLength(1);
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
  } finally { await t.close(); }
});

it('recovers through nested exits without executing a blocked parent action', async () => {
  const t = await testEngine(`${fixture.url}/overlays.html?initial=aria`, { contextRules: [] });
  try {
    await act(t.engine, t.sessionId, 'Close panel');
    const checkpoint = await t.engine.createCheckpoint(t.sessionId, 'parent');
    await pageOf(t.engine).evaluate(() => {
      const panel = document.createElement('div'); panel.id = 'recovery-dialog'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Recovery dialog');
      panel.innerHTML = '<button id="recovery-close" onclick="this.parentElement.remove()">Close dialog</button><button id="recovery-open" popovertarget="details">Nested popup</button>';
      document.body.append(panel);
    });
    await t.engine.observe(t.sessionId); await act(t.engine, t.sessionId, 'Nested popup');
    const result = await t.engine.reachCheckpoint(t.sessionId, checkpoint.id);
    expect(result.status).toBe('REACHED_VERIFIED'); expect(result.attemptIds).toHaveLength(2);
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
  } finally { await t.close(); }
});

it('keeps inline expanded sections outside the exclusive boundary model', async () => {
  const t = await testEngine(fixture.url, { contextRules: [] });
  try {
    await act(t.engine, t.sessionId, 'Duplicate controls');
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Order type')?.preconditions.blockers).toEqual([]);
  } finally { await t.close(); }
});
