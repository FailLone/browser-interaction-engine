import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import type {ActionCandidate,Checkpoint,Observation} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Scope} from '@interaction/explorer-plugin';
import {recordRouteRetry} from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import {scopeFor} from '../packages/explorer-plugin/src/policy.js';

type Assessment=ReturnType<NonNullable<ExplorerHost['checkpointRecoveryCandidates']>>[number];
type Control=Observation['controls'][number];
const url='https://recovery-candidates.fixture.invalid/source';
function observation(id:string,withTarget=true):Observation {
 const control={localId:`${id}:target`,instanceId:`${id}:target`,identityId:`identity-${id}`,identityScope:'semantic',stableKey:'id:remaining',
  tag:'div',role:'generic',name:'Remaining',label:'Remaining',region:'region',visible:true,enabled:true,actions:[],
  constraints:{type:'div',required:false,valid:true},selected:[],actionable:{hitTarget:true,unknown:[]}} as unknown as Control;
 return {id,sessionId:'session',documentId:`document-${id}`,instanceScope:`document-${id}`,url,ruleVersion:'observable-v7',context:{},stable:true,gaps:[],
  controls:withTarget?[control]:[],regions:[{key:'region',label:'Main menu',role:'navigation'}],boundaries:[],overlays:[],components:[],canonical:id,stateId:`state-${id}`} as unknown as Observation;
}
function item(id:string,scope:Scope,sources:Observation[]):PlanItem {
 return {id,title:id,scope,prerequisites:[],completion:'Review retained scope',status:'unresolved',required:true,dispatchScope:false,
  reason:'classification_unresolved',evidence:[...sources].reverse().map(source=>({sessionId:source.sessionId,observationId:source.id})),attempts:[]};
}
function fixture(count=1) {
 const sources=Array.from({length:count},(_,index)=>observation(`source-${index+1}`)),current=observation('current',false);
 const frames=new Map([...sources,current].map(source=>[source.id,source])),actionRows=new Map<string,ActionCandidate[]>();
 const checkpoints:Checkpoint[]=sources.map(source=>({id:`checkpoint-${source.id}`,sessionId:source.sessionId,name:'Retained review',observationId:source.id,
  stateId:source.stateId,context:source.context,predicates:[],acceptable:[],path:[],createdAt:'2026-10-17T00:00:00.000Z'}));
 const statuses=new Map(checkpoints.map(checkpoint=>[checkpoint.id,'no_known_path' as Assessment['status']]));
 const assessment=(checkpointId:string):Assessment=>({checkpointId,sourceObservationId:checkpoints.find(checkpoint=>checkpoint.id===checkpointId)!.observationId,
  currentObservationId:current.id,status:statuses.get(checkpointId)!,strategies:[],blockers:[],invalidatedBy:[],
  checkpointVerified:false,executionAuthorized:false,currentExecution:false,coverageGranted:false,dispatchRevalidationRequired:true});
 const assess=vi.fn((_sid:string,input:{observationId:string;checkpointIds:string[]})=>input.checkpointIds.map(assessment));
 const host={events:new EventEmitter(),session:()=>({id:'session',options:{},actionCount:0,currentObservationId:current.id}),
  actionAvailability:()=>({observationId:current.id,revision:'fixture-revision',actions:[]}),
  observation:(_sid:string,id?:string)=>{const source=id?frames.get(id):current;if(!source)throw Error('Missing fixture observation');return source;},
  actions:(_sid:string,id?:string)=>actionRows.get(id||current.id)||[],list:(_sid:string,kind:string)=>kind==='checkpoint'?checkpoints:[],
  interactionTransition:()=>({retainedControls:[]}),recoveryAssessment:()=>({unknownAttempts:[]}),checkpointRecoveryCandidates:assess,
  reachCheckpoint:vi.fn(async()=>{throw Error('Selection must not dispatch');}),execute:vi.fn(async()=>{throw Error('Selection must not execute');})} as unknown as ExplorerHost;
 const store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(host,store),task=plugin.create({url,coverageMode:'all'});
 const review=item('review',{url,region:'Main menu',label:'Remaining',role:'generic',stableKey:'id:remaining'},sources);
 task.plan=[{...item('authority',{url},sources),dispatchScope:true,status:'pending',reason:'accepted scope'},review];task.status='running';
 task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:'2026-10-17T00:00:00.000Z',status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
 const runtime=plugin as any;
 const select=()=>runtime.scheduledRecovery(task,task.rounds[0],current,[],host.actionAvailability('session',current.id),runtime.routeConditionReader(current,[]));
 return {sources,current,checkpoints,statuses,assessment,assess,host,task,review,actionRows,store,select,close:()=>plugin.close()};
}

it('skips two no-path sources and retains the third tryable checkpoint without inventing recovery attempts',async()=>{
 const f=fixture(3);try{
  f.statuses.set(f.checkpoints[2].id,'tryable');const plan=structuredClone(f.task.plan);
  expect((await f.select())).toMatchObject({itemId:'review',source:{id:f.sources[2].id},frame:{checkpointId:f.checkpoints[2].id},targetActionIds:[],returnToSource:false});
  expect(f.assess.mock.calls).toEqual([['session',{observationId:f.current.id,checkpointIds:f.checkpoints.map(checkpoint=>checkpoint.id)}]]);
  expect(Object.values(f.task.scheduling!.routes).map(route=>route.checkpointId)).toEqual([f.checkpoints[2].id]);
  expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toBeUndefined();
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();expect(f.host.execute).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('continues bounded batches past eight no-path sources instead of allowing the ninth through',async()=>{
 const f=fixture(11);try{
  f.statuses.set(f.checkpoints[10].id,'tryable');
  expect((await f.select())).toMatchObject({frame:{checkpointId:f.checkpoints[10].id}});
  expect(f.assess.mock.calls.map(call=>call[1].checkpointIds)).toEqual([
   f.checkpoints.slice(0,8).map(checkpoint=>checkpoint.id),f.checkpoints.slice(8).map(checkpoint=>checkpoint.id),
  ]);
  expect(f.task.routeRetries).toBeUndefined();expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('reuses the current batch for another review while retaining all plan rows and unrelated failure and unknown debts',async()=>{
 const f=fixture();try{
  f.task.plan.push({...structuredClone(f.review),id:'another-review'},
   {...item('unknown',{url,label:'Earlier uncertain operation',kind:'click'},f.sources),status:'blocked',reason:'unknown_action_outcome'});
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:'old-failure',conditionVersion:'old-condition',outcome:'unreachable',reason:'Old failure'});
  f.task.routeRetries=recordRouteRetry(f.task.routeRetries,{routeKey:'old-unknown',conditionVersion:'old-condition',outcome:'unknown',reason:'Old unknown',
   unknownSource:{sessionId:'session',attemptIds:['uncertain-attempt']}});
  f.task.scheduling={version:1,localSelections:4,legacyUnmappedRouteKeys:[],routes:Object.fromEntries(['old-failure','old-unknown'].map(key=>[key,{
   sessionId:'session',observationId:f.sources[0].id,checkpointId:f.checkpoints[0].id,targets:[{url,label:key}],path:[],itemIds:[key],memberKeys:[key],pathKeys:[],
  }]))};
  const plan=structuredClone(f.task.plan),debt=structuredClone(f.task.routeRetries),routes=structuredClone(f.task.scheduling.routes);
  expect((await f.select())).toBeUndefined();expect(f.assess).toHaveBeenCalledTimes(1);
  expect(f.task.scheduling.deferred).toMatchObject({review:{reason:'checkpoint_no_known_path'},'another-review':{reason:'checkpoint_no_known_path'}});
  expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toEqual(debt);expect(f.task.scheduling.routes).toEqual(routes);
  expect(f.task.scheduling.localSelections).toBe(4);expect(f.task.status).toBe('running');
  expect(f.store.events(f.task.id).filter(event=>event.type.startsWith('recovery.'))).toEqual([]);
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();expect(f.host.execute).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('reassesses the same observation and checkpoint IDs on the next selection',async()=>{
 const f=fixture();try{
  const plan=structuredClone(f.task.plan);expect((await f.select())).toBeUndefined();
  f.statuses.set(f.checkpoints[0].id,'tryable');
  expect((await f.select())).toMatchObject({frame:{checkpointId:f.checkpoints[0].id}});
  expect(f.assess).toHaveBeenCalledTimes(2);expect(f.assess.mock.calls[1]).toEqual(f.assess.mock.calls[0]);
  expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toBeUndefined();
 }finally{await f.close();}
});

it.each(['unknown','missing API','exception'] as const)('preserves the strict recovery fallback for %s',async kind=>{
 const f=fixture();try{
  if(kind==='unknown')f.statuses.set(f.checkpoints[0].id,'unknown');
  if(kind==='missing API')delete f.host.checkpointRecoveryCandidates;
  if(kind==='exception')f.assess.mockImplementation(()=>{throw Error('Assessment unavailable');});
  const plan=structuredClone(f.task.plan);
  expect((await f.select())).toMatchObject({frame:{checkpointId:f.checkpoints[0].id},returnToSource:false,targetActionIds:[]});
  expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toBeUndefined();expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it.each(['checkpoint','source','current','blockers','authority','duplicate result'] as const)('does not use a no-path assessment with invalid %s evidence',async kind=>{
 const f=fixture();try{
  f.assess.mockImplementation(()=>{
   const result=f.assessment(f.checkpoints[0].id);
   if(kind==='checkpoint')result.checkpointId='another-checkpoint';
   if(kind==='source')result.sourceObservationId='another-source';
   if(kind==='current')result.currentObservationId='another-current';
   if(kind==='blockers')result.blockers=['unknown_execution_outcome'];
   if(kind==='authority')(result as any).executionAuthorized=true;
   return kind==='duplicate result'?[result,result]:[result];
  });
  expect((await f.select())).toMatchObject({frame:{checkpointId:f.checkpoints[0].id}});
  expect(f.task.routeRetries).toBeUndefined();expect(f.task.scheduling?.deferred?.review).toBeUndefined();
 }finally{await f.close();}
});

it('keeps existing unknown route debt ahead of candidate assessment',async()=>{
 const f=fixture();try{
  f.statuses.set(f.checkpoints[0].id,'tryable');const first=(await f.select());expect(first).toBeDefined();
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:first.routeKey,conditionVersion:first.conditionVersion,outcome:'unknown',reason:'Unresolved execution',
   unknownSource:{sessionId:'session',attemptIds:['uncertain-attempt']}});
  const plan=structuredClone(f.task.plan),debt=structuredClone(f.task.routeRetries);f.assess.mockClear();
  expect((await f.select())).toBeUndefined();expect(f.assess).not.toHaveBeenCalled();
  expect(f.task.scheduling?.deferred?.review.reason).toBe('route_retry_unknown_result');
  expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toEqual(debt);
 }finally{await f.close();}
});

it.each([true,false])('assesses a concrete operation only when target recovery is absent (target API: %s)',async targetApi=>{
 const f=fixture();try{
  const source=f.sources[0],control=source.controls[0];Object.assign(control,{tag:'button',role:'button',actions:['click'],constraints:{type:'button',required:false,valid:true}});
  const action={id:'source-action',sessionId:'session',observationId:source.id,stateId:source.stateId,localId:control.localId,controlId:control.identityId,
   kind:'click',label:'Remaining',risk:'interface',replayable:true,source:'control',sampleValidity:'valid',excluded:false,
   basis:{status:'supported',evidence:[{source:'html',rule:'native-button/v1',facts:{type:'button'}}]},
   preconditions:{visible:true,enabled:true,identityResolved:true,context:source.context}} as unknown as ActionCandidate;
  f.actionRows.set(source.id,[action]);f.review.scope=scopeFor(action,source);f.review.reason='operation_not_executed';
  if(targetApi)f.host.reachExplorationTarget=vi.fn(async()=>{throw Error('Selection must not reach a target');});
  const plan=structuredClone(f.task.plan);
  if(targetApi){expect((await f.select())).toMatchObject({targetActionIds:[action.id],returnToSource:false});expect(f.assess).not.toHaveBeenCalled();}
  else{expect((await f.select())).toBeUndefined();expect(f.assess).toHaveBeenCalledTimes(1);}
  expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toBeUndefined();expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
  if(targetApi)expect(f.host.reachExplorationTarget).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('keeps accepted page source-position return separate from strict checkpoint assessment',async()=>{
 const f=fixture();try{
  const source=f.sources[0];source.navigation={browserSessionId:'browser',currentIndex:0,entries:[{id:1,url,method:'GET'}]};
  f.current.url='https://recovery-candidates.fixture.invalid/away';f.current.navigation={browserSessionId:'browser',currentIndex:1,
   entries:[{id:1,url,method:'GET'},{id:2,url:f.current.url,method:'GET'}]};
  f.task.plan=[f.task.plan[0]];f.host.returnToObservedSource=vi.fn(async()=>{throw Error('Selection must not return to source');});
  const plan=structuredClone(f.task.plan);
  expect((await f.select())).toMatchObject({itemId:'authority',returnToSource:true,targetActionIds:[]});expect(f.assess).not.toHaveBeenCalled();
  expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toBeUndefined();expect(f.host.returnToObservedSource).not.toHaveBeenCalled();
 }finally{await f.close();}
});
