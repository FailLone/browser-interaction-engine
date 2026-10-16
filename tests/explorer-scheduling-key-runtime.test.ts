import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Round,type Task} from '@interaction/explorer-plugin';
import {type ActionCandidate,type Observation,browserOperationKey,browserOperationSchedulingKey} from '@interaction/browser';
import {normalizeOperationScheduling,scopeFor} from '../packages/explorer-plugin/src/policy.js';

function fixture(){
 const frame=(id:string)=>{
  const control={localId:`${id}:button`,instanceId:`${id}:button`,identityId:'identity',name:'Run',label:'Run',tag:'button',role:'button',region:'document',visible:true,enabled:true,selected:[],constraints:{type:'button'},actions:['click'],
   structuralItem:{ownerInstanceId:`${id}:owner`,recordKey:'record:123',template:'row',slot:'button'},stableKey:`structural-item:${JSON.stringify([`${id}:owner`,'record:123','button'])}`,identityContext:{scope:'orders',binding:'record:123',evidence:['fixture']}};
  const o={id,sessionId:'session',instanceScope:id,url:'https://fixture.invalid/',context:{},stable:true,gaps:[],controls:[control],regions:[],components:[],boundaries:[]} as unknown as Observation;
  const action={id:`action-${id}`,sessionId:o.sessionId,observationId:id,localId:control.localId,controlId:'identity',kind:'click',label:'Run',replayable:true,risk:'interface',preconditions:{visible:true,enabled:true,context:{}}} as ActionCandidate;
  return {o,action};
 };
 const a=frame('A'),b=frame('B'),frames=[a,b];
 const host={events:new EventEmitter(),observation:vi.fn((sid:string,id?:string)=>frames.find(f=>f.o.id===id)?.o||b.o),actions:vi.fn((sid:string,id?:string)=>[frames.find(f=>f.o.id===id)?.action||b.action]),list:()=>[]} as unknown as ExplorerHost;
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:')),task=plugin.create({url:a.o.url,coverageMode:'all'});
 const pending:PlanItem={id:'pending',title:'Run',scope:scopeFor(a.action,a.o),prerequisites:[],completion:'Execute',required:true,dispatchScope:false,status:'pending',reason:'observed_in_scope',evidence:[{sessionId:'session',observationId:a.o.id}],attempts:[],operationConditionKey:browserOperationKey(a.action,a.o),operationConditionPolicy:'browser-operation-key-v2'};
 const root:PlanItem={...structuredClone(pending),id:'root',scope:{url:a.o.url},dispatchScope:true,operationConditionKey:undefined,operationConditionPolicy:undefined,evidence:[]};task.plan=[root,pending];
 const round:Round={id:'round',number:1,sessionId:'session',startedAt:'2026-10-17T00:00:00.000Z',status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[pending.operationConditionKey!],reviewed:[],noProgress:0};task.rounds=[round];
 const runtime=plugin as unknown as {wasTried(task:Task,round:Round,action:ActionCandidate,o:Observation):boolean;gap(task:Task,reason:string,scope:PlanItem['scope'],required:boolean,path:[],persist:boolean,source:Observation,key:string,actionId:string):PlanItem};
 return {a,b,host,plugin,task,pending,round,runtime};
}
it('keeps the original tried v2 encoding consumed after DOM-owner normalization and a stored task restart',async()=>{
 const f=fixture();try{
  const tried=[...f.round.tried];normalizeOperationScheduling(f.task,f.host);f.plugin.store.save(f.task);
  const restored=f.plugin.store.task(f.task.id);
  expect(f.runtime.wasTried(restored,restored.rounds[0],f.b.action,f.b.o)).toBe(true);
  expect(restored.rounds[0].tried).toEqual(tried);expect(restored.plan[1].status).toBe('pending');expect(restored.plan[1].attempts).toEqual([]);
  expect(f.host.actions).toHaveBeenCalledTimes(1);
 }finally{await f.plugin.close();}
});
it('does not consume an unrelated changed semantic binding through an old alias',async()=>{
 const f=fixture();try{
  normalizeOperationScheduling(f.task,f.host);f.b.o.controls[0].identityContext!.binding='record:456';
  expect(f.runtime.wasTried(f.task,f.round,f.b.action,f.b.o)).toBe(false);expect(f.round.tried).toHaveLength(1);
 }finally{await f.plugin.close();}
});
it('appends a new availability source without losing its verified scheduling normalization or original condition',async()=>{
 const f=fixture();try{
  normalizeOperationScheduling(f.task,f.host);const original=f.pending.operationConditionKey;
  const item=f.runtime.gap(f.task,'region_review_required',scopeFor(f.b.action,f.b.o),true,[],true,f.b.o,browserOperationSchedulingKey(f.b.action,f.b.o),f.b.action.id);
  expect(item.id).toBe(f.pending.id);expect(f.task.plan).toHaveLength(2);expect(item.operationConditionKey).toBe(original);
  expect(item.operationSchedulingNormalization!.sources.map(source=>JSON.parse(source)[1])).toEqual(['A','B']);
  expect(item.operationAvailability?.reason).toBe('region_review_required');expect(item.status).toBe('pending');expect(item.attempts).toEqual([]);
  expect(f.runtime.wasTried(f.task,f.round,f.b.action,f.b.o)).toBe(true);
  const persisted=f.plugin.store.task(f.task.id);expect(persisted.plan[1]).toEqual(item);
 }finally{await f.plugin.close();}
});
