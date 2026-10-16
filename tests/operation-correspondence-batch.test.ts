import { expect, it, vi } from 'vitest';
import { InteractionEngine } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter } from '../examples/counter-adapter.js';
import { explorerFixture } from './explorer-plugin-helpers.js';

function fixture(options: {identity?: boolean} = {}) {
  const store=new MemoryStore(),adapter=new CounterAdapter() as any;
  adapter.controlCorrespondence=vi.fn((c:any)=>c.stableKey?{key:c.stableKey,policy:'fixture-hint',evidence:['observed-key'],invalidatedBy:['binding-change']}:undefined);
  adapter.signature=vi.fn((c:any)=>`${c.tag}:${c.role}:${c.name}`);
  adapter.correspondenceCase=vi.fn((_a:any,o:any)=>({key:o.semanticState||'same-operation',policy:'fixture-operation',evidence:['observed-operation']}));
  const host=new InteractionEngine<any,any>({adapter,persistence:store});
  const control=(localId:string)=>({localId,instanceId:localId,identityId:`identity-${localId}`,tag:'button',role:'button',name:'Same',stableKey:options.identity?undefined:'key-one'});
  const observation=(id:string,sessionId:string)=>({id,sessionId,instanceScope:`document-${sessionId}`,context:{tenant:{status:'known',value:'one'}},gaps:[],controls:[control(id)],semanticState:'same-operation'});
  const before=observation('before','old'),after=observation('after','old'),current=observation('current','new');
  if(options.identity)Object.assign(current.controls[0],{identityId:'provisional',hypothesisId:'hypothesis'});
  for(const o of [before,after,current])store.put('observation',o);
  for(const id of ['old','new'])store.put('session',{id,options:{exploration:'controls'},actionCount:0,currentObservationId:id==='old'?'after':'current'});
  const action=(id:string,o:any)=>({id,sessionId:o.sessionId,observationId:o.id,localId:o.controls[0].localId,controlId:o.controls[0].identityId,kind:'select',value:'b',risk:'interface',basis:{status:'supported',evidence:[]},preconditions:{context:o.context}});
  const oldAction=action('old-action',before),target=action('new-action',current);
  store.put('action',target);
  const attempt={id:'attempt',sessionId:'old',action:oldAction,beforeId:'before',afterId:'after',status:'succeeded'};
  store.put('attempt',attempt);
  const request={actionId:target.id,source:{sessionId:'old',attemptId:attempt.id}};
  const batch=(requests=[request])=>host.operationCorrespondences('new',{observationId:current.id,requests});
  const singles=(requests=[request])=>requests.map(r=>host.operationCorrespondence('new',{observationId:current.id,...r}));
  return {store,adapter,host,before,after,current,target,attempt,request,batch,singles};
}

it('matches single results in request order, isolates missing or wrongly owned evidence, and grants no authority',()=>{
  const f=fixture(),requests=[{...f.request,source:{...f.request.source,sessionId:'wrong'}},{...f.request,source:{...f.request.source,attemptId:'missing'}},f.request];
  const writes=vi.spyOn(f.store,'put'),events=vi.spyOn(f.store,'event');
  const result=f.batch(requests);expect(result).toEqual({sessionId:'new',observationId:'current',results:f.singles(requests)});
  expect(result.results.map(r=>r.reason)).toEqual(['evidence_unavailable','evidence_unavailable','equivalent_operation_sample']);
  expect(result.results.every(r=>!r.identityAuthorized&&!r.replayAuthorized&&!r.currentExecution)).toBe(true);
  expect(writes).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled();
  expect(f.batch([]).results).toEqual([]);f.store.close();
});

it('reads shared records and indexes correspondence once in a batch instead of repeating whole observations',()=>{
  const f=fixture(),requests=Array.from({length:40},()=>structuredClone(f.request)),read=vi.spyOn(f.store,'require');
  const batch=f.batch(requests),calls=read.mock.calls;
  for(const id of ['before','after','current'])expect(calls.filter(([kind,key])=>kind==='observation'&&key===id)).toHaveLength(1);
  for(const kind of ['action','attempt'])expect(calls.filter(([k])=>k===kind)).toHaveLength(1);
  expect(calls.filter(([kind])=>kind==='session')).toHaveLength(2);
  expect(f.adapter.controlCorrespondence).toHaveBeenCalledTimes(2);expect(f.adapter.correspondenceCase).toHaveBeenCalledTimes(2);
  read.mockClear();expect(f.singles(requests)).toEqual(batch.results);
  expect(read.mock.calls.filter(([kind])=>kind==='observation')).toHaveLength(120);f.store.close();
});

it('does not merge different source values that share the same candidate action ID',()=>{
  const f=fixture();f.store.put('attempt',{...structuredClone(f.attempt),id:'different-value',action:{...f.attempt.action,value:'a'}});
  const requests=[f.request,{...f.request,source:{sessionId:'old',attemptId:'different-value'}},f.request];
  expect(f.batch(requests).results).toEqual(f.singles(requests));expect(f.batch(requests).results.map(r=>r.equivalent)).toEqual([true,false,true]);f.store.close();
});

it.each(['same-name-other-control','duplicate','context','changed-operation','unknown','incomplete-after','wrong-observation','review-withdrawn'] as const)('preserves invalidation after a prior batch: %s',change=>{
  const f=fixture();expect(f.batch().results[0].equivalent).toBe(true);
  if(change==='same-name-other-control')f.current.controls[0].stableKey='key-two';
  if(change==='duplicate')f.current.controls.push({...f.current.controls[0],localId:'second',instanceId:'second'});
  if(change==='context'){f.current.context.tenant.value='two';f.target.preconditions.context=f.current.context;f.store.put('action',f.target);}
  if(change==='changed-operation')f.current.semanticState='changed';
  if(change==='unknown'){f.attempt.status='unknown';f.store.put('attempt',f.attempt);}
  if(change==='incomplete-after'){f.after.id='incomplete-after';(f.after.gaps as any[]).push({code:'incomplete',critical:true});f.attempt.afterId=f.after.id;f.store.put('observation',f.after);f.store.put('attempt',f.attempt);}
  if(change==='wrong-observation'){f.target.observationId='other';f.store.put('action',f.target);}
  if(change==='review-withdrawn'){f.target.basis.status='tentative';f.store.put('action',f.target);}
  if(['same-name-other-control','duplicate','context','changed-operation'].includes(change)){
    f.current.id='next';f.target.observationId=f.current.id;f.store.put('observation',f.current);f.store.put('action',f.target);
  }
  expect(f.batch().results).toEqual(f.singles());expect(f.batch().results[0].equivalent).toBe(false);f.store.close();
});

it('shares identity evidence within a batch and rechecks a withdrawn judgment on the next call',()=>{
  const f=fixture({identity:true});
  const hypothesis={id:'hypothesis',sessionId:'new',status:'resolved',provisionalIdentityId:'provisional',revisions:[{identityId:'accepted'}]};f.store.put('hypothesis',hypothesis);
  const reads=vi.spyOn(f.store,'list'),requests=[f.request,f.request];expect(f.batch(requests).results.every(r=>r.equivalent)).toBe(true);
  expect(reads.mock.calls.filter(([kind])=>kind==='hypothesis')).toHaveLength(2);
  f.store.put('hypothesis',{...hypothesis,status:'pending'});expect(f.batch(requests).results).toEqual(f.singles(requests));expect(f.batch().results[0].equivalent).toBe(false);f.store.close();
});

it('preserves browser cross-session correspondence and distinguishes same-name controls without changing execution records',async()=>{
  const f=await explorerFixture('<section aria-label="Controls"><button id="one" type="button">Same</button><button id="two" type="button">Same</button></section>');
  try{
    const options={url:f.url,headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]};
    const source=await f.host.createSession(options),o=f.host.observation(source.id),control=o.controls.find(c=>c.stableKey==='id:one')!,action=f.host.actions(source.id).find(a=>a.localId===control.localId)!;
    const attempt=await f.host.execute(source.id,action.id,'source');expect(attempt.status).toBe('succeeded');await f.host.stop(source.id);
    const next=await f.host.createSession(options),current=f.host.observation(next.id),requests=['id:one','id:two'].map(key=>({actionId:f.host.actions(next.id).find(a=>a.localId===current.controls.find(c=>c.stableKey===key)!.localId)!.id,source:{sessionId:source.id,attemptId:attempt.id}}));
    const events=f.host.store.events(next.id).length,result=f.host.operationCorrespondences(next.id,{observationId:current.id,requests});
    expect(result.results).toEqual(requests.map(r=>f.host.operationCorrespondence(next.id,{observationId:current.id,...r})));
    expect(result.results.map(r=>r.equivalent)).toEqual([true,false]);expect(f.host.list(next.id,'attempt')).toEqual([]);expect(f.host.session(next.id).actionCount).toBe(0);expect(f.host.store.events(next.id)).toHaveLength(events);
  }finally{await f.close();}
});

it.each(['unchanged','other-instance','duplicate-instance','new-document','changed-context','changed-operation','review-withdrawn','unknown'] as const)('uses unique same-instance continuity despite repeated hints, preserving %s checks',change=>{
 const f=fixture();
 f.current.sessionId='old';f.current.instanceScope=f.before.instanceScope;
 f.current.controls[0].instanceId=f.before.controls[0].instanceId;
 const sibling={...f.before.controls[0],localId:'sibling',instanceId:'sibling-instance',identityId:'sibling-identity'};
 f.before.controls.push(sibling);f.current.controls.push({...sibling});
 f.target.sessionId='old';
 if(change==='other-instance')f.current.controls[0].instanceId='replacement';
 if(change==='duplicate-instance')f.current.controls[1].instanceId=f.current.controls[0].instanceId;
 if(change==='new-document')f.current.instanceScope='replacement-document';
 if(change==='changed-context'){f.current.context.tenant.value='two';f.target.preconditions.context=f.current.context;}
 if(change==='changed-operation')f.current.semanticState='changed';
 if(change==='review-withdrawn')f.target.basis.status='tentative';
 if(change==='unknown')f.attempt.status='unknown';
 f.before.id='continuity-before';f.current.id='continuity-current';f.attempt.beforeId=f.before.id;f.attempt.action.observationId=f.before.id;f.target.observationId=f.current.id;
 for(const o of [f.before,f.current])f.store.put('observation',o);f.store.put('action',f.target);f.store.put('attempt',f.attempt);
 const writes=vi.spyOn(f.store,'put');
 const proof=f.host.operationCorrespondence('old',{observationId:f.current.id,...f.request});
 expect(proof.equivalent).toBe(change==='unchanged');
 expect(proof).toMatchObject({identityAuthorized:false,replayAuthorized:false,currentExecution:false});
 if(change==='unchanged')expect(proof.evidence).toContain('nonunique-hint-not-used');
 expect(writes).not.toHaveBeenCalled();f.store.close();
});

it('recognizes the same browser occurrence despite repeated test IDs without covering its sibling',async()=>{
 const f=await explorerFixture('<button data-testid="repeat" type="button">First</button><button data-testid="repeat" type="button">Second</button>');
 try{
  const s=await f.host.createSession({url:f.url,headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]}),a=f.host.actions(s.id).find(a=>a.label==='First')!;
  const attempt=await f.host.execute(s.id,a.id,'first'),current=f.host.observation(s.id);
  const proof=(label:string)=>f.host.operationCorrespondence(s.id,{observationId:current.id,actionId:f.host.actions(s.id).find(a=>a.label===label)!.id,source:{sessionId:s.id,attemptId:attempt.id}});
  expect(proof('First')).toMatchObject({equivalent:true,identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  expect(proof('First').evidence).toContain('current-instance-continuity');expect(proof('Second').equivalent).toBe(false);
 }finally{await f.close();}
});

it.each(['same','other-name','ambiguous','other-identity','pending','instance-only','changed-context','changed-operation','unknown'] as const)('refines a shared component key using unique semantics and existing identity, preserving %s',change=>{
 const f=fixture();f.current.sessionId='old';f.target.sessionId='old';
 f.current.controls[0].identityId=f.before.controls[0].identityId;f.target.controlId=f.current.controls[0].identityId;
 const peer={...f.before.controls[0],localId:'peer',instanceId:'peer-instance',identityId:'peer-identity',name:'Other'};
 f.before.controls.push(peer);f.current.controls.push({...peer,instanceId:'rebuilt-peer'});
 if(change==='other-name')f.current.controls[0].name='Different';
 if(change==='ambiguous')f.current.controls[1].name=f.current.controls[0].name;
 if(change==='other-identity')f.current.controls[0].identityId='different-identity';
 if(change==='pending')Object.assign(f.current.controls[0],{hypothesisId:'unresolved-hypothesis'});
 if(change==='instance-only')Object.assign(f.current.controls[0],{identityScope:'instance'});
 if(change==='changed-context'){f.current.context.tenant.value='two';f.target.preconditions.context=f.current.context;}
 if(change==='changed-operation')f.current.semanticState='changed';
 if(change==='unknown')f.attempt.status='unknown';
 f.before.id='refined-before';f.current.id='refined-current';f.attempt.beforeId=f.before.id;f.attempt.action.observationId=f.before.id;f.target.observationId=f.current.id;
 for(const o of [f.before,f.current])f.store.put('observation',o);f.store.put('action',f.target);f.store.put('attempt',f.attempt);
 const writes=vi.spyOn(f.store,'put');const proof=f.host.operationCorrespondence('old',{observationId:f.current.id,...f.request});
 expect(proof.equivalent).toBe(change==='same');
 if(change==='same')expect(proof.evidence).toContain('shared-hint-refined-by-unique-semantics');
 expect(proof).toMatchObject({identityAuthorized:false,replayAuthorized:false,currentExecution:false});expect(writes).not.toHaveBeenCalled();f.store.close();
});
