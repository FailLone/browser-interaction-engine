import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserEngine, type ActionAttempt, type ActionCandidate, type Observation } from '@interaction/browser';
import { hash } from '@interaction/core';
import { browserOperationKey } from '../packages/adapter-playwright/src/exploration.js';
import { formBinding } from '../packages/adapter-playwright/src/util.js';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin, ExplorerStore, type PlanItem, type Round, type Scope } from '@interaction/explorer-plugin';
import { POLICY_VERSION } from '../packages/explorer-plugin/src/decision-policy.js';
import { capturedRoute } from '../packages/explorer-plugin/src/reentry-evidence.js';
import { scopeFor } from '../packages/explorer-plugin/src/policy.js';
import { fakeProviders } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(kind: 'plain' | 'nested' | 'modal' | 'many' | 'modes' = 'plain') {
  const oracle: string[] = [], directory = mkdtempSync(join(tmpdir(), 'bie-obligation-scheduler-'));
  let omitA = false;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/oracle?')) {
      oracle.push(new URL(req.url, 'http://fixture').searchParams.get('event')!); res.writeHead(204); res.end(); return;
    }
    res.setHeader('Content-Type', 'text/html');
    const targets = `${omitA ? '' : kind === 'many' ? [1, 2, 3, 4].map(n => `<button id="target-a${n}" type="button" onclick="record('A${n}');this.disabled=true">Target A${n}</button>`).join('') : '<button id="target-a" type="button" onclick="record(\'A\');this.disabled=true">Target A</button>'}
      <button id="target-b" type="button" onclick="record('B');this.disabled=true">Target B</button>`;
    const body = req.url === '/away' ? '<p>Away</p>' : kind === 'modes'
      ? `<form id="settings"><select id="mode" aria-label="Mode" hidden><option>A</option><option>B</option></select></form><form id="commands"><button id="run" type="button" onclick="const m=document.querySelector('#mode');record(m.value);m.value=m.value==='A'?'B':'A'">Run</button></form>`
      : kind === 'nested'
      ? `<details id="outer"><summary>Outer</summary><details id="inner"><summary>Inner</summary>${targets}</details></details>`
      : kind === 'modal' ? `<button id="open" type="button" onclick="record('entry');document.querySelector('#panel').showModal()">Open panel</button><dialog id="panel" aria-label="Panel">${targets}<form method="dialog"><button>Close</button></form></dialog>`
      : targets;
    res.end(`<!doctype html><title>Durable obligations</title><main>${body}</main>
      <form><label>Quote<input readonly id="quote" value="100"></label></form>
      <script>function record(event){const r=new XMLHttpRequest();r.open('POST','/oracle?event='+event,false);r.send();}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const hostPath = join(directory, 'engine'), pluginPath = join(directory, 'plugin.sqlite'), providers = fakeProviders(url);
  let host = new BrowserEngine({ persistence: new SqliteStore(hostPath) });
  let plugin = new ExplorerPlugin(host, new ExplorerStore(pluginPath), providers);
  cleanup.push(async () => { await plugin.close(); await host.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  const options = { url, headless: true, exploration: 'controls' as const, executionPolicy: 'interface-only' as const,
    settleMs: 0, observeTimeoutMs: 1000, actionTimeoutMs: 2000, contextRules: [], listExploration: 'all' as const,
    pageExploration: 'all' as const, regionExploration: 'off' as const, interfaceActions: [{ kind: 'click' }],
    replayable: [{ stableKey: 'id:open' }], maxActions: 20, maxDurationMs: 60000 };
  const session = await host.createSession(options), sid = session.id;
  const find = (name: string, source = host.observation(sid)) => {
    const actions = host.actions(sid, source.id).filter(a => a.kind === 'click' && a.label === name);
    expect(actions, name).toHaveLength(1); return actions[0];
  };
  const setupRecords: { before: Observation; after: Observation; action: ActionCandidate; attempt: ActionAttempt }[] = [];
  const setup = async (name: string) => {
    const action = find(name), before = host.observation(sid);
    const attempt = await host.execute(sid, action.id, crypto.randomUUID());
    expect(attempt.status).toBe('succeeded');
    const record = { before, after: host.observation(sid), action, attempt }; setupRecords.push(record); return record;
  };
  if (kind === 'nested') { await setup('Outer'); await setup('Inner'); }
  if (kind === 'modal') await setup('Open panel');
  const source = host.observation(sid), a = find(kind === 'modes' ? 'Run' : kind === 'many' ? 'Target A1' : 'Target A', source), b = kind === 'modes' ? a : find('Target B', source);
  const checkpoint = await host.createCheckpoint(sid, 'Retained pending targets');
  const seed = (scopes: Scope[], sources = true) => {
    const created = plugin.create({ url, budget: { rounds: 1, actions: 12, durationMs: 30000, modelRequests: 8 }, sessionOptions: { headless: true, executionPolicy: 'interface-only', settleMs: 0, observeTimeoutMs: 1000, actionTimeoutMs: 2000, maxActions: 20 } });
    plugin.revise(created.id, { items: scopes.map((scope, i) => ({ title: `Requested ${i}`, scope, prerequisites: [],
      completion: 'Actual fixture event for the requested branch', required: true, reason: 'User-selected recorded scope' })) });
    const task = plugin.store.task(created.id);
    if (sources) for (const item of task.plan) item.evidence = [{ sessionId: sid, observationId: source.id }];
    const round: Round = { id: crypto.randomUUID(), number: 1, sessionId: sid, startedAt: new Date().toISOString(), status: 'paused',
      actions: host.session(sid).actionCount, policyVersion: POLICY_VERSION, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 };
    task.rounds = [round]; task.usage.rounds = 1; task.usage.actions = round.actions; task.status = 'paused'; plugin.store.save(task);
    return task;
  };
  return { url, sid, source, a, b, checkpoint, oracle, providers, options, seed, setup, find, setupRecords,
    omitA() { omitA = true; },
    get host() { return host; }, get plugin() { return plugin; },
    async away() { await pageOf(host).goto(`${url}away`); await host.observe(sid); },
    async coldRestart() { await plugin.close(); await host.close(); host = new BrowserEngine({ persistence: new SqliteStore(hostPath) }); plugin = new ExplorerPlugin(host, new ExplorerStore(pluginPath), providers); },
    async run(id: string) { plugin.start(id); await plugin.waitForIdle(); return plugin.view(id); },
  };
}

it('recovers a retained concrete obligation and actually executes it when the same-session traversal stack is empty', async () => {
  const f = await fixture(), task = f.seed([scopeFor(f.b, f.source)]);
  await f.away();
  expect(f.plugin.view(task.id).task.rounds[0].stack).toEqual([]);
  expect(f.host.list(f.sid, 'checkpoint')).toHaveLength(1);
  const result = await f.run(task.id);
  expect(f.oracle, JSON.stringify({ status: result.task.status, reason: result.task.reason, events: result.events.filter(e => e.type.includes('recovery') || e.type.includes('obligation')) })).toEqual(['B']);
  const item = result.task.plan.find(i => i.id === task.plan[0].id)!;
  expect(item.status).toBe('succeeded'); expect(item.resolvedBy?.attemptId).toBeTruthy();
  const actual = f.host.list<ActionAttempt>(f.sid, 'attempt').find(a => a.id === item.resolvedBy?.attemptId)!;
  expect(actual).toMatchObject({ status: 'succeeded', action: { label: 'Target B' } });
  expect(result.events.some(e => e.type === 'recovery.selected')).toBe(true);
  expect(f.providers.calls).toEqual([]);
});

it('returns to an accepted broad root for fresh discovery even with no concrete pending item and an empty stack', async () => {
  const f = await fixture(), task = f.seed([{ url: f.url }], false);
  await f.away();
  const result = await f.run(task.id);
  expect(f.oracle, JSON.stringify({ status: result.task.status, reason: result.task.reason })).toEqual(['A', 'B']);
  expect(result.task.plan.some(i => i.status === 'succeeded' && i.resolvedBy?.attemptId)).toBe(true);
  expect(f.host.list<ActionAttempt>(f.sid, 'attempt').filter(a => a.status === 'succeeded' && a.purpose !== 'recovery').map(a => a.action.label)).toEqual(['Target A', 'Target B']);
});

it('a failed historical target does not starve another reachable obligation or turn the failed target into coverage', async () => {
  const f = await fixture(), task = f.seed([scopeFor(f.a, f.source), scopeFor(f.b, f.source)]);
  f.omitA(); await f.away();
  const restore = f.host.reachExplorationTarget.bind(f.host), selections: string[][] = [];
  vi.spyOn(f.host, 'reachExplorationTarget').mockImplementation(async (sid, request) => {
    selections.push(request.actionIds);
    if (request.actionIds.includes(f.a.id)) {
      // Explicit unreachable injection: no browser mutation and no invented
      // positive result. B uses the real SDK to restore and dispatch.
      const actual = f.host.observation(sid);
      return { id: crypto.randomUUID(), sessionId: sid, checkpointId: request.checkpointId,
        status: 'UNREACHABLE', reason: 'fixture_target_a_route_unavailable', checks: [], attemptIds: [], observationId: actual.id,
        targetObservationId: request.observationId, targetActionIds: request.actionIds, matchedActionIds: [], matches: [],
        checkpointVerified: false, currentExecution: false, executionAuthorized: false,
        remainingFrontier: f.host.getFrontier(sid).length, diagnostics: { strategies: [], dirtyActions: [], resetAvailable: false, unassessedEffectAttemptIds: [] } };
    }
    return restore(sid, request);
  });
  const result = await f.run(task.id);
  expect(f.oracle, JSON.stringify({ selections, status: result.task.status, reason: result.task.reason })).toEqual(['B']);
  expect(selections.some(ids => ids.includes(f.a.id))).toBe(true);
  expect(selections.some(ids => ids.includes(f.b.id) && !ids.includes(f.a.id))).toBe(true);
  const a = result.task.plan.find(i => i.id === task.plan[0].id)!, b = result.task.plan.find(i => i.id === task.plan[1].id)!;
  expect(a.status).not.toBe('succeeded'); expect(a.resolvedBy).toBeUndefined(); expect(a.attempts).toEqual([]);
  expect(b.status).toBe('succeeded'); expect(b.resolvedBy?.attemptId).toBeTruthy();
});

it.each(['nested', 'modal'] as const)('uses necessary %s reentry to execute retained work after losing the traversal stack', async kind => {
  const f = await fixture(kind), task = f.seed([scopeFor(f.b, f.source)]), before = [...f.oracle];
  await f.away();
  const result = await f.run(task.id);
  expect(f.oracle.slice(before.length), JSON.stringify({ status: result.task.status, reason: result.task.reason })).toEqual(kind === 'modal' ? ['entry', 'B'] : ['B']);
  expect(result.task.plan.find(i => i.id === task.plan[0].id)?.status).toBe('succeeded');
  const recovery = f.host.list<ActionAttempt>(f.sid, 'attempt').filter(a => a.purpose === 'recovery');
  expect(recovery.filter(a => a.action.label === (kind === 'modal' ? 'Open panel' : 'Outer'))).toHaveLength(1);
  if (kind === 'nested') expect(recovery.filter(a => a.action.label === 'Inner')).toHaveLength(1);
  expect(recovery.every(a => a.status === 'succeeded')).toBe(true);
});

it('resumes retained nested work after actually closing the host and reopening the same SQLite session', async () => {
  const f = await fixture('nested'), task = f.seed([scopeFor(f.b, f.source)]);
  await f.coldRestart();
  expect(f.host.session(f.sid).id).toBe(f.sid);
  expect(f.plugin.view(task.id).task.rounds[0].stack).toEqual([]);
  const result = await f.run(task.id);
  expect(f.oracle, JSON.stringify({ status: result.task.status, reason: result.task.reason })).toEqual(['B']);
  expect(result.task.rounds).toHaveLength(1);
  expect(result.task.rounds[0].sessionId).toBe(f.sid);
  expect(result.task.plan.find(i => i.id === task.plan[0].id)?.resolvedBy?.sessionId).toBe(f.sid);
  expect(result.events.some(e => e.type === 'round.reattached')).toBe(true);
});

it('uses retained verified entry routes in a genuinely new round/session, never an old-session checkpoint', async () => {
  const f = await fixture('nested'), task = f.seed([scopeFor(f.b, f.source)]), target = task.plan[0];
  target.prerequisites = f.setupRecords.map(r => scopeFor(r.action, r.before));
  task.rounds[0].entryRoutes = f.setupRecords.map(r => {
    const transition = f.host.interactionTransition(f.sid, r.before.id, r.after.id);
    expect(transition.verified).toBe(true);
    const route = capturedRoute(scopeFor(r.action, r.before), r.before, r.after, transition.revealedControlIds, r.attempt);
    expect(route).toBeDefined(); return route!;
  });
  for (const r of f.setupRecords) task.plan.push({ id: `entry-${r.attempt.id}`, title: r.action.label,
    scope: scopeFor(r.action, r.before), prerequisites: [], completion: 'Actual recorded entry', required: true,
    dispatchScope: false, status: 'succeeded', reason: 'observed_in_scope', evidence: [{ sessionId: f.sid, observationId: r.before.id }],
    resolvedBy: { sessionId: f.sid, observationId: r.after.id, attemptId: r.attempt.id },
    attempts: [{ roundId: task.rounds[0].id, outcome: 'succeeded', evidence: { sessionId: f.sid, observationId: r.after.id, attemptId: r.attempt.id } }] });
  task.rounds[0].status = 'finished'; task.rounds[0].endedAt = new Date().toISOString(); task.budget.rounds = 2;
  f.plugin.store.save(task); await f.coldRestart();
  const reachCheckpoint = vi.spyOn(f.host, 'reachCheckpoint'), reachTarget = vi.spyOn(f.host, 'reachExplorationTarget');
  const result = await f.run(task.id);
  expect(f.oracle, JSON.stringify({ status: result.task.status, reason: result.task.reason })).toEqual(['B']);
  expect(result.task.rounds).toHaveLength(2);
  const sid = result.task.rounds[1].sessionId; expect(sid).not.toBe(f.sid);
  expect(result.task.plan.find(i => i.id === target.id)?.resolvedBy?.sessionId).toBe(sid);
  expect(reachCheckpoint.mock.calls.every(([session, cp]) => session !== sid || cp !== f.checkpoint.id)).toBe(true);
  expect(reachTarget.mock.calls.every(([session, request]) => session !== sid || request.checkpointId !== f.checkpoint.id)).toBe(true);
  expect(f.host.list<ActionAttempt>(sid, 'attempt').filter(a => ['Outer', 'Inner'].includes(a.action.label)).map(a => a.action.label)).toEqual(['Outer', 'Inner']);
});

it('does not end a round after three failed selections while a fifth recorded obligation remains reachable', async () => {
  const f = await fixture('many'), failures = [1, 2, 3, 4].map(n => f.find(`Target A${n}`, f.source));
  const task = f.seed([...failures.map(a => scopeFor(a, f.source)), scopeFor(f.b, f.source)]);
  f.omitA(); await f.away();
  const restore = f.host.reachExplorationTarget.bind(f.host), attempted: string[] = [];
  vi.spyOn(f.host, 'reachExplorationTarget').mockImplementation(async (sid, request) => {
    const failure = failures.find(a => request.actionIds.includes(a.id));
    if (!failure) return restore(sid, request);
    attempted.push(failure.id); const actual = f.host.observation(sid);
    return { id: crypto.randomUUID(), sessionId: sid, checkpointId: request.checkpointId,
      status: 'UNREACHABLE', reason: 'fixture_distinct_route_unavailable', checks: [], attemptIds: [], observationId: actual.id,
      targetObservationId: request.observationId, targetActionIds: request.actionIds, matchedActionIds: [], matches: [],
      checkpointVerified: false, currentExecution: false, executionAuthorized: false,
      remainingFrontier: f.host.getFrontier(sid).length, diagnostics: { strategies: [], dirtyActions: [], resetAvailable: false, unassessedEffectAttemptIds: [] } };
  });
  const result = await f.run(task.id);
  expect(f.oracle, JSON.stringify({ attempted, status: result.task.status, reason: result.task.reason })).toEqual(['B']);
  expect(new Set(attempted).size).toBe(4);
  for (const item of result.task.plan.filter(i => task.plan.slice(0, 4).some(old => old.id === i.id))) {
    expect(item.status).not.toBe('succeeded'); expect(item.resolvedBy).toBeUndefined(); expect(item.attempts).toEqual([]);
  }
});

it('schedules split A/B source conditions independently after losing the stack and never requeues the superseded parent', async () => {
  const f = await fixture('modes'), a = f.a, sourceA = f.source;
  await pageOf(f.host).locator('#mode').evaluate((mode: HTMLSelectElement) => { mode.value = 'B'; });
  const sourceB = await f.host.observe(f.sid), b = f.find('Run', sourceB);
  await f.host.createCheckpoint(f.sid, 'Retained B condition');
  expect(browserOperationKey(a, sourceA)).not.toBe(browserOperationKey(b, sourceB));
  // Independently frozen v1 operation key: this fixture's hidden cross-form
  // selector did not contribute to the legacy source condition projection.
  const c = sourceA.controls.find(c => c.localId === a.localId)!, region = sourceA.regions.find(r => r.key === c.region), context = c.identityContext;
  const oldKey = hash({ scope: { url: sourceA.url, ...(region ? { region: region.label } : {}), label: a.label,
    role: c.role, stableKey: c.stableKey, kind: a.kind }, context: sourceA.context,
    targetBinding: { context: { scope: context?.scope, binding: context?.binding }, form: formBinding(c) } });
  const task = f.seed([{ url: f.url, kind: 'click' }]), parent: PlanItem = {
    id: 'retained-unattempted-parent', title: 'Retained Run modes', scope: scopeFor(a, sourceA), prerequisites: [],
    completion: 'Actual execution of retained conditions', required: true, dispatchScope: false, status: 'pending',
    reason: 'observed_in_scope', operationConditionKey: oldKey,
    evidence: [{ sessionId: f.sid, observationId: sourceA.id }, { sessionId: f.sid, observationId: sourceB.id }], attempts: [],
  };
  task.plan.push(parent); f.plugin.store.save(task); await f.away();
  const result = await f.run(task.id);
  expect(f.oracle, JSON.stringify({ status: result.task.status, reason: result.task.reason })).toEqual(['A', 'B']);
  const historical = result.task.plan.find(i => i.id === parent.id)!;
  expect(historical).toMatchObject({ status: 'superseded', attempts: [], evidence: parent.evidence });
  expect(historical.resolvedBy).toBeUndefined(); expect(historical.coverageResolvedBy).toBeUndefined();
  const children = result.task.plan.filter(i => i.conditionLineage?.parentItemId === parent.id && i.conditionLineage.kind === 'condition');
  expect(children).toHaveLength(2);
  expect(new Set(children.map(i => i.operationConditionKey))).toEqual(new Set([browserOperationKey(a, sourceA), browserOperationKey(b, sourceB)]));
  const attempts = f.host.list<ActionAttempt>(f.sid, 'attempt');
  for (const child of children) {
    expect(child.status).toBe('succeeded'); expect(child.attempts).toHaveLength(1);
    const attempt = attempts.find(a => a.id === child.resolvedBy?.attemptId)!;
    expect(browserOperationKey(attempt.action, f.host.observation(f.sid, attempt.beforeId))).toBe(child.operationConditionKey);
  }
  expect(result.events.filter(e => e.type === 'obligation.selected').every(e => (e.data as { itemId?: string }).itemId !== parent.id)).toBe(true);
});

it.each(['nested', 'modal'] as const)('recovers a same-page hidden %s target using retained work even though the traversal stack is empty', async kind => {
  const f = await fixture(kind), task = f.seed([scopeFor(f.b, f.source)]), before = [...f.oracle];
  if (kind === 'modal') await pageOf(f.host).locator('#panel').evaluate((panel: HTMLDialogElement) => panel.close());
  else await pageOf(f.host).evaluate(() => {
    document.querySelector<HTMLDetailsElement>('#inner')!.open = false;
    document.querySelector<HTMLDetailsElement>('#outer')!.open = false;
  });
  const current = await f.host.observe(f.sid);
  expect(current.url).toBe(f.source.url);
  expect(current.controls.find(c => c.stableKey === 'id:target-b')?.visible).toBe(false);
  expect(f.plugin.view(task.id).task.rounds[0].stack).toEqual([]);
  const result = await f.run(task.id);
  expect(f.oracle.slice(before.length), JSON.stringify({ status: result.task.status, reason: result.task.reason })).toEqual(kind === 'modal' ? ['entry', 'B'] : ['B']);
  expect(result.task.plan.find(i => i.id === task.plan[0].id)?.status).toBe('succeeded');
  expect(result.events.some(e => e.type === 'recovery.selected')).toBe(true);
});
