import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {hash} from '@interaction/core';
import type {ActionAttempt,ActionCandidate,Observation} from '@interaction/browser';
import {ExplorerPlugin} from '../packages/explorer-plugin/src/runtime.js';
import {browserOperationKey,browserOperationSchedulingKey} from '../packages/adapter-playwright/src/exploration.js';
import {createOperationSchedulingNormalizer,normalizeOperationScheduling} from '../packages/explorer-plugin/src/operation-scheduling.js';
import {boundOperationCondition} from '../packages/explorer-plugin/src/plan-state.js';
import {scopeFor} from '../packages/explorer-plugin/src/policy.js';
import type {ExplorerHost,PlanItem,Task} from '../packages/explorer-plugin/src/types.js';

function frame(id:string){
 const controls=['Run A','Run B'].map((name,index)=>({localId:`${id}:${index}`,instanceId:`${id}:${index}`,identityId:`identity:${index}`,tag:'button',role:'button',name,label:name,region:'document',visible:true,enabled:true,selected:[],constraints:{type:'button'},actions:['click'],actionable:{hitTarget:true,unknown:[]},
  structuralItem:{ownerInstanceId:`${id}:owner`,recordKey:JSON.stringify(['record',index]),template:'row',slot:'run'},
  stableKey:`structural-item:${JSON.stringify([`${id}:owner`,JSON.stringify(['record',index]),'run'])}`,
  identityContext:{scope:'orders',binding:`record:${index}`,evidence:['fixture']}}));
 const o={id,sessionId:'session',instanceScope:id,url:'https://fixture.invalid/',ruleVersion:'observable-v7',context:{},stable:true,gaps:[],controls,regions:[{key:'document',label:'Page',role:'document'}],components:[],boundaries:[]} as unknown as Observation;
 const actions=controls.map((c,index)=>({id:`action:${id}:${index}`,sessionId:'session',observationId:id,stateId:`state:${id}`,localId:c.localId,controlId:c.identityId,kind:'click',label:c.name,risk:'interface',source:'fixture',sampleValidity:'known',excluded:false,replayable:true,basis:{status:'supported',evidence:[]},preconditions:{visible:true,enabled:true,identityResolved:true,context:o.context}} as ActionCandidate));
 return {o,actions};
}
function row(o:Observation,a:ActionCandidate,id:string):PlanItem{return {id,title:a.label,scope:scopeFor(a,o),prerequisites:[],completion:'Execute recorded operation',required:true,dispatchScope:false,status:'pending',reason:'observed_in_scope',operationConditionKey:browserOperationKey(a,o),operationConditionPolicy:'browser-operation-key-v2',evidence:[{sessionId:o.sessionId,observationId:o.id}],attempts:[]};}
function fixture(ids=['old','new']){
 const frames=new Map(ids.map(id=>[id,frame(id)])),iterations=new Map<string,number>(),attempts:ActionAttempt[]=[];
 for(const [id,f] of frames)Object.defineProperty(f.actions,Symbol.iterator,{value:function*(this:ActionCandidate[]){iterations.set(id,(iterations.get(id)||0)+1);yield* Array.prototype.values.call(this);}});
 const host={observation:vi.fn((_sid:string,id:string)=>{const f=frames.get(id);if(!f)throw Error('missing');return f.o;}),actions:vi.fn((_sid:string,id:string)=>frames.get(id)!.actions),list:vi.fn(()=>attempts)} as unknown as Pick<ExplorerHost,'observation'|'actions'|'list'>;
 const old=frames.get(ids[0])!,items=old.actions.map((a,index)=>row(old.o,a,`item:${index}`)),task={plan:items};
 iterations.clear();return {frames,iterations,attempts,host,items,task};
}

it('preserves wrapper results across source appends while building each shared source index once',()=>{
 const old=fixture(),shared=fixture(),normalize=createOperationSchedulingNormalizer(shared.host);
 const first=normalize(shared.task);expect(first).toEqual(normalizeOperationScheduling(old.task,old.host));
 expect(first).toHaveLength(2);
 for(let i=0;i<2;i++){
  for(const f of [old,shared])f.items[i].evidence.push({sessionId:'session',observationId:'new'});
  expect(normalize(shared.task,[shared.items[i]])).toEqual(normalizeOperationScheduling(old.task,old.host,[old.items[i]]));
 }
 expect(shared.task).toEqual(old.task);expect(shared.iterations.get('new')).toBe(1);expect(old.iterations.get('new')).toBe(2);
 expect(first[0].normalization!.sources).toHaveLength(1);
 const empty=normalize(shared.task),next=normalize(shared.task);expect(empty).toEqual([]);expect(next).toEqual([]);expect(next).not.toBe(empty);
});

it.each(['scope','removed-source','unknown','changed-appended-context'] as const)('rechecks mutable item proof on every factory call: %s',change=>{
 const f=fixture(),normalize=createOperationSchedulingNormalizer(f.host),item=f.items[0];normalize(f.task,[item]);
 if(change==='scope')item.scope.label='Different';
 if(change==='removed-source')item.evidence=[];
 if(change==='unknown')item.attempts.push({roundId:'round',outcome:'unknown',evidence:{sessionId:'session',observationId:'old',attemptId:'uncertain'}});
 if(change==='changed-appended-context'){f.frames.get('new')!.o.context={account:{value:null,status:'unknown',source:'fixture'}};item.evidence.push({sessionId:'session',observationId:'new'});}
 const changed=normalize(f.task,[item]);expect(boundOperationCondition(item)).toBe(item.operationConditionKey);
 if(change==='unknown')expect(changed).toEqual([]);else expect(changed).toEqual([{itemId:item.id,reason:'source_proof_unavailable'}]);
});

it('a fresh factory observes a revised action set at the same observation ID',()=>{
 const f=fixture(),raw=structuredClone(f.items[0]);expect(createOperationSchedulingNormalizer(f.host)(f.task,[f.items[0]])).toHaveLength(1);
 const old=f.frames.get('old')!;old.actions.push({...old.actions[0],id:'ambiguous-current'});
 const task={plan:[raw]};expect(createOperationSchedulingNormalizer(f.host)(task)).toEqual([]);expect(raw.operationSchedulingNormalization).toBeUndefined();
 expect(f.host.actions).toHaveBeenCalledTimes(2);
});

it('shares an attempt snapshot only inside a factory and rereads unknown receipts in the next pass',()=>{
 const f=fixture(),old=f.frames.get('old')!,ref={sessionId:'session',observationId:'new',attemptId:'attempt'};
 f.attempts.push({id:'attempt',sessionId:'session',beforeId:'old',afterId:'new',action:old.actions[0],status:'succeeded'} as ActionAttempt);
 const first=row(old.o,old.actions[0],'first');first.evidence=[ref];const second={...structuredClone(first),id:'second'},raw=structuredClone(first),task={plan:[first,second]};
 const normalize=createOperationSchedulingNormalizer(f.host);expect(normalize(task,[first])).toHaveLength(1);expect(normalize(task,[second])).toHaveLength(1);expect(f.host.list).toHaveBeenCalledTimes(1);
 f.attempts[0]={...f.attempts[0],status:'unknown'};
 expect(createOperationSchedulingNormalizer(f.host)({plan:[raw]})).toEqual([]);expect(raw.operationSchedulingNormalization).toBeUndefined();expect(f.host.list).toHaveBeenCalledTimes(2);
});

it('does not conflate distinct action objects with one ID and different input values',()=>{
 const f=fixture(),old=f.frames.get('old')!,a={...old.actions[0],kind:'fill',value:'A'},b={...old.actions[0],kind:'fill',value:'B'};
 old.actions.splice(0,old.actions.length,a,b);const task={plan:[row(old.o,a,'A'),row(old.o,b,'B')]};
 expect(createOperationSchedulingNormalizer(f.host)(task)).toHaveLength(2);
 expect(boundOperationCondition(task.plan[0])).toBe(browserOperationSchedulingKey(a,old.o));expect(boundOperationCondition(task.plan[1])).toBe(browserOperationSchedulingKey(b,old.o));
 expect(boundOperationCondition(task.plan[0])).not.toBe(boundOperationCondition(task.plan[1]));
});

it('bounds source indexes to eight records and rebuilds an evicted source',()=>{
 const ids=Array.from({length:9},(_,i)=>`source:${i}`),f=fixture(ids),normalize=createOperationSchedulingNormalizer(f.host),task={plan:[] as PlanItem[]};
 for(const id of ids){const source=f.frames.get(id)!,item=row(source.o,source.actions[0],id);expect(normalize(task,[item])).toHaveLength(1);}
 const first=f.frames.get(ids[0])!,again=row(first.o,first.actions[0],'again');expect(normalize(task,[again])).toHaveLength(1);
 expect(f.host.observation).toHaveBeenCalledTimes(10);expect(f.iterations.get(ids[0])).toBe(2);expect(f.iterations.get(ids[8])).toBe(1);
});

it('does not manufacture an alias after a failed read and retries in a fresh pass',()=>{
 const f=fixture(),old=f.frames.get('old')!;f.frames.delete('old');const normalize=createOperationSchedulingNormalizer(f.host);
 expect(normalize(f.task)).toEqual([]);f.frames.set('old',old);expect(normalize(f.task)).toEqual([]);
 expect(createOperationSchedulingNormalizer(f.host)(f.task)).toHaveLength(2);expect(f.host.observation).toHaveBeenCalledTimes(2);
});

it.each(['unchanged','missing','unknown-attempt','ambiguous','different-key'] as const)('stops a proved no-op encoding without altering pending work or later debt: %s',tail=>{
 const f=fixture();
 for(const frame of f.frames.values())for(const [index,control] of frame.o.controls.entries()){
  delete control.structuralItem;control.stableKey=`button:${index}`;
 }
 const first=f.frames.get('old')!,later=f.frames.get('new')!,item=row(first.o,first.actions[0],'unchanged');
 item.evidence.push({sessionId:'session',observationId:'new',...(tail==='unknown-attempt'?{attemptId:'unknown'}:{})});
 if(tail==='missing')f.frames.delete('new');
 if(tail==='unknown-attempt')f.attempts.push({id:'unknown',sessionId:'session',beforeId:'new',afterId:'new',status:'unknown',action:later.actions[0]} as ActionAttempt);
 if(tail==='ambiguous')later.actions.push({...later.actions[0],id:'duplicate'});
 if(tail==='different-key')later.o.context={mode:{value:'other',status:'known',source:'fixture'}};
 const task={plan:[item]},before=structuredClone(task),debt=structuredClone(f.attempts);
 expect(browserOperationSchedulingKey(first.actions[0],first.o)).toBe(item.operationConditionKey);
 expect(normalizeOperationScheduling(task,f.host)).toEqual([]);expect(task).toEqual(before);
 expect(boundOperationCondition(item)).toBe(item.operationConditionKey);expect(item.operationSchedulingNormalization).toBeUndefined();
 expect(f.attempts).toEqual(debt);expect(f.host.observation).toHaveBeenCalledTimes(1);expect(f.host.actions).toHaveBeenCalledTimes(1);
 expect(f.host.list).not.toHaveBeenCalled();
});

it('still removes an invalid old audit when an unchanged source makes any replacement impossible',()=>{
 const f=fixture();normalizeOperationScheduling(f.task,f.host);const oldAudit=structuredClone(f.items[0].operationSchedulingNormalization!);
 const source=f.frames.get('old')!;delete source.o.controls[0].structuralItem;source.o.controls[0].stableKey='button:0';
 const item=row(source.o,source.actions[0],'changed');item.operationSchedulingNormalization=oldAudit;
 item.evidence.push({sessionId:'session',observationId:'missing'});const task={plan:[item]},before=structuredClone(item);delete before.operationSchedulingNormalization;
 vi.mocked(f.host.observation).mockClear();
 expect(normalizeOperationScheduling(task,f.host)).toEqual([{itemId:'changed',reason:'source_proof_unavailable'}]);
 expect(item).toEqual(before);expect(f.host.observation).toHaveBeenCalledTimes(1);
});

it('runtime audit shares projection work while retaining per-item event ordering and later call freshness',async()=>{
 const f=fixture(),current=f.frames.get('new')!,events:{type:string;data:any}[]=[],host={...f.host,events:new EventEmitter()} as unknown as ExplorerHost;
 const sink={save:vi.fn(),event:(event:any)=>{events.push(event);return event;},close:()=>{}};
 const plugin=new ExplorerPlugin(host,sink as never),root={...structuredClone(f.items[0]),id:'root',scope:{url:current.o.url},operationConditionKey:undefined,operationConditionPolicy:undefined,dispatchScope:true,reason:'user_goal'};
 const round={id:'round',number:1,sessionId:'session',startedAt:'2026-01-01T00:00:00.000Z',status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};
 const task={id:'task',plan:[root,...f.items],rounds:[round],sessionOptions:{},coverageMode:'all',routeRetries:{routes:{retained:{unknown:true}}}} as unknown as Task;
 const snapshot={actions:current.actions,operationCandidates:current.actions,availability:{observationId:'new',actions:current.actions.map(a=>({actionId:a.id,executable:false,blockers:[{code:'ACTION_BLOCKED',reason:'region_review_required',evidence:[]}]}))},revision:'fixture',obligations:{criticalGaps:[],regions:[],classifications:[],operations:[],identities:[],pageTraversal:false,discovery:false}};
 try{
  (plugin as any).normalizeScheduling(task);events.length=0;f.iterations.clear();const rounds=structuredClone(task.rounds),routes=structuredClone(task.routeRetries);
  (plugin as any).auditRemainingScopes(task,round,current.o,snapshot,new Set());
  expect(f.iterations.get('new')).toBe(3); // audit scope count + snapshot matching + one normalizer index
  expect(events.map(e=>e.type)).toEqual(['scope.availability_updated','operation.scheduling_normalized','scope.availability_updated','operation.scheduling_normalized','scope.audit']);
  expect(task.plan).toHaveLength(3);expect(f.items.every(i=>i.evidence.length===2&&i.status==='pending'&&i.attempts.length===0)).toBe(true);expect(task.rounds).toEqual(rounds);expect(task.routeRetries).toEqual(routes);
  const previous=structuredClone(task),reads=vi.mocked(f.host.actions).mock.calls.length;events.length=0;
  (plugin as any).auditRemainingScopes(task,round,current.o,snapshot,new Set());
  expect(task).toEqual(previous);expect(events.map(e=>e.type)).toEqual(['scope.audit']);expect(f.host.actions).toHaveBeenCalledTimes(reads);
 }finally{await plugin.close();}
});

it('runtime outcome preserves wrapper results and debt while sharing receipt and source projections',async()=>{
 const run=async(shared:boolean)=>{
  const f=fixture(),old=f.frames.get('old')!,events:any[]=[],first=f.items[0],second={...structuredClone(first),id:'peer',reason:'operation_not_executed'};
  const attempt={id:'receipt',sessionId:'session',requestId:'request',beforeId:'old',afterId:'new',action:old.actions[0],status:'succeeded',purpose:'exploration',startedAt:'2026-01-01T00:00:00.000Z'} as ActionAttempt;
  f.attempts.push(attempt);
  const freeze=(value:unknown):void=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}};
  const rawBefore=JSON.stringify([...f.frames.values()]);for(const value of f.frames.values())freeze(value);freeze(attempt);
  const host={...f.host,events:new EventEmitter(),observation:(sid:string,id?:string)=>f.host.observation(sid,id||'new'),
   operationReceiptCondition:()=>({actualSuccess:true,conditionVerified:true,status:'portable',policy:'fixture-policy',conditionKey:'fixture-key',reason:'fixture-retained-condition',source:{sessionId:attempt.sessionId,attemptId:attempt.id,beforeId:attempt.beforeId,afterId:attempt.afterId,actionId:attempt.action.id,actionKey:hash(attempt.action)},evidence:[],identityAuthorized:false,replayAuthorized:false,currentExecution:false,arrivalVerified:false}),
   operationCoverageCandidates:vi.fn((_sid:string,id:string)=>f.frames.get(id)!.actions),operationCorrespondences:vi.fn(()=>{throw Error('No cross-source proof');}),session:()=>({actionCount:1})} as unknown as ExplorerHost;
  const plugin=new ExplorerPlugin(host,{save:()=>{},event:(event:any)=>{events.push(event);return event;},close:()=>{}} as never),runtime=plugin as any;
  // Exercise the old per-call wrapper through the same runtime entry point.
  if(!shared){const original=runtime.normalizeScheduling;runtime.normalizeScheduling=function(task:Task,items:PlanItem[],reader:ExplorerHost,observationId:string){return original.call(this,task,items,reader,observationId);};}
  const round={id:'round',number:1,sessionId:'session',startedAt:'2026-01-01T00:00:00.000Z',status:'paused',actions:0,stack:[],entryPath:[],reentries:['old-reentry'],tried:['old-attempt-key'],reviewed:[],noProgress:0};
  const task={id:'task',plan:[first,second],rounds:[round],usage:{actions:0,durationMs:0},routeRetries:{routes:{retained:{unknown:true,attempts:[{attemptKey:'spent'}]}}}} as unknown as Task;
  const debt=structuredClone(task.routeRetries);
  try{
   runtime.recordOutcome(task,attempt,[first.id,second.id]);
   expect(task.plan.map(item=>item.status)).toEqual(['succeeded','succeeded']);
   expect(task.plan.every(item=>item.attempts.length===1&&item.resolvedBy?.attemptId===attempt.id)).toBe(true);
   expect(host.operationCoverageCandidates).toHaveBeenCalledTimes(1);expect(host.operationCorrespondences).not.toHaveBeenCalled();
   expect(task.routeRetries).toEqual(debt);expect(round.tried).toEqual(['old-attempt-key']);expect(round.reentries).toEqual(['old-reentry']);
   expect(JSON.stringify([...f.frames.values()])).toBe(rawBefore);expect(f.attempts).toEqual([attempt]);
   expect(events.map(event=>event.type)).toEqual(['operation.scheduling_normalized','operation.scheduling_normalized','operation.scheduling_normalized','action.verified']);
   return {task,events,iterations:f.iterations.get('old'),lists:vi.mocked(f.host.list).mock.calls.length};
  }finally{await plugin.close();}
 };
 const shared=await run(true),wrapped=await run(false);
 expect(shared.task).toEqual(wrapped.task);expect(shared.events).toEqual(wrapped.events);
 expect(shared.iterations).toBe(1);expect(wrapped.iterations).toBe(3);expect(shared.lists).toBe(1);expect(wrapped.lists).toBe(2);
});
