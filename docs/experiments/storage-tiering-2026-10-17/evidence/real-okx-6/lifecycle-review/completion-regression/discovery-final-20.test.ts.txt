import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {type ActionAttempt,type ActionCandidate,type Observation,browserOperationKey,browserOperationSchedulingKey,browserTargetConditions} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Round,type Task} from '@interaction/explorer-plugin';
import {scopeFor} from '../packages/explorer-plugin/src/policy.js';

function fixture(reason='region_review_required'){
 const url='https://fixture.invalid/discovery';
 const frame=(id:string)=>{
  const c={localId:`${id}:target`,instanceId:`${id}:target`,identityId:`${id}:identity`,tag:'button',role:'button',name:'Open',label:'Open',visible:true,enabled:true,region:'document',selected:[],constraints:{type:'button'},
   structuralItem:{ownerInstanceId:`${id}:owner`,recordKey:'record-123',template:'row',slot:'open'},stableKey:`structural-item:${JSON.stringify([`${id}:owner`,'record-123','open'])}`,identityContext:{scope:'orders',binding:'record-123',evidence:['fixture']},actionBasis:{click:{status:'supported',evidence:[]}}};
  const o={id,sessionId:'session',instanceScope:id,url,ruleVersion:'observable-v7',context:{},stable:true,gaps:[],regions:[],boundaries:[],components:[],controls:[c,{localId:`${id}:mode`,instanceId:`${id}:mode`,tag:'input',role:'checkbox',name:'Mode',label:'Mode',checked:false,selected:[],visible:false,enabled:true,region:'document',constraints:{type:'checkbox'},hypothesisId:`${id}:unverified-mode`}]} as unknown as Observation;
  const a={id:`${id}:action`,sessionId:o.sessionId,observationId:o.id,stateId:`state-${id}`,source:'fixture',sampleValidity:'known',localId:c.localId,controlId:c.identityId,kind:'click',label:'Open',risk:'interface',replayable:true,excluded:false,basis:c.actionBasis.click,preconditions:{visible:true,enabled:true,identityResolved:true,context:o.context}} as ActionCandidate;
  return {o,a};
 };
 const a=frame('A'),b=frame('B'),after={...structuredClone(b.o),id:'after',url:'https://fixture.invalid/after',controls:[]} as Observation;
 expect(scopeFor(a.a,a.o)).toEqual(scopeFor(b.a,b.o));expect(browserOperationKey(a.a,a.o)).not.toBe(browserOperationKey(b.a,b.o));
 expect(browserOperationSchedulingKey(a.a,a.o)).toBe(browserOperationSchedulingKey(b.a,b.o));expect(browserTargetConditions(b.a,b.o)).toBeUndefined();
 const attempt=(id:string,before:typeof a)=>({id,sessionId:'session',beforeId:before.o.id,afterId:after.id,action:before.a,status:'succeeded',startedAt:'2026-10-17T00:00:00.000Z',finishedAt:'2026-10-17T00:00:00.001Z'}) as ActionAttempt;
 const oldAttempt=attempt('executed-A',a),newAttempt=attempt('executed-B',b),observations=new Map([a.o,b.o,after].map(o=>[o.id,o]));
 const actions=new Map([[a.o.id,[a.a]],[b.o.id,[b.a]],[after.id,[] as ActionCandidate[]]]),attempts=[oldAttempt,newAttempt];
 const host={events:new EventEmitter(),observation:(_sid:string,id?:string)=>observations.get(id||b.o.id)!,actions:(_sid:string,id?:string)=>actions.get(id||b.o.id)!,operationCoverageCandidates:(_sid:string,id?:string)=>actions.get(id||b.o.id)!,list:(_sid:string,kind:string)=>kind==='attempt'?attempts:[],session:()=>({id:'session',actionCount:2,options:{}}),
  operationCorrespondences:vi.fn((sid:string,input:{observationId:string;requests:{actionId:string;source:{sessionId:string;attemptId:string}}[]})=>({sessionId:sid,observationId:input.observationId,results:input.requests.map(r=>({equivalent:false,reason:'operation_conditions_unavailable',source:r.source,target:{sessionId:sid,observationId:input.observationId,actionId:r.actionId},identityAuthorized:false,replayAuthorized:false,currentExecution:false,evidence:[],invalidatedBy:[]}))}))} as unknown as ExplorerHost;
 const store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(host,store),task=plugin.create({url,coverageMode:'all'}),scope=scopeFor(b.a,b.o),key=browserOperationSchedulingKey(b.a,b.o);
 const round:Round={id:'round',number:1,sessionId:'session',startedAt:'2026-10-17T00:00:00.000Z',status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};task.rounds=[round];
 const item=(id:string,source:string):PlanItem=>({id,title:'Open',scope,prerequisites:[],completion:'Verify each retained source',status:'unresolved',required:true,dispatchScope:false,reason,operationConditionKey:key,operationConditionPolicy:'browser-operation-key-v3',evidence:[{sessionId:'session',observationId:source}],attempts:[]});
 const old=item('closed-A','A'),ref={sessionId:'session',observationId:after.id,attemptId:oldAttempt.id};old.status='succeeded';old.resolvedBy=ref;old.evidence.push(ref);old.attempts.push({roundId:'round',outcome:'succeeded',evidence:ref});
 task.plan=[{id:'root',title:'Page',scope:{url},prerequisites:[],completion:'Explore page',required:true,dispatchScope:true,status:'pending',reason:'program_exhaustive_root',evidence:[],attempts:[]},old];
 const runtime=plugin as unknown as {gap(task:Task,reason:string,operationScope:typeof scope,required:boolean,path:PlanItem['prerequisites'],persist:boolean,source:Observation,key:string,uniqueActionId:string):PlanItem;auditRemainingScopes(task:Task,round:Round,o:Observation,snapshot:ReturnType<ExplorerHost['explorationSnapshot']>,completed:Set<ActionCandidate>):Set<string>;recordOutcome(task:Task,attempt:ActionAttempt,ids:string[]):void;entryTargets(task:Task,action:ActionCandidate,o:Observation):PlanItem[]};
 const snapshot={revision:'fixture',actions:[b.a],operationCandidates:[b.a],availability:{sessionId:'session',observationId:b.o.id,actions:[{actionId:b.a.id,executable:false,blockers:[{code:'ACTION_BLOCKED',reason}]}]},obligations:{criticalGaps:[],regions:[b.a.localId],pageTraversal:false,classifications:[],operations:[],identities:[],discovery:[]}} as unknown as ReturnType<ExplorerHost['explorationSnapshot']>;
 const entry=(id:string)=>{const control={...structuredClone(b.o.controls[0]),localId:`entry-${id}`,instanceId:`entry-${id}`,identityId:`entry-${id}`,stableKey:`id:entry-${id}`,name:`Entry ${id}`,label:`Entry ${id}`};delete control.structuralItem;delete control.identityContext;b.o.controls.push(control);return {...b.a,id:`entry-action-${id}`,localId:control.localId,controlId:control.identityId,label:control.label};};
 return {a,b,old,newAttempt,attempts,host,task,round,item,store,entry,entryTargets:(action:ActionCandidate)=>runtime.entryTargets(task,action,b.o),gap:(path:PlanItem['prerequisites']=[])=>runtime.gap(task,reason,scope,true,path,true,b.o,key,b.a.id),audit:()=>runtime.auditRemainingScopes(task,round,b.o,snapshot,new Set()),complete:(ids:string[])=>runtime.recordOutcome(task,newAttempt,ids),close:()=>plugin.close()};
}

function recordedReceipt(f:ReturnType<typeof fixture>,partial=false){
 const item=f.item('recorded-B',partial?'A':'B'),ref={sessionId:'session',observationId:f.newAttempt.afterId!,attemptId:f.newAttempt.id};
 if(partial)item.evidence.push({sessionId:'session',observationId:'B'});else {item.status='succeeded';item.resolvedBy=ref;}
 item.evidence.push(ref);item.attempts.push({roundId:'round',outcome:'succeeded',evidence:ref});f.task.plan.push(item);return item;
}

it('a new blocked source cannot be appended to a directly succeeded gap with the same scheduling key',async()=>{
 const f=fixture();try{
  const before=structuredClone(f.old),next=f.gap();expect(next.id).not.toBe(f.old.id);expect(next.status).toBe('unresolved');
  expect(next.evidence).toContainEqual({sessionId:'session',observationId:'B'});expect(f.old).toEqual(before);
 }finally{await f.close();}
});

it('actual remaining-scope audit preserves blocked B as unfinished when SDK coverage of A is unavailable',async()=>{
 const f=fixture();try{
  const before=structuredClone(f.old);expect(f.audit().has('root')).toBe(true);
  const current=f.task.plan.filter(i=>i.id!=='root'&&i.id!==f.old.id);expect(current).toHaveLength(1);
  expect(current[0]).toMatchObject({required:true,dispatchScope:false,status:'unresolved',reason:'region_review_required'});
  expect(current[0].evidence).toContainEqual({sessionId:'session',observationId:'B'});expect(f.old).toEqual(before);
  expect(f.store.events(f.task.id).find(e=>e.type==='scope.audit')?.data).toMatchObject({pendingActions:[f.b.a.id]});
 }finally{await f.close();}
});

it('prefers an unfinished exact gap over an older succeeded row without changing either historical receipt',async()=>{
 const f=fixture();try{
  const before=structuredClone(f.old),pending=f.item('pending','A');f.task.plan.push(pending);
  expect(f.gap()).toBe(pending);expect(f.task.plan).toHaveLength(3);expect(pending.status).toBe('unresolved');
  expect(pending.evidence).toContainEqual({sessionId:'session',observationId:'B'});expect(f.old).toEqual(before);
 }finally{await f.close();}
});

it('recordOutcome leaves a derived closed source unchanged when a new matching source succeeds',async()=>{
 const f=fixture('operation_not_executed');try{
  const before=structuredClone(f.old),current=f.item('current-B','B');f.task.plan.push(current);f.complete([f.old.id,current.id]);
  expect(f.old).toEqual(before);expect(current.status).toBe('succeeded');expect(current.resolvedBy?.attemptId).toBe(f.newAttempt.id);
 }finally{await f.close();}
});

it('a spent scheduling hint prevents another dispatch without erasing the new unproved discovery source',async()=>{
 const f=fixture();try{
  const before=structuredClone(f.old);f.round.tried.push(browserOperationSchedulingKey(f.a.a,f.a.o));f.audit();
  expect(f.old).toEqual(before);
  expect(f.task.plan.some(item=>item.id!==f.old.id&&item.dispatchScope===false&&item.status!=='succeeded'
   &&item.evidence.some(ref=>!ref.attemptId&&ref.sessionId==='session'&&ref.observationId==='B'))).toBe(true);
  expect(f.round.tried).toEqual([browserOperationSchedulingKey(f.a.a,f.a.o)]);
 }finally{await f.close();}
});

it('does not treat a task-only success annotation as a real execution receipt',async()=>{
 const f=fixture();try{
  const fake=recordedReceipt(f),before=structuredClone(fake);f.attempts.splice(1,1);f.audit();
  expect(fake).toEqual(before);expect(f.task.plan.some(i=>i.id!==fake.id&&i.status==='unresolved'&&i.evidence.some(e=>e.observationId==='B'&&!e.attemptId))).toBe(true);
  expect(f.store.events(f.task.id).find(e=>e.type==='scope.audit')?.data).toMatchObject({pendingActions:[f.b.a.id]});
 }finally{await f.close();}
});

it.each(['unknown','executing'] as const)('retains the current source when the real SDK receipt is %s despite a task success annotation',async status=>{
 const f=fixture();try{
  const annotated=recordedReceipt(f);f.newAttempt.status=status;f.audit();
  expect(f.task.plan.some(i=>i.id!==annotated.id&&i.status==='unresolved'&&i.evidence.some(e=>e.observationId==='B'&&!e.attemptId))).toBe(true);
  expect(f.newAttempt.status).toBe(status);expect(f.store.events(f.task.id).find(e=>e.type==='scope.audit')?.data).toMatchObject({pendingActions:[f.b.a.id]});
 }finally{await f.close();}
});

it('recognizes a real exact-source receipt even when SDK cross-observation conditions are unavailable',async()=>{
 const f=fixture();try{
  recordedReceipt(f);const before=structuredClone(f.task.plan),reads=vi.spyOn(f.host,'list');f.audit();
  expect(f.task.plan).toEqual(before);expect(reads).toHaveBeenCalledTimes(1);expect(f.host.operationCorrespondences).not.toHaveBeenCalled();
  expect(f.store.events(f.task.id).find(e=>e.type==='scope.audit')?.data).toMatchObject({pendingActions:[]});
 }finally{await f.close();}
});

it('recognizes an aggregate item receipt for B without completing or dropping its retained A source',async()=>{
 const f=fixture();try{
  const partial=recordedReceipt(f,true),before=structuredClone(partial),count=f.task.plan.length;f.audit();
  expect(partial).toEqual(before);expect(partial.status).toBe('unresolved');expect(f.task.plan).toHaveLength(count);
  expect(partial.evidence).toContainEqual({sessionId:'session',observationId:'A'});
  expect(f.store.events(f.task.id).find(e=>e.type==='scope.audit')?.data).toMatchObject({pendingActions:[]});
 }finally{await f.close();}
});

it.each(['foreign-session','wrong-before','wrong-action','wrong-local-id','wrong-kind','wrong-value','missing-after'] as const)('rejects a %s receipt as exact-source execution',async change=>{
 const f=fixture();try{
  const annotated=recordedReceipt(f);f.newAttempt.action=structuredClone(f.newAttempt.action);
  if(change==='foreign-session')f.newAttempt.sessionId='foreign';if(change==='wrong-before')f.newAttempt.beforeId='A';
  if(change==='wrong-action')f.newAttempt.action.id='different-action';if(change==='wrong-local-id')f.newAttempt.action.localId='different-control';
  if(change==='wrong-kind')f.newAttempt.action.kind='hover';if(change==='wrong-value')f.newAttempt.action.value='different-value';
  if(change==='missing-after')delete f.newAttempt.afterId;f.audit();
  expect(f.task.plan.some(i=>i.id!==annotated.id&&i.status==='unresolved'&&i.evidence.some(e=>e.observationId==='B'&&!e.attemptId))).toBe(true);
 }finally{await f.close();}
});

it('uses the supplied source for audit and availability events without another observation read',async()=>{
 const f=fixture();try{
  const pending=f.item('pending','A');pending.reason='operation_not_executed';f.task.plan=[f.task.plan[0],pending];
  const reads=vi.spyOn(f.host,'observation');f.audit();
  expect(reads).not.toHaveBeenCalled();const events=f.store.events(f.task.id).filter(e=>['scope.audit','scope.availability_updated'].includes(e.type));
  expect(events.map(e=>e.type)).toEqual(['scope.availability_updated','scope.audit']);expect(events.every(e=>e.observationId==='B')).toBe(true);
  expect(pending.evidence).toContainEqual({sessionId:'session',observationId:'B'});
 }finally{await f.close();}
});

it('keeps a different observed prerequisite route selectable instead of folding its blocker into the old entry',async()=>{
 const f=fixture();try{
  const a=f.entry('A'),b=f.entry('B'),pathA=scopeFor(a,f.b.o),pathB=scopeFor(b,f.b.o),pending=f.item('via-A','A');
  pending.reason='observed_in_scope';pending.prerequisites=[pathA];const unknown=f.item('unknown','A');unknown.reason='unknown_action_outcome';
  unknown.attempts=[{roundId:'round',outcome:'unknown',evidence:{sessionId:'session',observationId:'A',attemptId:'unknown-attempt'}}];
  f.task.plan=[f.task.plan[0],pending,unknown];const before=structuredClone(pending),unknownBefore=structuredClone(unknown);
  const newlyBlocked=f.gap([pathB]);expect(newlyBlocked.id).not.toBe(pending.id);expect(newlyBlocked.prerequisites).toEqual([pathB]);
  expect(f.entryTargets(a).map(item=>item.id)).toEqual([pending.id]);expect(f.entryTargets(b).map(item=>item.id)).toEqual([newlyBlocked.id]);
  expect(pending).toEqual(before);expect(unknown).toEqual(unknownBefore);expect(newlyBlocked.status).toBe('unresolved');
 }finally{await f.close();}
});

it('can fold a changed availability reason when the complete prerequisite path is unchanged',async()=>{
 const f=fixture();try{
  const entry=f.entry('A'),path=scopeFor(entry,f.b.o),pending=f.item('via-A','A');pending.reason='observed_in_scope';pending.prerequisites=[path];
  f.task.plan=[f.task.plan[0],pending];expect(f.gap([path])).toBe(pending);expect(f.task.plan).toHaveLength(2);
  expect(f.entryTargets(entry).map(item=>item.id)).toEqual([pending.id]);expect(pending.prerequisites).toEqual([path]);
  expect(pending.evidence).toEqual([{sessionId:'session',observationId:'A'},{sessionId:'session',observationId:'B'}]);
  expect(pending.status).toBe('unresolved');expect(pending.attempts).toEqual([]);
 }finally{await f.close();}
});
