import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ActionAttempt, FrontierItem } from '@interaction/browser';
import { createServer } from '../apps/server/src/server.js';
import { act, fixtureServer, pageOf, testEngine } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });

it('keeps parent candidates inspectable without duplicating their frontier under an overlay', async () => {
  const t = await testEngine(fixture.url, { contextRules: [] });
  try {
    const parentState = t.engine.observation(t.sessionId).stateId;
    await act(t.engine, t.sessionId, 'Other settings');
    const overlay = t.engine.observation(t.sessionId);
    const amount = t.engine.actions(t.sessionId).find(a => a.label === 'Amount')!;
    expect(amount.preconditions.blockers?.[0].code).toBe('outside_active_boundary');
    await expect(t.engine.execute(t.sessionId, amount.id, 'blocked-background')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').filter(f => f.action.label === 'Amount')).toHaveLength(1);
    expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').some(f => f.stateId === overlay.stateId && f.action.label === 'Time in force')).toBe(true);
    await act(t.engine, t.sessionId, 'Done');
    expect(t.engine.observation(t.sessionId).stateId).toBe(parentState);
    await act(t.engine, t.sessionId, 'Amount', 'fill');
    expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').find(f => f.stateId === parentState && f.action.label === 'Amount')?.status).toBe('executed');
    expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').filter(f => [parentState, t.engine.observation(t.sessionId).stateId].includes(f.stateId) && f.action.label === 'Post only')).toHaveLength(2);
    expect(t.engine.store.list<FrontierItem>('frontier', t.sessionId).some(f => f.action.preconditions.blockers?.some(b => b.code === 'outside_active_boundary'))).toBe(false);
    expect(t.engine.actions(t.sessionId, overlay.id).find(a => a.id === amount.id)).toEqual(amount);
  } finally { await t.close(); }
});

it('preserves outer-layer work across a nested popup without creating inner-state copies', async () => {
  const t = await testEngine(`${fixture.url}/overlays.html?initial=aria`, { contextRules: [] });
  try {
    const outerState = t.engine.observation(t.sessionId).stateId;
    await act(t.engine, t.sessionId, 'Open portal details');
    expect(t.engine.observation(t.sessionId).boundaries).toHaveLength(2);
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Panel value')?.preconditions.blockers?.[0].code).toBe('outside_active_boundary');
    expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').filter(f => f.action.label === 'Panel value')).toHaveLength(1);
    await act(t.engine, t.sessionId, 'Close details');
    expect(t.engine.observation(t.sessionId).stateId).toBe(outerState);
    await act(t.engine, t.sessionId, 'Panel value', 'fill');
    expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').find(f => f.stateId === outerState && f.action.label === 'Panel value')?.status).toBe('executed');
  } finally { await t.close(); }
});

it('omits legacy boundary-only rows consistently from API totals, reports and recovery counts without rewriting history', async () => {
  const t = await testEngine(fixture.url, { contextRules: [] });
  const app = await createServer(t.engine);
  try {
    await act(t.engine, t.sessionId, 'Other settings');
    const action = t.engine.actions(t.sessionId).find(a => a.label === 'Amount')!;
    const legacy: FrontierItem = { id: 'legacy-boundary', sessionId: t.sessionId, key: 'legacy-boundary', stateId: action.stateId, contextKey: '{}', action, status: 'blocked', reason: 'outside_active_boundary', unblock: action.preconditions.blockers![0].unblock, attempts: [], depth: 1 };
    t.engine.store.put('frontier', legacy);
    const before = t.engine.observation(t.sessionId);
    const frontier = t.engine.list<FrontierItem>(t.sessionId, 'frontier');
    expect(frontier.some(f => f.id === legacy.id)).toBe(false);
    const page = (await app.inject(`/v1/sessions/${t.sessionId}/frontier?limit=1`)).json();
    expect(page.total).toBe(frontier.length);
    expect(page.items).toHaveLength(1);
    const blocked = (await app.inject(`/v1/sessions/${t.sessionId}/frontier?status=blocked`)).json();
    expect(blocked.items.some((f: FrontierItem) => f.id === legacy.id)).toBe(false);
    expect(Object.values(t.engine.report(t.sessionId).frontier).reduce((a, b) => a + b, 0)).toBe(frontier.length);
    const cp = await t.engine.createCheckpoint(t.sessionId, 'current overlay');
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.remainingFrontier).toBe(t.engine.list<FrontierItem>(t.sessionId, 'frontier').filter(f => f.status !== 'executed').length);
    expect(t.engine.store.require('frontier', legacy.id)).toEqual(legacy);
    expect(t.engine.observation(t.sessionId, before.id)).toEqual(before);
  } finally { await app.close(); await t.close(); }
});

it('can restore an earlier branch after Done closes settings and a later input changes', async () => {
  const t = await testEngine(fixture.url, { contextRules: [] });
  try {
    const cp = await t.engine.createCheckpoint(t.sessionId, 'entry');
    await act(t.engine, t.sessionId, 'Other settings');
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Done')).toMatchObject({ risk: 'interface', replayable: true, boundary: { intent: 'exit' } });
    await act(t.engine, t.sessionId, 'Done');
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    expect(t.engine.session(t.sessionId).dirty).toBe(false);
    await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).toBe('REACHED_VERIFIED');
    expect(t.engine.observation(t.sessionId).stateId).toBe(cp.stateId);
    expect(result.attemptIds.length).toBeGreaterThan(0);
  } finally { await t.close(); }
});

it('treats native method=dialog dismissal as an interface operation', async () => {
  const t = await testEngine(`${fixture.url}/boundary-cases.html?scenario=native`, { contextRules: [] });
  try {
    const result = await act(t.engine, t.sessionId, 'Finish');
    expect(result.action).toMatchObject({ risk: 'interface', replayable: true, boundary: { intent: 'exit' } });
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    expect(t.engine.session(t.sessionId).dirty).toBe(false);
  } finally { await t.close(); }
});

it('honors a dialog submitter override without treating every button inside its form as an exit', async () => {
  const t = await testEngine(`${fixture.url}/boundary-cases.html?scenario=native`, { contextRules: [] });
  try {
    await pageOf(t.engine).evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('#native form')!;
      const inspect = document.createElement('button'); inspect.type = 'button'; inspect.textContent = 'Inspect details'; form.append(inspect);
    });
    await t.engine.observe(t.sessionId);
    const inspect = t.engine.actions(t.sessionId).find(a => a.label === 'Inspect details')!;
    expect(inspect.boundary?.intent).toBe('interact');
    expect(inspect.risk).toBe('unknown');
    await pageOf(t.engine).evaluate(() => {
      document.querySelector<HTMLFormElement>('#native form')!.method = 'post';
      document.querySelector<HTMLButtonElement>('#native-close')!.setAttribute('formmethod', 'dialog');
    });
    await t.engine.observe(t.sessionId);
    const result = await act(t.engine, t.sessionId, 'Finish');
    expect(result.action.risk).toBe('interface');
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    expect(t.engine.session(t.sessionId).dirty).toBe(false);
  } finally { await t.close(); }
});

it('distinguishes form cancellation from submission and never submits a close-labelled button during recovery', async () => {
  const t = await testEngine(`${fixture.url}/overlays.html`, { contextRules: [] });
  const open = async () => {
    await pageOf(t.engine).evaluate(() => document.querySelector<HTMLDialogElement>('#modal')!.showModal());
    await t.engine.observe(t.sessionId);
  };
  try {
    await pageOf(t.engine).evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>('#modal')!;
      const done = document.querySelector<HTMLButtonElement>('#done')!;
      done.removeAttribute('onclick');
      const form = document.createElement('form'); form.id = 'submit-form';
      form.addEventListener('submit', event => { event.preventDefault(); document.body.dataset.submitted = 'true'; dialog.close(); });
      done.before(form); form.append(done);
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close(); form.append(cancel);
    });
    await t.engine.observe(t.sessionId);
    const cp = await t.engine.createCheckpoint(t.sessionId, 'parent');
    await open();
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Done')).toMatchObject({ risk: 'submission', replayable: false, boundary: { intent: 'exit' } });
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Cancel')).toMatchObject({ risk: 'interface', replayable: true });
    const recovered = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(recovered.status).toBe('REACHED_VERIFIED');
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').filter(a => a.purpose === 'recovery').map(a => a.action.label)).toEqual(['Cancel']);
    expect(await pageOf(t.engine).evaluate(() => document.body.dataset.submitted)).toBeUndefined();
    expect(t.engine.session(t.sessionId).dirty).toBe(false);
    await open(); await act(t.engine, t.sessionId, 'Done');
    expect(await pageOf(t.engine).evaluate(() => document.body.dataset.submitted)).toBe('true');
    expect(t.engine.session(t.sessionId).dirty).toBe(true);
    await open(); await act(t.engine, t.sessionId, 'Cancel');
    expect(t.engine.session(t.sessionId).dirty).toBe(true);
    await act(t.engine, t.sessionId, 'Parent operation');
    const blocked = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(blocked.status).toBe('UNREACHABLE');
    expect(blocked.reason).toContain('no verified return path');
  } finally { await t.close(); }
});
