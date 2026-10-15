import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BrowserEngine, type ControlReviewRecord, type EngineHooks, type ReuseControlReviewsInput, type SessionOptions } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { InteractionClient } from '@interaction/client';
import { createServer as apiServer } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';

const html = '<nav id="tools" data-business="public"><a id="details" href="/b">Details</a><a href="/other">Other</a></nav>';
const reuse = { binding: 'same-url-context' as const, businessScope: 'Public information navigation; no account or transaction effects' };
async function fixture(options: Partial<SessionOptions> = {}, hooks: EngineHooks = {}, persistence: MemoryStore | SqliteStore = new MemoryStore()) {
  let body = html;
  const site = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/a' ? body : '<button>Destination business action</button>'); });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(site.address() as {port:number}).port}/a`;
  const engine = new BrowserEngine({ persistence, hooks: { ...hooks, actions: (as, ctx) => {
    const guarded = as.map(a => a.source === 'control-review' ? a : {...a, excluded:true, exclusionReason:'navigation_requires_review'});
    return hooks.actions ? hooks.actions(guarded, ctx) : guarded;
  } } });
  const session = await engine.createSession({url,headless:true,settleMs:25,observeTimeoutMs:600,...options});
  return {engine,sid:session.id,url,setBody:(next:string)=>{body=next;},close:async()=>{await engine.close();await new Promise<void>(r=>site.close(()=>r()));}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const target=(t:Fixture)=>t.engine.observation(t.sid).controls.find(c=>c.selector==='#details')!;
const records=(t:Fixture)=>t.engine.list<ControlReviewRecord>(t.sid,'control-review');
async function approve(t:Fixture, reusable=true) {
  return (await t.engine.reviewControls(t.sid,{observationId:t.engine.observation(t.sid).id,source:'upper-original',reviews:[{
    localId:target(t).localId,kind:'click',risk:'interface',replayable:true,reason:'Open the public details page',
    evidence:['Reviewed the ordinary navigation purpose'],...(reusable?{reuse}:{}),
  }]}))[0];
}
async function reload(t:Fixture) {await pageOf(t.engine).reload();await t.engine.observe(t.sid);}
function proposal(t:Fixture, sourceId?:string):ReuseControlReviewsInput {
  const material=t.engine.controlReviewMaterial(t.sid),entry=material.controls.find(x=>x.control.localId===target(t).localId)!;
  const match=sourceId?entry.reuseCandidates!.find(c=>c.review.id===sourceId)!:entry.reuseCandidates![0];
  return {observationId:material.observationId,source:'upper-reuse',businessScope:reuse.businessScope,evidence:['Current structure, URL and declared context fit this purpose'],
    reviews:[{reviewId:match.review.id,localId:entry.control.localId,conditionKey:match.conditionKey}]};
}
const candidates=(t:Fixture)=>t.engine.controlReviewMaterial(t.sid).controls.find(x=>x.control.localId===target(t).localId)!.reuseCandidates!;

it('offers opted-in purposes after A→B→A without reactivating the old review or approving exploration depth',async()=>{
  const t=await fixture({regionExploration:'review'});try{
    const source=await approve(t);const old=target(t).localId;
    await pageOf(t.engine).goto(t.url.replace('/a','/b'));await t.engine.observe(t.sid);
    expect(records(t)[0].status).toBe('invalidated');
    await pageOf(t.engine).goto(t.url);await t.engine.observe(t.sid);
    expect(target(t).localId).not.toBe(old);expect(candidates(t).map(c=>c.review.id)).toEqual([source.id]);
    expect(t.engine.actions(t.sid).every(a=>a.excluded)).toBe(true);
    const [copy]=await t.engine.reuseControlReviews(t.sid,proposal(t));
    expect(copy).toMatchObject({status:'active',replayable:false,source:'upper-reuse',reusedFrom:{reviewId:source.id}});
    expect(copy.id).not.toBe(source.id);expect(copy.conditions.instanceScope).not.toBe(source.conditions.instanceScope);
    expect(records(t).find(r=>r.id===source.id)!.status).toBe('invalidated');
    expect(t.engine.store.events(t.sid).filter(e=>e.type==='control.review_reused')).toHaveLength(1);
    const destination=t.engine.explorationReviewMaterial(t.sid).groups.find(g=>g.kind==='page')!;
    await t.engine.decideExplorationGroup(t.sid,destination.id,destination.revision,{mode:'skip',source:'upper-depth',evidence:['Destination arrival only']});
    await t.engine.explore(t.sid);await t.engine.waitForIdle();
    expect(t.engine.session(t.sid).actionCount).toBe(0);
    expect(t.engine.session(t.sid).stopReason).toBe('REGION_REVIEW_REQUIRED');
    // A purpose is not a scope decision: approve a fresh region and a fresh member separately.
    const o=t.engine.observation(t.sid),r=o.regionCandidates!.find(c=>c.selector==='#tools')!;
    await t.engine.reviewRegions(t.sid,{observationId:o.id,source:'upper-scope',evidence:['Only the details entry'],regions:[{key:'details',label:'Details navigation',candidateIds:[r.id],controlIds:[target(t).localId]}]});
    const g=t.engine.explorationReviewMaterial(t.sid).groups.find(g=>g.kind==='reviewed-region'&&g.status!=='invalidated')!;
    await t.engine.decideExplorationGroup(t.sid,g.id,g.revision,{mode:'sample',memberKeys:[g.members.find(m=>!m.excluded)!.key],source:'upper-depth',evidence:['One navigation only']});
    await t.engine.explore(t.sid);await t.engine.waitForIdle();
    const attempts=t.engine.list<any>(t.sid,'attempt');
    expect(attempts.map(a=>[a.action.label,a.action.kind])).toEqual([['Details','click'],['Return to observed page','history']]);
    expect(t.engine.observation(t.sid).url).toBe(t.url);
    expect(attempts[0].action.basis.evidence.some((e:any)=>e.rule==='reused-control-review/v1')).toBe(true);
    expect(t.engine.store.events(t.sid).some(e=>e.type==='exploration.page_returned')).toBe(true);
  }finally{await t.close();}
});

for(const change of ['href','label','target-data','ancestor-data','ancestor-label','handler','parent','url','context'] as const)it(`rejects changed ${change} instead of transplanting a same-named purpose`,async()=>{
  let context='demo';const t=await fixture({}, {context:()=>({account:{status:'known',value:context,source:'fixture'}})});try{
    const source=await approve(t);const key=t.engine.store.get<ControlReviewRecord>('control-review',source.id)!.reuseConditions;
    expect(key).toBeDefined();
    const replacements={href:html.replace('/b','/different'),label:html.replace('Details','Different'),
      'target-data':html.replace('id="details"','id="details" data-account="live"'),
      'ancestor-data':html.replace('data-business="public"','data-business="private"'),
      'ancestor-label':html.replace('id="tools"','id="tools" aria-label="Account changes"'),
      handler:html.replace('id="details"','id="details" onclick="event.preventDefault()"'),
      parent:html.replace('<a id="details"','<div id="moved"><a id="details"').replace('Details</a>','Details</a></div>')};
    if(change==='context')context='live';
    else if(change!=='url')t.setBody(replacements[change]);
    await reload(t);
    if(change==='url'){await pageOf(t.engine).evaluate(()=>history.pushState({},'','#new'));await t.engine.observe(t.sid);}
    expect(candidates(t)).toEqual([]);expect(records(t)).toHaveLength(1);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  }finally{await t.close();}
});

it('requires explicit opt-in and a known context, and refuses ordinary reuse for lists, exits and submissions',async()=>{
  let known=true;const t=await fixture({}, {context:()=>({account:{status:known?'known':'unknown',value:'demo',source:'fixture'}})});try{
    await approve(t,false);await reload(t);expect(candidates(t)).toEqual([]);
    await approve(t);await reload(t);expect(candidates(t)).toHaveLength(1);
    known=false;await t.engine.observe(t.sid);expect(candidates(t)).toEqual([]);
    known=true;t.setBody('<form><button id="details">Submit</button></form>');await reload(t);
    await expect(approve(t)).rejects.toMatchObject({code:'INVALID_CONTROL_REVIEW'});
    t.setBody('<div role="listbox"><button id="details" type="button">Details</button></div>');await reload(t);
    await expect(approve(t)).rejects.toMatchObject({code:'INVALID_CONTROL_REVIEW'});
  }finally{await t.close();}
});

it('validates the complete batch and current observation before creating any copies',async()=>{
  const t=await fixture();try{
    await approve(t);await reload(t);const valid=proposal(t);
    await expect(t.engine.reuseControlReviews(t.sid,{...valid,businessScope:'Different business'})).rejects.toMatchObject({code:'CONTROL_REVIEW_REUSE_MISMATCH'});
    await expect(t.engine.reuseControlReviews(t.sid,{...valid,reviews:[...valid.reviews,{...valid.reviews[0],conditionKey:'wrong'}]})).rejects.toMatchObject({code:'CONTROL_REVIEW_REUSE_MISMATCH'});
    await expect(t.engine.reuseControlReviews(t.sid,{...valid,reviews:[...valid.reviews,...valid.reviews]})).rejects.toMatchObject({code:'INVALID_CONTROL_REVIEW'});
    expect(records(t)).toHaveLength(1);
    await t.engine.observe(t.sid);await expect(t.engine.reuseControlReviews(t.sid,valid)).rejects.toMatchObject({code:'STALE_CONTROL_REVIEW'});
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  }finally{await t.close();}
});

it('checks live structural evidence both at reuse and again before dispatch',async()=>{
  const t=await fixture();try{
    const source=await approve(t);await reload(t);const input=proposal(t);
    await pageOf(t.engine).locator('#tools').evaluate(e=>e.setAttribute('data-business','changed'));
    await expect(t.engine.reuseControlReviews(t.sid,input)).rejects.toMatchObject({code:'STALE_CONTROL_REVIEW'});
    expect(records(t)).toHaveLength(1);
    await reload(t);await t.engine.reuseControlReviews(t.sid,proposal(t,source.id));
    const action=t.engine.actions(t.sid).find(a=>a.label==='Details')!;
    await pageOf(t.engine).locator('#tools').evaluate(e=>e.setAttribute('data-business','changed-again'));
    await expect(t.engine.execute(t.sid,action.id,'changed-ancestor')).rejects.toMatchObject({code:'STALE_OBSERVATION'});
    expect(t.engine.session(t.sid).actionCount).toBe(0);
    expect(records(t).at(-1)!.status).toBe('invalidated');
  }finally{await t.close();}
});

it('checks associated form endpoints across documents and preserves input constraints',async()=>{
  const t=await fixture();try{
    t.setBody('<form id="form" action="/preview"><input id="details" type="number" aria-label="Amount" min="0" max="10"></form>');await reload(t);
    const [source]=await t.engine.reviewControls(t.sid,{observationId:t.engine.observation(t.sid).id,source:'upper',reviews:[{localId:target(t).localId,kind:'fill',risk:'interface',reason:'Local amount preview',evidence:['Reviewed preview'],samples:['2','20'],reuse}]});
    await reload(t);await t.engine.reuseControlReviews(t.sid,proposal(t,source.id));
    await expect(t.engine.execute(t.sid,t.engine.actions(t.sid).find(a=>a.value==='20')!.id,'invalid-value')).rejects.toMatchObject({code:'INVALID_INPUT'});
    await t.engine.execute(t.sid,t.engine.actions(t.sid).find(a=>a.value==='2')!.id,'valid-value');
    expect(await pageOf(t.engine).locator('#details').inputValue()).toBe('2');
    t.setBody('<form id="form" action="/commit"><input id="details" type="number" aria-label="Amount" min="0" max="10"></form>');await reload(t);
    expect(candidates(t)).toEqual([]);
  }finally{await t.close();}
});

it('serves reuse over HTTP and revokes an entire provenance chain without reviving older grants',async()=>{
  const t=await fixture();const api=await apiServer(t.engine);const url=await api.listen({host:'127.0.0.1',port:0});const client=new InteractionClient(url);try{
    const original=await approve(t);await reload(t);
    const material=await client.controlReviewMaterial(t.sid);expect(material.controls.find(c=>c.control.name==='Details')!.reuseCandidates![0].review.id).toBe(original.id);
    const [first]=await client.reuseControlReviews(t.sid,proposal(t));await reload(t);
    const [second]=await client.reuseControlReviews(t.sid,proposal(t,first.id));
    const prepared=t.engine.actions(t.sid).find(a=>a.label==='Details')!;
    await client.revokeControlReview(t.sid,{reviewId:original.id,source:'upper',reason:'Purpose withdrawn'});
    await expect(client.execute(t.sid,prepared.id,'revoked-source')).rejects.toMatchObject({code:'CONTROL_REVIEW_EXPIRED'});
    expect(records(t).find(r=>r.id===second.id)!.status).toBe('invalidated');
    await reload(t);expect(candidates(t)).toEqual([]);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  }finally{await api.close();await t.close();}
});

it('retains opt-in evidence across storage restart but still requires a fresh explicit reuse decision',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ordinary-reuse-'));const t=await fixture({}, {},new SqliteStore(dir));try{
    const original=await approve(t);await t.engine.close();
    const restored=new BrowserEngine({persistence:new SqliteStore(dir)});try{
      await restored.observe(t.sid);
      const m=restored.controlReviewMaterial(t.sid),entry=m.controls.find(c=>c.control.name==='Details')!;
      expect(entry.reuseCandidates!.map(c=>c.review.id)).toEqual([original.id]);
      expect(restored.list<ControlReviewRecord>(t.sid,'control-review')[0].status).toBe('invalidated');
      expect(restored.actions(t.sid).every(a=>a.source!=='control-review')).toBe(true);
    }finally{await restored.close();}
  }finally{await t.close();rmSync(dir,{recursive:true,force:true});}
});

it('permits explicit reuse for a rebuilt node but not a second indistinguishable live target',async()=>{
  const t=await fixture();try{
    const source=await approve(t);
    await pageOf(t.engine).locator('#details').evaluate(e=>e.replaceWith(e.cloneNode(true)));await t.engine.observe(t.sid);
    expect(candidates(t).map(c=>c.review.id)).toEqual([source.id]);
    const [copy]=await t.engine.reuseControlReviews(t.sid,proposal(t));
    expect(copy.conditions.instanceScope).toBe(source.conditions.instanceScope);
    expect(copy.conditions.target.instanceId).not.toBe(source.conditions.target.instanceId);
    await pageOf(t.engine).locator('#details').evaluate(e=>e.after(e.cloneNode(true)));await t.engine.observe(t.sid);
    expect(t.engine.controlReviewMaterial(t.sid).controls.filter(c=>c.control.name==='Details').every(c=>!c.reuseCandidates?.length)).toBe(true);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  }finally{await t.close();}
});

it('keeps caller exclusions and disabled/occluded target checks after reuse',async()=>{
  let deny=false;const t=await fixture({}, {actions:as=>deny?as.map(a=>({...a,excluded:true,exclusionReason:'caller-denied'})):as});try{
    t.setBody('<nav id="tools"><button id="details" type="button">Details</button></nav>');await reload(t);
    await approve(t);await reload(t);await t.engine.reuseControlReviews(t.sid,proposal(t));
    deny=true;await t.engine.observe(t.sid);
    await expect(t.engine.execute(t.sid,t.engine.actions(t.sid)[0].id,'caller-denied')).rejects.toMatchObject({code:'ACTION_EXCLUDED'});
    deny=false;await pageOf(t.engine).locator('#details').evaluate(e=>e.setAttribute('disabled',''));await t.engine.observe(t.sid);
    await expect(t.engine.execute(t.sid,t.engine.actions(t.sid)[0].id,'disabled')).rejects.toMatchObject({code:'ACTION_BLOCKED'});
    await pageOf(t.engine).evaluate(()=>{document.getElementById('details')!.removeAttribute('disabled');const block=document.createElement('div');block.style.cssText='position:fixed;inset:0;z-index:100;background:red';document.body.append(block);});await t.engine.observe(t.sid);
    await expect(t.engine.execute(t.sid,t.engine.actions(t.sid)[0].id,'occluded')).rejects.toMatchObject({code:'ACTION_BLOCKED'});
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  }finally{await t.close();}
});

it('rejects missing bounded evidence and sources from another session',async()=>{
  const t=await fixture();try{
    const source=await approve(t);await reload(t);const before=proposal(t);
    await t.engine.stop(t.sid);const other=await t.engine.createSession({url:t.url,headless:true,settleMs:25,observeTimeoutMs:600});
    const current=t.engine.observation(other.id);
    await expect(t.engine.reuseControlReviews(other.id,{...before,observationId:current.id,reviews:[{...before.reviews[0],localId:current.controls.find(c=>c.name==='Details')!.localId}]})).rejects.toMatchObject({code:'CONTROL_REVIEW_REUSE_MISMATCH'});
    expect(t.engine.list<ControlReviewRecord>(other.id,'control-review')).toEqual([]);
    expect(t.engine.store.get<ControlReviewRecord>('control-review',source.id)).toBeDefined();
    // An over-depth ancestry is intentionally ineligible, rather than partially compared.
    t.setBody('<div>'.repeat(34)+html+'</div>'.repeat(34));await pageOf(t.engine).reload();await t.engine.observe(other.id);
    const deep=t.engine.observation(other.id).controls.find(c=>c.name==='Details')!;
    expect(deep.reviewReuseBinding).toBeUndefined();
    await expect(t.engine.reviewControls(other.id,{observationId:t.engine.observation(other.id).id,source:'upper',reviews:[{localId:deep.localId,kind:'click',risk:'interface',reason:'Deep entry',evidence:['Bounded source missing'],reuse}]})).rejects.toBeDefined();
  }finally{await t.close();}
});
