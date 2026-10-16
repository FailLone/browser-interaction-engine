import {EventEmitter} from 'node:events';
import {expect,it} from 'vitest';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem,type Task} from '@interaction/explorer-plugin';
import {availabilityObligation} from '../packages/explorer-plugin/src/operation-availability.js';

const scope={url:'https://fixture.invalid/',label:'Open',role:'button',kind:'click',stableKey:'id:open'};
type OperationScope=typeof scope;
const item=(changes:Partial<PlanItem>={}):PlanItem=>({id:'pending',title:'Open',scope,prerequisites:[],completion:'Observe execution',status:'unresolved',reason:'operation_not_executed',required:true,dispatchScope:false,
 operationConditionKey:'condition',operationConditionPolicy:'browser-operation-key-v2',evidence:[{sessionId:'session',observationId:'old'}],attempts:[],...changes});
const select=(items:PlanItem[],reason='region_review_required')=>availabilityObligation(items,reason,scope,'condition',true);

it('treats a changed mechanical blocker as availability of the same unfinished scheduling obligation',()=>{
 const prior=item(),before=structuredClone(prior);expect(select([prior])).toBe(prior);expect(prior).toEqual(before);
});
it('prefers an existing gap without retiring older discovered or duplicate rows',()=>{
 const discovered=item({id:'discovered',reason:'observed_in_scope',status:'pending'}),gap=item(),duplicate=item({id:'another'});
 expect(select([discovered,gap,duplicate])).toBe(gap);expect([discovered,gap,duplicate].map(i=>i.status)).toEqual(['pending','unresolved','unresolved']);
});
it.each(['unknown_action_outcome','checkpoint_unverified','classification_unresolved','operation_basis_unconfirmed','operation_risk_unresolved','reentry_not_repeatable','scope_deferred','sample_unselected','missing_capability:probe','identity_unresolved'])('does not fold independent %s gaps into an operation',reason=>{
 expect(select([item()],reason)).toBeUndefined();expect(select([item({reason})])).toBeUndefined();
});
it.each(['succeeded','blocked','excluded','untested','superseded'] as const)('retains %s history independently',status=>{expect(select([item({status})])).toBeUndefined();});
it('requires the complete scope, condition and authority to agree',()=>{
 for(const changed of [{scope:{...scope,targetBinding:'other'}},{scope:{...scope,value:'B'}},{operationConditionKey:'other'},{required:false},{dispatchScope:true}] as Partial<PlanItem>[])
  expect(select([item(changed)])).toBeUndefined();
 expect(availabilityObligation([item()],'region_review_required',scope,'condition',false)).toBeUndefined();
});
it('preserves attempts, coverage, recovery waits and condition migrations independently',()=>{
 const ref={sessionId:'session',observationId:'old',attemptId:'attempt'};
 for(const changed of [{attempts:[{roundId:'round',outcome:'succeeded',evidence:ref}]},{resolvedBy:ref},{coverageResolvedBy:{observation:ref,relatedItemIds:[]}},
  {conditionMigration:{status:'migrated',fromKey:'old',toKey:'condition',reason:'test',sources:[]}}] as Partial<PlanItem>[])
  expect(select([item(changed)])).toBeUndefined();
});

function fixture(){
 const host={events:new EventEmitter(),observation:()=>({sessionId:'session',id:'current'})} as unknown as ExplorerHost;
 const store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(host,store),task=plugin.create({url:scope.url,coverageMode:'all'});
 task.plan=[{...item({id:'root',scope:{url:scope.url},dispatchScope:true,status:'pending',reason:'user_goal'}),operationConditionKey:undefined},item()];
 task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:new Date().toISOString(),status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
 const runtime=plugin as unknown as {gap(task:Task,reason:string,scope:OperationScope,required:boolean,path:[],persist:boolean,source:{sessionId:string;id:string},condition:string,uniqueActionId?:string):PlanItem};
 return {plugin,store,task,gap:(reason:string,observationId:string,unique=true)=>runtime.gap(task,reason,scope,true,[],true,{sessionId:'session',id:observationId},'condition',unique?'exact-current-action':undefined)};
}
it('persists repeated availability changes as one pending item with all sources and reason-change events',async()=>{
 const f=fixture();try{
  const prior=f.task.plan[1];f.gap('region_review_required','current');f.gap('pointer_intercepted','next');f.gap('operation_not_executed','third');
  expect(f.task.plan).toHaveLength(2);expect(prior.status).toBe('unresolved');expect(prior.attempts).toEqual([]);expect(prior.resolvedBy).toBeUndefined();
  expect(prior.evidence.map(e=>e.observationId)).toEqual(['old','current','next','third']);
  expect(f.store.task(f.task.id).plan[1]).toEqual(prior);
  const events=f.store.events(f.task.id).filter(e=>e.type==='scope.availability_updated');expect(events).toHaveLength(3);
  expect(events.every(e=>(e.data as {coverageGranted:boolean}).coverageGranted===false)).toBe(true);
 }finally{await f.plugin.close();}
});
it('retains a separate blocker without a unique current candidate',async()=>{
 const f=fixture();try{f.gap('region_review_required','current',false);expect(f.task.plan).toHaveLength(3);expect(f.task.plan[1].evidence.map(e=>e.observationId)).toEqual(['old']);}finally{await f.plugin.close();}
});
