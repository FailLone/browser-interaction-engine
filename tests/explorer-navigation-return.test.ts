import {expect,it,vi} from 'vitest';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import type {ActionAttempt} from '@interaction/browser';
import {explorerFixture} from './explorer-plugin-helpers.js';

// The only initially visible operation is a button with no href. Returning to
// this page exposes different UI, so restoring its old modal checkpoint cannot
// honestly be reported as verified even though the accepted URL is reached.
const navigationPage=`
<button id="remaining" type="button" hidden onclick="this.disabled=true">Remaining</button>
<div role="dialog" aria-modal="true" aria-label="Wallet introduction" id="gate">
 <button id="wallet" type="button" onclick="sessionStorage.setItem('left-source','yes');location.href='/elsewhere'">GoWallet</button>
</div>
<script>
 function revealReturnedPage(){
  if(location.pathname==='/elsewhere'){document.body.innerHTML='<p>Destination</p>';return;}
  if(sessionStorage.getItem('left-source')){document.getElementById('gate')?.remove();document.getElementById('remaining').hidden=false;}
 }
 revealReturnedPage();addEventListener('pageshow',revealReturnedPage);
</script>`;

it.each([false,true])('returns from unknown-effect button navigation while retaining page obligations; unresolved execution=%s',async unknown=>{
 let requests=0;
 const returnedPage='<button id="remaining" type="button" onclick="this.disabled=true">Remaining</button><script>if(location.pathname==="/elsewhere")document.body.innerHTML="<p>Destination</p>";</script>';
 const f=await explorerFixture(()=>++requests===1?navigationPage:returnedPage),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store);
 // This suite exercises the strict-checkpoint fallback of older host contracts.
 Object.defineProperty(f.host,'returnToObservedSource',{value:undefined});
 const create=f.host.createSession.bind(f.host);
 vi.spyOn(f.host,'createSession').mockImplementation(async input=>{
  const session=await create(input),o=f.host.observation(session.id),gate=o.controls.find(c=>c.stableKey==='id:gate');
  // Known fixture container classification removes unrelated semantic-review
  // work. Its only unfinished operation is the navigation button itself.
  if(gate)await f.host.classifyControls(session.id,{observationId:o.id,source:'fixture-container',classifications:[{localId:gate.localId,classification:'container',reason:'Fixture modal container has no operation of its own',evidence:[`observation:${o.id}`]}]});
  return f.host.session(session.id);
 });
 const reach=f.host.reachCheckpoint.bind(f.host);
 const recovery=vi.spyOn(f.host,'reachCheckpoint').mockImplementation(async(sid,checkpointId)=>{
  const result=await reach(sid,checkpointId);
  // This test requires a real browser return, not a mocked observation or a
  // forged success. The changed page cannot satisfy its old modal baseline.
  expect(f.host.observation(sid).url).toBe(f.url);
  if(unknown){
   const source=f.host.list<ActionAttempt>(sid,'attempt').find(a=>a.action.label==='GoWallet')!;
   f.host.store.put('attempt',{...source,id:'unresolved-after-return',requestId:'unresolved-after-return',status:'unknown',reason:'Fixture unresolved dispatch remains after returning to the page'} satisfies ActionAttempt);
  }
  return {...result,status:'UNVERIFIED' as const,reason:'Returned to accepted page; prior modal checkpoint was not restored'};
 });
 try{
  const task=plugin.create({url:f.url,sessionOptions:{headless:true,settleMs:0,observeTimeoutMs:150},budget:{rounds:1,actions:12,modelRequests:1}});
  plugin.start(task.id);await plugin.waitForIdle();
  const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId,attempts=f.host.list<ActionAttempt>(sid,'attempt');
  expect(attempts[0]).toMatchObject({status:'succeeded',action:{label:'GoWallet',kind:'click',risk:'unknown',replayable:false}});
  expect(recovery).toHaveBeenCalledTimes(1);
  expect(view.events.find(e=>e.type==='navigation.return_required')?.data).toMatchObject({acceptedUrl:f.url,observedUrl:new URL('/elsewhere',f.url).href,scopeExpanded:false});
  expect(view.events.find(e=>e.type==='recovery.result')?.data).toMatchObject({status:'UNVERIFIED'});
  expect(view.events.filter(e=>e.type==='recovery.result').some(e=>(e.data as any).status==='REACHED_VERIFIED')).toBe(false);
  expect(view.events.find(e=>e.type==='recovery.selected')?.data).toMatchObject({unfinishedTargets:1});
  const remaining=attempts.filter(a=>a.action.label==='Remaining');
  if(unknown){
   expect(remaining).toHaveLength(0);
   expect(view.task.plan.some(i=>i.required&&i.scope.url===f.url&&i.status!=='succeeded')).toBe(true);
   expect(f.host.recoveryAssessment(sid).unknownAttempts.map(a=>a.id)).toContain('unresolved-after-return');
   expect(view.task.status).not.toBe('completed');
  }else{
   expect(view.task.plan.some(i=>i.reason==='checkpoint_unverified'&&i.status!=='succeeded'),JSON.stringify({status:view.task.status,plan:view.task.plan.map(i=>({scope:i.scope,reason:i.reason,status:i.status,required:i.required})),recoveries:view.events.filter(e=>e.type.startsWith('recovery.'))})).toBe(true);
   expect(view.events.find(e=>e.type==='recovery.observed_scope')?.data).toMatchObject({checkpointVerified:false,continueFromCurrentObservation:true});
   expect(remaining,JSON.stringify({reason:view.task.reason,attempts:attempts.map(a=>[a.action.label,a.status]),events:view.events.slice(-12)})).toHaveLength(1);expect(remaining[0].status).toBe('succeeded');
   expect(view.task.plan.some(i=>i.scope.label==='Remaining'&&i.status==='succeeded')).toBe(true);
  }
  expect(view.task.usage.modelRequests).toBe(0);
 }finally{await plugin.close();await f.close();}
});
