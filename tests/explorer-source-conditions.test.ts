import { expect, it, vi } from 'vitest';
import { ExplorerPlugin, ExplorerStore, type PlanItem, type Round, type Task } from '@interaction/explorer-plugin';
import type { ActionAttempt } from '@interaction/browser';
import { completedOperations } from '../packages/explorer-plugin/src/completion-evidence.js';
import { scopeFor } from '../packages/explorer-plugin/src/policy.js';
import { browserOperationKey } from '../packages/adapter-playwright/src/exploration.js';
import { explorerFixture, fakeProviders } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';

const html = `<form id="modes"><label>Mode <select id="mode"><option value="a">A</option><option value="b">B</option></select></label>
  <button id="run" type="button" onclick="document.querySelector('#result').textContent=document.querySelector('#mode').value+' branch'">Run</button></form><output id="result"></output>`;
const options = { headless: true, exploration: 'controls', settleMs: 0, observeTimeoutMs: 100,
  regionExploration: 'off', pageExploration: 'all', listExploration: 'all', interfaceActions: [{ kind: 'click' }] };
function runAction(host: Awaited<ReturnType<typeof explorerFixture>>['host'], sid: string) {
  const o = host.observation(sid), target = o.controls.find(c => c.stableKey === 'id:run')!;
  return host.actions(sid).find(a => a.localId === target.localId && a.kind === 'click')!;
}

it('the actual plugin schedules a new mode branch in one round and reuses verified history when mode A returns', async () => {
  const f = await explorerFixture(`${html}<button id="later" type="button" disabled>Later</button>`), providers = fakeProviders(f.url), plugin = new ExplorerPlugin(f.host, new ExplorerStore(':memory:'), providers);
  try {
    const session = await f.host.createSession({ ...options, url: f.url });
    const created = plugin.create({ url: f.url, budget: { rounds: 1, actions: 8 } });
    // A known unavailable click remains pending, keeping the exploration scope
    // open while a new externally observed mode arrives. A completed one-shot
    // user action is not silently changed into a continuous monitoring request.
    plugin.revise(created.id, { items: [{ title: 'Encountered click branches', scope: { url: f.url, kind: 'click' }, prerequisites: [], completion: 'Observe encountered branches', required: true, reason: 'Explicit fixture target' }] });
    const task = plugin.store.task(created.id), round: Round = { id: 'mode-round', number: 1, sessionId: session.id, startedAt: new Date().toISOString(), status: 'running', actions: 0, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 };
    task.rounds = [round]; task.status = 'running'; plugin.store.save(task);
    const runtime = plugin as unknown as { step(task: Task, round: Round, signal: AbortSignal): Promise<boolean> };
    const step = () => runtime.step(task, round, new AbortController().signal);
    for (let i = 0; i < 10 && f.host.session(session.id).actionCount < 1; i++) await step();
    expect(await pageOf(f.host).locator('#result').textContent()).toBe('a branch');
    await pageOf(f.host).evaluate(() => { (document.querySelector('#mode') as HTMLSelectElement).value = 'b'; });
    await f.host.observe(session.id);
    for (let i = 0; i < 10 && f.host.session(session.id).actionCount < 2; i++) await step();
    expect(f.host.list<ActionAttempt>(session.id, 'attempt').map(a => [a.action.label, a.status])).toEqual([['Run', 'succeeded'], ['Run', 'succeeded']]);
    expect(await pageOf(f.host).locator('#result').textContent()).toBe('b branch');
    const successes = f.host.list<ActionAttempt>(session.id, 'attempt').filter(a => a.status === 'succeeded' && a.action.label === 'Run');
    expect(successes).toHaveLength(2);
    const leaves = task.plan.filter(i => i.dispatchScope === false && i.scope.label === 'Run' && i.reason === 'observed_in_scope');
    expect(new Set(leaves.map(i => i.operationConditionKey)).size).toBe(2);
    expect(leaves.every(i => i.status === 'succeeded' && !!i.resolvedBy?.attemptId)).toBe(true);
    await pageOf(f.host).evaluate(() => { (document.querySelector('#mode') as HTMLSelectElement).value = 'a'; });
    const returned = await f.host.observe(session.id), current = runAction(f.host, session.id);
    expect(completedOperations(f.host, task, returned, [current]).has(current)).toBe(true);
    await step();
    const attempts=f.host.list<ActionAttempt>(session.id, 'attempt').filter(a => a.action.label === 'Run');
    expect(attempts,JSON.stringify({attempts:attempts.map(a=>({purpose:a.purpose,beforeId:a.beforeId,afterId:a.afterId,status:a.status})),
      recovery:f.host.store.events(session.id).filter(e=>e.type.startsWith('checkpoint.')).slice(-12)})).toHaveLength(2);
    expect(providers.calls).toEqual([]);
    // This finite fixture proves the encountered branches, not real-page exhaustion.
  } finally { await plugin.close(); await f.close(); }
});

it('retains multiple successful source proofs when a legacy plan row points at the latest mode', async () => {
  const f = await explorerFixture(html), plugin = new ExplorerPlugin(f.host, new ExplorerStore(':memory:'));
  try {
    const session = await f.host.createSession({ ...options, url: f.url }), initial = f.host.observation(session.id), initialAction = runAction(f.host, session.id);
    const first = await f.host.execute(session.id, initialAction.id, 'mode-a');
    await pageOf(f.host).evaluate(() => { (document.querySelector('#mode') as HTMLSelectElement).value = 'b'; });
    await f.host.observe(session.id); const second = await f.host.execute(session.id, runAction(f.host, session.id).id, 'mode-b');
    const ref = (a: ActionAttempt) => ({ sessionId: session.id, observationId: a.beforeId, attemptId: a.id });
    const task = plugin.create({ url: f.url }), item: PlanItem = { id: 'legacy-proof', title: 'Run', scope: scopeFor(initialAction, initial), prerequisites: [], completion: 'Retain outcomes', required: true, dispatchScope: false,
      status: 'succeeded', reason: 'action_verified', resolvedBy: ref(second), evidence: [ref(first), ref(second)], attempts: [first, second].map(a => ({ roundId: 'r', outcome: a.status, evidence: ref(a) })) };
    task.plan = [item]; const batch = vi.spyOn(f.host, 'operationCorrespondences');
    const check = async (mode: string) => {
      await pageOf(f.host).evaluate(value => { (document.querySelector('#mode') as HTMLSelectElement).value = value; }, mode);
      const o = await f.host.observe(session.id), a = runAction(f.host, session.id);
      return { completed: completedOperations(f.host, task, o, [a]), a };
    };
    const a = await check('a'); expect(a.completed.has(a.a)).toBe(true);
    const b = await check('b'); expect(b.completed.has(b.a)).toBe(true);
    expect(batch.mock.calls.every(([, input]) => input.requests.length === 2)).toBe(true);
    f.host.store.put('attempt', { ...first, status: 'unknown' });
    const unknown = await check('a'); expect(unknown.completed.has(unknown.a)).toBe(false);
    expect(f.host.list<ActionAttempt>(session.id, 'attempt')).toHaveLength(2);
    expect(task.plan[0].attempts).toHaveLength(2);
  } finally { await plugin.close(); await f.close(); }
});

it('does not skip a rebuilt shared-key button when its semantic owner changes, or repeat an unchanged owner rebuild', async () => {
  const f = await explorerFixture(`<div id="owner" aria-label="Owner A"><button data-testid="shared" type="button" onclick="document.querySelector('#result').textContent=this.parentElement.getAttribute('aria-label')">Run</button></div><button id="later" type="button" disabled>Later</button><output id="result"></output>`);
  const providers = fakeProviders(f.url), plugin = new ExplorerPlugin(f.host, new ExplorerStore(':memory:'), providers);
  try {
    const session = await f.host.createSession({ ...options, url: f.url }), created = plugin.create({ url: f.url, budget: { rounds: 1, actions: 8 } });
    plugin.revise(created.id, { items: [{ title: 'Encountered clicks', scope: { url: f.url, kind: 'click' }, prerequisites: [], completion: 'Observe branches', required: true, reason: 'Fixture scope' }] });
    const task = plugin.store.task(created.id), round: Round = { id: 'owner-round', number: 1, sessionId: session.id, startedAt: new Date().toISOString(), status: 'running', actions: 0, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 };
    task.rounds = [round]; task.status = 'running'; plugin.store.save(task);
    const runtime = plugin as unknown as { step(task: Task, round: Round, signal: AbortSignal): Promise<boolean> };
    const step = () => runtime.step(task, round, new AbortController().signal);
    const before = f.host.observation(session.id), first = f.host.actions(session.id).find(a => a.label === 'Run')!;
    for (let i = 0; i < 10 && f.host.session(session.id).actionCount < 1; i++) await step();
    expect(await pageOf(f.host).locator('#result').textContent()).toBe('Owner A');
    await pageOf(f.host).evaluate(() => {
      const owner = document.querySelector('#owner')!; owner.setAttribute('aria-label', 'Owner B');
      const button = owner.querySelector('button')!; button.replaceWith(button.cloneNode(true));
    });
    const changed = await f.host.observe(session.id), second = f.host.actions(session.id).find(a => a.label === 'Run')!;
    expect(scopeFor(second, changed).stableKey).toBe(scopeFor(first, before).stableKey);
    expect(scopeFor(second, changed).targetBinding).not.toBe(scopeFor(first, before).targetBinding);
    expect(browserOperationKey(second, changed)).not.toBe(browserOperationKey(first, before));
    expect(completedOperations(f.host, task, changed, [second]).has(second)).toBe(false);
    for (let i = 0; i < 10 && f.host.session(session.id).actionCount < 2; i++) await step();
    expect(await pageOf(f.host).locator('#result').textContent()).toBe('Owner B');
    await pageOf(f.host).evaluate(() => { const button = document.querySelector('#owner button')!; button.replaceWith(button.cloneNode(true)); });
    const rebuilt = await f.host.observe(session.id), current = f.host.actions(session.id).find(a => a.label === 'Run')!;
    expect(browserOperationKey(current, rebuilt)).toBe(browserOperationKey(second, changed));
    expect(completedOperations(f.host, task, rebuilt, [current]).has(current)).toBe(true);
    await step();
    expect(f.host.list<ActionAttempt>(session.id, 'attempt').filter(a => a.action.label === 'Run')).toHaveLength(2);
    expect(providers.calls).toEqual([]);
  } finally { await plugin.close(); await f.close(); }
});
