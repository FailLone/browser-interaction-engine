import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { fixtureServer, testEngine, act, pageOf } from './helpers.js';
import type { ActionAttempt, FrontierItem, IdentityHypothesis, InteractionScope } from '@interaction/browser';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });

describe('Real Chromium interaction engine', () => {
  it('tracks portal menus, persistent selector identity and cumulative parent effects', async () => {
    const t = await testEngine(fixture.url);
    try {
      const before = t.engine.observation(t.sessionId); const selector = before.controls.find(c => c.name === 'Order type')!;
      expect((await act(t.engine, t.sessionId, 'Order type')).status).toBe('succeeded');
      const menu = t.engine.observation(t.sessionId); expect(menu.regions.some(r => r.role === 'menu')).toBe(true);
      expect((await act(t.engine, t.sessionId, 'Market')).status).toBe('succeeded');
      const market = t.engine.observation(t.sessionId);
      expect(market.controls.find(c => c.name === 'Order type')!.identityId).toBe(selector.identityId);
      expect(market.controls.some(c => c.name === 'Price')).toBe(false);
      expect(t.engine.actions(t.sessionId).some(a => a.kind === 'fill' && a.label === 'Amount')).toBe(true);
      const scopes = t.engine.list<InteractionScope>(t.sessionId, 'scope');
      expect(scopes).toHaveLength(1); expect(scopes[0].status).toBe('closed'); expect(scopes[0].attemptIds).toHaveLength(2);
      expect(scopes[0].diff!.changes.some(c => c.kind === 'disappeared')).toBe(true);
      const filled = await act(t.engine, t.sessionId, 'Amount', 'fill', '2'); expect(filled.diff?.changes.some(c => c.field === 'value')).toBe(true);
      expect(t.engine.getGraph(t.sessionId).visits.find(v => v.viaAttemptId === filled.id)?.parentId).toBe(market.visitId);
    } finally { await t.close(); }
  });
  it('matches React rebuilds and records business bindings independently', async () => {
    const t = await testEngine(fixture.url);
    try {
      const old = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Amount')!;
      const rebuilt = await act(t.engine, t.sessionId, 'Rebuild inputs');
      const next = t.engine.observation(t.sessionId).controls.find(c => c.name === 'Amount')!;
      expect(next.identityId).toBe(old.identityId); expect(next.instanceId).not.toBe(old.instanceId); expect(rebuilt.diff?.changes.some(c => c.kind === 'rebuilt')).toBe(true);
      const changed = await act(t.engine, t.sessionId, 'Trading pair', 'select', 'ETH/USDT');
      expect(changed.diff?.changes.some(c => c.kind === 'context')).toBe(true);
      expect(t.engine.observation(t.sessionId).controls.find(c => c.name === 'Amount')!.identityId).toBe(old.identityId);
      expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').some(f => f.status === 'needs_revalidation')).toBe(true);
    } finally { await t.close(); }
  });
  it('does not silently match duplicate labels and accepts sourced decisions', async () => {
    const t = await testEngine(fixture.url);
    try {
      await act(t.engine, t.sessionId, 'Duplicate controls');
      const h = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis').filter(h => h.status === 'pending'); expect(h.length).toBeGreaterThanOrEqual(2);
      const action = t.engine.actions(t.sessionId).find(a => a.label === 'Reference')!;
      await expect(t.engine.execute(t.sessionId, action.id, 'ambiguous')).rejects.toMatchObject({ code: 'IDENTITY_AMBIGUOUS' });
      const oldObservation = t.engine.observation(t.sessionId);
      await t.engine.resolveIdentity(t.sessionId, h[0].id, h[0].provisionalIdentityId, 'test-user', ['Left reference belongs to the first record']);
      expect(t.engine.observation(t.sessionId, oldObservation.id)).toEqual(oldObservation);
      expect(t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis').find(x => x.id === h[0].id)!.revisions).toHaveLength(1);
      expect(t.engine.actions(t.sessionId).some(a => a.controlId === h[0].provisionalIdentityId && a.preconditions.identityResolved)).toBe(true);
    } finally { await t.close(); }
  });
  it('merges equivalent observable states but keeps separate paths', async () => {
    const t = await testEngine(fixture.url, { replayable: [{ name: 'Quick Market' }, { name: 'Reset interface' }] });
    try {
      const initial = t.engine.observation(t.sessionId); await act(t.engine, t.sessionId, 'Order type'); await act(t.engine, t.sessionId, 'Market');
      const firstMarket = t.engine.observation(t.sessionId); await act(t.engine, t.sessionId, 'Reset interface');
      expect(t.engine.observation(t.sessionId).stateId).toBe(initial.stateId);
      expect(t.engine.observation(t.sessionId).actionDiscovery?.documentHints.some(h => h.rule === 'click-handler/v1' && h.facts.tag === 'body')).toBe(true);
      expect(t.engine.observation(t.sessionId).controls.some(c => c.tag === 'body')).toBe(false);
      await act(t.engine, t.sessionId, 'Quick Market');
      const secondMarket = t.engine.observation(t.sessionId); expect(secondMarket.stateId).toBe(firstMarket.stateId); expect(secondMarket.visitId).not.toBe(firstMarket.visitId);
    } finally { await t.close(); }
  });
  it('returns verified, acceptable, changed, unreachable and unverified recovery results', async () => {
    const t = await testEngine(fixture.url);
    try {
      const cp = await t.engine.createCheckpoint(t.sessionId, 'initial');
      expect((await t.engine.reachCheckpoint(t.sessionId, cp.id)).status).toBe('REACHED_VERIFIED');
      const acceptable = await t.engine.createCheckpoint(t.sessionId, 'accept amount changes', [], [{ target: 'url', equals: fixture.url + '/' }]);
      await act(t.engine, t.sessionId, 'Amount', 'fill', '1');
      expect((await t.engine.reachCheckpoint(t.sessionId, acceptable.id)).status).toBe('REACHED_ACCEPTABLE');
      expect((await t.engine.reachCheckpoint(t.sessionId, cp.id)).status).toBe('REACHED_VERIFIED');
      await act(t.engine, t.sessionId, 'Trading pair', 'select', 'ETH/USDT');
      expect((await t.engine.reachCheckpoint(t.sessionId, cp.id)).status).toBe('PRECONDITIONS_CHANGED');
      await act(t.engine, t.sessionId, 'Trading pair', 'select', 'BTC/USDT');
      await act(t.engine, t.sessionId, 'Submit test order');
      await act(t.engine, t.sessionId, 'Amount', 'fill', '1');
      expect((await t.engine.reachCheckpoint(t.sessionId, cp.id)).status).toBe('UNREACHABLE');
      await pageOf(t.engine).locator('#pair').evaluate(el => el.remove());
      expect((await t.engine.reachCheckpoint(t.sessionId, cp.id)).status).toBe('UNVERIFIED');
    } finally { await t.close(); }
  });
  it('replays a checkpoint path from entry and verifies each intermediate state', async () => {
    const t = await testEngine(fixture.url, { replayable: [{ name: 'Reset interface' }] });
    try {
      await act(t.engine, t.sessionId, 'Order type'); await act(t.engine, t.sessionId, 'Market');
      const cp = await t.engine.createCheckpoint(t.sessionId, 'Market'); await act(t.engine, t.sessionId, 'Reset interface');
      const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
      expect(result.status).toBe('REACHED_VERIFIED'); expect(result.attemptIds.length).toBeGreaterThanOrEqual(2);
      expect(result.attemptIds.every(id => t.engine.list<ActionAttempt>(t.sessionId, 'attempt').find(a => a.id === id)!.purpose === 'recovery')).toBe(true);
    } finally { await t.close(); }
  });
  it('rejects stale observations, records gaps and executes the same request only once', async () => {
    const t = await testEngine(fixture.url);
    try {
      const action = t.engine.actions(t.sessionId).find(a => a.label === 'Order type')!;
      await pageOf(t.engine).locator('#amount').fill('99');
      await expect(t.engine.execute(t.sessionId, action.id, 'stale')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
      const fresh = t.engine.actions(t.sessionId).find(a => a.label === 'Order type')!;
      const first = await t.engine.execute(t.sessionId, fresh.id, 'once'); const repeated = await t.engine.execute(t.sessionId, fresh.id, 'once'); expect(repeated.id).toBe(first.id);
      expect(t.engine.session(t.sessionId).actionCount).toBe(1);
      await expect(t.engine.execute(t.sessionId, fresh.id, 'once', 'different')).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
      await pageOf(t.engine).evaluate(() => { document.body.append(document.createElement('iframe'), document.createElement('canvas')); });
      const o = await t.engine.observe(t.sessionId); expect(o.gaps.map(g => g.code)).toEqual(expect.arrayContaining(['UNSUPPORTED_IFRAME', 'UNSUPPORTED_CANVAS']));
    } finally { await t.close(); }
  });
  it('runs bounded DFS and preserves exclusions and remaining work', async () => {
    const t = await testEngine(fixture.url, { maxActions: 3, exclude: [{ name: 'Submit test order' }, { name: 'Background refresh' }] });
    try {
      await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
      expect(t.engine.session(t.sessionId).actionCount).toBe(3); expect(t.engine.session(t.sessionId).stopReason).toBe('BUDGET_EXHAUSTED');
      expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(a => a.action.label === 'Submit test order')).toBe(false);
      expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier').some(f => f.status === 'pending')).toBe(true);
    } finally { await t.close(); }
  });
  it('serializes competing SDK commands and keeps the first source observation immutable', async () => {
    const t = await testEngine(fixture.url);
    try {
      const before = t.engine.observation(t.sessionId); const action = t.engine.actions(t.sessionId).find(a => a.label === 'Order type')!;
      const results = await Promise.allSettled([t.engine.execute(t.sessionId, action.id, 'writer-a'), t.engine.execute(t.sessionId, action.id, 'writer-b')]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(t.engine.session(t.sessionId).actionCount).toBe(1);
      expect(t.engine.observation(t.sessionId, before.id)).toEqual(before);
    } finally { await t.close(); }
  });
  it('isolates hook failures and publishes checker issues without model dependencies', async () => {
    const t = await testEngine(fixture.url, {}, { samples: () => { throw new Error('Sample provider offline'); }, check: (_a, ctx) => [{ source: 'example-checker', severity: 'info', message: `${ctx.observation.controls.length} controls inspected` }] });
    try {
      expect(t.engine.actions(t.sessionId).find(a => a.kind === 'fill')!.exclusionReason).toBe('samples_hook_failed');
      await act(t.engine, t.sessionId, 'Order type'); expect(t.engine.list(t.sessionId, 'issue')).toHaveLength(1);
      expect(t.engine.store.events(t.sessionId).some(e => e.type === 'hook.error')).toBe(true);
    } finally { await t.close(); }
  });
  it('detects a reused node with changed business binding and context outside controls', async () => {
    const t = await testEngine(fixture.url, { contextRules: [{ key: 'pair', selector: '#pair' }, { key: 'record', selector: 'main', attribute: 'data-record', required: true }] });
    try {
      await pageOf(t.engine).locator('main').evaluate(el => el.setAttribute('data-record', 'one')); await t.engine.observe(t.sessionId);
      const before = t.engine.observation(t.sessionId); const target = t.engine.actions(t.sessionId).find(a => a.label === 'Order type')!;
      await pageOf(t.engine).locator('main').evaluate(el => el.setAttribute('data-record', 'two'));
      await expect(t.engine.execute(t.sessionId, target.id, 'changed-context')).rejects.toMatchObject({ code: 'PRECONDITIONS_CHANGED' });
      const after = t.engine.observation(t.sessionId);
      expect(after.controls.find(c => c.name === 'Order type')?.instanceId).toBe(before.controls.find(c => c.name === 'Order type')?.instanceId);
      expect(after.context.record.value).toBe('two'); expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    } finally { await t.close(); }
  });
  it('retains unstable observations and returns an unverified checkpoint result', async () => {
    let permit = true;
    const t = await testEngine(fixture.url, { settleMs: 180, observeTimeoutMs: 700 }, { verify: () => ({ result: permit ? 'pass' : 'unknown', evidence: ['test verifier'] }) });
    try {
      await act(t.engine, t.sessionId, 'Background refresh', 'check', true);
      expect(t.engine.observation(t.sessionId).gaps.some(g => g.code === 'UNSTABLE')).toBe(true);
      const cp = await t.engine.createCheckpoint(t.sessionId, 'unstable'); permit = false;
      expect((await t.engine.reachCheckpoint(t.sessionId, cp.id)).status).toBe('UNVERIFIED');
    } finally { await t.close(); }
  });
  it('uses reset evidence before replaying a write path and persists every recovery action', async () => {
    let resets = 0;
    const t = await testEngine(fixture.url, {}, { reset: () => { resets++; return Promise.resolve({ reset: true, evidence: ['fixture business state is held in the document and resets on reload'] }); } });
    try {
      const cp = await t.engine.createCheckpoint(t.sessionId, 'initial');
      await act(t.engine, t.sessionId, 'Submit test order'); await act(t.engine, t.sessionId, 'Amount', 'fill', '1');
      const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
      expect(result.status).toBe('REACHED_VERIFIED'); expect(resets).toBe(1);
      const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
      expect(attempts.some(a => a.action.kind === 'navigate' && a.purpose === 'recovery')).toBe(true);
      expect(attempts.length).toBe(t.engine.session(t.sessionId).actionCount);
      const next = await t.engine.createCheckpoint(t.sessionId, 'new entry'); expect(next.path).toHaveLength(0);
    } finally { await t.close(); }
  });
  it('validates native input constraints and replays caller supplied values', async () => {
    const t = await testEngine(fixture.url);
    try {
      const amount = t.engine.actions(t.sessionId).find(a => a.label === 'Amount')!;
      await expect(t.engine.execute(t.sessionId, amount.id, 'invalid-amount', '-1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(t.engine.session(t.sessionId).actionCount).toBe(0);
      await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
      const cp = await t.engine.createCheckpoint(t.sessionId, 'custom input');
      await act(t.engine, t.sessionId, 'Amount', 'fill', '3');
      const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
      expect(result.status).toBe('REACHED_VERIFIED');
      expect(t.engine.observation(t.sessionId).controls.find(c => c.name === 'Amount')?.value).toBe('2');
    } finally { await t.close(); }
  });
  it('stops a replay after a divergent intermediate observation', async () => {
    const t = await testEngine(fixture.url, { replayable: [{ name: 'Reset interface' }] });
    try {
      await act(t.engine, t.sessionId, 'Order type'); await act(t.engine, t.sessionId, 'Market');
      const cp = await t.engine.createCheckpoint(t.sessionId, 'market'); await act(t.engine, t.sessionId, 'Reset interface');
      await pageOf(t.engine).locator('#order-type').evaluate(el => el.addEventListener('click', () => document.querySelector('#price')?.setAttribute('min', '9')));
      const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
      expect(result.status).toBe('UNREACHABLE'); expect(result.reason).toBe('replay_state_diverged');
      expect(result.attemptIds).toHaveLength(1);
      expect(t.engine.observation(t.sessionId).controls.some(c => c.name === 'Market')).toBe(true);
    } finally { await t.close(); }
  });
  it('starts a new visit root when reattaching a stopped session without losing its history', async () => {
    const t = await testEngine(fixture.url);
    try {
      await act(t.engine, t.sessionId, 'Order type'); await act(t.engine, t.sessionId, 'Market');
      const market = t.engine.observation(t.sessionId);
      await t.engine.stop(t.sessionId); await t.engine.observe(t.sessionId);
      expect(t.engine.session(t.sessionId).status).toBe('paused');
      const checkpoint = await t.engine.createCheckpoint(t.sessionId, 'fresh entry');
      expect(checkpoint.path).toHaveLength(0);
      expect(t.engine.observation(t.sessionId, market.id).id).toBe(market.id);
      expect(t.engine.graph(t.sessionId).visits.some(v => v.observationId === market.id)).toBe(true);
    } finally { await t.close(); }
  });
});
