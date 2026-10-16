import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { InteractionEngine, canonical, hash, type ActionCandidate, type ActionAttempt, type FrontierItem } from '@interaction/core';
import { BrowserEngine, PlaywrightAdapter, type ActionCandidate as BrowserAction, type Observation as BrowserObservation, type Control as BrowserControl } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { CounterAdapter, type CounterDriver, type CounterObservation } from '../examples/counter-adapter.js';
import { explorationCase } from '../packages/adapter-playwright/src/exploration.js';
import { migrateSamplingSources, sampledFrontierKey } from '../packages/core/src/sampling-migration.js';
import { describeFrontier, groupFrontier } from '../packages/core/src/frontier.js';
import { pageOf } from './helpers.js';

// Frozen projection from 1ed22389 (exploration.ts shape/explorationCase and
// util.ts signature/formBinding). This deliberately does not call the decoder
// under test. This fixture's selector is in another native form, so the old
// algorithm's relevant branch-condition set is empty in both A and B.
function frozenV1Case(action: BrowserAction, o: BrowserObservation) {
  const signature = (c: BrowserControl) => canonical({ role: c.role, label: c.label || c.liveContent?.name || c.name,
    region: c.region, form: c.form, actions: c.actions, type: c.constraints.type,
    scope: c.identityContext?.scope, binding: c.identityContext?.binding,
    ...(c.structuralItem ? { record: c.structuralItem.recordKey } : {}) });
  const c = o.controls.find(c => c.identityId === action.controlId && c.localId === action.localId)!;
  const mode = o.controls.find(c => c.stableKey === 'id:mode')!;
  expect(c.formOwner?.instanceId).toBeTruthy();
  expect(mode.formOwner?.instanceId).toBeTruthy();
  expect(mode.formOwner!.instanceId).not.toBe(c.formOwner!.instanceId);
  const { valid: _valid, ...constraints } = c.constraints;
  const { instanceId: _instance, ...formOwner } = c.formOwner!;
  const item = c.structuralItem;
  const structuralItem = item ? { ownerInstanceId: item.ownerInstanceId, template: item.template,
    slot: item.slot, recordKey: item.recordKey, ...(item.recordKey ? {} : { rowInstanceId: item.rowInstanceId }) } : undefined;
  const target = { signature: signature(c), stableKey: c.stableKey, identityScope: c.identityScope,
    visible: c.visible, enabled: c.enabled, editable: c.editable, constraints, options: c.options,
    list: c.list, purposeBinding: c.purposeBinding, formOwner, structuralItem };
  const structuralScope = o.controls.filter(c => c.visible && c.actions.length)
    .map(c => ({ key: c.stableKey || signature(c), role: c.role })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const projection = { url: o.url, boundary: o.boundaries?.map(b => b.key) || [], structuralScope, target,
    valid: c.constraints.valid, branch: hash({ policy: 'browser-branch-conditions-v1', conditions: [] }),
    text: c.displayedText, expanded: c.expanded, risk: action.risk, replayable: action.replayable,
    basis: action.basis, excluded: action.excluded, exclusionReason: action.exclusionReason,
    blockers: action.preconditions.blockers?.map(b => b.code) || [] };
  return { key: hash(projection), policy: 'browser-representative-v2', evidence: ['Frozen 1ed22389 fixture encoder'] };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

class UpgradeAdapter extends CounterAdapter {
  upgraded = false;
  legacyCalls = 0;
  rejectCount?: number;
  driver?: CounterDriver;
  get explorationCaseRevision() { return this.upgraded ? 'counter-sampling-v2' : 'counter-sampling-v1'; }
  override createDriver() { this.driver = super.createDriver(); return this.driver; }
  explorationCase(_a: ActionCandidate, o: CounterObservation) {
    if (this.upgraded && o.count === this.rejectCount) return;
    return { key: this.upgraded ? `count:${o.count}` : 'all-counts', policy: 'counter-representative', evidence: ['Retained counter conditions'] };
  }
  legacyExplorationCases() { this.legacyCalls++; return [{ key: 'all-counts', policy: 'counter-representative', evidence: ['Known old encoder'] }]; }
}
class TrackedStore extends MemoryStore {
  reads: string[] = [];
  override get<T>(kind: string, id: string) { if (kind === 'observation') this.reads.push(id); return super.get<T>(kind, id); }
  drop(id: string) { (this as unknown as { entities: Map<string, unknown> }).entities.delete(id); }
}
async function fixture() {
  const adapter = new UpgradeAdapter(), store = new TrackedStore();
  let engine = new InteractionEngine({ adapter, persistence: store, hooks: { actions: actions => actions.map(a => ({ ...a, basis: { status: 'supported', evidence: [{ source: 'fixture', rule: 'counter-operation', facts: {} }] } })) } });
  cleanup.push(() => engine.close());
  const session = await engine.createSession({ exploration: 'representative' });
  const first = engine.observation(session.id);
  await adapter.driver!.execute({ ...engine.actions(session.id)[0], value: { by: 1 } });
  const second = await engine.observe(session.id);
  const parent = store.list<FrontierItem>('frontier', session.id)[0];
  expect(parent.sampling?.observationIds).toEqual([first.id, second.id]);
  return { adapter, store, sid: session.id, parent, first, second,
    get engine() { return engine; },
    upgrade() { adapter.upgraded = true; store.transaction(() => migrateSamplingSources(store, engine.session(session.id), adapter, false)); },
    async restart() { await engine.close(); engine = new InteractionEngine({ adapter, persistence: store }); },
    currentParent() { return store.require<FrontierItem>('frontier', parent.id); },
    children() { return store.list<FrontierItem>('frontier', session.id).filter(f => f.id !== parent.id); },
  };
}

it('splits two retained sources without granting execution, and is idempotent across 100 captures and restart', async () => {
  const f = await fixture(); f.upgrade();
  expect(f.currentParent()).toMatchObject({ status: 'superseded', reason: 'sampling_policy_migrated', attempts: [] });
  expect(f.children()).toHaveLength(2);
  expect(f.children().every(c => c.status === 'pending' && !c.attempts.length && c.samplingParents?.[0].frontierId === f.parent.id)).toBe(true);
  const views = f.engine.getFrontier(f.sid), parent = views.find(v => v.id === f.parent.id)!;
  expect(parent.coverage).toMatchObject({ executionStatus: 'not_attempted', migratedTo: expect.arrayContaining(f.children().map(c => c.id)) });
  expect(groupFrontier(views)[0].counts).toMatchObject({ total: 2, notAttempted: 2, executed: 0 });
  const calls = f.adapter.legacyCalls;
  f.store.reads = [];
  for (let i = 0; i < 100; i++) await f.engine.observe(f.sid);
  expect(f.adapter.legacyCalls).toBe(calls);
  // Historical source observations are not repeatedly loaded by migration.
  expect(f.store.reads.filter(id => id === f.first.id)).toHaveLength(0);
  expect(f.children()).toHaveLength(2);
  await f.restart(); await f.engine.reconcileSamplingScopes(f.sid);
  expect(f.children()).toHaveLength(2);
  expect(f.currentParent().attempts).toEqual([]);
});

it('caches an unchanged partial gap for 100 captures and retries repaired evidence only through explicit reconciliation', async () => {
  const f = await fixture();
  f.store.put('frontier', { ...f.parent, sampling: { ...f.parent.sampling!, observationIds: [...f.parent.sampling!.observationIds, 'later-source'] } });
  f.upgrade();
  expect(f.currentParent().samplingMigration?.sources.at(-1)).toMatchObject({ observationId: 'later-source', reason: 'source_observation_missing' });
  const calls = f.adapter.legacyCalls; f.store.reads = [];
  for (let i = 0; i < 100; i++) await f.engine.observe(f.sid);
  expect(f.adapter.legacyCalls).toBe(calls);
  expect(f.store.reads.filter(id => id === f.first.id || id === 'later-source')).toHaveLength(0);
  const action = f.store.list<ActionCandidate>('action', f.sid).find(a => a.observationId === f.first.id)!;
  f.store.put('observation', { ...f.first, id: 'later-source' });
  f.store.put('action', { ...action, id: 'later-action', observationId: 'later-source' });
  await f.engine.observe(f.sid);
  expect(f.currentParent().status).toBe('blocked');
  await f.engine.reconcileSamplingScopes(f.sid);
  expect(f.currentParent().status).toBe('superseded');
  expect(f.children()).toHaveLength(2);
  expect(f.currentParent().samplingMigration?.sources.at(-1)).toMatchObject({ observationId: 'later-source', actionId: 'later-action', childId: expect.any(String) });
});

it.each(['missing', 'wrong-action'] as const)('preserves a %s child gap through repeated forced audits and cold engine restart', async fault => {
  const f = await fixture(); f.upgrade();
  const child = f.children()[0];
  if (fault === 'missing') f.store.drop(child.id);
  else f.store.put('frontier', { ...child, action: { ...child.action, value: { by: 999 } } });
  const invalid = f.engine.getFrontier(f.sid).find(v => v.id === f.parent.id)!;
  expect(invalid).toMatchObject({ status: 'blocked', coverage: { executionStatus: 'not_attempted' } });
  expect(invalid.coverage.migratedTo).toBeUndefined();
  for (let i = 0; i < 2; i++) {
    await f.engine.reconcileSamplingScopes(f.sid);
    expect(f.currentParent().status).toBe('blocked');
    expect(f.currentParent().samplingMigration?.sources.find(s => s.childId === child.id)?.reason)
      .toBe(fault === 'missing' ? 'derived_scope_missing' : 'derived_scope_binding_unverified');
  }
  await f.restart(); await f.engine.reconcileSamplingScopes(f.sid);
  expect(f.currentParent().status).toBe('blocked');
  expect(f.currentParent().samplingMigration?.sources.some(s => s.childId === child.id && !!s.reason)).toBe(true);
  expect(f.store.require<FrontierItem>('frontier', f.parent.id).attempts).toEqual([]);
  if (fault === 'missing') expect(f.store.get('frontier', child.id)).toBeUndefined();
});

it.each(['incomplete', 'ambiguous', 'unsupported-key', 'current-undefined'] as const)('keeps %s historical evidence as an explicit gap with no fallback authorization', async fault => {
  const f = await fixture();
  const action = f.store.list<ActionCandidate>('action', f.sid).find(a => a.observationId === f.first.id)!;
  if (fault === 'incomplete') {
    f.store.put('observation', { ...f.first, id: 'incomplete-source', stable: false });
    f.store.put('action', { ...action, id: 'incomplete-action', observationId: 'incomplete-source' });
    f.store.put('frontier', { ...f.parent, sampling: { ...f.parent.sampling!, observationIds: [...f.parent.sampling!.observationIds, 'incomplete-source'] } });
  }
  if (fault === 'ambiguous') f.store.put('action', { ...action, id: 'ambiguous-action' });
  if (fault === 'unsupported-key') f.store.put('frontier', { ...f.parent, key: 'unknown-historical-encoding' });
  if (fault === 'current-undefined') f.adapter.rejectCount = 0;
  f.upgrade();
  expect(f.currentParent()).toMatchObject({ status: 'blocked', reason: 'sampling_migration_incomplete', attempts: [] });
  const reasons = f.currentParent().samplingMigration!.sources.map(s => s.reason);
  expect(reasons).toContain({ incomplete: 'source_observation_unverified', ambiguous: 'source_action_ambiguous',
    'unsupported-key': 'source_action_or_legacy_key_unverified', 'current-undefined': 'current_source_conditions_unverified' }[fault]);
  const parent = f.engine.getFrontier(f.sid).find(v => v.id === f.parent.id)!;
  expect(parent.coverage.migratedTo).toBeUndefined(); expect(parent.coverage.equivalentTo).toBeUndefined();
  expect(f.engine.report(f.sid).explorationAudit.status).toBe('blocked');
});

it.each(['other-kind', 'other-key', 'wrong-action'] as const)('rejects a derived child collision with %s without overwriting it', async fault => {
  const f = await fixture(); f.adapter.upgraded = true;
  const action = f.store.list<ActionCandidate>('action', f.sid).find(a => a.observationId === f.first.id)!;
  const sample = f.adapter.explorationCase(action, f.first)!, key = sampledFrontierKey(action, sample);
  const id = hash({ kind: 'sampling-derived-frontier', sessionId: f.sid, key });
  if (fault === 'other-kind') f.store.put('sentinel', { id, sessionId: f.sid, untouched: true });
  else f.store.put('frontier', { ...f.parent, id, key: fault === 'other-key' ? 'occupied-key' : key,
    action: fault === 'wrong-action' ? { ...action, value: { by: 999 } } : action,
    sampling: { ...f.parent.sampling!, policy: sample.policy, revision: f.adapter.explorationCaseRevision } });
  const before = f.store.get(fault === 'other-kind' ? 'sentinel' : 'frontier', id);
  f.upgrade();
  expect(f.currentParent().status).toBe('blocked');
  expect(f.currentParent().samplingMigration?.sources.find(s => s.observationId === f.first.id)?.reason)
    .toBe(fault === 'wrong-action' ? 'derived_scope_binding_unverified' : 'derived_id_conflict');
  expect(f.store.get(fault === 'other-kind' ? 'sentinel' : 'frontier', id)).toEqual(before);
});

it('never transfers successful old execution to newly keyed samples', async () => {
  const f = await fixture();
  const before = { ...f.parent, status: 'executed' as const, attempts: ['old-attempt'] };
  f.store.put('frontier', before); f.upgrade();
  expect(f.currentParent()).toEqual(before); expect(f.children()).toEqual([]);
});

it('blocks migration on an unknown outcome across restart without inventing a success', async () => {
  const f = await fixture();
  const a = f.parent.action;
  f.store.put('attempt', { id: 'interrupted-attempt', sessionId: f.sid, action: a, beforeId: a.observationId,
    status: 'executing', purpose: 'recovery', startedAt: new Date().toISOString(), requestId: 'interrupted' } as ActionAttempt);
  await f.restart(); f.adapter.upgraded = true;
  expect(f.store.require<ActionAttempt>('attempt', 'interrupted-attempt').status).toBe('unknown');
  await f.engine.reconcileSamplingScopes(f.sid);
  expect(f.currentParent().samplingMigration?.sources.every(s => s.reason === 'unknown_execution_outcome')).toBe(true);
  expect(f.children()).toEqual([]);
  expect(f.currentParent().attempts).toEqual([]);
  expect(f.store.require<ActionAttempt>('attempt', 'interrupted-attempt').status).toBe('unknown');
});

it('keeps partial migration out of equivalent coverage even if a caller supplies an equivalent record', async () => {
  const f = await fixture(); f.adapter.rejectCount = 0; f.upgrade();
  const views = describeFrontier(f.store.list<FrontierItem>('frontier', f.sid), [], new Map([[f.parent.id, {
    attemptId: 'some-other-attempt', beforeId: f.first.id, afterId: f.second.id,
  } as never]]));
  expect(views.find(v => v.id === f.parent.id)?.coverage).toMatchObject({ executionStatus: 'not_attempted' });
  expect(views.find(v => v.id === f.parent.id)?.coverage.equivalentTo).toBeUndefined();
});

it('uses the real browser v1 decoder to split retained A/B conditions, preserving strict states and executing each actual branch', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><title>Sampling migration</title>
      <form id="settings"><select id="mode" aria-label="Mode"><option>A</option><option>B</option></select></form>
      <form id="commands"><button id="run" type="button" onclick="window.events.push(document.querySelector('#mode').value)">Run</button></form>
      <script>window.events=[]</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const directory = mkdtempSync(join(tmpdir(), 'bie-sampling-migration-'));
  const store = new SqliteStore(directory);
  let engine = new BrowserEngine({ persistence: store, hooks: { actions: as => as.filter(a => a.kind === 'click' && a.label === 'Run') } });
  cleanup.push(async () => { await engine.close(); rmSync(directory, { recursive: true, force: true }); });
  const adapter = (engine as unknown as { adapter: PlaywrightAdapter }).adapter;
  const currentCase = adapter.explorationCase.bind(adapter), currentGrouping = adapter.stateGrouping.bind(adapter);
  adapter.explorationCase = (a, o) => {
    const historical = frozenV1Case(a, o);
    expect(explorationCase(a, o, 'v1')?.key).toBe(historical.key);
    return historical;
  };
  adapter.stateGrouping = () => undefined;
  Object.defineProperty(adapter, 'explorationCaseRevision', { value: 'browser-branch-conditions-v1', configurable: true });
  const s = await engine.createSession({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, headless: true,
    exploration: 'representative', settleMs: 0, observeTimeoutMs: 1000, actionTimeoutMs: 2000, contextRules: [],
    pageExploration: 'all', listExploration: 'all', regionExploration: 'off', interfaceActions: [{ kind: 'click' }] });
  const first = engine.observation(s.id), firstState = store.require('state', first.stateId);
  await pageOf(engine).locator('#mode').selectOption('B'); const second = await engine.observe(s.id);
  const old = engine.getFrontier(s.id)[0];
  expect(engine.getFrontier(s.id)).toHaveLength(1); expect(old.sampling?.observationIds).toEqual([first.id, second.id]);
  adapter.explorationCase = currentCase; adapter.stateGrouping = currentGrouping;
  Object.defineProperty(adapter, 'explorationCaseRevision', { value: 'browser-branch-conditions-v2', configurable: true });
  await pageOf(engine).locator('#mode').selectOption('A'); await engine.observe(s.id);
  expect(store.require('state', first.stateId)).toEqual(firstState);
  expect(engine.observation(s.id, first.id)).toEqual(first);
  const parent = engine.getFrontier(s.id).find(f => f.id === old.id)!;
  expect(parent).toMatchObject({ status: 'superseded', attempts: [], coverage: { executionStatus: 'not_attempted' } });
  expect(parent.coverage.migratedTo).toHaveLength(2);
  expect(engine.getFrontier(s.id).filter(f => f.id !== old.id).every(f => f.coverage.executionStatus === 'not_attempted')).toBe(true);
  for (const mode of ['A', 'B']) {
    await pageOf(engine).locator('#mode').selectOption(mode); await engine.observe(s.id);
    const a = engine.actions(s.id)[0];
    expect((await engine.execute(s.id, a.id, crypto.randomUUID())).status).toBe('succeeded');
  }
  expect(await pageOf(engine).evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(['A', 'B']);
  expect(store.require<FrontierItem>('frontier', old.id).attempts).toEqual([]);
  expect(engine.getFrontier(s.id).filter(f => f.id !== old.id).map(f => f.attempts.length)).toEqual([1, 1]);
  // Manual dispatch verifies both recorded branches, without declaring discovery
  // complete or changing the session's exploration lifecycle.
  expect(engine.report(s.id).explorationAudit).toMatchObject({ discoveryComplete: false,
    counts: { retired: 1, succeeded: 2, pending: 0, blocked: 0, covered_equivalent: 0 } });
  const childIds = parent.coverage.migratedTo;
  await engine.close(); engine = new BrowserEngine({ persistence: new SqliteStore(directory) });
  await engine.reconcileSamplingScopes(s.id);
  expect(engine.getFrontier(s.id)).toHaveLength(3);
  expect(engine.getFrontier(s.id).find(f => f.id === old.id)?.coverage).toMatchObject({ executionStatus: 'not_attempted', migratedTo: childIds });
  expect(engine.observation(s.id, first.id)).toEqual(first);
});
