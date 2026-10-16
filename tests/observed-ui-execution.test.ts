import { expect, it } from 'vitest';
import { explorerFixture } from './explorer-plugin-helpers.js';
import { createServer as createApi } from '../apps/server/src/server.js';
import { isObservedUIOperation } from '@interaction/core';
import type { ActionAttempt } from '@interaction/core';

const base={headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:300};
const html='<input id="query" aria-label="Search" value="example"><button id="clear" type="button" onclick="document.querySelector(\'#query\').value=\'\'">Clear</button><form><button id="submit">Submit</button></form><div id="weak" style="cursor:pointer">Unknown</div>';

it('explores a supported button without certifying its effect and retains the observed transition',async()=>{
 const f=await explorerFixture(html);
 try{
  const s=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui'}),o=f.host.observation(s.id);
  const a=f.host.actions(s.id).find(a=>a.label==='Clear'&&a.kind==='click')!;
  expect(a).toMatchObject({risk:'unknown',basis:{status:'supported'},replayable:false});
  expect(f.host.controlReviewMaterial(s.id).pendingControlIds).not.toContain(a.localId);
  const snapshot=f.host.explorationSnapshot(s.id,o.id);
  expect(snapshot.availability.profile).toBe('observed-ui-exploration');
  expect(snapshot.availability.actions.find(x=>x.actionId===a.id)?.executable).toBe(true);
  expect(snapshot.obligations.operations).not.toContain(a.localId);
  const attempt=await f.host.execute(s.id,a.id,'clear',undefined,{observationId:o.id,profile:'observed-ui-exploration'});
  expect(attempt).toMatchObject({status:'succeeded',effectsAssessment:'not-assessed',executionProfile:'observed-ui-exploration',action:{risk:'unknown',replayable:false}});
  expect(f.host.observation(s.id).controls.find(c=>c.stableKey==='id:query')?.value).toBe('');
  expect(f.host.session(s.id)).toMatchObject({dirty:false,unassessedEffectAttemptIds:[attempt.id]});
  expect(f.host.recoveryAssessment(s.id)).toMatchObject({verificationScope:'observed-ui',unassessedEffectAttemptIds:[attempt.id],unknownAttempts:[]});
  const cp=await f.host.createCheckpoint(s.id,'After click'),reach=await f.host.reachCheckpoint(s.id,cp.id);
  expect(reach).toMatchObject({status:'REACHED_VERIFIED',verificationScope:'observed-ui',diagnostics:{unassessedEffectAttemptIds:[attempt.id]}});
  expect(f.host.session(s.id).unassessedEffectAttemptIds).toEqual([attempt.id]);
 }finally{await f.close();}
});

it('keeps legacy risk gates and requires an explicit session opt-in',async()=>{
 const f=await explorerFixture(html);
 try{
  const s=await f.host.createSession({...base,url:f.url}),o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.label==='Clear'&&a.kind==='click')!;
  expect(f.host.actionAvailability(s.id).actions.find(x=>x.actionId===a.id)?.executable).toBe(false);
  expect(f.host.controlReviewMaterial(s.id).pendingControlIds).toContain(a.localId);
  await expect(f.host.execute(s.id,a.id,'no-opt-in',undefined,{observationId:o.id,profile:'observed-ui-exploration'})).rejects.toMatchObject({code:'ACTION_BLOCKED',message:'observed_ui_authorization_required'});
  await expect(f.host.execute(s.id,a.id,'old-profile',undefined,{observationId:o.id,profile:'interface-exploration'})).rejects.toMatchObject({code:'ACTION_BLOCKED',message:'interface_risk_required'});
  const manual=await f.host.execute(s.id,a.id,'manual');
  expect(manual.effectsAssessment).toBeUndefined();expect(f.host.session(s.id)).toMatchObject({dirty:true,dirtyAttemptIds:[manual.id]});
 }finally{await f.close();}
});

it('does not authorize native submission, missing capabilities, external probes or arbitrary kinds',async()=>{
 const f=await explorerFixture(html);
 try{
  const s=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui'}),o=f.host.observation(s.id),submit=f.host.actions(s.id).find(a=>a.label==='Submit'&&a.kind==='click')!,clear=f.host.actions(s.id).find(a=>a.label==='Clear'&&a.kind==='click')!;
  expect(f.host.actionAvailability(s.id).actions.find(x=>x.actionId===submit.id)?.executable).toBe(false);
  await expect(f.host.execute(s.id,submit.id,'submit',undefined,{observationId:o.id,profile:'observed-ui-exploration'})).rejects.toMatchObject({code:'ACTION_BLOCKED'});
  for(const patch of [{source:'external-probe'},{kind:'custom-driver-operation'},{basis:{status:'tentative' as const,evidence:clear.basis!.evidence}},{localId:undefined}])expect(isObservedUIOperation({...clear,...patch},o)).toBe(false);
  expect(f.host.controlReviewMaterial(s.id).pendingControlIds).toContain(o.controls.find(c=>c.stableKey==='id:weak')!.localId);
  expect(f.host.session(s.id).actionCount).toBe(0);
 }finally{await f.close();}
});

it('does not treat a no-change click as a functional failure or a business-effect guarantee',async()=>{
 const f=await explorerFixture('<button type="button">No change</button>');
 try{
  const s=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui'}),o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.kind==='click')!;
  const result=await f.host.execute(s.id,a.id,'no-change',undefined,{observationId:o.id,profile:'observed-ui-exploration'});
  expect(result).toMatchObject({status:'succeeded',effectsAssessment:'not-assessed'});
  expect(f.host.observation(s.id).canonical).toBe(o.canonical);
 }finally{await f.close();}
});

it('keeps stale decisions and unknown execution outcomes blocked while preserving old dirty evidence',async()=>{
 const f=await explorerFixture(html);
 try{
  const s=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui'}),o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.label==='Clear'&&a.kind==='click')!;
  await f.host.observe(s.id);
  await expect(f.host.execute(s.id,a.id,'stale',undefined,{observationId:o.id,profile:'observed-ui-exploration'})).rejects.toMatchObject({code:'STALE_OBSERVATION'});
  const current=f.host.observation(s.id),next=f.host.actions(s.id).find(a=>a.label==='Clear'&&a.kind==='click')!;
  const unknown:ActionAttempt={id:'unknown-old',sessionId:s.id,requestId:'old',action:next,startedAt:new Date().toISOString(),beforeId:current.id,status:'unknown',purpose:'external'};
  f.host.store.put('attempt',unknown);f.host.store.put('session',{...f.host.session(s.id),dirty:true,dirtyAttemptIds:[unknown.id]});
  expect(f.host.actionAvailability(s.id).actions.find(x=>x.actionId===next.id)?.blockers).toContainEqual(expect.objectContaining({code:'UNKNOWN_ACTION_OUTCOME'}));
  await expect(f.host.execute(s.id,next.id,'unknown',undefined,{observationId:current.id,profile:'observed-ui-exploration'})).rejects.toMatchObject({code:'UNKNOWN_ACTION_OUTCOME'});
  expect(f.host.session(s.id)).toMatchObject({dirty:true,dirtyAttemptIds:['unknown-old'],actionCount:0});
 }finally{await f.close();}
});

it('supports the explicit contract over HTTP with no explorer plugin loaded',async()=>{
 const f=await explorerFixture(html),api=await createApi(f.host);
 try{
  const s=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui'}),o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.label==='Clear'&&a.kind==='click')!;
  const result=await api.inject({method:'POST',url:`/v1/sessions/${s.id}/commands`,payload:{type:'execute',actionId:a.id,requestId:'http',guard:{observationId:o.id,profile:'observed-ui-exploration'}}});
  expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({effectsAssessment:'not-assessed',status:'succeeded'});
 }finally{await api.close();await f.close();}
});

it('keeps supported unknown operations as correspondence evidence without replay authority',async()=>{
 const f=await explorerFixture('<button id="plain" type="button">Plain</button>');
 try{
  const first=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui'}),before=f.host.observation(first.id),a=f.host.actions(first.id).find(a=>a.kind==='click')!;
  const attempt=await f.host.execute(first.id,a.id,'source',undefined,{observationId:before.id,profile:'observed-ui-exploration'});await f.host.stop(first.id);
  const second=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui'}),current=f.host.observation(second.id),b=f.host.actions(second.id).find(a=>a.kind==='click')!;
  expect(f.host.operationCorrespondence(second.id,{observationId:current.id,actionId:b.id,source:{sessionId:first.id,attemptId:attempt.id}})).toMatchObject({equivalent:true,replayAuthorized:false,identityAuthorized:false,currentExecution:false});
  expect(f.host.session(second.id).actionCount).toBe(0);
  expect(f.host.graph(first.id).transitions.find(t=>t.attemptId===attempt.id)?.replayable).toBe(false);
 }finally{await f.close();}
});

it('preserves opt-in and unassessed effects across restart without laundering an interrupted attempt',async()=>{
 const { InteractionEngine }=await import('@interaction/browser');
 const { SqliteStore }=await import('@interaction/storage-sqlite');
 const { join }=await import('node:path');
 const f=await explorerFixture('<button type="button">Plain</button>');let restarted:InstanceType<typeof InteractionEngine>|undefined;
 try{
  const s=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui'}),before=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.kind==='click')!;
  const attempt=await f.host.execute(s.id,a.id,'completed',undefined,{observationId:before.id,profile:'observed-ui-exploration'});
  const interrupted={...attempt,id:'interrupted',requestId:'interrupted',status:'executing' as const,finishedAt:undefined};
  f.host.store.put('attempt',interrupted);f.host.store.put('session',{...f.host.session(s.id),unassessedEffectAttemptIds:[attempt.id,interrupted.id]});
  await f.host.close();restarted=new InteractionEngine({persistence:new SqliteStore(join(f.dir,'engine'))});
  expect(restarted.session(s.id)).toMatchObject({status:'paused',options:{executionPolicy:'observed-ui'},unassessedEffectAttemptIds:[attempt.id,interrupted.id],actionCount:1,dirty:false});
  expect(restarted.recoveryAssessment(s.id).unknownAttempts.map(a=>a.id)).toEqual([interrupted.id]);
  expect(restarted.list<ActionAttempt>(s.id,'attempt').find(a=>a.id===attempt.id)).toMatchObject({status:'succeeded',effectsAssessment:'not-assessed',action:{replayable:false,risk:'unknown'}});
  expect(restarted.actionAvailability(s.id).actions.every(a=>!a.executable)).toBe(true);
 }finally{await restarted?.close();await f.close();}
});

it('rechecks native submission evidence instead of trusting a changed candidate risk label',async()=>{
 const f=await explorerFixture(html);
 try{
  const s=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui'}),o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.label==='Submit'&&a.kind==='click')!;
  f.host.store.put('action',{...a,risk:'unknown'});
  const candidateBefore=f.host.actions(s.id).find(x=>x.id===a.id);
  expect(f.host.actionAvailability(s.id).actions.find(x=>x.actionId===a.id)?.blockers).toContainEqual(expect.objectContaining({reason:'submission_not_authorized'}));
  expect(f.host.actions(s.id).find(x=>x.id===a.id)).toEqual(candidateBefore);
  await expect(f.host.execute(s.id,a.id,'native',undefined,{observationId:o.id,profile:'observed-ui-exploration'})).rejects.toMatchObject({code:'ACTION_BLOCKED'});
  expect(f.host.session(s.id).actionCount).toBe(0);
 }finally{await f.close();}
});

it('keeps reviewed traversal selections binding for supported unknown buttons',async()=>{
 const f=await explorerFixture('<section aria-label="Area"><button id="one" type="button">One</button><button id="two" type="button">Two</button></section>');
 try{
  const s=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui',regionExploration:'review'}),o=f.host.observation(s.id);
  const material=f.host.regionReviewMaterial(s.id);
  await f.host.reviewRegions(s.id,{observationId:o.id,source:'test',evidence:['Observed section'],regions:[{key:'area',label:'Area',candidateIds:[material.candidates.find(c=>c.label==='Area')!.id]}]});
  const current=f.host.observation(s.id),one=f.host.actions(s.id).find(a=>a.label==='One'&&a.kind==='click')!,group=f.host.explorationReviewMaterial(s.id).groups.find(g=>g.kind==='reviewed-region')!;
  await f.host.decideExplorationGroup(s.id,group.id,group.revision,{mode:'sample',source:'test',evidence:['Only selected member'],memberKeys:[group.members.find(m=>m.actionId!==one.id)!.key]});
  expect(f.host.actionAvailability(s.id).actions.find(a=>a.actionId===one.id)?.blockers).toContainEqual(expect.objectContaining({selection:expect.objectContaining({state:'unselected'})}));
  await expect(f.host.execute(s.id,one.id,'outside-sample',undefined,{observationId:current.id,profile:'observed-ui-exploration'})).rejects.toMatchObject({code:'ACTION_BLOCKED'});
  expect(f.host.session(s.id).actionCount).toBe(0);
 }finally{await f.close();}
});

it('does not let an observed-ui authorization cross an active interaction boundary',async()=>{
 const f=await explorerFixture('<button id="outside" type="button">Outside</button><dialog open aria-label="Active"><button type="button">Inside</button></dialog>');
 try{
  const s=await f.host.createSession({...base,url:f.url,executionPolicy:'observed-ui'}),o=f.host.observation(s.id),outside=f.host.actions(s.id).find(a=>a.label==='Outside'&&a.kind==='click')!;
  expect(f.host.actionAvailability(s.id).actions.find(a=>a.actionId===outside.id)?.blockers).toContainEqual(expect.objectContaining({reason:'outside_active_boundary'}));
  await expect(f.host.execute(s.id,outside.id,'outside',undefined,{observationId:o.id,profile:'observed-ui-exploration'})).rejects.toMatchObject({code:'ACTION_BLOCKED'});
  expect(f.host.session(s.id).actionCount).toBe(0);
 }finally{await f.close();}
});
