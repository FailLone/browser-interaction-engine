import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BrowserEngine, type ControlReviewRecord, type EngineHooks, type SessionOptions, type ControlReviewInput } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { InteractionClient } from '@interaction/client';
import { createServer as createApi } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';

const custom='<div id="custom" tabindex="0" style="cursor:pointer;width:120px;height:40px">Open info</div><script>window.clicks=0;document.querySelector("#custom").addEventListener("click",()=>window.clicks++);</script>';
const why={reason:'Open the informational UI',evidence:['Caller reviewed this exact current target'],risk:'interface' as const};
async function setup(html=custom,hooks:EngineHooks={},options:Partial<SessionOptions>={},persistence:MemoryStore|SqliteStore=new MemoryStore()){
  const site=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
  const engine=new BrowserEngine({persistence,hooks});const session=await engine.createSession({url:`http://127.0.0.1:${(site.address() as any).port}`,headless:true,settleMs:30,observeTimeoutMs:600,...options});
  return {engine,sid:session.id,close:async()=>{await engine.close();await new Promise<void>(r=>site.close(()=>r()));}};
}
type Fixture=Awaited<ReturnType<typeof setup>>;
const records=(t:Fixture)=>t.engine.list<ControlReviewRecord>(t.sid,'control-review');
function review(t:Fixture,name='Open info',extra:Partial<ControlReviewInput['reviews'][number]>={}):ControlReviewInput{
  const o=t.engine.observation(t.sid);return {observationId:o.id,source:'fixture-upper-layer',reviews:[{...why,localId:o.controls.find(c=>c.name===name)!.localId,kind:'click',...extra}]};
}
const action=(t:Fixture,name='Open info',kind='click')=>t.engine.actions(t.sid).find(a=>a.label===name&&a.kind===kind)!;

it('publishes deduplicated materials and executes a durable reviewed custom control without rewriting its observation',async()=>{
 const t=await setup();try{
  const before=t.engine.observation(t.sid);expect(t.engine.actions(t.sid)).toEqual([]);
  expect(t.engine.controlReviewMaterial(t.sid).pendingControlIds).toEqual([before.controls[0].localId]);
  await t.engine.observe(t.sid);expect(t.engine.store.events(t.sid).filter(e=>e.type==='control.review_requested')).toHaveLength(1);
  const [r]=await t.engine.reviewControls(t.sid,review(t));expect(r.status).toBe('active');expect(r.replayable).toBe(false);
  expect(t.engine.controlReviewMaterial(t.sid).pendingControlIds).toEqual([]);expect(t.engine.observation(t.sid,before.id)).toEqual(before);
  await t.engine.execute(t.sid,action(t).id,'reviewed-click');expect(await pageOf(t.engine).evaluate(()=>(window as any).clicks)).toBe(1);
  expect(t.engine.controlCoverage(t.sid).counts.covered).toBe(1);expect(records(t)[0].status).toBe('active');
 }finally{await t.close();}
});

it('runs bounded control hooks before caller action policy and keeps independent scope gates',async()=>{
 const t=await setup(custom,{controlReview:m=>({observationId:m.observationId,source:'hook-reviewer',reviews:[{...why,kind:'click',localId:m.controls[0].control.localId}]}),
  actions:as=>as.map(a=>({...a,excluded:true,exclusionReason:'caller-policy'})),
  explorationScopes:as=>[{key:'custom',kind:'custom',label:'Review depth',actionIds:as.map(a=>a.id),traversalActionIds:[],evidence:[{source:'test',rule:'custom/v1',facts:{}}]}]});try{
  expect(records(t)).toHaveLength(1);expect(action(t).exclusionReason).toBe('caller-policy');
  await expect(t.engine.execute(t.sid,action(t).id,'policy-block')).rejects.toMatchObject({code:'ACTION_EXCLUDED'});
  expect(t.engine.explorationReviewMaterial(t.sid).groups[0].decisions).toEqual([]);expect(t.engine.session(t.sid).actionCount).toBe(0);
 }finally{await t.close();}
});

it('does not persist a late control hook result',async()=>{
 const t=await setup(custom,{controlReview:async m=>{await new Promise(r=>setTimeout(r,5100));return {observationId:m.observationId,source:'late',reviews:[{...why,kind:'click',localId:m.controls[0].control.localId}]};}});try{
  await new Promise(r=>setTimeout(r,150));expect(records(t)).toEqual([]);expect(t.engine.actions(t.sid)).toEqual([]);
  expect(t.engine.store.events(t.sid).some(e=>e.type==='hook.error')).toBe(true);
 }finally{await t.close();}
});

it('publishes queryable requests for the final caller policy and requests again after revocation',async()=>{
 const t=await setup('<a href="#first">Open info</a>',{actions:as=>as.map(a=>a.source==='control-review'?a:{...a,excluded:true,exclusionReason:'navigation_requires_review'})});try{
  expect(t.engine.store.events(t.sid).filter(e=>e.type==='control.review_requested')).toHaveLength(1);
  const [r]=await t.engine.reviewControls(t.sid,review(t));
  await t.engine.revokeControlReview(t.sid,{reviewId:r.id,source:'caller',reason:'Review again'});
  const observed:string[]=[];t.engine.events.on('event',e=>{if(e.type==='control.review_requested'){
    const oid=(e.data as {observationId:string}).observationId;
    observed.push(t.engine.observation(t.sid,oid).id);
    expect(t.engine.controlReviewMaterial(t.sid).observationId).toBe(oid);
  }});
  await t.engine.observe(t.sid);await new Promise(r=>setTimeout(r,20));
  expect(observed).toEqual([t.engine.observation(t.sid).id]);
 }finally{await t.close();}
});

it('does not record an approval when its live preflight finishes after the hook deadline',async()=>{
 let approve=false;const t=await setup(custom,{controlReview:m=>approve?{observationId:m.observationId,source:'bounded-preflight',reviews:[{...why,kind:'click',localId:m.controls[0].control.localId}]}:undefined});try{
  approve=true;await pageOf(t.engine).locator('#custom').evaluate(el=>el.setAttribute('title','new review condition'));
  (t.engine as any).driver.preflight=async()=>{await new Promise(r=>setTimeout(r,5100));return 'valid';};
  await t.engine.observe(t.sid);await new Promise(r=>setTimeout(r,150));
  expect(records(t)).toEqual([]);expect(t.engine.actions(t.sid)).toEqual([]);
  expect(t.engine.store.events(t.sid).some(e=>e.type==='hook.error'&&(e.data as any).name==='controlReview-preflight')).toBe(true);
 }finally{await t.close();}
});

it('atomically rejects stale, duplicate, invisible and malformed reviews',async()=>{
 const t=await setup(custom+'<button hidden>Hidden</button>');try{
  const input=review(t);await t.engine.observe(t.sid);
  await expect(t.engine.reviewControls(t.sid,input)).rejects.toMatchObject({code:'STALE_CONTROL_REVIEW'});
  const fresh=review(t);for(const bad of [{...fresh,reviews:[...fresh.reviews,...fresh.reviews]},
   {...fresh,reviews:[...fresh.reviews,{...fresh.reviews[0],localId:t.engine.observation(t.sid).controls.find(c=>!c.visible)!.localId}]},
   {...fresh,reviews:[{...fresh.reviews[0],kind:'press' as const}]}])await expect(t.engine.reviewControls(t.sid,bad)).rejects.toBeDefined();
  expect(records(t)).toEqual([]);expect(t.engine.session(t.sid).actionCount).toBe(0);
 }finally{await t.close();}
});

for(const change of ['replace','href','parent','handler','url','context'] as const)it(`invalidates ${change} conditions before dispatch and never revives an old judgment`,async()=>{
 const t=await setup('<div id="one"><a id="custom" href="#one">Open info</a></div><div id="two"></div><span id="context">A</span>',{}, {contextRules:[{key:'mode',selector:'#context'}]});try{
  const [r]=await t.engine.reviewControls(t.sid,review(t));const old=action(t);
  await pageOf(t.engine).evaluate(change=>{
    const e=document.querySelector('#custom')!;
    if(change==='replace')e.replaceWith(e.cloneNode(true));
    if(change==='href')e.setAttribute('href','#different');
    if(change==='parent')document.querySelector('#two')!.append(e);
    if(change==='handler')e.setAttribute('onclick','event.preventDefault()');
    if(change==='url')history.pushState({},'','#new');
    if(change==='context')document.querySelector('#context')!.textContent='B';
  },change);
  await expect(t.engine.execute(t.sid,old.id,'changed-target')).rejects.toBeDefined();
  expect(records(t).find(x=>x.id===r.id)?.status).toBe('invalidated');expect(t.engine.session(t.sid).actionCount).toBe(0);
  await pageOf(t.engine).evaluate(()=>{document.querySelector('#custom')!.setAttribute('href','#one');document.querySelector('#context')!.textContent='A';});await t.engine.observe(t.sid);
  expect(records(t).find(x=>x.id===r.id)?.status).toBe('invalidated');
 }finally{await t.close();}
});

it('supports sampled inputs while preserving constraints, availability and native submission risk',async()=>{
 const t=await setup('<input aria-label="Amount" type="number" min="0" max="10"><button disabled>Disabled</button><form action="/pay"><button>Pay</button></form>');try{
  await expect(t.engine.reviewControls(t.sid,review(t,'Pay'))).rejects.toMatchObject({code:'INVALID_CONTROL_REVIEW'});
  await t.engine.reviewControls(t.sid,review(t,'Amount',{kind:'fill',samples:['2','20']}));
  const invalid=t.engine.actions(t.sid).find(a=>a.value==='20')!;await expect(t.engine.execute(t.sid,invalid.id,'invalid-number')).rejects.toMatchObject({code:'INVALID_INPUT'});
  await t.engine.execute(t.sid,t.engine.actions(t.sid).find(a=>a.value==='2')!.id,'valid-number');expect(await pageOf(t.engine).getByRole('spinbutton').inputValue()).toBe('2');
  expect(records(t)[0].status).toBe('active');
  await t.engine.reviewControls(t.sid,review(t,'Disabled'));await expect(t.engine.execute(t.sid,action(t,'Disabled').id,'disabled')).rejects.toMatchObject({code:'ACTION_BLOCKED'});
  expect(t.engine.session(t.sid).actionCount).toBe(1);
 }finally{await t.close();}
});

it('binds associated form endpoints and refuses a judgment with unknown declared context',async()=>{
 const t=await setup('<form id="form" action="/first"><input aria-label="Amount"></form>');try{
  const [r]=await t.engine.reviewControls(t.sid,review(t,'Amount',{kind:'fill',samples:['5']}));const prepared=action(t,'Amount','fill');
  await pageOf(t.engine).locator('#form').evaluate(el=>el.setAttribute('action','/different'));
  await expect(t.engine.execute(t.sid,prepared.id,'changed-form')).rejects.toMatchObject({code:'STALE_OBSERVATION'});
  expect(records(t).find(x=>x.id===r.id)?.status).toBe('invalidated');
 }finally{await t.close();}
 const unknown=await setup(custom,{context:()=>({account:{value:null,status:'unknown',source:'application'}})});try{
  await expect(unknown.engine.reviewControls(unknown.sid,review(unknown))).rejects.toMatchObject({code:'UNKNOWN_REVIEW_CONTEXT'});expect(records(unknown)).toEqual([]);
 }finally{await unknown.close();}
});

it('checks changed read-only target bindings without blocking unrelated actions',async()=>{
 const t=await setup('<input readonly aria-label="Quote A" value="1"><button>Open info</button>');try{
  await t.engine.reviewControls(t.sid,review(t,'Quote A',{kind:'hover'}));const old=action(t,'Quote A','hover');
  await pageOf(t.engine).getByRole('textbox').evaluate(el=>el.setAttribute('aria-label','Quote B'));
  await expect(t.engine.execute(t.sid,old.id,'changed-readonly-target')).rejects.toMatchObject({code:'STALE_OBSERVATION'});
  expect(records(t)[0].status).toBe('invalidated');
  const unrelated=action(t);await pageOf(t.engine).getByRole('textbox').evaluate(el=>el.setAttribute('aria-label','Quote C'));
  expect((await t.engine.execute(t.sid,unrelated.id,'unrelated-readonly-change')).status).toBe('succeeded');
 }finally{await t.close();}
});

it('uses a sourced current exit, verifies its result and expires the boundary-bound review',async()=>{
 const t=await setup('<button type="button" id="toggle" style="position:fixed;top:5px;left:5px;z-index:10" onclick="document.querySelector(\'#panel\').hidePopover()">Dismiss panel</button><div id="panel" popover><input aria-label="Inside"></div><script>document.querySelector("#panel").showPopover()</script>');try{
  const boundary=t.engine.observation(t.sid).boundaries!.at(-1)!.key;
  const [r]=await t.engine.reviewControls(t.sid,review(t,'Dismiss panel',{exitBoundary:boundary,replayable:true}));
  expect(action(t,'Dismiss panel').boundary?.intent).toBe('exit');expect(action(t,'Dismiss panel').replayable).toBe(false);
  expect((await t.engine.execute(t.sid,action(t,'Dismiss panel').id,'reviewed-exit')).status).toBe('succeeded');
  expect(t.engine.observation(t.sid).boundaries).toEqual([]);expect(records(t).find(x=>x.id===r.id)?.status).toBe('invalidated');
 }finally{await t.close();}
});

it('supports reviewed hover without clicking and preserves occlusion and explicit exclusions',async()=>{
 const t=await setup('<style>#hint span{visibility:hidden;position:absolute}#hint:hover span{visibility:visible}</style><div id="hint" tabindex="0" style="cursor:pointer">Info<span role="tooltip">Help</span></div><button id="covered" style="position:absolute;top:100px;left:20px">Covered</button><div style="position:absolute;top:95px;left:15px;width:160px;height:70px;background:black;z-index:20"></div><button>Excluded</button>',{}, {exclude:[{name:'Excluded'}]});try{
  await t.engine.reviewControls(t.sid,review(t,'Info',{kind:'hover'}));expect((await t.engine.execute(t.sid,action(t,'Info','hover').id,'hover')).status).toBe('succeeded');
  expect(t.engine.observation(t.sid).text).toContain('Help');expect(records(t)[0].status).toBe('active');
  await t.engine.reviewControls(t.sid,review(t,'Covered',{kind:'hover'}));await expect(t.engine.execute(t.sid,action(t,'Covered','hover').id,'occluded')).rejects.toMatchObject({code:'ACTION_BLOCKED'});
  await t.engine.reviewControls(t.sid,review(t,'Excluded'));await expect(t.engine.execute(t.sid,action(t,'Excluded').id,'excluded')).rejects.toMatchObject({code:'ACTION_EXCLUDED'});
 }finally{await t.close();}
});

it('replaces and revokes queued judgments without resurrecting earlier approvals or erasing execution',async()=>{
 const t=await setup();try{
  const [first]=await t.engine.reviewControls(t.sid,review(t));await t.engine.execute(t.sid,action(t).id,'first-approved');
  const [second]=await t.engine.reviewControls(t.sid,review(t,'Open info',{replayable:true}));const queued=action(t);
  await t.engine.revokeControlReview(t.sid,{reviewId:second.id,source:'caller',reason:'Withdraw purpose judgment'});
  await expect(t.engine.execute(t.sid,queued.id,'revoked-action')).rejects.toMatchObject({code:'CONTROL_REVIEW_EXPIRED'});
  expect(records(t).find(r=>r.id===first.id)?.status).toBe('superseded');await t.engine.observe(t.sid);expect(t.engine.actions(t.sid)).toEqual([]);
  expect(t.engine.report(t.sid).explorationAudit.counts.succeeded).toBe(1);expect(t.engine.session(t.sid).actionCount).toBe(1);
 }finally{await t.close();}
});

it('serves review materials, records and revocation over HTTP with session isolation',async()=>{
 const t=await setup();const api=await createApi(t.engine);await api.listen({host:'127.0.0.1',port:0});const client=new InteractionClient(`http://127.0.0.1:${(api.server.address() as any).port}`);try{
  expect((await client.controlReviewMaterial(t.sid)).pendingControlIds).toHaveLength(1);
  const [r]=await client.reviewControls(t.sid,review(t));expect((await client.controlReviews(t.sid)).items[0].id).toBe(r.id);
  await client.revokeControlReview(t.sid,{reviewId:r.id,source:'http-caller',reason:'No longer in scope'});
  expect((await client.controlReviews(t.sid)).items[0].status).toBe('revoked');
  await expect(client.revokeControlReview('missing',{reviewId:r.id,source:'caller',reason:'bad session'})).rejects.toMatchObject({code:'NOT_FOUND'});
 }finally{await api.close();await t.close();}
});

it('keeps SQLite review history across restart but invalidates grants for the new browser document',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'control-reviews-'));const t=await setup(custom,{}, {},new SqliteStore(directory));let next:BrowserEngine|undefined;try{
  const [r]=await t.engine.reviewControls(t.sid,review(t));await t.engine.close();
  next=new BrowserEngine({persistence:new SqliteStore(directory)});expect(next.list<ControlReviewRecord>(t.sid,'control-review')[0].id).toBe(r.id);
  await next.observe(t.sid);expect(next.list<ControlReviewRecord>(t.sid,'control-review')[0].status).toBe('invalidated');
  expect(next.actions(t.sid)).toEqual([]);
 }finally{await next?.close();await t.close();rmSync(directory,{recursive:true,force:true});}
});
