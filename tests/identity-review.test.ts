import { it, expect } from 'vitest';
import { InteractionClient, prepareIdentityReview, includeIdentityImages, identityDecisionCommand } from '@interaction/client';
import type { IdentityHypothesis, SessionOptions } from '@interaction/browser';
import { fixtureServer, testEngine, pageOf } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';

async function reviewFixture(run: (t: Awaited<ReturnType<typeof testEngine>>, api: InteractionClient) => Promise<void>, options: Partial<SessionOptions> = {}) {
  const fixture = await fixtureServer();
  const t = await testEngine(`${fixture.url}/identity-review.html`, { contextRules: [], evidenceRetention: { mode: 'cache', ttlMs: 60000, maxBytes: 64 * 1024 ** 2, maxObservations: 100 }, ...options });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  try { await run(t, new InteractionClient(`http://127.0.0.1:${(app.server.address() as any).port}`)); }
  finally { await app.close(); await t.close(); await fixture.server.close(); }
}

it('exports historical declared context and actual screenshots without writing or borrowing future candidate evidence', async () => {
  await reviewFixture(async (t, api) => {
    await t.engine.observe(t.sessionId);
    const latestBefore = t.engine.observation(t.sessionId);
    await pageOf(t.engine).evaluate(() => (window as any).renderReview('R17', ['op-82', 'op-14']));
    const after = await t.engine.observe(t.sessionId);
    const h = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis').find(h => h.observationId === after.id)!;
    const eventCount = t.engine.store.events(t.sessionId).length;
    const packet = await prepareIdentityReview(api, t.sessionId, h.id);
    const targetOp = packet.target.node?.attributes?.['data-operation-key'];
    expect(targetOp).toBeTruthy();
    const same = packet.candidates.find(c => !c.simultaneous && c.exhibit.node?.attributes?.['data-operation-key'] === targetOp)!;
    expect(same.exhibit.observationId).toBe(latestBefore.id);
    expect(same.exhibit.ancestors?.some(a => a.attributes?.['data-row-key'] === 'R17')).toBe(true);
    expect(packet.timeline.note).toContain('没有已记录的触发操作');
    expect(packet.candidates.find(c => c.simultaneous)?.unavailable).toContain('不能合并');
    const withImages = await includeIdentityImages(api, packet);
    expect(withImages.images[after.id].dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(packet.images[after.id].status).toBe('reference');
    expect(t.engine.store.events(t.sessionId)).toHaveLength(eventCount);
    expect(identityDecisionCommand(packet, { decision: 'uncertain', reason: 'Cannot prove', missingEvidence: ['stable operation key'], evidenceRefs: ['target'] }, 'test')).toBeUndefined();
    expect(() => identityDecisionCommand(packet, { decision: 'same', candidateId: same.identityId, reason: 'guess', evidenceRefs: ['invented'] }, 'test')).toThrow('有效的证据');
    const peer = packet.candidates.find(c => c.simultaneous)!;
    expect(() => identityDecisionCommand(packet, { decision: 'same', candidateId: peer.identityId, reason: 'looks identical', evidenceRefs: ['target'] }, 'test')).toThrow('不能关联');
    const command = identityDecisionCommand(packet, { decision: 'same', candidateId: same.identityId, reason: 'Same declared record and immutable operation key', evidenceRefs: ['target', same.exhibit.ref] }, 'test')!;
    await api.command(t.sessionId, command); await t.engine.waitForIdle();
    expect(t.engine.observation(t.sessionId).controls.find(c => c.localId === h.localId)?.identityId).toBe(same.identityId);
    // This historical identity now has a future occurrence. Reviewing the old case must still select pre-origin evidence.
    const reread = await prepareIdentityReview(api, t.sessionId, h.id);
    expect(reread.candidates.find(c => c.identityId === same.identityId)?.exhibit.observationId).toBe(latestBefore.id);
  });
});

it('reports expired detailed evidence and blocks applying old decisions to recycled rows', async () => {
  await reviewFixture(async (t, api) => {
    const before = t.engine.observation(t.sessionId);
    await pageOf(t.engine).evaluate(() => (window as any).renderReview('R17', ['op-82', 'op-14']));
    const after = await t.engine.observe(t.sessionId);
    const h = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis').find(h => h.observationId === after.id)!;
    await t.engine.releaseEvidence(t.sessionId, before.id);
    const packet = await includeIdentityImages(api, await prepareIdentityReview(api, t.sessionId, h.id));
    const old = packet.candidates.find(c => !c.simultaneous)!;
    expect(old.exhibit.control).toBeTruthy(); expect(old.exhibit.node).toBeUndefined();
    expect(old.exhibit.gaps.join(' ')).toContain('UNAVAILABLE');
    expect(packet.images[before.id].status).toBe('unavailable');
    await pageOf(t.engine).evaluate(() => (window as any).renderReview('R99', ['op-82', 'op-14'], true));
    await t.engine.observe(t.sessionId);
    const stale = await prepareIdentityReview(api, t.sessionId, h.id);
    expect(stale.current.targetPresent).toBe(true); expect(stale.current.bindingChanged).toBe(true);
    expect(() => identityDecisionCommand(stale, { decision: 'independent', reason: 'old observation', evidenceRefs: ['target'] }, 'test')).toThrow('目标已变化');
    expect(identityDecisionCommand(stale, { decision: 'uncertain', reason: 'row changed', missingEvidence: ['current binding'], evidenceRefs: ['current'] }, 'test')).toBeUndefined();
  });
});

it('makes truncated DOM and unavailable original observations explicit without preventing abstention', async () => {
  await reviewFixture(async (t, api) => {
    const h = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis')[0];
    const packet = await prepareIdentityReview(api, t.sessionId, h.id);
    expect(packet.target.domTruncated).toBe(true);
    expect(packet.target.gaps.join(' ')).toContain('截断');
    const readObservation = api.observation.bind(api);
    api.observation = (sid, oid) => oid === h.observationId ? Promise.reject(new Error('source observation unavailable')) : readObservation(sid, oid);
    const missing = await prepareIdentityReview(api, t.sessionId, h.id);
    expect(missing.target.control).toBeUndefined();
    expect(missing.target.gaps.join(' ')).toContain('不得用当前控件替代');
    expect(identityDecisionCommand(missing, { decision: 'uncertain', reason: 'Original evidence unavailable', missingEvidence: ['original control and DOM'], evidenceRefs: ['target'] }, 'test')).toBeUndefined();
  }, { evidence: { enabled: true, maxNodes: 5, maxTextLength: 20000, maxHtmlLength: 1000000, maxDomCharacters: 4000000, maxAttributeLength: 4000, maxRuntimeEntries: 100, styles: 'none', accessibility: false, fullPageScreenshot: false } });
});

it('accepts real image references and guards HTTP decisions against newer observations', async () => {
  await reviewFixture(async (t, api) => {
    const h = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis')[0];
    const review = await prepareIdentityReview(api, t.sessionId, h.id);
    const decision = { decision: 'independent' as const, reason: 'Distinct simultaneous target', evidenceRefs: [`image:${review.target.observationId}`] };
    const command = identityDecisionCommand(review, decision, 'external-rule')!;
    expect(command.guard).toEqual({ observationId: review.current.observationId, revision: 0 });
    expect(() => identityDecisionCommand(review, { ...decision, evidenceRefs: ['image:invented'] }, 'external-rule')).toThrow('有效的证据');
    const unavailable = structuredClone(review); unavailable.images[review.target.observationId!].status = 'unavailable';
    expect(() => identityDecisionCommand(unavailable, decision, 'external-rule')).toThrow('有效的证据');
    await api.observe(t.sessionId);
    await expect(api.command(t.sessionId, command)).rejects.toMatchObject({ code: 'STALE_IDENTITY_REVIEW' });
    expect(t.engine.store.require<IdentityHypothesis>('hypothesis', h.id).status).toBe('pending');
    const fresh = await prepareIdentityReview(api, t.sessionId, h.id);
    await api.command(t.sessionId, identityDecisionCommand(fresh, decision, 'external-rule')!);
    expect(t.engine.store.require<IdentityHypothesis>('hypothesis', h.id).status).toBe('resolved');
    await expect(api.command(t.sessionId, command)).rejects.toMatchObject({ code: 'STALE_IDENTITY_REVIEW' });
    expect(t.engine.store.require<IdentityHypothesis>('hypothesis', h.id).revisions).toHaveLength(1);
  });
});

it('rejects live binding changes even when a caller bypasses the client review helper', async () => {
  await reviewFixture(async (t, api) => {
    const h = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis')[0];
    const o = t.engine.observation(t.sessionId); const target = o.controls.find(c => c.localId === h.localId)!;
    await pageOf(t.engine).locator(target.selector).evaluate(el => el.setAttribute('data-operation-key', 'changed-operation'));
    const command = { type: 'resolveIdentity' as const, hypothesisId: h.id, identityId: h.provisionalIdentityId, source: 'direct-http', evidence: ['old target'] };
    await expect(api.command(t.sessionId, command)).rejects.toMatchObject({ code: 'STALE_IDENTITY_REVIEW' });
    // After a fresh capture, the original hypothesis is still bound to the old attributes.
    await expect(t.engine.resolveIdentity(t.sessionId, h.id, h.provisionalIdentityId, 'direct-sdk', ['old target'])).rejects.toMatchObject({ code: 'STALE_IDENTITY_REVIEW' });
    expect(t.engine.store.require<IdentityHypothesis>('hypothesis', h.id).revisions).toHaveLength(0);
    expect(t.engine.store.events(t.sessionId).filter(e => e.type === 'identity.resolved')).toHaveLength(0);
  });
});

it('snapshots SDK review guards and evidence before the command waits in the queue', async () => {
  await reviewFixture(async t => {
    const h = t.engine.list<IdentityHypothesis>(t.sessionId, 'hypothesis')[0];
    const guard = { observationId: t.engine.observation(t.sessionId).id, revision: 0 }; const evidence = ['Original reviewed evidence'];
    const pending = t.engine.resolveIdentity(t.sessionId, h.id, h.provisionalIdentityId, 'sdk-reviewer', evidence, guard);
    guard.observationId = 'changed-by-caller'; evidence[0] = 'changed-by-caller';
    const result = await pending;
    expect(result.revisions[0].evidence).toEqual(['Original reviewed evidence']);
  });
});
