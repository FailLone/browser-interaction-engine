import { afterAll, beforeAll, expect, it } from 'vitest';
import { sessionSchema } from '@interaction/adapter-playwright';
import type { ActionAttempt, FrontierItem, ReachResult } from '@interaction/browser';
import { testSiteProfile } from '../examples/test-site-profile.js';
import { createServer } from '../apps/server/src/server.js';
import { act, fixtureServer, pageOf, testEngine } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });

it('samples ordinary field values without duplicating the page or rewriting actual execution evidence', async () => {
  expect(sessionSchema.parse({ url: fixture.url }).exploration).toBe('representative');
  const t = await testEngine(fixture.url, { exploration: 'representative', contextRules: [] });
  const app = await createServer(t.engine);
  try {
    const before = t.engine.observation(t.sessionId);
    const initialCount = t.engine.getFrontier(t.sessionId).length;
    await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
    expect(t.engine.getFrontier(t.sessionId)).toHaveLength(initialCount + 1); // the explicit extra sample only
    expect(t.engine.getFrontier(t.sessionId).filter(f => f.action.label === 'Amount' && f.action.value === '0.001')).toHaveLength(1);
    const check = await act(t.engine, t.sessionId, 'Post only', 'check', true);
    await act(t.engine, t.sessionId, 'Amount', 'fill', '3');
    const sample = t.engine.getFrontier(t.sessionId).find(f => f.attempts.includes(check.id))!;
    expect(sample.action.observationId).toBe(check.beforeId);
    expect(sample.stateId).toBe(check.action.stateId);
    expect(sample.sampling!.observationIds.length).toBeGreaterThan(1);
    expect(sample.coverage.executionStatus).toBe('succeeded');
    expect(t.engine.observation(t.sessionId, before.id)).toEqual(before);
    expect(t.engine.observation(t.sessionId).stateId).not.toBe(before.stateId);
    const apiSample = (await app.inject(`/v1/sessions/${t.sessionId}/frontier`)).json().items.find((f: FrontierItem) => f.id === sample.id);
    expect(apiSample).toEqual(sample);
    expect(t.engine.report(t.sessionId).coverage).toContain('field combinations');
  } finally { await app.close(); await t.close(); }
});

it('retains distinct samples when constraints, structure, or declared business context changes', async () => {
  const t = await testEngine(fixture.url, { exploration: 'representative', contextRules: [] });
  try {
    await act(t.engine, t.sessionId, 'Trading pair', 'select', 'ETH/USDT');
    const amounts = t.engine.getFrontier(t.sessionId).filter(f => f.action.label === 'Amount');
    expect(amounts.map(f => f.action.value).sort()).toEqual(['0.001', '0.01']);
    await act(t.engine, t.sessionId, 'Quick Market');
    expect(t.engine.getFrontier(t.sessionId).filter(f => f.action.label === 'Amount' && f.action.value === '0.01')).toHaveLength(2);
  } finally { await t.close(); }
  const contextual = await testEngine(fixture.url, { exploration: 'representative' });
  try {
    await act(contextual.engine, contextual.sessionId, 'Trading pair', 'select', 'ETH/USDT');
    expect(contextual.engine.getFrontier(contextual.sessionId).filter(f => f.action.label === 'Other settings')).toHaveLength(2);
  } finally { await contextual.close(); }
});

it('keeps stateful exploration and legacy sessions on strict per-state cases', async () => {
  const t = await testEngine(fixture.url, { contextRules: [] });
  try {
    const s = t.engine.session(t.sessionId); delete s.options.exploration; t.engine.store.put('session', s);
    const before = t.engine.getFrontier(t.sessionId).length;
    await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
    expect(t.engine.getFrontier(t.sessionId).length).toBeGreaterThan(before + 1);
    expect(t.engine.getFrontier(t.sessionId).every(f => !f.sampling)).toBe(true);
  } finally { await t.close(); }
});

it('restores declared reversible fields locally with full verification and a durable recovery ledger', async () => {
  const t = await testEngine(fixture.url, { ...testSiteProfile });
  try {
    const original = t.engine.observation(t.sessionId);
    const cp = await t.engine.createCheckpoint(t.sessionId, 'entry');
    await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
    await act(t.engine, t.sessionId, 'Price', 'fill', '3');
    await act(t.engine, t.sessionId, 'Rebuild inputs');
    expect(t.engine.session(t.sessionId).dirty).toBe(false);
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).toBe('REACHED_VERIFIED');
    expect(t.engine.observation(t.sessionId).documentId).toBe(original.documentId);
    expect(t.engine.observation(t.sessionId).canonical).toBe(original.canonical);
    expect(result.attemptIds).toHaveLength(2);
    const attempts = result.attemptIds.map(id => t.engine.list<ActionAttempt>(t.sessionId, 'attempt').find(a => a.id === id)!);
    expect(attempts.every(a => a.purpose === 'recovery' && a.action.source === 'recovery-local')).toBe(true);
    expect(result.diagnostics?.strategies).toContain('declared_local_restore');
  } finally { await t.close(); }
});

it('stops a declared inverse on unexpected effects instead of accepting the target field alone', async () => {
  const t = await testEngine(fixture.url, { reversible: [{ stableKey: 'id:amount' }], contextRules: [] });
  try {
    const cp = await t.engine.createCheckpoint(t.sessionId, 'entry');
    await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
    await pageOf(t.engine).evaluate(() => {
      document.querySelector('#amount')!.addEventListener('input', () => { (document.querySelector('#post-only') as HTMLInputElement).checked = true; });
    });
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).toBe('UNVERIFIED');
    expect(result.reason).toContain('restoration diverged');
    expect(result.attemptIds).toHaveLength(1);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(a => a.action.source === 'recovery-entry')).toBe(false);
  } finally { await t.close(); }
});

it('reports the actual unknown action that blocked recovery and does not assume reload resets business state', async () => {
  const t = await testEngine(fixture.url, { contextRules: [] });
  try {
    const cp = await t.engine.createCheckpoint(t.sessionId, 'entry');
    await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
    const rebuild = await act(t.engine, t.sessionId, 'Rebuild inputs');
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).toBe('UNREACHABLE');
    expect(result.diagnostics).toMatchObject({ resetAvailable: false, dirtyActions: [{ attemptId: rebuild.id, label: 'Rebuild inputs', risk: 'unknown' }] });
    expect(result.attemptIds).toHaveLength(0);
  } finally { await t.close(); }
});

it('executes a configured document reset once, verifies it, and clears only reset-confirmed dirty origins', async () => {
  const t = await testEngine(fixture.url, { contextRules: [], maxActions: 3, environmentReset: 'document-reload', interfaceActions: [{ stableKey: 'id:submit' }] });
  try {
    const cp = await t.engine.createCheckpoint(t.sessionId, 'entry');
    const submit = await act(t.engine, t.sessionId, 'Submit test order');
    expect(submit.action.risk).toBe('submission'); // cannot downgrade an actual form submission
    await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).toBe('REACHED_VERIFIED');
    expect(result.attemptIds).toHaveLength(1);
    expect(t.engine.session(t.sessionId).actionCount).toBe(3);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').find(a => a.id === result.attemptIds[0])!.action.source).toBe('recovery-reset');
    expect(await pageOf(t.engine).getByLabel('Submitted orders').innerText()).toBe('Submitted orders: 0');
    expect(t.engine.session(t.sessionId)).toMatchObject({ dirty: false, dirtyAttemptIds: [] });
    expect(t.engine.store.events(t.sessionId).some(e => e.type === 'environment.reset')).toBe(true);
    expect((await t.engine.createCheckpoint(t.sessionId, 'fresh')).path).toEqual([]);
  } finally { await t.close(); }
});

it('does not bypass action budgets during local restoration', async () => {
  const t = await testEngine(fixture.url, { ...testSiteProfile, maxActions: 1 });
  try {
    const cp = await t.engine.createCheckpoint(t.sessionId, 'entry');
    await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).toBe('UNREACHABLE');
    expect(result.attemptIds).toEqual([]);
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
  } finally { await t.close(); }
});

it('preserves boundary depth limits in representative mode while allowing verified exits', async () => {
  const t = await testEngine(fixture.url, { ...testSiteProfile, maxDepth: 1 }, { choose: items => items.find(f => f.action.label === 'Other settings')?.id || items.find(f => f.action.boundary?.intent === 'exit')?.id || null });
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.getFrontier(t.sessionId).find(f => f.action.label === 'Time in force')).toMatchObject({ status: 'blocked', reason: 'depth_budget', depth: 1 });
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt').some(a => a.action.label === 'Done')).toBe(true);
  } finally { await t.close(); }
});

it('finishes the declared ordinary test-site scope within the default action budget', async () => {
  const t = await testEngine(fixture.url, { ...testSiteProfile, evidence: { enabled: false } as any });
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const report = t.engine.report(t.sessionId);
    const remaining = t.engine.getFrontier(t.sessionId).filter(f => !f.action.excluded && f.action.basis?.status !== 'tentative' && f.status !== 'executed');
    expect({ stop: report.session.stopReason, remaining: remaining.map(f => ({ label: f.action.label, reason: f.reason, state: f.stateId })) }).toEqual({ stop: 'known_frontier_exhausted_with_gaps', remaining: [] });
    expect(report.session.actionCount).toBeLessThan(100);
    expect(t.engine.list<ReachResult>(t.sessionId, 'reach').every(r => r.status === 'REACHED_VERIFIED')).toBe(true);
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt').filter(a => a.purpose === 'exploration');
    expect(attempts.some(a => a.action.label === 'Market')).toBe(true);
    expect(attempts.some(a => a.action.label === 'Time in force')).toBe(true);
    expect(attempts.some(a => a.action.risk === 'submission')).toBe(true);
    const firstWrite = attempts.findIndex(a => a.action.risk !== 'interface');
    expect(attempts.slice(firstWrite).every(a => a.action.risk !== 'interface')).toBe(true);
  } finally { await t.close(); }
});
