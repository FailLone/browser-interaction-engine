import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import type {ActionAttempt} from '@interaction/browser';
import {explorerFixture} from './explorer-plugin-helpers.js';

const page=`<button id="remaining" type="button" hidden onclick="this.disabled=true">Remaining</button>
<div role="dialog" aria-modal="true" aria-label="Introduction" id="gate">
<button id="leave" type="button" onclick="sessionStorage.setItem('left-source','yes');location.href='/elsewhere'">Leave</button></div>
<script>function update(){if(location.pathname==='/elsewhere'){document.body.innerHTML='<p>Destination</p>';return;}
if(sessionStorage.getItem('left-source')){document.getElementById('gate')?.remove();document.getElementById('remaining').hidden=false;}}
update();addEventListener('pageshow',update);</script>`;

it.each([false,true])('returns a page discovery obligation without replaying its vanished modal; late unknown=%s',async unknown=>{
 const f=await explorerFixture(page),path=join(f.dir,'source-return-plugin.sqlite');let plugin=new ExplorerPlugin(f.host,new ExplorerStore(path));
 const create=f.host.createSession.bind(f.host);
 vi.spyOn(f.host,'createSession').mockImplementation(async options=>{
  const session=await create({...options as any,contextRules:[]}),o=f.host.observation(session.id),gate=o.controls.find(c=>c.stableKey==='id:gate');
  if(gate)await f.host.classifyControls(session.id,{observationId:o.id,source:'fixture-container',classifications:[{localId:gate.localId,classification:'container',reason:'The fixture modal is a container',evidence:[`observation:${o.id}`]}]});
  return f.host.session(session.id);
 });
 const strict=vi.spyOn(f.host,'reachCheckpoint'),target=vi.spyOn(f.host,'reachExplorationTarget'),reach=f.host.returnToObservedSource.bind(f.host);let unknownId='';
 const returned=vi.spyOn(f.host,'returnToObservedSource').mockImplementation(async(sid,input)=>{
  const result=await reach(sid,input);expect(result).toMatchObject({status:'SOURCE_REACHED',checkpointVerified:false,sourceStateRestored:false,currentExecution:false,executionAuthorized:false});
  expect(f.host.observation(sid).canonical).not.toBe(f.host.observation(sid,input.observationId).canonical);
  if(unknown){unknownId=result.attemptIds[0];const attempt=f.host.list<ActionAttempt>(sid,'attempt').find(a=>a.id===unknownId)!;f.host.store.put('attempt',{...attempt,status:'unknown',reason:'Injected durable-result fault after native return'});}
  return result;
 });
 try{
  const task=plugin.create({url:f.url,sessionOptions:{headless:true,settleMs:0,observeTimeoutMs:500},budget:{rounds:2,actions:12,modelRequests:1}});
  plugin.start(task.id);await plugin.waitForIdle();const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId,attempts=f.host.list<ActionAttempt>(sid,'attempt');
  expect(returned).toHaveBeenCalledTimes(1);expect(strict).not.toHaveBeenCalled();expect(target).not.toHaveBeenCalled();
  expect(attempts.filter(a=>a.purpose==='recovery').map(a=>a.action.kind)).toEqual(['history']);expect(attempts.some(a=>a.action.source==='recovery-entry')).toBe(false);
  expect(view.events.find(e=>e.type==='recovery.selected')?.data).toMatchObject({arrivalMode:'observed-source',unfinishedTargets:1});
  const remaining=attempts.filter(a=>a.action.label==='Remaining');
  if(unknown){
   expect(remaining).toEqual([]);expect(view.events.find(e=>e.type==='recovery.result')?.data).toMatchObject({status:'UNVERIFIED',hostResultStatus:'SOURCE_REACHED',checkpointVerified:false});
   expect(view.task.unverifiedRecoveries?.[0].attemptIds).toContain(unknownId);expect(view.events.some(e=>e.type==='recovery.source_reached')).toBe(false);
   const debts=structuredClone(view.task.routeRetries);await plugin.close();await f.host.stop(sid);plugin=new ExplorerPlugin(f.host,new ExplorerStore(path));
   const observe=vi.spyOn(f.host,'observe'),createAgain=vi.mocked(f.host.createSession);createAgain.mockClear();returned.mockClear();
   plugin.start(task.id);await plugin.waitForIdle();const after=plugin.store.task(task.id);
   expect(after.reason).toBe('UNKNOWN_DISPATCH_REQUIRES_REVIEW');expect(after.routeRetries).toEqual(debts);expect(after.rounds).toHaveLength(1);
   expect(observe).not.toHaveBeenCalled();expect(createAgain).not.toHaveBeenCalled();expect(returned).not.toHaveBeenCalled();
  }else{
   expect(remaining).toHaveLength(1);expect(remaining[0].status).toBe('succeeded');
   expect(view.events.find(e=>e.type==='recovery.source_reached')?.data).toMatchObject({checkpointVerified:false,sourceStateRestored:false,currentExecution:false,executionAuthorized:false});
   expect(view.events.find(e=>e.type==='recovery.position_reconciled')?.data).toMatchObject({checkpointVerified:false,pathVerified:false,path:[]});
   const recoveryIds=new Set(attempts.filter(a=>a.purpose==='recovery').map(a=>a.id));
   expect(view.task.plan.some(item=>item.resolvedBy?.attemptId&&recoveryIds.has(item.resolvedBy.attemptId))).toBe(false);
  }
 }finally{await plugin.close();await f.close();}
});
