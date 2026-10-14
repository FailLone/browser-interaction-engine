import { beforeAll, afterAll, it, expect } from 'vitest';
import { fixtureServer, testEngine, act, pageOf } from './helpers.js';
import type { ActionAttempt, FrontierItem, InteractionScope } from '@interaction/browser';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const options = { contextRules: [], maxDepth: 20, maxActions: 20 };
const url = (scenario: string) => `${fixture.url}/boundary-cases.html?scenario=${scenario}`;

it('links a hidden portalled popup to its visible opener, even when another hidden opener references it', async () => {
  const t = await testEngine(url('nested'), options);
  try {
    const before = t.engine.observation(t.sessionId);
    await act(t.engine, t.sessionId, 'Open nested popup');
    const o = t.engine.observation(t.sessionId);
    expect(o.boundaries).toHaveLength(2); expect(o.boundaries![1].parentKey).toBe(o.boundaries![0].key);
    const scopes = t.engine.list<InteractionScope>(t.sessionId, 'scope');
    expect(scopes[1].parentScopeId).toBe(scopes[0].id); expect(scopes[1].beforeId).toBe(before.id);
    await act(t.engine, t.sessionId, 'Child input', 'fill'); await act(t.engine, t.sessionId, 'Close child');
    expect(t.engine.observation(t.sessionId).boundaries).toHaveLength(1);
    expect(t.engine.list<InteractionScope>(t.sessionId, 'scope')[1].status).toBe('closed');
    const parent = t.engine.actions(t.sessionId).find(a => a.label === 'Parent action')!;
    await expect(t.engine.execute(t.sessionId, parent.id, 'still-blocked')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
  } finally { await t.close(); }
});

it('recognizes an expanded positioned popup without role semantics', async () => {
  const t = await testEngine(url('hidden-popup'), options);
  try {
    const before = t.engine.observation(t.sessionId); expect(before.boundaries).toEqual([]);
    await act(t.engine, t.sessionId, 'Open popup');
    expect(t.engine.observation(t.sessionId).overlays![0].evidence).toContain('expanded-popup-owner');
    const scope = t.engine.list<InteractionScope>(t.sessionId, 'scope')[0];
    expect(scope.beforeId).toBe(before.id); expect(scope.baseline).toBe('before_entry');
    await act(t.engine, t.sessionId, 'Close child');
    expect(t.engine.list<InteractionScope>(t.sessionId, 'scope')[0].status).toBe('closed');
  } finally { await t.close(); }
});

it('does not reopen the browser behind a boundary whose exit controls have no effect', async () => {
  const t = await testEngine(url('stuck'), options);
  try {
    await pageOf(t.engine).locator('#mask').evaluate(el => (el as HTMLElement).hidden = true);
    await t.engine.observe(t.sessionId); const cp = await t.engine.createCheckpoint(t.sessionId, 'parent');
    await pageOf(t.engine).locator('#mask').evaluate(el => (el as HTMLElement).hidden = false); await t.engine.observe(t.sessionId);
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).toBe('UNREACHABLE'); expect(result.reason).toContain('boundary');
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').every(a => a.action.source !== 'recovery-entry')).toBe(true);
    expect(t.engine.observation(t.sessionId).boundaries).toHaveLength(1);
  } finally { await t.close(); }
});

it('excludes background work from the external strategy while a boundary is active', async () => {
  let offered: FrontierItem[] = [];
  const t = await testEngine(url('modal'), options, { choose(items) { offered = items; return null; } });
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every(f => f.action.boundary?.key === 'dialog:outer')).toBe(true);
    expect(offered.some(f => f.action.label === 'Parent action')).toBe(false);
  } finally { await t.close(); }
});

it('blocks an unclassified obstruction and revalidates the target when uncovered', async () => {
  const t = await testEngine(url('hidden-popup'), options);
  try {
    const old = t.engine.actions(t.sessionId).find(a => a.label === 'Parent action')!;
    await pageOf(t.engine).evaluate(() => { const mask = document.createElement('div'); mask.id = 'obstruction'; mask.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:99'; document.body.append(mask); });
    await expect(t.engine.execute(t.sessionId, old.id, 'old')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    const blocked = t.engine.actions(t.sessionId).find(a => a.label === 'Parent action')!;
    expect(blocked.preconditions.blockers?.[0].code).toBe('pointer_intercepted');
    await expect(t.engine.execute(t.sessionId, blocked.id, 'blocked')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    await pageOf(t.engine).locator('#obstruction').evaluate(el => el.remove()); await t.engine.observe(t.sessionId);
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Parent action')!.preconditions.blockers).toEqual([]);
    expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').find(f => f.stateId === t.engine.observation(t.sessionId).stateId && f.action.label === 'Parent action')?.status).toBe('pending');
  } finally { await t.close(); }
});
