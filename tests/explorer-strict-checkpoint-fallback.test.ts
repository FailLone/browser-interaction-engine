import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {browserTargetConditions,type ActionCandidate,type Checkpoint,type Observation} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Scope} from '@interaction/explorer-plugin';
import {scopeFor,schedulingKeyFor} from '../packages/explorer-plugin/src/policy.js';
import {recordRouteRetry} from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import {InteractionEngine,type Session,type UIState} from '@interaction/core';
import {MemoryStore} from '@interaction/storage-memory';
import {CounterAdapter} from '../examples/counter-adapter.js';
import {createRecoverySelectionView} from '../packages/browser/src/recovery-selection-view.js';

type Control=Observation['controls'][number];
const url='https://strict-fallback.fixture.invalid/source';
function control(localId:string,patch:Partial<Control>={}):Control {
 return {localId,identityId:`identity-${localId}`,instanceId:`instance-${localId}`,identityScope:'semantic',tag:'button',role:'button',name:'Remaining',label:'Remaining',
  region:'region',visible:true,enabled:true,actions:['click'],constraints:{type:'button',required:false,valid:true},selected:[],
  actionable:{hitTarget:true,unknown:[]},...patch} as unknown as Control;
}

it('core strictly restores a memory machine without portable target conditions',async()=>{
 class StrictAdapter extends CounterAdapter { explorationTargetConditions(){return undefined;} }
 const adapter=new StrictAdapter(),engine=new InteractionEngine({adapter,persistence:new MemoryStore()});
 try{
  const session=await engine.createSession({});
  await engine.execute(session.id,engine.actions(session.id)[0].id,'first');
  const cp=await engine.createCheckpoint(session.id,'one',[{target:'count',equals:1}]);
  await engine.execute(session.id,engine.actions(session.id)[0].id,'second');
  const before=engine.observation(session.id);
  expect(adapter.explorationTargetConditions()).toBeUndefined();
  const assessment=engine.checkpointRecoveryCandidates(session.id,{observationId:before.id,checkpointIds:[cp.id]})[0];
  expect(assessment).toMatchObject({status:'tryable',checkpointVerified:false,executionAuthorized:false,coverageGranted:false});
  expect((await engine.reachCheckpoint(session.id,cp.id)).status).toBe('REACHED_VERIFIED');
  expect(engine.observation(session.id).count).toBe(1);
 }finally{await engine.close();}
});

it('retains the unique operation as a strict candidate when the complete portable projection overflows',async()=>{
 const f=fixture();try{
  expect(browserTargetConditions(f.sourceAction,f.source)).toBeUndefined();
  const assessment=f.assess('session',{observationId:f.current.id,checkpointIds:['checkpoint']})[0];
  expect(assessment).toMatchObject({status:'tryable',blockers:[],checkpointVerified:false,executionAuthorized:false,coverageGranted:false});
  expect(assessment.strategies).toContainEqual(expect.objectContaining({strategy:'entry_replay',status:'tryable'}));
  f.assess.mockClear();const plan=structuredClone(f.task.plan);
  const selected=await f.select();
  expect(selected).toMatchObject({itemId:'target',source:{id:f.source.id},frame:{checkpointId:'checkpoint'},targetActionIds:[],returnToSource:false});
  expect(f.assess).toHaveBeenCalledOnce();
  selected.revalidate();expect(f.assess).toHaveBeenCalledTimes(2);
  expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toBeUndefined();
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();expect(f.host.reachExplorationTarget).not.toHaveBeenCalled();expect(f.driver).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it.each(['unknown','no_known_path','missing API','exception','wrong source','claims authorization','no strategy'] as const)('keeps missing portable proof blocked for %s',async kind=>{
 const f=fixture();try{
  const original=f.assess.getMockImplementation()!;
  if(kind==='missing API')delete f.host.checkpointRecoveryCandidates;
  else if(kind==='exception')f.assess.mockImplementation(()=>{throw Error('unavailable');});
  else f.assess.mockImplementation((...args)=>original(...args).map(row=>({...row,
   ...(['unknown','no_known_path'].includes(kind)?{status:kind as 'unknown'|'no_known_path'}:{}),
   ...(kind==='wrong source'?{sourceObservationId:'another-source'}:{}),
   ...(kind==='claims authorization'?{executionAuthorized:true}:{}),
   ...(kind==='no strategy'?{strategies:[]}:{}),
  })) as ReturnType<typeof original>);
  const plan=structuredClone(f.task.plan);expect(await f.select()).toBeUndefined();
  expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toBeUndefined();expect(f.task.scheduling!.routes).toEqual({});
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();expect(f.host.reachExplorationTarget).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it.each(['duplicate','condition mismatch','critical gap','unknown context','current ambiguous target'] as const)('does not use a tryable checkpoint to bypass %s',async kind=>{
 const f=fixture();try{
  if(kind==='duplicate')f.actionRows.set(f.source.id,[f.sourceAction,{...f.sourceAction,id:'duplicate'}]);
  if(kind==='condition mismatch'){
   f.targetItem.operationConditionPolicy='browser-operation-key-v3';f.targetItem.operationConditionKey=schedulingKeyFor(f.sourceAction,f.source);
   f.source.context.account.value='another-account';
  }
  if(kind==='critical gap')f.source.gaps.push({code:'fixture',message:'Missing facts',critical:true});
  if(kind==='unknown context')f.source.context.account={status:'unknown',value:null,source:'fixture'};
  if(kind==='current ambiguous target'){
   f.current.controls=[structuredClone(f.target)];const current=action(f.current,f.current.controls[0]);
   f.actionRows.set(f.current.id,[current,{...current,id:'duplicate-current'}]);
  }
  expect(await f.select()).toBeUndefined();expect(f.assess).not.toHaveBeenCalled();expect(f.task.scheduling!.routes).toEqual({});
 }finally{await f.close();}
});

it.each(['unverified','unknown'] as const)('does not mint an unconditioned budget after losing source proof with %s debt',async outcome=>{
 const f=fixture();try{
  const modes=f.source.controls.splice(1),before=await f.select();expect(before.targetActionIds).toEqual([f.sourceAction.id]);
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:before.routeKey,conditionVersion:before.conditionVersion,outcome,reason:'Retained debt'});
  const debt=structuredClone(f.task.routeRetries),routes=structuredClone(f.task.scheduling!.routes);f.source.controls.push(...modes);
  // Serializing the ledgers models the retained state read by a fresh selector;
  // it does not stand in for real browser/process restart acceptance.
  f.task.routeRetries=JSON.parse(JSON.stringify(debt));f.task.scheduling=JSON.parse(JSON.stringify(f.task.scheduling));
  expect(await f.select()).toBeUndefined();expect(f.task.routeRetries).toEqual(debt);expect(f.task.scheduling!.routes).toEqual(routes);
  expect(f.assess).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('keeps strict retry debt through price/ID churn and restoration of portable source proof',async()=>{
 const f=fixture();try{
  const selected=await f.select();expect(selected).toBeDefined();
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:selected.routeKey,conditionVersion:selected.conditionVersion,outcome:'unverified',reason:'Spent strict route'});
  const debt=structuredClone(f.task.routeRetries),keys=Object.keys(f.task.scheduling!.routes);
  f.source.canonical='price:234.56';f.current.canonical='price:345.67';f.current.id='fresh-current';f.frames.set(f.current.id,f.current);
  expect(await f.select()).toBeUndefined();expect(Object.keys(f.task.scheduling!.routes)).toEqual(keys);
  f.source.controls.splice(1);expect(browserTargetConditions(f.sourceAction,f.source)).toBeDefined();
  expect(await f.select()).toBeUndefined();expect(f.task.routeRetries).toEqual(debt);expect(Object.keys(f.task.scheduling!.routes)).toEqual(keys);
 }finally{await f.close();}
});

it('does not choose the first debt-free alias to bypass another retained member budget',async()=>{
 const f=fixture();try{
  const selected=await f.select(),route=structuredClone(f.task.scheduling!.routes[selected.routeKey]);
  f.task.scheduling!.routes['other-conditioned-member']={...route,sourceCondition:'condition-A'};
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:'other-conditioned-member',conditionVersion:'old',outcome:'unverified',reason:'Same member spent'});
  const debt=structuredClone(f.task.routeRetries);expect(await f.select()).toBeUndefined();expect(f.task.routeRetries).toEqual(debt);
 }finally{await f.close();}
});

it('preserves distinct verified A/B source retry budgets while keeping A spent',async()=>{
 const f=fixture();try{
  f.source.controls.splice(2);const mode=f.source.controls[1],a=await f.select();
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:a.routeKey,conditionVersion:a.conditionVersion,outcome:'unverified',reason:'A spent'});
  const debt=structuredClone(f.task.routeRetries);mode.checked=true;const b=await f.select();
  expect(b.targetActionIds).toEqual([f.sourceAction.id]);expect(b.routeKey).not.toBe(a.routeKey);
  mode.checked=false;expect(await f.select()).toBeUndefined();expect(f.task.routeRetries).toEqual(debt);expect(f.assess).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it.each(['assessment','source facts','related unknown','same-route debt'] as const)('revalidates %s immediately before dispatch',async kind=>{
 const f=fixture();try{
  const selected=await f.select();expect(selected).toBeDefined();
  if(kind==='assessment'){
   const original=f.assess.getMockImplementation()!;f.assess.mockImplementation((...args)=>original(...args).map(row=>({...row,status:'unknown'})));
  }
  if(kind==='source facts')f.source.controls[1].checked=true;
  if(kind==='related unknown'){
   f.task.scheduling!.routes['late-unknown']={...structuredClone(f.task.scheduling!.routes[selected.routeKey]),sourceCondition:'old-A',arrivalMode:'observed-source'};
   f.task.routeRetries=recordRouteRetry(undefined,{routeKey:'late-unknown',conditionVersion:'old',outcome:'unknown',reason:'Later retained uncertainty'});
  }
  if(kind==='same-route debt')f.task.routeRetries=recordRouteRetry(undefined,{routeKey:selected.routeKey,conditionVersion:selected.conditionVersion,outcome:'unverified',reason:'Consumed after selection'});
  expect(()=>selected.revalidate()).toThrow('STALE_DECISION');
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();expect(f.host.reachExplorationTarget).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('keeps the optimized selection epoch and reacquires strategy evidence after closing it',async()=>{
 const f=fixture();try{
  const source=vi.fn((id:string)=>({source:f.frames.get(id)!,actions:f.actionRows.get(id)!,transition:f.host.interactionTransition('session',id,f.current.id)}));
  f.host.recoverySelectionView=()=>createRecoverySelectionView({supported:()=>true,recordRevision:()=> 'fixture-generation',
   current:()=>({observation:f.current,actions:[],availability:f.host.actionAvailability('session',f.current.id)}),source});
  const selected=await f.select();expect(selected.targetActionIds).toEqual([]);
  expect(source).toHaveBeenCalledOnce();expect(f.assess).toHaveBeenCalledOnce();expect(f.task.scheduling!.routes[selected.routeKey]).toBeDefined();
  const original=f.assess.getMockImplementation()!;f.assess.mockImplementation((...args)=>original(...args).map(row=>({...row,status:'unknown'})));
  expect(()=>selected.revalidate()).toThrow('STALE_DECISION');expect(f.assess).toHaveBeenCalledTimes(2);
  expect(source).toHaveBeenCalledOnce();expect(f.task.routeRetries).toBeUndefined();expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
 }finally{await f.close();}
});
function observation(id:string,controls:Control[]=[]):Observation {
 return {id,sessionId:'session',documentId:`document-${id}`,instanceScope:`document-${id}`,url,ruleVersion:'counter-v1',
  context:{account:{status:'known',value:'anonymous',source:'fixture'}},stable:true,gaps:[],controls,
  regions:[{key:'region',label:'First region',role:'region'}],boundaries:[],overlays:[],components:[],canonical:id,stateId:`state-${id}`} as unknown as Observation;
}
function action(o:Observation,c:Control,patch:Partial<ActionCandidate>={}):ActionCandidate {
 return {id:`action-${c.localId}`,sessionId:o.sessionId,observationId:o.id,stateId:o.stateId,localId:c.localId,controlId:c.identityId,
  kind:'click',label:c.name||c.label,risk:'interface',replayable:true,source:'control',sampleValidity:'valid',excluded:false,
  basis:{status:'supported',evidence:[{source:'html',rule:'native-button/v1',facts:{type:'button'}}]},
  preconditions:{visible:true,enabled:true,identityResolved:true,context:o.context},...patch} as unknown as ActionCandidate;
}
function item(id:string,scope:Scope,source:Observation):PlanItem {
 return {id,title:id,scope,prerequisites:[],completion:'Successful source operation',required:true,dispatchScope:false,status:'pending',
  reason:'operation_not_executed',evidence:[{sessionId:source.sessionId,observationId:source.id}],attempts:[]};
}
function fixture() {
 const target=control('target',{stableKey:'id:remaining'}),source=observation('source',[target]),current=observation('current');
 const sourceAction=action(source,target),frames=new Map([source,current].map(o=>[o.id,o])),actionRows=new Map([[source.id,[sourceAction]],[current.id,[] as ActionCandidate[]]]);
 const checkpoints:Checkpoint[]=[{id:'checkpoint',sessionId:source.sessionId,name:'Retained source',observationId:source.id,stateId:source.stateId,
  context:source.context,predicates:[],acceptable:[],path:[],createdAt:'2026-10-17T00:00:00.000Z'}];
 const readObservation=vi.fn((_sid:string,id?:string)=>{const o=id?frames.get(id):current;if(!o)throw Error('Missing owned fixture observation');return o;});
 const host={events:new EventEmitter(),session:()=>({id:'session',options:{},actionCount:0,currentObservationId:current.id}),
  actionAvailability:()=>({observationId:current.id,revision:'fixture-revision',actions:[]}),observation:readObservation,
  actions:vi.fn((_sid:string,id?:string)=>actionRows.get(id||current.id)||[]),list:(_sid:string,kind:string)=>kind==='checkpoint'?checkpoints:[],
  interactionTransition:()=>({retainedControls:[]}),recoveryAssessment:()=>({unknownAttempts:[]}),
  reachCheckpoint:vi.fn(async()=>{throw Error('Selection must not dispatch');}),execute:vi.fn(async()=>{throw Error('Selection must not execute');})} as unknown as ExplorerHost;
 // Seed a separate, owned memory store for the actual core candidate API.
 // Its driver must never be constructed by selection or revalidation.
 const coreStore=new MemoryStore(),adapter=new CounterAdapter(),engine=new InteractionEngine({adapter,persistence:coreStore});
 const driver=vi.spyOn(adapter,'createDriver').mockImplementation(()=>{throw Error('Selection must not construct a driver');});
 const assess=vi.fn((sid:string,input:Parameters<NonNullable<ExplorerHost['checkpointRecoveryCandidates']>>[1])=>{
  coreStore.put('session',{id:sid,options:adapter.parseOptions({}),createdAt:'2026-10-17T00:00:00.000Z',status:'paused',currentObservationId:current.id,actionCount:0,elapsedMs:0,mode:'manual',dirty:false} satisfies Session);
  for(const o of frames.values()){
   coreStore.put('observation',o);
   coreStore.put('state',{id:o.stateId,sessionId:sid,fingerprint:o.canonical,canonical:o.canonical,ruleVersion:o.ruleVersion,context:o.context,observationIds:[o.id]} satisfies UIState);
  }
  for(const cp of checkpoints)coreStore.put('checkpoint',cp);
  return engine.checkpointRecoveryCandidates(sid,input);
 });
 host.checkpointRecoveryCandidates=assess;
 host.reachExplorationTarget=vi.fn(async()=>{throw Error('Missing portable proof must not select target recovery');});
 const addModes=()=>{for(let i=0;i<33;i++)source.controls.push(control(`mode-${i}`,{stableKey:`id:mode-${i}`,tag:'input',role:'checkbox',name:`Mode ${i}`,label:`Mode ${i}`,visible:false,checked:false,region:'remote-region'}));};
 addModes();
 const store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(host,store),task=plugin.create({url,coverageMode:'all'});
 const targetItem=item('target',scopeFor(sourceAction,source),source);
 task.plan=[{...item('authority',{url},source),dispatchScope:true,reason:'accepted scope'},targetItem];task.status='running';
 task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:'2026-10-17T00:00:00.000Z',status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
 const runtime=plugin as any;
 const select=()=>{const actions=actionRows.get(current.id)||[];return runtime.scheduledRecovery(task,task.rounds[0],current,actions,host.actionAvailability('session',current.id),runtime.routeConditionReader(current,actions));};
 return {addModes,assess,coreStore,engine,driver,target,source,current,sourceAction,targetItem,frames,actionRows,checkpoints,host,readObservation,store,plugin,task,runtime,select,close:async()=>{await plugin.close();await engine.close();}};
}

