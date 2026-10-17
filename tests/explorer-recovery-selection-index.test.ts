import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {browserTargetConditions,type ActionCandidate,type Checkpoint,type Observation} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Scope} from '@interaction/explorer-plugin';
import {controlInScope,controlScopeMatcher,scopeFor,schedulingKeyFor} from '../packages/explorer-plugin/src/policy.js';
import {recordRouteRetry,recoveryRouteKey} from '../packages/explorer-plugin/src/obligation-lifecycle.js';

type Control=Observation['controls'][number];
const url='https://selection.fixture.invalid/source';
function control(localId:string,patch:Partial<Control>={}):Control {
 return {localId,identityId:`identity-${localId}`,instanceId:`instance-${localId}`,identityScope:'semantic',tag:'button',role:'button',name:'Remaining',label:'Remaining',
  region:'region',visible:true,enabled:true,actions:['click'],constraints:{type:'button',required:false,valid:true},selected:[],
  actionable:{hitTarget:true,unknown:[]},...patch} as unknown as Control;
}
function observation(id:string,controls:Control[]=[]):Observation {
 return {id,sessionId:'session',documentId:`document-${id}`,instanceScope:`document-${id}`,url,ruleVersion:'observable-v7',
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
 const store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(host,store),task=plugin.create({url,coverageMode:'all'});
 const targetItem=item('target',scopeFor(sourceAction,source),source);
 task.plan=[{...item('authority',{url},source),dispatchScope:true,reason:'accepted scope'},targetItem];task.status='running';
 task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:'2026-10-17T00:00:00.000Z',status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
 const runtime=plugin as any;
 const select=()=>{const actions=actionRows.get(current.id)||[];return runtime.scheduledRecovery(task,task.rounds[0],current,actions,host.actionAvailability('session',current.id),runtime.routeConditionReader(current,actions));};
 return {target,source,current,sourceAction,targetItem,frames,actionRows,checkpoints,host,readObservation,store,plugin,task,runtime,select,close:()=>plugin.close()};
}

it('preserves direct control matching for ambiguous IDs, missing IDs, values and scope wildcards',()=>{
 const first=control('shared',{name:'First',label:'First'}),second=control('shared',{name:'Second',label:'Second',role:'generic'});
 const empty=control('',{name:'Empty',label:'Empty'}),missing=control(undefined as unknown as string,{name:'Missing',label:'Missing'});
 const sameLabel=control('other',{name:'First',label:'First',region:'other-region'});
 const o=observation('scope',[first,second,empty,missing,sameLabel]);
 o.regions.push({...o.regions[0],label:'Wrong later region'},{...o.regions[0],key:'other-region',label:'Other region'});
 const actions=[action(o,first,{kind:'check',value:false}),action(o,first,{kind:'check',value:true}),action(o,first,{kind:'fill',value:0}),
  action(o,first,{kind:'fill',value:''}),action(o,empty,{kind:'check',value:false}),action(o,missing,{kind:'fill',value:0}),action(o,sameLabel)];
 // All actions deliberately share generated IDs for one local target. Values,
 // kinds and duplicate occurrences must survive; IDs cannot deduplicate them.
 const read=controlScopeMatcher(o,actions),fields=['url','region','label','role','stableKey','targetBinding','kind','value'] as const;
 const scopes:Scope[]=[{},...actions.map(a=>scopeFor(a,o)),{label:'Second',role:'generic'},
  ...[{kind:'check',value:false},{kind:'fill',value:0},{kind:'fill',value:''},{value:undefined},{value:null},{label:undefined},{label:null}] as unknown as Scope[]];
 for(const a of actions){const full=scopeFor(a,o);for(let mask=0;mask<256;mask++)scopes.push(Object.fromEntries(fields.filter((_,bit)=>mask&(1<<bit)).map(key=>[key,full[key]])) as Scope);}
 for(const c of [...o.controls,structuredClone(second)])for(const scope of scopes)
  expect(read(scope,c),JSON.stringify({localId:c.localId,name:c.name,scope})).toBe(controlInScope(scope,c,o,actions));
 expect(read({label:'First'},first)).toBe(true);expect(read({label:'Second',role:'generic'},second)).toBe(true);
 expect(read({label:'Second',role:'generic'},first)).toBe(false);
 expect(read({kind:'check',value:false},empty)).toBe(true);expect(read({kind:'fill',value:0},missing)).toBe(true);
 expect(read({kind:'check',value:true},empty)).toBe(false);
});

it('rebuilds control matching after same-ID captures, context and action-set changes',()=>{
 const c=control('target',{stableKey:'id:remaining'}),o=observation('same-id',[c]),a=action(o,c,{kind:'check',value:false});
 const before=scopeFor(a,o),first=controlScopeMatcher(o,[a]);expect(first(before,c)).toBe(true);
 const next=structuredClone(o);next.context.account.value='another-tenant';next.controls[0].name='Rebound';next.controls[0].label='Rebound';
 next.controls[0].stableKey='id:rebound';next.regions[0].label='Rebuilt region';
 const changed=action(next,next.controls[0],{id:a.id,kind:'check',value:true}),fresh=controlScopeMatcher(next,[changed]);
 expect(fresh(before,next.controls[0])).toBe(false);
 const current=scopeFor(changed,next);expect(fresh(current,next.controls[0])).toBe(true);
 expect(fresh({kind:'check',value:false},next.controls[0])).toBe(false);
 expect(fresh(current,next.controls[0])).toBe(controlInScope(current,next.controls[0],next,[changed]));
});

it('associates all defer events with the supplied frame without rereading current observation for each item',async()=>{
 const f=fixture();try{
  f.checkpoints.length=0;
  const rows=Array.from({length:24},(_,i)=>({...item(`review-${i}`,{url,label:`Missing ${i}`},f.source),reason:'classification_unresolved'}));
  f.task.plan.splice(1,1,...rows);const plan=structuredClone(f.task.plan);f.readObservation.mockClear();
  expect((await f.select())).toBeUndefined();
  const events=()=>f.store.events(f.task.id).filter(e=>e.type==='obligation.route_unavailable');
  expect(events()).toHaveLength(rows.length);expect(events().map(e=>e.observationId)).toEqual(rows.map(()=>f.current.id));
  expect(events().map(e=>(e.data as {itemId:string}).itemId)).toEqual(rows.map(r=>r.id));
  const firstReads=f.readObservation.mock.calls.length;
  // Each real scan yield revalidates the current frame; defer bookkeeping does
  // not reread it per item. Retained source facts remain unnecessary here.
  expect(firstReads).toBeLessThan(rows.length);
  expect(f.readObservation.mock.calls.every(([,id])=>!id||id===f.current.id)).toBe(true);expect(f.task.plan).toEqual(plan);
  expect((await f.select())).toBeUndefined();expect(events()).toHaveLength(rows.length);
  const secondReads=f.readObservation.mock.calls.length;expect(secondReads-firstReads).toBeLessThan(rows.length);
  f.current.id='new-current';f.frames.set(f.current.id,f.current);f.current.context.account.value='changed-context';
  expect((await f.select())).toBeUndefined();expect(events()).toHaveLength(rows.length*2);
  expect(events().slice(rows.length).every(e=>e.observationId==='new-current')).toBe(true);
  expect(f.readObservation.mock.calls.length-secondReads).toBeLessThan(rows.length);
  expect(f.readObservation.mock.calls.slice(secondReads).every(([,id])=>!id||id===f.current.id)).toBe(true);
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it.each(['unsupported duplicate','foreign-owner duplicate'] as const)('does not manufacture a unique retained target by omitting an %s',async variant=>{
 const f=fixture();try{
  const duplicate={...f.sourceAction,id:'duplicate',...(variant==='unsupported duplicate'?{basis:{status:'tentative',evidence:[]}}:{sessionId:'another-session',observationId:'another-observation'})} as ActionCandidate;
  f.actionRows.set(f.source.id,[f.sourceAction,duplicate]);const plan=structuredClone(f.task.plan);
  expect((await f.select())).toBeUndefined();expect(f.task.scheduling!.routes).toEqual({});expect(f.task.plan).toEqual(plan);
  f.actionRows.set(f.source.id,[f.sourceAction]);expect((await f.select())).toMatchObject({itemId:'target',targetActionIds:[f.sourceAction.id],source:{id:f.source.id}});
  f.actionRows.set(f.source.id,[duplicate,f.sourceAction]);expect((await f.select())).toBeUndefined();
  expect(f.task.plan).toEqual(plan);expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('recomputes a formerly unavailable target condition on every selection and keeps hidden nonlocal modes',async()=>{
 const f=fixture();try{
  const mode=control('remote-mode',{tag:'input',role:'checkbox',name:'Hidden mode',label:'Hidden mode',visible:false,checked:false,identityScope:'instance',stableKey:'id:mode',region:'remote-region'});
  f.source.controls.push(mode);expect(browserTargetConditions(f.sourceAction,f.source)).toBeUndefined();expect((await f.select())).toBeUndefined();
  mode.identityScope=f.target.identityScope;expect(browserTargetConditions(f.sourceAction,f.source)).toBeDefined();
  const first=(await f.select());expect(first).toMatchObject({itemId:'target',targetActionIds:[f.sourceAction.id]});
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:first.routeKey,conditionVersion:first.conditionVersion,outcome:'unverified',reason:'Retained failure',attemptKey:'original-attempt'});
  const debt=structuredClone(f.task.routeRetries);expect((await f.select())).toBeUndefined();
  mode.checked=true;const other=(await f.select());expect(other).toBeDefined();expect(other.routeKey).not.toBe(first.routeKey);
  mode.checked=false;expect((await f.select())).toBeUndefined();expect(f.task.routeRetries).toEqual(debt);
  mode.identityScope='instance';expect((await f.select())).toBeUndefined();expect(f.task.routeRetries).toEqual(debt);
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('recomputes bound scheduling conditions for a changed context without renewing the original debt',async()=>{
 const f=fixture();try{
  f.targetItem.operationConditionPolicy='browser-operation-key-v3';f.targetItem.operationConditionKey=schedulingKeyFor(f.sourceAction,f.source);
  const selected=(await f.select());expect(selected).toBeDefined();
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:selected.routeKey,conditionVersion:selected.conditionVersion,outcome:'unverified',reason:'Spent original source'});
  const debt=structuredClone(f.task.routeRetries),plan=structuredClone(f.task.plan);
  f.source.context.account.value='another-tenant';expect(schedulingKeyFor(f.sourceAction,f.source)).not.toBe(f.targetItem.operationConditionKey);
  expect((await f.select())).toBeUndefined();expect(f.task.scheduling!.deferred!.target.reason).toBe('source_target_unverified');
  f.source.context.account.value='anonymous';expect((await f.select())).toBeUndefined();
  expect(f.task.scheduling!.deferred!.target.reason).toBe('route_retry_condition_attempted');
  expect(f.task.routeRetries).toEqual(debt);expect(f.task.plan).toEqual(plan);
 }finally{await f.close();}
});

it('does not retain current-review matching when the current capture and actions are rebuilt under the same IDs',async()=>{
 const f=fixture();try{
  f.targetItem.scope={url,label:'Remaining',role:'button'};f.targetItem.reason='classification_unresolved';
  expect((await f.select())).toMatchObject({itemId:'target',targetActionIds:[]});
  const present=structuredClone(f.target);f.current.controls=[present];
  expect((await f.select())).toBeUndefined();expect(f.task.scheduling!.deferred!.target.reason).toBe('current_review_occurrence_present');
  present.name='Another';present.label='Another';
  expect((await f.select())).toMatchObject({itemId:'target',targetActionIds:[]});
  f.actionRows.set(f.current.id,[action(f.current,present,{id:f.sourceAction.id,label:'Remaining'})]);
  expect((await f.select())).toBeUndefined();expect(f.task.scheduling!.deferred!.target.reason).toBe('current_review_occurrence_present');
  f.actionRows.set(f.current.id,[]);expect((await f.select())).toMatchObject({itemId:'target',targetActionIds:[]});
 }finally{await f.close();}
});

it.each(['unknown','saturated','failed landing','opaque legacy'] as const)('retains %s debt across fresh selectors and never dispatches',async kind=>{
 const f=fixture();try{
  const selected=(await f.select());expect(selected).toBeDefined();
  if(kind==='opaque legacy'){
   delete f.task.scheduling;f.task.routeRetries=recordRouteRetry(undefined,{routeKey:'opaque-before-index',conditionVersion:'unknown-old-condition',outcome:'unverified',reason:'Unmapped retained debt'});
  }else if(kind==='saturated'){
   for(let i=0;i<16;i++)f.task.routeRetries=recordRouteRetry(f.task.routeRetries,{routeKey:selected.routeKey,conditionVersion:`old-${i}`,outcome:'unverified',reason:'Prior failure'});
  }else{
   f.task.routeRetries=recordRouteRetry(undefined,{routeKey:selected.routeKey,conditionVersion:'original-start',outcome:kind==='unknown'?'unknown':'unverified',reason:'Prior result',
    evidence:{sessionId:'session',observationId:f.current.id},...(kind==='unknown'?{unknownSource:{sessionId:'session',attemptIds:['unknown-attempt']}}:{resultCondition:{conditionVersion:selected.conditionVersion,evidence:{sessionId:'session',observationId:f.current.id},basis:'complete-observation'}})});
  }
  const debt=structuredClone(f.task.routeRetries),plan=structuredClone(f.task.plan);
  for(let i=0;i<2;i++){f.actionRows.set(f.source.id,[structuredClone(f.sourceAction)]);expect((await f.select())).toBeUndefined();}
  expect(f.task.routeRetries).toEqual(debt);expect(f.task.plan).toEqual(plan);
  const reason=kind==='unknown'?'route_retry_unknown_result':kind==='saturated'?'route_retry_condition_limit':kind==='failed landing'?'route_retry_failed_result_condition':'legacy_route_debt_unmapped';
  expect(f.task.scheduling!.deferred!.target.reason).toBe(reason);
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();expect(f.host.execute).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('retains the original composite route instead of minting an independent singleton budget',async()=>{
 const f=fixture();try{
  const other=control('other',{name:'Other',label:'Other',stableKey:'id:other'}),otherAction=action(f.source,other);
  f.source.controls.push(other);f.actionRows.set(f.source.id,[f.sourceAction,otherAction]);
  const targets=[f.targetItem.scope,scopeFor(otherAction,f.source)],key=recoveryRouteKey(f.source,[f.sourceAction,otherAction],targets);
  f.task.scheduling={version:1,localSelections:0,legacyUnmappedRouteKeys:[],routes:{[key]:{sessionId:'session',observationId:f.source.id,checkpointId:'checkpoint',targets,path:[],itemIds:['target'],
   memberKeys:targets.map(scope=>recoveryRouteKey(f.source,[f.sourceAction,otherAction],[scope])),pathKeys:[]}}};
  const selected=(await f.select());expect(selected.routeKey).toBe(key);expect(selected.frame.remaining).toEqual(targets);
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:key,conditionVersion:selected.conditionVersion,outcome:'unverified',reason:'Composite spent'});
  const debt=structuredClone(f.task.routeRetries);expect((await f.select())).toBeUndefined();expect(f.task.routeRetries).toEqual(debt);
  expect(Object.keys(f.task.scheduling.routes)).toEqual([key]);
 }finally{await f.close();}
});

it('uses combined SDK source facts without changing the selected task or rereading the same source',async()=>{
 const f=fixture();try{
  const before=structuredClone(f.task),legacy=(await f.select()),after=structuredClone(f.task);
  Object.assign(f.task,structuredClone(before));delete f.task.scheduling;
  const material=vi.fn((_sid:string,input:{sourceObservationId:string;currentObservationId:string})=>{
   expect(input.currentObservationId).toBe(f.current.id);
   return {source:structuredClone(f.frames.get(input.sourceObservationId)!),actions:structuredClone(f.actionRows.get(input.sourceObservationId)!),
    transition:{beforeId:input.sourceObservationId,afterId:input.currentObservationId,verified:true,documentChanged:true,navigated:false,retainedControls:[],entered:[],exited:[],revealedControlIds:[]}};
  });
  f.host.recoverySourceMaterial=material;f.readObservation.mockClear();vi.mocked(f.host.actions).mockClear();
  const {revalidate:legacyRevalidate,...legacyFields}=legacy;
  const {revalidate:combinedRevalidate,...combinedFields}=await f.select();
  expect(legacyRevalidate).toBeTypeOf('function');expect(combinedRevalidate).toBeTypeOf('function');
  expect(combinedFields).toEqual(legacyFields);expect(f.task).toEqual(after);
  expect(material).toHaveBeenCalledOnce();expect(f.readObservation).not.toHaveBeenCalled();expect(f.host.actions).not.toHaveBeenCalled();
  f.source.context.account.value='changed';(await f.select());
  expect(material).toHaveBeenCalledTimes(2);expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('does not bypass a rejected combined source read with legacy APIs',async()=>{
 const f=fixture();try{
  f.host.recoverySourceMaterial=vi.fn(()=>{throw Error('source facts unavailable');});f.readObservation.mockClear();
  const plan=structuredClone(f.task.plan);expect((await f.select())).toBeUndefined();expect(f.task.plan).toEqual(plan);
  expect(f.readObservation).not.toHaveBeenCalled();expect(f.host.actions).not.toHaveBeenCalled();
  expect(f.task.scheduling!.deferred!.target.reason).toBe('source_target_unverified');
  expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
 }finally{await f.close();}
});
