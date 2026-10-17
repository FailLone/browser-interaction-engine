import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {browserTargetConditions,type ActionCandidate,type Checkpoint,type Observation} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem} from '@interaction/explorer-plugin';
import {recordRouteRetry} from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import {scopeFor} from '../packages/explorer-plugin/src/policy.js';

const url='https://fixture.invalid/source',away='https://fixture.invalid/away';
const checkpointFor=(o:Observation):Checkpoint=>({id:`cp-${o.id}`,sessionId:o.sessionId,name:o.id,observationId:o.id,stateId:o.stateId,context:o.context,predicates:[],acceptable:[],path:[],createdAt:'2026-10-17T00:00:00.000Z'});
function fixture(){
 const source={id:'page-source',sessionId:'session',instanceScope:'current-document',url,ruleVersion:'observable-v7',context:{account:{status:'known',value:'anonymous',source:'fixture'}},stable:true,gaps:[],controls:[],regions:[],boundaries:[],overlays:[],canonical:'page',stateId:'page-state',navigation:{browserSessionId:'current-browser',currentIndex:0,entries:[{id:1,url,method:'GET'}]}} as unknown as Observation;
 const current=structuredClone(source);current.id='away';current.url=away;current.canonical='away';current.stateId='away-state';current.navigation!.entries.push({id:2,url:away,method:'GET'});current.navigation!.currentIndex=1;
 const old=structuredClone(source);old.id='review-source';old.canonical='old-review';old.stateId='review-state';old.instanceScope='old-document';old.navigation!.browserSessionId='old-browser';
 old.controls=[{localId:'usd',identityId:'usd-id',instanceId:'old-usd',tag:'div',role:'generic',name:'USD',label:'USD',region:'document',visible:true,enabled:true,actions:[],constraints:{},selected:[]} as unknown as Observation['controls'][number]];
 const page:PlanItem={id:'page',title:'Continue source discovery',scope:{url},prerequisites:[],completion:'Inspect page',status:'pending',required:true,dispatchScope:true,reason:'accepted scope',evidence:[{sessionId:'session',observationId:source.id}],attempts:[]};
 const review:PlanItem={id:'review',title:'Review USD',scope:{url,label:'USD',role:'generic'},prerequisites:[],completion:'Obtain classification evidence',status:'unresolved',required:true,dispatchScope:false,reason:'classification_unresolved',evidence:[{sessionId:'session',observationId:old.id}],attempts:[]};
 const observations=new Map([source,old,current].map(o=>[o.id,o])),actions=new Map<string,ActionCandidate[]>();
 const checkpoints=[source,old].map(checkpointFor);
 const host={events:new EventEmitter(),session:()=>({id:'session',options:{},actionCount:0,currentObservationId:current.id}),
  actionAvailability:()=>({observationId:current.id,revision:'fixture-revision',actions:[]}),
  observation:vi.fn((_sid:string,id?:string)=>{const value=observations.get(id||current.id);if(!value)throw Error('Missing source');return value;}),
  actions:(_sid:string,id?:string)=>actions.get(id||current.id)||[],list:(_sid:string,kind:string)=>kind==='checkpoint'?checkpoints:[],interactionTransition:()=>({retainedControls:[]}),
  recoveryAssessment:()=>({unknownAttempts:[]}),returnToObservedSource:vi.fn(async()=>{throw Error('Must not dispatch');})} as unknown as ExplorerHost;
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:')),task=plugin.create({url,coverageMode:'all'});
 task.plan=[page,review];task.status='running';task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:'2026-10-17T00:00:00.000Z',status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
 const runtime=plugin as any,select=()=>runtime.scheduledRecovery(task,task.rounds[0],current,[],host.actionAvailability('session',current.id),runtime.routeConditionReader(current,[]));
 return {source,old,current,page,review,observations,actions,checkpoints,host,plugin,task,runtime,select,close:()=>plugin.close()};
}

it('prefers an authorized native page return over a review source from an older browser without rebinding the review',async()=>{
 const f=fixture();try{
  // Unrelated checkpoints must not cause an all-observation scan.
  for(let i=0;i<30;i++)f.checkpoints.push({id:`unused-${i}`,sessionId:'session',observationId:`unread-${i}`} as Checkpoint);
  const plan=structuredClone(f.task.plan),selected=(await f.select());
  expect(selected).toMatchObject({itemId:'page',returnToSource:true,targetActionIds:[],source:{id:f.source.id}});
  expect(f.task.plan).toEqual(plan);expect(f.review.evidence).toEqual([{sessionId:'session',observationId:f.old.id}]);
  expect(f.task.routeRetries).toBeUndefined();expect(f.task.scheduling!.deferred?.review).toBeUndefined();
  expect(Object.values(f.task.scheduling!.routes)).toHaveLength(1);
  expect(Object.values(f.task.scheduling!.routes)[0]).toMatchObject({arrivalMode:'observed-source',itemIds:['page']});
  expect(vi.mocked(f.host.observation).mock.calls.every(([,id])=>!id?.startsWith('unread-'))).toBe(true);
  expect(f.host.returnToObservedSource).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it.each([false,true])('reads attempt-only page sources lazily and continues past an invalid latest candidate: %s',async invalidLatest=>{
 const f=fixture();try{
  f.page.evidence=[{sessionId:'session',observationId:'historic-attempt-source',attemptId:'historical-action'}];
  f.checkpoints.unshift(...Array.from({length:30},(_,i)=>({id:`unused-${i}`,sessionId:'session',observationId:`unread-${i}`} as Checkpoint)));
  if(invalidLatest){
   const invalid=structuredClone(f.source);invalid.id='invalid-latest';invalid.navigation!.entries[0].method='POST';f.observations.set(invalid.id,invalid);
   f.checkpoints.push(checkpointFor(invalid));
  }
  const plan=structuredClone(f.task.plan),selected=(await f.select());
  expect(selected).toMatchObject({itemId:'page',returnToSource:true,source:{id:f.source.id}});expect(f.task.plan).toEqual(plan);
  const ids=vi.mocked(f.host.observation).mock.calls.map(([,id])=>id);
  expect(ids.some(id=>id?.startsWith('unread-'))).toBe(false);
  expect(ids.includes('invalid-latest')).toBe(invalidLatest);
  expect(f.host.returnToObservedSource).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it.each(['missing-entry','source-post','new-browser','changed-context','critical-source','active-boundary','unstable','no-api','not-pure-page','different-url'] as const)('keeps the original strict review candidate when page return has %s',async kind=>{
 const f=fixture();try{
  if(kind==='missing-entry')f.current.navigation!.entries[0].id=99;
  if(kind==='source-post')f.source.navigation!.entries[0].method='POST';
  if(kind==='new-browser')f.source.navigation!.browserSessionId='another-browser';
  if(kind==='changed-context')f.source.context.account.value='changed';
  if(kind==='critical-source')f.source.gaps=[{code:'MISSING',message:'Missing capture',critical:true}];
  if(kind==='active-boundary')f.current.boundaries=[{key:'dialog'}] as Observation['boundaries'];
  if(kind==='unstable')f.source.stable=false;
  if(kind==='no-api')f.host.returnToObservedSource=undefined;
  if(kind==='not-pure-page')f.page.prerequisites=[{url,label:'Open'}];
  if(kind==='different-url'){
   // The original page authority remains; only another URL has page discovery work.
   f.page.dispatchScope=true;f.page.status='succeeded';f.task.plan.push({...structuredClone(f.page),id:'other-page',status:'pending',scope:{url:'https://fixture.invalid/other'}});
  }
  const plan=structuredClone(f.task.plan),selected=(await f.select());
  expect(selected).toMatchObject({itemId:'review',returnToSource:false,targetActionIds:[],source:{id:f.old.id},frame:{checkpointId:'cp-review-source'}});
  expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toBeUndefined();
  expect(Object.values(f.task.scheduling!.routes).some(r=>r.arrivalMode==='observed-source')).toBe(false);
 }finally{await f.close();}
});

it.each(['spent','saturated','unknown'] as const)('does not bypass %s page-route debt to replace the original review candidate',async kind=>{
 const f=fixture();try{
  const first=(await f.select());expect(first.itemId).toBe('page');
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:first.routeKey,conditionVersion:kind==='saturated'?'other-condition':first.conditionVersion,outcome:kind==='unknown'?'unknown':'unverified',reason:'retained page failure',attemptKey:'prior'});
  if(kind==='saturated')f.task.routeRetries.routes[first.routeKey].saturated=true;
  const debt=structuredClone(f.task.routeRetries),plan=structuredClone(f.task.plan),selected=(await f.select());
  expect(selected).toMatchObject({itemId:'review',returnToSource:false,source:{id:f.old.id}});expect(f.task.routeRetries).toEqual(debt);
  expect(f.task.plan).toEqual(plan);
  expect(f.task.scheduling!.deferred!.page.reason).toBe(kind==='unknown'?'source_return_unknown_route_debt':kind==='saturated'?'route_retry_condition_limit':'route_retry_condition_attempted');
  expect(f.host.returnToObservedSource).not.toHaveBeenCalled();
  if(kind==='unknown'){
   // The provisional candidate is scheduling only; a real unresolved SDK result
   // still blocks dispatch through the existing recovery gate.
   f.host.recoveryAssessment=()=>({unknownAttempts:[{id:'unknown',sessionId:'session',status:'unknown'}]}) as any;
   expect(()=>f.runtime.assertRecoveryOutcomes(f.task)).toThrow();
  }
 }finally{await f.close();}
});

it('keeps a review with a current native history anchor ahead of the page obligation',async()=>{
 const f=fixture();try{
  f.old.navigation=structuredClone(f.source.navigation);
  expect((await f.select())).toMatchObject({itemId:'review',returnToSource:false,source:{id:f.old.id}});
 }finally{await f.close();}
});

it('does not promote page return over a concrete operation with an old source',async()=>{
 const f=fixture();try{
  const control:Observation['controls'][number]={...f.old.controls[0],tag:'a',role:'link',name:'Remaining',label:'Remaining',constraints:{type:'a',required:false,valid:true},reviewBinding:{parentInstanceId:'fixture-parent',attributes:{href:'/remaining'}},actionBasis:{click:{status:'supported',evidence:[{source:'html',rule:'hyperlink/v1',facts:{tag:'a',href:'/remaining'}}]}}};
  f.old.controls=[control];const action={id:'target',sessionId:'session',observationId:f.old.id,localId:control.localId,controlId:control.identityId,kind:'click',label:'Remaining',risk:'interface',replayable:true,basis:control.actionBasis!.click,excluded:false,preconditions:{visible:true,enabled:true,identityResolved:true,context:f.old.context}} as ActionCandidate;
  expect(browserTargetConditions(action,f.old)).toBeDefined();f.actions.set(f.old.id,[action]);
  f.review.scope=scopeFor(action,f.old);f.review.reason='operation_not_executed';
  expect((await f.select())).toMatchObject({itemId:'review',returnToSource:false,targetActionIds:['target'],source:{id:f.old.id}});
  expect(f.task.routeRetries).toBeUndefined();expect(f.host.returnToObservedSource).not.toHaveBeenCalled();
 }finally{await f.close();}
});
