import { expect, it, vi } from 'vitest';
import { classificationCorrespondenceConditions, type ControlClassificationRecord } from '@interaction/browser';
import { explorerFixture } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';

async function fixture(external=false,named=false){
 let generation=0;
 const f=await explorerFixture(()=>{generation++;return `<section id="area">${external?`<span id="title-${generation}">Notice</span>`:''}<div role="dialog" tabindex="0" ${named?'aria-label="Shared notice"':''} aria-labelledby="title-${generation}"><p>Notice</p><input type="checkbox" id="check-${generation}"><label for="check-${generation}">Keep preference</label><button type="button">Close</button></div></section>`;});
 const options={url:f.url,headless:true,settleMs:0,observeTimeoutMs:100};
 const s=await f.host.createSession(options),before=f.host.observation(s.id),c=before.controls.find(c=>c.role==='dialog')!;
 const [record]=await f.host.classifyControls(s.id,{observationId:before.id,source:'test-review',classifications:[{localId:c.localId,classification:'container',reason:'Complete observed grouping',evidence:['complete current subtree']}]});
 const source={sessionId:s.id,observationId:before.id,classificationId:record.id,classification:'container' as const};
 const current=()=>{const o=f.host.observation(s.id);return {o,c:o.controls.find(c=>c.role==='dialog')!};};
 const query=()=>{const {o,c}=current();return f.host.classificationCorrespondences(s.id,{observationId:o.id,requests:[{localId:c.localId,source}]});};
 const apply=()=>{const {o,c}=current();return f.host.classifyControls(s.id,{observationId:o.id,source:'test-reuse',classifications:[{localId:c.localId,classification:'container' as const,reason:'SDK verified correspondence',evidence:['SDK correspondence'],reuseFrom:source}]});};
 const reload=async()=>{await pageOf(f.host).reload();await f.host.observe(s.id);};
 return {...f,sid:s.id,options,before,original:c,record,source,current,query,apply,reload};
}

it.each([false,true])('reuses complete container evidence after reload and consistent internal/external IDREF renaming (external=%s)',async external=>{
 const f=await fixture(external);try{
  await f.reload();const {o,c}=f.current();expect(c.instanceId).not.toBe(f.original.instanceId);expect(c.classificationBinding?.nodes[0].attributes['aria-labelledby']).not.toBe(f.original.classificationBinding?.nodes[0].attributes['aria-labelledby']);
  const writes=vi.spyOn(f.host.store,'put'),events=f.host.store.events(f.sid).length;
  const result=f.query();expect(result.results[0]).toMatchObject({applicable:true,reason:'equivalent_classification_conditions',identityAuthorized:false,executionAuthorized:false,currentExecution:false});expect(result.observationId).toBe(o.id);expect(writes).not.toHaveBeenCalled();expect(f.host.store.events(f.sid)).toHaveLength(events);
  const batch=f.host.classificationCorrespondences(f.sid,{observationId:o.id,requests:Array.from({length:200},()=>({localId:c.localId,source:f.source}))});expect(batch.results).toHaveLength(200);expect(batch.results.every(r=>r.applicable)).toBe(true);
  const [reused]=await f.apply();expect(reused.reuseFrom).toEqual(f.source);expect(f.host.controlClassificationMaterial(f.sid).pendingControlIds).not.toContain(f.current().c.localId);expect(f.host.session(f.sid).actionCount).toBe(0);
  expect(f.host.observation(f.sid,f.before.id)).toEqual(f.before);
 }finally{await f.close();}
});

it('supports a fresh session without inheriting identity, execution or source-record state',async()=>{
 const f=await fixture();try{
  await f.host.stop(f.sid);const next=await f.host.createSession(f.options),o=f.host.observation(next.id),c=o.controls.find(c=>c.role==='dialog')!;
  expect(f.host.classificationCorrespondences(next.id,{observationId:o.id,requests:[{localId:c.localId,source:f.source}]}).results[0]).toMatchObject({applicable:true,currentExecution:false,executionAuthorized:false,identityAuthorized:false});expect(f.host.list(next.id,'attempt')).toEqual([]);
 }finally{await f.close();}
});

it.each(['subtree','text','interaction','duplicate','duplicate-idref','external-text','reference-topology','owner'] as const)('rejects changed or ambiguous captured evidence: %s',async change=>{
 const f=await fixture(change==='external-text');try{
  await f.reload();await pageOf(f.host).evaluate(change=>{
   const el=document.querySelector('[role="dialog"]')!;
   if(change==='subtree')el.append(document.createElement('i'));
   if(change==='text')el.querySelector('p')!.textContent='Different notice';
   if(change==='interaction')el.setAttribute('onclick','window.changed=true');
   if(change==='duplicate')el.after(el.cloneNode(true));
   if(change==='duplicate-idref')el.append(el.querySelector('input')!.cloneNode(true));
   if(change==='external-text')document.querySelector('section > span')!.textContent='Different title';
   if(change==='reference-topology')el.querySelector('label')!.setAttribute('for','other-missing');
   if(change==='owner')el.parentElement!.setAttribute('id','other-area');
  },change);await f.host.observe(f.sid);expect(f.query().results[0].applicable).toBe(false);
 }finally{await f.close();}
});

it('rejects stale requests and rechecks source revocation during application and current material reads',async()=>{
 const f=await fixture();try{
  await f.reload();const {o,c}=f.current();expect(f.query().results[0].applicable).toBe(true);await f.host.observe(f.sid);
  expect(()=>f.host.classificationCorrespondences(f.sid,{observationId:o.id,requests:[{localId:c.localId,source:f.source}]})).toThrow();
  const [copy]=await f.apply();expect(f.host.controlClassificationMaterial(f.sid).pendingControlIds).not.toContain(f.current().c.localId);
  await f.host.revokeControlClassification(f.sid,{classificationId:f.record.id,source:'test',reason:'Original evidence revoked'});
  expect(f.host.controlClassificationMaterial(f.sid).pendingControlIds).toContain(f.current().c.localId);expect(f.query().results[0].applicable).toBe(false);
  await expect(f.apply()).rejects.toMatchObject({code:'CLASSIFICATION_REUSE_INVALID'});
  const {o:fresh,c:target}=f.current();expect(f.host.classificationCorrespondences(f.sid,{observationId:fresh.id,requests:[{localId:target.localId,source:{...f.source,classificationId:copy.id,observationId:copy.observationId}}]}).results[0]).toMatchObject({applicable:false,reason:'original_negative_classification_required'});
 }finally{await f.close();}
});

it('requires captured external reference evidence in legacy observations and preserves full attributes',async()=>{
 const f=await fixture();try{
  const original=structuredClone(f.original);delete original.classificationBinding!.references;
  expect(classificationCorrespondenceConditions(original,f.before)).toBeUndefined();
  const current=structuredClone(f.original);current.classificationBinding!.truncated=true;
  expect(classificationCorrespondenceConditions(current,f.before)).toBeUndefined();
  const unknown=structuredClone(f.before);unknown.context={tenant:{status:'unknown',value:null,source:'test'}};
  expect(classificationCorrespondenceConditions(f.original,unknown)).toBeUndefined();
  const changed=structuredClone(f.original);changed.classificationBinding!.nodes[1].attributes['data-mode']='changed';
  expect(classificationCorrespondenceConditions(changed,f.before)?.conditionKey).not.toBe(classificationCorrespondenceConditions(f.original,f.before)?.conditionKey);
 }finally{await f.close();}
});

it('allows layout and sibling-position changes without changing semantic ownership',async()=>{
 const f=await fixture();try{
  await f.reload();await pageOf(f.host).evaluate(()=>{const marker=document.createElement('div');marker.style.height='30px';document.querySelector('[role="dialog"]')!.before(marker);});await f.host.observe(f.sid);
  expect(f.query().results[0].applicable).toBe(true);
 }finally{await f.close();}
});

it('rejects superseded source evidence, including an otherwise identical new classification',async()=>{
 const f=await fixture();try{
  const {o,c}=f.current();await f.host.classifyControls(f.sid,{observationId:o.id,source:'replacement-review',classifications:[{localId:c.localId,classification:'container',reason:'Replacement review',evidence:['new judgment']}]});
  expect(f.host.list<ControlClassificationRecord>(f.sid,'control-classification').find(r=>r.id===f.record.id)?.status).toBe('superseded');
  await f.reload();expect(f.query().results[0]).toMatchObject({applicable:false,reason:'classification_revoked_or_replaced'});
 }finally{await f.close();}
});

it('keeps known business context values in portable classification conditions',async()=>{
 const f=await fixture();try{
  const before=structuredClone(f.before),after=structuredClone(f.before);before.context={account:{status:'known',value:'one',source:'test'}};after.context={account:{status:'known',value:'two',source:'test'}};
  expect(classificationCorrespondenceConditions(f.original,before)?.conditionKey).not.toBe(classificationCorrespondenceConditions(f.original,after)?.conditionKey);
 }finally{await f.close();}
});

it('does not treat an incomplete same-name rival as evidence of unique correspondence',async()=>{
 const f=await fixture(false,true);try{
  await f.reload();expect(f.query().results[0].applicable).toBe(true);
  await pageOf(f.host).evaluate(()=>{const original=document.querySelector('[role="dialog"]')!,rival=document.createElement('div');rival.setAttribute('role','dialog');rival.setAttribute('tabindex','0');rival.setAttribute('aria-label','Shared notice');rival.setAttribute('aria-labelledby','missing-rival-title');rival.textContent=original.textContent;for(let i=0;i<210;i++)rival.append(document.createElement('i'));original.after(rival);});await f.host.observe(f.sid);
  const {o,c}=f.current(),rival=o.controls.find(x=>x.localId!==c.localId&&x.role==='dialog')!;
  expect(rival.classificationBinding?.truncated).toBe(true);expect(rival.name).toBe(c.name);expect(rival.label).toBe(c.label);
  expect(f.query().results[0]).toMatchObject({applicable:false,reason:'target_correspondence_ambiguous'});
 }finally{await f.close();}
});
