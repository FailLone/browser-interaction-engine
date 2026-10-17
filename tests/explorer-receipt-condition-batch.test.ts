import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {hash} from '@interaction/core';
import type {ActionAttempt,ActionCandidate,Observation,OperationReceiptCondition} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Task} from '@interaction/explorer-plugin';
import {receiptConditionReader} from '../packages/explorer-plugin/src/receipt-condition.js';
import {exactSourceExecution,operationSourceCompletion} from '../packages/explorer-plugin/src/operation-source-completion.js';
import {scopeFor,schedulingKeyFor} from '../packages/explorer-plugin/src/policy.js';

// Protocol fixtures, not browser-recovery or end-to-end timing evidence.
function fixture(count=3) {
  const url='https://batch-fixture.invalid/page',observations=new Map<string,Observation>(),actions=new Map<string,ActionCandidate[]>(),attempts:ActionAttempt[]=[];
  for(let index=0;index<count;index++){
    const id=`before-${index}`,control={localId:'target',instanceId:'target',identityId:'identity',stableKey:'id:target',selector:'#target',tag:'button',role:'button',name:'Open',label:'Open',visible:true,enabled:true,region:'document',form:'',selected:[],constraints:{type:'button',required:false,valid:true},actionBasis:{click:{status:'supported',evidence:[]}}};
    const before={id,sessionId:'session',stateId:`state-${index}`,documentId:'document',instanceScope:'document',url,ruleVersion:'observable-v7',context:{},stable:true,gaps:[],regions:[],boundaries:[],overlays:[],components:[],controls:[control]} as unknown as Observation;
    const action={id:`action-${index}`,sessionId:'session',observationId:id,stateId:before.stateId,localId:'target',controlId:'identity',kind:'click',label:'Open',risk:'interface',replayable:true,excluded:false,source:'protocol-fixture',sampleValidity:'known',basis:{status:'supported',evidence:[]},preconditions:{visible:true,enabled:true,identityResolved:true,context:{}}} as ActionCandidate;
    const after={...structuredClone(before),id:`after-${index}`,controls:[]} as Observation;
    observations.set(id,before);observations.set(after.id,after);actions.set(id,[action]);actions.set(after.id,[]);
    attempts.push({id:`attempt-${index}`,sessionId:'session',beforeId:id,afterId:after.id,action,status:'succeeded',startedAt:'2026-10-17T00:00:00.000Z'} as ActionAttempt);
  }
  const denied=new Set<string>();
  const proof=(attempt:ActionAttempt):OperationReceiptCondition=>{
    const valid=attempt.status==='succeeded'&&!denied.has(attempt.id);
    return {actualSuccess:attempt.status==='succeeded',conditionVerified:valid,status:valid?'document':'unavailable',reason:valid?'fixture_condition_verified':'fixture_condition_revoked',...(valid?{policy:'fixture-policy',conditionKey:`condition-${attempt.id}`} : {}),
      source:{sessionId:attempt.sessionId,attemptId:attempt.id,beforeId:attempt.beforeId,afterId:attempt.afterId,actionId:attempt.action.id,actionKey:hash(attempt.action)},evidence:[],identityAuthorized:false,replayAuthorized:false,currentExecution:false,arrivalVerified:false};
  };
  const single=vi.fn((_sessionId:string,input:{attemptId:string})=>proof(attempts.find(attempt=>attempt.id===input.attemptId)!));
  const batch=vi.fn((sessionId:string,input:{attemptIds:string[]})=>({sessionId,results:input.attemptIds.map(id=>proof(attempts.find(attempt=>attempt.id===id)!))}));
  const list=vi.fn((_sessionId:string,kind:string)=>kind==='attempt'?attempts:[]);
  const host={events:new EventEmitter(),session:()=>({id:'session',actionCount:count,options:{}}),sessions:()=>[],boundaryState:()=>({verified:true}),createSession:vi.fn(()=>{throw Error('No browser may start');}),
    observation:(_sessionId:string,id?:string)=>observations.get(id||`after-${count-1}`)!,actions:(_sessionId:string,id?:string)=>actions.get(id||`after-${count-1}`)||[],operationCoverageCandidates:(_sessionId:string,id?:string)=>actions.get(id||`after-${count-1}`)||[],
    list,operationReceiptCondition:single,operationReceiptConditions:batch,
    operationCorrespondences:vi.fn((sessionId:string,input:{observationId:string;requests:{actionId:string;source:{sessionId:string;attemptId:string}}[]})=>({sessionId,observationId:input.observationId,results:input.requests.map(request=>({equivalent:false,source:request.source,target:{sessionId,observationId:input.observationId,actionId:request.actionId},reason:'distinct_source_conditions',evidence:[],invalidatedBy:[],identityAuthorized:false,replayAuthorized:false,currentExecution:false}))}))} as unknown as ExplorerHost;
  const item=(attempt:ActionAttempt):PlanItem=>({id:`item-${attempt.id}`,title:'Open',scope:scopeFor(attempt.action,observations.get(attempt.beforeId)!),prerequisites:[],completion:'Cover retained source',required:true,dispatchScope:false,status:'succeeded',reason:'operation_not_executed',operationConditionPolicy:'browser-operation-key-v3',operationConditionKey:schedulingKeyFor(attempt.action,observations.get(attempt.beforeId)!),
    evidence:[{sessionId:attempt.sessionId,observationId:attempt.beforeId}],resolvedBy:{sessionId:attempt.sessionId,observationId:attempt.afterId!,attemptId:attempt.id},attempts:[{roundId:'round',outcome:'succeeded',evidence:{sessionId:attempt.sessionId,observationId:attempt.afterId!,attemptId:attempt.id}}]});
  const runtime=()=>{
    const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:')),task=plugin.create({url,coverageMode:'all'});
    task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:attempts[0].startedAt,status:'paused',actions:count,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];task.plan=attempts.map(item);
    return {plugin,task,methods:plugin as unknown as {reconcileConditionCompletions(task:Task):number;recordOutcome(task:Task,attempt:ActionAttempt,ids:string[]):void}};
  };
  return {host,attempts,observations,actions,denied,proof,single,batch,list,item,runtime};
}

it('batches distinct receipts by session, deduplicates repeated references and preserves input order',()=>{
  const f=fixture(4);f.attempts[3].sessionId='another-session';f.attempts[3].action.sessionId='another-session';
  const input=[f.attempts[2],f.attempts[0],f.attempts[3],f.attempts[1],f.attempts[0]],read=receiptConditionReader(f.host),before=structuredClone(input);
  expect(read.many(input)).toEqual(input.map(f.proof));expect(input).toEqual(before);
  expect(f.batch.mock.calls).toEqual([['session',{attemptIds:['attempt-2','attempt-0','attempt-1']}],['another-session',{attemptIds:['attempt-3']}]]);expect(f.single).not.toHaveBeenCalled();
  expect(read(f.attempts[0])).toEqual(f.proof(f.attempts[0]));expect(f.batch).toHaveBeenCalledTimes(2);expect(f.single).not.toHaveBeenCalled();
});

it.each(['partial','reordered','foreign-session','foreign-receipt','throw'] as const)('refuses a %s batch without falling back to a positive single query',failure=>{
  const f=fixture(2),original=f.batch.getMockImplementation()!;
  f.batch.mockImplementation((sid,input)=>{
    if(failure==='throw')throw Error('Receipt ledger unavailable');
    const result=original(sid,input);
    if(failure==='partial')result.results.pop();
    if(failure==='reordered')result.results.reverse();
    if(failure==='foreign-session')result.sessionId='foreign';
    if(failure==='foreign-receipt')result.results[0].source.attemptId='foreign';
    return result;
  });
  const result=receiptConditionReader(f.host).many(f.attempts);
  expect(result.every(proof=>!proof.conditionVerified&&proof.status==='unavailable')).toBe(true);expect(f.single).not.toHaveBeenCalled();
  expect(result.map(proof=>proof.source.attemptId)).toEqual(f.attempts.map(attempt=>attempt.id));
});

it.each(['action-value','arrival-authority'] as const)('refuses a batch row with mismatched %s evidence while preserving a valid independent row',failure=>{
  const f=fixture(2),original=f.batch.getMockImplementation()!;
  f.batch.mockImplementation((sid,input)=>{const result=original(sid,input);if(failure==='action-value')result.results[0].source.actionKey=hash({...f.attempts[0].action,value:'other'});else (result.results[0] as unknown as {arrivalVerified:boolean}).arrivalVerified=true;return result;});
  expect(receiptConditionReader(f.host).many(f.attempts).map(proof=>proof.conditionVerified)).toEqual([false,true]);expect(f.single).not.toHaveBeenCalled();
});

it('does not collapse two conflicting facts for the same receipt into a positive proof',()=>{
  const f=fixture(1),changed={...structuredClone(f.attempts[0]),status:'unknown' as const};
  expect(receiptConditionReader(f.host).many([f.attempts[0],changed]).map(proof=>proof.conditionVerified)).toEqual([false,false]);expect(f.batch).not.toHaveBeenCalled();expect(f.single).not.toHaveBeenCalled();
});

it.each(['unknown','revoked'] as const)('re-reads a %s receipt on the next independent query',change=>{
  const f=fixture(1),callerReceipt=structuredClone(f.attempts[0]);expect(receiptConditionReader(f.host).many([callerReceipt])[0].conditionVerified).toBe(true);
  if(change==='unknown')f.attempts[0].status='unknown';else f.denied.add(f.attempts[0].id);
  expect(receiptConditionReader(f.host).many([callerReceipt])[0]).toMatchObject({actualSuccess:change!=='unknown',conditionVerified:false});expect(f.batch).toHaveBeenCalledTimes(2);
});

it('does not eagerly query an old host during prepare or inspect unrelated audit candidates',()=>{
  const f=fixture(2);f.host.operationReceiptConditions=undefined;const items=f.attempts.map(f.item),complete=operationSourceCompletion(f.host);
  complete.prepare(items);expect(f.list).not.toHaveBeenCalled();expect(f.single).not.toHaveBeenCalled();
  expect(complete(items[0])).toBe(true);expect(f.single.mock.calls).toEqual([['session',{attemptId:'attempt-0'}]]);
  const task={plan:items} as Task,before=f.observations.get(f.attempts[1].beforeId)!,audit=exactSourceExecution(f.host,task,before);
  expect(audit({...f.attempts[1].action,id:'unrelated'})).toBe(false);expect(f.single).toHaveBeenCalledTimes(1);
  expect(audit(f.attempts[1].action)).toBe(true);expect(f.single).toHaveBeenCalledTimes(2);expect(f.batch).not.toHaveBeenCalled();
});

it('prepares distinct source proofs once while keeping unknown and missing source obligations unresolved',()=>{
  const f=fixture(4),items=f.attempts.map(f.item);f.attempts[2].status='unknown';items[3].evidence.push({sessionId:'session',observationId:'missing',attemptId:'missing'});
  const before=structuredClone(items),complete=operationSourceCompletion(f.host);complete.prepare(items);
  expect(f.batch.mock.calls).toEqual([['session',{attemptIds:['attempt-0','attempt-1']}]]);
  expect(items.map(complete)).toEqual([true,true,false,false]);expect(items).toEqual(before);expect(f.batch).toHaveBeenCalledTimes(1);expect(f.single).not.toHaveBeenCalled();
});

it('keeps an unverified A source when batching a valid B receipt',()=>{
  const f=fixture(2),item=f.item(f.attempts[1]);item.evidence.unshift({sessionId:'session',observationId:f.attempts[0].beforeId});
  const complete=operationSourceCompletion(f.host);complete.prepare([item]);expect(complete(item)).toBe(false);expect(f.batch.mock.calls).toEqual([['session',{attemptIds:['attempt-1']}]]);
  expect(f.host.operationCorrespondences).toHaveBeenCalled();expect(item.evidence[0].observationId).toBe(f.attempts[0].beforeId);
});

it('reconciles the same task facts as single queries using one batch for distinct receipts',async()=>{
  const batch=fixture(),legacy=fixture();legacy.host.operationReceiptConditions=undefined;batch.denied.add('attempt-1');legacy.denied.add('attempt-1');
  const current=batch.runtime(),prior=legacy.runtime();try{
    const retained=structuredClone(current.task.plan.map(item=>({evidence:item.evidence,attempts:item.attempts,resolvedBy:item.resolvedBy})));
    current.methods.reconcileConditionCompletions(current.task);prior.methods.reconcileConditionCompletions(prior.task);
    expect(current.task.plan).toEqual(prior.task.plan);expect(current.task.plan.map(item=>item.status)).toEqual(['succeeded','unresolved','succeeded']);
    expect(current.task.plan.map(item=>({evidence:item.evidence,attempts:item.attempts,resolvedBy:item.resolvedBy}))).toEqual(retained);
    expect(batch.batch.mock.calls).toEqual([['session',{attemptIds:['attempt-0','attempt-1','attempt-2']}]]);expect(batch.single).not.toHaveBeenCalled();expect(legacy.single).toHaveBeenCalledTimes(3);
    expect(batch.host.createSession).not.toHaveBeenCalled();
  }finally{await current.plugin.close();await prior.plugin.close();}
});

it('rejects the new receipt in the single gate before requesting any old receipt condition proof',async()=>{
  const f=fixture(2),runtime=f.runtime();try{
    const current=f.attempts[1],item=f.item(current);item.status='unresolved';item.attempts=[];delete item.resolvedBy;item.evidence.push({sessionId:'session',observationId:f.attempts[0].afterId!,attemptId:f.attempts[0].id});runtime.task.plan=[item];f.denied.add(current.id);
    runtime.methods.recordOutcome(runtime.task,current,[item.id]);
    expect(item).toMatchObject({status:'unresolved',conditionCompletion:{status:'unverified'}});expect(item.resolvedBy).toMatchObject({attemptId:current.id});
    expect(f.single.mock.calls).toEqual([['session',{attemptId:current.id}]]);expect(f.batch).not.toHaveBeenCalled();
  }finally{await runtime.plugin.close();}
});
