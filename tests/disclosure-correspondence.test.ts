import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, browserControlCorrespondence, type ActionAttempt, type Control, type SessionOptions, type ExplorationGroup } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { remapStoredScopes } from '../packages/explorer-plugin/src/scope-migration.js';
import { pageOf } from './helpers.js';

const rows=(names=['Current rate?','How does it work?','Where is support?'],prefix='')=>`<section aria-label="Questions"><div aria-label="Answers">${names.map((name,i)=>`<div><button type="button" aria-expanded="true" aria-controls="${prefix}answer-${i}"><h3>${name}</h3></button><div role="region" id="${prefix}answer-${i}"><p>Current answer ${i}: 100.</p></div></div>`).join('')}</div></section>`;
async function fixture(html=rows(),overrides:Partial<SessionOptions>={}) {
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const engine=new BrowserEngine({persistence:new MemoryStore()});
  const options:Partial<SessionOptions>={url:`http://127.0.0.1:${(server.address() as any).port}`,headless:true,settleMs:0,observeTimeoutMs:100,exploration:'controls',listExploration:'all',interfaceActions:[{kind:'click'}],...overrides};
  const session=await engine.createSession(options);
  return {engine,sid:session.id,options,close:async()=>{await engine.close();await new Promise<void>(r=>server.close(()=>r()));}};
}
const key=(c:Control)=>browserControlCorrespondence(c)?.key;

it('binds disclosure records to the proven trigger and preserves correspondence across answer changes and collapse',async()=>{
  const t=await fixture();
  try {
    const read=()=>t.engine.observation(t.sid).controls.find(c=>c.name==='Current rate?')!;
    const first=read(),before=structuredClone(first);
    expect(first.label).toBe('');expect(first.structuralItem?.recordKey).toContain('disclosure/v1');
    expect(first.structuralItem?.recordEvidence).toEqual([expect.objectContaining({rule:'disclosure-record/v1',facts:expect.objectContaining({targetId:'answer-0',relation:'unique-aria-controls-within-record',triggerSlot:'0',panelSlot:'1'})})]);
    expect(browserControlCorrespondence(first)?.evidence).toContain('disclosure-record/v1');
    for(const hidden of [true,false,true,false]) {
      await pageOf(t.engine).evaluate(hidden=>{const panel=document.getElementById('answer-0')!,button=document.querySelector('[aria-controls="answer-0"]')!;panel.querySelector('p')!.textContent='Changed answer: 123456.';panel.hidden=hidden;button.setAttribute('aria-expanded',String(!hidden));},hidden);
      await t.engine.observe(t.sid);
      const current=read();expect(current.identityId).toBe(first.identityId);expect(current.stableKey).toBe(first.stableKey);expect(key(current)).toBe(key(first));
      expect(current.structuralItem?.template).toBe(first.structuralItem?.template);
    }
    expect(first).toEqual(before);expect(t.engine.list(t.sid,'attempt')).toEqual([]);
    // A changed question is a changed record even when the node is retained.
    await pageOf(t.engine).locator('[aria-controls="answer-0"] h3').evaluate(el=>el.textContent='A different question?');await t.engine.observe(t.sid);
    const changed=t.engine.observation(t.sid).controls.find(c=>c.name==='A different question?')!;
    expect(key(changed)).not.toBe(key(first));expect(changed.identityId).not.toBe(first.identityId);
  } finally {await t.close();}
});

it('discovers new disclosure operations and invalidates the old structural approval',async()=>{
  const t=await fixture(rows(),{listExploration:'review'});
  try {
    const before=t.engine.observation(t.sid),old=before.controls.find(c=>c.name==='Current rate?')!;
    const group=t.engine.list<ExplorationGroup>(t.sid,'exploration-group').find(g=>g.members.some(m=>m.localId===old.localId))!;
    await t.engine.decideExplorationGroup(t.sid,group.id,group.revision,{mode:'all',source:'test',evidence:['Original question triggers only']});
    await pageOf(t.engine).locator('[role=region]').evaluateAll(es=>es.forEach((el,i)=>el.insertAdjacentHTML('beforeend',`<button type="button">New action ${i}</button>`)));
    await t.engine.observe(t.sid);const current=t.engine.observation(t.sid),changed=current.controls.find(c=>c.name==='Current rate?')!;
    expect(changed.structuralItem?.recordKey).toBe(old.structuralItem?.recordKey);
    expect(changed.structuralItem?.template).not.toBe(old.structuralItem?.template);expect(key(changed)).not.toBe(key(old));
    expect(current.controls.filter(c=>c.name.startsWith('New action'))).toHaveLength(3);
    expect(t.engine.list<ExplorationGroup>(t.sid,'exploration-group').find(g=>g.id===group.id)?.status).toBe('invalidated');
    expect(t.engine.list<ExplorationGroup>(t.sid,'exploration-group').some(g=>g.status==='pending'&&g.members.some(m=>m.label.startsWith('New action')))).toBe(true);
    expect(t.engine.list(t.sid,'attempt')).toEqual([]);
  }finally{await t.close();}
});

it('compares a new document using public evidence without granting identity, replay or current execution',async()=>{
  const t=await fixture();
  try {
    const before=t.engine.observation(t.sid),control=before.controls.find(c=>c.name==='Current rate?')!,action=t.engine.actions(t.sid).find(a=>a.localId===control.localId&&a.kind==='click')!;
    const attempt=await t.engine.execute(t.sid,action.id,'source');expect(attempt.status).toBe('succeeded');await t.engine.stop(t.sid);
    const next=await t.engine.createSession(t.options),current=t.engine.observation(next.id),target=current.controls.find(c=>c.name==='Current rate?')!,targetAction=t.engine.actions(next.id).find(a=>a.localId===target.localId&&a.kind==='click')!;
    expect(target.stableKey).not.toBe(control.stableKey);expect(key(target)).toBe(key(control));
    const result=t.engine.operationCorrespondence(next.id,{observationId:current.id,actionId:targetAction.id,source:{sessionId:t.sid,attemptId:attempt.id}});
    expect(result).toMatchObject({equivalent:true,identityAuthorized:false,replayAuthorized:false,currentExecution:false});
    expect(t.engine.list<ActionAttempt>(next.id,'attempt')).toEqual([]);expect(t.engine.session(next.id).actionCount).toBe(0);
    await pageOf(t.engine).locator('[aria-label=Answers]').evaluate(el=>el.setAttribute('aria-label','Different owner'));await t.engine.observe(next.id);
    const changed=t.engine.observation(next.id),changedAction=t.engine.actions(next.id).find(a=>a.localId===target.localId&&a.kind==='click')!;
    expect(t.engine.operationCorrespondence(next.id,{observationId:changed.id,actionId:changedAction.id,source:{sessionId:t.sid,attemptId:attempt.id}})).toMatchObject({equivalent:false,reason:'operation_conditions_changed'});
  } finally {await t.close();}
});

it('does not infer disclosure ownership from missing, external, duplicate or multiple targets',async()=>{
  const markup=(kind:string)=>rows(['One?','Two?','Three?'],kind).replaceAll('aria-controls="'+kind+'answer-',`data-kind="${kind}" aria-controls="${kind==='external'?'outside-':kind==='missing'?'missing-':kind}answer-`);
  const t=await fixture(markup('external')+markup('missing')+markup('duplicate')+markup('multiple')+'<div id="outside-answer-0">External</div><div id="outside-answer-1">External</div><div id="outside-answer-2">External</div><div id="duplicateanswer-0">Duplicate</div>');
  try {
    await pageOf(t.engine).locator('[data-kind=multiple]').evaluateAll(es=>es.forEach(el=>el.setAttribute('aria-controls',el.getAttribute('aria-controls')+' outside-answer-0')));await t.engine.observe(t.sid);
    const all=t.engine.observation(t.sid).controls.filter(c=>c.role==='button');
    const invalid=all.filter(c=>['external','missing','multiple'].some(kind=>c.reviewAttributes?.['data-kind']===kind)||c.controls==='duplicateanswer-0');
    expect(invalid).toHaveLength(10);expect(invalid.every(c=>!c.structuralItem?.recordKey?.includes('disclosure/v1'))).toBe(true);
  } finally {await t.close();}
});

it('keeps same-name sibling disclosures ambiguous without inferring an equivalent target',async()=>{
  const t=await fixture(rows(['Same question?','Same question?','Same question?']));
  try {
    const first=t.engine.observation(t.sid).controls.filter(c=>c.role==='button');
    expect(first).toHaveLength(3);expect(new Set(first.map(key)).size).toBe(1);expect(first.every(c=>!!c.hypothesisId)).toBe(true);
    expect(new Set(first.map(c=>c.stableKey)).size).toBe(1);expect(t.engine.list(t.sid,'attempt')).toEqual([]);
    // An explicit action can target a current instance. That does not authorize
    // matching all three same-named records to its historical success.
    const action=t.engine.actions(t.sid).find(a=>a.localId===first[0].localId&&a.kind==='click')!;
    const attempt=await t.engine.execute(t.sid,action.id,'exact-instance');expect(attempt.status).toBe('succeeded');
    const current=t.engine.observation(t.sid),target=t.engine.actions(t.sid).find(a=>a.localId===first[1].localId&&a.kind==='click')!;
    expect(t.engine.operationCorrespondence(t.sid,{observationId:current.id,actionId:target.id,source:{sessionId:t.sid,attemptId:attempt.id}})).toMatchObject({equivalent:false,identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  } finally {await t.close();}
});

it('keeps legacy answer-based hints readable without inventing missing disclosure evidence or rewriting task outcomes',async()=>{
  const t=await fixture();
  try {
    const current=t.engine.observation(t.sid).controls.find(c=>c.name==='Current rate?')!;
    const old=structuredClone(current);old.structuralItem!.recordKey=JSON.stringify(['description','Current answer: 100.']);delete old.structuralItem!.recordEvidence;
    const historical=structuredClone(old),oldKey=key(old)!;
    expect(oldKey).not.toBe(key(current));expect(browserControlCorrespondence(old)?.evidence).not.toContain('disclosure-record/v1');expect(old).toEqual(historical);
    const task={plan:[{scope:{url:t.options.url,label:old.name,role:old.role,stableKey:oldKey},prerequisites:[],status:'unresolved',evidence:[{sessionId:t.sid,observationId:'legacy'}],attempts:[]}],rounds:[],usage:{rounds:1,actions:2,modelRequests:3,durationMs:4}} as any;
    const before=structuredClone(task);expect(remapStoredScopes(task,{} as any)).toEqual([]);expect(task).toEqual(before);
  } finally {await t.close();}
});
