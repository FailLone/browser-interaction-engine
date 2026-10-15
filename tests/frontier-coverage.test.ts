import { expect, it } from 'vitest';
import type { ActionAttempt, FrontierItem } from '@interaction/core';
import { describeFrontier, groupFrontier } from '../packages/core/src/frontier.js';
import { InteractionClient } from '@interaction/client';
import { createServer } from '../apps/server/src/server.js';
import { act, fixtureServer, testEngine } from './helpers.js';

it('exposes an untested input sample separately from successful work on the same control through SDK, HTTP, hooks and reports', async () => {
  const fixture = await fixtureServer(); let initialState = ''; const chosenUnits: string[] = [];
  // Force historical work to exercise recovery; entry-page scheduling has separate coverage.
  const t = await testEngine(fixture.url, { contextRules: [], pageExploration: 'all' }, { choose: items => {
    const sample = items.find(f => f.stateId === initialState && f.action.label === 'Amount' && f.action.value === '0.001');
    if (sample) chosenUnits.push(sample.coverage.unit);
    return sample?.id ?? null;
  } });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${(app.server.address() as any).port}`);
  try {
    initialState = t.engine.observation(t.sessionId).stateId;
    const checkpoint = await t.engine.createCheckpoint(t.sessionId, 'initial');
    await act(t.engine, t.sessionId, 'Amount', 'fill', '2');
    expect((await t.engine.reachCheckpoint(t.sessionId, checkpoint.id)).status).toBe('REACHED_VERIFIED');
    await act(t.engine, t.sessionId, 'Submit test order');
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const rawBefore = t.engine.store.list<FrontierItem>('frontier', t.sessionId);
    const views = t.engine.getFrontier(t.sessionId);
    const sample = views.find(f => f.stateId === initialState && f.action.label === 'Amount' && f.action.value === '0.001')!;
    const success = views.find(f => f.stateId === initialState && f.action.label === 'Amount' && f.action.value === '2')!;
    expect(sample).toMatchObject({ status: 'blocked', attempts: [], coverage: { unit: 'input_sample', executionStatus: 'not_attempted' } });
    expect(sample.reason).toContain('Cannot restore checkpoint');
    expect(success).toMatchObject({ status: 'executed', coverage: { groupId: sample.coverage.groupId, executionStatus: 'succeeded' } });
    expect(success.action.controlId).toBe(sample.action.controlId);
    expect(chosenUnits).toEqual(['input_sample']);
    const group = (await client.frontierCoverage(t.sessionId)).find(g => g.id === sample.coverage.groupId)!;
    expect(group).toMatchObject({ coverageStatus: 'partial', counts: { executed: 1, blocked: 1 } });
    expect(group.items).toContainEqual(sample);
    const state = group.states.find(s => s.stateId === sample.stateId)!;
    expect(state.status).toBe('available');
    expect(state.facts).toContainEqual(expect.objectContaining({ label: 'Trading pair', value: 'BTC/USDT' }));
    expect(state.facts).toContainEqual(expect.objectContaining({ label: 'Amount', value: '' }));
    expect(state.facts).toContainEqual(expect.objectContaining({ label: 'Price', value: '' }));
    const page = await client.frontier(t.sessionId, { status: 'blocked', limit: 1 });
    const blocked = views.filter(f => f.status === 'blocked');
    expect(page.items).toEqual(blocked.slice(0, 1));
    expect(page.total).toBe(blocked.length);
    const samplePage = await client.frontier(t.sessionId, { status: 'blocked', offset: blocked.findIndex(f => f.id === sample.id), limit: 1 });
    expect(samplePage.items).toEqual([sample]);
    expect(t.engine.list(t.sessionId, 'frontier')).toEqual(views);
    expect(t.engine.frontierCoverage(t.sessionId)).toEqual(await client.frontierCoverage(t.sessionId));
    const report = (await app.inject(`/v1/sessions/${t.sessionId}/report`)).json();
    expect(report.frontierCoverage.find((g: { id: string }) => g.id === group.id)).toMatchObject({ coverageStatus: 'partial', counts: group.counts });
    expect(report.frontierCoverage.find((g: { id: string }) => g.id === group.id).states).toBeUndefined();
    expect(t.engine.store.list('frontier', t.sessionId)).toEqual(rawBefore);
  } finally { await app.close(); await t.close(); await fixture.server.close(); }
});

const item = (id: string, value: FrontierItem['action']['value'] = '0.001'): FrontierItem => ({
  id, sessionId: 's', key: id, stateId: 'initial', contextKey: '{}', status: 'blocked', reason: 'depth_budget', attempts: [], depth: 0,
  action: { id, sessionId: 's', observationId: 'o', stateId: 'initial', controlId: 'amount', kind: 'fill', label: 'Amount', value,
    preconditions: { context: {}, visible: true, enabled: true, identityResolved: true }, replayable: true, risk: 'interface', source: 'test', excluded: false, sampleValidity: 'known' },
});

it('keeps state/context/value cases distinct and does not merge different or unidentified controls by label', () => {
  const first = item('first', ''); const next = item('next', 0); next.stateId = next.action.stateId = 'other';
  next.contextKey = 'changed'; next.action.preconditions.context = { pair: { value: 'ETH', status: 'known', source: 'test' } };
  const other = item('other', false); other.action.controlId = 'other-amount';
  const missing1 = item('missing1', null); delete missing1.action.controlId;
  const missing2 = item('missing2'); delete missing2.action.controlId; delete missing2.action.value;
  const click = item('click'); click.action.kind = 'click';
  const views = describeFrontier([first, next, other, missing1, missing2, click], []);
  const groups = groupFrontier(views);
  expect(groups).toHaveLength(5);
  expect(groups[0]).toMatchObject({ coverageStatus: 'not_attempted', counts: { total: 2, blocked: 2, notAttempted: 2 } });
  expect(groups[0].items.map(f => [f.stateId, f.contextKey, f.action.value])).toEqual([['initial', '{}', ''], ['other', 'changed', 0]]);
  expect(views[2].action.value).toBe(false); expect(views[3].action.value).toBeNull(); expect(views[4].action.value).toBeUndefined();
  expect(views[5].coverage.unit).toBe('action_case');
});

it('does not label failed, interrupted, or missing attempt evidence as never tested, and preserves revalidation', () => {
  const failed = item('failed'); failed.attempts = ['a'];
  const interrupted = item('interrupted'); interrupted.status = 'unknown';
  const missing = item('missing'); missing.attempts = ['missing-attempt'];
  const success = item('success'); success.status = 'executed';
  const stale = item('stale'); stale.status = 'needs_revalidation'; stale.attempts = ['b'];
  const attempts = [{ id: 'a', status: 'failed' }, { id: 'b', status: 'succeeded' }] as ActionAttempt[];
  const views = describeFrontier([failed, interrupted, missing, success, stale], attempts);
  expect(views.map(f => f.coverage.executionStatus)).toEqual(['failed', 'unknown', 'unknown', 'succeeded', 'succeeded']);
  expect(groupFrontier(views)[0]).toMatchObject({ coverageStatus: 'partial', counts: { total: 5, executed: 1, notAttempted: 0 } });
  expect(groupFrontier([views[0]])[0].coverageStatus).toBe('attempted');
  expect(groupFrontier([views[3]])[0].coverageStatus).toBe('complete');
  expect(groupFrontier([views[4]])[0].coverageStatus).toBe('attempted');
});
