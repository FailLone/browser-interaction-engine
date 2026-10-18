import {expect,it,vi} from 'vitest';
import {hash} from '@interaction/core';
import type {ActionAttempt,ActionCandidate,Observation,OperationReceiptCondition} from '@interaction/browser';
import type {ExplorerHost,PlanItem} from '@interaction/explorer-plugin';
import {operationSourceCompletion} from '../packages/explorer-plugin/src/operation-source-completion.js';
import {matches,schedulingKeyFor,scopeFor} from '../packages/explorer-plugin/src/policy.js';

// Pure consumer-contract fixture: SDK answers are explicit, revocable facts.
// Navigation correspondence itself is covered by the separate SDK tests; this
// suite opens no engine, persistence, browser, server or task store.
function fixture(){
  const sid='retained-session',url='https://fixture.invalid/';
  const frame=(id:string,rebuilt=false,mode=false)=>{
    const target={localId:`${id}:target`,instanceId:`${id}:target`,identityId:`${id}:identity`,stableKey:rebuilt?'id:new-target':'id:old-target',
      tag:'button',role:'button',name:rebuilt?'Buy crypto':'Convert',label:rebuilt?'Buy crypto':'Convert',region:'document',visible:true,enabled:true,
      readOnly:false,editable:false,selected:[],checked:null,pressed:null,expanded:null,value:'',constraints:{type:'button'},
      identityContext:{scope:'navigation',binding:rebuilt?'new-binding':'old-binding',evidence:['fixture']},actionBasis:{click:{status:'supported',evidence:[]}}};
    const o={id,sessionId:sid,documentId:id,instanceScope:id,url,ruleVersion:'observable-v8',canonical:id,fingerprint:id,stateId:`state:${id}`,
      context:{},stable:true,gaps:[],boundaries:[],components:[],regions:[{key:'document',role:'document',label:'Document'}],controls:[target,
        {...target,localId:`${id}:mode`,instanceId:`${id}:mode`,identityId:'mode',stableKey:'id:mode',tag:'input',role:'checkbox',name:'Mode',label:'Mode',checked:mode,
          constraints:{type:'checkbox'},identityContext:{scope:'settings',binding:'mode',evidence:['fixture']}}]} as unknown as Observation;
    const a={id:`${id}:action`,sessionId:sid,observationId:id,stateId:o.stateId,localId:target.localId,controlId:target.identityId,
      kind:'click',label:target.name,source:'fixture',risk:'interface',replayable:true,excluded:false,sampleValidity:'known',basis:{status:'supported',evidence:[]},
      preconditions:{visible:true,enabled:true,identityResolved:true,context:{}}} as ActionCandidate;
    return {o,a};
  };
  const a=frame('old-A'),b=frame('old-B',false,true),current=frame('new-A',true),next=frame('new-B',true,true);
  const frames=[a,b,current,next],observations=new Map(frames.map(f=>[f.o.id,f.o])),actions=new Map(frames.map(f=>[f.o.id,[f.a]]));
  const makeAttempt=(id:string,f:typeof a)=>{
    const after={...structuredClone(f.o),id:`${id}:after`};observations.set(after.id,after);actions.set(after.id,[]);
    return {id,sessionId:sid,beforeId:f.o.id,afterId:after.id,action:structuredClone(f.a),status:'succeeded',purpose:'external',
      startedAt:'2026-10-18T00:00:00.000Z',finishedAt:'2026-10-18T00:00:00.001Z'} as ActionAttempt;
  };
  const attempt=makeAttempt('actual-A',current),second=makeAttempt('actual-B',next),attempts=[attempt,second],revoked=new Set<string>();
  const mode=(id:string)=>observations.get(id)?.controls.find(c=>c.role==='checkbox')?.checked;
  const receipt=(sessionId:string,input:{attemptId:string}):OperationReceiptCondition=>{
    const actual=attempts.find(a=>a.id===input.attemptId&&a.sessionId===sessionId)!;
    const verified=actual.status==='succeeded'&&!!actual.afterId&&!revoked.has(actual.id);
    return {actualSuccess:actual.status==='succeeded',conditionVerified:verified,status:verified?'portable':'unavailable',
      reason:verified?'retained-sdk-receipt':'retained-receipt-unavailable',...(verified?{policy:'fixture-receipt',conditionKey:`mode:${mode(actual.beforeId)}`}:{ }),
      source:{sessionId,attemptId:actual.id,beforeId:actual.beforeId,afterId:actual.afterId,actionId:actual.action.id,actionKey:hash(actual.action)},evidence:[],
      identityAuthorized:false,replayAuthorized:false,currentExecution:false,arrivalVerified:false};
  };
  const host={observation:vi.fn((sessionId:string,id:string)=>{const o=observations.get(id);if(o?.sessionId!==sessionId)throw Error('Missing observation');return o;}),
    actions:vi.fn((_sessionId:string,id:string)=>actions.get(id)||[]),operationCoverageCandidates:vi.fn((_sessionId:string,id:string)=>actions.get(id)||[]),
    list:vi.fn((_sessionId:string,kind:string)=>kind==='attempt'?attempts:[]),operationReceiptCondition:vi.fn(receipt),
    operationReceiptConditions:vi.fn((sessionId:string,input:{attemptIds:string[]})=>({sessionId,results:input.attemptIds.map(attemptId=>receipt(sessionId,{attemptId}))})),
    explorationTargetCorrespondences:vi.fn((sessionId:string,input:Parameters<NonNullable<ExplorerHost['explorationTargetCorrespondences']>>[1])=>({sessionId,observationId:input.observationId,
      results:input.requests.map(request=>({equivalent:mode(request.source.observationId)===mode(input.observationId),reason:'fixture-navigation-equivalent',policy:'fixture-navigation',
        source:request.source,target:{sessionId,observationId:input.observationId,actionId:request.actionId},evidence:[],invalidatedBy:[],identityAuthorized:false,replayAuthorized:false,currentExecution:false}))})),
    operationCorrespondences:vi.fn((sessionId:string,input:Parameters<ExplorerHost['operationCorrespondences']>[1])=>({sessionId,observationId:input.observationId,
      results:input.requests.map(request=>{const actual=attempts.find(a=>a.sessionId===request.source.sessionId&&a.id===request.source.attemptId);
        return {equivalent:!!actual&&!revoked.has(actual.id)&&mode(actual.beforeId)===mode(input.observationId),reason:'fixture-source-covered',policy:'fixture-operation',source:request.source,
          target:{sessionId,observationId:input.observationId,actionId:request.actionId},evidence:[],invalidatedBy:[],identityAuthorized:false,replayAuthorized:false,currentExecution:false};})}))} as unknown as ExplorerHost;
  const item:PlanItem={id:'original-child',title:'Convert',scope:scopeFor(a.a,a.o),prerequisites:[],completion:'Execute every retained source',status:'unresolved',required:true,
    dispatchScope:false,reason:'region_review_required',operationConditionPolicy:'browser-operation-key-v3',operationConditionKey:schedulingKeyFor(a.a,a.o),
    evidence:[{sessionId:sid,observationId:a.o.id}],attempts:[]};
  const append=(actual=attempt,target=item)=>{
    const ref={sessionId:actual.sessionId,observationId:actual.afterId||actual.beforeId,attemptId:actual.id};
    target.evidence.push(ref);target.attempts.push({roundId:'round',outcome:actual.status,evidence:ref});target.resolvedBy=ref;
  };
  return {host,item,a,b,current,next,attempt,second,attempts,observations,actions,revoked,append,makeAttempt};
}

it('associates a rebuilt navigation attempt without rewriting the original child or inventing a discovery source',()=>{
  const f=fixture(),original=structuredClone(f.item),complete=operationSourceCompletion(f.host,f.attempt);
  expect(matches(f.item.scope,f.current.a,f.current.o)).toBe(false);expect(schedulingKeyFor(f.current.a,f.current.o)).not.toBe(f.item.operationConditionKey);
  expect(complete.associate(f.item,f.attempt)).toBe(true);expect(f.item).toEqual(original);
  f.append();expect(complete(f.item)).toBe(true);
  expect(f.item.scope).toEqual(original.scope);expect(f.item.operationConditionKey).toBe(original.operationConditionKey);
  expect(f.item.evidence.filter(ref=>!ref.attemptId)).toEqual(original.evidence);
  expect(vi.mocked(f.host.operationCorrespondences).mock.calls.map(([,input])=>input.observationId)).toEqual([f.a.o.id]);
  expect(vi.mocked(f.host.observation).mock.calls.filter(([,id])=>id===f.a.o.id)).toHaveLength(1);
  expect(f.item.status).toBe('unresolved'); // Attribution/completion queries never settle a task themselves.
});

it('requires independent A and B source receipts and rechecks their retained proofs after a serialized restart',()=>{
  const f=fixture();f.item.evidence.push({sessionId:f.b.o.sessionId,observationId:f.b.o.id});f.append();
  expect(operationSourceCompletion(f.host)(f.item)).toBe(false);
  f.append(f.second);const restarted=JSON.parse(JSON.stringify(f.item)) as PlanItem;
  expect(operationSourceCompletion(f.host)(restarted)).toBe(true);
  f.revoked.add(f.attempt.id);expect(operationSourceCompletion(f.host)(restarted)).toBe(false);
  expect(restarted).toEqual(f.item);expect(f.attempt.status).toBe('succeeded');expect(f.second.status).toBe('succeeded');
});

it('attributes an actual unknown outcome without turning it into condition completion',()=>{
  const f=fixture();f.attempt.status='unknown';const complete=operationSourceCompletion(f.host,f.attempt);
  expect(complete.associate(f.item,f.attempt)).toBe(true);f.append();expect(complete(f.item)).toBe(false);
  expect(f.attempt.status).toBe('unknown');expect(f.host.operationReceiptConditions).not.toHaveBeenCalled();
});

it('binds the current SDK proof before dispatch and restores attribution after navigation without changing completion requirements',()=>{
  const f=fixture(),saved=operationSourceCompletion(f.host).prepareAssociation(f.item,f.current.a)!;
  expect(saved).toBeDefined();
  vi.mocked(f.host.explorationTargetCorrespondences!).mockImplementation(()=>{throw Error('STALE_OBSERVATION');});
  const restarted=JSON.parse(JSON.stringify(saved)),complete=operationSourceCompletion(f.host,f.attempt);
  expect(complete.associate(f.item,f.attempt)).toBe(false);
  expect(complete.associate(f.item,f.attempt,restarted)).toBe(true);
  expect(complete.associate(f.item,{...f.attempt,action:{...f.attempt.action,label:'different command'}},restarted)).toBe(false);
  expect(complete.associate(f.item,f.attempt,{...restarted,proof:{...restarted.proof,source:{...restarted.proof.source,observationId:'other-source'}}})).toBe(false);
  f.append();expect(complete(f.item)).toBe(true);
  f.revoked.add(f.attempt.id);expect(operationSourceCompletion(f.host)(f.item)).toBe(false);
});

it.each(['missing','unknown','executing'] as const)('keeps a previously referenced %s receipt blocking attribution and completion',status=>{
  const f=fixture();f.append(f.second);if(status==='missing')f.attempts.splice(f.attempts.indexOf(f.second),1);else f.second.status=status;
  const complete=operationSourceCompletion(f.host,f.attempt);expect(complete.associate(f.item,f.attempt)).toBe(false);expect(complete(f.item)).toBe(false);
  expect(f.host.explorationTargetCorrespondences).not.toHaveBeenCalled();expect(f.host.operationReceiptConditions).not.toHaveBeenCalled();
});

it.each(['source','target','authority','batch'] as const)('rejects an SDK association with mismatched %s evidence',fault=>{
  const f=fixture(),query=vi.mocked(f.host.explorationTargetCorrespondences!),original=query.getMockImplementation()!;
  query.mockImplementation((sid,input)=>{const result=original(sid,input),proof=result.results[0];
    if(fault==='source')proof.source={...proof.source,actionId:'another-source'};
    if(fault==='target')proof.target={...proof.target,actionId:'another-target'};
    if(fault==='authority')Object.assign(proof,{executionAuthorized:true,identityAuthorized:true});
    if(fault==='batch')result.results.push(proof);
    return result;
  });
  expect(operationSourceCompletion(f.host,f.attempt).associate(f.item,f.attempt)).toBe(false);
});

it.each(['condition','scope','ambiguous','wrong-mode','user-authority','missing-source','missing-capability','actual-value'] as const)('does not use correspondence to widen %s',fault=>{
  const f=fixture();
  if(fault==='condition')f.item.operationConditionKey='not-the-retained-condition';
  if(fault==='scope')f.item.scope={...f.item.scope,label:'another-control'};
  if(fault==='ambiguous')f.actions.get(f.a.o.id)!.push({...f.a.a,id:'duplicate-source'});
  if(fault==='wrong-mode')f.current.o.controls.find(c=>c.role==='checkbox')!.checked=true;
  if(fault==='user-authority')f.item.dispatchScope=true;
  if(fault==='missing-source')f.observations.delete(f.a.o.id);
  if(fault==='missing-capability')f.host.explorationTargetCorrespondences=undefined;
  if(fault==='actual-value')f.attempt.action={...f.attempt.action,value:'different-supplied-input'};
  expect(operationSourceCompletion(f.host,f.attempt).associate(f.item,f.attempt)).toBe(false);
});

it('preserves receipt-only legacy exact-before completion and does not reinterpret an unrelated legacy scope',()=>{
  const f=fixture(),legacy=structuredClone(f.item);legacy.evidence=[];legacy.scope=scopeFor(f.current.a,f.current.o);f.append(f.attempt,legacy);
  expect(operationSourceCompletion(f.host)(legacy)).toBe(true);expect(f.host.operationCorrespondences).not.toHaveBeenCalled();
  legacy.scope=structuredClone(f.item.scope);expect(operationSourceCompletion(f.host)(legacy)).toBe(false);
});

it('keeps receipt proof, reference integrity and false authority flags independent from fresh association',()=>{
  const f=fixture();expect(operationSourceCompletion(f.host,f.attempt).associate(f.item,f.attempt)).toBe(true);f.append();f.revoked.add(f.attempt.id);
  expect(operationSourceCompletion(f.host)(f.item)).toBe(false);expect(f.host.operationCorrespondences).not.toHaveBeenCalled();
  f.revoked.clear();const query=vi.mocked(f.host.operationCorrespondences),original=query.getMockImplementation()!;
  query.mockImplementation((sid,input)=>{const result=original(sid,input);Object.assign(result.results[0],{replayAuthorized:true});return result;});
  expect(operationSourceCompletion(f.host)(f.item)).toBe(false);
  query.mockImplementation(original);f.item.resolvedBy={...f.item.resolvedBy!,observationId:'unrelated-receipt-frame'};
  expect(operationSourceCompletion(f.host)(f.item)).toBe(false);
});

it('retains prepare batching and rejects unknown annotations without a resolvable receipt',()=>{
  const f=fixture();f.append();const complete=operationSourceCompletion(f.host);complete.prepare([f.item]);expect(complete(f.item)).toBe(true);
  expect(f.host.operationReceiptConditions).toHaveBeenCalledTimes(1);
  f.item.attempts.push({roundId:'interrupted',outcome:'unknown'});expect(operationSourceCompletion(f.host)(f.item)).toBe(false);
});

it('retains a direct pre-dispatch binding for every original source without overwriting the first with a later match',()=>{
  const f=fixture();f.b.o.controls[1].checked=false;
  f.item.evidence.push({sessionId:f.b.o.sessionId,observationId:f.b.o.id});
  const binding=operationSourceCompletion(f.host).prepareAssociation(f.item,f.current.a)!;
  expect(binding.proof.source.observationId).toBe(f.a.o.id);
  expect(binding.retainedProofs?.map(p=>p.source.observationId)).toEqual([f.b.o.id]);
  expect([binding.proof,...binding.retainedProofs!].every(p=>p.target.actionId===f.current.a.id)).toBe(true);
  const restored=JSON.parse(JSON.stringify(binding));
  vi.mocked(f.host.explorationTargetCorrespondences!).mockImplementation(()=>{throw Error('STALE_OBSERVATION');});
  expect(operationSourceCompletion(f.host).associate(f.item,f.attempt,restored)).toBe(true);
  expect(operationSourceCompletion(f.host).associate(f.item,{...f.attempt,action:{...f.attempt.action,id:'wrong-action'}},restored)).toBe(false);
});
