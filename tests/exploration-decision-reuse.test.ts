import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '@interaction/storage-sqlite';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, currentExplorationDecision, type ActionAttempt, type EngineHooks, type ExplorationDecisionReuseRecord, type ExplorationGroup, type ExplorationGroupDecision, type ReuseExplorationDecisionsInput } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { createServer as apiServer } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';
const reason = { source: 'upper', evidence: ['Reviewed the current UI operations'] };
const scope = 'Public UI inspection';
const markup = '<section id="area" aria-label="Area"><input id="a" aria-label="Amount"><input id="b" aria-label="Search"></section>';
class TestEngine extends BrowserEngine { dispatch(sid: string, actionId: string) { return this.runAction(sid, actionId, 'prepared', undefined, 'exploration'); } }
async function fixture(hooks: EngineHooks = {}, store: MemoryStore | SqliteStore = new MemoryStore(), html = markup) {
  const site = createServer((req,res) => {res.setHeader('Content-Type','text/html'); res.end(req.url === '/b' ? '<input aria-label="Destination">' : html);});
  await new Promise<void>(r => site.listen(0,'127.0.0.1',r));
  const url = `http://127.0.0.1:${(site.address() as {port:number}).port}/a`;
  const engine = new TestEngine({ persistence: store, hooks });
  const session = await engine.createSession({url,headless:true,regionExploration:'review',settleMs:25,observeTimeoutMs:700,exploration:'controls'});
  return {engine,sid:session.id,url,close:async()=>{await engine.close(); await new Promise<void>(r=>site.close(()=>r()));}};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const group = (t: Fixture) => t.engine.explorationReviewMaterial(t.sid).groups.find(g=>g.kind==='reviewed-region' && g.label==='Area')!;
async function initial(t: Fixture, mode: ExplorationGroupDecision['mode']='sample') {
  const m = t.engine.regionReviewMaterial(t.sid);
  await t.engine.reviewRegions(t.sid,{observationId:m.observationId,...reason,regions:[{key:'area',label:'Area',candidateIds:[m.candidates.find(c=>c.label==='Area')!.id],reuse:{binding:'same-url-context',businessScope:scope}}]});
  const g = group(t), selected = g.members.filter(m=>m.label==='Amount');
  await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,mode==='sample'?{...reason,mode,memberKeys:[selected[0].key]}:{...reason,mode});
  return t.engine.reviewExplorationDecisionReuse(t.sid,{...reason,observationId:t.engine.observation(t.sid).id,groupId:g.id,revision:group(t).revision,businessScope:scope});
}
async function returned(t: Fixture) {
  await pageOf(t.engine).goto(t.url.replace('/a','/b')); await t.engine.observe(t.sid);
  await pageOf(t.engine).goto(t.url); await t.engine.observe(t.sid);
  const m = t.engine.regionReviewMaterial(t.sid), c = m.reuseCandidates!.find(c=>c.regionKey==='area')!;
  await t.engine.reuseRegionReviews(t.sid,{...reason,observationId:m.observationId,baseReviewId:m.review!.id,businessScope:scope,regions:[{reviewId:c.reviewId,regionKey:c.regionKey,conditionKey:c.conditionKey}]});
}
function proposal(t: Fixture, reviewId?:string): ReuseExplorationDecisionsInput {
  const m = t.engine.explorationDecisionReuseMaterial(t.sid), c = m.candidates.find(c=>!reviewId || c.reviewId===reviewId)!;
  expect(c,JSON.stringify(m.unavailable)).toBeDefined();
  return {...reason,observationId:m.observationId,businessScope:scope,decisions:[{reviewId:c.reviewId,groupId:c.groupId,revision:c.revision,conditionKey:c.conditionKey}]};
}
async function skipDestination(t: Fixture) {
  const pages = t.engine.explorationReviewMaterial(t.sid).groups.filter(g=>g.kind==='page');
  for(const g of pages) await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...reason,mode:'skip'});
}

it('keeps returned A pending until explicit reuse, maps exact samples, then resumes DFS without testing B',async()=>{
  const t=await fixture();try{
    const source=await initial(t); const old=group(t);
    await returned(t); await skipDestination(t); const current=group(t);
    expect(current.id).not.toBe(old.id);expect(current.decisions).toEqual([]);
    const candidate=t.engine.explorationDecisionReuseMaterial(t.sid).candidates[0];
    expect(candidate.mapping.filter(m=>m.selected)).toMatchObject([{label:'Amount',kind:'fill',value:old.members.find(m=>m.key===(source.decision as any).memberKeys[0])!.value}]);
    expect(candidate.mapping.every(m=>m.previousActionId!==m.actionId)).toBe(true);
    await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(t.engine.session(t.sid).actionCount).toBe(0);
    const before=t.engine.getFrontier(t.sid).map(f=>f.attempts).flat();
    await t.engine.reuseExplorationDecisions(t.sid,proposal(t));
    expect(t.engine.getFrontier(t.sid).map(f=>f.attempts).flat()).toEqual(before);
    expect(group(t).decisions.at(-1)?.reusedFrom?.reviewId).toBe(source.id);
    await t.engine.explore(t.sid);await t.engine.waitForIdle();
    const attempts=t.engine.list<ActionAttempt>(t.sid,'attempt');expect(attempts).toHaveLength(1);expect(attempts[0]).toMatchObject({purpose:'exploration',status:'succeeded',action:{label:'Amount'}});
    expect(t.engine.store.events(t.sid).some(e=>e.type==='exploration.decision_reuse_requested')).toBe(true);
  }finally{await t.close();}
});

for(const mode of ['all','defer','skip'] as const) it(`explicitly reuses ${mode} while preserving its meaning`,async()=>{
  const t=await fixture();try{
    await initial(t,mode);await returned(t);await skipDestination(t);await t.engine.reuseExplorationDecisions(t.sid,proposal(t));
    expect(currentExplorationDecision(group(t))?.decision.mode).toBe(mode);
    await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(t.engine.session(t.sid).actionCount).toBe(mode==='all'?2:0);
  }finally{await t.close();}
});

it('revokes descendants, never falls back to an older grant, and accepts a fresh decision to resume',async()=>{
  const t=await fixture();try{
    const source=await initial(t);await returned(t);await skipDestination(t);await t.engine.reuseExplorationDecisions(t.sid,proposal(t));
    const action=t.engine.actions(t.sid).find(a=>a.label==='Amount')!;
    await t.engine.revokeExplorationDecisionReuse(t.sid,{reviewId:source.id,source:'upper',reason:'Scope changed'});
    expect(currentExplorationDecision(group(t))).toBeUndefined();expect(group(t).status).toBe('pending');
    await expect(t.engine.dispatch(t.sid,action.id)).rejects.toMatchObject({code:'DEPTH_REUSE_INVALIDATED'});
    await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(t.engine.session(t.sid).actionCount).toBe(0);
    const g=group(t);await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...reason,mode:'all'});
    await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(t.engine.session(t.sid).actionCount).toBe(2);
  }finally{await t.close();}
});

it('fails closed on changed current operation values and reports a fresh-decision route',async()=>{
  let value='alpha';const t=await fixture({samples:()=>[value]});try{
    await initial(t);value='beta';await returned(t);
    const m=t.engine.explorationDecisionReuseMaterial(t.sid);expect(m.candidates).toEqual([]);expect(m.unavailable).toContainEqual(expect.objectContaining({reason:'DEPTH_REUSE_CONDITIONS_CHANGED',next:'fresh_decision'}));
    const g=group(t);await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...reason,mode:'sample',memberKeys:[g.members.find(m=>m.label==='Amount')!.key]});
    await skipDestination(t);await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(t.engine.list<ActionAttempt>(t.sid,'attempt').map(a=>a.action.value)).toEqual(['beta']);
  }finally{await t.close();}
});

it('invalidates an accepted all decision when new operation samples appear',async()=>{
  let values=['alpha'];const t=await fixture({samples:()=>values});try{
    await initial(t,'all');await returned(t);await skipDestination(t);await t.engine.reuseExplorationDecisions(t.sid,proposal(t));
    values=['alpha','beta'];await t.engine.observe(t.sid);
    expect(group(t).decisions.at(-1)?.invalidation?.reason).toBe('DEPTH_REUSE_CONDITIONS_CHANGED');
    await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(t.engine.session(t.sid).actionCount).toBe(0);
  }finally{await t.close();}
});

it('rejects stale or mixed invalid batches atomically and exposes the same protocol over HTTP',async()=>{
  const t=await fixture();const api=await apiServer(t.engine);try{
    await api.listen({host:'127.0.0.1',port:0});const client=new InteractionClient(`http://127.0.0.1:${(api.server.address() as {port:number}).port}`);
    await initial(t);await returned(t);const input=proposal(t),before=structuredClone(group(t));
    for(const bad of [{...input,observationId:'old'},{...input,businessScope:'other'},{...input,decisions:[input.decisions[0],{...input.decisions[0],groupId:'missing'}]},{...input,decisions:[input.decisions[0],input.decisions[0]]}]){
      await expect(client.reuseExplorationDecisions(t.sid,bad)).rejects.toBeDefined();expect(group(t)).toEqual(before);
    }
    expect((await client.explorationDecisionReuseMaterial(t.sid)).candidates).toHaveLength(1);
    const copied=await client.reuseExplorationDecisions(t.sid,input);expect(copied[0].decisions.at(-1)?.reusedFrom).toBeDefined();
    const reviews=await client.list<ExplorationDecisionReuseRecord>(t.sid,'exploration-decision-reviews');expect(reviews.total).toBe(1);
  }finally{await api.close();await t.close();}
});

it('can accept through the hook, while a failed hook leaves the current group undecided',async()=>{
  let accept=false;const t=await fixture({explorationDecisionReuse:m=>{if(!accept)throw new Error('upstream unavailable');const c=m.candidates[0];return {...reason,businessScope:scope,observationId:m.observationId,decisions:[{reviewId:c.reviewId,groupId:c.groupId,revision:c.revision,conditionKey:c.conditionKey}]};}});try{
    await initial(t);await returned(t);expect(group(t).decisions).toEqual([]);
    expect(t.engine.store.events(t.sid).some(e=>e.type==='hook.error')).toBe(true);
    // A later external decision can always resume after hook failure.
    await t.engine.reuseExplorationDecisions(t.sid,proposal(t));expect(currentExplorationDecision(group(t))).toBeDefined();
    accept=true;await returned(t);expect(currentExplorationDecision(group(t))).toBeDefined();
  }finally{await t.close();}
});

it('does not register implicitly, and superseding a source decision withdraws its old reuse candidate',async()=>{
  const t=await fixture();try{
    const r=await initial(t);const g=group(t);
    await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...reason,mode:'defer'});
    expect(t.engine.list(t.sid,'exploration-decision-review')).toHaveLength(1);
    await returned(t);expect(t.engine.explorationDecisionReuseMaterial(t.sid).candidates).toEqual([]);
    expect(t.engine.explorationDecisionReuseMaterial(t.sid).unavailable).toContainEqual(expect.objectContaining({reviewId:r.id,reason:'DEPTH_REUSE_SOURCE_UNAVAILABLE'}));
  }finally{await t.close();}
});

it('rejects a live target change after presenting reuse material without committing a decision',async()=>{
  const t=await fixture();try{
    await initial(t);await returned(t);const input=proposal(t);
    await pageOf(t.engine).locator('#a').evaluate(el=>el.setAttribute('disabled',''));
    await expect(t.engine.reuseExplorationDecisions(t.sid,input)).rejects.toMatchObject({code:'STALE_DEPTH_REUSE'});
    expect(group(t).decisions).toEqual([]);expect(t.engine.list(t.sid,'exploration-decision-application')).toEqual([]);
  }finally{await t.close();}
});

it('does not treat an externally removed operation as completed work',async()=>{
  const t=await fixture();try{
    await initial(t,'all');await returned(t);await t.engine.reuseExplorationDecisions(t.sid,proposal(t));
    await pageOf(t.engine).locator('#a').fill('example');await t.engine.observe(t.sid);
    expect(group(t).decisions.at(-1)?.invalidation?.reason).toBe('DEPTH_REUSE_CONDITIONS_CHANGED');
    expect(t.engine.list(t.sid,'attempt')).toEqual([]);
    expect(t.engine.report(t.sid).explorationAudit.counts.succeeded).toBe(0);
  }finally{await t.close();}
});

it('propagates region source withdrawal through accepted depth decisions',async()=>{
  const t=await fixture();try{
    const source=await initial(t);await returned(t);await t.engine.reuseExplorationDecisions(t.sid,proposal(t));const gid=group(t).id;
    await t.engine.revokeRegionReuse(t.sid,{reviewId:source.regionReviewId,regionKey:source.regionKey,source:'upper',reason:'Boundary withdrawn'});
    const g=t.engine.list<ExplorationGroup>(t.sid,'exploration-group').find(g=>g.id===gid)!;
    expect(g.status).toBe('invalidated');expect(g.decisions.at(-1)?.invalidation?.reason).toBe('DEPTH_REUSE_SOURCE_UNAVAILABLE');
    expect(t.engine.explorationDecisionReuseMaterial(t.sid).candidates).toEqual([]);
  }finally{await t.close();}
});

it('keeps source chains across SQLite restart and rejects another session’s source',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'depth-reuse-'));const t=await fixture({},new SqliteStore(dir));try{
    const source=await initial(t);await returned(t);await t.engine.reuseExplorationDecisions(t.sid,proposal(t));
    const g=group(t),child=await t.engine.reviewExplorationDecisionReuse(t.sid,{...reason,observationId:t.engine.observation(t.sid).id,groupId:g.id,revision:g.revision,businessScope:scope});
    expect(child.parentReviewId).toBe(source.id);
    await t.engine.close();t.engine=new TestEngine({persistence:new SqliteStore(dir)});await t.engine.observe(t.sid);
    const m=t.engine.regionReviewMaterial(t.sid),c=m.reuseCandidates!.find(c=>c.reviewId===child.regionReviewId)!;
    await t.engine.reuseRegionReviews(t.sid,{...reason,observationId:m.observationId,baseReviewId:m.review!.id,businessScope:scope,regions:[{reviewId:c.reviewId,regionKey:c.regionKey,conditionKey:c.conditionKey}]});
    await t.engine.reuseExplorationDecisions(t.sid,proposal(t,child.id));
    await t.engine.revokeExplorationDecisionReuse(t.sid,{reviewId:source.id,source:'upper',reason:'Withdraw root'});
    expect(currentExplorationDecision(group(t))).toBeUndefined();
    await t.engine.stop(t.sid);const other=await t.engine.createSession({url:t.url,headless:true,regionExploration:'review',settleMs:25});
    await expect(t.engine.revokeExplorationDecisionReuse(other.id,{reviewId:child.id,source:'other',reason:'not owned'})).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(t.engine.explorationDecisionReuseMaterial(other.id).candidates).toEqual([]);
  }finally{await t.engine.close();await t.close();rmSync(dir,{recursive:true,force:true});}
});

it('requires independent current purpose reuse before offering a depth sample for a rebuilt weak control',async()=>{
  const t=await fixture({},new MemoryStore(),markup.replace('<input id="a" aria-label="Amount">','<div id="a" role="button" aria-label="Amount" tabindex="0">Amount</div>'));try{
    const m=t.engine.controlReviewMaterial(t.sid),target=m.controls.find(c=>c.control.name==='Amount')!;
    const [purpose]=await t.engine.reviewControls(t.sid,{source:reason.source,observationId:m.observationId,reviews:[{localId:target.control.localId,kind:'click',risk:'interface',replayable:false,reason:'Read-only fixture control',evidence:reason.evidence,reuse:{binding:'same-url-context',businessScope:scope}}]});
    const source=await initial(t);await returned(t);
    expect(t.engine.explorationDecisionReuseMaterial(t.sid).candidates).toEqual([]);
    const current=t.engine.controlReviewMaterial(t.sid),candidate=current.controls.find(c=>c.control.name==='Amount')!;
    const reuse=candidate.reuseCandidates!.find(c=>c.review.id===purpose.id)!;
    await t.engine.reuseControlReviews(t.sid,{...reason,observationId:current.observationId,businessScope:scope,reviews:[{localId:candidate.control.localId,reviewId:purpose.id,conditionKey:reuse.conditionKey}]});
    await t.engine.reuseExplorationDecisions(t.sid,proposal(t,source.id));
    const chosen=currentExplorationDecision(group(t))!.decision;
    expect(chosen.mode).toBe('sample');expect(chosen.mode==='sample' && chosen.memberKeys.every(k=>group(t).members.find(m=>m.key===k)?.observationId===t.engine.observation(t.sid).id)).toBe(true);
    await skipDestination(t);await t.engine.explore(t.sid);await t.engine.waitForIdle();
    expect(t.engine.list<ActionAttempt>(t.sid,'attempt').map(a=>[a.action.label,a.action.kind])).toEqual([['Amount','click']]);
    await t.engine.revokeControlReview(t.sid,{reviewId:purpose.id,source:'upper',reason:'Purpose withdrawn'});
    expect(currentExplorationDecision(group(t))).toBeUndefined();
    expect(t.engine.explorationDecisionReuseMaterial(t.sid).unavailable).toContainEqual(expect.objectContaining({reason:'DEPTH_REUSE_PURPOSE_UNAVAILABLE',next:'review_purpose'}));
  }finally{await t.close();}
});

it('ignores a late reuse-hook answer and leaves a resumable pending decision',async()=>{
  let finish: (()=>void)|undefined;
  const t=await fixture({explorationDecisionReuse:m=>new Promise(resolve=>{const c=m.candidates[0];finish=()=>resolve({...reason,businessScope:scope,observationId:m.observationId,decisions:[{reviewId:c.reviewId,groupId:c.groupId,revision:c.revision,conditionKey:c.conditionKey}]});})});try{
    await initial(t);await returned(t);expect(group(t).decisions).toEqual([]);
    finish!();await new Promise(r=>setTimeout(r,30));expect(group(t).decisions).toEqual([]);expect(t.engine.list(t.sid,'exploration-decision-application')).toEqual([]);
    await t.engine.reuseExplorationDecisions(t.sid,proposal(t));expect(currentExplorationDecision(group(t))).toBeDefined();
  }finally{await t.close();}
});
