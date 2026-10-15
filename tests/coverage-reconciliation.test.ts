import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, reconcileCoverage, type ActionAttempt, type ActionCandidate, type FrontierItem,
  type IdentityHypothesis, type Observation, type Session } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { controlCase } from '../packages/adapter-playwright/src/exploration.js';
import { pageOf } from './helpers.js';
import { InteractionClient, prepareIdentityReview, identityDecisionCommand } from '@interaction/client';
import { createServer as createApi } from '../apps/server/src/server.js';

async function fixture(html: string) {
  const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  const s = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}`, headless: true,
    exploration: 'controls', settleMs: 30, observeTimeoutMs: 600, contextRules: [] });
  return { engine, sid: s.id, close: async () => { await engine.close(); await new Promise<void>(r => site.close(() => r())); } };
}
const reason = ['Verified the retained operation key and owner in both observations'];

it('reconciles successful current-instance work after identity decisions and rebuilds without redispatch or rewriting history', async () => {
  const t = await fixture('<section><button data-operation-key="a">Run</button><button data-operation-key="b">Run</button></section>');
  try {
    const initial = t.engine.observation(t.sid), saved = structuredClone(initial);
    expect(initial.controls.map(c => c.hypothesisId).filter(Boolean)).toHaveLength(2);
    const [a, b] = initial.controls;
    const execute = (localId: string) => t.engine.execute(t.sid, t.engine.actions(t.sid).find(a => a.localId === localId && a.kind === 'click')!.id, crypto.randomUUID());
    await execute(a.localId);
    // A direct API caller must not merge two simultaneous controls, even after one disappears.
    await expect(t.engine.resolveIdentity(t.sid, a.hypothesisId!, b.identityId!, 'test', reason)).rejects.toMatchObject({ code: 'INVALID_RESOLUTION' });
    for (const c of initial.controls) await t.engine.resolveIdentity(t.sid, c.hypothesisId!, c.identityId!, 'test', reason);
    await pageOf(t.engine).evaluate(() => document.querySelectorAll('button').forEach(c => c.replaceWith(c.cloneNode(true))));
    const rebuilt = await t.engine.observe(t.sid);
    const [newA, newB] = rebuilt.controls;
    expect(newA.hypothesisId).toBeTruthy(); expect(newB.hypothesisId).toBeTruthy();
    const queue = t.engine.explorationReviewMaterial(t.sid).identityReviews;
    expect(queue.find(r => r.hypothesisId === newA.hypothesisId)).toMatchObject({ observationId: rebuilt.id, currentLocalIds: [newA.localId], frontierIds: expect.any(Array) });
    await execute(newB.localId);
    await t.engine.resolveIdentity(t.sid, newB.hypothesisId!, b.identityId!, 'test', reason);
    await t.engine.resolveIdentity(t.sid, newA.hypothesisId!, a.identityId!, 'test', reason);
    expect(t.engine.explorationReviewMaterial(t.sid).identityReviews).toEqual([]);
    const raw = t.engine.store.list('frontier', t.sid);
    const views = t.engine.getFrontier(t.sid);
    expect(views.filter(f => f.coverage.equivalentTo).length).toBeGreaterThan(0);
    expect(views.filter(f => f.coverage.equivalentTo).every(f => !f.attempts.length && f.coverage.executionStatus === 'not_attempted')).toBe(true);
    expect(t.engine.report(t.sid).explorationAudit.counts.covered_equivalent).toBeGreaterThan(0);
    expect(t.engine.controlCoverage(t.sid).counts).toMatchObject({ actionable: 2, covered: 2, incomplete: 0 });
    expect(t.engine.store.list('frontier', t.sid)).toEqual(raw);
    expect(t.engine.observation(t.sid, initial.id)).toEqual(saved);
    await t.engine.explore(t.sid); await t.engine.waitForIdle();
    expect(t.engine.session(t.sid)).toMatchObject({ actionCount: 2, stopReason: 'known_frontier_exhausted' });
    expect(t.engine.report(t.sid).explorationAudit.status).toBe('complete');
  } finally { await t.close(); }
});

it('keeps equivalent repeated reviews in one case while requiring a fresh review after node replacement', async () => {
  const t = await fixture('<div id="custom" style="cursor:pointer">Inspect</div>');
  const review = async () => {
    const o = t.engine.observation(t.sid), c = o.controls.find(c => c.stableKey === 'id:custom')!;
    await t.engine.reviewControls(t.sid, { observationId: o.id, source: 'test', reviews: [{ localId: c.localId, kind: 'click', risk: 'interface', reason: 'Inspect control', evidence: ['Observed local inspection handler'] }] });
  };
  try {
    await review(); const action = t.engine.actions(t.sid).find(a => a.source === 'control-review')!;
    await t.engine.execute(t.sid, action.id, 'first'); await review();
    expect(t.engine.getFrontier(t.sid).filter(f => f.action.controlId)).toHaveLength(1);
    await pageOf(t.engine).evaluate(() => { const c = document.querySelector('#custom')!; c.replaceWith(c.cloneNode(true)); });
    await t.engine.observe(t.sid);
    expect(t.engine.actions(t.sid).some(a => a.source === 'control-review')).toBe(false);
    await review();
    expect(t.engine.getFrontier(t.sid).filter(f => f.action.controlId)).toHaveLength(1);
    expect(t.engine.session(t.sid).actionCount).toBe(1);
  } finally { await t.close(); }
});

it('lets the caller resolve retained historical identity evidence after the target disappears through the public API', async () => {
  const t = await fixture('<section><button data-operation-key="a">Run</button><button data-operation-key="b">Run</button></section>');
  const server = await createApi(t.engine); await server.listen({ host: '127.0.0.1', port: 0 });
  const api = new InteractionClient(`http://127.0.0.1:${(server.server.address() as { port: number }).port}`);
  try {
    const first = t.engine.observation(t.sid);
    for (const c of first.controls) await t.engine.resolveIdentity(t.sid, c.hypothesisId!, c.identityId!, 'test', reason);
    await pageOf(t.engine).evaluate(() => document.querySelectorAll('button').forEach(c => c.replaceWith(c.cloneNode(true))));
    const rebuilt = await t.engine.observe(t.sid), target = rebuilt.controls[0];
    await t.engine.execute(t.sid, t.engine.actions(t.sid).find(a => a.localId === target.localId && a.kind === 'click')!.id, 'before-removal');
    await pageOf(t.engine).evaluate(() => document.querySelector('button')!.remove()); await t.engine.observe(t.sid);
    const material = await api.explorationReviewMaterial(t.sid);
    expect(material.identityReviews.find(r => r.hypothesisId === target.hypothesisId)).toMatchObject({ currentLocalIds: [], observationId: rebuilt.id });
    const packet = await prepareIdentityReview(api, t.sid, target.hypothesisId!);
    const same = packet.candidates.find(c => c.identityId === first.controls[0].identityId)!;
    expect(packet.current.targetPresent).toBe(false);
    expect(packet.target.node?.attributes?.['data-operation-key']).toBe(same.exhibit.node?.attributes?.['data-operation-key']);
    const command = identityDecisionCommand(packet, { decision: 'same', candidateId: same.identityId, evidenceRefs: ['target', same.exhibit.ref], reason: reason[0] }, 'test')!;
    await api.command(t.sid, command);
    expect((await api.explorationReviewMaterial(t.sid)).identityReviews.some(r => r.hypothesisId === target.hypothesisId)).toBe(false);
    expect(t.engine.observation(t.sid).controls.some(c => c.identityId === first.controls[0].identityId)).toBe(false);
    expect(t.engine.session(t.sid).actionCount).toBe(1);
    expect(t.engine.getFrontier(t.sid).some(f => f.coverage.equivalentTo?.identityId === first.controls[0].identityId)).toBe(true);
    // Historical coexistence still forbids merging the removed target with its peer.
    await expect(t.engine.resolveIdentity(t.sid, target.hypothesisId!, rebuilt.controls[1].identityId!, 'test', reason)).rejects.toMatchObject({ code: 'INVALID_RESOLUTION' });
  } finally { await server.close(); await t.close(); }
});

it('never transfers coverage across pending identities, input samples, conditions, missing evidence or failed attempts', async () => {
  const t = await fixture('<input id="quantity" aria-label="Quantity" min="0" max="10">');
  try {
    const a = t.engine.actions(t.sid).find(a => a.kind === 'fill')!;
    await t.engine.execute(t.sid, a.id, 'sample', '3');
    const attempt = t.engine.list<ActionAttempt>(t.sid, 'attempt')[0];
    const observations = t.engine.list<Observation>(t.sid, 'observation');
    const source = observations.find(o => o.id === attempt.beforeId)!;
    const session = t.engine.session(t.sid);
    const next = structuredClone(source); next.id = 'rebuilt'; next.controls[0].instanceId = next.controls[0].localId = 'rebuilt:node';
    const action: ActionCandidate = { ...attempt.action, id: 'new-action', observationId: next.id, localId: next.controls[0].localId };
    const f: FrontierItem = { id: 'case', sessionId: t.sid, key: 'new-case', stateId: next.stateId, contextKey: '{}', action, status: 'blocked', attempts: [], depth: 0 };
    const evaluate = (o = next, item = f, history = observations, successes = [attempt], hypotheses: IdentityHypothesis[] = [], s: Session = session) =>
      reconcileCoverage(s, [item], successes, [...history, o], hypotheses, controlCase);
    expect(evaluate().get('case')?.attemptId).toBe(attempt.id);
    expect(evaluate(next, { ...f, action: { ...action, value: '4' } }).size).toBe(0);
    expect(evaluate(next, { ...f, attempts: ['failed'] }, observations, [attempt, { ...attempt, id: 'failed', status: 'failed' }]).size).toBe(0);
    expect(evaluate(next, f, observations.filter(o => o.id !== attempt.afterId)).size).toBe(0);
    expect(evaluate(next, f, observations, [{ ...attempt, status: 'unknown' }]).size).toBe(0);
    expect(evaluate(next, f, observations, [attempt], [], { ...session, options: { ...session.options, exploration: 'stateful' } }).size).toBe(0);
    for (const change of [
      (o: Observation) => { o.controls[0].constraints.max = '20'; },
      (o: Observation) => { o.controls[0].stableKey = 'other'; },
      (o: Observation) => { o.controls[0].hypothesisId = 'pending'; },
      (o: Observation) => { o.controls[0].identityScope = 'instance'; },
      (o: Observation) => { o.url += '?mode=other'; },
      (o: Observation) => { o.gaps.push({ code: 'missing', message: 'Missing target evidence', critical: true }); },
      (o: Observation) => { o.context.market = { value: 'other', status: 'known', source: 'test' }; },
    ]) { const altered = structuredClone(next); change(altered); expect(evaluate(altered).size).toBe(0); }
    expect(evaluate(next, { ...f, action: { ...action, risk: 'submission' } }).size).toBe(0);
  } finally { await t.close(); }
});
