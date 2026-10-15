import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, auditExploration, type ActionAttempt, type ExplorationGroup, type EngineHooks, type SessionOptions, type Observation } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';

async function run(html: string, hooks: EngineHooks = {}, options: Partial<SessionOptions> = {}) {
  const site = createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);}); await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
  const engine = new BrowserEngine({persistence:new MemoryStore(),hooks});
  const session = await engine.createSession({url:`http://127.0.0.1:${(site.address() as any).port}`,headless:true,settleMs:30,observeTimeoutMs:600,...options});
  return { engine, sid:session.id, explore:async()=>{await engine.explore(session.id);await engine.waitForIdle();},
    close:async()=>{await engine.close();await new Promise<void>(r=>site.close(()=>r()));} };
}
const list = '<input aria-label="Amount"><select aria-label="Currency"><option>A</option><option>B</option><option>C</option></select>';
const source = {source:'fixture-upper-layer',evidence:['Select only observed B; other list members remain untested']};

it('reports a completed sampled scope without claiming skipped members were executed or discovery complete',async()=>{
  const t=await run(list,{explorationDecision:g=>({...source,mode:'sample',memberKeys:g.members.filter(m=>m.value==='B').map(m=>m.key)})});try{
    await t.explore(); const report=t.engine.report(t.sid),a=report.explorationAudit;
    expect(a.status).toBe('complete');expect(a.discoveryComplete).toBe(false);
    expect(a.counts.succeeded).toBe(2);expect(a.counts.policy_excluded).toBe(2);expect(a.counts.notAttempted).toBe(2);
    expect(a.cases.filter(c=>c.disposition==='policy_excluded').every(c=>c.attemptIds.length===0&&c.policies[0].source===source.source)).toBe(true);
    expect(t.engine.list<ActionAttempt>(t.sid,'attempt').filter(a=>a.action.kind==='select').map(a=>a.action.value)).toEqual(['B']);
  }finally{await t.close();}
});

it('keeps unanswered decisions pending and distinguishes explicit skip from completion evidence',async()=>{
 const t=await run(list);try{
  await t.explore();expect(t.engine.report(t.sid).explorationAudit.status).toBe('awaiting_decision');
  const g=t.engine.explorationReviewMaterial(t.sid).groups[0];await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...source,mode:'skip'});await t.explore();
  const a=t.engine.report(t.sid).explorationAudit;expect(a.status).toBe('complete');expect(a.counts.policy_excluded).toBe(g.members.length);expect(a.counts.succeeded).toBe(1);
 }finally{await t.close();}
});

it('does not turn zero pending into completion when controls are excluded or a selected member is disabled',async()=>{
 const t=await run(list.replace('<option>B','<option disabled>B'),{explorationDecision:g=>({...source,mode:'sample',memberKeys:g.members.filter(m=>m.value==='B').map(m=>m.key)})},{exclude:[{name:'Amount'}]});try{
  await t.explore();const a=t.engine.report(t.sid).explorationAudit;expect(a.status).toBe('blocked');expect(a.counts.pending).toBe(0);expect(a.counts.blocked).toBeGreaterThan(0);
  expect(a.cases.find(c=>c.label==='Amount')?.disposition).toBe('blocked');
 }finally{await t.close();}
});

it('requires real attempt and observation records, and never hides a failed attempt behind a later skip',async()=>{
 const t=await run('<input aria-label="Amount">',{explorationScopes:actions=>[{key:'input',kind:'custom',label:'Input',actionIds:actions.map(a=>a.id),traversalActionIds:[],evidence:[{source:'test',rule:'input/v1',facts:{}}]}],explorationDecision:()=>({...source,mode:'all'})});try{
  await t.explore();const session=t.engine.session(t.sid),frontier=t.engine.getFrontier(t.sid),observations=t.engine.list<Observation>(t.sid,'observation'),attempts=t.engine.list<ActionAttempt>(t.sid,'attempt');
  expect(auditExploration(session,frontier,[],observations,[]).status).toBe('blocked');
  expect(auditExploration(session,frontier,attempts,observations.filter(o=>o.id!==attempts[0].afterId),[]).status).toBe('blocked');
  const unrelated=structuredClone(attempts);unrelated[0].action.controlId='different-control';unrelated[0].action.localId='different-node';
  expect(auditExploration(session,frontier,unrelated,observations,[]).counts.succeeded).toBe(0);
  const group=t.engine.explorationReviewMaterial(t.sid).groups[0];await t.engine.decideExplorationGroup(t.sid,group.id,group.revision,{...source,mode:'skip'});
  const failed=structuredClone(attempts);failed[0].status='failed';expect(auditExploration(session,frontier,failed,observations,t.engine.list<ExplorationGroup>(t.sid,'exploration-group')).cases[0].reason).toBe('attempt_failed');
 }finally{await t.close();}
});

it('preserves a verified historical exclusion without authorizing cases observed after invalidation',async()=>{
 const t=await run(list,{explorationDecision:()=>({...source,mode:'skip'})});try{
  await t.explore();const session=t.engine.session(t.sid),frontier=t.engine.getFrontier(t.sid),observations=t.engine.list<Observation>(t.sid,'observation'),attempts=t.engine.list<ActionAttempt>(t.sid,'attempt'),groups=t.engine.list<ExplorationGroup>(t.sid,'exploration-group');
  const later={...observations.at(-1)!,id:'later-document',instanceScope:'new-document',capturedAt:new Date(Date.now()+1000).toISOString()};
  const archived=groups.map(g=>({...g,status:'invalidated' as const,revision:g.revision+1,invalidation:{observationId:later.id,reason:'exploration_conditions_changed'}}));
  const audit=auditExploration(session,frontier,attempts,[...observations,later],archived);
  expect(audit.counts.policy_excluded).toBe(groups[0].members.length);
  expect(audit.cases.filter(c=>c.disposition==='policy_excluded').every(c=>c.policies[0].validity==='historical'&&!c.attemptIds.length)).toBe(true);
  const forged=frontier.filter(f=>f.explorationGroups?.length).map(f=>({...f,action:{...f.action,observationId:later.id}}));
  expect(auditExploration(session,forged,attempts,[...observations,later],archived).counts.policy_excluded).toBe(0);
  const lateDecision=archived.map(g=>({...g,decisions:g.decisions.map(d=>({...d,at:new Date(Date.parse(later.capturedAt)+1).toISOString()}))}));
  expect(auditExploration(session,frontier,attempts,[...observations,later],lateDecision).counts.policy_excluded).toBe(0);
 }finally{await t.close();}
});

it('rejects policy exclusion with missing, invalidated or mismatched scope evidence',async()=>{
 const t=await run(list,{explorationDecision:()=>({...source,mode:'skip'})});try{
  await t.explore();const session=t.engine.session(t.sid),frontier=t.engine.getFrontier(t.sid),observations=t.engine.list<Observation>(t.sid,'observation'),attempts=t.engine.list<ActionAttempt>(t.sid,'attempt'),groups=t.engine.list<ExplorationGroup>(t.sid,'exploration-group');
  for(const altered of [[],groups.map(g=>({...g,status:'invalidated' as const})),groups.map(g=>({...g,members:[]}))]) {
    const audit=auditExploration(session,frontier,attempts,observations,altered);expect(audit.status).toBe('blocked');expect(audit.counts.policy_excluded).toBe(0);
  }
 }finally{await t.close();}
});

it('keeps budget exhaustion explicit even when the scheduler has stopped',async()=>{
 const t=await run('<input aria-label="First"><input aria-label="Second">',{}, {maxActions:1});try{
  await t.explore();const a=t.engine.report(t.sid).explorationAudit;expect(a.status).toBe('blocked');expect(a.stopReasons).toContain('BUDGET_EXHAUSTED');expect(a.counts.succeeded).toBe(1);expect(a.counts.pending).toBe(1);
 }finally{await t.close();}
});
