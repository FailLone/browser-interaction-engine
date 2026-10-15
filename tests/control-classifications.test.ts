import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BrowserEngine, type ControlClassificationRecord, type ControlClassification, type EngineHooks, type SessionOptions, describeControlCoverage } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { InteractionClient } from '@interaction/client';
import { createServer as createApi } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';

const prose = '<div id="one"><div id="candidate" tabindex="0" aria-label="Candidate">Read this text</div></div><div id="two"></div><span id="context">A</span>';
async function setup(html = prose, hooks: EngineHooks = {}, options: Partial<SessionOptions> = {}, persistence: MemoryStore | SqliteStore = new MemoryStore()) {
  const site = createServer((_req,res) => { res.setHeader('Content-Type','text/html'); res.end(html); });
  await new Promise<void>(r => site.listen(0,'127.0.0.1',r));
  const engine = new BrowserEngine({persistence,hooks});
  const session = await engine.createSession({url:`http://127.0.0.1:${(site.address() as any).port}`,headless:true,settleMs:30,observeTimeoutMs:600,...options});
  return {engine,sid:session.id,close:async()=>{await engine.close();await new Promise<void>(r=>site.close(()=>r()));}};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const records = (t: Fixture) => t.engine.list<ControlClassificationRecord>(t.sid,'control-classification');
function input(t: Fixture, classification: ControlClassification['classification'] = 'display') {
  const o = t.engine.observation(t.sid), c = o.controls.find(c=>c.stableKey==='id:candidate')!;
  return {observationId:o.id,source:'fixture-upper-layer',classifications:[{localId:c.localId,classification,reason:'Interpret this exact fixture node',evidence:['Reviewed current text and bounded subtree']} ]};
}

it('classifies a weak display with provenance, removes review noise and never counts it as execution',async()=>{
  const t=await setup();try{
    const before=t.engine.observation(t.sid);expect(t.engine.controlCoverage(t.sid).counts.unconfirmed).toBe(1);
    const [r]=await t.engine.classifyControls(t.sid,input(t));expect(r.status).toBe('active');
    expect(t.engine.controlClassificationMaterial(t.sid).pendingControlIds).toEqual([]);
    expect(t.engine.controlReviewMaterial(t.sid).pendingControlIds).toEqual([]);
    expect(t.engine.actions(t.sid)).toEqual([]);expect(t.engine.session(t.sid).actionCount).toBe(0);
    expect(t.engine.observation(t.sid,before.id)).toEqual(before);
    const report=t.engine.report(t.sid);expect(report.controlCoverage.counts).toMatchObject({unconfirmed:0,display:1,covered:0,actionable:0});
    expect(report.completionAudit.controlClassifications[0]).toMatchObject({id:r.id,source:'fixture-upper-layer',reason:r.reason});
    expect(report.completionAudit.exhaustive).toBe(false);expect(report.completionAudit.gaps.some(g=>g.code==='EVENT_LISTENER_COVERAGE')).toBe(true);
    report.completionAudit.controlClassifications[0].evidence.length=0;expect(records(t)[0].evidence).toHaveLength(1);
  }finally{await t.close();}
});

it('retires only an unattempted tentative container operation and keeps child operations available',async()=>{
  const t=await setup('<div id="candidate" aria-label="Candidate" onclick="window.delegated=true"><button type="button">Child</button></div>',{}, {exploration:'stateful'});try{
    const before=t.engine.getFrontier(t.sid);expect(before.some(f=>f.action.label==='Candidate')).toBe(true);
    const [r]=await t.engine.classifyControls(t.sid,input(t,'container'));
    expect(t.engine.actions(t.sid).some(a=>a.label==='Candidate')).toBe(false);
    const retired=t.engine.getFrontier(t.sid).find(f=>f.action.label==='Candidate')!;
    expect(retired).toMatchObject({status:'superseded',reason:'control_classified_noninteractive',attempts:[]});
    expect(retired.action.basis!.evidence.at(-1)?.facts.classificationId).toBe(r.id);
    expect(t.engine.report(t.sid).explorationAudit.counts.retired).toBe(1);
    const child=t.engine.actions(t.sid).find(a=>a.label==='Child')!;expect(child).toBeDefined();
    expect((await t.engine.execute(t.sid,child.id,'child')).status).toBe('succeeded');
    expect(t.engine.controlCoverage(t.sid).counts).toMatchObject({containers:1,actionable:1,covered:1});
    await t.engine.revokeControlClassification(t.sid,{classificationId:r.id,source:'caller',reason:'Reconsider container'});
    expect(t.engine.getFrontier(t.sid).find(f=>f.action.label==='Candidate')).toMatchObject({status:'blocked',reason:'action_basis_unconfirmed'});
    expect(t.engine.controlReviewMaterial(t.sid).pendingControlIds.length).toBeGreaterThan(0);
  }finally{await t.close();}
});

for(const classification of ['interaction','probe_required','unresolved'] as const)it(`records ${classification} without granting an operation or silently dismissing uncertainty`,async()=>{
  const t=await setup();try{
    await t.engine.classifyControls(t.sid,input(t,classification));
    expect(t.engine.actions(t.sid)).toEqual([]);expect(t.engine.controlReviewMaterial(t.sid).pendingControlIds).toHaveLength(1);
    expect(t.engine.controlCoverage(t.sid).counts).toMatchObject({unconfirmed:1,covered:0,display:0,containers:0});
    expect(t.engine.session(t.sid).actionCount).toBe(0);
    await t.engine.observe(t.sid);expect(records(t)).toHaveLength(1);
  }finally{await t.close();}
});

it('rejects an entire batch that would erase supported native capability, including disabled controls',async()=>{
  const t=await setup(prose+'<button disabled>Disabled</button>');try{
    const i=input(t);i.classifications.push({...i.classifications[0],localId:t.engine.observation(t.sid).controls.find(c=>c.name==='Disabled')!.localId});
    await expect(t.engine.classifyControls(t.sid,i)).rejects.toMatchObject({code:'INVALID_CONTROL_CLASSIFICATION'});
    expect(records(t)).toEqual([]);expect(t.engine.actions(t.sid).find(a=>a.label==='Disabled')!.basis?.status).toBe('supported');
  }finally{await t.close();}
});

it('requires complete bounded structure and rejects stale, duplicate, hidden and evidence-free classifications',async()=>{
  const t=await setup(prose+'<div tabindex="0" hidden>Hidden</div>');try{
    const i=input(t);await t.engine.observe(t.sid);
    await expect(t.engine.classifyControls(t.sid,i)).rejects.toMatchObject({code:'STALE_CONTROL_CLASSIFICATION'});
    const fresh=input(t);
    for(const classifications of [[...fresh.classifications,...fresh.classifications],[{...fresh.classifications[0],evidence:[]}],[{...fresh.classifications[0],localId:t.engine.observation(t.sid).controls.find(c=>!c.visible)!.localId}]]){
      await expect(t.engine.classifyControls(t.sid,{...fresh,classifications})).rejects.toBeDefined();
    }
    await pageOf(t.engine).locator('#candidate').evaluate(el=>{el.innerHTML='<i></i>'.repeat(210);});await t.engine.observe(t.sid);
    expect(t.engine.observation(t.sid).controls.find(c=>c.stableKey==='id:candidate')!.classificationBinding?.truncated).toBe(true);
    await expect(t.engine.classifyControls(t.sid,input(t))).rejects.toMatchObject({code:'INVALID_CONTROL_CLASSIFICATION'});
    expect(records(t)).toEqual([]);
  }finally{await t.close();}
});

for(const change of ['replace','parent','structure','text','handler','context','url','capability'] as const)it(`invalidates ${change} and keeps the old classification as history`,async()=>{
  const t=await setup(prose,{}, {contextRules:[{key:'mode',selector:'#context'}]});try{
    const [r]=await t.engine.classifyControls(t.sid,input(t));
    await pageOf(t.engine).evaluate(change=>{
      const el=document.querySelector('#candidate')!;
      if(change==='replace')el.replaceWith(el.cloneNode(true));
      if(change==='parent')document.querySelector('#two')!.append(el);
      if(change==='structure'){const span=document.createElement('span');span.textContent=el.textContent;el.replaceChildren(span);}
      if(change==='text')el.textContent='Different';
      if(change==='handler')el.setAttribute('onclick','window.changed=true');
      if(change==='context')document.querySelector('#context')!.textContent='B';
      if(change==='url')history.pushState({},'','#different');
      if(change==='capability')el.setAttribute('role','button');
    },change);await t.engine.observe(t.sid);
    expect(records(t).find(x=>x.id===r.id)?.status).toBe('invalidated');
    if(change==='capability')expect(t.engine.actions(t.sid).find(a=>a.label==='Candidate')?.basis?.status).toBe('supported');
    else expect(t.engine.controlClassificationMaterial(t.sid).pendingControlIds).toHaveLength(1);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  }finally{await t.close();}
});

it('rejects structure changed during review and an unknown declared context',async()=>{
  const t=await setup();try{
    const i=input(t);await pageOf(t.engine).locator('#candidate').evaluate(el=>el.append(document.createElement('i')));
    await expect(t.engine.classifyControls(t.sid,i)).rejects.toMatchObject({code:'STALE_CONTROL_CLASSIFICATION'});expect(records(t)).toEqual([]);
  }finally{await t.close();}
  const u=await setup(prose,{context:()=>({account:{status:'unknown',source:'test',value:null}})});try{
    await expect(u.engine.classifyControls(u.sid,input(u))).rejects.toMatchObject({code:'UNKNOWN_REVIEW_CONTEXT'});expect(records(u)).toEqual([]);
  }finally{await u.close();}
});

it('lets a later supported review override a negative interpretation while preserving that interpretation as invalid history',async()=>{
  const t=await setup();try{
    const [r]=await t.engine.classifyControls(t.sid,input(t));const o=t.engine.observation(t.sid);
    await t.engine.reviewControls(t.sid,{observationId:o.id,source:'reviewer',reviews:[{localId:input(t).classifications[0].localId,kind:'hover',risk:'interface',reason:'Review explicit hover',evidence:['Known UI hint contract']}]});
    expect(records(t).find(x=>x.id===r.id)?.status).toBe('invalidated');
    expect(t.engine.actions(t.sid).find(a=>a.kind==='hover')?.basis?.status).toBe('supported');
    expect(t.engine.controlCoverage(t.sid).counts).toMatchObject({actionable:1,covered:0,display:0});
    await expect(t.engine.classifyControls(t.sid,input(t))).rejects.toMatchObject({code:'INVALID_CONTROL_CLASSIFICATION'});
  }finally{await t.close();}
});

it('does not erase executed tentative probes or unresolved observations in another context',async()=>{
  const t=await setup('<div id="candidate" aria-label="Candidate" onclick="window.probes=(window.probes||0)+1">Probe</div>',{}, {exploration:'stateful'});try{
    const a=t.engine.actions(t.sid)[0];await t.engine.execute(t.sid,a.id,'probe');
    const [r]=await t.engine.classifyControls(t.sid,input(t));
    expect(t.engine.report(t.sid).explorationAudit.counts.succeeded).toBe(1);expect(t.engine.controlCoverage(t.sid).counts.covered).toBe(0);
    expect(t.engine.getFrontier(t.sid).some(f=>f.attempts.length===1)).toBe(true);
    const o=t.engine.observation(t.sid), other={...structuredClone(o),id:'other',context:{mode:{status:'known' as const,source:'test',value:'another'}}};
    const coverage=describeControlCoverage([o,other],[],[],[r]);expect(coverage.counts).toMatchObject({unconfirmed:1,display:0});
  }finally{await t.close();}
});

it('preserves a supported operation added by the final caller policy after the classification hook',async()=>{
  const t=await setup(prose,{
    controlClassification:m=>({observationId:m.observationId,source:'classifier',classifications:[{localId:m.pendingControlIds[0],classification:'display',reason:'Initial interpretation',evidence:['Current snapshot']}]}),
    actions:(as,{observation:o,session})=>{const c=o.controls.find(c=>c.stableKey==='id:candidate')!;return [...as,{id:'',sessionId:session.id,observationId:o.id,stateId:o.stateId,localId:c.localId,controlId:c.identityId,label:c.name,kind:'hover',risk:'interface',replayable:false,excluded:false,source:'caller',sampleValidity:'known',preconditions:{context:o.context,visible:true,enabled:true,identityResolved:true},basis:{status:'supported',evidence:[{source:'caller',rule:'fixture-hover/v1',facts:{reason:'Known hover implementation'}}]}}];},
  });try{
    expect(records(t)[0].status).toBe('invalidated');expect(t.engine.actions(t.sid).find(a=>a.kind==='hover')?.basis?.status).toBe('supported');
    expect(t.engine.controlCoverage(t.sid).counts).toMatchObject({actionable:1,display:0,covered:0});
  }finally{await t.close();}
});

it('replaces and revokes classifications without reviving an old dismissal',async()=>{
  const t=await setup();try{
    const [first]=await t.engine.classifyControls(t.sid,input(t));const [second]=await t.engine.classifyControls(t.sid,input(t,'unresolved'));
    expect(records(t).find(r=>r.id===first.id)?.status).toBe('superseded');
    await t.engine.revokeControlClassification(t.sid,{classificationId:second.id,source:'caller',reason:'Withdraw assessment'});
    expect(t.engine.controlReviewMaterial(t.sid).pendingControlIds).toHaveLength(1);expect(t.engine.controlCoverage(t.sid).counts.unconfirmed).toBe(1);
    expect(records(t).find(r=>r.id===first.id)?.status).toBe('superseded');
  }finally{await t.close();}
});

it('runs a classification hook without granting operations and suppresses duplicate requests',async()=>{
  let calls=0;const t=await setup(prose,{controlClassification:m=>{calls++;return {observationId:m.observationId,source:'classification-hook',classifications:[{localId:m.pendingControlIds[0],classification:'display',reason:'Static explanatory text',evidence:['Fixture source and current subtree']}]};}});try{
    expect(records(t)).toHaveLength(1);await t.engine.observe(t.sid);expect(calls).toBe(1);
    expect(t.engine.controlReviewMaterial(t.sid).pendingControlIds).toEqual([]);expect(t.engine.actions(t.sid)).toEqual([]);
    expect(t.engine.controlCoverage(t.sid).counts.display).toBe(1);
  }finally{await t.close();}
});

it('does not persist a classification whose live preflight finishes after the hook deadline',async()=>{
  let enabled=false;const t=await setup(prose,{controlClassification:m=>enabled?{observationId:m.observationId,source:'late-classification',classifications:[{localId:m.pendingControlIds[0],classification:'display',reason:'Text',evidence:['Fixture']}]}:undefined});try{
    enabled=true;await pageOf(t.engine).locator('#candidate').evaluate(el=>el.setAttribute('title','new'));
    (t.engine as any).driver.preflight=async()=>{await new Promise(r=>setTimeout(r,5100));return 'valid';};
    await t.engine.observe(t.sid);await new Promise(r=>setTimeout(r,150));expect(records(t)).toEqual([]);
    expect(t.engine.controlCoverage(t.sid).counts.unconfirmed).toBe(1);
  }finally{await t.close();}
});

it('publishes queryable deduplicated requests and supports HTTP classification, revocation and session isolation',async()=>{
  const t=await setup();const api=await createApi(t.engine);await api.listen({host:'127.0.0.1',port:0});const client=new InteractionClient(`http://127.0.0.1:${(api.server.address() as any).port}`);try{
    await t.engine.observe(t.sid);expect(t.engine.store.events(t.sid).filter(e=>e.type==='control.classification_requested')).toHaveLength(1);
    expect((await client.controlClassificationMaterial(t.sid)).pendingControlIds).toHaveLength(1);
    const [r]=await client.classifyControls(t.sid,input(t));expect((await client.controlClassifications(t.sid)).items[0].id).toBe(r.id);
    const seen:string[]=[];t.engine.events.on('event',e=>{if(e.type==='control.classification_requested')seen.push(t.engine.controlClassificationMaterial(t.sid).observationId);});
    await client.revokeControlClassification(t.sid,{classificationId:r.id,source:'http',reason:'Review again'});await new Promise(r=>setTimeout(r,20));
    expect(seen).toEqual([t.engine.observation(t.sid).id]);expect((await client.controlClassifications(t.sid)).items[0].status).toBe('revoked');
    await expect(client.revokeControlClassification('missing',{classificationId:r.id,source:'http',reason:'Wrong session'})).rejects.toMatchObject({code:'NOT_FOUND'});
  }finally{await api.close();await t.close();}
});

it('preserves SQLite classification history but a new document needs a fresh decision',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'control-classification-'));const t=await setup(prose,{}, {},new SqliteStore(dir));let next:BrowserEngine|undefined;try{
    const [r]=await t.engine.classifyControls(t.sid,input(t));await t.engine.close();next=new BrowserEngine({persistence:new SqliteStore(dir)});
    expect(next.list<ControlClassificationRecord>(t.sid,'control-classification')[0].id).toBe(r.id);
    await next.observe(t.sid);expect(next.list<ControlClassificationRecord>(t.sid,'control-classification')[0].status).toBe('invalidated');
    expect(next.controlClassificationMaterial(t.sid).pendingControlIds).toHaveLength(1);
  }finally{await next?.close();await t.close();rmSync(dir,{recursive:true,force:true});}
});
