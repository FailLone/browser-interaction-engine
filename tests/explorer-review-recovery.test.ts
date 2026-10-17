import { expect,it,vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { classificationCorrespondenceConditions, type ActionCandidate, type Checkpoint, type Control, type Observation } from '@interaction/browser';
import { ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Task } from '@interaction/explorer-plugin';
import { reviewRecoveryChanges,reviewRecoveryMaterialKey,prioritizeReviewAnchors,validReviewRecoveryWait } from '../packages/explorer-plugin/src/review-recovery.js';
import { scopeForControl } from '../packages/explorer-plugin/src/policy.js';
import { explorerFixture,fakeProviders } from './explorer-plugin-helpers.js';
import { pageOf } from './helpers.js';

const url='https://fixture.invalid/source';
function observation(id:string,instance=id,browserSessionId=instance):Observation {
 const c:Control={localId:`${instance}:target`,instanceId:`${instance}:target`,identityId:'retained-id',tag:'div',role:'generic',name:'Preference',label:'',region:'dialog',form:'',selector:'#target',rect:{x:0,y:0,width:20,height:20},
  value:'',displayedText:'Preference',checked:null,selected:[],visible:true,enabled:true,editable:false,expanded:null,controls:null,constraints:{type:'div',required:false,valid:true},options:[],actions:[],discovery:[],actionBasis:{},
  identityContext:{scope:'owner:dialog',binding:'preference',evidence:['captured-owner']},
  actionable:{visible:true,enabled:true,editable:false,hitTarget:true,unknown:[]},
  reviewBinding:{parentInstanceId:`${instance}:parent`,attributes:{class:'wrapper'}},reviewReuseBinding:{ancestors:[{tag:'section',selector:'#section',attributes:{id:'section'},label:'Settings'}]},
  classificationBinding:{truncated:false,text:'Preference',nodes:[{instanceId:`${instance}:target`,parentInstanceId:`${instance}:parent`,tag:'div',attributes:{class:'wrapper'}},{instanceId:`${instance}:text`,parentInstanceId:`${instance}:target`,tag:'span',attributes:{}}],references:[]}};
 return {id,sessionId:'session',instanceScope:instance,documentId:instance,url,ruleVersion:'observable-v7',context:{},stable:true,gaps:[],controls:[c],regions:[{key:'dialog',label:'Settings',role:'dialog',selector:'#dialog',text:'',rect:c.rect}],boundaries:[],overlays:[],canonical:id,stateId:id,navigation:{browserSessionId,currentIndex:0,entries:[{id:1,url,method:'GET'}]}} as unknown as Observation;
}
function fixture() {
 const original=observation('original'),current=observation('current','new','browser'),observations=new Map([original,current].map(o=>[o.id,o]));
 const store=new ExplorerStore(':memory:'),events=new EventEmitter(),actions:ActionCandidate[]=[];
 let active=current,unknown=false,executable=false;
 const material=()=>({sessionId:'session',observationId:active.id,controls:active.controls.map(control=>({control,actions:actions.filter(a=>a.localId===control.localId),reviews:[],needsReview:true,surroundings:{version:'control-surroundings/v1',key:'missing-owner',ownerInstanceId:'owner',complete:false,truncated:false,reasons:['owner_too_distant'],nodes:[],controls:[]}}))});
 const host={events,session:()=>({id:'session',options:{},actionCount:0,currentObservationId:active.id}),observation:(_sid:string,id?:string)=>{const o=id?observations.get(id):active;if(!o)throw Error('missing source');return o;},
  actions:()=>actions,recoveryAssessment:()=>({unknownAttempts:unknown?[{id:'unknown'}]:[],blockingBoundaryExit:undefined}),controlReviewMaterial:material,
  actionAvailability:()=>({observationId:active.id,revision:'fixture-revision',actions:actions.map(a=>({actionId:a.id,executable,blockers:[]}))}),pinEvidence:vi.fn(async()=>[]),
  list:()=>[],interactionTransition:()=>({retainedControls:[]})} as unknown as ExplorerHost;
 const plugin=new ExplorerPlugin(host,store),task=plugin.create({url,coverageMode:'all'});
 const item:PlanItem={id:'review',title:'Review Preference',scope:scopeForControl(original.controls[0],original),prerequisites:[],completion:'Review observed target',status:'unresolved',required:true,dispatchScope:false,reason:'classification_unresolved',evidence:[{sessionId:'session',observationId:original.id}],attempts:[]};
 task.plan=[{...structuredClone(item),id:'authority',scope:{url},dispatchScope:true,reason:'accepted scope'},item];task.status='running';task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:new Date().toISOString(),status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
 const apply=(changes=reviewRecoveryChanges(task,active,host,{checkpointId:'current-checkpoint'}))=>{for(const c of changes){const i=task.plan.find(i=>i.id===c.itemId)!;if(c.source)i.evidence.push(c.source);if(c.wait)i.reviewRecoveryWait=c.wait;else if(c.clearWait)delete i.reviewRecoveryWait;}return changes;};
 return {original,current,observations,task,item,host,plugin,actions,material,apply,setActive(o:Observation){active=o;observations.set(o.id,o);},setUnknown(){unknown=true;},setExecutable(){executable=true;},close:()=>plugin.close()};
}

it('retains an SDK-proved current review source without changing authority, debt, coverage or attempts',async()=>{
 const f=fixture();try{
  f.task.routeRetries={version:1,routes:{legacy:{attempts:[],unknownSources:[]}}} as any;
  const debt=JSON.stringify(f.task.routeRetries),before=JSON.stringify({...f.item,evidence:[]});
  const changes=f.apply();expect(changes).toHaveLength(1);expect(changes[0].proof).toMatchObject({policy:'classification-correspondence/v1',source:{observationId:'original'}});
  expect(f.item.evidence.map(e=>e.observationId)).toEqual(['original','current']);expect(JSON.stringify({...f.item,evidence:[]})).toBe(before);expect(JSON.stringify(f.task.routeRetries)).toBe(debt);
 }finally{await f.close();}
});

it.each(['owner','duplicate','incomplete-rival','unknown-context','truncated','hypothesis','background'] as const)('does not rebind same-name review work using %s evidence',async change=>{
 const f=fixture();try{
  const c=f.current.controls[0];
  if(change==='owner')c.reviewReuseBinding!.ancestors[0].attributes.id='other-owner';
  if(change==='duplicate'||change==='incomplete-rival'){const rival=structuredClone(c);rival.localId='rival';rival.instanceId='rival';if(change==='incomplete-rival')rival.classificationBinding!.truncated=true;f.current.controls.push(rival);}
  if(change==='unknown-context')f.original.context={account:{status:'unknown',value:null,source:'test'}};
  if(change==='truncated')c.classificationBinding!.truncated=true;
  if(change==='hypothesis')c.hypothesisId='unresolved-identity';
  if(change==='background'){f.current.boundaries=[{key:'modal'}] as any;f.current.overlays=[{key:'modal',controlIds:['other']}] as any;}
  expect(f.apply()).toEqual([]);expect(f.item.evidence).toHaveLength(1);
 }finally{await f.close();}
});

it('does not turn unknown execution or pending dispatch into a new review source',async()=>{
 const f=fixture();try{f.setUnknown();expect(f.apply()).toEqual([]);}finally{await f.close();}
 const g=fixture();try{g.task.pendingDispatch={requestId:'pending'} as any;expect(g.apply()).toEqual([]);}finally{await g.close();}
});

it('binds a negative review to captured missing facts, not capture IDs; changes and executable work release it',async()=>{
 const f=fixture();try{
  const changes=f.apply(reviewRecoveryChanges(f.task,f.current,f.host,{rejected:[{localId:f.current.controls[0].localId,decisionId:'negative',kind:'probe'}]}));
  expect(changes[0].wait?.decisions).toEqual([{id:'negative',kind:'probe'}]);expect(f.item.status).toBe('unresolved');expect(f.item.attempts).toEqual([]);
  const next=structuredClone(f.current);next.id='new-capture';f.setActive(next);expect(f.apply(reviewRecoveryChanges(f.task,next,f.host))).toEqual([]);expect(f.item.reviewRecoveryWait).toBeDefined();
  next.controls[0].readiness={status:'unstable',reason:'dependency changed'};expect(f.apply(reviewRecoveryChanges(f.task,next,f.host))).toContainEqual({itemId:'review',clearWait:true});expect(f.item.reviewRecoveryWait).toBeUndefined();
  delete next.controls[0].readiness;f.apply(reviewRecoveryChanges(f.task,next,f.host,{rejected:[{localId:next.controls[0].localId,decisionId:'negative-2',kind:'probe'}]}));
  f.actions.push({id:'new-action',sessionId:'session',observationId:next.id,localId:next.controls[0].localId,kind:'click',label:'Preference',risk:'interface',preconditions:{},basis:{status:'supported',evidence:[]}} as unknown as ActionCandidate);f.setExecutable();
  expect(f.apply()).toContainEqual({itemId:'review',clearWait:true});
 }finally{await f.close();}
});

it('keeps waits across routine revision changes only while source, browser and task meaning remain valid',async()=>{
 const f=fixture();try{
  f.apply(reviewRecoveryChanges(f.task,f.current,f.host,{rejected:[{localId:f.current.controls[0].localId,decisionId:'negative',kind:'probe'}]}));
  const away=observation('away','away-document','browser');away.url='https://fixture.invalid/away';away.controls=[];f.setActive(away);
  const read=(id:string)=>f.observations.get(id);f.task.revision++;
  expect(validReviewRecoveryWait(f.task,f.item,away,read)).toBe(true);
  away.ruleVersion='observable-v6';expect(validReviewRecoveryWait(f.task,f.item,away,read)).toBe(false);away.ruleVersion=f.current.ruleVersion;
  away.context={account:{status:'known',value:'new',source:'test'}};expect(validReviewRecoveryWait(f.task,f.item,away,read)).toBe(false);away.context={};
  expect(validReviewRecoveryWait(f.task,f.item,away,()=>({...f.current,id:'wrong-id'}))).toBe(false);
  f.task.goal='Explicit different goal';expect(validReviewRecoveryWait(f.task,f.item,away,read)).toBe(false);f.task.goal='';
  expect(validReviewRecoveryWait(f.task,f.item,away,()=>undefined)).toBe(false);
  away.navigation!.browserSessionId='new-browser';expect(validReviewRecoveryWait(f.task,f.item,away,read)).toBe(false);
 }finally{await f.close();}
});

it('does not load review material or retained observations on ordinary steps without a wait',async()=>{
 const f=fixture();try{const material=vi.spyOn(f.host,'controlReviewMaterial'),read=vi.spyOn(f.host,'observation');expect(reviewRecoveryChanges(f.task,f.current,f.host)).toEqual([]);expect(material).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();}finally{await f.close();}
});

it('ignores generated action IDs but keeps operation samples, risk, gaps and material in the wait key',()=>{
 const o=observation('one'),c=o.controls[0],a={id:'a',observationId:o.id,kind:'check',label:'Preference',value:true,risk:'interface',preconditions:{},basis:{status:'supported',evidence:[]}} as unknown as ActionCandidate;
 const material={control:c,actions:[a],reviews:[],needsReview:true},key=reviewRecoveryMaterialKey(o,material);
 expect(reviewRecoveryMaterialKey({...o,id:'another'},{...material,actions:[{...a,id:'b',observationId:'another'}]})).toBe(key);
 expect(reviewRecoveryMaterialKey(o,{...material,actions:[{...a,value:false}]})).not.toBe(key);
 expect(reviewRecoveryMaterialKey({...o,ruleVersion:'observable-v6'},material)).not.toBe(key);
 expect(reviewRecoveryMaterialKey({...o,gaps:[{code:'DISCOVERY_INCOMPLETE',message:'New missing target evidence'}]},material)).not.toBe(key);
 expect(reviewRecoveryMaterialKey(o,{...material,surroundings:{complete:false,reasons:['missing']} as any})).not.toBe(key);
});

it('prefers a currently recorded GET history anchor while retaining every old candidate',async()=>{
 const f=fixture();try{
  const away=observation('away','away','browser');away.url='https://fixture.invalid/away';away.navigation!.entries.push({id:2,url:away.url,method:'GET'});away.navigation!.currentIndex=1;
  const cp=(o:Observation)=>({id:`cp-${o.id}`,observationId:o.id}) as Checkpoint;
  expect((await prioritizeReviewAnchors([cp(f.original),cp(f.current)],away,id=>f.observations.get(id))).map(c=>c.id)).toEqual(['cp-current','cp-original']);
  away.navigation!.entries[0].method='POST';expect((await prioritizeReviewAnchors([cp(f.original),cp(f.current)],away,id=>f.observations.get(id))).map(c=>c.id)).toEqual(['cp-original','cp-current']);
 }finally{await f.close();}
});

it('does not persist a prepared wait when pinning races with a new observation',async()=>{
 const f=fixture();try{
  const changes=reviewRecoveryChanges(f.task,f.current,f.host,{rejected:[{localId:f.current.controls[0].localId,decisionId:'negative',kind:'probe'}]});
  vi.mocked(f.host.pinEvidence).mockImplementation(async()=>{f.setActive(observation('later'));return [] as never;});
  await (f.plugin as unknown as {applyReviewRecoveryChanges(task:Task,o:Observation,signal:AbortSignal,changes:unknown[]):Promise<void>}).applyReviewRecoveryChanges(f.task,f.current,new AbortController().signal,changes);
  expect(f.item.reviewRecoveryWait).toBeUndefined();expect(f.item.evidence).toHaveLength(1);
 }finally{await f.close();}
});

it('the scheduler selects the refreshed native-history checkpoint and consumes a negative wait without new route debt',async()=>{
 const f=fixture();try{
  f.apply();const away=observation('away','away','browser');away.url='https://fixture.invalid/away';away.controls=[];away.navigation!.entries.push({id:2,url:away.url,method:'GET'});away.navigation!.currentIndex=1;f.setActive(away);
  const checkpoints=[f.current,f.original].map(o=>({id:`cp-${o.id}`,sessionId:'session',observationId:o.id,stateId:o.stateId}));
  vi.spyOn(f.host,'list').mockImplementation(((_sid:string,kind:string)=>kind==='checkpoint'?checkpoints:[]) as any);
  const select=()=> (f.plugin as any).scheduledRecovery(f.task,f.task.rounds[0],away,[],f.host.actionAvailability('session',away.id),()=> 'same-condition');
  const selected=await select();expect(selected.frame.checkpointId).toBe('cp-current');
  const route=JSON.stringify(f.task.scheduling?.routes[selected.routeKey]);f.setActive(f.current);
  f.apply(reviewRecoveryChanges(f.task,f.current,f.host,{rejected:[{localId:f.current.controls[0].localId,decisionId:'negative',kind:'probe'}]}));f.setActive(away);
  expect((await select())?.itemId).not.toBe('review');expect(f.task.scheduling?.deferred?.review.reason).toBe('unchanged_unresolved_review');expect(JSON.stringify(f.task.scheduling?.routes[selected.routeKey])).toBe(route);expect(f.task.routeRetries).toBeUndefined();
 }finally{await f.close();}
});

it('keeps an absent target unverified after a real native return rather than granting checkpoint coverage',async()=>{
 const f=await explorerFixture('<div id="target" tabindex="0"><span>Preference</span></div><a href="/away">Leave</a><script>if(location.pathname==="/away")localStorage.setItem("hidden","yes");function update(){if(localStorage.getItem("hidden"))document.querySelector("#target")?.remove()}addEventListener("pageshow",update);update()</script>');
 try{
  const s=await f.host.createSession({url:f.url,headless:true,exploration:'controls',contextRules:[],settleMs:0,observeTimeoutMs:500,actionTimeoutMs:1000,maxActions:20}),cp=await f.host.createCheckpoint(s.id,'review target'),source=f.host.observation(s.id);
  expect(classificationCorrespondenceConditions(source.controls.find(c=>c.stableKey==='id:target')!,source)).toBeDefined();
  await pageOf(f.host).goto(`${f.url}away`);await f.host.observe(s.id);
  const result=await f.host.reachCheckpoint(s.id,cp.id);expect(result.status).not.toMatch(/^REACHED_/);expect(result.diagnostics?.strategies).toContain('observed_source_return');
  expect(f.host.observation(s.id).controls.some(c=>c.stableKey==='id:target')).toBe(false);
 }finally{await f.close();}
});

it('public start keeps a denied generic review pending while a later page executes fresh work',async()=>{
 const f=await explorerFixture('<section id="source"><div id="weak" tabindex="0"><span>Unclear preference</span></div><a href="/away">Leave</a></section><section id="away"><button id="fresh" type="button" onclick="window.freshCount=(window.freshCount||0)+1;this.disabled=true">Fresh work</button></section><script>document.querySelector(location.pathname==="/away"?"#source":"#away").remove()</script>');
 const providers=fakeProviders(f.url),decide=providers.jev.decide;
 providers.jev.decide=async (request,signal)=>request.purpose==='control-classification'&&(request.state as any).material?.control?.stableKey==='id:weak'
  ?{value:'interaction',model:'controlled-test',confidence:1}:decide(request,signal);
 const createSession=f.host.createSession.bind(f.host);
 vi.spyOn(f.host,'createSession').mockImplementation(options=>createSession({...options as any,contextRules:[],regionExploration:'off',listExploration:'all',pageExploration:'all',interfaceActions:[{stableKey:'id:fresh',kind:'click'}]}));
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers);
 try{
  const task=plugin.create({url:f.url,coverageMode:'all',budget:{rounds:1,actions:6,modelRequests:25,durationMs:20000},sessionOptions:{headless:true,executionPolicy:'interface-only',settleMs:0,observeTimeoutMs:1000,actionTimeoutMs:2000}});
  plugin.revise(task.id,{items:[{title:'Source',scope:{url:f.url},prerequisites:[],completion:'Keep unresolved source reviews',required:true,reason:'fixture'},{title:'Destination',scope:{url:`${f.url}away`},prerequisites:[],completion:'Exercise fresh work',required:true,reason:'fixture'}]});
  plugin.start(task.id);await plugin.waitForIdle();
  const final=plugin.store.task(task.id),events=plugin.store.events(task.id),waiting=final.plan.filter(item=>item.reviewRecoveryWait&&item.scope.stableKey==='id:weak');
  expect(waiting.length,JSON.stringify({reason:final.reason,events:events.filter(e=>e.type.startsWith('review.')||e.type.startsWith('recovery.')).map(e=>({type:e.type,data:e.data}))})).toBeGreaterThan(0);
  expect(waiting.every(item=>item.status==='unresolved'&&!item.resolvedBy&&!item.reviewResolvedBy&&!item.attempts.length)).toBe(true);
  expect(events.some(e=>e.type==='recovery.selected'&&waiting.some(item=>item.id===(e.data as any).itemId))).toBe(false);
  const sid=final.rounds[0].sessionId;
  expect(f.host.list<any>(sid,'attempt').some(a=>a.action.label==='Fresh work'&&a.status==='succeeded')).toBe(true);
  expect(final.plan.some(item=>item.scope.label==='Fresh work'&&item.status==='succeeded')).toBe(true);
 }finally{await plugin.close();await f.close();}
});
