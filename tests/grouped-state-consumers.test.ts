import { expect, it, vi } from 'vitest';
import { contextKey, type ExplorationGroup } from '@interaction/core';
import { EngineError, withFrontierStates, type BrowserFrontierCoverageGroup, type FrontierItemView, type Observation, type Session } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { ExplorerPlugin, ExplorerStore, type Round, type Task } from '@interaction/explorer-plugin';
import { PageExploration } from '../packages/browser/src/page-exploration.js';
import { referenceFor, sameObservedSummary, stateDifferences } from '../apps/ui/src/frontier-comparison.js';
import { explorerFixture, fakeProviders } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';

function observation(id: string, value: string): Observation {
  return { id, sessionId: 'session', stateId: 'shared-graph-group', ruleVersion: 'observable-v7', canonical: `strict:${value}`, fingerprint: `fingerprint:${value}`,
    capturedAt: '2026-10-16T00:00:00.000Z', title: 'Fixture', text: '', viewport: { width: 800, height: 600 }, documentId: 'doc', instanceScope: 'doc', visitId: `visit:${id}`, cause: 'inspection', regions: [],
    url: 'https://fixture.test/child', context: {}, gaps: [], stable: true, scroll: { x: 0, y: 0, maxY: 0 }, controls: [{
      localId: 'price', instanceId: 'price-node', identityId: 'price', name: 'Price', label: 'Price', tag: 'input', role: 'textbox', actions: ['fill'], value,
      region: 'document', form: '', selector: '#price', rect: { x: 0, y: 0, width: 100, height: 20 }, displayedText: '', controls: null, options: [], discovery: ['native-input'],
      visible: true, enabled: true, editable: true, checked: null, expanded: null, selected: [], constraints: { type: 'text', required: false, valid: true },
      actionable: { visible: true, enabled: true, editable: true, hitTarget: true, unknown: [] },
    }] };
}
function item(id: string, source: Observation, status: FrontierItemView['status'] = 'pending'): FrontierItemView {
  return { id, sessionId: source.sessionId, stateId: source.stateId, depth: 0, status,
    action: { observationId: source.id, stateId: source.stateId, kind: 'fill', value: 'sample', preconditions: { context: {} } },
    explorationGroups: [{ groupId: 'page', memberKey: 'member' }] } as FrontierItemView;
}

it('retains distinct historical facts and comparison references within one graph group', () => {
  const before = observation('before', '100'), current = observation('current', '200');
  const a = item('old-success', before, 'executed'), b = item('new-success', current, 'executed'), pending = item('pending', current);
  const read = vi.fn((id: string) => [before, current].find(o => o.id === id));
  const [group] = withFrontierStates([{ items: [a, b, pending] } as BrowserFrontierCoverageGroup], read);
  expect(group.states.map(s => [s.stateId, s.observationId])).toEqual([[before.stateId, before.id], [current.stateId, current.id]]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(sameObservedSummary(group.states[0], group.states[1])).toBe(false);
  expect(stateDifferences(group.states[0], group.states[1])).toContainEqual({ key: 'price:value', label: 'Price', field: 'value', before: '100', after: '200' });
  expect(referenceFor(group, pending, 'auto')?.id).toBe('new-success');
  expect(referenceFor(group, pending, 'old-success')?.id).toBe('old-success');
});

it('summary equality requires complete strict facts, even across legacy and grouped state IDs', () => {
  const before = observation('before', '100'), equal = { ...before, id: 'equal', stateId: 'legacy-exact-state' };
  const incomplete = { ...before, id: 'incomplete', gaps: [{ code: 'partial', message: 'Missing facts', critical: true }] };
  const sources = [before, equal, incomplete];
  const [group] = withFrontierStates([{ items: sources.map(o => item(o.id, o)) } as BrowserFrontierCoverageGroup], id => sources.find(o => o.id === id));
  expect(group.states).toHaveLength(3);
  expect(sameObservedSummary(group.states[0], group.states[1])).toBe(true);
  expect(sameObservedSummary(group.states[0], group.states[2])).toBe(false);
  expect(group.states[2].strictObservationKey).toBeUndefined();
});

it('does not substitute a different observation from the same graph group for missing history', () => {
  const before = observation('before', '100'), current = observation('current', '200');
  const [group] = withFrontierStates([{ items: [item('pending', before)] } as BrowserFrontierCoverageGroup], () => current);
  expect(group.states).toEqual([{ stateId: before.stateId, observationId: before.id, status: 'unavailable', facts: [] }]);
});

it('page traversal treats only a verified historical observation as current local work', () => {
  const store = new MemoryStore(), pages = new PageExploration(store), before = observation('before', '100'), current = observation('current', '200');
  store.put('observation', before); store.put('observation', current);
  store.put('page-exploration', { id: 'session:page-exploration', sessionId: 'session', rootUrl: 'https://fixture.test/', frames: [] });
  const session = { options: { pageExploration: 'review', maxDepth: 10 } } as Session;
  store.put('exploration-group', { id: 'page', sessionId: 'session', kind: 'page', binding: 'context', proposalKey: `page:${current.url}`, contextKey: contextKey({}), status: 'decided',
    decisions: [{ revision: 1, at: '', decision: { mode: 'sample', memberKeys: ['member'], source: 'test', evidence: ['Explicitly accepted sample'] } }] } as ExplorationGroup);
  const historical = item('historical', before), local = item('local', current);
  expect(pages.shouldReturn(current, session, () => [historical])).toBe(true);
  expect(pages.shouldReturn(current, session, () => [local])).toBe(false);
  expect(pages.candidates([historical, local], current, session).map(f => f.id)).toEqual(['local']);
  // Returning to exactly the same facts reuses work, regardless of group IDs.
  const equivalent = { ...current, id: 'equivalent', stateId: 'legacy-exact-state' }; store.put('observation', equivalent);
  expect(pages.candidates([historical, item('equivalent', equivalent)], current, session).map(f => f.id)).toEqual(['equivalent']);
  const incomplete = { ...current, id: 'incomplete', gaps: [{ code: 'partial', message: 'Missing facts', critical: true }] }; store.put('observation', incomplete);
  expect(pages.shouldReturn(current, session, () => [item('incomplete', incomplete)])).toBe(true);
});

const options = { headless: true, exploration: 'controls', settleMs: 0, observeTimeoutMs: 1000,
  regionExploration: 'off', pageExploration: 'all', listExploration: 'all', interfaceActions: [{ kind: 'click' }] };
async function runtimeFixture() {
  const f = await explorerFixture('<button id="run" type="button" onclick="this.dataset.executed=\'yes\'">Run</button><label>Price<input id="quote" readonly value="100"></label>');
  const plugin = new ExplorerPlugin(f.host, new ExplorerStore(':memory:'), fakeProviders(f.url));
  const session = await f.host.createSession({ ...options, url: f.url }), source = f.host.observation(session.id), checkpoint = await f.host.createCheckpoint(session.id, 'Retained source');
  const created = plugin.create({ url: f.url, budget: { rounds: 1, actions: 8 } });
  plugin.revise(created.id, { items: [{ title: 'Run', scope: { url: f.url, label: 'Run', kind: 'click' }, prerequisites: [], completion: 'Execute Run', required: true, reason: 'Explicit fixture target' }] });
  const task = plugin.store.task(created.id), round: Round = { id: 'r', number: 1, sessionId: session.id, startedAt: new Date().toISOString(), status: 'running', actions: 0,
    stack: [{ checkpointId: checkpoint.id, observationId: source.id, stateId: source.stateId, used: [], path: [], remaining: [{ url: f.url, label: 'Run', kind: 'click' }] }],
    entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 };
  task.rounds = [round]; task.status = 'running'; plugin.store.save(task);
  const runtime = plugin as unknown as { step(task: Task, round: Round, signal: AbortSignal): Promise<boolean>;
    probe(task: Task, signal: AbortSignal, o: Observation, decision: undefined, localId: string, kind: 'focus'): Promise<void> };
  return { ...f, plugin, session, source, task, round, runtime, close: async () => { await plugin.close(); await f.close(); } };
}

it('keeps execution frames separate when a grouped price observation changes', async () => {
  const f = await runtimeFixture();
  try {
    await pageOf(f.host).locator('#quote').evaluate(el => { (el as HTMLInputElement).value = '200'; });
    const current = await f.host.observe(f.session.id);
    expect(current.canonical).not.toBe(f.source.canonical);
    // Deliberately make this collision explicit: graph grouping must never be
    // an authority, even if a future adapter applies a broader abstraction.
    f.round.stack[0].stateId = current.stateId;
    await f.runtime.step(f.task, f.round, new AbortController().signal);
    expect(await pageOf(f.host).locator('#run').getAttribute('data-executed')).toBe('yes');
    expect(f.round.stack.map(frame => frame.observationId)).toEqual([f.source.id, current.id]);
  } finally { await f.close(); }
});

it.each([false, true])('probe preparation and rollback preserve historical frames (changed facts: %s)', async changed => {
  const f = await runtimeFixture();
  try {
    if (changed) await pageOf(f.host).locator('#quote').evaluate(el => { (el as HTMLInputElement).value = '200'; });
    const current = await f.host.observe(f.session.id); f.round.stack[0].stateId = current.stateId;
    const before = structuredClone(f.round.stack), target = current.controls.find(c => c.stableKey === 'id:run')!;
    const command = vi.spyOn(f.host, 'command').mockImplementationOnce(async () => {
      expect(f.round.stack).toHaveLength(changed ? 2 : 1);
      throw new EngineError('TARGET_MISSING', 'Deliberate rejection before any probe dispatch');
    });
    await expect(f.runtime.probe(f.task, new AbortController().signal, current, undefined, target.localId, 'focus')).rejects.toMatchObject({ code: 'TARGET_MISSING' });
    expect(command).toHaveBeenCalledOnce(); expect(f.round.stack).toEqual(before);
    expect(f.host.list(f.session.id, 'attempt')).toHaveLength(0);
    expect(f.task.pendingDispatch).toBeUndefined();
  } finally { await f.close(); }
});

it('does not skip unfinished target recovery merely because its frame shares the current graph group', async () => {
  const f = await runtimeFixture();
  try {
    await pageOf(f.host).locator('#run').evaluate(el => { (el as HTMLElement).hidden = true; });
    const current = await f.host.observe(f.session.id); f.round.stack[0].stateId = current.stateId;
    expect(current.canonical).not.toBe(f.source.canonical);
    const reach = vi.spyOn(f.host, 'reachExplorationTarget');
    await f.runtime.step(f.task, f.round, new AbortController().signal);
    expect(reach).toHaveBeenCalledOnce();
    expect((await reach.mock.results[0].value).status).toBe('TARGET_REACHED');
    expect(await pageOf(f.host).locator('#run').isVisible()).toBe(true);
    expect(await pageOf(f.host).locator('#run').getAttribute('data-executed')).toBeNull();
    expect(f.round.stack).toHaveLength(1);
  } finally { await f.close(); }
});
