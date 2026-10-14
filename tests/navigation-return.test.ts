import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { PlaywrightAdapter } from '@interaction/adapter-playwright';
import type { ActionAttempt, EngineEvent, EngineHooks, Observation, SessionOptions } from '@interaction/browser';
import { act, pageOf, testEngine } from './helpers.js';

async function setup(mode = 'plain', hooks: EngineHooks = {}, options: Partial<SessionOptions> = {}) {
  const requests: { url: string; method: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url!, method: req.method! }); res.setHeader('Content-Type', 'text/html');
    if (req.url!.startsWith('/b')) res.end(`<a id="back" href="/a">Return link</a><button id="dirty">Change business state</button><script>${['changed', 'dialog-return'].includes(mode) ? "sessionStorage.setItem('version','after')" : ''}</script>`);
    else if (req.url!.startsWith('/posted')) res.end('<a id="next" href="/b">Next</a><p>POST result</p>');
    else res.end(`<button id="prepare">Prepare</button><a id="next" href="/b">Next</a><input id="remaining" aria-label="Remaining">
      ${mode === 'post' ? '<form method="post" action="/posted"><button id="post">Submit</button></form>' : ''}
      ${mode === 'changed' ? `<input id="version" readonly aria-label="Version"><script>function update(){version.value=sessionStorage.getItem('version')||'before'}update();addEventListener('pageshow',update)</script>` : ''}
      ${mode === 'dialog-return' ? `<dialog id="dialog"><button onclick="dialog.close()">Close</button></dialog><script>addEventListener('pageshow',()=>{if(sessionStorage.getItem('version'))dialog.showModal()})</script>` : ''}
      ${mode === 'same-url' ? `<button id="panel" role="tab" onclick="history.pushState({panel:2},'',location.href);view.textContent='Second panel'">Next panel</button><p id="view">First panel</p><script>addEventListener('popstate',()=>view.textContent=history.state?.panel===2?'Second panel':'First panel')</script>` : ''}`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}/a`, {
    exploration: 'controls', contextRules: [], maxActions: 30, ...options,
  }, { ...hooks, actions(actions, ctx) {
    const constrained = actions.map(a => a.label === 'Prepare' ? { ...a, risk: 'interface' as const, replayable: false } : a.label === 'Change business state' ? { ...a, risk: 'unknown' as const, replayable: false } : a);
    return hooks.actions ? hooks.actions(constrained, ctx) : constrained;
  } });
  const events: EngineEvent[] = []; t.engine.events.on('event', e => { if (e.type === 'exploration.source_return') events.push(e); });
  return { ...t, events, requests, close: async () => { await t.close(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}

it('returns to a known native GET entry without replaying a nonreplayable prefix, including forward history', async () => {
  const t = await setup();
  try {
    await act(t.engine, t.sessionId, 'Prepare');
    const a = await t.engine.createCheckpoint(t.sessionId, 'A', [], [], o => Object.values(o.evidence!.artifacts).map(a => a!.key));
    const original = t.engine.observation(t.sessionId);
    expect(original.navigation?.entries[original.navigation.currentIndex].method).toBe('GET');
    await act(t.engine, t.sessionId, 'Next'); const b = await t.engine.createCheckpoint(t.sessionId, 'B', [], [], o => Object.values(o.evidence!.artifacts).map(a => a!.key));
    const reached = await t.engine.reachCheckpoint(t.sessionId, a.id);
    expect(reached.status).toBe('REACHED_VERIFIED'); expect(reached.diagnostics?.strategies).toContain('observed_source_return');
    expect((await t.engine.reachCheckpoint(t.sessionId, b.id)).status).toBe('REACHED_VERIFIED');
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts.filter(a => a.action.kind === 'history')).toHaveLength(2);
    expect(attempts.filter(a => a.action.kind === 'history').every(a => !a.action.replayable && a.status === 'succeeded')).toBe(true);
    expect(attempts.some(a => a.action.source === 'recovery-entry')).toBe(false);
    expect(attempts.filter(a => a.action.label === 'Prepare')).toHaveLength(1);
  } finally { await t.close(); }
});

it('continues original-page control work through native return without claiming checkpoint equality', async () => {
  const t = await setup('plain', { choose: (items, ctx) => (ctx.session.actionCount === 1 ? items.find(f => f.action.label === 'Next') : items.find(f => f.action.label === 'Remaining'))?.id || null });
  try {
    await act(t.engine, t.sessionId, 'Prepare');
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.events).toHaveLength(1); expect((t.events[0].data as any).returnedScope).toBe(true);
    expect(await pageOf(t.engine).locator('#remaining').inputValue()).toBe('example');
    expect(t.engine.list(t.sessionId, 'reach')).toEqual([]);
  } finally { await t.close(); }
});

it('does not turn reaching the same URL into proof that the original state was restored', async () => {
  const t = await setup('changed');
  try {
    await act(t.engine, t.sessionId, 'Prepare'); const cp = await t.engine.createCheckpoint(t.sessionId, 'before');
    await act(t.engine, t.sessionId, 'Next'); const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).not.toBe('REACHED_VERIFIED'); expect(result.checks).toContainEqual({ name: 'observable-state', result: 'fail' });
    expect(result.diagnostics?.strategies).toContain('observed_source_return');
    expect(await pageOf(t.engine).locator('#version').inputValue()).toBe('after');
  } finally { await t.close(); }
});

it('uses the exact native entry when multiple history entries share a URL', async () => {
  const t = await setup('same-url');
  try {
    const cp = await t.engine.createCheckpoint(t.sessionId, 'first'); const before = t.engine.observation(t.sessionId);
    await act(t.engine, t.sessionId, 'Next panel'); const next = t.engine.observation(t.sessionId);
    expect(next.url).toBe(before.url);
    expect(next.navigation?.entries[next.navigation.currentIndex].id).not.toBe(before.navigation?.entries[before.navigation.currentIndex].id);
    // The panel text alone is passive evidence, so use a URL-equal but observable
    // input change as well to require an actual return rather than immediate verification.
    await pageOf(t.engine).evaluate(() => { const el = document.querySelector<HTMLInputElement>('#remaining')!; el.value = 'second'; addEventListener('popstate', () => { el.value = ''; }); });
    await t.engine.observe(t.sessionId);
    expect((await t.engine.reachCheckpoint(t.sessionId, cp.id)).status).toBe('REACHED_VERIFIED');
    expect(await pageOf(t.engine).locator('#view').textContent()).toBe('First panel');
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(a => a.action.kind === 'history')).toBe(true);
  } finally { await t.close(); }
});

it('rejects a stale native history pointer even when URL and DOM remain unchanged', async () => {
  let target: Observation | undefined; const adapter = new PlaywrightAdapter();
  const t = await setup('plain', { actions: (actions, ctx) => { const action = target && adapter.returnToObservation(target, ctx.observation, ctx.session); return action ? [...actions, action] : actions; } });
  try {
    target = t.engine.observation(t.sessionId); await act(t.engine, t.sessionId, 'Next');
    const back = t.engine.actions(t.sessionId).find(a => a.kind === 'history')!;
    const count = t.engine.session(t.sessionId).actionCount;
    await pageOf(t.engine).evaluate(() => history.pushState({}, '', location.href));
    await expect(t.engine.execute(t.sessionId, back.id, 'stale-history')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(count);
  } finally { await t.close(); }
});

it('never revisits a POST result through native history, even when the post was outside the engine', async () => {
  const t = await setup('post');
  try {
    await pageOf(t.engine).locator('#post').click(); await t.engine.observe(t.sessionId);
    const o = t.engine.observation(t.sessionId); expect(o.navigation?.entries[o.navigation.currentIndex].method).toBe('POST');
    expect(t.engine.session(t.sessionId).dirty).toBe(false);
    const cp = await t.engine.createCheckpoint(t.sessionId, 'post-result');
    await act(t.engine, t.sessionId, 'Next'); await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(a => a.action.kind === 'history')).toBe(false);
    expect(t.requests.filter(r => r.method === 'POST')).toHaveLength(1);
  } finally { await t.close(); }
});

it.each(['dirty', 'excluded'])('respects %s restrictions on native return', async restriction => {
  const t = await setup('plain', {}, restriction === 'excluded' ? { exclude: [{ kind: 'history' }] } : {});
  try {
    await act(t.engine, t.sessionId, 'Prepare'); const cp = await t.engine.createCheckpoint(t.sessionId, 'before');
    await act(t.engine, t.sessionId, 'Next');
    if (restriction === 'dirty') await act(t.engine, t.sessionId, 'Change business state');
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).not.toBe('REACHED_VERIFIED');
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(a => a.action.kind === 'history')).toBe(false);
    if (restriction === 'dirty') expect(t.engine.session(t.sessionId).dirty).toBe(true);
  } finally { await t.close(); }
});

it('does not use a history entry from a replaced browser session', async () => {
  const t = await setup();
  try {
    const original = t.engine.observation(t.sessionId);
    await t.engine.stop(t.sessionId); await t.engine.observe(t.sessionId);
    await act(t.engine, t.sessionId, 'Next');
    const current = t.engine.observation(t.sessionId);
    expect(current.navigation?.browserSessionId).not.toBe(original.navigation?.browserSessionId);
    expect(new PlaywrightAdapter().returnToObservation(original, current, t.engine.session(t.sessionId))).toBeUndefined();
  } finally { await t.close(); }
});

it('exits a boundary that appears on native return before continuing checkpoint recovery', async () => {
  const t = await setup('dialog-return');
  try {
    await act(t.engine, t.sessionId, 'Prepare'); const cp = await t.engine.createCheckpoint(t.sessionId, 'before');
    await act(t.engine, t.sessionId, 'Next'); const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).toBe('REACHED_VERIFIED');
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt').filter(a => a.purpose === 'recovery');
    expect(attempts.map(a => a.action.kind)).toEqual(['history', 'click']);
    expect(attempts[1].action.label).toBe('Close');
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
  } finally { await t.close(); }
});
