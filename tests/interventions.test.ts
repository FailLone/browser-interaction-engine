import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { BrowserEngine, type EngineHooks, type InterventionResponseInput, type ActionAttempt, type ExplorationGroup, type FrontierItem, type ReachResult, type Observation } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { createServer as apiServer } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';
import { reviewInterventions } from '../examples/external-interventions.js';

const reason = { source: 'upper', evidence: ['Current bounded UI inspection'] };
const html = '<section aria-label="Area"><input aria-label="Amount"><input aria-label="Search"><select aria-label="Currency"><option>A</option><option>B</option><option>C</option></select><div role="button" tabindex="0" id="custom">Unknown control</div></section>';
async function fixture(hooks: EngineHooks = {}) {
  const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const engine = new BrowserEngine({ persistence: new MemoryStore(), hooks });
  const session = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}`, headless: true, regionExploration: 'review', settleMs: 20, observeTimeoutMs: 600 });
  return { engine, sid: session.id, close: async () => { await engine.close(); await new Promise<void>(r => site.close(() => r())); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function partition(t: Fixture) {
  const m = t.engine.regionReviewMaterial(t.sid);
  await t.engine.reviewRegions(t.sid, { ...reason, observationId: m.observationId, regions: [{ key: 'area', label: 'Area', candidateIds: [m.candidates.find(c => c.label === 'Area')!.id] }] });
}
function response(t: Fixture, mode: 'all' | 'defer' | 'skip' = 'defer'): InterventionResponseInput {
  const g = t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.kind === 'reviewed-region')!;
  const item = t.engine.interventionMaterial(t.sid).items.find(i => i.subject.groupId === g.id)!;
  return { requestId: crypto.randomUUID(), interventionId: item.id, conditionKey: item.conditionKey, command: { type: 'decideExplorationGroup', groupId: g.id, revision: g.revision, decision: { ...reason, mode } } };
}

it('refreshes intervention work once for a batch while retaining every group decision event and constraint', async () => {
  const t = await fixture({ explorationScopes: actions => Array.from({length:12},(_,i)=>({key:`group-${i}`,kind:'custom',label:`Group ${i}`,conditions:{group:i},actionIds:actions.map(a=>a.id),traversalActionIds:[],evidence:[{source:'test',rule:'overlapping-scopes/v1',facts:{group:i}}]})) });
  try {
    await partition(t);
    const groups=t.engine.explorationReviewMaterial(t.sid).groups.filter(g=>g.kind==='custom');expect(groups).toHaveLength(12);
    const before=t.engine.store.events(t.sid).at(-1)!.sequence,reads=vi.spyOn(t.engine,'getFrontier');
    await t.engine.decideExplorationGroups(t.sid,groups.map((g,i)=>({groupId:g.id,revision:g.revision,decision:{...reason,mode:i===groups.length-1?'defer':'all'}})));
    await new Promise<void>(resolve=>setImmediate(resolve));
    const readCount=reads.mock.calls.length;reads.mockRestore();
    const events=t.engine.store.events(t.sid,before),material=t.engine.interventionMaterial(t.sid);
    expect(events.filter(e=>e.type==='exploration.group_decided')).toHaveLength(12);
    expect(events.filter(e=>e.type==='exploration.groups_decided')).toHaveLength(1);
    expect(events.filter(e=>e.type==='interventions.updated')).toHaveLength(1);
    expect(material.items.find(i=>i.subject.groupId===groups.at(-1)!.id)?.status).toBe('deferred');
    expect(t.engine.session(t.sid).actionCount).toBe(0);
    expect(readCount).toBe(1);
  } finally { await t.close(); }
});

it.each([false,true])('rebuilds intervention work once for many invalidated scopes, retaining grants as revoked even if capture fails=%s', async fail => {
  let epoch = 0;
  const t = await fixture({ explorationScopes: actions => Array.from({length:12},(_,i)=>({key:`changing-${i}`,kind:'custom',label:`Changing ${i}`,conditions:{epoch},actionIds:actions.map(a=>a.id),traversalActionIds:[],evidence:[{source:'test',rule:'changing-scopes/v1',facts:{epoch}}]})) });
  try {
    const groups=t.engine.explorationReviewMaterial(t.sid).groups.filter(g=>g.kind==='custom');
    await t.engine.decideExplorationGroups(t.sid,groups.map(g=>({groupId:g.id,revision:g.revision,decision:{...reason,mode:'all'}})));
    await new Promise<void>(resolve=>setImmediate(resolve));
    const before=t.engine.store.events(t.sid).at(-1)!.sequence,reads=vi.spyOn(t.engine,'getFrontier');
    epoch++;
    const hooks=t.engine as unknown as {afterCapture:(o:Observation,previous?:Observation,attemptId?:string)=>Promise<void>};
    const original=hooks.afterCapture.bind(t.engine);
    const failure=fail?vi.spyOn(hooks,'afterCapture').mockImplementationOnce(async(...args)=>{await original(...args);throw new Error('capture-finalization-failed');}):undefined;
    if(fail)await expect(t.engine.observe(t.sid)).rejects.toThrow('capture-finalization-failed');
    else await t.engine.observe(t.sid);
    failure?.mockRestore();
    const current=t.engine.observation(t.sid);
    await new Promise<void>(resolve=>setImmediate(resolve));
    const readCount=reads.mock.calls.length;reads.mockRestore();
    const events=t.engine.store.events(t.sid,before);
    expect(events.filter(e=>e.type==='exploration.group_invalidated')).toHaveLength(12);
    expect(events.filter(e=>e.type==='interventions.updated')).toHaveLength(1);
    expect(readCount).toBe(1);
    const material=t.engine.interventionMaterial(t.sid);
    expect(material.observationId).toBe(current.id);
    const fresh=t.engine.explorationReviewMaterial(t.sid).groups.filter(g=>g.kind==='custom');
    expect(fresh).toHaveLength(12);
    expect(fresh.every(g=>g.status==='pending'&&!groups.some(old=>old.id===g.id))).toBe(true);
    expect(fresh.every(g=>material.items.some(i=>i.subject.groupId===g.id&&i.status==='awaiting_decision'))).toBe(true);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
    // Failure must not leave a suppression flag that hides later changes.
    await t.engine.decideExplorationGroups(t.sid,fresh.map(g=>({groupId:g.id,revision:g.revision,decision:{...reason,mode:'defer'}})));
    expect(t.engine.interventionMaterial(t.sid).items.filter(i=>fresh.some(g=>g.id===i.subject.groupId)).every(i=>i.status==='deferred')).toBe(true);
  } finally { await t.close(); }
});

it('organizes current causes and dependencies without mutating records or granting permission', async () => {
  const t = await fixture(); try {
    const before = t.engine.store.events(t.sid).length, material = t.engine.interventionMaterial(t.sid);
    expect(t.engine.interventionMaterial(t.sid)).toEqual(material);
    expect(t.engine.store.events(t.sid)).toHaveLength(before);
    expect(material.items.filter(i => i.kind === 'region')).toHaveLength(1);
    const region = material.items.find(i => i.kind === 'region')!;
    expect(region.affected.frontierIds.length).toBeGreaterThan(1);
    const list = material.items.find(i => i.kind === 'exploration')!;
    expect(list.dependsOn).toContain(region.id); expect(material.readyIds).not.toContain(list.id);
    expect(material.items.some(i => i.kind === 'control' && i.title === 'Unknown control')).toBe(true);
    expect(new Set(material.items.map(i => i.id)).size).toBe(material.items.length);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
    expect(t.engine.store.events(t.sid).some(e => e.type === 'interventions.updated')).toBe(true);
  } finally { await t.close(); }
});

it('checks a late answer inside the queue even when the underlying group revision is still valid', async () => {
  const t = await fixture(); try {
    await partition(t); const input = response(t, 'all');
    const capture = t.engine.observe(t.sid), reply = t.engine.respondToIntervention(t.sid, input);
    await capture; const result = await reply;
    expect(result.response).toMatchObject({ status: 'rejected', error: { code: 'STALE_INTERVENTION' } });
    expect(t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.id === (input.command as any).groupId)!.decisions).toEqual([]);
    expect(result.material.observationId).toBe(t.engine.observation(t.sid).id);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  } finally { await t.close(); }
});

it('copies queued input and deduplicates concurrent and later responses without replay', async () => {
  const t = await fixture(); try {
    await partition(t); const input = response(t), original = structuredClone(input);
    const first = t.engine.respondToIntervention(t.sid, input), second = t.engine.respondToIntervention(t.sid, original);
    (input.command as any).decision.mode = 'all';
    const [a, b] = await Promise.all([first, second]);
    expect(a.response.id).toBe(b.response.id); expect(a.response.status).toBe('applied');
    expect(t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.kind === 'reviewed-region')!.decisions).toHaveLength(1);
    expect(t.engine.interventionMaterial(t.sid).items.find(i => i.id === original.interventionId)?.status).toBe('deferred');
    expect((await t.engine.respondToIntervention(t.sid, original)).response.id).toBe(a.response.id);
    expect(() => t.engine.respondToIntervention(t.sid, input)).toThrow(/Request ID/);
    expect(t.engine.store.events(t.sid).filter(e => e.type === 'interventions.responded')).toHaveLength(1);
  } finally { await t.close(); }
});

it('rejects a response that targets another scope and leaves both undecided', async () => {
  const t = await fixture(); try {
    await partition(t); const input = response(t, 'all'), other = t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.kind === 'similar-list')!;
    input.command = { type: 'decideExplorationGroup', groupId: other.id, revision: other.revision, decision: { ...reason, mode: 'all' } };
    const result = await t.engine.respondToIntervention(t.sid, input);
    expect(result.response).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INTERVENTION_RESPONSE' } });
    expect(t.engine.explorationReviewMaterial(t.sid).groups.every(g => !g.decisions.length)).toBe(true);
  } finally { await t.close(); }
});

it('keeps domain live validation and provides new material after a changed target', async () => {
  const t = await fixture(); try {
    const m = t.engine.interventionMaterial(t.sid), item = m.items.find(i => i.kind === 'control' && i.title === 'Unknown control')!;
    await pageOf(t.engine).locator('#custom').evaluate(el => el.setAttribute('aria-label', 'Replaced meaning'));
    const result = await t.engine.respondToIntervention(t.sid, { requestId: crypto.randomUUID(), interventionId: item.id, conditionKey: item.conditionKey,
      command: { type: 'reviewControls', review: { source: reason.source, observationId: m.observationId, reviews: [{ localId: item.subject.localIds![0], kind: 'click', risk: 'interface', replayable: false, reason: 'Original meaning', evidence: reason.evidence }] } } });
    expect(result.response.status).toBe('rejected'); expect(result.response.error?.code).toBe('STALE_CONTROL_REVIEW');
    expect(t.engine.list(t.sid, 'control-review')).toEqual([]);
    expect(result.material.observationId).not.toBe(m.observationId);
  } finally { await t.close(); }
});

it('records a domain failure before enqueueing without an unhandled rejection or stuck request', async () => {
  const t = await fixture(); try {
    const material = t.engine.interventionMaterial(t.sid), item = material.items[0];
    const result = await t.engine.respondToIntervention(t.sid, { requestId: 'missing-identity', interventionId: item.id, conditionKey: item.conditionKey,
      command: { type: 'resolveIdentity', hypothesisId: 'missing-hypothesis', identityId: 'missing-identity', source: reason.source, evidence: reason.evidence } });
    expect(result.response).toMatchObject({ status: 'rejected', error: { code: 'NOT_FOUND' } });
    expect(result.response.finishedAt).toBeDefined();
    await t.engine.observe(t.sid); await partition(t);
    expect((await t.engine.respondToIntervention(t.sid, response(t))).response.status).toBe('applied');
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  } finally { await t.close(); }
});

it('keeps skipped work visible and reports request retirement separately from coverage', async () => {
  const t = await fixture(); try {
    const before = t.engine.interventionMaterial(t.sid); await partition(t);
    const delta = t.engine.interventionMaterial(t.sid, before.revision);
    expect(delta.changes.retired).toContain(before.items.find(i => i.kind === 'region')!.id);
    const result = await t.engine.respondToIntervention(t.sid, response(t, 'skip'));
    expect(result.material.items.some(i => i.status === 'skipped')).toBe(true);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
    expect(t.engine.report(t.sid).completionAudit.exhaustive).toBe(false);
    expect(() => t.engine.interventionMaterial(t.sid, 'missing')).toThrow(/revision/);
  } finally { await t.close(); }
});

it('aggregates many recovery failures by the recorded root result', async () => {
  const t = await fixture(); try {
    const targets = t.engine.list<FrontierItem>(t.sid, 'frontier').slice(0, 3), o = t.engine.observation(t.sid);
    const cp = await t.engine.createCheckpoint(t.sid, 'Origin');
    const result: ReachResult = { id: 'one-root-result', sessionId: t.sid, checkpointId: cp.id, status: 'UNREACHABLE', reason: 'No verified return path', checks: [], attemptIds: [], observationId: o.id, remainingFrontier: 3, diagnostics: { strategies: ['verified-history'], dirtyActions: [], resetAvailable: false } };
    t.engine.store.put('reach', result);
    for (const f of targets) t.engine.store.put('frontier', { ...f, status: 'blocked', reason: result.reason, recovery: { resultId: result.id, diagnostics: result.diagnostics! } });
    const items = t.engine.interventionMaterial(t.sid).items.filter(i => i.subject.checkpointId === cp.id);
    expect(items).toHaveLength(1); expect(items[0].affected.frontierIds.sort()).toEqual(targets.map(f => f.id).sort());
    expect(items[0].evidence.recordIds).toContain(result.id);
  } finally { await t.close(); }
});

it('exposes the same current requests, guarded answers, and continuation through HTTP', async () => {
  const t = await fixture(), api = await apiServer(t.engine); try {
    await api.listen({ host: '127.0.0.1', port: 0 }); const client = new InteractionClient(`http://127.0.0.1:${(api.server.address() as { port: number }).port}`);
    const m = await client.interventionMaterial(t.sid), item = m.items.find(i => i.kind === 'region')!, region = await client.regionReviewMaterial(t.sid);
    const accepted = await client.respondToIntervention(t.sid, { requestId: crypto.randomUUID(), interventionId: item.id, conditionKey: item.conditionKey, command: {
      type: 'reviewRegions', review: { ...reason, observationId: m.observationId, regions: [{ key: 'area', label: 'Area', candidateIds: [region.candidates.find(c => c.label === 'Area')!.id], pageTraversal: false }] },
    } });
    expect(accepted.response.status).toBe('applied');
    const g = (await client.explorationReviewMaterial(t.sid)).groups.find(g => g.kind === 'reviewed-region')!;
    const decision = (await client.interventionMaterial(t.sid)).items.find(i => i.subject.groupId === g.id)!;
    await client.respondToIntervention(t.sid, { requestId: crypto.randomUUID(), interventionId: decision.id, conditionKey: decision.conditionKey, command: {
      type: 'decideExplorationGroup', groupId: g.id, revision: g.revision, decision: { ...reason, mode: 'sample', memberKeys: [g.members.find(m => m.label === 'Amount')!.key] },
    } });
    const continued = await client.continueExploration(t.sid, { ...reason, requestId: crypto.randomUUID(), observationId: (await client.observation(t.sid)).id });
    expect(continued.continuation.status).toBe('started'); await t.engine.waitForIdle();
    expect(t.engine.list<ActionAttempt>(t.sid, 'attempt').map(a => a.action.label)).toEqual(['Amount']);
    expect((await client.list(t.sid, 'intervention-responses')).total).toBe(2);
    expect((await client.list(t.sid, 'continuations')).total).toBe(1);
    expect((await client.interventionMaterial(t.sid)).items.some(i => i.kind === 'control')).toBe(true);
    await expect(client.command(t.sid, { type: 'respondToIntervention', response: { requestId: 'invalid', interventionId: item.id, conditionKey: item.conditionKey, command: { type: 'explore' } } })).rejects.toBeDefined();
  } finally { await api.close(); await t.close(); }
});

it('runs a bounded external review pass and continues independent work while leaving unanswered requests', async () => {
  const t = await fixture(), api = await apiServer(t.engine); try {
    await api.listen({ host: '127.0.0.1', port: 0 }); const client = new InteractionClient(`http://127.0.0.1:${(api.server.address() as { port: number }).port}`);
    const result = await reviewInterventions(client, t.sid, { decide: async item => {
      if (item.kind === 'region') {
        const m = await client.regionReviewMaterial(t.sid);
        return { type: 'reviewRegions', review: { ...reason, observationId: m.observationId, regions: [{ key: 'area', label: 'Area', candidateIds: [m.candidates.find(c => c.label === 'Area')!.id], pageTraversal: false }] } };
      }
      if (item.kind === 'exploration') {
        const g = (await client.explorationReviewMaterial(t.sid)).groups.find(g => g.id === item.subject.groupId)!;
        return { type: 'decideExplorationGroup', groupId: g.id, revision: g.revision, decision: g.kind === 'reviewed-region'
          ? { ...reason, mode: 'sample', memberKeys: [g.members.find(m => m.label === 'Amount')!.key] }
          : { ...reason, mode: 'defer' } };
      }
      return undefined;
    } });
    expect(result.continuation?.status).toBe('started'); await t.engine.waitForIdle();
    expect(t.engine.list<ActionAttempt>(t.sid, 'attempt').map(a => a.action.label)).toEqual(['Amount']);
    expect(t.engine.interventionMaterial(t.sid).items.some(i => i.status === 'deferred')).toBe(true);
  } finally { await api.close(); await t.close(); }
});

it('does not auto-refresh an answer from a slow external reviewer', async () => {
  const t = await fixture(), api = await apiServer(t.engine); try {
    await api.listen({ host: '127.0.0.1', port: 0 }); const client = new InteractionClient(`http://127.0.0.1:${(api.server.address() as { port: number }).port}`);
    const result = await reviewInterventions(client, t.sid, { decide: async () => { await client.observe(t.sid); return { type: 'observe' }; } });
    expect(result.responses).toHaveLength(1); expect(result.responses[0]).toMatchObject({ status: 'rejected', error: { code: 'STALE_INTERVENTION' } });
    expect(result.continuation).toBeUndefined(); expect(t.engine.list(t.sid, 'continuation')).toEqual([]);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  } finally { await api.close(); await t.close(); }
});
