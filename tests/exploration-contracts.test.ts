import { expect, it, vi } from 'vitest';
import { explorerFixture } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';
import type { ActionAttempt } from '@interaction/browser';
import { createServer as createApi } from '../apps/server/src/server.js';

const options={headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:300,interfaceActions:[{kind:'click'}]};

it.each(['same','other-control','binding','context','duplicate'] as const)('returns cross-session operation evidence without granting identity or recording execution: %s',async(change)=>{
  let html='<section aria-label="Original"><button id="one" type="button">Run</button><button id="two" type="button">Run</button></section>';
  const f=await explorerFixture(()=>html);
  try{
    const first=await f.host.createSession({...options,url:f.url,context:{tenant:'one'}}),before=f.host.observation(first.id);
    const target=before.controls.find(c=>c.stableKey==='id:one')!,a=f.host.actions(first.id).find(a=>a.localId===target.localId&&a.kind==='click')!;
    const attempt=await f.host.execute(first.id,a.id,'source');expect(attempt.status).toBe('succeeded');await f.host.stop(first.id);
    if(change==='binding')html=html.replace('Original','Changed');
    if(change==='duplicate')html=html.replace('id="two"','id="one"');
    const next=await f.host.createSession({...options,url:f.url,context:{tenant:change==='context'?'two':'one'}}),o=f.host.observation(next.id);
    const c=o.controls.find(c=>c.stableKey===(change==='other-control'?'id:two':'id:one'))!,b=f.host.actions(next.id).find(a=>a.localId===c.localId&&a.kind==='click')!;
    const events=f.host.store.events(next.id).length,identities=f.host.list(next.id,'identity');
    const proof=f.host.operationCorrespondence(next.id,{observationId:o.id,actionId:b.id,source:{sessionId:first.id,attemptId:attempt.id}});
    expect(proof.equivalent).toBe(change==='same');expect(proof).toMatchObject({identityAuthorized:false,replayAuthorized:false,currentExecution:false,source:{attemptId:attempt.id}});
    expect(proof.invalidatedBy).toContain('changed-operation-conditions');
    expect(f.host.session(next.id).actionCount).toBe(0);expect(f.host.list(next.id,'attempt')).toEqual([]);expect(f.host.list(next.id,'identity')).toEqual(identities);expect(f.host.store.events(next.id)).toHaveLength(events);
  }finally{await f.close();}
});

it.each(['options','form'] as const)('invalidates portable operation evidence when %s changes',async(change)=>{
  let html='<form action="/first"><select id="choices"><option value="a">A</option><option value="b">B</option></select></form>';
  const f=await explorerFixture(()=>html);
  try{
    const first=await f.host.createSession({...options,url:f.url}),a=f.host.actions(first.id).find(a=>a.kind==='select'&&a.value==='b')!;
    const attempt=await f.host.execute(first.id,a.id,'select');expect(attempt.status).toBe('succeeded');await f.host.stop(first.id);
    html=change==='options'?html.replace('</select>','<option value="c">C</option></select>'):html.replace('/first','/second');
    const next=await f.host.createSession({...options,url:f.url}),o=f.host.observation(next.id),b=f.host.actions(next.id).find(a=>a.kind==='select'&&a.value==='b')!;
    expect(f.host.operationCorrespondence(next.id,{observationId:o.id,actionId:b.id,source:{sessionId:first.id,attemptId:attempt.id}})).toMatchObject({equivalent:false,reason:'operation_conditions_changed',currentExecution:false});
  }finally{await f.close();}
});

it('rechecks traversal decisions at dispatch and keeps manual execution available without the plugin',async()=>{
  const f=await explorerFixture('<section aria-label="Area"><button id="one" type="button">Run</button><button id="two" type="button">Other</button></section>');
  try{
    const s=await f.host.createSession({...options,url:f.url,regionExploration:'review'});let o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.kind==='click')!;
    const reads=vi.spyOn(f.host.store,'list'),blocked=f.host.actionAvailability(s.id,o.id);
    for(const kind of ['exploration-group','region-review','control-classification'])expect(reads.mock.calls.filter(([k])=>k===kind)).toHaveLength(1);
    reads.mockRestore();expect(blocked.actions.find(x=>x.actionId===a.id)?.executable).toBe(false);
    await expect(f.host.execute(s.id,a.id,'blocked',undefined,{observationId:o.id,profile:'interface-exploration'})).rejects.toMatchObject({code:'ACTION_BLOCKED'});
    const region=f.host.regionReviewMaterial(s.id);await f.host.reviewRegions(s.id,{observationId:o.id,source:'test',evidence:['Observed area'],regions:[{key:'area',label:'Area',candidateIds:[region.candidates.find(c=>c.label==='Area')!.id]}]});o=f.host.observation(s.id);a=f.host.actions(s.id).find(a=>a.kind==='click')!;
    const group=f.host.explorationReviewMaterial(s.id).groups.find(g=>g.kind==='reviewed-region')!;
    await f.host.decideExplorationGroup(s.id,group.id,group.revision,{mode:'all',source:'test',evidence:['Current page scope']});
    const allowed=f.host.actionAvailability(s.id,o.id);expect(allowed.actions.find(x=>x.actionId===a.id)?.executable).toBe(true);
    let updated=f.host.explorationReviewMaterial(s.id).groups.find(g=>g.id===group.id)!;
    await f.host.decideExplorationGroup(s.id,updated.id,updated.revision,{mode:'sample',memberKeys:[updated.members.find(m=>m.actionId!==a.id)!.key],source:'test',evidence:['Explicit sample']});
    const sampled=f.host.actionAvailability(s.id,o.id).actions.find(x=>x.actionId===a.id)!;
    expect(sampled.blockers).toContainEqual(expect.objectContaining({selection:expect.objectContaining({state:'unselected',groupId:group.id}),evidence:[group.id]}));
    const sampledAudit=f.host.explorationSnapshot(s.id,o.id);
    expect(sampledAudit.facts.find(x=>x.kind==='operation'&&x.actionId===a.id)).toMatchObject({blockers:sampled.blockers});
    updated=f.host.explorationReviewMaterial(s.id).groups.find(g=>g.id===group.id)!;
    await f.host.decideExplorationGroup(s.id,updated.id,updated.revision,{mode:'defer',source:'test',evidence:['Withdraw traversal decision']});
    const deferred=f.host.actionAvailability(s.id,o.id);expect(deferred.revision).not.toBe(allowed.revision);
    expect(deferred.actions.find(x=>x.actionId===a.id)?.blockers).toContainEqual(expect.objectContaining({selection:expect.objectContaining({state:'deferred',groupId:group.id})}));
    await expect(f.host.execute(s.id,a.id,'revoked',undefined,{observationId:o.id,profile:'interface-exploration'})).rejects.toMatchObject({code:'ACTION_BLOCKED'});
    expect(f.host.session(s.id).actionCount).toBe(0);
    expect((await f.host.execute(s.id,a.id,'manual')).status).toBe('succeeded');
    expect(f.host.actionAvailability(s.id,o.id).actions.every(x=>!x.executable)).toBe(true);
    await expect(f.host.execute(s.id,a.id,'stale',undefined,{observationId:o.id,profile:'interface-exploration'})).rejects.toMatchObject({code:'STALE_OBSERVATION'});
  }finally{await f.close();}
});

it('exposes read-only host contracts and guarded execution over HTTP with the plugin disabled',async()=>{
  const f=await explorerFixture('<button id="one" type="button">Run</button>'),api=await createApi(f.host);
  try{
    const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.kind==='click')!;
    const available=await api.inject({url:`/v1/sessions/${s.id}/action-availability?observationId=${o.id}`});expect(available.statusCode).toBe(200);expect(available.headers['cache-control']).toBe('no-store');
    const audit=await api.inject({url:`/v1/sessions/${s.id}/exploration-snapshot?completionAudit=true`});expect(audit.statusCode).toBe(200);expect(audit.json().completionAudit.exhaustive).toBe(false);
    const result=await api.inject({method:'POST',url:`/v1/sessions/${s.id}/commands`,payload:{type:'execute',actionId:a.id,requestId:'http',guard:{observationId:o.id,profile:'interface-exploration'}}});expect(result.statusCode).toBe(200);expect(result.json().status).toBe('succeeded');
    const recovery=await api.inject({url:`/v1/sessions/${s.id}/recovery-assessment`});expect(recovery.statusCode).toBe(200);expect(recovery.json().unknownAttempts).toEqual([]);
  }finally{await api.close();await f.close();}
});

it('returns a consistent read-only audit with unsupported contents and rebuilds it after review changes',async()=>{
  const f=await explorerFixture('<canvas></canvas><div id="unknown" style="cursor:pointer">Unknown</div>');
  try{
    const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),c=o.controls.find(c=>c.stableKey==='id:unknown')!;
    const count=f.host.store.events(s.id).length,read=vi.spyOn(f.host.store,'list');
    const snapshot=f.host.explorationSnapshot(s.id,o.id,{includeCompletionAudit:true});
    expect(read.mock.calls.filter(([kind])=>kind==='observation')).toHaveLength(1);expect(read.mock.calls.filter(([kind])=>kind==='exploration-group')).toHaveLength(1);read.mockRestore();
    expect(f.host.store.events(s.id)).toHaveLength(count);expect(snapshot.facts.some(x=>x.kind==='unsupported'&&x.code==='UNSUPPORTED_CANVAS')).toBe(true);
    expect([snapshot.observation.id,snapshot.availability.observationId,snapshot.classifications.observationId,snapshot.operations.observationId,snapshot.discovery.observationId]).toEqual(Array(5).fill(o.id));
    const records=await f.host.classifyControls(s.id,{observationId:o.id,source:'test',classifications:[{localId:c.localId,classification:'display',reason:'Display label',evidence:['Observed display-only content']}]});
    const next=f.host.explorationSnapshot(s.id);expect(next.revision).not.toBe(snapshot.revision);expect(next.nonInteractive.some(x=>x.classificationId===records[0].id)).toBe(true);
    await f.host.revokeControlClassification(s.id,{classificationId:records[0].id,source:'test',reason:'Purpose changed'});
    const revoked=f.host.explorationSnapshot(s.id);expect(revoked.nonInteractive).toEqual([]);expect(revoked.classifications.pendingControlIds.length).toBeGreaterThan(0);expect(revoked.facts.some(x=>x.kind==='unsupported')).toBe(true);
    expect(()=>f.host.explorationSnapshot(s.id,o.id)).toThrow('Audit requires the current observation');
  }finally{await f.close();}
});

it('projects current interpretations without scanning history, sharing full-audit proofs and rejecting stale observations',async()=>{
  const f=await explorerFixture('<div id="label" tabindex="0">Informational text</div><button type="button">Ready</button>');
  try{
    const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),c=o.controls.find(c=>c.stableKey==='id:label')!;
    const count=f.host.store.events(s.id).length,reads=vi.spyOn(f.host.store,'list');
    const before=f.host.controlInterpretationSnapshot(s.id,o.id);
    expect(reads.mock.calls.filter(([kind])=>['observation','attempt','frontier','exploration-group'].includes(kind))).toEqual([]);reads.mockRestore();
    expect(f.host.store.events(s.id)).toHaveLength(count);expect(before).toMatchObject({observationId:o.id,executionAuthorized:false,nonInteractive:[]});
    const [record]=await f.host.classifyControls(s.id,{observationId:o.id,source:'test',classifications:[{localId:c.localId,classification:'display',reason:'Read-only explanatory content',evidence:['Bounded current subtree']}]});
    const current=f.host.controlInterpretationSnapshot(s.id),audit=f.host.explorationSnapshot(s.id);
    expect(current.nonInteractive).toEqual(audit.nonInteractive);expect(current.classifications).toEqual(audit.classifications);expect(current.operations).toEqual(audit.operations);
    expect(current.nonInteractive).toEqual([expect.objectContaining({classificationId:record.id})]);expect(current.revision).not.toBe(before.revision);
    await f.host.revokeControlClassification(s.id,{classificationId:record.id,source:'test',reason:'Reconsider classification'});
    const revoked=f.host.controlInterpretationSnapshot(s.id);expect(revoked.nonInteractive).toEqual([]);expect(revoked.revision).not.toBe(current.revision);
    expect(()=>f.host.controlInterpretationSnapshot(s.id,current.observationId)).toThrow('Interpretation requires the current observation');
    expect(f.host.session(s.id).actionCount).toBe(0);
  }finally{await f.close();}
});

it('retains classification evidence only for its proven historical scene and invalidates it on revocation',async()=>{
  const f=await explorerFixture('<div id="label" tabindex="0">Informational text</div><button type="button">Ready</button>');
  try{
    const s=await f.host.createSession({...options,url:f.url}),before=f.host.observation(s.id),c=before.controls.find(c=>c.stableKey==='id:label')!;
    const [record]=await f.host.classifyControls(s.id,{observationId:before.id,source:'test',classifications:[{localId:c.localId,classification:'display',reason:'Display only',evidence:['Complete target structure']}]});
    const interpreted=f.host.controlInterpretationSnapshot(s.id),proof=interpreted.nonInteractive[0];expect(proof).toBeTruthy();
    // The proof cites the resulting observation, not the pre-classification record.
    expect(proof.observationId).not.toBe(record.observationId);
    await pageOf(f.host).evaluate(()=>document.querySelector('#label')!.remove());await f.host.observe(s.id);
    const count=f.host.store.events(s.id).length,reads=vi.spyOn(f.host.store,'list');
    const current=f.host.controlInterpretationSnapshot(s.id,undefined,{retainedClassifications:[proof]});
    expect(reads.mock.calls.filter(([kind])=>kind==='control-classification')).toHaveLength(1);
    expect(reads.mock.calls.filter(([kind])=>['observation','attempt','frontier'].includes(kind))).toEqual([]);reads.mockRestore();
    expect(current.nonInteractive).toEqual([]);expect(current.retainedClassifications).toEqual([{source:proof,retained:true,reason:'historical_classification_retained',currentApplicability:false,executionAuthorized:false}]);
    expect(f.host.store.events(s.id)).toHaveLength(count);expect(f.host.session(s.id).actionCount).toBe(0);
    const mismatches=[{...proof,sessionId:'another-session'},{...proof,observationId:current.observationId},{...proof,classification:'container' as const},{...proof,classificationId:'missing'}];
    expect(f.host.controlInterpretationSnapshot(s.id,undefined,{retainedClassifications:mismatches}).retainedClassifications.every(p=>!p.retained)).toBe(true);
    await f.host.revokeControlClassification(s.id,{classificationId:record.id,source:'test',reason:'Withdraw interpretation'});
    const revoked=f.host.controlInterpretationSnapshot(s.id,undefined,{retainedClassifications:[proof]});
    expect(revoked.retainedClassifications[0]).toMatchObject({retained:false,reason:'classification_revoked_or_replaced'});expect(revoked.revision).not.toBe(current.revision);
  }finally{await f.close();}
});

it('tracks distinct boundary visits through existing scope lifecycle, including document replacement',async()=>{
  const f=await explorerFixture('<button id="open" onclick="document.querySelector(\'dialog\').showModal()">Open</button><dialog><button id="close" onclick="this.parentElement.close()">Close</button></dialog>');
  try{
    const s=await f.host.createSession({...options,url:f.url});
    const click=async(label:string)=>f.host.execute(s.id,f.host.actions(s.id).find(a=>a.label===label&&a.kind==='click')!.id,crypto.randomUUID());
    await click('Open');const first=f.host.boundaryState(s.id);expect(first.active?.scopeId).toBeTruthy();
    const blocked=f.host.actionAvailability(s.id);const open=f.host.actions(s.id).find(a=>a.label==='Open'&&a.kind==='click');if(open)expect(blocked.actions.find(a=>a.actionId===open.id)?.blockers.some(b=>b.reason==='outside_active_boundary')).toBe(true);
    await click('Close');expect(f.host.boundaryState(s.id).active).toBeUndefined();
    await click('Open');const second=f.host.boundaryState(s.id);expect(second.active?.scopeId).not.toBe(first.active?.scopeId);
    await pageOf(f.host).reload();await pageOf(f.host).evaluate(()=>document.querySelector('dialog')!.showModal());await f.host.observe(s.id);
    const third=f.host.boundaryState(s.id);expect(third.active?.scopeId).not.toBe(second.active?.scopeId);
    expect(f.host.list<any>(s.id,'scope').find(x=>x.id===second.active?.scopeId)?.status).toBe('interrupted');
  }finally{await f.close();}
});

it('reports unique occurrence continuity without treating changed operation conditions as equivalent',async()=>{
  const f=await explorerFixture('<button id="target" type="button">Before</button>');
  try{
    const s=await f.host.createSession({...options,url:f.url}),before=f.host.observation(s.id),action=f.host.actions(s.id).find(a=>a.label==='Before')!;
    const attempt=await f.host.execute(s.id,action.id,'source');expect(attempt.status).toBe('succeeded');
    await pageOf(f.host).evaluate(()=>{document.querySelector('button')!.textContent='After';});await f.host.observe(s.id);
    const after=f.host.observation(s.id),target=f.host.actions(s.id).find(a=>a.label==='After')!;
    expect(f.host.interactionTransition(s.id,before.id,after.id).retainedControls).toContainEqual({beforeLocalId:action.localId,afterLocalId:target.localId});
    expect(f.host.operationCorrespondence(s.id,{observationId:after.id,actionId:target.id,source:{sessionId:s.id,attemptId:attempt.id}})).toMatchObject({equivalent:false,identityAuthorized:false,replayAuthorized:false,currentExecution:false});
    await pageOf(f.host).reload();await f.host.observe(s.id);
    expect(f.host.interactionTransition(s.id,after.id,f.host.observation(s.id).id)).toMatchObject({documentChanged:true,retainedControls:[]});
    expect(f.host.list(s.id,'attempt')).toHaveLength(1);
  }finally{await f.close();}
});

it('exposes unknown navigation facts without treating isolation or a new session as recovery',async()=>{
  const f=await explorerFixture('<a id="next" href="/next">Next</a>');
  try{
    const s=await f.host.createSession({...options,url:f.url}),a=f.host.actions(s.id).find(a=>a.kind==='click')!;
    const attempt=await f.host.execute(s.id,a.id,'navigation');expect(attempt.status).toBe('succeeded');
    const unknown:ActionAttempt={...attempt,status:'unknown',reason:'Simulated unavailable outcome evidence'};f.host.store.put('attempt',unknown);
    const facts=f.host.navigationIsolation(s.id,attempt.id);expect(facts).toMatchObject({canIsolate:true,verified:false,replayAllowed:false,originalStatus:'unknown'});
    const o=f.host.observation(s.id),b=f.host.actions(s.id).find(a=>a.kind==='click')!;
    expect(f.host.operationCorrespondence(s.id,{observationId:o.id,actionId:b.id,source:{sessionId:s.id,attemptId:attempt.id}}).reason).toBe('source_not_verified');
    expect(f.host.explorationSnapshot(s.id).facts.some(x=>x.kind==='unknown-result')).toBe(true);
    expect(f.host.actionAvailability(s.id,o.id).actions.every(x=>!x.executable)).toBe(true);
    await expect(f.host.execute(s.id,b.id,'must-not-retry',undefined,{observationId:o.id,profile:'interface-exploration'})).rejects.toMatchObject({code:'UNKNOWN_ACTION_OUTCOME'});
    await f.host.stop(s.id);await f.host.createSession({...options,url:f.url});
    expect(f.host.recoveryAssessment(s.id).unknownAttempts.map(x=>x.id)).toContain(attempt.id);expect(f.host.list<ActionAttempt>(s.id,'attempt')[0].status).toBe('unknown');
  }finally{await f.close();}
});
