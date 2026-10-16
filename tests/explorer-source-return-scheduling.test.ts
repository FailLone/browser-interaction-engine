import { EventEmitter } from 'node:events';
import { expect,it,vi } from 'vitest';
import type { Checkpoint,Observation } from '@interaction/browser';
import { ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Scope } from '@interaction/explorer-plugin';
import { pageSourceObligation,sourceReturnCondition } from '../packages/explorer-plugin/src/source-return.js';
import { recordRouteRetry,recoveryRouteKey } from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import type { ScheduledRoute } from '../packages/explorer-plugin/src/obligation-scheduler.js';

const sourceUrl='https://fixture.invalid/source',awayUrl='https://fixture.invalid/away';
function observations() {
 const source={id:'source',sessionId:'session',instanceScope:'source-document',documentId:'source-document',url:sourceUrl,
  ruleVersion:'observable-v7',context:{account:{status:'known',value:'anonymous',source:'fixture'}},stable:true,gaps:[],controls:[],regions:[],boundaries:[],overlays:[],canonical:'source',stateId:'source-state',
  navigation:{browserSessionId:'browser',currentIndex:0,entries:[{id:1,url:sourceUrl,method:'GET'}]}} as unknown as Observation;
 const current=structuredClone(source);current.id='away';current.url=awayUrl;current.canonical='away';current.stateId='away-state';
 current.navigation!.entries.push({id:2,url:awayUrl,method:'GET'});current.navigation!.currentIndex=1;
 return {source,current};
}
function pageItem():PlanItem {
 return {id:'page',title:'Continue source discovery',scope:{url:sourceUrl},prerequisites:[],completion:'Inspect remaining source work',status:'pending',required:true,dispatchScope:true,
  reason:'accepted scope',evidence:[{sessionId:'session',observationId:'source'}],attempts:[]};
}
function fixture() {
 const {source,current}=observations(),item=pageItem(),store=new ExplorerStore(':memory:');
 const checkpoint={id:'source-checkpoint',sessionId:'session',observationId:source.id,stateId:source.stateId} as Checkpoint;
 const host={events:new EventEmitter(),session:()=>({id:'session',options:{},actionCount:0}),
  observation:(_sid:string,id?:string)=>{if(!id||id===current.id)return current;if(id===source.id)return source;throw Error('missing retained source');},
  actions:()=>[],recoveryAssessment:()=>({unknownAttempts:[],blockingBoundaryExit:undefined}),
  actionAvailability:()=>({observationId:current.id,actions:[]}),pinEvidence:vi.fn(async()=>[]),
  list:(_sid:string,kind:string)=>kind==='checkpoint'?[checkpoint]:[],interactionTransition:()=>({retainedControls:[]}),
  returnToObservedSource:vi.fn(async()=>{throw Error('scheduling must not dispatch');})} as unknown as ExplorerHost;
 const plugin=new ExplorerPlugin(host,store),task=plugin.create({url:sourceUrl,coverageMode:'all'});
 task.plan=[item];task.status='running';task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:'2026-10-17T00:00:00.000Z',status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
 const select=()=> (plugin as any).scheduledRecovery(task,task.rounds[0],current,[],{actions:[]},(plugin as any).routeConditionReader(current,[]));
 const mapStrictDebt=(outcome:'unverified'|'unknown'='unverified',otherPage=false)=>{
  const scope={url:otherPage?'https://fixture.invalid/other-source':sourceUrl},key=recoveryRouteKey(source,[],[scope]);
  const route:ScheduledRoute={sessionId:'session',observationId:source.id,checkpointId:checkpoint.id,targets:[scope],path:[],itemIds:[item.id],memberKeys:[key],pathKeys:[],
   failure:{status:'invalidated',reason:'strict checkpoint did not verify',conditionVersion:'old-condition',targets:[scope]}};
  task.scheduling={version:1,localSelections:0,routes:{[key]:route},legacyUnmappedRouteKeys:[]};
  task.routeRetries=recordRouteRetry(undefined,{routeKey:key,conditionVersion:'old-condition',outcome,reason:'retained strict failure'});
  return {key,route};
 };
 return {source,current,item,host,plugin,task,select,mapStrictDebt,close:()=>plugin.close()};
}

it.each([
 ['region',{region:'dialog'}],['label',{label:'Preference'}],['role',{role:'checkbox'}],['kind',{kind:'check'}],
 ['false value',{value:false}],['empty value',{value:''}],['stable key',{stableKey:'id:preference'}],['target binding',{targetBinding:'bound-target'}],
] as [string,Partial<Scope>][])('keeps %s obligations out of source-position arrival',async(_name,scope)=>{
 const f=fixture();try{
  Object.assign(f.item.scope,scope);expect(pageSourceObligation(f.item)).toBe(false);
  expect(f.select()?.returnToSource).not.toBe(true);
  expect(Object.values(f.task.scheduling?.routes||{}).some(route=>route.arrivalMode==='observed-source')).toBe(false);
  expect(f.host.returnToObservedSource).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('requires explicit page authority with no prerequisite path',async()=>{
 const f=fixture();try{
  expect(pageSourceObligation(f.item)).toBe(true);
  f.item.prerequisites=[{url:sourceUrl,label:'Enter account'}];expect(pageSourceObligation(f.item)).toBe(false);expect(f.select()?.returnToSource).not.toBe(true);
  f.item.prerequisites=[];f.item.dispatchScope=false;expect(pageSourceObligation(f.item)).toBe(false);expect(f.select()).toBeUndefined();
  f.item.dispatchScope=true;f.item.scope={};expect(pageSourceObligation(f.item)).toBe(false);expect(f.select()).toBeUndefined();
 }finally{await f.close();}
});

it.each(['optional','succeeded','excluded','superseded','unknown_action_outcome'] as const)('does not schedule %s page work merely because its scope is a URL',async state=>{
 const f=fixture();try{
  if(state==='optional')f.item.required=false;
  else if(state==='unknown_action_outcome')f.item.reason=state;
  else f.item.status=state;
  expect(f.select()).toBeUndefined();expect(Object.keys(f.task.scheduling?.routes||{})).toEqual([]);
 }finally{await f.close();}
});

it.each([
 ['source unknown context',(s:Observation)=>{s.context.account.status='unknown';}],
 ['current unknown context',(_s:Observation,c:Observation)=>{c.context.account.status='unknown';}],
 ['changed known context',(_s:Observation,c:Observation)=>{c.context.account.value='signed-in';}],
 ['changed rules',(_s:Observation,c:Observation)=>{c.ruleVersion='observable-v6';}],
 ['another browser',(_s:Observation,c:Observation)=>{c.navigation!.browserSessionId='another-browser';}],
 ['source POST',(s:Observation,c:Observation)=>{s.navigation!.entries[0].method='POST';c.navigation!.entries[0].method='POST';}],
 ['history target POST',(_s:Observation,c:Observation)=>{c.navigation!.entries[0].method='POST';}],
 ['missing native entry',(_s:Observation,c:Observation)=>{c.navigation!.entries[0].id=99;}],
 ['source critical gap',(s:Observation)=>{s.gaps=[{code:'MISSING_CAPTURE',message:'Incomplete source',critical:true}];}],
 ['current critical gap',(_s:Observation,c:Observation)=>{c.gaps=[{code:'MISSING_CAPTURE',message:'Incomplete current state',critical:true}];}],
 ['active boundary',(_s:Observation,c:Observation)=>{c.boundaries=[{key:'dialog'}] as any;}],
 ['unstable source',(s:Observation)=>{s.stable=false;}],
 ['unstable current',(_s:Observation,c:Observation)=>{c.stable=false;}],
] as [string,(source:Observation,current:Observation)=>void][])('does not create a source-return condition for %s',async(_name,change)=>{
 const f=fixture();try{
  expect(sourceReturnCondition(f.source,f.current)).toBeDefined();change(f.source,f.current);
  expect(sourceReturnCondition(f.source,f.current)).toBeUndefined();expect(f.select()).toBeUndefined();
  expect(Object.keys(f.task.scheduling?.routes||{})).toEqual([]);
 }finally{await f.close();}
});

it('retains mapped strict failure debt while giving page position its own one-attempt route',async()=>{
 const f=fixture();try{
  const {key,route}=f.mapStrictDebt(),debt=f.task.routeRetries!.routes[key],before=structuredClone(debt),routeBefore=structuredClone(route),planBefore=structuredClone(f.task.plan);
  const selected=f.select();expect(selected).toMatchObject({returnToSource:true,itemId:f.item.id,targetActionIds:[],frame:{path:[]}});
  expect(selected.routeKey).not.toBe(key);expect(selected.conditionVersion).toBe(sourceReturnCondition(f.source,f.current));
  expect(f.task.scheduling!.routes[selected.routeKey]).toMatchObject({arrivalMode:'observed-source',targets:[{url:sourceUrl}],path:[]});
  expect(f.task.routeRetries!.routes[key]).toBe(debt);expect(debt).toEqual(before);expect(f.task.scheduling!.routes[key]).toBe(route);expect(route).toEqual(routeBefore);
  expect(f.task.plan).toEqual(planBefore);expect(f.host.returnToObservedSource).not.toHaveBeenCalled();
  f.task.routeRetries=recordRouteRetry(f.task.routeRetries,{routeKey:selected.routeKey,conditionVersion:selected.conditionVersion,outcome:'unverified',reason:'native return did not settle'});
  expect(f.select()).toBeUndefined();expect(f.task.scheduling!.deferred![f.item.id].reason).toBe('route_retry_condition_attempted');
  expect(f.task.routeRetries!.routes[key]).toEqual(before);expect(f.task.scheduling!.routes[key]).toEqual(routeBefore);
 }finally{await f.close();}
});

it('100 price, DOM and capture changes neither change the source condition nor renew its spent route',async()=>{
 const f=fixture();try{
  const first=f.select(),condition=first.conditionVersion;
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:first.routeKey,conditionVersion:condition,outcome:'unverified',reason:'already tried this native position'});
  for(let tick=0;tick<100;tick++){
   f.current.id=`capture-${tick}`;f.current.documentId=`document-${tick}`;f.current.instanceScope=`instance-${tick}`;
   f.current.canonical=`price-${100+tick}`;f.current.stateId=`state-${tick}`;f.current.context.account.source=`capture:${tick}`;
   f.current.controls=[{localId:`dom-${tick}`,instanceId:`instance-${tick}`,stableKey:`id:quote-${tick}`,name:`Price ${100+tick}`,value:String(100+tick),displayedText:String(100+tick)}] as any;
   const sourceCapture=structuredClone(f.source);sourceCapture.id=`source-capture-${tick}`;sourceCapture.documentId=`source-dom-${tick}`;sourceCapture.controls=structuredClone(f.current.controls);
   expect(sourceReturnCondition(sourceCapture,f.current)).toBe(condition);expect(f.select()).toBeUndefined();
  }
  expect(Object.keys(f.task.routeRetries!.routes)).toEqual([first.routeKey]);
  expect(Object.values(f.task.routeRetries!.routes[first.routeKey].conditions)).toEqual([{attempts:1,outcome:'unverified',reason:'already tried this native position'}]);
  expect(f.task.scheduling!.deferred![f.item.id].reason).toBe('route_retry_condition_attempted');
 }finally{await f.close();}
});

it('distinguishes repeated native entries for the same URL without inventing a different route',async()=>{
 const f=fixture();try{
  const first=f.select();f.task.routeRetries=recordRouteRetry(undefined,{routeKey:first.routeKey,conditionVersion:first.conditionVersion,outcome:'unverified',reason:'first native position failed'});
  f.current.navigation!.entries.push({id:3,url:awayUrl,method:'GET'});f.current.navigation!.currentIndex=2;
  const second=f.select();expect(second.routeKey).toBe(first.routeKey);expect(second.conditionVersion).not.toBe(first.conditionVersion);
  const source2=structuredClone(f.source);source2.navigation!.entries[0].id=4;f.current.navigation!.entries.push({id:4,url:sourceUrl,method:'GET'});
  expect(sourceReturnCondition(source2,f.current)).toBeDefined();expect(sourceReturnCondition(source2,f.current)).not.toBe(second.conditionVersion);
  expect(f.task.routeRetries!.routes[first.routeKey].conditions[first.conditionVersion].outcome).toBe('unverified');
 }finally{await f.close();}
});

it('does not use a new arrival contract to bypass an unmapped legacy failure',async()=>{
 const f=fixture();try{
  f.task.routeRetries=recordRouteRetry(undefined,{routeKey:'opaque-legacy',conditionVersion:'old-condition',outcome:'unverified',reason:'missing retained route mapping'});
  const before=structuredClone(f.task.routeRetries);
  expect(f.select()).toBeUndefined();expect(f.task.scheduling!.legacyUnmappedRouteKeys).toEqual(['opaque-legacy']);
  expect(f.task.scheduling!.deferred![f.item.id].reason).toBe('legacy_route_debt_unmapped');expect(f.task.routeRetries).toEqual(before);
 }finally{await f.close();}
});

it.each(['mapped strict','mapped other page','unknown record without flag','unmapped unknown'] as const)('blocks %s unknown debt even when the SDK reports no current unknown attempts',async kind=>{
 const f=fixture();try{
  const {key}=f.mapStrictDebt('unknown',kind==='mapped other page');
  if(kind==='unknown record without flag')delete f.task.routeRetries!.routes[key].unknown;
  if(kind==='unmapped unknown')delete f.task.scheduling;
  expect(f.host.recoveryAssessment('session').unknownAttempts).toEqual([]);
  expect(f.task.routeRetries!.routes[key].conditions['old-condition'].unknownSource).toBeUndefined();
  const before=structuredClone(f.task.routeRetries);
  expect(f.select()).toBeUndefined();expect(f.task.scheduling!.deferred![f.item.id].reason).toBe('source_return_unknown_route_debt');
  f.current.navigation!.entries.push({id:3,url:awayUrl,method:'GET'});f.current.navigation!.currentIndex=2;
  expect(f.select()).toBeUndefined();expect(f.task.routeRetries).toEqual(before);
  expect(Object.values(f.task.scheduling!.routes).some(route=>route.arrivalMode==='observed-source')).toBe(false);
  expect(f.host.returnToObservedSource).not.toHaveBeenCalled();
 }finally{await f.close();}
});
