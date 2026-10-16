import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BrowserEngine, sameObservedState, type ActionAttempt, type EngineHooks, type Observation,
  type SessionOptions } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { pageOf } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(body: string, options: Partial<SessionOptions> = {}, hooks: EngineHooks = {}) {
  const site = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html><head><title>Dynamic grouping fixture</title></head><body>${body}</body></html>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => site.close(() => resolve())));
  const directory = mkdtempSync(join(tmpdir(), 'bie-dynamic-state-grouping-'));
  let engine = new BrowserEngine({ persistence: new SqliteStore(directory), hooks });
  cleanup.push(async () => { await engine.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await engine.createSession({
    url: `http://127.0.0.1:${(site.address() as { port: number }).port}/`, headless: true,
    exploration: 'controls', contextRules: [], settleMs: 0, observeTimeoutMs: 1000,
    actionTimeoutMs: 2000, listExploration: 'all', pageExploration: 'all', ...options,
  });
  return {
    get engine() { return engine; }, sid: session.id,
    async restart() { await engine.close(); engine = new BrowserEngine({ persistence: new SqliteStore(directory), hooks }); return engine; },
  };
}

const quote = '<label>Quote<input id="quote" readonly value="100"></label>';
const currentAction = (engine: BrowserEngine, sid: string, label: string, value?: string) => {
  const actions = engine.actions(sid).filter(a => a.label === label && (value === undefined || a.value === value));
  expect(actions, `one action for ${label}/${value}`).toHaveLength(1);
  return actions[0];
};

it('bounds a 100-tick graph membership index while retaining all 101 strict observations across persistence restart', async () => {
  const f = await fixture(quote), first = f.engine.observation(f.sid), saved: Observation[] = [structuredClone(first)];
  expect(first.controls.find(c => c.stableKey === 'id:quote')).toMatchObject({ value: '100', readOnly: true, editable: false });
  for (let tick = 1; tick <= 100; tick++) {
    await pageOf(f.engine).evaluate(value => { document.querySelector<HTMLInputElement>('#quote')!.value = String(value); }, 100 + tick);
    const observed = await f.engine.observe(f.sid);
    expect(observed.controls.find(c => c.stableKey === 'id:quote')?.value).toBe(String(100 + tick));
    expect(observed.stateId).toBe(first.stateId);
    expect(sameObservedState(first, observed)).toBe(false);
    saved.push(structuredClone(observed));
  }
  const assertRetained = () => {
    const states = f.engine.getGraph(f.sid).states;
    expect(states).toHaveLength(1);
    expect(states[0].observationIds).toEqual([first.id, saved.at(-1)!.id]);
    expect(states[0].grouping).toMatchObject({
      policy: expect.any(String), canonical: expect.any(String), fingerprint: expect.any(String),
      evidence: expect.any(Array), observationCount: 101, memberReferences: 'first-and-latest',
    });
    expect(states[0].grouping!.evidence.length).toBeGreaterThan(0);
    const observations = f.engine.list<Observation>(f.sid, 'observation');
    expect(observations).toHaveLength(101);
    expect(new Set(observations.map(o => o.canonical)).size).toBe(101);
    expect(new Set(observations.map(o => o.fingerprint)).size).toBe(101);
    // The state index is compact. The immutable observations are not deleted or
    // rewritten, and every original quote remains available by its own ID.
    for (const original of saved) expect(f.engine.observation(f.sid, original.id)).toEqual(original);
  };
  assertRetained();
  await f.restart();
  assertRetained();
  await f.engine.observe(f.sid);
  const reopened = f.engine.observation(f.sid), state = f.engine.getGraph(f.sid).states[0];
  expect(reopened.stateId).toBe(first.stateId);
  expect(state.observationIds).toEqual([first.id, reopened.id]);
  expect(state.grouping?.observationCount).toBe(f.engine.list(f.sid, 'observation').length);
  for (const original of saved) expect(f.engine.observation(f.sid, original.id)).toEqual(original);
});

it.each(['controls', 'representative', 'stateful'] as const)('uses the documented grouping policy in %s exploration', async exploration => {
  const f = await fixture(quote, { exploration }), first = f.engine.observation(f.sid);
  await pageOf(f.engine).evaluate(() => { document.querySelector<HTMLInputElement>('#quote')!.value = '101'; });
  const next = await f.engine.observe(f.sid);
  expect(first.canonical).not.toBe(next.canonical);
  expect(first.fingerprint).not.toBe(next.fingerprint);
  expect(sameObservedState(first, next)).toBe(false);
  expect(next.stateId === first.stateId).toBe(exploration !== 'stateful');
  expect(f.engine.getGraph(f.sid).states).toHaveLength(exploration === 'stateful' ? 2 : 1);
  if (exploration === 'stateful') expect(f.engine.getGraph(f.sid).states.every(s => !s.grouping)).toBe(true);
});

const structuredPage = `${quote}<form id="one"><label>Target<input id="target" value="start"></label></form><form id="two"></form>
  <label>Mode<select id="mode"><option>A</option><option>B</option></select></label>
  <a id="destination" href="/a">Destination</a><label><input id="choice" type="checkbox">Choice</label>
  <details id="menu"><summary>Menu</summary><input aria-label="Nested"></details>`;

it.each(['mode', 'editable-value', 'owner', 'type', 'href', 'disabled', 'hidden', 'checked', 'expanded'] as const)(
  'keeps %s changes outside the passive-value graph group', async change => {
    const f = await fixture(structuredPage), first = f.engine.observation(f.sid);
    await pageOf(f.engine).evaluate(change => {
      const target = document.querySelector<HTMLInputElement>('#target')!;
      document.querySelector<HTMLInputElement>('#quote')!.value = '101';
      if (change === 'mode') document.querySelector<HTMLSelectElement>('#mode')!.value = 'B';
      if (change === 'editable-value') target.value = 'different';
      if (change === 'owner') target.setAttribute('form', 'two');
      if (change === 'type') target.type = 'password';
      if (change === 'href') document.querySelector<HTMLAnchorElement>('#destination')!.href = '/b';
      if (change === 'disabled') target.disabled = true;
      if (change === 'hidden') target.hidden = true;
      if (change === 'checked') document.querySelector<HTMLInputElement>('#choice')!.checked = true;
      if (change === 'expanded') document.querySelector<HTMLDetailsElement>('#menu')!.open = true;
    }, change);
    const next = await f.engine.observe(f.sid);
    expect(next.stateId).not.toBe(first.stateId);
    expect(sameObservedState(first, next)).toBe(false);
  },
);

it.each(['onclick="void 0"', 'aria-controls="dependent"'])(
  'does not suppress readonly values that carry an interaction or relation: %s', async attributes => {
    const f = await fixture(`<label>Quote<input id="quote" readonly value="100" ${attributes}></label><div id="dependent">Details</div>`);
    const first = f.engine.observation(f.sid);
    await pageOf(f.engine).evaluate(() => { document.querySelector<HTMLInputElement>('#quote')!.value = '101'; });
    const next = await f.engine.observe(f.sid);
    const control = next.controls.find(c => c.stableKey === 'id:quote')!;
    expect(next.stateId, JSON.stringify({ actions: control.actions, hints: control.interactionHints,
      basis: control.actionBasis, attributes: control.reviewBinding?.attributes })).not.toBe(first.stateId);
    expect(sameObservedState(first, next)).toBe(false);
  },
);

it('does not treat a grouped graph node as a strict checkpoint or an executed target', async () => {
  const f = await fixture(`${quote}<form id="work"><label>Target<input id="target"></label></form>
    <script>localStorage.loads=String(Number(localStorage.loads||0)+1);document.querySelector('#quote').value=localStorage.loads;</script>`, {}, { samples: () => ['sample'] });
  const first = f.engine.observation(f.sid), action = currentAction(f.engine, f.sid, 'Target');
  const checkpoint = await f.engine.createCheckpoint(f.sid, 'Exact initial quote');
  await pageOf(f.engine).evaluate(() => { document.querySelector<HTMLInputElement>('#quote')!.value = '999'; });
  const changed = await f.engine.observe(f.sid);
  expect(changed.stateId).toBe(first.stateId);
  expect(sameObservedState(first, changed)).toBe(false);
  const arrival = await f.engine.reachExplorationTarget(f.sid, { checkpointId: checkpoint.id, observationId: first.id, actionIds: [action.id] });
  expect(arrival).toMatchObject({ status: 'TARGET_REACHED', checkpointVerified: false, currentExecution: false, executionAuthorized: false, attemptIds: [] });
  expect(await pageOf(f.engine).locator('#target').inputValue()).toBe('');
  expect(f.engine.list(f.sid, 'attempt')).toHaveLength(0);
  const targetCases = f.engine.getFrontier(f.sid).filter(f => f.action.label === 'Target');
  expect(targetCases.length).toBeGreaterThan(0);
  expect(targetCases.every(f => f.coverage.executionStatus === 'not_attempted' && !f.coverage.equivalentTo)).toBe(true);
  const strict = await f.engine.reachCheckpoint(f.sid, checkpoint.id);
  expect(strict.status).not.toBe('REACHED_VERIFIED');
  expect(strict.status).not.toBe('REACHED_ACCEPTABLE');
  expect(strict.checks).toContainEqual({ name: 'observable-state', result: 'fail' });
  expect(f.engine.observation(f.sid).stateId).toBe(first.stateId);
  expect(sameObservedState(first, f.engine.observation(f.sid))).toBe(false);
});

it('does not grant a different input sample coverage merely because observations share a graph group', async () => {
  const f = await fixture(`${quote}<form id="work"><label>Target<input id="target"></label></form>`, {}, { samples: () => ['alpha', 'beta'] });
  const first = f.engine.observation(f.sid), action = currentAction(f.engine, f.sid, 'Target', 'alpha');
  const attempt = await f.engine.execute(f.sid, action.id, crypto.randomUUID());
  expect(attempt.status).toBe('succeeded');
  expect(await pageOf(f.engine).locator('#target').inputValue()).toBe('alpha');
  await pageOf(f.engine).evaluate(() => {
    document.querySelector<HTMLInputElement>('#target')!.value = '';
    document.querySelector<HTMLInputElement>('#quote')!.value = '101';
  });
  const current = await f.engine.observe(f.sid), beta = currentAction(f.engine, f.sid, 'Target', 'beta');
  expect(current.stateId).toBe(first.stateId);
  expect(sameObservedState(first, current)).toBe(false);
  expect(f.engine.operationCorrespondence(f.sid, { observationId: current.id, actionId: beta.id,
    source: { sessionId: f.sid, attemptId: attempt.id } }).equivalent).toBe(false);
  const untested = f.engine.getFrontier(f.sid).filter(f => f.action.label === 'Target' && f.action.value === 'beta');
  expect(untested.length).toBeGreaterThan(0);
  expect(untested.every(f => !f.attempts.length && !f.coverage.equivalentTo && f.coverage.executionStatus === 'not_attempted')).toBe(true);
});

it('preserves an unknown outcome across restart and refuses target arrival and dispatch even inside the same graph group', async () => {
  const f = await fixture(`${quote}<form id="work"><label>Target<input id="target"></label></form>`, {}, { samples: () => ['sample'] });
  const first = f.engine.observation(f.sid), action = currentAction(f.engine, f.sid, 'Target');
  const checkpoint = await f.engine.createCheckpoint(f.sid, 'Unknown target checkpoint');
  const attempt = await f.engine.execute(f.sid, action.id, crypto.randomUUID());
  expect(attempt.status).toBe('succeeded');
  // Fault injection at the durable execution boundary, not a claim that the
  // completed fixture input itself had an unknown result.
  f.engine.store.put('attempt', { ...attempt, status: 'executing' });
  await pageOf(f.engine).evaluate(() => {
    document.querySelector<HTMLInputElement>('#quote')!.value = '101';
    document.querySelector<HTMLInputElement>('#target')!.value = '';
  });
  const changed = await f.engine.observe(f.sid);
  expect(changed.stateId).toBe(first.stateId);
  expect(sameObservedState(first, changed)).toBe(false);
  await f.restart();
  expect(f.engine.store.require<ActionAttempt>('attempt', attempt.id).status).toBe('unknown');
  const current = await f.engine.observe(f.sid);
  expect(current.stateId).toBe(first.stateId);
  const ready = currentAction(f.engine, f.sid, 'Target');
  expect(await pageOf(f.engine).locator('#target').isEditable()).toBe(true);
  expect(f.engine.operationCorrespondence(f.sid, { observationId: current.id, actionId: ready.id,
    source: { sessionId: f.sid, attemptId: attempt.id } }).equivalent).toBe(false);
  const arrived = await f.engine.reachExplorationTarget(f.sid, { checkpointId: checkpoint.id, observationId: first.id, actionIds: [action.id] });
  expect(arrived).toMatchObject({ status: 'UNVERIFIED', checkpointVerified: false, matchedActionIds: [], attemptIds: [] });
  await expect(f.engine.execute(f.sid, ready.id, crypto.randomUUID(), undefined,
    { profile: 'interface-exploration', observationId: current.id })).rejects.toMatchObject({ code: 'UNKNOWN_ACTION_OUTCOME' });
  expect(f.engine.list<ActionAttempt>(f.sid, 'attempt')).toHaveLength(1);
  expect(f.engine.store.require<ActionAttempt>('attempt', attempt.id).status).toBe('unknown');
});
