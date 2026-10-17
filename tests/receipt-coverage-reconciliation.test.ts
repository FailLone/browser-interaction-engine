import { expect, it, vi } from 'vitest';
import { reconcileCoverage, type ActionAttempt, type ActionCandidate, type FrontierItem, type Observation, type Session } from '@interaction/core';

function fixture() {
  const control={localId:'control',instanceId:'node',identityId:'identity',identityScope:'instance' as const,role:'control',name:'Target',label:'Target',region:'root',visible:true,enabled:true};
  const observation=(id:string):Observation=>({id,sessionId:'session',capturedAt:'2026-10-17T00:00:00Z',instanceScope:'scope',controls:[{...control}],regions:[],context:{},gaps:[],stable:true,stateId:'state',visitId:id,fingerprint:'facts',canonical:'facts',ruleVersion:'test-v1',cause:'inspection'});
  const before=observation('before'),after=observation('after'),current=observation('current');
  const action=(o:Observation,value:string):ActionCandidate=>({id:'shared-action-id',sessionId:'session',observationId:o.id,stateId:o.stateId,controlId:'identity',localId:'control',kind:'set',value,label:'Target',preconditions:{context:{},visible:true,enabled:true,identityResolved:false},basis:{status:'supported',evidence:[{source:'fixture',rule:'native/v1',facts:{}}]},replayable:false,risk:'interface',source:'fixture',excluded:false,sampleValidity:'known'});
  const source=action(before,'A'),target=action(current,'A');
  const attempt:ActionAttempt={id:'success',sessionId:'session',requestId:'request',action:source,startedAt:before.capturedAt,finishedAt:after.capturedAt,beforeId:before.id,afterId:after.id,status:'succeeded',purpose:'exploration'};
  const item=(id:string,a=target):FrontierItem=>({id,sessionId:'session',key:id,stateId:a.stateId,contextKey:'{}',action:a,status:'pending',attempts:[],depth:0});
  const session={id:'session',options:{exploration:'controls'}} as Session;
  const receipt=vi.fn((a:ActionCandidate,_o:Observation,r:ActionAttempt)=>a.value===r.action.value?{key:'narrow',policy:'receipt-test',evidence:['actual-receipt']}:undefined);
  const evaluate=(frontier=[item('pending')],attempts=[attempt],sample:Parameters<typeof reconcileCoverage>[5]=()=>undefined)=>
    reconcileCoverage(session,frontier,attempts,[before,after,current],[],sample,receipt);
  return {before,after,current,source,target,attempt,item,receipt,evaluate};
}

it('uses the supplied frontier action object and receipt input, even when candidate IDs are shared',()=>{
  const f=fixture(),a=f.item('A'),b=f.item('B',{...f.target,value:'B'});
  const saved=structuredClone([a,b,f.attempt]),result=f.evaluate([a,b]);
  expect([...result.keys()]).toEqual(['A']);expect(result.get('A')).toMatchObject({attemptId:'success',policy:'receipt-test'});
  expect(f.receipt.mock.calls[0][0]).toBe(a.action);expect(f.receipt.mock.calls[0][2]).toBe(f.attempt);
  expect([a,b,f.attempt]).toEqual(saved);
});

it('does not invoke the retained fallback when both portable samples are known and different',()=>{
  const f=fixture();const result=f.evaluate(undefined,undefined,(_a,o)=>({key:o.id,policy:'portable',evidence:['known-condition']}));
  expect(result.size).toBe(0);expect(f.receipt).not.toHaveBeenCalled();
});

it('keeps unknown, executing, attempted and migration debt out of retained coverage',()=>{
  const f=fixture(),rows=[{...f.item('unknown'),status:'unknown' as const},{...f.item('executing'),status:'executing' as const},
    {...f.item('attempted'),attempts:['previous-failure']},{...f.item('migration'),samplingMigration:{version:'retained-sampling-sources/v1' as const,sourceKey:'old',sources:[],children:[]}}];
  expect(f.evaluate(rows).size).toBe(0);expect(f.receipt).not.toHaveBeenCalled();
});

it.each(['unknown','executing','failed','blocked','missing-after','incomplete-after'] as const)('requires a complete successful receipt: %s',change=>{
  const f=fixture();if(change==='missing-after')delete f.attempt.afterId;
  else if(change==='incomplete-after')f.after.gaps.push({code:'missing-result',message:'incomplete result',critical:true});
  else f.attempt.status=change;
  expect(f.evaluate().size).toBe(0);expect(f.receipt).not.toHaveBeenCalled();
});

it('keeps retained coverage disabled without a composition reader',()=>{
  const f=fixture(),session={id:'session',options:{exploration:'controls'}} as Session;
  expect(reconcileCoverage(session,[f.item('pending')],[f.attempt],[f.before,f.after,f.current],[],()=>undefined).size).toBe(0);
});

it('does not rebuild portable samples for observations excluded by the composition',()=>{
  const f=fixture(),sample=vi.fn(()=>undefined);
  Object.assign(f.receipt,{acceptsObservation:()=>false});
  expect(f.evaluate(undefined,undefined,sample).size).toBe(0);
  expect(f.receipt).not.toHaveBeenCalled();expect(sample).toHaveBeenCalledTimes(2);
});
