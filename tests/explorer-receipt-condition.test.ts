import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {hash} from '@interaction/core';
import {BrowserEngine,type ActionAttempt,type ActionCandidate,type Observation,type OperationReceiptCondition} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Task} from '@interaction/explorer-plugin';
import {scopeFor,schedulingKeyFor} from '../packages/explorer-plugin/src/policy.js';
import {schedulableObligation} from '../packages/explorer-plugin/src/plan-state.js';
import {projectObligations} from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import {exactSourceExecution,operationSourceCompletion} from '../packages/explorer-plugin/src/operation-source-completion.js';
import {receiptConditionReader} from '../packages/explorer-plugin/src/receipt-condition.js';
import {pageOf} from './helpers.js';

it.each([true,false])('records real owner execution independently of own-before condition completion (changed=%s)',async changed=>{
  const site=createServer((_req,response)=>{response.setHeader('Content-Type','text/html');response.end(`<!doctype html><main><ul>
    <li data-record="target"><input id="flag" type="checkbox" aria-label="Flag" onchange="window.actualBranch=document.querySelector('#mode-owner').dataset.record"><a href="/target-record">Target record</a></li>
    <li id="mode-owner" data-record="A"><i id="mode" role="button" aria-label="Hidden mode" aria-expanded="false" hidden></i><a href="/mode-record">Mode record</a></li>
    </ul></main>`);});
  await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));
  const host=new BrowserEngine({persistence:new MemoryStore()}),plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'));
  try {
    const url=`http://127.0.0.1:${(site.address() as {port:number}).port}/`;
    const session=await host.createSession({url,headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100,evidence:{enabled:false}});
    const initial=host.observation(session.id),flag=initial.controls.find(control=>control.selector==='#flag')!;
    await host.reviewControls(session.id,{observationId:initial.id,source:'owned-plugin-condition-fixture',reviews:[{localId:flag.localId,kind:'check',samples:[true],risk:'interface',replayable:false,reason:'Owned checkbox',evidence:['Local handler records actual owner']}]});
    await host.observe(session.id);
    const before=host.observation(session.id),action=host.actions(session.id).find(candidate=>candidate.localId===flag.localId&&candidate.kind==='check'&&candidate.value===true)!;
    const task=plugin.create({url,coverageMode:'all'}),key=schedulingKeyFor(action,before);
    task.rounds=[{id:'owned-round',number:1,sessionId:session.id,startedAt:new Date().toISOString(),status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[key],reviewed:[],noProgress:0}];
    const item:PlanItem={id:'own-before-A',title:'Flag under retained A',scope:scopeFor(action,before),prerequisites:[],completion:'Verify the retained source condition',status:'unresolved',required:true,dispatchScope:false,reason:'operation_not_executed',operationConditionPolicy:'browser-operation-key-v3',operationConditionKey:key,evidence:[{sessionId:session.id,observationId:before.id}],attempts:[]};
    task.plan=[item];
    const tried=structuredClone(task.rounds[0].tried),beforeJson=JSON.stringify(before);
    if(changed)await pageOf(host).locator('#mode-owner').evaluate(element=>element.setAttribute('data-record','B'));
    const attempt=await host.execute(session.id,action.id,'owned-plugin-A-to-B');
    expect(attempt.status).toBe('succeeded');expect(await pageOf(host).evaluate(()=>(window as unknown as {actualBranch:string}).actualBranch)).toBe(changed?'B':'A');
    if(changed)expect(host.observation(session.id,attempt.afterId!).ownerDependencyDispatch).toBeUndefined();
    else expect(host.operationReceiptCondition(session.id,{attemptId:attempt.id})).toMatchObject({actualSuccess:true,conditionVerified:true,status:'document'});
    (plugin as unknown as {recordOutcome(task:Task,attempt:ActionAttempt,ids:string[]):void}).recordOutcome(task,attempt,[item.id]);
    expect(item.attempts).toContainEqual({roundId:'owned-round',outcome:'succeeded',evidence:{sessionId:session.id,observationId:attempt.afterId,attemptId:attempt.id}});
    expect(item.resolvedBy?.attemptId).toBe(attempt.id);
    expect(task.rounds[0].tried).toEqual(tried);expect(JSON.stringify(host.observation(session.id,before.id))).toBe(beforeJson);
    expect(item.status).toBe(changed?'unresolved':'succeeded');
  }finally{await plugin.close();await host.close();await new Promise<void>(resolve=>site.close(()=>resolve()));}
});

function fixture(filename=':memory:') {
  const url='https://owned.invalid/condition';
  const before={id:'before',sessionId:'session',stateId:'state',documentId:'document',instanceScope:'document',url,ruleVersion:'observable-v7',context:{},stable:true,gaps:[],regions:[],boundaries:[],overlays:[],components:[],
    controls:[{localId:'target',instanceId:'target',identityId:'identity',stableKey:'id:target',selector:'#target',tag:'button',role:'button',name:'Open',label:'Open',visible:true,enabled:true,region:'document',form:'',selected:[],constraints:{type:'button',required:false,valid:true},actionBasis:{click:{status:'supported',evidence:[]}}}]} as unknown as Observation;
  const after={...structuredClone(before),id:'after',controls:[]} as Observation;
  const action={id:'action',sessionId:'session',observationId:'before',stateId:'state',localId:'target',controlId:'identity',kind:'click',label:'Open',risk:'interface',replayable:true,excluded:false,source:'owned-fixture',sampleValidity:'known',basis:{status:'supported',evidence:[]},preconditions:{visible:true,enabled:true,identityResolved:true,context:{}}} as ActionCandidate;
  const attempt={id:'attempt',sessionId:'session',beforeId:'before',afterId:'after',action,status:'succeeded',startedAt:'2026-10-17T00:00:00.000Z'} as ActionAttempt;
  const attempts=[attempt],observations=new Map([before,after].map(o=>[o.id,o])),actions=new Map([[before.id,[action]],[after.id,[] as ActionCandidate[]]]);
  let verified=false,equivalent=false,status:'portable'|'document'='document';
  const query=vi.fn((_sid:string,{attemptId}:{attemptId:string}):OperationReceiptCondition=>{
    const a=attempts.find(a=>a.id===attemptId)!;
    return {actualSuccess:a.status==='succeeded',conditionVerified:verified&&a.status==='succeeded',status:verified?status:'unavailable',reason:verified?'owned_condition_verified':'dispatch_witness_missing',policy:verified?'owned-policy':undefined,conditionKey:verified?'owned-condition':undefined,
      source:{sessionId:a.sessionId,attemptId:a.id,beforeId:a.beforeId,afterId:a.afterId,actionId:a.action.id,actionKey:hash(a.action)},evidence:[],identityAuthorized:false,replayAuthorized:false,currentExecution:false,arrivalVerified:false};
  });
  const host={events:new EventEmitter(),session:()=>({id:'session',actionCount:1,options:{}}),sessions:()=>[],boundaryState:()=>({verified:true}),createSession:vi.fn(()=>{throw Error('No browser may start');}),
    observation:(_sid:string,id?:string)=>observations.get(id||after.id)!,actions:(_sid:string,id?:string)=>actions.get(id||after.id)||[],operationCoverageCandidates:(_sid:string,id?:string)=>actions.get(id||after.id)||[],
    list:(_sid:string,kind:string)=>kind==='attempt'?attempts:[],operationReceiptCondition:query,
    operationCorrespondences:vi.fn((sid:string,input:{observationId:string;requests:{actionId:string;source:{sessionId:string;attemptId:string}}[]})=>({sessionId:sid,observationId:input.observationId,results:input.requests.map(request=>({equivalent,source:request.source,target:{sessionId:sid,observationId:input.observationId,actionId:request.actionId},reason:'owned-proof',evidence:[],invalidatedBy:[],identityAuthorized:false,replayAuthorized:false,currentExecution:false}))}))} as unknown as ExplorerHost;
  const store=new ExplorerStore(filename),plugin=new ExplorerPlugin(host,store),task=plugin.create({url,coverageMode:'all'}),key=schedulingKeyFor(action,before);
  task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:attempt.startedAt,status:'paused',actions:1,stack:[],entryPath:[],reentries:[],tried:[key],reviewed:[],noProgress:0}];
  const item:PlanItem={id:'operation',title:'Open',scope:scopeFor(action,before),prerequisites:[],completion:'Verify retained source',required:true,dispatchScope:false,status:'unresolved',reason:'observed_in_scope',operationConditionPolicy:'browser-operation-key-v3',operationConditionKey:key,evidence:[{sessionId:'session',observationId:'before'}],attempts:[]};
  const root:PlanItem={id:'root',title:'Page',scope:{url},prerequisites:[],completion:'Explore',required:true,dispatchScope:true,status:'pending',reason:'program_exhaustive_root',evidence:[],attempts:[]};task.plan=[root,item];
  const runtime=plugin as unknown as {recordOutcome(task:Task,attempt:ActionAttempt,ids:string[]):void;reconcileConditionCompletions(task:Task):number;settleScopes(task:Task,o:Observation,incomplete:Set<string>,operationsOnly:boolean):void;gap(task:Task,reason:string,scope:PlanItem['scope'],required:boolean,path:PlanItem['prerequisites'],persist:boolean,o:Observation,key:string):PlanItem};
  return {host,plugin,store,task,item,root,before,after,action,attempt,attempts,query,observations,actions,runtime,
    verify:(value=true,policy:typeof status='document')=>{verified=value;status=policy;},equivalent:()=>{equivalent=true;},complete:()=>runtime.recordOutcome(task,attempt,[item.id]),close:()=>plugin.close()};
}

it.each(['portable','document'] as const)('accepts a stable %s receipt only under the SDK policy and memoizes within this completion',async policy=>{
  const f=fixture();try{f.verify(true,policy);f.complete();expect(f.item.status).toBe('succeeded');expect(f.item.conditionCompletion?.status).toBe('verified');expect(f.query).toHaveBeenCalledTimes(1);
    f.verify(false);expect(exactSourceExecution(f.host,f.task,f.before)(f.action)).toBe(false);expect(f.query).toHaveBeenCalledTimes(2);
  }finally{await f.close();}
});

it('does not count a missing SDK capability or a mismatched actual supplied value as condition proof',async()=>{
  const f=fixture();try{
    f.verify();f.attempt.action={...f.action,value:'actual'};const original=f.query.getMockImplementation()!;
    f.query.mockImplementation((sid,input)=>({...original(sid,input),source:{...original(sid,input).source,actionKey:hash(f.action)}}));
    expect(receiptConditionReader(f.host)(f.attempt)).toMatchObject({actualSuccess:true,conditionVerified:false,reason:'receipt_condition_ownership_mismatch'});
    f.query.mockImplementation(original);expect(receiptConditionReader(f.host)(f.attempt).conditionVerified).toBe(true);
    f.host.operationReceiptCondition=undefined;expect(receiptConditionReader(f.host)(f.attempt)).toMatchObject({actualSuccess:true,conditionVerified:false});
  }finally{await f.close();}
});

it('does not reuse a synchronous receipt memo after an actual status/value change or a new query',async()=>{
  const f=fixture();try{f.verify();const read=receiptConditionReader(f.host);expect(read(f.attempt).conditionVerified).toBe(true);expect(read(f.attempt).conditionVerified).toBe(true);expect(f.query).toHaveBeenCalledTimes(1);
    f.attempt.status='unknown';expect(read(f.attempt).conditionVerified).toBe(false);expect(f.query).toHaveBeenCalledTimes(2);
    f.attempt.status='succeeded';f.verify(false);expect(receiptConditionReader(f.host)(f.attempt).conditionVerified).toBe(false);
  }finally{await f.close();}
});

it('does not report stale actual success when the owned SDK receipt has become unknown',async()=>{
  const f=fixture();try{f.verify();const original=f.query.getMockImplementation()!;f.query.mockImplementation((sid,input)=>({...original(sid,input),actualSuccess:false,conditionVerified:false,reason:'unknown_execution_outcome'}));
    expect(receiptConditionReader(f.host)(f.attempt)).toMatchObject({actualSuccess:false,conditionVerified:false});
  }finally{await f.close();}
});

it.each(['succeeded','unknown','executing'] as const)('rechecks an old completed task after restart with a %s receipt without starting a session or refreshing its debt',async status=>{
  const dir=mkdtempSync(join(tmpdir(),'owned-receipt-restart-')),path=join(dir,'task.sqlite'),f=fixture(path);
  try{
    f.complete();f.item.status='succeeded';delete f.item.conditionCompletion;f.root.status='succeeded';f.task.status='completed';
    f.task.routeRetries={version:1,routes:{opaque:{conditions:{old:{attempts:1,outcome:'unverified'}}}}} as unknown as Task['routeRetries'];
    f.task.obligations={entries:[{itemId:f.item.id,state:'resolved'}]} as unknown as Task['obligations'];
    (f.task as unknown as {exhaustive:boolean}).exhaustive=true;
    const retained={evidence:structuredClone(f.item.evidence),attempts:structuredClone(f.item.attempts),resolvedBy:structuredClone(f.item.resolvedBy),tried:structuredClone(f.task.rounds[0].tried),debt:structuredClone(f.task.routeRetries)};
    f.store.save(f.task);await f.close();f.attempt.status=status;
    const restarted=new ExplorerPlugin(f.host,new ExplorerStore(path));try{
      const task=restarted.start(f.task.id),item=task.plan.find(item=>item.id===f.item.id)!;
      expect(task).toMatchObject({status:'blocked',reason:'operation_conditions_unverified',exhaustive:false});expect(task.obligations).toBeUndefined();
      expect(item).toMatchObject({status:'unresolved',conditionCompletion:{status:'unverified',waiting:true}});
      expect({evidence:item.evidence,attempts:item.attempts,resolvedBy:item.resolvedBy,tried:task.rounds[0].tried,debt:task.routeRetries}).toEqual(retained);
      expect(f.attempt.status).toBe(status);expect(f.host.createSession).not.toHaveBeenCalled();
      const projection=projectObligations(f.host,task,f.before,[f.action]).projection;
      expect(projection.entries.find(e=>e.itemId==='root')?.state).toBe('authority');expect(projection.entries.find(e=>e.itemId===item.id)?.state).toBe('waiting');
    }finally{await restarted.close();}
  }finally{await f.close();rmSync(dir,{recursive:true,force:true});}
});

it('holds only the old obligation, keeps a new source independent, and lets complete SDK evidence settle the waiting source',async()=>{
  const f=fixture();try{
    f.complete();expect(schedulableObligation(f.item)).toBe(false);expect(schedulableObligation(f.root)).toBe(true);
    const oldRefs=structuredClone(f.item.evidence),next={...structuredClone(f.before),id:'next'};
    f.observations.set(next.id,next);const nextAction={...f.action,id:'next-action',observationId:next.id};f.actions.set(next.id,[nextAction]);
    const independent=f.runtime.gap(f.task,f.item.reason,f.item.scope,true,[],false,next,f.item.operationConditionKey!);
    expect(independent.id).not.toBe(f.item.id);expect(schedulableObligation(independent)).toBe(true);expect(f.item.evidence).toEqual(oldRefs);
    f.verify();f.equivalent();const peer={...f.attempt,id:'proved-peer-receipt',beforeId:next.id,action:nextAction};f.attempts.push(peer);
    const original=f.query.getMockImplementation()!;f.query.mockImplementation((sid,input)=>input.attemptId===f.attempt.id?{...original(sid,input),conditionVerified:false,status:'unavailable',reason:'dispatch_witness_missing'}:original(sid,input));
    const peerRef={sessionId:'session',observationId:peer.afterId!,attemptId:peer.id},related={...structuredClone(independent),id:'proved-current',status:'succeeded' as const,resolvedBy:peerRef,evidence:[...independent.evidence,peerRef],attempts:[{roundId:'round',outcome:'succeeded',evidence:peerRef}]};f.task.plan.push(related);
    f.runtime.settleScopes(f.task,f.after,new Set(),true);
    expect(f.item.status).toBe('succeeded');expect(f.item.conditionCompletion).toMatchObject({status:'verified'});expect(f.item.evidence).toEqual(oldRefs);
    const retained=structuredClone({resolvedBy:f.item.resolvedBy,evidence:f.item.evidence,attempts:f.item.attempts,tried:f.task.rounds[0].tried});
    expect(f.item.resolvedBy?.attemptId).toBe(f.attempt.id);expect(f.item.coverageResolvedBy?.relatedItemIds).toContain(related.id);
    f.runtime.reconcileConditionCompletions(f.task);expect(f.item.status).toBe('succeeded');
    expect({resolvedBy:f.item.resolvedBy,evidence:f.item.evidence,attempts:f.item.attempts,tried:f.task.rounds[0].tried}).toEqual(retained);
    peer.status='unknown';f.runtime.reconcileConditionCompletions(f.task);expect(f.item.status).toBe('unresolved');expect(peer.status).toBe('unknown');
    peer.status='succeeded';f.task.plan=f.task.plan.filter(item=>item.id!==related.id);f.runtime.reconcileConditionCompletions(f.task);expect(f.item.status).toBe('unresolved');expect(f.item.conditionCompletion?.reason).toBe('related_coverage_receipt_missing');
    expect({resolvedBy:f.item.resolvedBy,evidence:f.item.evidence,attempts:f.item.attempts,tried:f.task.rounds[0].tried}).toEqual(retained);
  }finally{await f.close();}
});

it('explicit supplement releases only waiting, retaining the old uncertainty and all original sources',async()=>{
  const f=fixture();try{f.complete();f.store.save(f.task);const refs=structuredClone(f.item.evidence),diagnostic=f.item.conditionCompletion!.reason;
    const revised=f.plugin.revise(f.task.id,{itemIds:[f.item.id]},true),item=revised.plan.find(item=>item.id===f.item.id)!;
    expect(item.conditionCompletion).toMatchObject({status:'unverified',reason:diagnostic,waiting:false});expect(item.evidence).toEqual(refs);expect(schedulableObligation(item)).toBe(true);
    expect(operationSourceCompletion(f.host,f.attempt)(item)).toBe(false);
  }finally{await f.close();}
});

it('does not reopen required parent scope for an unselected old completion without condition proof',async()=>{
  const f=fixture();try{
    f.complete();f.item.status='succeeded';delete f.item.conditionCompletion;f.item.required=false;f.root.status='succeeded';f.task.exhaustive=false;
    const retained=structuredClone({root:f.root,scope:f.item.scope,required:f.item.required,evidence:f.item.evidence,attempts:f.item.attempts,tried:f.task.rounds[0].tried});
    f.runtime.reconcileConditionCompletions(f.task);
    expect(f.item).toMatchObject({status:'unresolved',required:false,conditionCompletion:{status:'unverified'}});expect(f.task.exhaustive).toBe(false);
    expect({root:f.root,scope:f.item.scope,required:f.item.required,evidence:f.item.evidence,attempts:f.item.attempts,tried:f.task.rounds[0].tried}).toEqual(retained);
    expect(projectObligations(f.host,f.task,f.before,[f.action]).projection.entries.find(e=>e.itemId===f.item.id)?.state).toBe('excluded');
    f.task.status='completed';f.store.save(f.task);expect(()=>f.plugin.start(f.task.id)).toThrow('PLAN_ALREADY_COMPLETE');expect(f.host.createSession).not.toHaveBeenCalled();
  }finally{await f.close();}
});

it('rechecks a revoked receipt during final round audit and cannot regain success through a stale cross-source answer',async()=>{
  const f=fixture();try{
    f.verify();f.complete();expect(f.item.status).toBe('succeeded');f.verify(false);f.equivalent();f.task.status='running';
    const runtime=f.plugin as unknown as {assertRecoveryOutcomes(task:Task):void;retainHostLimitations():Promise<void>;reconcileReviewLedger():Promise<void>;finishRound(task:Task,round:Task['rounds'][number],signal:AbortSignal):Promise<boolean>};
    vi.spyOn(runtime,'assertRecoveryOutcomes').mockImplementation(()=>{});vi.spyOn(runtime,'retainHostLimitations').mockResolvedValue(undefined);vi.spyOn(runtime,'reconcileReviewLedger').mockResolvedValue(undefined);
    f.host.explorationSnapshot=(()=>({revision:'owned',actions:[],operationCandidates:[],availability:{sessionId:'session',observationId:'after',actions:[]},obligations:{criticalGaps:[],regions:[],pageTraversal:false,classifications:[],operations:[],identities:[],discovery:[]},explorationAudit:{},completionAudit:{}})) as unknown as ExplorerHost['explorationSnapshot'];
    expect(await runtime.finishRound(f.task,f.task.rounds[0],new AbortController().signal)).toBe(false);
    expect(f.item.status).toBe('unresolved');expect(f.task.status).not.toBe('completed');expect(f.item.attempts[0].outcome).toBe('succeeded');
    expect(f.store.events(f.task.id).some(event=>event.type==='task.completed')).toBe(false);
  }finally{await f.close();}
});

it('completion rechecking cannot revive an excluded or transferred old obligation',async()=>{
  const f=fixture();try{f.complete();f.item.status='excluded';const prior=structuredClone(f.item);f.runtime.reconcileConditionCompletions(f.task);expect(f.item).toEqual(prior);
    expect(projectObligations(f.host,f.task,f.before,[f.action]).projection.entries.find(e=>e.itemId===f.item.id)?.state).toBe('excluded');
    f.item.status='unresolved';f.item.required=false;expect(projectObligations(f.host,f.task,f.before,[f.action]).projection.entries.find(e=>e.itemId===f.item.id)?.state).toBe('excluded');
    f.item.required=true;f.item.attempts.push({roundId:'round',outcome:'unknown'});expect(projectObligations(f.host,f.task,f.before,[f.action]).projection.entries.find(e=>e.itemId===f.item.id)).toMatchObject({state:'active',reason:'execution_result_unresolved'});
    f.item.status='superseded';const transferred=structuredClone(f.item);f.runtime.reconcileConditionCompletions(f.task);expect(f.item).toEqual(transferred);
  }finally{await f.close();}
});

it('cannot hide a legacy completion with missing receipts behind a current scheduling alias',async()=>{
  const f=fixture();try{f.item.status='succeeded';f.runtime.reconcileConditionCompletions(f.task);
    f.host.explorationTargetCorrespondences=vi.fn(()=>{throw Error('Unverified completion must not be aliased');});
    expect(projectObligations(f.host,f.task,f.before,[f.action]).projection.entries.find(e=>e.itemId===f.item.id)).toMatchObject({state:'waiting',reason:'operation_conditions_unverified'});
    expect(f.host.explorationTargetCorrespondences).not.toHaveBeenCalled();
  }finally{await f.close();}
});
