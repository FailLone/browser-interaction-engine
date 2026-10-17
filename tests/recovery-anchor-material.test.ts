import { afterEach, expect, it, vi } from 'vitest';
import { BrowserEngine, type Observation } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';

const engines: BrowserEngine[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) await engine.close(); });
function observation(id: string): Observation {
  return { id, sessionId: 'session', capturedAt: '2026-10-17T00:00:00.000Z', instanceScope: `document-${id}`, documentId: `document-${id}`,
    url: 'https://anchor.fixture.invalid/', stateId: `state-${id}`, visitId: `visit-${id}`, fingerprint: id, canonical: id, ruleVersion: 'test-v1',
    cause: 'inspection', stable: true, gaps: [], context: { account: { status: 'known', value: 'A', source: 'fixture' } },
    navigation: { browserSessionId: 'browser', currentIndex: 0, entries: [{ id: 1, url: 'https://anchor.fixture.invalid/', method: 'GET' }] },
    regions: [], boundaries: [], overlays: [], components: [], controls: [{ localId: `control-${id}`, instanceId: 'node', tag: 'div',
      role: 'generic', name: 'Retained target', label: 'Retained target', visible: true, enabled: true, actions: [] }] } as unknown as Observation;
}
const project = ({ id, sessionId, url, navigation, context, gaps }: Observation) => ({ id, sessionId, url, navigation, context, gaps });
function fixture() {
  const store = new MemoryStore(), engine = new BrowserEngine({ persistence: store }); engines.push(engine);
  const source = observation('source'), current = observation('current');
  store.put('session', { id: 'session', status: 'paused', currentObservationId: current.id, options: {}, dirty: false });
  store.put('observation', source); store.put('observation', current);
  const read = (sourceObservationId = source.id, currentObservationId = current.id) => engine.recoveryAnchorMaterial('session', { sourceObservationId, currentObservationId });
  return { store, engine, source, current, read };
}

it('returns only detached ordering facts with one source observation read and no action/current-frame reads or effects', () => {
  const f = fixture(), require = vi.spyOn(f.engine.store, 'require'), actions = vi.spyOn(f.engine.store, 'listByObservation');
  const put = vi.spyOn(f.engine.store, 'put'), event = vi.spyOn(f.engine.store, 'event'), transaction = vi.spyOn(f.engine.store, 'transaction');
  const execute = vi.spyOn(f.engine, 'execute'), reach = vi.spyOn(f.engine, 'reachCheckpoint');
  const result = f.read();
  expect(result).toEqual({ source: project(f.source) });
  expect(Object.keys(result)).toEqual(['source']);
  expect(Object.keys(result.source).sort()).toEqual(['context', 'gaps', 'id', 'navigation', 'sessionId', 'url']);
  expect(require.mock.calls.filter(([kind]) => kind === 'observation')).toEqual([['observation', f.source.id]]);
  expect(actions).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled(); expect(reach).not.toHaveBeenCalled();
  require.mockClear(); expect(f.read(f.current.id).source).toEqual(project(f.current));
  expect(require.mock.calls.filter(([kind]) => kind === 'observation')).toEqual([['observation', f.current.id]]);
});

it('isolates borrowed nested facts and rereads a changed same-ID source without caching', () => {
  const f = fixture(), borrowed = structuredClone(f.source), read = f.engine.store.require.bind(f.engine.store);
  f.engine.store.require = <T>(kind: string, id: string): T => kind === 'observation' && id === borrowed.id ? borrowed as T : read<T>(kind, id);
  const first = f.read(), expected = structuredClone(first);
  first.source.context.account.value = 'caller'; first.source.navigation!.entries[0].url = 'https://caller.invalid/';
  first.source.gaps.push({ code: 'caller', message: 'caller', critical: true });
  expect(borrowed.context.account.value).toBe('A'); expect(borrowed.navigation!.entries[0].url).toBe(f.source.url); expect(borrowed.gaps).toEqual([]);
  expect(f.read()).toEqual(expected);
  borrowed.context.account.value = 'B'; borrowed.navigation!.entries[0].method = 'POST';
  borrowed.gaps.push({ code: 'incomplete', message: 'Changed source', critical: true });
  expect(f.read().source).toMatchObject({ id: f.source.id, context: { account: { value: 'B' } }, navigation: { entries: [{ method: 'POST' }] },
    gaps: [{ code: 'incomplete', critical: true }] });
});

it.each(['observation', 'actions', 'interactionTransition', 'observationActions', 'recoverySourceMaterial'] as const)(
  'preserves the full composition failure when %s is overridden', seam => {
    const f = fixture(), error = new Error(`Rejected ${seam}`), engine = f.engine as any, original = engine[seam].bind(engine);
    engine[seam] = (...args: unknown[]) => {
      // A source-only shortcut could still call this observation override. Only
      // the full composition reaches its comparison-frame rejection.
      if (seam === 'observation' && args[1] !== f.current.id) return original(...args);
      throw error;
    };
    expect(() => f.read()).toThrow(error);
  },
);

it('uses the full composition if a source read replaces it before the fast return', () => {
  const f = fixture(), read = f.engine.store.require.bind(f.engine.store), error = new Error('Composition changed during read');
  f.engine.store.require = <T>(kind: string, id: string): T => {
    const value = read<T>(kind, id);
    if (kind === 'observation' && id === f.source.id) f.engine.recoverySourceMaterial = () => { throw error; };
    return value;
  };
  expect(() => f.read()).toThrow(error);
});

it('retains explicit-ID, ownership, missing-record and live-cursor failures on the default path', () => {
  const f = fixture();
  for (const [source, current] of [['', f.current.id], [f.source.id, '']]) expect(() => f.read(source, current)).toThrow('requires two explicit observation IDs');
  f.store.put('observation', { ...observation('foreign'), sessionId: 'another-session' });
  expect(() => f.read('foreign')).toThrow('does not belong to session');
  expect(() => f.read('missing')).toThrow('not found');
  expect(() => f.read(f.source.id, f.source.id)).toThrow('requires the current observation');
  expect(f.store.events('session')).toEqual([]);
});
