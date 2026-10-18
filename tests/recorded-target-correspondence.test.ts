import {expect,it} from 'vitest';
import {explorerFixture} from './explorer-plugin-helpers.js';

it('audits a recorded target only with its exact verified dispatch receipt, without making stale targets current',async()=>{
 const f=await explorerFixture('<button role="tab" onclick="this.disabled=true">Inspect</button><button role="tab">Unexecuted</button>');
 try{
  const session=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui'}),sid=session.id;
  const before=f.host.observation(sid),actions=f.host.actions(sid),a=actions.find(a=>a.label==='Inspect'&&a.kind==='click')!,other=actions.find(a=>a.label==='Unexecuted'&&a.kind==='click')!;
  const attempt=await f.host.execute(sid,a.id,'recorded-target',undefined,{observationId:before.id,profile:'observed-ui-exploration'});
  expect(attempt.status).toBe('succeeded');expect(f.host.operationReceiptCondition(sid,{attemptId:attempt.id}).conditionVerified).toBe(true);
  const query=(actionId:string)=>f.host.explorationTargetCorrespondences(sid,{observationId:before.id,requests:[{actionId,source:{sessionId:sid,observationId:before.id,actionId}}]});
  const current=f.host.observation(sid).id,proof=query(a.id).results[0];
  expect(proof).toMatchObject({equivalent:true,identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  expect(proof.evidence).toContain(`recorded-target-dispatch:${attempt.id}`);expect(f.host.observation(sid).id).toBe(current);
  expect(()=>query(other.id)).toThrowError('Historical target correspondence requires its exact verified dispatch receipt');
  await expect(f.host.execute(sid,a.id,'stale-target',undefined,{observationId:before.id,profile:'observed-ui-exploration'})).rejects.toHaveProperty('code','STALE_OBSERVATION');
  const persistence=(f.host as any).store;
  for(const corrupted of [{...attempt,status:'unknown'},{...attempt,dispatchWitness:{...attempt.dispatchWitness,actionKey:'unmatched-dispatch'}},{...attempt,afterId:undefined}]){
   persistence.put('attempt',corrupted);expect(()=>query(a.id),JSON.stringify({status:corrupted.status,afterId:corrupted.afterId,witness:corrupted.dispatchWitness})).toThrowError('Historical target correspondence requires its exact verified dispatch receipt');
  }
  persistence.put('attempt',attempt);expect(query(a.id).results[0].equivalent).toBe(true);
 }finally{await f.close();}
});
