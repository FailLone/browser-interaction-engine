import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import type { ActionAttempt, EngineEvent, EngineHooks, Observation, ReachResult } from '@interaction/browser';
import { act, pageOf, testEngine } from './helpers.js';

const html = `<button id="setup">Prepare</button><input id="draft" aria-label="Draft">
  <button id="open" aria-expanded="false" onclick="if(window.allowOpen!==false){menu.hidden=false;this.setAttribute('aria-expanded','true')}">Open menu</button>
  <div id="menu" hidden>
    <button id="nested" aria-expanded="false" onclick="child.hidden=false;this.setAttribute('aria-expanded','true')">Open group</button>
    <button id="close" onclick="menu.hidden=true;child.hidden=true;document.getElementById('open').setAttribute('aria-expanded','false');nested.setAttribute('aria-expanded','false')">Close menu</button>
    <div id="child" hidden><button id="first" onclick="window.firstCalls=(window.firstCalls||0)+1;child.hidden=true;nested.setAttribute('aria-expanded','false')">First leaf</button>
      <button id="second" onclick="window.secondCalls=(window.secondCalls||0)+1">Second leaf</button></div>
  </div>`;

async function setup(hooks: EngineHooks = {}, context = false, content = html) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(content); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
    exploration: 'controls', contextRules: context ? [{ key: 'draft', selector: '#draft', required: true }] : [], maxActions: 30,
  }, { ...hooks, actions(actions, ctx) {
    // The historical branch path deliberately contains an action without replay
    // permission, as can happen with a dismissed notice. Re-entry must not replay it.
    const constrained = actions.map(a => a.label === 'Prepare' ? { ...a, replayable: false } : a);
    return hooks.actions ? hooks.actions(constrained, ctx) : constrained;
  } });
  const events: EngineEvent[] = []; t.engine.events.on('event', e => { if (e.type === 'exploration.target_reentry') events.push(e); });
  return { ...t, events, close: async () => { await t.close(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}

async function visitAndClose(t: Awaited<ReturnType<typeof setup>>) {
  await act(t.engine, t.sessionId, 'Prepare');
  await act(t.engine, t.sessionId, 'Open menu');
  await act(t.engine, t.sessionId, 'Open group');
  await act(t.engine, t.sessionId, 'Close menu');
  await act(t.engine, t.sessionId, 'Draft', 'fill', 'example');
}

it('re-enters nested nonmodal branches from observed reveals and preserves the current draft', async () => {
  const t = await setup();
  try {
    await visitAndClose(t);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId).stopReason).toBe('known_frontier_exhausted');
    expect(await pageOf(t.engine).evaluate(() => [(window as any).firstCalls, (window as any).secondCalls])).toEqual([1, 1]);
    expect(await pageOf(t.engine).locator('#draft').inputValue()).toBe('example');
    expect(t.engine.list<Observation>(t.sessionId, 'observation').every(o => !o.boundaries?.length)).toBe(true);
    expect(t.engine.list<ReachResult>(t.sessionId, 'reach')).toEqual([]);
    expect(t.events.length).toBeGreaterThanOrEqual(3);
    expect(t.events.every(e => (e.data as any).revealed && (e.data as any).sourceAttemptId)).toBe(true);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').filter(a => a.action.label === 'Prepare')).toHaveLength(1);
  } finally { await t.close(); }
});

it('records a no-effect entry as unverified revelation and bounds retries without counting the missing work', async () => {
  const t = await setup();
  try {
    await visitAndClose(t);
    await pageOf(t.engine).evaluate(() => { (window as any).allowOpen = false; });
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.events.length).toBeGreaterThan(0);
    expect(t.events.length).toBeLessThanOrEqual(2); // At most one entry attempt per remaining leaf.
    expect(t.events.every(e => !(e.data as any).revealed)).toBe(true);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(a => a.action.label.endsWith('leaf'))).toBe(false);
    expect(t.engine.controlCoverage(t.sessionId).items.filter(c => c.label.endsWith('leaf')).every(c => c.status !== 'covered')).toBe(true);
    expect(t.engine.session(t.sessionId).stopReason).toBe('known_frontier_exhausted_with_gaps');
  } finally { await t.close(); }
});

it.each(['not-replayable', 'excluded'])('respects current entry permissions: %s', async restriction => {
  let restrict = false;
  const t = await setup({ actions: actions => actions.map(a => restrict && a.label === 'Open menu'
    ? restriction === 'excluded' ? { ...a, excluded: true, exclusionReason: 'review-required' } : { ...a, replayable: false }
    : a) });
  try {
    await visitAndClose(t); restrict = true;
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.events).toEqual([]);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').filter(a => a.action.label === 'Open menu')).toHaveLength(1);
    expect(t.engine.session(t.sessionId).stopReason).toBe('known_frontier_exhausted_with_gaps');
  } finally { await t.close(); }
});

it('does not borrow a reveal path from a different declared business context', async () => {
  const t = await setup({ choose: items => items.find(f => f.action.label === 'Second leaf')?.id || null }, true);
  try {
    await visitAndClose(t); // Draft is part of declared context and changes after the menu visit.
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.events).toEqual([]);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(a => a.action.label.endsWith('leaf'))).toBe(false);
    expect(t.engine.session(t.sessionId).stopReason).toBe('external_strategy_paused');
  } finally { await t.close(); }
});

it('requires fresh reveal evidence after the document is replaced', async () => {
  const t = await setup({ choose: items => items.find(f => f.action.label === 'Second leaf')?.id || null });
  try {
    await visitAndClose(t);
    const original = t.engine.observation(t.sessionId).instanceScope;
    await pageOf(t.engine).reload(); await t.engine.observe(t.sessionId);
    expect(t.engine.observation(t.sessionId).instanceScope).not.toBe(original);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.events).toEqual([]);
    const explicitRecovery = new Set(t.engine.list<ReachResult>(t.sessionId, 'reach').flatMap(r => r.attemptIds));
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').filter(a => a.purpose === 'recovery').every(a => explicitRecovery.has(a.id))).toBe(true);
    expect(t.engine.session(t.sessionId).stopReason).toBe('external_strategy_paused');
  } finally { await t.close(); }
});

it('uses a delayed reveal observed before the next action and cites the actual later observation', async () => {
  const delayed = html.replace('child.hidden=false;this.setAttribute', "if(window.loaded){child.hidden=false}else{setTimeout(()=>{window.loaded=true;child.hidden=false},1000)};this.setAttribute");
  const t = await setup({}, false, delayed);
  try {
    await act(t.engine, t.sessionId, 'Prepare'); await act(t.engine, t.sessionId, 'Open menu');
    const opener = await act(t.engine, t.sessionId, 'Open group');
    expect(t.engine.observation(t.sessionId).controls.find(c => c.name === 'First leaf')!.visible).toBe(false);
    await pageOf(t.engine).locator('#first').waitFor({ state: 'visible' });
    const witness = await t.engine.observe(t.sessionId);
    await act(t.engine, t.sessionId, 'Close menu'); await act(t.engine, t.sessionId, 'Draft', 'fill', 'example');
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId).stopReason).toBe('known_frontier_exhausted');
    expect(t.events.some(e => (e.data as any).sourceAttemptId === opener.id && (e.data as any).sourceObservationId === witness.id)).toBe(true);
    expect(await pageOf(t.engine).evaluate(() => [(window as any).firstCalls, (window as any).secondCalls])).toEqual([1, 1]);
  } finally { await t.close(); }
});

it('does not attribute a later reveal across an intervening action without replay permission', async () => {
  const deferred = html.replace('child.hidden=false;this.setAttribute', 'window.requestPending=true;this.setAttribute');
  const t = await setup({ choose: items => items.find(f => f.action.label === 'Second leaf')?.id || null }, false, deferred);
  try {
    await act(t.engine, t.sessionId, 'Prepare'); await act(t.engine, t.sessionId, 'Open menu'); await act(t.engine, t.sessionId, 'Open group');
    await act(t.engine, t.sessionId, 'Prepare'); // Ends the open-group observation interval.
    await pageOf(t.engine).evaluate(() => { document.getElementById('child')!.hidden = false; });
    await t.engine.observe(t.sessionId);
    await act(t.engine, t.sessionId, 'Close menu'); await act(t.engine, t.sessionId, 'Draft', 'fill', 'example');
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.events).toEqual([]);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(a => a.action.label.endsWith('leaf'))).toBe(false);
  } finally { await t.close(); }
});

it('does not mistake an identity decision about a visible control for an observed reveal', async () => {
  let focus: string | undefined;
  const t = await setup({ choose: items => items.find(f => f.action.controlId === focus)?.id || null }, false,
    `<button id="setup">Prepare</button><button id="unrelated">Unrelated</button><input aria-label="Same"><input aria-label="Same">
    <button id="hide" onclick="document.querySelectorAll('input').forEach(el=>el.hidden=true)">Hide inputs</button>`);
  try {
    await act(t.engine, t.sessionId, 'Prepare'); await act(t.engine, t.sessionId, 'Unrelated');
    const c = t.engine.observation(t.sessionId).controls.find(c => c.role === 'textbox')!;
    expect(c.hypothesisId).toBeTruthy(); focus = c.identityId;
    await t.engine.resolveIdentity(t.sessionId, c.hypothesisId!, c.identityId!, 'test reviewer', ['The first current input is an independent field; it was already visible.']);
    await act(t.engine, t.sessionId, 'Hide inputs');
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.events).toEqual([]);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').filter(a => a.action.label === 'Unrelated')).toHaveLength(1);
  } finally { await t.close(); }
});
