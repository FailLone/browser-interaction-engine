import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import type {ActionCandidate,Checkpoint,Observation} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Scope} from '@interaction/explorer-plugin';
import {recordRouteRetry} from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import {controlScopeMatcher,scopeFor} from '../packages/explorer-plugin/src/policy.js';
import {controlReviewGapReasons} from '../packages/explorer-plugin/src/review-ledger.js';

type Control=Observation['controls'][number];
const url='https://review-source.fixture.invalid/page';
function control(localId:string,patch:Partial<Control>={}):Control {
 return {localId,instanceId:`instance-${localId}`,tag:'i',role:'button',name:'Open sub-menu',label:'Open sub-menu',region:'menu',
  visible:true,enabled:true,actions:[],constraints:{required:false,valid:true},selected:[],hypothesisId:`hypothesis-${localId}`,...patch} as unknown as Control;
}
function observation(id:string,controls:Control[]):Observation {
 return {id,sessionId:'session',documentId:`document-${id}`,instanceScope:`document-${id}`,url,ruleVersion:'observable-v7',
  context:{account:{status:'known',value:'anonymous',source:'fixture'}},stable:true,gaps:[],controls,regions:[{key:'menu',label:'Main menu',role:'navigation'}],
  boundaries:[],overlays:[],components:[],canonical:id,stateId:`state-${id}`} as unknown as Observation;
}
function planItem(id:string,scope:Scope,source:Observation):PlanItem {
 return {id,title:id,scope,prerequisites:[],completion:'Review retained scope',required:true,dispatchScope:false,status:'unresolved',
  reason:'identity_unresolved',evidence:[{sessionId:source.sessionId,observationId:source.id}],attempts:[]};
}
function fixture() {
 const source=observation('source',[control('first'),control('second')]),current=observation('current',[]);
 const frames=new Map([source,current].map(o=>[o.id,o])),actionRows=new Map<string,ActionCandidate[]>();
 const checkpoint=(o:Observation):Checkpoint=>({id:`checkpoint-${o.id}`,sessionId:o.sessionId,name:'Retained review source',observationId:o.id,stateId:o.stateId,
  context:o.context,predicates:[],acceptable:[],path:[],createdAt:'2026-10-17T00:00:00.000Z'});
 const checkpoints=[checkpoint(source)],store=new ExplorerStore(':memory:');
 const host={events:new EventEmitter(),session:()=>({id:'session',options:{},actionCount:0}),
  observation:vi.fn((_sid:string,id?:string)=>{const o=id?frames.get(id):current;if(!o)throw Error('Missing owned fixture frame');return o;}),
  actions:(_sid:string,id?:string)=>actionRows.get(id||current.id)||[],list:(_sid:string,kind:string)=>kind==='checkpoint'?checkpoints:[],
  interactionTransition:()=>({retainedControls:[]}),recoveryAssessment:()=>({unknownAttempts:[]}),
  reachCheckpoint:vi.fn(async()=>{throw Error('Selection must not dispatch');}),execute:vi.fn(async()=>{throw Error('Selection must not execute');})} as unknown as ExplorerHost;
 const plugin=new ExplorerPlugin(host,store),task=plugin.create({url,coverageMode:'all'});
 const review=planItem('review',{url,region:'Main menu',label:'Open sub-menu',role:'button'},source);
 task.plan=[{...planItem('authority',{url},source),dispatchScope:true,status:'pending',reason:'accepted scope'},review];task.status='running';
 task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:'2026-10-17T00:00:00.000Z',status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
 const runtime=plugin as any;
 const select=()=>runtime.scheduledRecovery(task,task.rounds[0],current,[],{actions:[]},runtime.routeConditionReader(current,[]));
 return {source,current,review,task,host,store,frames,actionRows,checkpoints,checkpoint,select,close:()=>plugin.close()};
}
function hidden(o:Observation){for(const c of o.controls)c.visible=false;}
function overlay(o:Observation,key:string,controlIds:string[]){o.boundaries!.push({key} as any);o.overlays!.push({key,controlIds} as any);}

it.each([...controlReviewGapReasons])('retains hidden %s work without mistaking its checkpoint for an available review destination',async reason=>{
 const f=fixture();try{
  f.review.reason=reason;hidden(f.source);f.current.controls=structuredClone(f.source.controls);
  const plan=structuredClone(f.task.plan);
  expect(f.select()).toBeUndefined();expect(f.task.plan).toEqual(plan);
  expect(f.task.scheduling!.deferred!.review.reason).toBe('source_review_target_not_available');
  expect(f.task.scheduling!.routes).toEqual({});expect(f.task.routeRetries).toBeUndefined();
  expect(f.store.events(f.task.id).filter(e=>e.type==='obligation.route_unavailable')).toMatchObject([
   {observationId:f.current.id,data:{itemId:'review',reason:'source_review_target_not_available',retainedInPlan:true,coverageGranted:false}},
  ]);
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();expect(f.host.execute).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('allows a visible ambiguous review source without inventing a unique identity or executable action',async()=>{
 const f=fixture();try{
  const plan=structuredClone(f.task.plan);
  expect(f.select()).toMatchObject({itemId:'review',source:{id:'source'},returnToSource:false,targetActionIds:[]});
  expect(f.task.plan).toEqual(plan);expect(f.review.status).toBe('unresolved');
  expect(f.source.controls.every(c=>!!c.hypothesisId)).toBe(true);expect(f.host.execute).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('allows a disabled visible target to provide review material without granting execution',async()=>{
 const f=fixture();try{
  for(const c of f.source.controls)c.enabled=false;
  expect(f.select()).toMatchObject({itemId:'review',targetActionIds:[]});
  expect(f.review.status).toBe('unresolved');expect(f.host.execute).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it.each(['background','outer boundary only','missing overlay'] as const)('does not use %s visible controls as an active-boundary review source',async kind=>{
 const f=fixture();try{
  if(kind==='outer boundary only')overlay(f.source,'outer',f.source.controls.map(c=>c.localId));
  if(kind==='missing overlay')f.source.boundaries!.push({key:'active'} as any);else overlay(f.source,'active',['unrelated']);
  const plan=structuredClone(f.task.plan);expect(f.select()).toBeUndefined();expect(f.task.plan).toEqual(plan);
  expect(f.task.scheduling!.deferred!.review.reason).toBe('source_review_target_not_available');
  expect(f.task.scheduling!.routes).toEqual({});
 }finally{await f.close();}
});

it('accepts one visible member of the innermost boundary even with hidden or background same-name rivals',async()=>{
 const f=fixture();try{
  f.source.controls.push(control('hidden',{visible:false}));
  overlay(f.source,'outer',['second']);overlay(f.source,'active',['first','hidden']);
  expect(f.select()).toMatchObject({itemId:'review',source:{id:'source'},targetActionIds:[]});
 }finally{await f.close();}
});

it('continues to a retained visible source after rejecting a newer hidden source without rebinding the obligation',async()=>{
 const f=fixture();try{
  const newer=observation('newer-hidden',[control('newer',{visible:false})]);f.frames.set(newer.id,newer);f.checkpoints.push(f.checkpoint(newer));
  f.review.evidence.push({sessionId:'session',observationId:newer.id});const before=structuredClone(f.review);
  expect(f.select()).toMatchObject({itemId:'review',source:{id:f.source.id},frame:{checkpointId:'checkpoint-source'}});
  expect(f.review).toEqual(before);
 }finally{await f.close();}
});

it.each([false,true])('defers an already present review item only without an active boundary (active: %s)',async activeBoundary=>{
 const f=fixture();try{
  f.source.controls=[control('old-review')];f.source.regions[0].label='Historical menu';
  f.review.scope.region='Historical menu';
  const newer=observation('newer-retained',[control('retained-header',{instanceId:'same-header-instance'})]);
  newer.regions[0].label='Historical menu';newer.documentId=f.current.documentId;newer.instanceScope=f.current.instanceScope;
  f.current.controls=[control('current-header',{instanceId:'same-header-instance',region:'header'})];
  f.current.regions=[{key:'header',label:'Current header',role:'navigation'} as Observation['regions'][number]];
  if(activeBoundary)overlay(f.current,'blocking-boundary',['unrelated-modal-control']);
  f.frames.set(newer.id,newer);f.checkpoints.push(f.checkpoint(newer));
  f.review.evidence.push({sessionId:'session',observationId:newer.id}); // Reversed candidates put this source first.
  const missing=observation('missing-source',[control('missing',{name:'Another review',label:'Another review'})]);
  f.frames.set(missing.id,missing);f.checkpoints.push(f.checkpoint(missing));
  f.task.plan.push(planItem('genuinely-missing',{url,region:'Main menu',label:'Another review',role:'button'},missing));
  const unknownScope:Scope={url,label:'Earlier unknown operation',kind:'click'};
  f.task.plan.push({...planItem('old-unknown',unknownScope,f.source),status:'blocked',reason:'unknown_action_outcome'});
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:'old-unknown-route',conditionVersion:'old-condition',outcome:'unknown',reason:'Unresolved earlier dispatch',
   unknownSource:{sessionId:'session',attemptIds:['old-unknown-attempt']}});
  f.task.scheduling={version:1,localSelections:0,legacyUnmappedRouteKeys:[],routes:{'old-unknown-route':{
   sessionId:'session',observationId:f.source.id,checkpointId:'checkpoint-source',targets:[unknownScope],path:[],itemIds:['old-unknown'],memberKeys:['old-unknown-member'],pathKeys:[]}}};
  const transition=vi.fn((_sid:string,sourceId:string)=>({retainedControls:sourceId===newer.id
   ?[{beforeLocalId:'retained-header',afterLocalId:'current-header'}]:[]}));
  f.host.interactionTransition=transition as unknown as ExplorerHost['interactionTransition'];
  // Neither same label nor current scope equality causes the defer: only the
  // newest source's retained occurrence corresponds to this current header.
  expect(controlScopeMatcher(f.source,[])(f.review.scope,f.source.controls[0])).toBe(true);
  expect(controlScopeMatcher(newer,[])(f.review.scope,newer.controls[0])).toBe(true);
  expect(controlScopeMatcher(f.current,[])(f.review.scope,f.current.controls[0])).toBe(false);
  const plan=structuredClone(f.task.plan),debt=structuredClone(f.task.routeRetries);
  if(activeBoundary){
   // The retained header can be behind a modal. This patch must not turn the
   // existing present predicate into permission to review that background node.
   expect(f.select()).toMatchObject({itemId:'review',source:{id:f.source.id}});
   expect(transition.mock.calls.map(call=>call[1])).toEqual([newer.id,f.source.id]);
   expect(f.task.scheduling.deferred?.review).toBeUndefined();
  }else{
   expect(f.select()).toMatchObject({itemId:'genuinely-missing',source:{id:missing.id}});
   expect(transition.mock.calls.map(call=>call[1])).toEqual([newer.id,missing.id]);
   expect(f.task.scheduling.deferred?.review.reason).toBe('current_review_occurrence_present');
   expect(Object.values(f.task.scheduling.routes).some(route=>route.itemIds.includes('review'))).toBe(false);
  }
  expect(f.task.plan).toEqual(plan);expect(f.task.status).toBe('running');expect(f.review.status).toBe('unresolved');
  expect(f.task.routeRetries).toEqual(debt);expect(f.current.controls[0].hypothesisId).toBe('hypothesis-current-header');
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();expect(f.host.execute).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('rechecks source visibility on a fresh call and preserves old unknown retry debt and source history',async()=>{
 const f=fixture();try{
  const first=f.select();expect(first).toBeDefined();
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:first.routeKey,conditionVersion:first.conditionVersion,outcome:'unknown',reason:'Unresolved old dispatch',
   unknownSource:{sessionId:'session',attemptIds:['old-unknown']}});
  const debt=structuredClone(f.task.routeRetries),plan=structuredClone(f.task.plan);
  hidden(f.source);expect(f.select()).toBeUndefined();expect(f.task.scheduling!.deferred!.review.reason).toBe('source_review_target_not_available');
  f.source.controls[0].visible=true;expect(f.select()).toBeUndefined();expect(f.task.scheduling!.deferred!.review.reason).toBe('route_retry_unknown_result');
  expect(f.task.routeRetries).toEqual(debt);expect(f.task.plan).toEqual(plan);expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('does not claim that an undeployed prerequisite or a same-URL page return makes a hidden source visible',async()=>{
 const f=fixture();try{
  hidden(f.source);f.review.prerequisites=[{url,label:'Trade',kind:'click'}];
  f.host.returnToObservedSource=vi.fn(async()=>{throw Error('Selection must not return the page');});
  const plan=structuredClone(f.task.plan);expect(f.select()).toBeUndefined();expect(f.task.plan).toEqual(plan);
  expect(f.task.scheduling!.deferred!.review.reason).toBe('source_review_target_not_available');
  expect(f.host.returnToObservedSource).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('keeps a separately observed concrete entry operation eligible while the hidden review remains unresolved',async()=>{
 const f=fixture();try{
  hidden(f.source);
  const entry=control('entry',{name:'Trade',label:'Trade',tag:'button',hypothesisId:undefined,stableKey:'id:trade',actions:['click']});f.source.controls.push(entry);
  const action={id:'trade-action',sessionId:'session',observationId:f.source.id,stateId:f.source.stateId,localId:entry.localId,kind:'click',label:'Trade',
   risk:'interface',replayable:true,source:'control',sampleValidity:'valid',basis:{status:'supported',evidence:[{source:'html',rule:'native-button/v1',facts:{type:'button'}}]},
   preconditions:{visible:true,enabled:true,identityResolved:true,context:f.source.context}} as unknown as ActionCandidate;
  f.actionRows.set(f.source.id,[action]);f.task.plan.push({...planItem('entry',scopeFor(action,f.source),f.source),status:'pending',reason:'operation_not_executed'});
  const plan=structuredClone(f.task.plan);expect(f.select()).toMatchObject({itemId:'entry',targetActionIds:[action.id]});
  expect(f.task.plan).toEqual(plan);expect(f.review.status).toBe('unresolved');expect(f.host.execute).not.toHaveBeenCalled();
 }finally{await f.close();}
});
