import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, type ActionAttempt, type EngineHooks, type RegionReviewMaterial, type RegionReviewInput, type SessionOptions } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { createServer as apiServer } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';
const reason = { source: 'test-plan', evidence: ['Review the currently observed business boundary'] };
const body = '<div id="convert"><h2>Converter</h2><input aria-label="Amount"><input aria-label="Result"></div><div id="chart"><h2>Chart</h2><button type="button">Day</button><button type="button">Week</button></div>';
async function fixture(html = body, hooks: EngineHooks = {}, options: Partial<SessionOptions> = {}) {
  const site = createServer((_req,res) => {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);}); await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
  const engine = new BrowserEngine({persistence:new MemoryStore(),hooks}); const session = await engine.createSession({url:`http://127.0.0.1:${(site.address() as any).port}`,headless:true,regionExploration:'review',settleMs:30,observeTimeoutMs:600,...options});
  return {engine,sid:session.id,close:async()=>{await engine.close();await new Promise<void>(r=>site.close(()=>r()));}};
}
const plan = (m: RegionReviewMaterial): RegionReviewInput => ({ observationId:m.observationId,...reason,regions: ['Converter','Chart'].map(label=>({key:label,label,candidateIds:[m.candidates.find(c=>c.label===label && c.basis==='heading')!.id]})) });
const explore = async(t:Awaited<ReturnType<typeof fixture>>)=>{await t.engine.explore(t.sid);await t.engine.waitForIdle();};
const attempts = (t:Awaited<ReturnType<typeof fixture>>)=>t.engine.list<ActionAttempt>(t.sid,'attempt');
const allow = async(t:Awaited<ReturnType<typeof fixture>>,label?:string)=>{const groups=t.engine.explorationReviewMaterial(t.sid).groups.filter(g=>g.kind==='reviewed-region' && (!label||g.label===label));await t.engine.decideExplorationGroups(t.sid,groups.map(g=>({groupId:g.id,revision:g.revision,decision:{...reason,mode:'all'}})));};

it('finds unlabelled containers, requires confirmation and separate decisions, and keeps ordinary value edits valid',async()=>{
 const t=await fixture();try{
  await explore(t);expect(attempts(t)).toEqual([]);expect(t.engine.session(t.sid).stopReason).toBe('REGION_REVIEW_REQUIRED');
  const m=t.engine.regionReviewMaterial(t.sid);expect(m.unassignedControlIds).toHaveLength(4);expect(m.candidates.filter(c=>c.suggested).map(c=>c.label)).toEqual(['Converter','Chart']);
  const record=await t.engine.reviewRegions(t.sid,plan(m));expect(record.regions).toHaveLength(2);expect(attempts(t)).toEqual([]);
  expect(t.engine.explorationReviewMaterial(t.sid).groups.filter(g=>g.kind==='reviewed-region')).toHaveLength(2);
  await allow(t,'Converter');await explore(t);expect(attempts(t).map(a=>a.action.label)).toEqual(['Amount','Result']);
  expect(t.engine.regionReviewMaterial(t.sid).review?.regions.every(r=>r.status==='active')).toBe(true);
  expect(t.engine.session(t.sid).stopReason).toBe('EXPLORATION_DECISION_REQUIRED');
 }finally{await t.close();}
});

it('supports splits, merges and rejection while preserving uncovered work and atomically rejecting bad partitions',async()=>{
 const t=await fixture();try{
  const m=t.engine.regionReviewMaterial(t.sid),p=plan(m);const converter=m.candidates.find(c=>c.id===p.regions[0].candidateIds[0])!;
  const split={observationId:m.observationId,...reason,regions:converter.controlIds.map((id,i)=>({key:`part-${i}`,label:`Part ${i}`,candidateIds:[converter.id],controlIds:[id]})),rejectedCandidateIds:p.regions[1].candidateIds};
  await t.engine.reviewRegions(t.sid,split);await allow(t);await explore(t);expect(attempts(t)).toHaveLength(2);expect(t.engine.session(t.sid).stopReason).toBe('REGION_REVIEW_REQUIRED');
  const current=t.engine.regionReviewMaterial(t.sid);const before=t.engine.list(t.sid,'region-review');
  await expect(t.engine.reviewRegions(t.sid,{...plan(current),regions:[...plan(current).regions,plan(current).regions[0]]})).rejects.toMatchObject({code:'INVALID_REGION_REVIEW'});
  expect(t.engine.list(t.sid,'region-review')).toEqual(before);
  const merged=await t.engine.reviewRegions(t.sid,{observationId:current.observationId,...reason,regions:[{key:'both',label:'Combined',candidateIds:plan(current).regions.flatMap(r=>r.candidateIds)}]});
  expect(merged.regions[0].controlIds).toHaveLength(4);expect(t.engine.explorationReviewMaterial(t.sid).groups.filter(g=>g.kind==='reviewed-region').map(g=>g.label)).toEqual(['Combined']);
 }finally{await t.close();}
});

it.each(['replace','move','heading','new-control','context','reload'] as const)('invalidates affected region before dispatch after %s and never revives old approval',async change=>{
 let business='A';const t=await fixture(body,{context:()=>({business:{value:business,status:'known',source:'test'}})});try{
  await t.engine.reviewRegions(t.sid,plan(t.engine.regionReviewMaterial(t.sid)));await allow(t);
  const original=t.engine.regionReviewMaterial(t.sid).review!,action=t.engine.actions(t.sid).find(a=>a.label==='Amount')!;
  const page=pageOf(t.engine);
  if(change==='replace')await page.locator('#convert').evaluate(el=>{const next=el.cloneNode(false);while(el.firstChild)next.appendChild(el.firstChild);el.replaceWith(next);});
  if(change==='move')await page.evaluate(()=>document.querySelector('#chart')!.appendChild(document.querySelector('input')!));
  if(change==='heading')await page.locator('#convert h2').evaluate(el=>el.textContent='Different object');
  if(change==='new-control')await page.locator('#convert').evaluate(el=>{const input=document.createElement('input');input.setAttribute('aria-label','New work');el.appendChild(input);});
  if(change==='context'){business='B';await t.engine.observe(t.sid);}
  if(change==='reload')await page.reload();
  await expect(t.engine.execute(t.sid,action.id,'stale-region')).rejects.toBeDefined();expect(attempts(t)).toEqual([]);
  const stored=t.engine.list<typeof original>(t.sid,'region-review').find(r=>r.id===original.id)!;expect(stored.regions.find(r=>r.key==='Converter')?.status).toBe('invalidated');
  if(['replace','heading','new-control'].includes(change))expect(stored.regions.find(r=>r.key==='Chart')?.status).toBe('active');
  if(change==='heading'){await page.locator('#convert h2').evaluate(el=>el.textContent='Converter');await t.engine.observe(t.sid);expect(t.engine.list<typeof original>(t.sid,'region-review').find(r=>r.id===original.id)!.regions[0].status).toBe('invalidated');}
 }finally{await t.close();}
});

it('keeps same-name regions separate and exposes layout-only evidence without inventing a business label',async()=>{
 const t=await fixture('<div style="display:flex"><button>One</button><button>Two</button></div><div><h2>Same</h2><input aria-label="First"></div><div><h2>Same</h2><input aria-label="Second"></div>');try{
 const m=t.engine.regionReviewMaterial(t.sid);expect(m.candidates.filter(c=>c.label==='Same'&&c.basis==='heading')).toHaveLength(2);expect(m.candidates.some(c=>c.basis==='layout'&&c.label==='div 容器')).toBe(true);
 }finally{await t.close();}
});

it('keeps candidate review hooks bounded and never lets a scheduling hook authorize unassigned controls',async()=>{
 const calls:string[]=[];const t=await fixture(body,{regionReview:m=>{calls.push(m.observationId);return undefined;},explorationReview:m=>m.groups.map(g=>({groupId:g.id,revision:g.revision,decision:{...reason,mode:'all'}}))},{decisionScopes:['input-space']});try{
 await explore(t);await t.engine.observe(t.sid);expect(calls).toHaveLength(1);expect(attempts(t)).toEqual([]);expect(t.engine.session(t.sid).stopReason).toBe('REGION_REVIEW_REQUIRED');
 }finally{await t.close();}
});

it('uses a synchronous region-review result and then the existing exploration hook in one capture',async()=>{
 const t=await fixture(body,{regionReview:plan,explorationReview:m=>m.groups.map(g=>({groupId:g.id,revision:g.revision,decision:{...reason,mode:g.label==='Chart'?'defer':'all'}}))});try{
 await explore(t);expect(attempts(t).map(a=>a.action.label)).toEqual(['Amount','Result']);expect(t.engine.session(t.sid).stopReason).toBe('EXPLORATION_DEFERRED');
 }finally{await t.close();}
});

it('queries and records through SDK/HTTP, checks live facts on review and rejects old observations',async()=>{
 const t=await fixture();const api=await apiServer(t.engine);await api.listen({host:'127.0.0.1',port:0});const client=new InteractionClient(`http://127.0.0.1:${(api.server.address() as any).port}`);try{
 const m=await client.regionReviewMaterial(t.sid);await pageOf(t.engine).locator('#convert h2').evaluate(el=>el.textContent='Changed');
 await expect(client.reviewRegions(t.sid,plan(m))).rejects.toMatchObject({code:'STALE_REGION_REVIEW'});expect(t.engine.list(t.sid,'region-review')).toEqual([]);
 await expect(client.reviewRegions(t.sid,plan(m))).rejects.toMatchObject({code:'STALE_REGION_REVIEW'});
 const latest=await client.regionReviewMaterial(t.sid);const selected=latest.candidates.find(c=>c.label==='Changed'&&c.basis==='heading')!;
 expect((await client.reviewRegions(t.sid,{observationId:latest.observationId,...reason,regions:[{key:'new',label:'Reviewed',candidateIds:[selected.id]}]})).status).toBe('active');expect(attempts(t)).toEqual([]);
 }finally{await api.close();await t.close();}
});

it('does not persist a region decision returned after the hook deadline',async()=>{
 let finish!:()=>void;const t=await fixture(body,{regionReview:m=>new Promise(resolve=>{finish=()=>resolve(plan(m));})});try{
 finish();await t.engine.observe(t.sid);await explore(t);expect(t.engine.list(t.sid,'region-review')).toEqual([]);expect(attempts(t)).toEqual([]);
 }finally{await t.close();}
});

it('keeps document traversal gated until it is explicitly assigned and an all decision permits discovery',async()=>{
 const t=await fixture('<div style="height:1700px"><h2>Long page</h2></div>');try{
  await explore(t);expect(attempts(t)).toEqual([]);const m=t.engine.regionReviewMaterial(t.sid);expect(m.unassignedPageTraversal).toBe(true);
  await t.engine.reviewRegions(t.sid,{observationId:m.observationId,...reason,regions:[{key:'page',label:'Page discovery',candidateIds:[m.candidates[0].id],controlIds:[],pageTraversal:true}]});
  await allow(t);await explore(t);expect(attempts(t).some(a=>a.action.kind==='scroll'&&a.status==='succeeded')).toBe(true);
 }finally{await t.close();}
});

it('retains exits and page boundaries while requiring a new region review at a destination',async()=>{
 const t=await fixture('<dialog open><h2>Prompt</h2><input aria-label="Inside"><button onclick="this.closest(\'dialog\').close()">Close</button></dialog><a href="/b">To B</a>');try{
  await explore(t);expect(attempts(t).map(a=>a.action.label)).toEqual(['Close']);expect(t.engine.session(t.sid).stopReason).toBe('REGION_REVIEW_REQUIRED');
  const m=t.engine.regionReviewMaterial(t.sid),anchor=m.candidates.find(c=>c.controlIds.includes(m.controls.find(c=>c.label==='To B')!.localId))!;
  await t.engine.reviewRegions(t.sid,{observationId:m.observationId,...reason,regions:[{key:'entry',label:'Entry',candidateIds:[anchor.id],controlIds:[m.controls.find(c=>c.label==='To B')!.localId]}]});
  await allow(t);await explore(t);expect(t.engine.observation(t.sid).url).not.toContain('/b');
  expect(t.engine.explorationReviewMaterial(t.sid).groups.some(g=>g.kind==='page'&&g.status==='pending')).toBe(true);
  expect(attempts(t).filter(a=>a.action.kind==='fill')).toEqual([]);
 }finally{await t.close();}
});

it('rejects a review for an inactive session without using another session browser',async()=>{
 const t=await fixture();try{
  const old=t.engine.regionReviewMaterial(t.sid);await t.engine.stop(t.sid);const s=await t.engine.createSession({...t.engine.session(t.sid).options});const current=t.engine.observation(s.id);
  await expect(t.engine.reviewRegions(t.sid,plan(old))).rejects.toMatchObject({code:'BROWSER_UNAVAILABLE'});
  expect(t.engine.observation(s.id)).toEqual(current);expect(t.engine.regionReviewMaterial(t.sid).observationId).toBe(old.observationId);
 }finally{await t.close();}
});

it('keeps a complete fallback for controls deeper than the candidate ancestor scan',async()=>{
 const t=await fixture('<div>'.repeat(30)+'<input aria-label="Deep">'+'</div>'.repeat(30));try{
  const m=t.engine.regionReviewMaterial(t.sid);expect(m.candidates.some(c=>c.controlIds.includes(m.controls[0].localId))).toBe(true);
 }finally{await t.close();}
});
