import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { BrowserEngine, type ActionAttempt } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin, ExplorerStore, type PlanItem, type Round, type Task } from '@interaction/explorer-plugin';
import { scopeFor, keyFor } from '../packages/explorer-plugin/src/policy.js';
import { recoveryRouteKey, recoveryRouteConditionVersion, recordRouteRetry } from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import { POLICY_VERSION } from '../packages/explorer-plugin/src/decision-policy.js';
import { fakeProviders } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';

/** These negative cases use only pre-scheduler APIs so the identical file can
 * run on 290456d. Each browser, HTTP server and SQLite database is test-owned. */
async function fixture(nativeLinks = false) {
  const events: string[] = [], directory = mkdtempSync(join(tmpdir(), 'bie-scheduler-safety-'));
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/oracle?')) {
      events.push(new URL(req.url, 'http://fixture').searchParams.get('target')!); res.writeHead(204); res.end(); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/away' ? '<!doctype html><title>Away</title><main><output id="price">100</output></main>'
      : `<!doctype html><title>Source</title><main>
        ${nativeLinks ? '<section id="records" aria-label="Records"><a id="first" href="/first"><span>First </span><span>$100</span></a><a id="second" href="/second"><span>Second </span><span>$100</span></a><a href="/third"><span>Third </span><span>$100</span></a></section>' : `<button id="first" type="button" onclick="record('First')">First</button>
        <button id="second" type="button" onclick="record('Second')">Second</button>`}
        <a href="/away">Leave</a></main>
        <script>function record(target){const r=new XMLHttpRequest();r.open('POST','/oracle?target='+target,false);r.send();}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`, providers = fakeProviders(url);
  const hostPath = join(directory, 'host'), pluginPath = join(directory, 'plugin.sqlite');
  let host = new BrowserEngine({ persistence: new SqliteStore(hostPath) });
  let plugin = new ExplorerPlugin(host, new ExplorerStore(pluginPath), providers);
  const options = { url, headless: true, exploration: 'controls', executionPolicy: 'interface-only', settleMs: 0,
    observeTimeoutMs: 1000, actionTimeoutMs: 2000, contextRules: [], regionExploration: 'off', pageExploration: 'all',
    listExploration: 'all', interfaceActions: [{ kind: 'click' }] };
  const session = await host.createSession(options), sid = session.id;
  const source = host.observation(sid), checkpoint = await host.createCheckpoint(sid, 'Retained source');
  const sourceActions = host.actions(sid, source.id), targets = sourceActions.filter(a => /^(First|Second)( |$)/.test(a.label));
  expect(targets).toHaveLength(2);
  const leave = await host.execute(sid, sourceActions.find(a => a.label === 'Leave')!.id, 'leave-owned-fixture');
  expect(leave.status).toBe('succeeded');
  let task = plugin.create({ url, budget: { rounds: 4, actions: 30, modelRequests: 12, durationMs: 60000 },
    sessionOptions: { headless: true, executionPolicy: 'interface-only', settleMs: 0, observeTimeoutMs: 1000, actionTimeoutMs: 2000 } });
  const root: PlanItem = { id: 'accepted-root', title: 'Accepted source page', scope: { url }, prerequisites: [],
    completion: 'Explore observed source work', required: true, dispatchScope: true, status: 'unresolved',
    reason: 'user_goal', evidence: [{ sessionId: sid, observationId: source.id }], attempts: [] };
  task.plan = [root, ...targets.map((action, index): PlanItem => ({ id: `retained-${index}`, title: action.label,
    scope: scopeFor(action, source), prerequisites: [], completion: 'Execute retained target', required: true,
    dispatchScope: false, status: 'unresolved', reason: 'operation_not_executed', operationConditionKey: keyFor(action, source),
    operationConditionPolicy: 'browser-operation-key-v2', evidence: [{ sessionId: sid, observationId: source.id }], attempts: [] }))];
  task.rounds = [{ id: 'source-round', number: 1, sessionId: sid, startedAt: new Date().toISOString(), status: 'running',
    actions: host.session(sid).actionCount, policyVersion: POLICY_VERSION, entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0,
    stack: [{ checkpointId: checkpoint.id, observationId: source.id, stateId: source.stateId, path: [], used: [], remaining: targets.map(a => scopeFor(a, source)) }] }];
  task.status = 'running'; task.usage.rounds = 1; plugin.store.save(task);
  return { sid, source, sourceActions, targets, checkpoint, leave, url, events, providers, options,
    get host() { return host; }, get plugin() { return plugin; }, get task() { return task; },
    get round() { return task.rounds.at(-1)!; },
    step() { return (plugin as unknown as { step(task: Task, round: Round, signal: AbortSignal): Promise<boolean> }).step(task, task.rounds.at(-1)!, new AbortController().signal); },
    async coldRestart() {
      plugin.store.save(task); await plugin.close(); await host.close();
      host = new BrowserEngine({ persistence: new SqliteStore(hostPath) });
      plugin = new ExplorerPlugin(host, new ExplorerStore(pluginPath), providers); task = plugin.store.task(task.id);
    },
    async close() { await plugin.close(); await host.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); },
  };
}

function denyRecovery(f: Awaited<ReturnType<typeof fixture>>) {
  // Fail before any actual browser navigation if a forbidden route is selected.
  const checkpoint = vi.spyOn(f.host, 'reachCheckpoint').mockRejectedValue(new Error('Forbidden checkpoint recovery selected'));
  const target = vi.spyOn(f.host, 'reachExplorationTarget').mockRejectedValue(new Error('Forbidden target recovery selected'));
  const execute = vi.spyOn(f.host, 'execute').mockRejectedValue(new Error('Forbidden action dispatch selected'));
  return { checkpoint, target, execute, assertUnused() { expect(checkpoint).not.toHaveBeenCalled(); expect(target).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); } };
}

it.each([false, true])('does not bypass exhausted legacy composite route debt with new per-item keys (orphaned=%s)', async orphaned => {
  const f = await fixture();
  try {
    // Authorize the two click targets, without a separate broad discovery goal
    // that could legitimately request an unrelated root inspection.
    f.task.plan[0].scope = { url: f.url, kind: 'click' };
    const frame = f.round.stack[0], current = f.host.observation(f.sid);
    const routeKey = recoveryRouteKey(f.source, f.sourceActions, frame.remaining, frame.path);
    const conditionVersion = recoveryRouteConditionVersion(current, f.host.actions(f.sid), [...frame.path, ...frame.remaining]);
    f.task.routeRetries = recordRouteRetry(undefined, { routeKey, conditionVersion, outcome: 'unreachable', reason: 'Original composite restoration failed', attemptKey: 'retained-route-attempt' });
    const debt = structuredClone(f.task.routeRetries);
    if (orphaned) f.round.stack = [];
    const denied = denyRecovery(f);
    for (let price = 101; price <= 103; price++) {
      await pageOf(f.host).locator('#price').evaluate((node, value) => { node.textContent = String(value); }, price);
      await f.host.observe(f.sid);
      const result = await f.step().catch(error => error);
      denied.assertUnused(); expect(result).not.toBeInstanceOf(Error);
      expect(f.task.routeRetries).toEqual(debt);
    }
    await f.coldRestart(); f.task.status = 'running'; const afterRestart = denyRecovery(f);
    const observe = vi.spyOn(f.host, 'observe'), create = vi.spyOn(f.host, 'createSession');
    const result = await f.step().catch(error => error);
    afterRestart.assertUnused(); expect(result).not.toBeInstanceOf(Error);
    expect(observe).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(f.task.routeRetries).toEqual(debt);
    expect(f.task.plan.filter(i => i.id.startsWith('retained-')).every(i => i.status !== 'succeeded' && !i.resolvedBy)).toBe(true);
    expect(f.events).toEqual([]); expect(f.providers.calls).toEqual([]);
  } finally { await f.close(); }
});

it('keeps an already associated composite debt after a fresh duplicate row ID is discovered and the historical stack disappears', async () => {
  const f = await fixture();
  try {
    f.task.plan[0].scope = { url: f.url, kind: 'click' };
    const frame = f.round.stack[0], current = f.host.observation(f.sid);
    const routeKey = recoveryRouteKey(f.source, f.sourceActions, frame.remaining, frame.path);
    const conditionVersion = recoveryRouteConditionVersion(current, f.host.actions(f.sid), frame.remaining);
    f.task.routeRetries = recordRouteRetry(undefined, { routeKey, conditionVersion, outcome: 'unreachable', reason: 'Composite route exhausted', attemptKey: 'legacy-attempt' });
    const denied = denyRecovery(f), debt = structuredClone(f.task.routeRetries);
    const initial = await f.step().catch(error => error);
    denied.assertUnused(); expect(initial).not.toBeInstanceOf(Error);
    // New discovery bookkeeping cannot mint a route allowance for the same
    // retained target. No new completion, source condition or authority exists.
    f.task.plan.push({ ...structuredClone(f.task.plan.find(i => i.id === 'retained-0')!), id: 'rediscovered-row-id' });
    f.round.stack = [];
    const repeated = await f.step().catch(error => error);
    denied.assertUnused(); expect(repeated).not.toBeInstanceOf(Error);
    expect(f.task.routeRetries).toEqual(debt); expect(f.events).toEqual([]);
  } finally { await f.close(); }
});

it('never restores another session checkpoint when only historical target evidence survives and no EntryRoute exists', async () => {
  const f = await fixture();
  try {
    f.round.status = 'finished';
    await f.host.stop(f.sid);
    const next = await f.host.createSession({ ...f.options, url: `${f.url}away` });
    f.task.rounds.push({ ...structuredClone(f.round), id: 'new-round', number: 2, sessionId: next.id, status: 'running',
      actions: 0, stack: [], entryPath: [], entryRoutes: [] });
    f.task.usage.rounds = 2;
    const denied = denyRecovery(f), before = structuredClone(f.task.plan);
    const result = await f.step().catch(error => error);
    denied.assertUnused(); expect(result).not.toBeInstanceOf(Error);
    expect(f.task.plan.filter(i => before.some(old => old.id === i.id)).every(i => i.status !== 'succeeded' && !i.resolvedBy)).toBe(true);
    expect(f.host.list(next.id, 'attempt')).toEqual([]); expect(f.events).toEqual([]);
  } finally { await f.close(); }
});

it('retained gaps and a historical root frame do not authorize returning to a page after its accepted scope is removed', async () => {
  const f = await fixture();
  try {
    f.task.plan = f.task.plan.filter(i => i.dispatchScope === false);
    f.round.stack[0].remaining = [{ url: f.url }];
    const denied = denyRecovery(f), before = structuredClone(f.task.plan);
    const result = await f.step().catch(error => error);
    denied.assertUnused(); expect(result).not.toBeInstanceOf(Error);
    expect(f.task.plan.filter(i => before.some(old => old.id === i.id))).toEqual(before);
    expect(f.events).toEqual([]);
  } finally { await f.close(); }
});

it('a durable unknown in the old source session blocks cold-start scheduling before observation, replacement session or dispatch', async () => {
  const f = await fixture();
  try {
    f.host.store.put('attempt', { ...f.leave, purpose: 'recovery', status: 'unknown', reason: 'Independent result-loss fault' } satisfies ActionAttempt);
    f.task.status = 'paused'; f.round.status = 'paused'; f.round.policyVersion = 'older-policy';
    await f.coldRestart();
    const denied = denyRecovery(f), observe = vi.spyOn(f.host, 'observe'), create = vi.spyOn(f.host, 'createSession');
    f.plugin.start(f.task.id); await f.plugin.waitForIdle();
    const result = f.plugin.view(f.task.id).task;
    expect(result).toMatchObject({ status: 'blocked', reason: 'UNKNOWN_DISPATCH_REQUIRES_REVIEW' });
    denied.assertUnused(); expect(observe).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(result.rounds).toHaveLength(1); expect(f.host.list<ActionAttempt>(f.sid, 'attempt').find(a => a.id === f.leave.id)?.status).toBe('unknown');
    expect(result.plan.filter(i => i.id.startsWith('retained-')).every(i => !i.resolvedBy && i.status !== 'succeeded')).toBe(true);
    expect(f.events).toEqual([]); expect(f.providers.calls).toEqual([]);
  } finally { await f.close(); }
});


it('does not turn an exhausted composite route into a fresh singleton route when native-link quote labels change', async () => {
  const f = await fixture(true);
  try {
    f.task.plan[0].scope = { url: f.url, kind: 'click' };
    const frame = f.round.stack[0], current = f.host.observation(f.sid);
    const routeKey = recoveryRouteKey(f.source, f.sourceActions, frame.remaining, frame.path);
    const conditionVersion = recoveryRouteConditionVersion(current, f.host.actions(f.sid), frame.remaining);
    f.task.routeRetries = recordRouteRetry(undefined, { routeKey, conditionVersion, outcome: 'unreachable', reason: 'Composite route exhausted', attemptKey: 'legacy-quote-attempt' });
    const denied = denyRecovery(f), debt = structuredClone(f.task.routeRetries);
    const initial = await f.step().catch(error => error);
    denied.assertUnused(); expect(initial).not.toBeInstanceOf(Error);
    await pageOf(f.host).goto(f.url);
    await pageOf(f.host).locator('#first span:last-child').evaluate(node => { node.textContent = '$999'; });
    await f.host.observe(f.sid);
    const fresh = f.host.observation(f.sid), first = f.host.actions(f.sid).find(a => a.label === 'First $999')!;
    expect(first).toBeDefined(); await f.host.createCheckpoint(f.sid, 'Same native operation after a quote update');
    expect(recoveryRouteKey(fresh, [first], [scopeFor(first, fresh)]))
      .toBe(recoveryRouteKey(f.source, f.sourceActions, [scopeFor(f.targets.find(a => a.label === 'First $100')!, f.source)]));
    f.task.plan.push({ ...structuredClone(f.task.plan.find(i => i.id === 'retained-0')!), id: 'new-quote-row',
      title: first.label, scope: scopeFor(first, fresh), operationConditionKey: keyFor(first, fresh),
      evidence: [{ sessionId: f.sid, observationId: fresh.id }] });
    f.round.stack = [];
    await pageOf(f.host).goto(`${f.url}away`); await f.host.observe(f.sid);
    const repeated = await f.step().catch(error => error);
    denied.assertUnused(); expect(repeated).not.toBeInstanceOf(Error);
    expect(f.task.routeRetries).toEqual(debt); expect(f.events).toEqual([]);
  } finally { await f.close(); }
});

it('retained gaps do not authorize a local boundary exit after every accepted scope is removed', async () => {
  const f = await fixture();
  try {
    await pageOf(f.host).goto(f.url);
    await pageOf(f.host).evaluate(() => {
      const dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', 'Revoked work');
      dialog.innerHTML = '<form method="dialog"><button>Close</button></form>';
      document.body.append(dialog); dialog.showModal();
    });
    await f.host.observe(f.sid);
    expect(f.host.observation(f.sid).boundaries).toHaveLength(1);
    expect(f.host.actions(f.sid).some(a => a.label === 'Close' && a.boundary?.intent === 'exit')).toBe(true);
    f.task.plan = f.task.plan.filter(i => i.dispatchScope === false); f.round.stack = [];
    const denied = denyRecovery(f);
    for (let step = 0; step < 4; step++) {
      const result = await f.step().catch(error => error);
      denied.assertUnused(); expect(result).not.toBeInstanceOf(Error);
      if (result === false) break;
    }
    expect(await pageOf(f.host).locator('dialog').evaluate(node => (node as HTMLDialogElement).open)).toBe(true);
    expect(f.events).toEqual([]); expect(f.task.plan.every(i => !i.resolvedBy)).toBe(true);
  } finally { await f.close(); }
});


it('does not renew a failed route condition when a still-obstructed native target changes only its quote label', async () => {
  const f = await fixture(true);
  try {
    f.task.plan[0].scope = { url: f.url, kind: 'click' };
    await pageOf(f.host).goto(f.url);
    await pageOf(f.host).evaluate(() => {
      document.querySelectorAll<HTMLElement>('#records a').forEach(node => { node.style.pointerEvents = 'none'; });
      document.querySelector<HTMLAnchorElement>('main > a')!.hidden = true;
    });
    await f.host.observe(f.sid);
    const frame = f.round.stack[0], obstructed = f.host.observation(f.sid), obstructedActions = f.host.actions(f.sid);
    expect(obstructedActions.find(a => a.label === 'First $100')?.preconditions.blockers?.some(b => b.code === 'pointer_intercepted')).toBe(true);
    const routeKey = recoveryRouteKey(f.source, f.sourceActions, frame.remaining, frame.path);
    const conditionVersion = recoveryRouteConditionVersion(obstructed, obstructedActions, frame.remaining);
    f.task.routeRetries = recordRouteRetry(undefined, { routeKey, conditionVersion, outcome: 'unreachable', reason: 'Obstructed target restoration failed', attemptKey: 'obstructed-quote-attempt' });
    const denied = denyRecovery(f), debt = structuredClone(f.task.routeRetries);
    const initial = await f.step().catch(error => error);
    denied.assertUnused(); expect(initial).not.toBeInstanceOf(Error);
    await pageOf(f.host).locator('#first span:last-child').evaluate(node => { node.textContent = '$999'; });
    await f.host.observe(f.sid);
    const changed = f.host.observation(f.sid), changedActions = f.host.actions(f.sid);
    expect(changedActions.some(a => a.label === 'First $100')).toBe(false);
    const first = changedActions.find(a => a.label === 'First $999')!;
    expect(first?.preconditions.blockers?.some(b => b.code === 'pointer_intercepted')).toBe(true);
    expect(recoveryRouteKey(changed, [first], [scopeFor(first, changed)]))
      .toBe(recoveryRouteKey(f.source, f.sourceActions, [scopeFor(f.targets.find(a => a.label === 'First $100')!, f.source)]));
    const repeated = await f.step().catch(error => error);
    denied.assertUnused(); expect(repeated).not.toBeInstanceOf(Error);
    expect(f.task.routeRetries).toEqual(debt); expect(f.events).toEqual([]);
  } finally { await f.close(); }
});
