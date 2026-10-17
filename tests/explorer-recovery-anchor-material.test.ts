import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ActionCandidate, Checkpoint, Observation } from '@interaction/browser';
import { ExplorerPlugin, type ExplorerHost, type ExplorerStore, type PlanItem, type Scope } from '@interaction/explorer-plugin';
import { recordRouteRetry } from '../packages/explorer-plugin/src/obligation-lifecycle.js';

type Control = Observation['controls'][number];
type Anchor = ReturnType<NonNullable<ExplorerHost['recoveryAnchorMaterial']>>;
const url = 'https://anchor-selection.fixture.invalid/';
function observation(id: string, withControl = true): Observation {
  const control = { localId: `${id}:target`, instanceId: `${id}:target`, identityId: `identity-${id}`, identityScope: 'semantic', stableKey: 'id:remaining',
    tag: 'div', role: 'generic', name: 'Remaining', label: 'Remaining', region: 'region', visible: true, enabled: true, actions: [],
    constraints: { type: 'div', required: false, valid: true }, selected: [], actionable: { hitTarget: true, unknown: [] } } as unknown as Control;
  return { id, sessionId: 'session', documentId: `document-${id}`, instanceScope: `document-${id}`, url, ruleVersion: 'observable-v7',
    context: {}, stable: true, gaps: [], controls: withControl ? [control] : [], regions: [{ key: 'region', label: 'Main menu', role: 'navigation' }],
    boundaries: [], overlays: [], components: [], canonical: id, stateId: `state-${id}` } as unknown as Observation;
}
const project = ({ id, sessionId, url, navigation, context, gaps }: Observation): Anchor => ({ source: structuredClone({ id, sessionId, url, navigation, context, gaps }) });
function item(id: string, scope: Scope, sources: Observation[]): PlanItem {
  return { id, title: id, scope, prerequisites: [], completion: 'Review retained scope', status: 'unresolved', required: true, dispatchScope: false,
    reason: 'classification_unresolved', evidence: [...sources].reverse().map(source => ({ sessionId: source.sessionId, observationId: source.id })), attempts: [] };
}
function fixture(count = 2) {
  const sources = Array.from({ length: count }, (_,i) => observation(`source-${i + 1}`)), current = observation('current', false);
  sources.forEach((source, index) => { source.navigation = { browserSessionId: index === count - 1 ? 'browser' : 'old-browser', currentIndex: 0,
    entries: [{ id: 1, url, method: 'GET' }] }; });
  current.navigation = { browserSessionId: 'browser', currentIndex: 1, entries: [{ id: 1, url, method: 'GET' }, { id: 2, url, method: 'GET' }] };
  const frames = new Map([...sources, current].map(source => [source.id, source]));
  const checkpoints: Checkpoint[] = sources.map(source => ({ id: `checkpoint-${source.id}`, sessionId: source.sessionId, name: 'Retained review',
    observationId: source.id, stateId: source.stateId, context: source.context, predicates: [], acceptable: [], path: [], createdAt: '2026-10-17T00:00:00.000Z' }));
  const full = vi.fn((_sid: string, input: { sourceObservationId: string; currentObservationId: string }) => {
    const source = frames.get(input.sourceObservationId); if (!source) throw Error('Source unavailable');
    return { source: structuredClone(source), actions: [] as ActionCandidate[], transition: { beforeId: source.id, afterId: current.id, verified: true,
      documentChanged: true, navigated: false, retainedControls: [], entered: [], exited: [], revealedControlIds: [] } };
  });
  const anchor = vi.fn((_sid: string, input: { sourceObservationId: string; currentObservationId: string }): Anchor => {
    const source = frames.get(input.sourceObservationId); if (!source) throw Error('Source unavailable'); return project(source);
  });
  const effect = () => vi.fn(async () => { throw Error('Selection must not dispatch'); });
  const host = { events: new EventEmitter(), session: () => ({ id: 'session', options: {}, actionCount: 0, currentObservationId: current.id }),
    observation: vi.fn((_sid: string, id?: string) => { const source = frames.get(id || current.id); if (!source) throw Error('Missing frame'); return source; }),
    actions: () => [], actionAvailability: () => ({ sessionId: 'session', observationId: current.id, revision: 'ready', profile: 'interface-exploration',
      actions: [], dispatchRevalidationRequired: true }), list: (_sid: string, kind: string) => kind === 'checkpoint' ? checkpoints : [],
    recoverySourceMaterial: full, interactionTransition: () => ({ retainedControls: [] }), recoveryAssessment: () => ({ unknownAttempts: [] }),
    execute: effect(), reachCheckpoint: effect(), reachExplorationTarget: effect(), createCheckpoint: effect() } as unknown as ExplorerHost;
  const events: { type: string; data: unknown; observationId?: string }[] = [];
  const store = { save: vi.fn(), close: () => {}, event: (event: typeof events[number]) => { events.push(event); return event; } } as unknown as ExplorerStore;
  const plugin = new ExplorerPlugin(host, store), task = plugin.create({ url, coverageMode: 'all' });
  const review = item('review', { url, region: 'Main menu', label: 'Remaining', role: 'generic', stableKey: 'id:remaining' }, sources);
  task.plan = [{ ...item('authority', { url }, sources), dispatchScope: true, status: 'pending', reason: 'accepted scope' }, review]; task.status = 'running';
  task.rounds = [{ id: 'round', number: 1, sessionId: 'session', startedAt: '2026-10-17T00:00:00.000Z', status: 'running', actions: 0,
    stack: [], entryPath: [], reentries: [], tried: [], reviewed: [], noProgress: 0 }];
  task.routeRetries = recordRouteRetry(undefined, { routeKey: 'old-failure', conditionVersion: 'old-condition', outcome: 'unreachable', reason: 'Retained failure' });
  task.scheduling = { version: 1, localSelections: 4, legacyUnmappedRouteKeys: [], routes: { 'old-failure': {
    sessionId: 'old-session', observationId: 'old-source', checkpointId: 'old-checkpoint', targets: [{ url, label: 'Other target' }], path: [],
    itemIds: ['old-item'], memberKeys: ['old-member'], pathKeys: [],
  } } };
  const runtime = plugin as any;
  const select = () => runtime.scheduledRecovery(task, task.rounds[0], current, [], host.actionAvailability('session', current.id),
    runtime.routeConditionReader(current, []), new AbortController().signal);
  const noDispatch = () => { for (const method of ['execute', 'reachCheckpoint', 'reachExplorationTarget', 'createCheckpoint'] as const) expect(host[method]).not.toHaveBeenCalled(); };
  return { sources, current, frames, checkpoints, full, anchor, host, events, task, review, select, noDispatch, close: () => plugin.close() };
}
function selectedFacts(selected: any) {
  const { revalidate, ...facts } = selected; expect(revalidate).toBeTypeOf('function'); return facts;
}

it('preserves complete legacy choice, task, ordered events and debt while using light facts only for multi-source sorting', async () => {
  const f = fixture();
  try {
    const before = structuredClone(f.task), initialEvents = structuredClone(f.events);
    const legacy = await f.select(); legacy.revalidate();
    const legacyFacts = selectedFacts(legacy), legacyTask = structuredClone(f.task), legacyEvents = structuredClone(f.events);
    Object.assign(f.task, structuredClone(before)); f.events.splice(0, f.events.length, ...initialEvents);
    f.full.mockClear(); f.host.recoveryAnchorMaterial = f.anchor;
    const selected = await f.select();
    expect(selectedFacts(selected)).toEqual(legacyFacts);
    expect(f.anchor.mock.calls.map(call => call[1].sourceObservationId)).toEqual(f.sources.map(source => source.id));
    expect(f.full.mock.calls.map(call => call[1].sourceObservationId)).toEqual([f.sources[1].id]);
    selected.revalidate();
    expect(f.full.mock.calls.map(call => call[1].sourceObservationId)).toEqual([f.sources[1].id, f.sources[1].id]);
    expect(selectedFacts(selected)).toEqual(legacyFacts); expect(f.task).toEqual(legacyTask); expect(f.events).toEqual(legacyEvents);
    expect(f.task.plan).toEqual(before.plan); expect(f.task.routeRetries).toEqual(before.routeRetries); f.noDispatch();
  } finally { await f.close(); }
});

it.each(['throws', 'wrong owner'] as const)('treats an anchor API that %s as no ordering hint, never as a full-source bypass or a deleted candidate', async failure => {
  const f = fixture();
  try {
    f.host.recoveryAnchorMaterial = f.anchor;
    f.anchor.mockImplementation((_sid, input) => {
      if (failure === 'throws') throw Error('Anchor rejected');
      return { source: { ...project(f.frames.get(input.sourceObservationId)!).source, sessionId: 'another-session' } };
    });
    const full = f.full.getMockImplementation()!;
    f.full.mockImplementation((sid, input) => { if (input.sourceObservationId === f.sources[0].id) throw Error('Full source rejected'); return full(sid, input); });
    const plan = structuredClone(f.task.plan), debt = structuredClone(f.task.routeRetries);
    expect(await f.select()).toMatchObject({ itemId: 'review', source: { id: f.sources[1].id } });
    expect(f.anchor).toHaveBeenCalledTimes(2);
    expect(f.full.mock.calls.map(call => call[1].sourceObservationId)).toEqual(f.sources.map(source => source.id));
    expect(f.host.observation).not.toHaveBeenCalled(); expect(f.task.plan).toEqual(plan); expect(f.task.routeRetries).toEqual(debt); f.noDispatch();
  } finally { await f.close(); }
});

it('keeps the single-source path on one full read instead of adding a light decode immediately before it', async () => {
  const f = fixture(1);
  try {
    f.host.recoveryAnchorMaterial = f.anchor;
    const selected = await f.select(); expect(selected.source.id).toBe(f.sources[0].id);
    expect(f.anchor).not.toHaveBeenCalled(); expect(f.full).toHaveBeenCalledOnce();
    selected.revalidate(); expect(f.full).toHaveBeenCalledTimes(2); f.noDispatch();
  } finally { await f.close(); }
});

it('does not let a native anchor hint bypass full target visibility verification', async () => {
  const f = fixture();
  try {
    f.host.recoveryAnchorMaterial = f.anchor; f.sources[1].controls[0].visible = false;
    const plan = structuredClone(f.task.plan), debt = structuredClone(f.task.routeRetries);
    expect(await f.select()).toMatchObject({ source: { id: f.sources[0].id } });
    expect(f.full.mock.calls.map(call => call[1].sourceObservationId)).toEqual([f.sources[1].id, f.sources[0].id]);
    expect(f.task.plan).toEqual(plan); expect(f.task.routeRetries).toEqual(debt); f.noDispatch();
  } finally { await f.close(); }
});

it('discards even a repeated anchor across an actual yield and still revalidates selected full facts', async () => {
  const f = fixture(); let scheduled: ReturnType<typeof setImmediate> | undefined, yielded = false;
  try {
    const first = f.checkpoints[0], second = f.checkpoints[1];
    // Ten checkpoints share one source: two source keys cannot explain a reread
    // by LRU eviction. The actual yield must invalidate the anchor projection.
    f.checkpoints.splice(0, f.checkpoints.length, ...Array.from({ length: 10 }, (_,i) => ({ ...first, id: `${first.id}-${i}` })), second);
    f.host.recoveryAnchorMaterial = f.anchor;
    f.anchor.mockImplementation((_sid, input) => {
      const material = project(f.frames.get(input.sourceObservationId)!);
      if (input.sourceObservationId === f.sources[0].id && !scheduled) scheduled = setImmediate(() => {
        yielded = true; f.sources[0].navigation!.browserSessionId = 'updated-old-browser';
      });
      return material;
    });
    const plan = structuredClone(f.task.plan), debt = structuredClone(f.task.routeRetries), selected = await f.select();
    expect(yielded).toBe(true);
    const repeated = f.anchor.mock.calls.flatMap((call, index) => call[1].sourceObservationId === f.sources[0].id
      ? [(f.anchor.mock.results[index].value as Anchor).source.navigation!.browserSessionId] : []);
    expect(repeated).toEqual(['old-browser', 'updated-old-browser']);
    expect(selected.source.id).toBe(f.sources[1].id); expect(f.full).toHaveBeenCalledOnce();
    f.sources[1].controls[0].visible = false;
    expect(() => selected.revalidate()).toThrow('STALE_DECISION');
    expect(f.full).toHaveBeenCalledTimes(2); expect(f.task.plan).toEqual(plan); expect(f.task.routeRetries).toEqual(debt); f.noDispatch();
  } finally { if (scheduled) clearImmediate(scheduled); await f.close(); }
});
