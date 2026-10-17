import {beforeAll,expect,it,vi} from 'vitest';
import {BrowserEngine,PlaywrightAdapter,type ActionAttempt,type ActionCandidate,type ControlReviewRecord,type Observation,type Session} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';
import {explorerFixture} from './explorer-plugin-helpers.js';

type Row={id:string;sessionId?:string};
type Seed={sid:string;targetId:string;observationId:string;attemptId:string;reviewId:string;rows:Record<string,Row[]>};
let seed:Seed;
// Capture one real local execution. All counterexamples below use independent
// memory stores; no queried engine attaches a browser or serves an HTTP request.
beforeAll(async()=>{
 const f=await explorerFixture('<button id="open" type="button" data-record="A" onclick="window.executedRecord=this.dataset.record;this.disabled=true">Open</button><input id="mode" type="checkbox" aria-label="Mode" hidden>');
 try{
  const s=await f.host.createSession({url:f.url,headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100});
  const original=f.host.observation(s.id),target=f.host.actions(s.id).find(a=>a.label==='Open'&&a.kind==='click')!;
  expect(target).toBeDefined();expect(target.risk).toBe('unknown');
  await f.host.observe(s.id);const reviewSource=f.host.observation(s.id);
  const [review]=await f.host.reviewControls(s.id,{observationId:reviewSource.id,source:'fixture-explicit-review',reviews:[{localId:target.localId!,kind:'click',risk:'interface',replayable:false,reason:'Open this local interface',evidence:['Exact fixture handler reviewed']}]});
  const approved=f.host.actions(s.id).find(a=>a.localId===target.localId&&a.kind==='click')!;
  const attempt=await f.host.execute(s.id,approved.id,'actual-reviewed-source');expect(attempt.status).toBe('succeeded');
  expect(f.host.observation(s.id).controls.find(c=>c.localId===target.localId)?.enabled).toBe(false);
  const kinds=['session','observation','action','attempt','control-review','hypothesis','identity','visit'];
  seed={sid:s.id,targetId:target.id,observationId:original.id,attemptId:attempt.id,reviewId:review.id,rows:Object.fromEntries(kinds.map(kind=>[kind,f.host.store.list<Row>(kind,s.id)]))};
 }finally{await f.close();}
});

type Draft={session:Session;target:ActionCandidate;current:Observation;before:Observation;after:Observation;attempt:ActionAttempt;review:ControlReviewRecord;rows:Seed['rows']};
function fixture(change?:(d:Draft)=>void){
 const rows=structuredClone(seed.rows),find=<T extends Row>(kind:string,id:string)=>rows[kind].find(r=>r.id===id)! as T;
 const attempt=find<ActionAttempt>('attempt',seed.attemptId),session=find<Session>('session',seed.sid);
 const d:Draft={session,target:find<ActionCandidate>('action',seed.targetId),current:find<Observation>('observation',seed.observationId),before:find<Observation>('observation',attempt.beforeId),after:find<Observation>('observation',attempt.afterId!),attempt,review:find<ControlReviewRecord>('control-review',seed.reviewId),rows};
 // Required only for target/repetition read APIs; never an actual navigation.
 session.currentObservationId=d.current.id;change?.(d);
 const store=new MemoryStore();for(const [kind,values] of Object.entries(rows))for(const row of values)store.put(kind,row);
 const host=new BrowserEngine({persistence:store}),request={observationId:d.current.id,actionId:d.target.id,source:{sessionId:seed.sid,attemptId:attempt.id}};
 return {...d,store,host,request,query:()=>host.operationCorrespondence(seed.sid,request),close:()=>host.close()};
}
function reviewedProof(d:Draft){return d.attempt.action.basis!.evidence.find(e=>e.rule==='reviewed-control/v1')!;}
function targetControl(d:Draft){return d.current.controls.find(c=>c.localId===d.target.localId)!;}

it('proves the pre-review operation from a real successful reviewed execution without mutating facts or dispatching',async()=>{
 const f=fixture();try{
  const before=structuredClone(f.store.list<Observation>('observation')),attempts=structuredClone(f.store.list<ActionAttempt>('attempt'));
  const writes=vi.spyOn(f.store,'put'),events=vi.spyOn(f.store,'event');
  const proof=f.query();expect(proof).toMatchObject({equivalent:true,reason:'equivalent_reviewed_operation_sample',identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  expect(proof.evidence).toContain(`historical-control-review:${f.review.id}`);
  expect(f.host.operationCorrespondences(seed.sid,{observationId:f.current.id,requests:[{actionId:f.target.id,source:f.request.source}]}).results).toEqual([proof]);
  expect(writes).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled();expect(f.store.list('observation')).toEqual(before);expect(f.store.list('attempt')).toEqual(attempts);
  expect(f.host.session(seed.sid).actionCount).toBe(1);expect(f.host.list(seed.sid,'identity')).toEqual(seed.rows.identity);
 }finally{await f.close();}
});

it('permits tentative basis clarification without changing its retained action',async()=>{
 const f=fixture(d=>{d.target.basis!.status='tentative';});try{
  const before=structuredClone(f.target);expect(f.query().equivalent).toBe(true);expect(f.store.require('action',f.target.id)).toEqual(before);
 }finally{await f.close();}
});

it('accepts invalidation tied to the successful after capture even when it occurred before finishedAt',async()=>{
 const f=fixture(d=>{d.review.status='invalidated';d.review.invalidation={observationId:d.attempt.afterId!,at:d.after.capturedAt,reason:'control_conditions_changed'};});
 try{expect(Date.parse(f.review.invalidation!.at)).toBeLessThanOrEqual(Date.parse(f.attempt.finishedAt!));expect(f.query().equivalent).toBe(true);}finally{await f.close();}
});

it.each(['unknown','executing','failed','no-after','missing-attempt'] as const)('rejects a source outcome that is %s',async change=>{
 const f=fixture(d=>{if(change==='no-after')delete d.attempt.afterId;else if(change==='missing-attempt')d.rows.attempt=[];else d.attempt.status=change;});
 try{expect(f.query().equivalent).toBe(false);}finally{await f.close();}
});

it.each(['new-instance','new-document','rule-version','missing-rule-version','duplicate-instance','parent-binding','handler-binding','context','unknown-context','critical-gap','different-value','nonlocal-mode','nonlocal-unavailable'] as const)('does not use a control review to equate changed or unavailable %s evidence',async change=>{
 const f=fixture(d=>{
  const c=targetControl(d);
  if(change==='new-instance')c.instanceId='other-instance';if(change==='new-document')d.current.instanceScope='other-document';
  if(change==='rule-version')d.current.ruleVersion=d.current.ruleVersion==='observable-v1'?'observable-v2':'observable-v1';if(change==='missing-rule-version')Reflect.deleteProperty(d.current,'ruleVersion');
  if(change==='duplicate-instance')d.current.controls.push({...structuredClone(c),localId:'duplicate-control'});
  if(change==='parent-binding')c.reviewBinding!.parentInstanceId='different-parent';if(change==='handler-binding')c.reviewBinding!.attributes.onclick='different()';
  if(change==='context'||change==='unknown-context'){d.current.context={tenant:{status:change==='context'?'known':'unknown',value:'other',source:'fixture'}};d.target.preconditions.context=structuredClone(d.current.context);}
  if(change==='critical-gap')d.current.gaps.push({code:'INCOMPLETE',critical:true,message:'fixture gap'});
  if(change==='different-value')d.target.value='different-value';
  const mode=d.current.controls.find(c=>c.role==='checkbox')!;
  if(change==='nonlocal-mode')mode.checked=true;if(change==='nonlocal-unavailable')mode.hypothesisId='unresolved-mode';
 });try{expect(f.query().equivalent).toBe(false);}finally{await f.close();}
});

it.each(['foreign-review','missing-review','unsupported-status','forged-key','forged-source-observation','forged-source','corrupt-record-conditions','duplicate-proof','different-prior-review','revoked','superseded','invalidated-before','invalidated-unrelated','invalidated-without-coordinate','revoked-reuse-parent','cyclic-reuse-parent'] as const)('rejects invalid retained review provenance: %s',async change=>{
 const f=fixture(d=>{
  const proof=reviewedProof(d);
  if(change==='foreign-review')d.review.sessionId='foreign';if(change==='missing-review')d.rows['control-review']=[];
  if(change==='unsupported-status')Object.assign(d.review,{status:'damaged-status'});
  if(change==='forged-key')proof.facts.conditionKey='forged';if(change==='forged-source-observation')proof.facts.sourceObservationId='forged-observation';if(change==='forged-source')proof.source='forged-reviewer';
  if(change==='corrupt-record-conditions')d.review.conditions.target.name='Other target';
  if(change==='duplicate-proof')d.attempt.action.basis!.evidence.push(structuredClone(proof));
  if(change==='different-prior-review')d.target.basis!.evidence.push({...structuredClone(proof),facts:{...proof.facts,reviewId:'different-review'}});
  if(change==='revoked'||change==='superseded')d.review.status=change;
  if(change.startsWith('invalidated-')){d.review.status='invalidated';d.review.invalidation={observationId:change==='invalidated-before'?d.before.id:change==='invalidated-unrelated'?'later-unrelated-observation':'',at:d.attempt.startedAt,reason:'control_conditions_changed'};}
  if(change==='revoked-reuse-parent'){const parent={...structuredClone(d.review),id:'revoked-parent',status:'revoked' as const};d.rows['control-review'].push(parent);d.review.reusedFrom={reviewId:parent.id,conditionKey:'parent-key',evidence:['reuse']};}
  if(change==='cyclic-reuse-parent')d.review.reusedFrom={reviewId:d.review.id,conditionKey:'cycle',evidence:['invalid cycle']};
 });try{expect(f.query().equivalent).toBe(false);}finally{await f.close();}
});

it.each(['target-after-source','source-after-start','review-after-start','invalid-target-time','invalid-review-time'] as const)('rejects an unverifiable historical order: %s',async change=>{
 const f=fixture(d=>{
  const later=new Date(Date.parse(d.attempt.startedAt)+1000).toISOString();
  if(change==='target-after-source')d.current.capturedAt=later;if(change==='source-after-start')d.before.capturedAt=later;if(change==='review-after-start')d.review.at=later;
  if(change==='invalid-target-time')d.current.capturedAt='invalid';if(change==='invalid-review-time')d.review.at='invalid';
 });try{expect(f.query().equivalent).toBe(false);}finally{await f.close();}
});

it('does not apply historical review clarification to target arrival or repetition permission',async()=>{
 const f=fixture();try{
  expect(f.query().equivalent).toBe(true);
  const target=f.host.explorationTargetCorrespondences(seed.sid,{observationId:f.current.id,requests:[{actionId:f.target.id,source:{sessionId:seed.sid,observationId:f.before.id,actionId:f.attempt.action.id}}]}).results[0];
  expect(target.equivalent).toBe(false);expect(target.currentExecution).toBe(false);
  expect(f.host.repetitionAssessment(seed.sid,f.request).repeatable).toBe(false);expect(f.host.session(seed.sid).actionCount).toBe(1);
 }finally{await f.close();}
});


it.each(['target-data-record','original-review-attributes','missing-original-review','foreign-original-review','incomplete-original-review','changed-original-rule','late-original-review'] as const)('rejects unverified original review source or data binding: %s',async change=>{
 const f=fixture(d=>{
  const source=d.rows.observation.find(row=>row.id===d.review.observationId)! as Observation;
  expect(source.id).not.toBe(d.current.id);expect(source.id).not.toBe(d.before.id);
  const control=source.controls.find(c=>c.localId===d.review.localId)!;
  if(change==='target-data-record')targetControl(d).reviewAttributes!['data-record']='B';
  if(change==='original-review-attributes')control.reviewAttributes!['data-record']='B';
  if(change==='missing-original-review')d.rows.observation=d.rows.observation.filter(row=>row.id!==source.id);
  if(change==='foreign-original-review')source.sessionId='other-session';
  if(change==='incomplete-original-review')source.gaps.push({code:'INCOMPLETE',critical:true,message:'Missing original review source'});
  if(change==='changed-original-rule')source.ruleVersion=source.ruleVersion==='observable-v1'?'observable-v2':'observable-v1';
  if(change==='late-original-review')source.capturedAt=new Date(Date.parse(d.review.at)+1000).toISOString();
 });try{expect(f.query().equivalent).toBe(false);}finally{await f.close();}
});

it('reads a repeated proof pair once per batch and rechecks a later revocation on the next query',async()=>{
 const f=fixture();const reads=vi.spyOn(f.host.store,'get'),samples=vi.spyOn(PlaywrightAdapter.prototype,'correspondenceCase');
 try{
  const result=f.host.operationCorrespondences(seed.sid,{observationId:f.current.id,requests:Array.from({length:25},()=>({actionId:f.target.id,source:{...f.request.source}}))});
  expect(result.results).toHaveLength(25);expect(result.results.every(r=>r.equivalent)).toBe(true);
  expect(reads.mock.calls.filter(([kind,id])=>kind==='control-review'&&id===f.review.id)).toHaveLength(1);
  expect(reads.mock.calls.filter(([kind,id])=>kind==='observation'&&id===f.review.observationId)).toHaveLength(1);
  expect(samples).toHaveBeenCalledTimes(3); // source, original target, projected target
  f.review.status='revoked';f.store.put('control-review',f.review);reads.mockClear();
  expect(f.query().equivalent).toBe(false);expect(reads.mock.calls.filter(([kind,id])=>kind==='control-review'&&id===f.review.id)).toHaveLength(1);
 }finally{samples.mockRestore();await f.close();}
});
