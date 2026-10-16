import { expect, it } from 'vitest';
import { explorerFixture } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';
import { createServer as createApi } from '../apps/server/src/server.js';
import type { ActionAttempt, ExecutionGuard, FrontierItem } from '@interaction/core';
const options={headless:true,exploration:'controls',executionPolicy:'observed-ui',settleMs:0,observeTimeoutMs:300};
const html='<div id="hint" tabindex="0" style="cursor:pointer">Hint</div>';

it.each(['hover','focus'])('performs one current-instance %s probe without asserting business effects or replay permission',async kind=>{
 const f=await explorerFixture(html);
 try{
  const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),c=o.controls.find(c=>c.stableKey==='id:hint')!;
  const events=f.host.store.events(s.id).length,actions=f.host.actions(s.id);
  const available=f.host.probeAvailability(s.id,o.id,c.localId,kind);
  expect(available).toMatchObject({profile:'observed-ui-probe',executable:true,blockers:[],dispatchRevalidationRequired:true});
  expect(f.host.store.events(s.id)).toHaveLength(events);expect(f.host.actions(s.id)).toEqual(actions);
  const guard={observationId:o.id,profile:'observed-ui-probe' as const};
  const result=await f.host.probe(s.id,o.id,c.localId,kind,'probe',undefined,guard);
  expect(result).toMatchObject({status:'succeeded',effectsAssessment:'not-assessed',executionProfile:'observed-ui-probe',action:{source:'external-probe',kind,risk:'unknown',replayable:false}});
  expect(f.host.session(s.id)).toMatchObject({dirty:false,actionCount:1,unassessedEffectAttemptIds:[result.id]});
  expect((await f.host.probe(s.id,o.id,c.localId,kind,'probe',undefined,guard)).id).toBe(result.id);
  expect(f.host.session(s.id).actionCount).toBe(1);
  await expect(f.host.probe(s.id,o.id,c.localId,kind==='hover'?'focus':'hover','probe',undefined,guard)).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
 }finally{await f.close();}
});

it('requires opt-in and never grants clicks, scrolling, parameters or ordinary execute access',async()=>{
 const f=await explorerFixture(html);
 try{
  const s=await f.host.createSession({...options,url:f.url,executionPolicy:undefined}),o=f.host.observation(s.id),c=o.controls.find(c=>c.stableKey==='id:hint')!,guard={observationId:o.id,profile:'observed-ui-probe' as const};
  expect(f.host.probeAvailability(s.id,o.id,c.localId,'hover').blockers).toContainEqual(expect.objectContaining({reason:'observed_ui_authorization_required'}));
  await expect(f.host.probe(s.id,o.id,c.localId,'hover','no-opt-in',undefined,guard)).rejects.toMatchObject({code:'ACTION_BLOCKED'});
  for(const kind of ['click','scroll','custom']){
   expect(f.host.probeAvailability(s.id,o.id,c.localId,kind).executable).toBe(false);
   expect(()=>f.host.probe(s.id,o.id,c.localId,kind,kind,undefined,guard)).toThrow();
  }
  expect(()=>f.host.probe(s.id,o.id,c.localId,'hover','parameters','anything',guard)).toThrow();
  await expect(f.host.execute(s.id,'none','ordinary',undefined,guard as unknown as ExecutionGuard)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(f.host.session(s.id).actionCount).toBe(0);
  const legacy=await f.host.probe(s.id,o.id,c.localId,'hover','legacy');
  expect(legacy.effectsAssessment).toBeUndefined();expect(f.host.session(s.id).dirty).toBe(true);
 }finally{await f.close();}
});

it('retains active boundaries and unknown outcomes as probe blockers',async()=>{
 const f=await explorerFixture(`${html}<dialog open aria-label="Panel"><div id="inside" tabindex="0" style="cursor:pointer">Inside</div></dialog>`);
 try{
  const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),outside=o.controls.find(c=>c.stableKey==='id:hint')!,inside=o.controls.find(c=>c.stableKey==='id:inside')!,guard={observationId:o.id,profile:'observed-ui-probe' as const};
  expect(f.host.probeAvailability(s.id,o.id,outside.localId,'hover').blockers).toContainEqual(expect.objectContaining({reason:'outside_active_boundary'}));
  await expect(f.host.probe(s.id,o.id,outside.localId,'hover','outside',undefined,guard)).rejects.toMatchObject({code:'ACTION_BLOCKED'});
  const action=f.host.actions(s.id).find(a=>a.localId===inside.localId)!;
  f.host.store.put('attempt',{id:'old-unknown',sessionId:s.id,requestId:'old',action,beforeId:o.id,startedAt:new Date().toISOString(),status:'unknown',purpose:'external'} satisfies ActionAttempt);
  expect(f.host.probeAvailability(s.id,o.id,inside.localId,'focus').blockers).toContainEqual(expect.objectContaining({code:'UNKNOWN_ACTION_OUTCOME'}));
  await expect(f.host.probe(s.id,o.id,inside.localId,'focus','unknown',undefined,guard)).rejects.toMatchObject({code:'UNKNOWN_ACTION_OUTCOME'});
  expect(f.host.session(s.id).actionCount).toBe(0);
 }finally{await f.close();}
});

it('rejects stale observations and revalidates the live target after an available query',async()=>{
 const f=await explorerFixture(html);
 try{
  const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),c=o.controls.find(c=>c.stableKey==='id:hint')!;
  await f.host.observe(s.id);
  expect(f.host.probeAvailability(s.id,o.id,c.localId,'hover').blockers).toContainEqual(expect.objectContaining({code:'STALE_OBSERVATION'}));
  await expect(f.host.probe(s.id,o.id,c.localId,'hover','stale',undefined,{observationId:o.id,profile:'observed-ui-probe'})).rejects.toMatchObject({code:'STALE_OBSERVATION'});
  const current=f.host.observation(s.id),target=current.controls.find(c=>c.stableKey==='id:hint')!;
  expect(f.host.probeAvailability(s.id,current.id,target.localId,'hover').executable).toBe(true);
  await pageOf(f.host).evaluate(()=>document.querySelector('#hint')!.remove());
  await expect(f.host.probe(s.id,current.id,target.localId,'hover','removed',undefined,{observationId:current.id,profile:'observed-ui-probe'})).rejects.toMatchObject({code:'STALE_OBSERVATION'});
  expect(f.host.session(s.id).actionCount).toBe(0);
 }finally{await f.close();}
});

it('inherits target scope selections and unknown frontier state instead of bypassing them with a probe action ID',async()=>{
 const f=await explorerFixture('<section aria-label="Area"><button id="one" type="button">One</button><button id="two" type="button">Two</button></section>');
 try{
  const s=await f.host.createSession({...options,url:f.url,regionExploration:'review'}),o=f.host.observation(s.id),material=f.host.regionReviewMaterial(s.id);
  await f.host.reviewRegions(s.id,{observationId:o.id,source:'test',evidence:['Observed section'],regions:[{key:'area',label:'Area',candidateIds:[material.candidates.find(c=>c.label==='Area')!.id]}]});
  const current=f.host.observation(s.id),one=f.host.actions(s.id).find(a=>a.label==='One'&&a.kind==='click')!,group=f.host.explorationReviewMaterial(s.id).groups.find(g=>g.kind==='reviewed-region')!;
  await f.host.decideExplorationGroup(s.id,group.id,group.revision,{mode:'sample',source:'test',evidence:['Only selected member'],memberKeys:[group.members.find(m=>m.actionId!==one.id)!.key]});
  expect(f.host.probeAvailability(s.id,current.id,one.localId!,'hover').blockers).toContainEqual(expect.objectContaining({selection:expect.objectContaining({state:'unselected'})}));
  await expect(f.host.probe(s.id,current.id,one.localId!,'hover','sample',undefined,{observationId:current.id,profile:'observed-ui-probe'})).rejects.toMatchObject({code:'ACTION_BLOCKED'});
  const frontier=f.host.list<FrontierItem>(s.id,'frontier').find(f=>f.action.id===one.id)!;f.host.store.put('frontier',{...frontier,status:'unknown',reason:'Interrupted target operation'});
  expect(f.host.probeAvailability(s.id,current.id,one.localId!,'hover').blockers).toContainEqual(expect.objectContaining({reason:'Interrupted target operation'}));
  expect(f.host.session(s.id).actionCount).toBe(0);
 }finally{await f.close();}
});

it('accepts the guarded probe command with the explorer plugin disabled',async()=>{
 const f=await explorerFixture(html),api=await createApi(f.host);
 try{
  const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),c=o.controls.find(c=>c.stableKey==='id:hint')!;
  const r=await api.inject({method:'POST',url:`/v1/sessions/${s.id}/commands`,payload:{type:'probe',observationId:o.id,localId:c.localId,kind:'hover',requestId:'http',guard:{observationId:o.id,profile:'observed-ui-probe'}}});
  expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({status:'succeeded',effectsAssessment:'not-assessed',executionProfile:'observed-ui-probe'});
 }finally{await api.close();await f.close();}
});

it('requires unique current instance evidence even when logical identity was resolved',async()=>{
 const f=await explorerFixture(html);
 try{
  const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),c=o.controls.find(c=>c.stableKey==='id:hint')!;
  const duplicate={...o,id:'duplicate-observation',controls:[...o.controls,{...c,localId:'duplicate-local-id'}]};
  f.host.store.put('observation',duplicate);f.host.store.put('session',{...f.host.session(s.id),currentObservationId:duplicate.id});
  expect(f.host.probeAvailability(s.id,duplicate.id,c.localId,'hover').blockers).toContainEqual(expect.objectContaining({reason:'bounded_probe_required'}));
  await expect(f.host.probe(s.id,duplicate.id,c.localId,'hover','duplicate',undefined,{observationId:duplicate.id,profile:'observed-ui-probe'})).rejects.toMatchObject({code:'ACTION_BLOCKED'});
  expect(f.host.session(s.id).actionCount).toBe(0);
 }finally{await f.close();}
});
