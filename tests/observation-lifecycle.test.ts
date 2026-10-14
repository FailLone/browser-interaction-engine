import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { fixtureServer, testEngine, act, pageOf } from './helpers.js';
import type { ControlIdentity, FrontierItem, InteractionScope } from '@interaction/browser';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });

it('waits through a missing body after an action and compares the rebuilt document', async () => {
  const t = await testEngine(`${fixture.url}/capture.html`, { contextRules: [] });
  try {
    const result = await act(t.engine, t.sessionId, 'Rebuild document');
    expect(result.status).toBe('succeeded');
    expect(result.diff?.changes).toContainEqual(expect.objectContaining({ field: 'value', before: 'before', after: 'after' }));
    expect(t.engine.observation(t.sessionId).gaps.filter(g => g.code !== 'EVENT_LISTENER_COVERAGE')).toEqual([]);
    expect(await pageOf(t.engine).evaluate(() => (window as any).actionCalls)).toBe(1);
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
  } finally { await t.close(); }
});

it('persists a partial observation after the body disappears, without false removals or retries', async () => {
  const t = await testEngine(`${fixture.url}/capture.html`, { contextRules: [], observeTimeoutMs: 250 });
  try {
    const before = t.engine.observation(t.sessionId);
    const result = await act(t.engine, t.sessionId, 'Remove document body');
    expect(result.status).toBe('unknown'); expect(result.afterId).toBeTruthy();
    const after = t.engine.observation(t.sessionId);
    expect(after.stable).toBe(false); expect(after.gaps.map(g => g.code)).toContain('DOM_ROOT_UNAVAILABLE');
    expect(result.diff?.changes.some(c => c.kind === 'disappeared')).toBe(false);
    expect(result.diff?.gaps.some(g => g.critical)).toBe(true);
    expect(t.engine.list<ControlIdentity>(t.sessionId, 'identity').every(c => c.status === 'unknown')).toBe(true);
    expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').find(f => f.attempts.includes(result.id))?.status).toBe('unknown');
    expect(t.engine.observation(t.sessionId, before.id)).toEqual(before);
    const cp = await t.engine.createCheckpoint(t.sessionId, 'partial');
    expect((await t.engine.reachCheckpoint(t.sessionId, cp.id)).status).toBe('UNVERIFIED');
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId).stopReason).toBe('OBSERVATION_INCOMPLETE');
    expect(await pageOf(t.engine).evaluate(() => (window as any).actionCalls)).toBe(1);
    await pageOf(t.engine).evaluate(() => (window as any).restoreBody());
    expect((await t.engine.observe(t.sessionId)).stable).toBe(true);
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
  } finally { await t.close(); }
});

it('handles an absent document element as partial evidence', async () => {
  const t = await testEngine(`${fixture.url}/capture.html`, { contextRules: [], observeTimeoutMs: 150 });
  try {
    await pageOf(t.engine).evaluate(() => document.documentElement.remove());
    const o = await t.engine.observe(t.sessionId);
    expect(o.gaps.some(g => g.code === 'DOM_ROOT_UNAVAILABLE')).toBe(true);
    expect(o.controls).toEqual([]); expect(o.stable).toBe(false);
  } finally { await t.close(); }
});

it('retries transient destroyed contexts and preserves persistent capture failures', async () => {
  const t = await testEngine(`${fixture.url}/capture.html`, { contextRules: [], observeTimeoutMs: 200 });
  const driver = (t.engine as any).driver;
  try {
    const read = vi.spyOn(driver, 'readDOM');
    read.mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation'));
    expect((await t.engine.observe(t.sessionId)).stable).toBe(true);
    read.mockRejectedValue(new Error('Execution context was destroyed'));
    const partial = await t.engine.observe(t.sessionId);
    expect(partial.gaps.some(g => g.code === 'DOM_CAPTURE_FAILED' && g.critical)).toBe(true);
    expect(partial.stable).toBe(false); expect(partial.controls).toEqual([]);
    read.mockRestore();
    expect(t.engine.actions(t.sessionId)).toEqual([]);
    await t.engine.observe(t.sessionId);
    expect((await act(t.engine, t.sessionId, 'Navigate')).status).toBe('succeeded');
    expect(t.engine.observation(t.sessionId).url).toContain('arrived=1');
  } finally { vi.restoreAllMocks(); await t.close(); }
});

it('keeps a boundary open until a complete observation verifies its exit', async () => {
  const t = await testEngine(`${fixture.url}/overlays.html?initial=modal`, { contextRules: [], observeTimeoutMs: 150 });
  try {
    const scope = t.engine.list<InteractionScope>(t.sessionId, 'scope')[0];
    await pageOf(t.engine).evaluate(() => document.body.remove());
    await t.engine.observe(t.sessionId);
    expect(t.engine.list<InteractionScope>(t.sessionId, 'scope').find(s => s.id === scope.id)?.status).toBe('open');
    await expect(t.engine.closeScope(t.sessionId, scope.id)).rejects.toMatchObject({ code: 'OBSERVATION_INCOMPLETE' });
  } finally { await t.close(); }
});

it('preserves observation facts when post-action discovery loses the execution context', async () => {
  const t = await testEngine(`${fixture.url}/capture.html`, { contextRules: [] });
  try {
    vi.spyOn((t.engine as any).driver, 'discover').mockRejectedValueOnce(new Error('Execution context was destroyed'));
    const attempt = await act(t.engine, t.sessionId, 'Value', 'fill', 'new value');
    expect(attempt.status).toBe('unknown'); expect(attempt.afterId).toBeTruthy();
    const o = t.engine.observation(t.sessionId);
    expect(o.controls.find(c => c.name === 'Value')?.value).toBe('new value');
    expect(o.gaps.some(g => g.code === 'ACTION_DISCOVERY_FAILED')).toBe(true);
    expect(o.canonical).toContain('ACTION_DISCOVERY_FAILED');
  } finally { vi.restoreAllMocks(); await t.close(); }
});
