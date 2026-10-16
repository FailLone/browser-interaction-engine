import {expect,it} from 'vitest';
import {join} from 'node:path';
import {ExplorerPlugin,ExplorerStore,type Round,type Task} from '@interaction/explorer-plugin';
import {observedPosition,reconcileRecoveryPosition} from '../packages/explorer-plugin/src/navigation-state.js';
import {explorerFixture} from './explorer-plugin-helpers.js';

it('persists the actual same-URL position after a partial failed return without dropping the pending branch',async()=>{
 const f=await explorerFixture('<button id="open" onclick="document.querySelector(\'#branch\').hidden=false">Open</button><section id="branch" hidden><button>Child</button></section>');
 const path=join(f.dir,'navigation-position.sqlite');let plugin=new ExplorerPlugin(f.host,new ExplorerStore(path));
 try{
  const s=await f.host.createSession({url:f.url,headless:true,settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]});
  const before=f.host.observation(s.id),cp=await f.host.createCheckpoint(s.id,'Parent'),entry={url:f.url,label:'Open',kind:'click'};
  const round:Round={id:'r',number:1,sessionId:s.id,startedAt:new Date().toISOString(),status:'paused',actions:0,
   stack:[{checkpointId:cp.id,observationId:before.id,stateId:before.stateId,path:[],used:[],remaining:[{url:f.url,label:'Child',kind:'click'}]}],
   entryPath:[entry],reentries:[],tried:[],reviewed:[],noProgress:0,position:observedPosition(before)};
  const task=plugin.create({url:f.url});task.rounds=[round];
  task.plan=[{id:'child',title:'Child',scope:{url:f.url,label:'Child',kind:'click'},prerequisites:[entry],completion:'Observed execution',status:'unresolved',required:true,dispatchScope:false,reason:'operation_not_executed',evidence:[{sessionId:s.id,observationId:before.id}],attempts:[]}];
  const action=f.host.actions(s.id).find(a=>a.label==='Open')!;
  const partial=await f.host.execute(s.id,action.id,'partial-return'),after=f.host.observation(s.id);
  expect(after.url).toBe(before.url);expect(after.instanceScope).toBe(before.instanceScope);
  const result=reconcileRecoveryPosition(round,before,after,{status:'UNVERIFIED',attemptIds:[partial.id]});
  expect(result).toMatchObject({reason:'recovery_moved_browser',pathVerified:false,checkpointVerified:false});
  expect(round.entryPath).toEqual([]);expect(round.stack).toHaveLength(1);expect(round.position?.observationId).toBe(after.id);
  plugin.store.save(task);await plugin.close();plugin=new ExplorerPlugin(f.host,new ExplorerStore(path));
  const restored=plugin.store.task(task.id);expect(restored.plan).toEqual(task.plan);expect(restored.rounds[0]).toEqual(round);
  expect(restored.plan[0].status).toBe('unresolved');
  // A no-movement verification failure must not fabricate a parent path either.
  reconcileRecoveryPosition(restored.rounds[0],after,after,{status:'UNVERIFIED',attemptIds:[]});
  expect(restored.rounds[0].entryPath).toEqual([]);expect(restored.rounds[0].stack).toHaveLength(1);
 }finally{await plugin.close();await f.close();}
});
