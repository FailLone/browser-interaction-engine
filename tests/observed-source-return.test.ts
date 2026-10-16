import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserAdapter, BrowserEngine, PlaywrightAdapter, type ActionAttempt, type ActionCandidate, type Observation } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { act, pageOf } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(mode = 'plain') {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/b') res.end(`<a href="/a">Back link</a><script>localStorage.seen='yes'</script>${mode === 'blocked' ? '<dialog id="gate" aria-label="Blocking"><button>Inside</button></dialog><script>gate.showModal()</script>' : ''}`);
    else res.end(`<label>Remaining<input id="remaining"></label><a href="/b">Next</a>
      ${mode === 'changed-modal' ? `<dialog id="gate" aria-label="Introduction"><label>Remember<input type="checkbox" id="remember"></label><a href="/b">Announced</a></dialog><script>if(!localStorage.seen)gate.showModal();else{gate.remove();remaining.setAttribute('aria-label','New work')}</script>` : ''}
      ${mode === 'return-modal' ? `<dialog id="gate" aria-label="Returned"><button>Inside</button></dialog><script>if(localStorage.seen)gate.showModal()</script>` : ''}
      ${mode === 'same-url' ? `<button id="panel" type="button" onclick="history.pushState({},'',location.href);remaining.value='second'">Panel</button><script>addEventListener('popstate',()=>remaining.value='first')</script>` : ''}`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/a`, directory = mkdtempSync(join(tmpdir(), 'source-return-'));
  const engine = new BrowserEngine({ persistence: new SqliteStore(directory) });
  const session = await engine.createSession({ url, contextRules: [], headless: true, exploration: 'controls', settleMs: 50, observeTimeoutMs: 500, actionTimeoutMs: 2000 });
  const t = { engine, sessionId: session.id, directory, url, async restart() { await t.engine.close(); t.engine = new BrowserEngine({ persistence: new SqliteStore(directory) }); } };
  cleanups.push(async () => { await t.engine.close(); rmSync(directory, { recursive: true, force: true }); });
  return t;
}
const attempts = (t: Awaited<ReturnType<typeof fixture>>) => t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
const sourceReturn = (t: Awaited<ReturnType<typeof fixture>>, source: Observation) => t.engine.returnToObservedSource(t.sessionId, { observationId: source.id, currentObservationId: t.engine.observation(t.sessionId).id });

it('returns to the native page after the old modal disappears, without restoring its checkpoint or executing new work', async () => {
  const t = await fixture('changed-modal');
  await act(t.engine, t.sessionId, 'Remember', 'check', true); await act(t.engine, t.sessionId, 'Remember', 'check', false);
  const checkpoint = await t.engine.createCheckpoint(t.sessionId, 'modal'), source = t.engine.observation(t.sessionId);
  expect(source.boundaries).toHaveLength(1); expect(checkpoint.path).toHaveLength(2);
  await act(t.engine, t.sessionId, 'Announced');
  const before = attempts(t).length, result = await sourceReturn(t, source), current = t.engine.observation(t.sessionId);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'SOURCE_REACHED', checkpointVerified: false, currentExecution: false, executionAuthorized: false, sourceStateRestored: false });
  expect(result.attemptIds).toHaveLength(1); expect(current.url).toBe(source.url); expect(current.canonical).not.toBe(source.canonical);
  expect(current.boundaries).toHaveLength(0); expect(current.controls.some(c => c.name === 'New work')).toBe(true);
  expect(attempts(t).slice(before)).toMatchObject([{ status: 'succeeded', purpose: 'recovery', action: { kind: 'history' } }]);
  expect(attempts(t).some(a => a.action.source === 'recovery-entry')).toBe(false);
  expect(t.engine.list(t.sessionId, 'source-return')).toEqual([result]);
  expect(t.engine.store.events(t.sessionId).some(e => e.type === 'exploration.source_return_result')).toBe(true);
  const strict = await t.engine.reachCheckpoint(t.sessionId, checkpoint.id);
  expect(strict.status).not.toBe('REACHED_VERIFIED'); expect(strict.reason).toBe('replay_target_not_unique_or_missing');
});

it('distinguishes two native entries with the same URL and uses no action when already at the exact source', async () => {
  const t = await fixture('same-url'), source = t.engine.observation(t.sessionId), original = source.navigation!.entries[source.navigation!.currentIndex].id;
  await pageOf(t.engine).locator('#panel').click(); await t.engine.observe(t.sessionId);
  const changed = t.engine.observation(t.sessionId);
  expect(changed.url).toBe(source.url); expect(changed.navigation!.entries[changed.navigation!.currentIndex].id).not.toBe(original);
  const result = await sourceReturn(t, source); expect(result.status).toBe('SOURCE_REACHED'); expect(result.attemptIds).toHaveLength(1);
  const after = t.engine.observation(t.sessionId); expect(after.navigation!.entries[after.navigation!.currentIndex].id).toBe(original);
  const same = await sourceReturn(t, source); expect(same.status).toBe('SOURCE_REACHED'); expect(same.attemptIds).toEqual([]);
  expect(attempts(t)).toHaveLength(1);
});

it('preserves an ordinary boundary reached at the source and does not authorize actions behind it', async () => {
  const t = await fixture('return-modal'), source = t.engine.observation(t.sessionId);
  await act(t.engine, t.sessionId, 'Next');
  const result = await sourceReturn(t, source); expect(result.status, JSON.stringify(result)).toBe('SOURCE_REACHED');
  expect(t.engine.observation(t.sessionId).boundaries).toHaveLength(1);
  const same = await sourceReturn(t, source); expect(same.status).toBe('SOURCE_REACHED'); expect(same.attemptIds).toEqual([]);
  const hidden = t.engine.actions(t.sessionId).find(a => a.label === 'Remaining')!;
  expect(t.engine.actionAvailability(t.sessionId).actions.find(a => a.actionId === hidden.id)?.executable).toBe(false);
  expect(attempts(t).filter(a => a.action.kind === 'history')).toHaveLength(1);
});

it('will not navigate out of a different page with an active boundary', async () => {
  const t = await fixture('blocked'), source = t.engine.observation(t.sessionId);
  await act(t.engine, t.sessionId, 'Next'); const count = attempts(t).length;
  const result = await sourceReturn(t, source); expect(result).toMatchObject({ status: 'UNREACHABLE', reason: 'active_boundary_blocks_source_return', attemptIds: [] });
  expect(attempts(t)).toHaveLength(count);
});

it('rejects wrong ownership and stale cursor before any capture or driver attachment', async () => {
  const t = await fixture(), source = t.engine.observation(t.sessionId);
  const capture = vi.spyOn(t.engine as unknown as { capture: () => Promise<unknown> }, 'capture');
  await expect(t.engine.returnToObservedSource(t.sessionId, { observationId: source.id, currentObservationId: 'stale' })).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
  t.engine.store.put('observation', { ...source, id: 'foreign', sessionId: 'another' });
  expect(() => t.engine.returnToObservedSource(t.sessionId, { observationId: 'foreign' })).toThrow();
  expect(capture).not.toHaveBeenCalled(); expect(attempts(t)).toEqual([]);
});

it.each(['unknown', 'executing'] as const)('blocks %s across process restart without starting a driver or adding attempts', async status => {
  const t = await fixture(), source = t.engine.observation(t.sessionId), action = t.engine.actions(t.sessionId)[0];
  t.engine.store.put('attempt', { id: 'interrupted', sessionId: t.sessionId, requestId: 'interrupted', action, startedAt: new Date().toISOString(), beforeId: source.id, purpose: 'external', status } satisfies ActionAttempt);
  await t.restart(); const start = vi.spyOn(BrowserAdapter.prototype, 'start');
  const result = await sourceReturn(t, source); expect(result).toMatchObject({ status: 'UNVERIFIED', reason: 'unknown_execution_outcome', attemptIds: [] });
  expect(start).not.toHaveBeenCalled(); expect(attempts(t)).toHaveLength(1); expect(attempts(t)[0].status).toBe('unknown');
});

it('does not recreate a driver to make a retained history pointer appear live', async () => {
  const t = await fixture(), source = t.engine.observation(t.sessionId); await t.restart();
  const start = vi.spyOn(BrowserAdapter.prototype, 'start'), result = await sourceReturn(t, source);
  expect(result).toMatchObject({ status: 'UNREACHABLE', reason: 'observed_source_driver_unavailable', attemptIds: [] });
  expect(start).not.toHaveBeenCalled(); expect(attempts(t)).toEqual([]);
});

it('rejects dirty state, unresolved boundary debt, unknown or changed context, critical gaps, and unstable evidence before capture', async () => {
  const t = await fixture(), source = t.engine.observation(t.sessionId);
  const capture = vi.spyOn(t.engine as unknown as { capture: () => Promise<unknown> }, 'capture');
  const change = (patch: Partial<Observation>) => {
    const current = { ...source, id: crypto.randomUUID(), ...patch }; t.engine.store.put('observation', current);
    t.engine.store.put('session', { ...t.engine.session(t.sessionId), currentObservationId: current.id });
  };
  for (const patch of [{ context: { mode: { status: 'unknown' as const, value: null, source: 'fixture' } } }, { context: { mode: { status: 'known' as const, value: 'changed', source: 'fixture' } } }, { gaps: [{ code: 'INCOMPLETE', message: 'missing', critical: true }] }, { stable: false }]) {
    change(patch); const result = await sourceReturn(t, source); expect(['UNVERIFIED', 'PRECONDITIONS_CHANGED']).toContain(result.status); expect(result.attemptIds).toEqual([]);
  }
  change({}); const incomplete = { ...source, id: 'incomplete-source', gaps: [{ code: 'SOURCE_INCOMPLETE', message: 'missing source', critical: true }] }; t.engine.store.put('observation', incomplete);
  expect((await sourceReturn(t, incomplete)).reason).toBe('observation_incomplete');
  t.engine.store.put('session', { ...t.engine.session(t.sessionId), dirty: true }); expect((await sourceReturn(t, source)).reason).toBe('dirty_session_requires_verified_recovery');
  t.engine.store.put('session', { ...t.engine.session(t.sessionId), dirty: false });
  const action = t.engine.actions(t.sessionId, source.id)[0];
  t.engine.store.put('attempt', { id: 'exit', sessionId: t.sessionId, requestId: 'exit', action, startedAt: new Date().toISOString(), beforeId: source.id, afterId: t.engine.observation(t.sessionId).id, purpose: 'recovery', status: 'succeeded' } satisfies ActionAttempt);
  t.engine.store.put('boundary-exit-result', { id: 'debt', sessionId: t.sessionId, attemptId: 'exit', status: 'unverified' });
  const blocked = await sourceReturn(t, source); expect(blocked.status).toBe('UNVERIFIED'); expect(blocked.checks.some(c => c.name.includes('BOUNDARY_EXIT_UNVERIFIED'))).toBe(true);
  expect(capture).not.toHaveBeenCalled(); expect(attempts(t)).toHaveLength(1);
});

it('rechecks debt introduced during awaited driver validation before a history dispatch', async () => {
  const t = await fixture(), source = t.engine.observation(t.sessionId); const first = await act(t.engine, t.sessionId, 'Next');
  const driver = (t.engine as unknown as { driver: { validate: (a: ActionCandidate, c?: unknown) => Promise<void> } }).driver, validate = driver.validate.bind(driver);
  vi.spyOn(driver, 'validate').mockImplementation(async (action, control) => { await validate(action, control); t.engine.store.put('attempt', { ...first, status: 'unknown' }); });
  const result = await sourceReturn(t, source); expect(result.status).toBe('UNVERIFIED'); expect(result.reason).toContain('unknown_execution_outcome'); expect(result.attemptIds).toEqual([]);
  expect(attempts(t)).toHaveLength(1); expect(t.engine.observation(t.sessionId).url).toContain('/b');
});

it('rechecks the returned position rather than trusting successful driver dispatch', async () => {
  const t = await fixture(), source = t.engine.observation(t.sessionId); await act(t.engine, t.sessionId, 'Next');
  const driver = (t.engine as unknown as { driver: { execute: (a: ActionCandidate, c?: unknown) => Promise<void> } }).driver, execute = driver.execute.bind(driver);
  vi.spyOn(driver, 'execute').mockImplementation(async (action, control) => { await execute(action, control); if (action.kind === 'history') await pageOf(t.engine).evaluate(() => history.pushState({}, '', location.href)); });
  const result = await sourceReturn(t, source); expect(result).toMatchObject({ status: 'UNREACHABLE', reason: 'native_source_position_not_reached' }); expect(result.attemptIds).toHaveLength(1);
  expect(attempts(t).at(-1)?.status).toBe('succeeded'); expect(t.engine.observation(t.sessionId).url).toBe(source.url);
});

it('rejects POST sources, different browser sessions and missing native entries without accepting URL equality', async () => {
  const t = await fixture(), source = t.engine.observation(t.sessionId), adapter = new PlaywrightAdapter();
  const altered = structuredClone(source); altered.navigation!.entries[altered.navigation!.currentIndex].method = 'POST';
  expect(adapter.observedSourcePosition(altered, source)).toMatchObject({ status: 'unavailable', reason: 'native_source_not_verified_get' });
  altered.navigation!.entries[altered.navigation!.currentIndex].method = 'GET'; altered.navigation!.browserSessionId = 'another';
  expect(adapter.observedSourcePosition(source, altered)).toMatchObject({ status: 'unavailable', reason: 'native_browser_session_changed' });
  altered.navigation!.browserSessionId = source.navigation!.browserSessionId; altered.navigation!.entries[altered.navigation!.currentIndex].id += 100;
  expect(adapter.observedSourcePosition(source, altered)).toMatchObject({ status: 'unavailable', reason: 'native_source_entry_unavailable' });
  expect(adapter.observedSourcePosition(source, { ...source, navigation: undefined }).status).toBe('unknown');
  const capture = vi.spyOn(t.engine as unknown as { capture: () => Promise<unknown> }, 'capture');
  for (const kind of ['post', 'browser', 'missing'] as const) {
    const invalid = structuredClone(source); invalid.id = `invalid-${kind}`;
    if (kind === 'post') invalid.navigation!.entries[invalid.navigation!.currentIndex].method = 'POST';
    if (kind === 'browser') invalid.navigation!.browserSessionId = 'another';
    if (kind === 'missing') invalid.navigation!.entries[invalid.navigation!.currentIndex].id += 100;
    t.engine.store.put('observation', invalid);
    expect(await sourceReturn(t, invalid)).toMatchObject({ status: 'UNREACHABLE', attemptIds: [] });
  }
  expect(capture).not.toHaveBeenCalled(); expect(attempts(t)).toEqual([]);
});

it('keeps an unsuccessful or unknown return unsuccessful even if the final URL is the requested page', async () => {
  const t = await fixture(), source = t.engine.observation(t.sessionId); await act(t.engine, t.sessionId, 'Next');
  const driver = (t.engine as unknown as { driver: { execute: (a: ActionCandidate, c?: unknown) => Promise<void> } }).driver, execute = driver.execute.bind(driver);
  vi.spyOn(driver, 'execute').mockImplementation(async (action, control) => { await execute(action, control); throw new Error('driver did not confirm completion'); });
  const result = await sourceReturn(t, source); expect(result).toMatchObject({ status: 'UNVERIFIED', reason: 'native_source_return_not_verified' });
  expect(result.attemptIds).toHaveLength(1); expect(attempts(t).at(-1)?.status).toBe('failed'); expect(t.engine.observation(t.sessionId).url).toBe(source.url);
});

it('rejects changed declared context observed after an otherwise successful history return', async () => {
  const t = await fixture(), source = t.engine.observation(t.sessionId); await act(t.engine, t.sessionId, 'Next');
  const driver = (t.engine as unknown as { driver: BrowserAdapter }).driver, capture = driver.capture.bind(driver);
  vi.spyOn(driver, 'capture').mockImplementation(async (id, context) => {
    const observation = await capture(id, context);
    return context?.afterAction?.action.kind === 'history' ? { ...observation, context: { mode: { status: 'known', value: 'changed', source: 'fixture' } } } : observation;
  });
  const result = await sourceReturn(t, source); expect(result).toMatchObject({ status: 'PRECONDITIONS_CHANGED', reason: 'declared_context_changed' });
  expect(result.attemptIds).toHaveLength(1); expect(attempts(t).at(-1)?.status).toBe('succeeded');
});

it('reports unassessed observed-UI effects without claiming business-state restoration', async () => {
  const t = await fixture('same-url'), source = t.engine.observation(t.sessionId), session = t.engine.session(t.sessionId);
  session.options.executionPolicy = 'observed-ui'; t.engine.store.put('session', session);
  const action = t.engine.actions(t.sessionId).find(a => a.label === 'Panel')!;
  const first = await t.engine.execute(t.sessionId, action.id, crypto.randomUUID(), undefined, { profile: 'observed-ui-exploration', observationId: source.id });
  expect(first).toMatchObject({ status: 'succeeded', effectsAssessment: 'not-assessed' });
  const result = await sourceReturn(t, source);
  expect(result).toMatchObject({ status: 'SOURCE_REACHED', verificationScope: 'observed-ui', sourceStateRestored: false, diagnostics: { unassessedEffectAttemptIds: [first.id] } });
});
