import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {type ActionAttempt,type ActionCandidate,type Observation,browserTargetConditions} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Task} from '@interaction/explorer-plugin';
import {keyFor,scopeFor} from '../packages/explorer-plugin/src/policy.js';

/** The same scheduling key can represent two unverified mode sources. A current
 * successful receipt is exact evidence for B; the SDK declines A/B equivalence. */
function fixture(){
 const url='https://fixture.invalid/source';
 const observed=(id:string,checked:boolean)=>({id,sessionId:'session',instanceScope:`document-${id}`,url,ruleVersion:'observable-v7',context:{},stable:true,gaps:[],regions:[],boundaries:[],overlays:[],stateId:`state-${id}`,canonical:id,
  controls:[{localId:`target-${id}`,instanceId:`target-${id}`,identityId:'shared-identity',stableKey:'id:shared',tag:'a',role:'link',name:'Open',label:'Open',visible:true,enabled:true,region:'document',form:'',constraints:{type:'a',required:false,valid:true},selected:[],reviewBinding:{parentInstanceId:`parent-${id}`,attributes:{href:'/next'}},actionBasis:{click:{status:'supported',evidence:[{source:'html',rule:'hyperlink/v1',facts:{tag:'a',href:'/next'}}]}}},
   {localId:`mode-${id}`,instanceId:`mode-${id}`,hypothesisId:`unverified-mode-${id}`,tag:'input',role:'checkbox',name:'Mode',label:'Mode',checked,visible:true,enabled:true,region:'document',constraints:{type:'checkbox',required:false,valid:true},selected:[]}]}) as unknown as Observation;
 const a=observed('A',false),b=observed('B',true),after={...structuredClone(b),id:'after',url:'https://fixture.invalid/next',controls:[],canonical:'after'};
 const action=(o:Observation):ActionCandidate=>({id:`action-${o.id}`,sessionId:o.sessionId,observationId:o.id,localId:o.controls[0].localId,controlId:'shared-identity',kind:'click',label:'Open',risk:'interface',replayable:true,basis:o.controls[0].actionBasis!.click,excluded:false,preconditions:{visible:true,enabled:true,identityResolved:true,context:o.context}} as ActionCandidate);
 const actionA=action(a),actionB=action(b),observations=new Map([a,b,after].map(o=>[o.id,o])),actions=new Map([[a.id,[actionA]],[b.id,[actionB]],[after.id,[] as ActionCandidate[]]]);
 expect(scopeFor(actionA,a)).toEqual(scopeFor(actionB,b));expect(keyFor(actionA,a)).toBe(keyFor(actionB,b));expect(browserTargetConditions(actionA,a)).toBeUndefined();expect(browserTargetConditions(actionB,b)).toBeUndefined();
 const attempt={id:'executed-B',sessionId:'session',beforeId:b.id,afterId:after.id,action:actionB,status:'succeeded',startedAt:'2026-10-17T00:00:00.000Z',finishedAt:'2026-10-17T00:00:00.010Z'} as ActionAttempt;
 const attempts=[attempt];let equivalence=false;
 const host={events:new EventEmitter(),session:()=>({id:'session',options:{},actionCount:1}),observation:(_sid:string,id?:string)=>{const o=observations.get(id||after.id);if(!o)throw Error('Missing evidence');return o;},
  actions:(_sid:string,id?:string)=>actions.get(id||after.id)||[],operationCoverageCandidates:(_sid:string,id?:string)=>actions.get(id||after.id)||[],
  list:(_sid:string,kind:string)=>kind==='attempt'?attempts:[],
  operationCorrespondences:vi.fn((sid:string,input:{observationId:string;requests:{actionId:string;source:{sessionId:string;attemptId:string}}[]})=>({sessionId:sid,observationId:input.observationId,results:input.requests.map(request=>({equivalent:equivalence,reason:equivalence?'equivalent_operation_conditions':'operation_conditions_unavailable',source:request.source,target:{sessionId:sid,observationId:input.observationId,actionId:request.actionId},identityAuthorized:false,replayAuthorized:false,currentExecution:false,evidence:[],invalidatedBy:[]}))}))} as unknown as ExplorerHost;
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:')),task=plugin.create({url,coverageMode:'all'});
 task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:'2026-10-17T00:00:00.000Z',status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
 const item=(id:string,sourceIds:string[]):PlanItem=>({id,title:'Open',scope:scopeFor(actionB,b),prerequisites:[],completion:'Execute each retained source',status:'unresolved',required:true,dispatchScope:false,reason:'operation_not_executed',operationConditionKey:keyFor(actionB,b),operationConditionPolicy:'browser-operation-key-v2',evidence:sourceIds.map(observationId=>({sessionId:'session',observationId})),attempts:[]});
 const runtime=plugin as unknown as {recordOutcome(task:Task,attempt:ActionAttempt,ids:string[]):void};
 return {a,b,after,actionA,actionB,actions,attempt,attempts,host,plugin,task,item,complete:(items:PlanItem[])=>{task.plan=items;runtime.recordOutcome(task,attempt,items.map(i=>i.id));},setEquivalent:()=>{equivalence=true;},close:()=>plugin.close()};
}

it('a B success does not complete an older A discovery merely because its scope and unverified scheduling key match',async()=>{
 const f=fixture();try{
  const old=f.item('old-A',['A']),current=f.item('current-B',['B']);f.complete([old,current]);
  expect(old.status).not.toBe('succeeded');expect(old.coverageResolvedBy).toBeUndefined();
  expect(current.status).toBe('succeeded');expect(current.resolvedBy?.attemptId).toBe(f.attempt.id);
  expect(old.evidence).toContainEqual({sessionId:'session',observationId:'A'});
 }finally{await f.close();}
});

it('an aggregated A/B obligation retains the unverified A source after an exact B receipt',async()=>{
 const f=fixture();try{
  const item=f.item('both',['A','B']);f.complete([item]);
  expect(item.status).not.toBe('succeeded');expect(item.attempts.some(a=>a.evidence?.attemptId===f.attempt.id)).toBe(true);
  expect(item.evidence.filter(e=>!e.attemptId)).toEqual([{sessionId:'session',observationId:'A'},{sessionId:'session',observationId:'B'}]);
 }finally{await f.close();}
});

it('an exact current receipt completes its own discovery even when the after observation has no remaining target',async()=>{
 const f=fixture();try{
  expect(f.actions.get(f.after.id)).toEqual([]);const item=f.item('current',['B']);f.complete([item]);
  expect(item.status).toBe('succeeded');expect(item.resolvedBy?.attemptId).toBe(f.attempt.id);
 }finally{await f.close();}
});

it('retains distinct historical targets that share a name and identity when the SDK cannot prove equivalence',async()=>{
 const f=fixture();try{
  const other={...f.actionA,id:'second-A',localId:'second-target-A'};f.a.controls.push({...f.a.controls[0],localId:'second-target-A',instanceId:'second-target-A'});f.actions.get('A')!.push(other);
  expect(scopeFor(other,f.a)).toEqual(scopeFor(f.actionA,f.a));const item=f.item('historical-shared',['A','B']);f.complete([item]);
  expect(item.status).not.toBe('succeeded');expect(item.coverageResolvedBy).toBeUndefined();
 }finally{await f.close();}
});

it.each(['unknown','executing'] as const)('does not erase a prior %s attempt when a later matching action succeeds',async status=>{
 const f=fixture();try{
  const prior={...f.attempt,id:'prior-A',beforeId:'A',afterId:undefined,action:f.actionA,status} as ActionAttempt;f.attempts.unshift(prior);
  const item=f.item('uncertain-prior',['B']);item.evidence.push({sessionId:'session',observationId:'A',attemptId:prior.id});item.attempts.push({roundId:'round',outcome:status,evidence:{sessionId:'session',observationId:'A',attemptId:prior.id}});
  const previous=structuredClone(item.attempts[0]);f.complete([item]);
  expect(item.status).not.toBe('succeeded');expect(item.attempts[0]).toEqual(previous);expect(prior.status).toBe(status);
 }finally{await f.close();}
});

it.each(['unknown','executing'] as const)('keeps an attempt-ledger-only %s blocker through subsequent coverage reconciliation',async status=>{
 const f=fixture();try{
  const prior={...f.attempt,id:'prior-A',beforeId:'A',afterId:undefined,action:f.actionA,status} as ActionAttempt;f.attempts.unshift(prior);
  const item=f.item('attempt-ledger-only',['B']),peer=f.item('current-B',['B']);
  item.attempts.push({roundId:'round',outcome:status,evidence:{sessionId:'session',observationId:'A',attemptId:prior.id}});
  f.setEquivalent();f.complete([item,peer]);
  expect(peer.status).toBe('succeeded');expect(item.status).not.toBe('succeeded');expect(item.coverageResolvedBy).toBeUndefined();
  expect(item.attempts[0].evidence?.attemptId).toBe(prior.id);expect(prior.status).toBe(status);
 }finally{await f.close();}
});

it('keeps literal one-shot user requests fulfillable by the exact current operation',async()=>{
 const f=fixture();try{
  const item=f.item('user-goal',['A']);item.dispatchScope=true;item.reason='user_goal';delete item.operationConditionKey;delete item.operationConditionPolicy;f.complete([item]);
  expect(item.status).toBe('succeeded');expect(item.resolvedBy?.attemptId).toBe(f.attempt.id);
 }finally{await f.close();}
});

it('can complete retained A/B sources when the SDK supplies current positive operation evidence for them',async()=>{
 const f=fixture();try{
  const item=f.item('sdk-verified',['A','B']);f.setEquivalent();f.complete([item]);expect(item.status).toBe('succeeded');
 }finally{await f.close();}
});
