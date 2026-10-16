import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it,vi} from 'vitest';
import {BrowserEngine,type ActionAttempt} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerPlugin,ExplorerStore,type Round,type Task} from '@interaction/explorer-plugin';
import {observedPosition} from '../packages/explorer-plugin/src/navigation-state.js';
import {POLICY_VERSION} from '../packages/explorer-plugin/src/decision-policy.js';
import {routeRetryEligibility} from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import {pageOf} from './helpers.js';

async function fixture(){
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(req.url==='/elsewhere'?'<main><p>Elsewhere</p></main>':'<main><a href="/elsewhere">Leave</a></main>');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`,dir=mkdtempSync(join(tmpdir(),'explorer-recovery-outcomes-'));
 const host=new BrowserEngine({persistence:new SqliteStore(join(dir,'host')),hooks:{verifyExternalRecovery:()=>({result:'pass',evidence:['Local fixture recovery state independently verified']})}});
 const session=await host.createSession({url,headless:true,settleMs:0,observeTimeoutMs:100,executionPolicy:'interface-only',exploration:'controls',regionExploration:'off',pageExploration:'all',listExploration:'all'});
 const source=host.observation(session.id),checkpoint=await host.createCheckpoint(session.id,'Source');
 const leave=await host.execute(session.id,host.actions(session.id).find(a=>a.label==='Leave')!.id,'leave');
 expect(leave.status).toBe('succeeded');const current=host.observation(session.id);
 const path=join(dir,'plugin.sqlite');let plugin=new ExplorerPlugin(host,new ExplorerStore(path));
 const task=plugin.create({url,budget:{rounds:5,actions:20}}),round:Round={id:'r',number:1,sessionId:session.id,startedAt:new Date().toISOString(),status:'running',actions:1,
  stack:[{checkpointId:checkpoint.id,observationId:source.id,stateId:source.stateId,path:[{url,label:'Source path'}],used:[],remaining:[{url}]}],
  entryPath:[{url:current.url,label:'Current path'}],position:observedPosition(current),reentries:[],tried:[],reviewed:[],noProgress:0};
 task.rounds=[round];task.status='running';task.plan=[{id:'root',title:'Source page',scope:{url},prerequisites:[],completion:'Observe all source work',required:true,dispatchScope:true,status:'unresolved',reason:'user_goal',evidence:[],attempts:[]}];plugin.store.save(task);
 const runtime=()=>plugin as unknown as {step(t:Task,r:Round,s:AbortSignal):Promise<boolean>;assertRecoveryOutcomes(t:Task):void};
 return {host,url,task,round,leave,source,current,runtime,get plugin(){return plugin;},restart:async()=>{await plugin.close();plugin=new ExplorerPlugin(host,new ExplorerStore(path));},
  close:async()=>{await plugin.close();await host.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));rmSync(dir,{recursive:true,force:true});}};
}

it('blocks strict checkpoint fallback before recovery when an earlier recovery result is unknown',async()=>{
 const f=await fixture();try{
  // Crash-ledger fault after a real navigation; this operation is not represented
  // by the plugin's pendingDispatch because the SDK owns recovery attempts.
  f.host.store.put('attempt',{...f.leave,purpose:'recovery',status:'unknown',reason:'Recovery result not durably confirmed'} satisfies ActionAttempt);
  const checkpoint=vi.spyOn(f.host,'reachCheckpoint'),target=vi.spyOn(f.host,'reachExplorationTarget'),before=structuredClone(f.round.stack);
  await expect(f.runtime().step(f.task,f.round,new AbortController().signal)).rejects.toMatchObject({code:'UNKNOWN_DISPATCH_REQUIRES_REVIEW'});
  expect(checkpoint).not.toHaveBeenCalled();expect(target).not.toHaveBeenCalled();expect(f.round.stack).toEqual(before);
  expect(f.task.unverifiedRecoveries).toEqual([{sessionId:f.leave.sessionId,observationId:f.current.id,attemptIds:[f.leave.id]}]);
  expect(f.host.list<ActionAttempt>(f.leave.sessionId,'attempt')).toHaveLength(1);expect(f.task.plan[0].status).toBe('unresolved');
 }finally{await f.close();}
});

it('resumes the original route once after explicit source verification and retains a failed retry limit',async()=>{
 const f=await fixture();try{
  const reach=f.host.reachCheckpoint.bind(f.host);let unknownId='',initialRoute='';
  const recovery=vi.spyOn(f.host,'reachCheckpoint').mockImplementation(async(sid,id)=>{
   const result=await reach(sid,id);expect(result.status).toBe('REACHED_VERIFIED');
   unknownId=result.attemptIds.at(-1)!;const attempt=f.host.list<ActionAttempt>(sid,'attempt').find(a=>a.id===unknownId)!;
   f.host.store.put('attempt',{...attempt,status:'unknown',reason:'Recovery result unavailable'});
   return {...result,status:'UNVERIFIED'};
  });
  await expect(f.runtime().step(f.task,f.round,new AbortController().signal)).rejects.toMatchObject({code:'UNKNOWN_DISPATCH_REQUIRES_REVIEW'});
  initialRoute=Object.keys(f.task.routeRetries!.routes)[0];const condition=Object.keys(f.task.routeRetries!.routes[initialRoute].conditions)[0];
  expect(routeRetryEligibility(f.task.routeRetries,initialRoute,condition)).toMatchObject({allowed:false,reason:'unknown_result'});
  const current=f.host.observation(f.leave.sessionId),verified=await f.host.continueExploration(f.leave.sessionId,{requestId:crypto.randomUUID(),observationId:current.id,source:'fixture-reviewer',evidence:['Explicit recovery review'],recovery:{url:current.url,context:current.context,boundaryKeys:[],predicates:[]}});
  await f.host.waitForIdle();expect(verified.continuation.verifiedRecovery?.attemptIds).toContain(unknownId);
  await pageOf(f.host).goto(f.current.url);await f.host.observe(f.leave.sessionId);
  // The same route is now genuinely unavailable. Drive the public plugin start
  // through its normal scheduler; clearing the task-level blocker alone is not enough.
  recovery.mockImplementation(async(sid,id)=>({id:'retry-unreachable',sessionId:sid,checkpointId:id,status:'UNREACHABLE',reason:'Fixture route is no longer available',checks:[],attemptIds:[],observationId:f.host.observation(sid).id,remainingFrontier:1}));
  f.task.status='paused';f.round.status='paused';f.round.policyVersion=POLICY_VERSION;
  f.task.sessionOptions.executionPolicy=f.host.session(f.leave.sessionId).options.executionPolicy;
  f.task.budget.rounds=1;f.task.usage.rounds=1;f.plugin.store.save(f.task);
  f.plugin.start(f.task.id);await f.plugin.waitForIdle();const resumed=f.plugin.view(f.task.id);
  expect(recovery,JSON.stringify({reason:resumed.task.reason,events:resumed.events.filter(e=>e.actor==='program').map(e=>e.type)})).toHaveBeenCalledTimes(2);expect(resumed.task.unverifiedRecoveries).toBeUndefined();
  expect(resumed.task.rounds).toHaveLength(1);expect(resumed.task.plan[0].status).not.toBe('succeeded');
  expect(Object.keys(resumed.task.routeRetries!.routes)).toEqual([initialRoute]);
  expect(routeRetryEligibility(resumed.task.routeRetries,initialRoute,condition)).toMatchObject({allowed:false,reason:'condition_attempted',attempts:2});
  const audit=resumed.task.routeRetries!.routes[initialRoute].recoveryVerifications!;
  expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({sessionId:f.leave.sessionId,attemptIds:[unknownId],consumedBy:{conditionVersion:condition}});
  expect(audit[0].unknownRecords[0].record).toMatchObject({outcome:'unknown',unknownSource:{sessionId:f.leave.sessionId,attemptIds:[unknownId]}});
  expect(audit[0].continuations.map(c=>c.id)).toContain(verified.continuation.id);
  expect(resumed.events.filter(e=>e.type==='recovery.route_retry_released')).toHaveLength(1);
  expect(resumed.events.filter(e=>e.type==='recovery.selected')).toHaveLength(2);
  expect(resumed.events.filter(e=>e.type==='recovery.result').at(-1)?.data).toMatchObject({status:'UNREACHABLE'});
  expect(f.host.list<ActionAttempt>(f.leave.sessionId,'attempt').find(a=>a.id===unknownId)?.status).toBe('unknown');
  // Re-reading/restarting against the same continuation cannot mint another retry.
  const debt=structuredClone(resumed.task.routeRetries);f.runtime().assertRecoveryOutcomes(resumed.task);
  expect(resumed.task.routeRetries).toEqual(debt);expect(routeRetryEligibility(resumed.task.routeRetries,initialRoute,condition).allowed).toBe(false);
  resumed.task.status='paused';resumed.task.rounds[0].status='paused';f.plugin.store.save(resumed.task);await f.restart();
  f.plugin.start(f.task.id);await f.plugin.waitForIdle();const restarted=f.plugin.view(f.task.id);
  expect(recovery).toHaveBeenCalledTimes(2);expect(restarted.task.routeRetries).toEqual(debt);
  expect(restarted.events.filter(e=>e.type==='recovery.route_retry_released')).toHaveLength(1);
 }finally{await f.close();}
});

it('rediscovers a recovery crash from its source session before starting a new round without pendingDispatch',async()=>{
 const f=await fixture();try{
  f.host.store.put('attempt',{...f.leave,purpose:'recovery',status:'unknown',reason:'Process stopped before plugin received recovery result'} satisfies ActionAttempt);
  expect(f.task.pendingDispatch).toBeUndefined();expect(f.task.unverifiedRecoveries).toBeUndefined();
  f.round.policyVersion='old-policy';f.plugin.store.save(f.task);await f.restart();
  const create=vi.spyOn(f.host,'createSession'),observe=vi.spyOn(f.host,'observe');
  f.plugin.start(f.task.id);await f.plugin.waitForIdle();const restored=f.plugin.view(f.task.id).task;
  expect(restored).toMatchObject({status:'blocked',reason:'UNKNOWN_DISPATCH_REQUIRES_REVIEW'});expect(create).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();
  expect(restored.unverifiedRecoveries?.[0].attemptIds).toEqual([f.leave.id]);expect(restored.rounds).toHaveLength(1);
 }finally{await f.close();}
});

it.each(['REACHED_VERIFIED','UNVERIFIED'] as const)('retains actual position and unknown recovery debt even when the host returns %s',async(status)=>{
 const f=await fixture();try{
  const reach=f.host.reachCheckpoint.bind(f.host);let unknownId='';
  vi.spyOn(f.host,'reachCheckpoint').mockImplementation(async(sid,id)=>{
   const result=await reach(sid,id);expect(result.status).toBe('REACHED_VERIFIED');
   unknownId=result.attemptIds.at(-1)!;expect(unknownId).toBeTruthy();
   const attempt=f.host.list<ActionAttempt>(sid,'attempt').find(a=>a.id===unknownId)!;
   // A late durable-result fault must dominate a UI-only checkpoint result.
   f.host.store.put('attempt',{...attempt,status:'unknown',reason:'Recovery result unavailable'});
   return {...result,status};
  });
  const frame=f.round.stack[0],plan=structuredClone(f.task.plan);
  await expect(f.runtime().step(f.task,f.round,new AbortController().signal)).rejects.toMatchObject({code:'UNKNOWN_DISPATCH_REQUIRES_REVIEW'});
  expect(f.host.observation(f.leave.sessionId).url).toBe(f.url);expect(f.round.position?.observationId).toBe(f.host.observation(f.leave.sessionId).id);
  expect(f.round.entryPath).toEqual([]);expect(f.round.stack).toEqual([frame]);expect(f.task.plan).toEqual(plan);
  expect(frame.recoveryFailure).toMatchObject({status:'invalidated',reason:'unknown_action_outcome'});
  expect(f.task.unverifiedRecoveries?.[0].attemptIds).toEqual([unknownId]);
  const events=f.plugin.store.events(f.task.id);expect(events.find(e=>e.type==='recovery.position_reconciled')?.data).toMatchObject({checkpointVerified:false,pathVerified:false,path:[]});
  expect(events.find(e=>e.type==='recovery.result')?.data).toMatchObject({status:'UNVERIFIED',hostResultStatus:status,checkpointVerified:false});
  expect(events.some(e=>e.type==='recovery.target_reached')).toBe(false);
  expect(events.find(e=>e.type==='recovery.blocked')?.data).toMatchObject({reason:'unknown_action_outcome',checkpointVerified:false});

  // Policy migration and an exhausted source session ordinarily create a fresh
  // round. Restart must check the original source before opening any browser.
  f.task.status='paused';f.round.status='paused';f.round.policyVersion='old-policy';f.plugin.store.save(f.task);await f.restart();
  const create=vi.spyOn(f.host,'createSession'),observe=vi.spyOn(f.host,'observe');
  f.plugin.start(f.task.id);await f.plugin.waitForIdle();const restored=f.plugin.view(f.task.id).task;
  expect(restored).toMatchObject({status:'blocked',reason:'UNKNOWN_DISPATCH_REQUIRES_REVIEW'});expect(create).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();
  expect(restored.rounds).toHaveLength(1);expect(restored.rounds[0].stack).toHaveLength(1);expect(restored.unverifiedRecoveries?.[0].attemptIds).toEqual([unknownId]);
  expect(f.host.list<ActionAttempt>(f.leave.sessionId,'attempt').find(a=>a.id===unknownId)?.status).toBe('unknown');

  // Missing original evidence stays blocked; restoration of the source permits
  // only an explicit host continuation to release the blocker.
  const read=f.host.list.bind(f.host),missing=vi.spyOn(f.host,'list').mockImplementation((sid,kind)=>kind==='attempt'?read<ActionAttempt>(sid,kind).filter(a=>a.id!==unknownId):read(sid,kind));
  expect(()=>f.runtime().assertRecoveryOutcomes(restored)).toThrow('UNKNOWN_DISPATCH_REQUIRES_REVIEW');missing.mockRestore();
  const unavailable=vi.spyOn(f.host,'recoveryAssessment').mockImplementation(()=>{throw new Error('Original recovery session unavailable');});
  expect(()=>f.runtime().assertRecoveryOutcomes(restored)).toThrow('UNKNOWN_DISPATCH_REQUIRES_REVIEW');expect(restored.unverifiedRecoveries?.[0]).toMatchObject({sourceUnavailable:true,attemptIds:[unknownId]});unavailable.mockRestore();
  const current=f.host.observation(f.leave.sessionId),verified=await f.host.continueExploration(f.leave.sessionId,{requestId:crypto.randomUUID(),observationId:current.id,source:'fixture-reviewer',evidence:['Explicit recovery review'],recovery:{url:current.url,context:current.context,boundaryKeys:[],predicates:[]}});
  await f.host.waitForIdle();expect(verified.continuation.verifiedRecovery?.attemptIds).toContain(unknownId);
  expect(()=>f.runtime().assertRecoveryOutcomes(restored)).not.toThrow();expect(restored.unverifiedRecoveries).toBeUndefined();
  expect(f.host.list<ActionAttempt>(f.leave.sessionId,'attempt').find(a=>a.id===unknownId)?.status).toBe('unknown');
 }finally{await f.close();}
});
