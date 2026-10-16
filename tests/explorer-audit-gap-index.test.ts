import {EventEmitter} from 'node:events';
import {expect,it} from 'vitest';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Scope,type Task} from '@interaction/explorer-plugin';
import type {ActionCandidate,Observation} from '@interaction/browser';
import {auditGapIndex} from '../packages/explorer-plugin/src/audit-gap-index.js';
import {availabilityObligation} from '../packages/explorer-plugin/src/operation-availability.js';
import {operationSchedulingDigest,operationSchedulingProofHash,boundOperationCondition} from '../packages/explorer-plugin/src/plan-state.js';
import {schedulingKeyFor,scopeFor} from '../packages/explorer-plugin/src/policy.js';

const scope:Scope={url:'https://fixture.invalid/',label:'Open',role:'button',kind:'click',stableKey:'id:open'};
const item=(id:string,changes:Partial<PlanItem>={}):PlanItem=>({id,title:'Open',scope,prerequisites:[],completion:'Execute',status:'pending',reason:'observed_in_scope',required:true,dispatchScope:false,operationConditionKey:'v2',operationConditionPolicy:'browser-operation-key-v2',evidence:[{sessionId:'session',observationId:'old'}],attempts:[],...changes});
function alias(row:PlanItem){const audit={policy:'browser-operation-key-v3' as const,fromPolicy:'browser-operation-key-v2' as const,fromKey:'v2',toKey:'v3',scopeKey:operationSchedulingDigest(row.scope),sources:[JSON.stringify(['session','old',''])],legacyKeys:['v2'],proofHash:''};audit.proofHash=operationSchedulingProofHash(audit);row.operationSchedulingNormalization=audit;}
function fixture(rows:PlanItem[]=[]){
 const o={sessionId:'session',id:'current',instanceScope:'doc',url:scope.url,controls:[],regions:[],context:{},boundaries:[],gaps:[]} as unknown as Observation;
 const host={events:new EventEmitter(),observation:()=>o,actions:()=>[],list:()=>[]} as unknown as ExplorerHost,store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(host,store),task=plugin.create({url:scope.url!,coverageMode:'all'});
 task.plan=[item('root',{scope:{url:scope.url},dispatchScope:true,operationConditionKey:undefined,reason:'user_goal'}),...rows];
 task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:'2026-01-01T00:00:00.000Z',status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
 const index=auditGapIndex(task.plan);
 const gap=(reason:string,path:Scope[]=[],condition='v2',source='current')=>(plugin as any).gap(task,reason,scope,true,path,false,{sessionId:'session',id:source},condition,'unique-current',host,index) as PlanItem;
 return {o,host,store,plugin,task,index,gap};
}
it('narrows reason, complete operation condition and prerequisites while retaining stable plan order',()=>{
 const a=item('first'),b=item('gap',{reason:'operation_not_executed'}),otherPath=item('path',{prerequisites:[{label:'Enter'}]}),otherValue=item('value',{scope:{...scope,value:'other'}}),unknown=item('unknown',{reason:'unknown_action_outcome'});
 const index=auditGapIndex([a,b,otherPath,otherValue,unknown]);
 expect(index.exact('observed_in_scope',scope,'v2').map(i=>i.id)).toEqual(['first','path']);
 expect(index.availability(scope,'v2',[]).map(i=>i.id)).toEqual(['first','gap','unknown']);
 expect(availabilityObligation(index.availability(scope,'v2',[]),'region_review_required',scope,'v2',true)).toBe(b);
 index.refresh(a);expect(index.availability(scope,'v2',[]).map(i=>i.id)).toEqual(['first','gap','unknown']);
 expect(index.availability(scope,'v2',[{label:'Enter'}])).toEqual([otherPath]);expect(index.availability(scope,'different',[])).toEqual([]);
});
it('keeps a different prerequisite as a separate cross-reason obligation',async()=>{
 const old=item('old'),f=fixture([old]);try{const added=f.gap('region_review_required',[{label:'Enter'}]);expect(added).not.toBe(old);expect(old.evidence).toHaveLength(1);expect(f.task.plan).toHaveLength(3);expect(added.prerequisites).toEqual([{label:'Enter'}]);}finally{await f.plugin.close();}
});
it('refreshes newly appended rows before another gap and preserves every source',async()=>{
 const f=fixture();try{const first=f.gap('pointer_intercepted'),second=f.gap('region_review_required',[],'v2','next');expect(second).toBe(first);expect(f.task.plan).toHaveLength(2);expect(first.evidence.map(e=>e.observationId)).toEqual(['current','next']);expect(first.status).toBe('unresolved');expect(first.operationAvailability?.reason).toBe('region_review_required');}finally{await f.plugin.close();}
});
it('removes an invalidated effective alias from the current audit index after a failed source append',async()=>{
 const old=item('old');alias(old);const f=fixture([old]);try{
  expect(f.index.exact('observed_in_scope',scope,'v3')).toEqual([old]);
  expect(f.gap('region_review_required',[],'v3')).toBe(old);expect(old.operationSchedulingNormalization).toBeUndefined();expect(boundOperationCondition(old)).toBe('v2');
  expect(f.index.exact('observed_in_scope',scope,'v3')).toEqual([]);expect(f.index.exact('observed_in_scope',scope,'v2')).toEqual([old]);
  expect(f.gap('pointer_intercepted',[],'v3','next')).not.toBe(old);expect(f.task.plan).toHaveLength(3);expect(old.evidence.map(e=>e.observationId)).toEqual(['old','current']);
 }finally{await f.plugin.close();}
});
it('builds an independent verified index after edits between synchronous audits',()=>{
 const old=item('old');alias(old);expect(auditGapIndex([old]).exact('observed_in_scope',scope,'v3')).toEqual([old]);
 old.evidence.push({sessionId:'session',observationId:'unvalidated'});const next=auditGapIndex([old]);expect(next.exact('observed_in_scope',scope,'v3')).toEqual([]);expect(next.exact('observed_in_scope',scope,'v2')).toEqual([old]);
});
it('counts all current actions when a second same-scope candidate is not pending',async()=>{
 const f=fixture();try{
  const c={localId:'target',instanceId:'target',identityId:'identity',tag:'button',role:'button',name:'Open',label:'Open',region:'page',stableKey:'id:open',visible:true,enabled:true,actions:['click'],constraints:{},actionable:{hitTarget:true,unknown:[]}};
  Object.assign(f.o,{stable:true,ruleVersion:'v1',controls:[c],regions:[{key:'page',label:'Page',role:'document'}],components:[]});
  const a={id:'pending',sessionId:'session',observationId:'current',localId:'target',controlId:'identity',label:'Open',kind:'click',basis:{status:'supported'},preconditions:{visible:true,enabled:true,context:{}}} as ActionCandidate,duplicate={...a,id:'not-pending'};
  const old=item('old',{scope:scopeFor(a,f.o),operationConditionKey:schedulingKeyFor(a,f.o)});f.task.plan.push(old);
  const snapshot={actions:[a,duplicate],operationCandidates:[a],availability:{observationId:f.o.id,actions:[{actionId:a.id,executable:false,blockers:[{code:'ACTION_BLOCKED',reason:'region_review_required',evidence:[]}]}]},revision:'r',obligations:{criticalGaps:[],regions:[],classifications:[],operations:[],identities:[],pageTraversal:false,discovery:false}};
  (f.plugin as any).auditRemainingScopes(f.task,f.task.rounds[0],f.o,snapshot,new Set());
  expect(f.task.plan).toHaveLength(3);expect(old.evidence).toHaveLength(1);expect(f.task.plan[2]).toMatchObject({reason:'region_review_required',status:'unresolved'});
 }finally{await f.plugin.close();}
});
