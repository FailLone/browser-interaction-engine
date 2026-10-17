import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserEngine, type ActionCandidate, type Observation } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { createRecoverySelectionView } from '../packages/browser/src/recovery-selection-view.js';
import { acceptanceHost } from '../scripts/okx-storage-acceptance.js';
import { RegionReviews } from '../packages/browser/src/region-reviews.js';

const engines: BrowserEngine[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) await engine.close(); });

function fixture() {
  const state: { supported: boolean; revision: string | undefined } = { supported: true, revision: 'records:1' };
  const current = { observation: { id: 'current' }, actions: [{ id: 'current-action' }],
    availability: { revision: 'availability:1', dispatchRevalidationRequired: true } };
  const readers = {
    supported: vi.fn(() => state.supported), recordRevision: vi.fn(() => state.revision),
    current: vi.fn(() => current),
    source: vi.fn((id: string) => ({ source: { id }, actions: [{ id: `action:${id}` }] })),
    anchor: vi.fn((id: string) => ({ source: { id, url: 'https://selection.fixture.invalid/' } })),
  };
  const create = () => createRecoverySelectionView(readers);
  return { state, current, readers, create };
}

const expectStale = (read: () => unknown) => expect(read).toThrow(expect.objectContaining({ code: 'STALE_DECISION' }));

it.each(['unsupported', 'revision-unavailable'] as const)('returns no view when %s, without reading facts', reason => {
  const f = fixture();
  if (reason === 'unsupported') f.state.supported = false;
  else f.state.revision = undefined;
  expect(f.create()).toBeUndefined();
  expect(f.readers.current).not.toHaveBeenCalled(); expect(f.readers.source).not.toHaveBeenCalled(); expect(f.readers.anchor).not.toHaveBeenCalled();
  if (reason === 'unsupported') expect(f.readers.recordRevision).not.toHaveBeenCalled();
});

it('checks a stable generation across a real yield without rereading current facts or retaining source graphs', async () => {
  const f = fixture(), view = f.create()!;
  expect(view.current).toBe(f.current);
  expect(view.current.availability.dispatchRevalidationRequired).toBe(true);
  for (let index = 0; index < 128; index++) view.assertCurrent();
  await yieldImmediate();
  for (let index = 0; index < 128; index++) view.assertCurrent();
  expect(f.readers.current).toHaveBeenCalledTimes(1);
  expect(f.readers.source).not.toHaveBeenCalled(); expect(f.readers.anchor).not.toHaveBeenCalled();
  const first = view.source('source'), second = view.source('source');
  expect(second).toEqual(first); expect(second).not.toBe(first);
  expect(f.readers.source.mock.calls).toEqual([['source'], ['source']]);
  expect(view.anchor!('source')).toEqual({ source: { id: 'source', url: 'https://selection.fixture.invalid/' } });
  expect(Object.keys(view).sort()).toEqual(['anchor', 'assertCurrent', 'close', 'current', 'source']);
  expect(Object.isFrozen(view)).toBe(true);
});

it('rejects a generation change while constructing current materials', () => {
  const f = fixture();
  f.readers.current.mockImplementation(() => { f.state.revision = 'records:2'; return f.current; });
  expectStale(f.create);
  expect(f.readers.current).toHaveBeenCalledTimes(1); expect(f.readers.source).not.toHaveBeenCalled();
});

it('rejects before the next source read and cannot revive after a revision has been rejected', () => {
  const f = fixture(), view = f.create()!;
  f.state.revision = 'records:2';
  expectStale(() => view.source('source'));
  expect(f.readers.source).not.toHaveBeenCalled();
  f.state.revision = 'records:1';
  expectStale(view.assertCurrent); expectStale(() => view.anchor!('source'));
  expect(f.readers.anchor).not.toHaveBeenCalled();
});

it.each(['source', 'anchor'] as const)('rejects a generation change during a %s read without publishing its result', seam => {
  const f = fixture(), view = f.create()!;
  if (seam === 'source') f.readers.source.mockImplementation(id => { f.state.revision = 'records:2'; return { source: { id }, actions: [] }; });
  else f.readers.anchor.mockImplementation(id => { f.state.revision = 'records:2'; return { source: { id, url: 'https://changed.fixture.invalid/' } }; });
  expectStale(() => seam === 'source' ? view.source('source') : view.anchor!('source'));
  expectStale(view.assertCurrent);
});

it('honors a withdrawn composition proof even when records are unchanged', () => {
  const f = fixture(), view = f.create()!;
  // The SDK owns eligibility, including service overrides and unversioned
  // adapter policy. A storage generation cannot replace that explicit proof.
  f.readers.source.mockImplementation(id => { f.state.supported = false; return { source: { id }, actions: [] }; });
  expectStale(() => view.source('source'));
  expect(f.state.revision).toBe('records:1');
  f.state.supported = true;
  expectStale(view.assertCurrent);
});

it('preserves a stable reader error but checks validity on the exceptional path', () => {
  const f = fixture(), error = new Error('Retained source is unavailable'), view = f.create()!;
  f.readers.source.mockImplementationOnce(() => { throw error; });
  let caught: unknown;
  try { view.source('missing'); } catch (value) { caught = value; }
  expect(caught).toBe(error);
  expect(() => view.assertCurrent()).not.toThrow();
  expect(view.source('source').source.id).toBe('source');
  f.readers.source.mockImplementationOnce(() => { f.state.revision = 'records:2'; throw error; });
  expectStale(() => view.source('missing'));
  expectStale(view.assertCurrent);
});

it('reads optional historical review material lazily and checks its generation before, after and on errors', () => {
  const f = fixture(), error = new Error('Historical review unavailable');
  const reviewMaterial = vi.fn((id: string) => ({ observationId: id, controls: [] }));
  const create = () => createRecoverySelectionView({ ...f.readers, reviewMaterial });
  const view = create()!;
  expect(reviewMaterial).not.toHaveBeenCalled();
  expect(view.reviewMaterial!('source')).toEqual({ observationId: 'source', controls: [] });
  reviewMaterial.mockImplementationOnce(() => { throw error; });
  expect(() => view.reviewMaterial!('source')).toThrow(error);
  expect(() => view.assertCurrent()).not.toThrow();
  reviewMaterial.mockClear(); f.state.revision = 'records:2';
  expectStale(() => view.reviewMaterial!('source')); expect(reviewMaterial).not.toHaveBeenCalled();
  const next = create()!;
  reviewMaterial.mockImplementationOnce(id => { f.state.revision = 'records:3'; return { observationId: id, controls: [] }; });
  expectStale(() => next.reviewMaterial!('source'));
  const last = create()!;
  reviewMaterial.mockImplementationOnce(() => { f.state.revision = 'records:4'; throw error; });
  expectStale(() => last.reviewMaterial!('source')); expectStale(last.assertCurrent);
});

it('treats unavailable revision checks as unsupported initially and stale after creation', () => {
  const f = fixture(), error = new Error('Revision reader unavailable');
  f.readers.recordRevision.mockImplementationOnce(() => { throw error; });
  expect(f.create()).toBeUndefined(); expect(f.readers.current).not.toHaveBeenCalled();
  const view = f.create()!;
  f.state.revision = undefined;
  expectStale(view.assertCurrent);
  expect(f.readers.current).toHaveBeenCalledTimes(1);
});

it('closes without any new reader calls and cannot be used again', () => {
  const f = fixture(), { anchor: _anchor, ...readers } = f.readers;
  const view = createRecoverySelectionView(readers)!;
  expect(view.anchor).toBeUndefined();
  const checks = f.readers.recordRevision.mock.calls.length;
  view.close(); view.close();
  expectStale(view.assertCurrent); expectStale(() => view.source('source'));
  expect(f.readers.recordRevision).toHaveBeenCalledTimes(checks);
  expect(f.readers.current).toHaveBeenCalledTimes(1); expect(f.readers.source).not.toHaveBeenCalled();
});

function browserFixture() {
  const store = new MemoryStore(), engine = new BrowserEngine({ persistence: store }); engines.push(engine);
  const current = { id: 'current', sessionId: 'session', capturedAt: '2026-10-17T00:00:00.000Z', documentId: 'document', instanceScope: 'document',
    url: 'https://selection.fixture.invalid/', stateId: 'state', visitId: 'visit', fingerprint: 'fixture', canonical: 'fixture', ruleVersion: 'observable-v7',
    cause: 'inspection', stable: true, gaps: [], context: {}, boundaries: [], overlays: [], regions: [], components: [],
    controls: [{ localId: 'button', instanceId: 'button-instance', identityId: 'button-identity', tag: 'button', role: 'button', name: 'Open', label: 'Open',
      visible: true, enabled: true, actions: ['click'], actionable: {}, constraints: {} }] } as unknown as Observation;
  const source = { ...current, id: 'source' };
  const action: ActionCandidate = { id: 'action', sessionId: 'session', observationId: current.id, stateId: current.stateId,
    localId: 'button', controlId: 'button-identity', kind: 'click', label: 'Open', risk: 'interface', replayable: true, source: 'fixture',
    excluded: false, sampleValidity: 'known', preconditions: { context: {}, visible: true, enabled: true, identityResolved: true, targetResolved: true },
    basis: { status: 'supported', evidence: [{ source: 'fixture', rule: 'fixture-button/v1', facts: {} }] } };
  store.put('session', { id: 'session', status: 'paused', currentObservationId: current.id, dirty: false,
    options: { executionPolicy: 'observed-ui', exploration: 'controls', exclude: [], replayable: [] } });
  store.put('observation', current); store.put('observation', source); store.put('action', action);
  const create = () => engine.recoverySelectionView('session', { observationId: current.id });
  return { store, engine, current, source, action, create };
}

it('offers the default SDK composition with unchanged ordinary current/source facts and no record effects', () => {
  const f = browserFixture(), revision = f.store.recordRevision(), view = f.create()!;
  expect(view).toBeDefined();
  expect(view.current).toEqual({ observation: f.engine.observation('session'), actions: f.engine.actions('session', 'current'),
    availability: f.engine.actionAvailability('session', 'current') });
  expect(view.current.availability.actions).toEqual([{ actionId: f.action.id, executable: true, blockers: [] }]);
  expect(view.source('source')).toEqual(f.engine.recoverySourceMaterial('session', { sourceObservationId: 'source', currentObservationId: 'current' }));
  expect(view.anchor!('source')).toEqual(f.engine.recoveryAnchorMaterial('session', { sourceObservationId: 'source', currentObservationId: 'current' }));
  expect(f.store.recordRevision()).toBe(revision); expect(f.store.events('session')).toEqual([]);
});

it('reads detached historical review facts through the default SDK view without changing the current cursor or granting authority', () => {
  const f = browserFixture();
  f.store.put('action', { ...f.action, id: 'source-action', observationId: f.source.id });
  const record = { id: 'source-review', sessionId: 'session', observationId: f.source.id, localId: 'button', kind: 'click',
    status: 'revoked', conditionKey: 'fixture-condition', conditions: { instanceScope: f.source.instanceScope, target: { instanceId: 'button-instance' } } };
  f.store.put('control-review', record);
  const revision = f.store.recordRevision(), view = f.create()!;
  const material = f.engine.recoveryReviewMaterial('session', { observationId: f.source.id });
  expect(material).toMatchObject({ sessionId: 'session', observationId: f.source.id,
    controls: [{ actions: [{ id: 'source-action', observationId: f.source.id }], reviews: [{ id: record.id, status: 'revoked' }] }] });
  expect(view.reviewMaterial!(f.source.id)).toEqual(material);
  expect(f.engine.session('session').currentObservationId).toBe(f.current.id);
  expect(() => f.engine.controlInterpretationSnapshot('session', f.source.id)).toThrow();
  material.controls[0].control.label = 'caller-only'; material.controls[0].reviews[0].status = 'active';
  expect(f.engine.recoveryReviewMaterial('session', { observationId: f.source.id }).controls[0]).toMatchObject({ control: { label: 'Open' }, reviews: [{ status: 'revoked' }] });
  expect(f.store.recordRevision()).toBe(revision); expect(f.store.events('session')).toEqual([]);
  for (const field of ['checkpointVerified', 'executionAuthorized', 'currentExecution', 'coverageGranted']) expect(material).not.toHaveProperty(field);
  f.store.put('control-review', { ...record, status: 'superseded' });
  expectStale(() => view.reviewMaterial!(f.source.id));
  expect(f.create()!.reviewMaterial!(f.source.id).controls[0].reviews[0].status).toBe('superseded');
  expect(() => f.engine.recoveryReviewMaterial('session', { observationId: '' })).toThrow('requires an explicit observation ID');
  f.store.put('observation', { ...f.source, id: 'foreign-source', sessionId: 'another-session' });
  expect(() => f.engine.recoveryReviewMaterial('session', { observationId: 'foreign-source' })).toThrow('does not belong to session');
});

it('invalidates on record changes and retains the original unknown-outcome availability gate', () => {
  const f = browserFixture(), view = f.create()!;
  f.store.put('control-review', { id: 'revoked-review', sessionId: 'session', status: 'revoked' });
  expectStale(view.assertCurrent);
  const next = f.create()!;
  f.store.put('attempt', { id: 'unknown', sessionId: 'session', action: f.action, status: 'unknown', beforeId: 'current' });
  expectStale(next.assertCurrent);
  const fresh = f.create()!;
  expect(fresh.current.availability.actions[0]).toMatchObject({ executable: false,
    blockers: [expect.objectContaining({ code: 'UNKNOWN_ACTION_OUTCOME', evidence: ['unknown'] })] });
});

it.each(['actions', 'preparedActionValidator'] as const)('returns unsupported for an instance %s override without invoking it', seam => {
  const f = browserFixture(), replacement = vi.fn(() => { throw new Error('Custom composition must use the legacy path'); });
  (f.engine as unknown as Record<string, unknown>)[seam] = replacement;
  expect(f.create()).toBeUndefined(); expect(replacement).not.toHaveBeenCalled();
});

it('rejects an unversioned constrain closure and an altered service even with unchanged records', () => {
  const f = browserFixture(), view = f.create()!, internals = f.engine as unknown as {
    adapter: { constrain: unknown }; controls: { validate: unknown };
  };
  const revision = f.store.recordRevision();
  internals.controls.validate = vi.fn();
  expectStale(view.assertCurrent); expect(f.create()).toBeUndefined();
  expect(f.store.recordRevision()).toBe(revision);
  const other = browserFixture(); let allowed = true;
  const constrain = vi.fn((action: ActionCandidate) => ({ ...action, excluded: !allowed }));
  (other.engine as unknown as { adapter: { constrain: unknown } }).adapter.constrain = constrain;
  expect(other.create()).toBeUndefined(); allowed = false;
  expect(other.create()).toBeUndefined(); expect(constrain).not.toHaveBeenCalled();
});

it('rejects a service prototype replacement made before constructing the engine', () => {
  const replacement = vi.spyOn(RegionReviews.prototype, 'validateAction').mockImplementation(() => { throw new Error('Changed service'); });
  const f = browserFixture();
  expect(f.create()).toBeUndefined(); expect(replacement).not.toHaveBeenCalled();
});

it('validates the requested current cursor and isolates the input ID from later caller edits', () => {
  const f = browserFixture();
  expectStale(() => f.engine.recoverySelectionView('session', { observationId: 'source' }));
  const input = { observationId: 'current' }, view = f.engine.recoverySelectionView('session', input)!;
  input.observationId = 'source';
  expect(view.source('source').transition.afterId).toBe('current');
});


it('acceptance facade preserves SDK view eligibility, forwarding and stale fences', async () => {
  const f = browserFixture(), metrics: Parameters<typeof acceptanceHost>[2] = {};
  const before = Object.getOwnPropertyDescriptors(f.engine);
  const failure = new Error('budget stop');
  const facade = acceptanceHost(f.engine, { createSession: async () => { throw failure; } }, metrics);
  const view = facade.recoverySelectionView('session', { observationId: 'current' })!;
  expect(view).toBeDefined();
  expect(view.current).toEqual(f.create()!.current);
  expect(view.source('source')).toEqual(f.create()!.source('source'));
  expect(view.anchor!('source')).toEqual(f.create()!.anchor!('source'));
  expect(view.reviewMaterial!('source')).toEqual(f.create()!.reviewMaterial!('source'));
  expect(metrics.recoverySelectionView).toMatchObject({ calls: 1, viewsAvailable: 1, viewsUnavailable: 0, returned: 1 });
  await expect(facade.createSession({ url: 'https://fixture.invalid/' })).rejects.toBe(failure);
  expect(metrics.createSession).toMatchObject({ calls: 1, threw: 1 });
  expect(Object.getOwnPropertyDescriptors(f.engine)).toEqual(before);
  expect(f.create()).toBeDefined();
  f.store.put('control-review', { id: 'changed', sessionId: 'session', status: 'revoked' });
  expectStale(view.assertCurrent);
  const next = facade.recoverySelectionView('session', { observationId: 'current' })!;
  next.close(); expectStale(next.assertCurrent);
});
