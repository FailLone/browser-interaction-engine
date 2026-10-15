import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BrowserEngine, type EngineHooks, type RegionReviewInput, type RegionReviewRecord, type ReuseRegionReviewsInput } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { InteractionClient } from '@interaction/client';
import { createServer as apiServer } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';

const markup='<section id="first" aria-label="First" data-owner="public"><input aria-label="Amount"><a href="/b">Details</a></section><section id="second" aria-label="Second"><input aria-label="Search"></section>';
const reuse={binding:'same-url-context' as const,businessScope:'Public UI layout; no account or transaction scope'};
const reason={source:'upper-layout',evidence:['Reviewed the observed boundary and complete member pool']};
class TestEngine extends BrowserEngine { dispatchPrepared(sid:string,id:string) { return this.runAction(sid,id,'prepared-auto',undefined,'exploration'); } }
async function fixture(hooks:EngineHooks={},store:MemoryStore|SqliteStore=new MemoryStore()) {
  let html=markup;
  const site=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/b'?'<button>Destination action</button>':html);});
  await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${(site.address() as {port:number}).port}/a`;
  const engine=new TestEngine({persistence:store,hooks});
  const session=await engine.createSession({url,headless:true,regionExploration:'review',settleMs:25,observeTimeoutMs:700});
  return {engine,sid:session.id,url,setHtml:(value:string)=>{html=value;},close:async()=>{await engine.close();await new Promise<void>(r=>site.close(()=>r()));}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const material=(t:Fixture)=>t.engine.regionReviewMaterial(t.sid);
const records=(t:Fixture)=>t.engine.list<RegionReviewRecord>(t.sid,'region-review');
const group=(t:Fixture,key='First')=>t.engine.explorationReviewMaterial(t.sid).groups.find(g=>g.kind==='reviewed-region'&&g.label===key&&g.status!=='invalidated')!;
function partition(t:Fixture,keys=['First','Second']):RegionReviewInput {const m=material(t);return {observationId:m.observationId,...reason,regions:keys.map(label=>({key:label,label,candidateIds:[m.candidates.find(c=>c.label===label)!.id],reuse}))};}
async function reload(t:Fixture) {await pageOf(t.engine).reload();await t.engine.observe(t.sid);}
function proposal(t:Fixture,key='First',sourceId?:string):ReuseRegionReviewsInput {
  const m=material(t),c=m.reuseCandidates!.find(c=>c.regionKey===key&&(!sourceId||c.reviewId===sourceId))!;
  return {observationId:m.observationId,baseReviewId:m.review!.id,...reason,businessScope:reuse.businessScope,regions:[{reviewId:c.reviewId,regionKey:c.regionKey,conditionKey:c.conditionKey}]};
}

it('reuses A boundaries explicitly after a new document without inheriting depth or operation purpose',async()=>{
  const t=await fixture({actions:as=>as.map(a=>a.kind==='click'?{...a,excluded:true,exclusionReason:'navigation_requires_review'}:a)});try{
    const original=await t.engine.reviewRegions(t.sid,partition(t));const old=group(t);
    await t.engine.decideExplorationGroup(t.sid,old.id,old.revision,{...reason,mode:'all'});
    await pageOf(t.engine).goto(t.url.replace('/a','/b'));await t.engine.observe(t.sid);
    await pageOf(t.engine).goto(t.url);await t.engine.observe(t.sid);
    const page=t.engine.explorationReviewMaterial(t.sid).groups.find(g=>g.kind==='page')!;
    await t.engine.decideExplorationGroup(t.sid,page.id,page.revision,{...reason,mode:'skip'});
    expect(material(t).reuseCandidates).toHaveLength(2);expect(material(t).unassignedControlIds).toHaveLength(3);
    const copy=await t.engine.reuseRegionReviews(t.sid,proposal(t));
    expect(copy.id).not.toBe(original.id);expect(copy.instanceScope).not.toBe(original.instanceScope);
    expect(copy.regions[0]).toMatchObject({status:'active',reusedFrom:{reviewId:original.id,regionKey:'First'}});
    expect(copy.regions[0].controlIds).not.toEqual(original.regions[0].controlIds);
    expect(group(t).decisions).toEqual([]);expect(group(t).id).not.toBe(old.id);
    expect(t.engine.actions(t.sid).find(a=>a.label==='Details')?.exclusionReason).toBe('navigation_requires_review');
    await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(t.engine.session(t.sid).actionCount).toBe(0);
    const fresh=group(t);await t.engine.decideExplorationGroup(t.sid,fresh.id,fresh.revision,{...reason,mode:'sample',memberKeys:[fresh.members.find(m=>m.label==='Amount')!.key]});
    await t.engine.explore(t.sid);await t.engine.waitForIdle();
    expect(t.engine.list<any>(t.sid,'attempt').map(a=>a.action.label)).toEqual(['Amount']);
    expect(material(t).unassignedControlIds).toHaveLength(1);
    expect(t.engine.store.events(t.sid).filter(e=>e.type==='region.review_reused')).toHaveLength(1);
  }finally{await t.close();}
});

it('maps selected subsets of merged anchors exactly and never adds unselected current members',async()=>{
  const t=await fixture();try{
    const m=material(t),controls=m.controls.filter(c=>c.role==='textbox');
    const source=await t.engine.reviewRegions(t.sid,{observationId:m.observationId,...reason,regions:[{key:'inputs',label:'Inputs',candidateIds:partition(t).regions.flatMap(r=>r.candidateIds),controlIds:controls.map(c=>c.localId),reuse}]});
    await reload(t);const c=material(t).reuseCandidates![0];expect(c.controlIds).toHaveLength(2);
    const copy=await t.engine.reuseRegionReviews(t.sid,proposal(t,'inputs'));
    expect(copy.regions[0].controlIds).toEqual(c.controlIds);expect(copy.regions[0].reusedFrom?.reviewId).toBe(source.id);
    expect(material(t).unassignedControlIds).toHaveLength(1);expect(material(t).controls.find(c=>c.localId===material(t).unassignedControlIds[0])?.label).toBe('Details');
  }finally{await t.close();}
});

it('preserves an independent current region and its decision when reusing a rebuilt sibling',async()=>{
  const t=await fixture();try{
    await t.engine.reviewRegions(t.sid,partition(t));const second=group(t,'Second');
    await t.engine.decideExplorationGroup(t.sid,second.id,second.revision,{...reason,mode:'defer'});
    const saved=group(t,'Second');await pageOf(t.engine).locator('#first').evaluate(el=>el.replaceWith(el.cloneNode(true)));await t.engine.observe(t.sid);
    expect(material(t).reuseCandidates!.map(c=>c.regionKey)).toEqual(['First']);
    const copy=await t.engine.reuseRegionReviews(t.sid,proposal(t));expect(copy.regions).toHaveLength(2);
    expect(group(t,'Second').id).toBe(saved.id);expect(group(t,'Second').decisions).toEqual(saved.decisions);expect(group(t).decisions).toEqual([]);
  }finally{await t.close();}
});

for(const change of ['label','ancestor','added','removed','member-label','href','form','layout','url','context'] as const)it(`does not offer a region reuse candidate after ${change} changes`,async()=>{
  let context='public';const t=await fixture({context:()=>({scope:{status:'known',value:context,source:'fixture'}})});try{
    await t.engine.reviewRegions(t.sid,partition(t,['First']));
    const changes={label:markup.replace('aria-label="First"','aria-label="Other"'),ancestor:markup.replace('data-owner="public"','data-owner="account"'),
      added:markup.replace('</section>','<input aria-label="New"></section>'),removed:markup.replace('<input aria-label="Amount">',''),
      'member-label':markup.replace('aria-label="Amount"','aria-label="Balance"'),href:markup.replace('/b','/other'),
      form:markup.replace('<input aria-label="Amount">','<form action="/submit"><input aria-label="Amount"></form>'),
      layout:markup.replace('id="first"','id="first" style="display:flex"'),url:markup,context:markup};
    t.setHtml(changes[change]);if(change==='context') context='account';await reload(t);
    if(change==='url'){await pageOf(t.engine).evaluate(()=>history.pushState({},'','#changed'));await t.engine.observe(t.sid);}
    expect(material(t).reuseCandidates).toEqual([]);
  }finally{await t.close();}
});

it('rejects an entire malformed batch or stale base without replacing any partition',async()=>{
  const t=await fixture();try{
    await t.engine.reviewRegions(t.sid,partition(t));await reload(t);const input=proposal(t),before=records(t);
    for(const bad of [{...input,baseReviewId:'old'},{...input,observationId:'old'},{...input,businessScope:'different'},
      {...input,regions:[input.regions[0],input.regions[0]]},{...input,regions:[input.regions[0],{...input.regions[0],regionKey:'missing'}]},
      {...input,regions:[{...input.regions[0],conditionKey:'stale'}]}]) {
      await expect(t.engine.reuseRegionReviews(t.sid,bad)).rejects.toBeDefined();expect(records(t)).toEqual(before);
    }
    await t.engine.reuseRegionReviews(t.sid,input);await expect(t.engine.reuseRegionReviews(t.sid,input)).rejects.toMatchObject({code:'STALE_REGION_REVIEW'});
  }finally{await t.close();}
});

it('validates live structural evidence at initial opt-in, reuse, and prepared automated dispatch',async()=>{
  const t=await fixture();try{
    const input=partition(t,['First']);await pageOf(t.engine).locator('#first').evaluate(el=>el.setAttribute('data-owner','changed'));
    await expect(t.engine.reviewRegions(t.sid,input)).rejects.toMatchObject({code:'STALE_REGION_REVIEW'});expect(records(t)).toEqual([]);
    await pageOf(t.engine).locator('#first').evaluate(el=>el.setAttribute('data-owner','public'));await t.engine.observe(t.sid);
    await t.engine.reviewRegions(t.sid,partition(t,['First']));await reload(t);
    const reuseInput=proposal(t);await pageOf(t.engine).locator('#first').evaluate(el=>el.setAttribute('data-owner','changed'));
    await expect(t.engine.reuseRegionReviews(t.sid,reuseInput)).rejects.toMatchObject({code:'STALE_REGION_REVIEW'});
    await reload(t);await t.engine.reuseRegionReviews(t.sid,proposal(t));
    const g=group(t);await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...reason,mode:'all'});
    const a=t.engine.actions(t.sid).find(a=>a.label==='Amount')!;
    await pageOf(t.engine).locator('#first').evaluate(el=>el.setAttribute('data-owner','changed'));
    await expect(t.engine.dispatchPrepared(t.sid,a.id)).rejects.toMatchObject({code:'STALE_OBSERVATION'});
    expect(t.engine.session(t.sid).actionCount).toBe(0);expect(material(t).review?.status).toBe('invalidated');
  }finally{await t.close();}
});

it('revokes a three-record source chain immediately without reviving prior scope decisions',async()=>{
  const t=await fixture();try{
    const root=await t.engine.reviewRegions(t.sid,partition(t,['First']));await reload(t);
    const copy=await t.engine.reuseRegionReviews(t.sid,proposal(t));await reload(t);
    const last=await t.engine.reuseRegionReviews(t.sid,proposal(t,'First',copy.id));const g=group(t);
    await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...reason,mode:'all'});const action=t.engine.actions(t.sid).find(a=>a.label==='Amount')!;
    await t.engine.revokeRegionReuse(t.sid,{reviewId:root.id,regionKey:'First',source:'upper-withdrawal',reason:'Applicability withdrawn'});
    expect(material(t).review?.id).toBe(last.id);expect(material(t).review?.status).toBe('invalidated');expect(material(t).reuseCandidates).toEqual([]);
    expect(t.engine.list<any>(t.sid,'exploration-group').find(x=>x.id===g.id).status).toBe('invalidated');
    await expect(t.engine.dispatchPrepared(t.sid,action.id)).rejects.toMatchObject({code:'REGION_REVIEW_REQUIRED'});
    expect(t.engine.session(t.sid).actionCount).toBe(0);
    // Manual execute remains explicit caller takeover, not an automatic depth grant.
    await t.engine.execute(t.sid,action.id,'manual-takeover');expect(t.engine.session(t.sid).actionCount).toBe(1);
  }finally{await t.close();}
});

it.each(['replace','remove'] as const)('withdraws reuse sources on an explicit current-region %s',async mode=>{
  const t=await fixture();try{
    const original=await t.engine.reviewRegions(t.sid,partition(t,['First']));const m=material(t);
    await t.engine.reviewRegions(t.sid,{observationId:m.observationId,...reason,update:{baseReviewId:original.id,removeRegionKeys:mode==='remove'?['First']:[]},regions:mode==='remove'?[]:partition(t,['First']).regions.map(r=>({...r,reuse:undefined}))});
    expect(records(t)[0].regions[0].reuseRevocation?.reason).toBe('region_partition_replaced');await reload(t);expect(material(t).reuseCandidates).toEqual([]);
  }finally{await t.close();}
});

it('requires opt-in, complete bounded evidence and known context, and refuses active boundaries',async()=>{
  let unknown=false;const t=await fixture({context:()=>({scope:{status:unknown?'unknown':'known',value:null,source:'fixture'}})});try{
    await t.engine.reviewRegions(t.sid,{...partition(t,['First']),regions:partition(t,['First']).regions.map(r=>({...r,reuse:undefined}))});await reload(t);expect(material(t).reuseCandidates).toEqual([]);
    unknown=true;await t.engine.observe(t.sid);await expect(t.engine.reviewRegions(t.sid,partition(t,['First']))).rejects.toMatchObject({code:'INVALID_REGION_REUSE'});
    unknown=false;t.setHtml(markup.replace('data-owner="public"',`data-owner="${'x'.repeat(17000)}"`));await reload(t);
    await expect(t.engine.reviewRegions(t.sid,partition(t,['First']))).rejects.toMatchObject({code:'INVALID_REGION_REUSE'});
    t.setHtml('<dialog open aria-modal="true"><section aria-label="First"><input aria-label="Amount"></section></dialog>');await reload(t);
    await expect(t.engine.reviewRegions(t.sid,partition(t,['First']))).rejects.toMatchObject({code:'INVALID_REGION_REUSE'});
  }finally{await t.close();}
});

it('retains proof across SQLite restart, serves SDK/HTTP reuse, and isolates sessions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'region-reuse-'));const t=await fixture({},new SqliteStore(dir));let api:Awaited<ReturnType<typeof apiServer>>|undefined;try{
    const original=await t.engine.reviewRegions(t.sid,partition(t,['First']));await t.engine.close();
    const engine=new TestEngine({persistence:new SqliteStore(dir)});t.engine=engine;await engine.observe(t.sid);
    expect(material(t).reuseCandidates?.some(c=>c.reviewId===original.id)).toBe(true);expect(material(t).review?.status).toBe('invalidated');
    api=await apiServer(engine);const address=await api.listen({host:'127.0.0.1',port:0}),client=new InteractionClient(address);
    const copy=await client.reuseRegionReviews(t.sid,proposal(t));expect(copy.regions[0].reusedFrom?.reviewId).toBe(original.id);
    await engine.stop(t.sid);const other=await engine.createSession({url:t.url,headless:true,regionExploration:'review',settleMs:25});expect(engine.regionReviewMaterial(other.id).reuseCandidates).toEqual([]);
    await expect(client.revokeRegionReuse(other.id,{reviewId:original.id,regionKey:'First',source:'other-session',reason:'Not owned'})).rejects.toBeDefined();
  }finally{await api?.close();await t.close();rmSync(dir,{recursive:true,force:true});}
});

it('keeps list depth independent and rejects changed record bindings within a reusable region',async()=>{
  const t=await fixture();try{
    t.setHtml('<section aria-label="First"><ul><li data-key="a"><button>Alpha</button></li><li data-key="b"><button>Beta</button></li></ul></section>');await reload(t);
    await t.engine.reviewRegions(t.sid,partition(t,['First']));await reload(t);
    expect(material(t).reuseCandidates).toHaveLength(1);await t.engine.reuseRegionReviews(t.sid,proposal(t));
    expect(group(t).decisions).toEqual([]);
    expect(t.engine.explorationReviewMaterial(t.sid).groups.filter(g=>g.kind==='similar-list'&&g.status!=='invalidated').every(g=>g.decisions.length===0)).toBe(true);
    t.setHtml('<section aria-label="First"><ul><li data-key="b"><button>Alpha</button></li><li data-key="a"><button>Beta</button></li></ul></section>');await reload(t);expect(material(t).reuseCandidates).toEqual([]);
  }finally{await t.close();}
});

it('requires a new depth decision for an explicitly reused page traversal partition',async()=>{
  const t=await fixture();try{
    t.setHtml('<div style="height:3000px">Long passive page</div>');await reload(t);const m=material(t);
    await t.engine.reviewRegions(t.sid,{observationId:m.observationId,...reason,regions:[{key:'page',label:'Page',candidateIds:[m.candidates.find(c=>c.basis==='document')!.id],controlIds:[],pageTraversal:true,reuse}]});
    await reload(t);await t.engine.reuseRegionReviews(t.sid,proposal(t,'page'));
    expect(material(t).unassignedPageTraversal).toBe(false);expect(group(t,'Page').decisions).toEqual([]);
    await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(t.engine.session(t.sid).actionCount).toBe(0);
    const g=group(t,'Page');await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{...reason,mode:'all'});
    await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(t.engine.session(t.sid).actionCount).toBeGreaterThan(0);
    expect(t.engine.list<any>(t.sid,'attempt').every(a=>a.action.kind==='scroll')).toBe(true);
  }finally{await t.close();}
});

it('does not guess a same-named duplicate owner or silently retain a live-changed opted-in sibling',async()=>{
  const t=await fixture();try{
    await t.engine.reviewRegions(t.sid,partition(t));t.setHtml(markup+markup);await reload(t);expect(material(t).reuseCandidates).toEqual([]);
    t.setHtml(markup);await reload(t);await t.engine.reuseRegionReviews(t.sid,proposal(t,'Second'));
    const p=proposal(t,'First');await pageOf(t.engine).locator('#second').evaluate(el=>el.setAttribute('data-owner','private'));
    await expect(t.engine.reuseRegionReviews(t.sid,p)).rejects.toMatchObject({code:'STALE_REGION_REVIEW'});
    expect(material(t).review?.regions.find(r=>r.key==='Second')?.status).toBe('invalidated');
  }finally{await t.close();}
});

it('respects rejected current candidates even when a historical boundary would otherwise match',async()=>{
  const t=await fixture();try{
    await t.engine.reviewRegions(t.sid,partition(t));await reload(t);const m=material(t);
    await t.engine.reviewRegions(t.sid,{...partition(t,['Second']),rejectedCandidateIds:[m.candidates.find(c=>c.label==='First')!.id]});
    expect(material(t).reuseCandidates).toEqual([]);
    const latest=material(t);await t.engine.reviewRegions(t.sid,{observationId:latest.observationId,...reason,update:{baseReviewId:latest.review!.id},regions:[],rejectedCandidateIds:[]});
    expect(material(t).reuseCandidates!.map(c=>c.regionKey)).toEqual(['First']);
  }finally{await t.close();}
});

it('contains malformed region hook results and exposes reuse candidates without automatic acceptance',async()=>{
  let malformed=true,seen=0;const t=await fixture({regionReview:m=>{seen+=m.reuseCandidates?.length || 0;return malformed?{} as RegionReviewInput:undefined;}});try{
    expect(records(t)).toEqual([]);expect(t.engine.store.events(t.sid).some(e=>e.type==='hook.error')).toBe(true);
    malformed=false;await t.engine.reviewRegions(t.sid,partition(t,['First']));await reload(t);
    expect(seen).toBeGreaterThan(0);expect(material(t).review?.status).toBe('invalidated');
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  }finally{await t.close();}
});
