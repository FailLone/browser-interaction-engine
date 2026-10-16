import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { BrowserEngine, type ActionAttempt, type ActionCandidate, type Observation } from '@interaction/browser';
import { hash } from '@interaction/core';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin, ExplorerStore, type PlanItem, type Round } from '@interaction/explorer-plugin';
import { browserOperationKey } from '../packages/adapter-playwright/src/exploration.js';
import { formBinding } from '../packages/adapter-playwright/src/util.js';
import { migrateOperationConditions, scopeFor } from '../packages/explorer-plugin/src/policy.js';
import { completedOperations } from '../packages/explorer-plugin/src/completion-evidence.js';
import { projectObligations } from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import { POLICY_VERSION } from '../packages/explorer-plugin/src/decision-policy.js';
import { fakeProviders } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';

/** Independent frozen v1 encoding for this fixture: the cross-form hidden
 * selector was omitted. Do not use a new decoder to manufacture its own input. */
function originalKey(action: ActionCandidate, observation: Observation) {
  const c = observation.controls.find(c => c.localId === action.localId)!;
  const r = observation.regions.find(r => r.key === c.region), context = c.identityContext;
  return hash({ scope: { url: observation.url, ...(r ? { region: r.label } : {}), label: action.label,
    role: c.role, stableKey: c.stableKey, kind: action.kind }, context: observation.context,
    targetBinding: { context: { scope: context?.scope, binding: context?.binding }, form: formBinding(c) } });
}
// Structural reads keep this same test executable against the pre-split commit.
// No import of a new-only helper/type may turn the red baseline into a load error.
const lineage = (item: PlanItem) => (item as PlanItem & { conditionLineage?: {
  parentItemId: string; policy: string; kind: 'condition' | 'unverified-source'; fromKey: string;
} }).conditionLineage;

async function fixture() {
  const oracle: string[] = [], directory = mkdtempSync(join(tmpdir(), 'bie-split-cold-review-'));
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/oracle?')) {
      oracle.push(new URL(req.url, 'http://fixture').searchParams.get('branch')!); res.writeHead(204); res.end(); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><title>Retained mode split</title></head><body>
      <form id="settings"><select id="mode" aria-label="Mode" hidden><option value="A">A</option><option value="B">B</option></select></form>
      <form id="commands"><button id="run" type="button" onclick="const m=document.querySelector('#mode');record(m.value);m.value=m.value==='A'?'B':'A'">Run</button></form>
      <script>function record(branch){const r=new XMLHttpRequest();r.open('POST','/oracle?branch='+branch,false);r.send();}</script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`, providers = fakeProviders(url);
  const hostPath = join(directory, 'engine'), pluginPath = join(directory, 'plugin.sqlite');
  let host = new BrowserEngine({ persistence: new SqliteStore(hostPath) });
  let plugin = new ExplorerPlugin(host, new ExplorerStore(pluginPath), providers), hostCloses = 0;
  const session = await host.createSession({ url, headless: true, exploration: 'controls', executionPolicy: 'interface-only',
    settleMs: 0, observeTimeoutMs: 1000, actionTimeoutMs: 2000, contextRules: [], regionExploration: 'off',
    pageExploration: 'all', listExploration: 'all', interfaceActions: [{ kind: 'click' }] });
  const sid = session.id;
  const action = (o = host.observation(sid)) => host.actions(sid, o.id).find(a => a.kind === 'click' && a.label === 'Run')!;
  const a = host.observation(sid), actionA = action(a);
  await pageOf(host).evaluate(() => { document.querySelector<HTMLSelectElement>('#mode')!.value = 'B'; });
  const b = await host.observe(sid), actionB = action(b);
  await pageOf(host).evaluate(() => { document.querySelector<HTMLSelectElement>('#mode')!.value = 'A'; });
  await host.observe(sid);
  const created = plugin.create({ url, budget: { rounds: 1, actions: 8, durationMs: 60000, modelRequests: 8 },
    sessionOptions: { executionPolicy: 'interface-only', headless: true, settleMs: 0, observeTimeoutMs: 1000 } });
  plugin.revise(created.id, { items: [{ title: 'Encountered click modes', scope: { url, kind: 'click' }, prerequisites: [],
    completion: 'Actual events for retained mode branches', required: true, reason: 'Explicit fixture scope' }] });
  const task = plugin.store.task(created.id), parent: PlanItem = { id: 'retained-coarse-row', title: 'Run', scope: scopeFor(actionA, a),
    prerequisites: [], completion: 'Execute the encountered Run branches', required: true, dispatchScope: false,
    status: 'pending', reason: 'observed_in_scope', operationConditionKey: originalKey(actionA, a),
    evidence: [{ sessionId: sid, observationId: a.id }, { sessionId: sid, observationId: b.id }, { sessionId: sid, observationId: a.id }], attempts: [] };
  expect(originalKey(actionB, b)).toBe(parent.operationConditionKey);
  expect(browserOperationKey(actionA, a)).not.toBe(browserOperationKey(actionB, b));
  const round: Round = { id: 'retained-round', number: 1, sessionId: sid, startedAt: new Date().toISOString(), status: 'paused',
    actions: 0, policyVersion: POLICY_VERSION, stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 };
  task.rounds = [round]; task.usage.rounds = 1; task.status = 'paused'; task.plan.push(parent); plugin.store.save(task);
  return { url, sid, oracle, providers, a, b, actionA, actionB, task, parent, action,
    get host() { return host; }, get plugin() { return plugin; }, get hostCloses() { return hostCloses; },
    async coldRestart() {
      await plugin.close(); await host.close(); hostCloses++;
      host = new BrowserEngine({ persistence: new SqliteStore(hostPath) });
      plugin = new ExplorerPlugin(host, new ExplorerStore(pluginPath), providers);
    },
    async close() {
      await plugin.close(); await host.close(); await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    } };
}

it('cold restart splits one retained A/B hint into pending work, executes both real branches, and never turns the parent into success', async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.parent), sourceKeys = new Set([browserOperationKey(f.actionA, f.a), browserOperationKey(f.actionB, f.b)]);
    expect(f.oracle).toEqual([]); await f.coldRestart(); expect(f.hostCloses).toBe(1);
    expect(f.plugin.view(f.task.id).task.plan.find(i => i.id === original.id)).toEqual(original);
    const execute = f.host.execute.bind(f.host), firstDispatch: PlanItem[][] = [];
    vi.spyOn(f.host, 'execute').mockImplementation(async (...args) => {
      firstDispatch.push(structuredClone(f.plugin.view(f.task.id).task.plan)); return execute(...args);
    });
    f.plugin.start(f.task.id); await f.plugin.waitForIdle();
    const view = f.plugin.view(f.task.id), migrated = firstDispatch[0], beforeParent = migrated.find(i => i.id === original.id)!;
    expect(beforeParent).toMatchObject({ status: 'superseded', attempts: [], evidence: original.evidence });
    expect(beforeParent.resolvedBy).toBeUndefined(); expect(beforeParent.coverageResolvedBy).toBeUndefined();
    const children = migrated.filter(i => lineage(i)?.parentItemId === original.id && lineage(i)?.kind === 'condition');
    expect(children).toHaveLength(2);
    expect(new Set(children.map(i => i.operationConditionKey))).toEqual(sourceKeys);
    expect(children.every(i => lineage(i)?.policy === 'operation-condition-split-v1' && lineage(i)?.fromKey === original.operationConditionKey)).toBe(true);
    expect(children.every(i => i.status === 'pending' && !i.attempts.length && !i.resolvedBy && !i.coverageResolvedBy)).toBe(true);
    expect(f.oracle).toEqual(['A', 'B']);
    expect(view.task.status).toBe('completed');
    const finalParent = view.task.plan.find(i => i.id === original.id)!;
    expect(finalParent).toEqual(beforeParent);
    expect(view.task.plan.filter(i => children.some(c => c.id === i.id)).every(i => i.status === 'succeeded' && i.resolvedBy?.attemptId)).toBe(true);
    expect(view.task.obligations?.entries.find(i => i.itemId === original.id)?.state).toBe('superseded');
    expect(f.host.list<ActionAttempt>(f.sid, 'attempt').map(a => a.status)).toEqual(['succeeded', 'succeeded']);
    expect(f.providers.calls).toEqual([]);
    await f.coldRestart();
    const restored = f.plugin.view(f.task.id).task, retained = structuredClone(restored.plan);
    expect(migrateOperationConditions(restored, f.host)).toEqual([]);
    expect(restored.plan).toEqual(retained); expect(f.oracle).toEqual(['A', 'B']);
  } finally { await f.close(); }
});

it.each(['missing', 'unknown-context'] as const)('keeps the %s part of a retained A/B source set unresolved instead of dropping it during split', async kind => {
  const f = await fixture();
  try {
    const invalidRef = { sessionId: f.sid, observationId: `${kind}-source` };
    f.parent.evidence.splice(1, 0, invalidRef);
    const task = { plan: [f.parent] }, original = structuredClone(f.parent);
    const sourceHost = { observation: (sid: string, oid?: string) => {
      if (oid === invalidRef.observationId) {
        if (kind === 'missing') throw Error('Retained source missing');
        return { ...structuredClone(f.a), id: oid, context: { mode: { status: 'unknown' as const, value: null, source: 'independent fault' } } };
      }
      return f.host.observation(sid, oid);
    }, actions: (sid: string, oid?: string) => oid === invalidRef.observationId ? [{ ...f.actionA, observationId: oid }] : f.host.actions(sid, oid) };
    migrateOperationConditions(task, sourceHost);
    const children = task.plan.filter(i => lineage(i)?.parentItemId === original.id);
    expect(children.filter(i => lineage(i)?.kind === 'condition')).toHaveLength(2);
    const residual = children.filter(i => lineage(i)?.kind === 'unverified-source');
    expect(residual).toHaveLength(1);
    expect(residual[0]).toMatchObject({ required: true, dispatchScope: false, status: 'blocked', evidence: [invalidRef], attempts: [] });
    expect(residual[0].reason).toMatch(/^condition_policy_invalidated:/);
    expect(task.plan.some(i => i.required && ['pending', 'unresolved', 'blocked'].includes(i.status)
      && i.evidence.some(ref => ref.observationId === invalidRef.observationId))).toBe(true);
    expect(task.plan.every(i => i.status !== 'succeeded' && !i.resolvedBy && !i.coverageResolvedBy && !i.attempts.length)).toBe(true);
    const parent = task.plan.find(i => i.id === original.id)!;
    expect(parent.evidence).toEqual(original.evidence);
    expect(completedOperations(f.host, { ...f.task, plan: task.plan }, f.a, [f.actionA]).size).toBe(0);
    const projection = projectObligations(sourceHost, task, f.a, [f.actionA]).projection;
    expect(projection.counts.unresolved).toBeGreaterThan(0);
    const once = structuredClone(task.plan); expect(migrateOperationConditions(task, sourceHost)).toEqual([]); expect(task.plan).toEqual(once);
    expect(f.oracle).toEqual([]);
  } finally { await f.close(); }
});

it('a durable unknown recovery blocks a cold restart before splitting hints or creating a replacement browser session', async () => {
  const f = await fixture();
  try {
    const attempt = await f.host.execute(f.sid, f.action().id, 'independent-unknown-fault');
    f.host.store.put('attempt', { ...attempt, purpose: 'recovery', status: 'unknown', reason: 'Independent retained-result fault' });
    const original = structuredClone(f.plugin.view(f.task.id).task.plan); await f.coldRestart();
    const observe = vi.spyOn(f.host, 'observe'), create = vi.spyOn(f.host, 'createSession'), execute = vi.spyOn(f.host, 'execute');
    f.plugin.start(f.task.id); await f.plugin.waitForIdle();
    const view = f.plugin.view(f.task.id);
    expect(view.task).toMatchObject({ status: 'blocked', reason: 'UNKNOWN_DISPATCH_REQUIRES_REVIEW' });
    expect(view.task.plan.filter(i => original.some(old => old.id === i.id))).toEqual(original);
    const added = view.task.plan.filter(i => !original.some(old => old.id === i.id));
    expect(added.every(i => i.required && i.dispatchScope === false && i.status !== 'succeeded'
      && ['UNKNOWN_DISPATCH_REQUIRES_REVIEW', 'unknown_action_outcome'].includes(i.reason)
      && !lineage(i) && !i.resolvedBy && !i.coverageResolvedBy)).toBe(true);
    expect(view.task.plan.every(i => !lineage(i))).toBe(true);
    expect(view.events.some(e => e.type === 'operation.conditions_migrated')).toBe(false);
    expect(observe).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(f.host.list<ActionAttempt>(f.sid, 'attempt').find(a => a.id === attempt.id)?.status).toBe('unknown');
    expect(f.oracle).toEqual(['A']);
  } finally { await f.close(); }
});

it('a split with a child silently made optional is reopened as a required accounting gap', async () => {
  const f = await fixture();
  try {
    const task = { plan: [f.parent] };
    migrateOperationConditions(task, f.host);
    const children = task.plan.filter(i => lineage(i)?.parentItemId === f.parent.id);
    expect(children).toHaveLength(2);
    // Simulate an incomplete/corrupt retained ledger, not a user exclusion.
    // There is no plan revision or permission to abandon this source branch.
    children[0].required = false;
    migrateOperationConditions(task, f.host);
    expect(f.parent.required).toBe(true);
    expect(f.parent.status).toBe('blocked');
    expect(f.parent.reason).toMatch(/^condition_split_invalid:/);
    expect(f.parent.resolvedBy).toBeUndefined(); expect(f.parent.coverageResolvedBy).toBeUndefined();
    expect(f.oracle).toEqual([]);
    const retained = structuredClone(task.plan);
    expect(migrateOperationConditions(task, f.host)).toEqual([]); expect(task.plan).toEqual(retained);
  } finally { await f.close(); }
});
