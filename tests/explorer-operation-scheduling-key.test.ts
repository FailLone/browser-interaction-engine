import {expect,it,vi} from 'vitest';
import type {ActionAttempt,ActionCandidate,Observation} from '@interaction/browser';
import {browserOperationKey,browserOperationSchedulingKey} from '../packages/adapter-playwright/src/exploration.js';
import {browserTargetConditions} from '../packages/adapter-playwright/src/target-arrival.js';
import {migrateOperationConditions,normalizeOperationScheduling,schedulingKeyFor,scopeFor} from '../packages/explorer-plugin/src/policy.js';
import {boundOperationCondition,conditionSplitIssues,operationSchedulingAliases,operationSchedulingDigest,operationSchedulingProofHash} from '../packages/explorer-plugin/src/plan-state.js';
import type {ExplorerHost,PlanItem} from '../packages/explorer-plugin/src/types.js';
import {projectObligations,recoveryRouteKey} from '../packages/explorer-plugin/src/obligation-lifecycle.js';
function frame(id='old',mode='A',unverified=false){
 const control={localId:`${id}:target`,instanceId:`${id}:target`,identityId:`identity-${id}`,tag:'button',role:'button',name:'Run',label:'Run',region:'document',visible:true,enabled:true,selected:[],constraints:{type:'button'},actions:['click'],actionable:{hitTarget:true,unknown:[]},
  structuralItem:{ownerInstanceId:`${id}:owner`,recordKey:'["record","123"]',template:'row',slot:'run'},
  stableKey:`structural-item:${JSON.stringify([`${id}:owner`,'["record","123"]','run'])}`,identityContext:{scope:'orders',binding:'record-123',evidence:['fixture']}} as unknown as Observation['controls'][number];
 const selector={localId:`${id}:mode`,instanceId:`${id}:mode`,tag:'select',role:'combobox',name:'Mode',label:'Mode',region:'document',visible:false,enabled:true,selected:[mode],stableKey:'id:mode',constraints:{type:'select'},...unverified?{identityScope:'instance'}:{}} as unknown as Observation['controls'][number];
 const o={id,sessionId:'session',instanceScope:id,url:'https://fixture.invalid/',ruleVersion:'observable-v7',context:{account:{status:'known',value:'anon',source:'fixture'}},stable:true,gaps:[],controls:[control,selector],regions:[{key:'document',label:'Page',role:'document'}],components:[],boundaries:[]} as unknown as Observation;
 const a={id:`action-${id}`,sessionId:o.sessionId,observationId:id,localId:control.localId,controlId:control.identityId,kind:'click',label:'Run',risk:'interface',excluded:false,replayable:true,preconditions:{visible:true,enabled:true,identityResolved:true,context:o.context}} as ActionCandidate;
 return {o,a};
}
function fixture(unverified=true){
 const x=frame('old','A',unverified),y=frame('new','A',unverified),observations=new Map([x.o,y.o].map(o=>[o.id,o])),actions=new Map([[x.o.id,[x.a]],[y.o.id,[y.a]]]),attempts:ActionAttempt[]=[];
 const host={observation:vi.fn((sid:string,id:string)=>{const o=observations.get(id);if(!o)throw Error('missing');return o;}),actions:vi.fn((sid:string,id:string)=>actions.get(id)||[]),list:vi.fn(()=>attempts)} as unknown as Pick<ExplorerHost,'observation'|'actions'|'list'>;
 const item:PlanItem={id:'item',title:'Run',scope:scopeFor(x.a,x.o),prerequisites:[],completion:'Execute recorded operation',required:true,dispatchScope:false,status:'pending',reason:'observed_in_scope',operationConditionKey:browserOperationKey(x.a,x.o),operationConditionPolicy:'browser-operation-key-v2',evidence:[{sessionId:x.o.sessionId,observationId:x.o.id}],attempts:[]};
 return {x,y,host,item,observations,actions,attempts,task:{plan:[item]}};
}
it('normalizes only the generated DOM owner while v2 remains a readable frozen encoding',()=>{
 const x=frame(),y=frame('new');expect(browserOperationKey(x.a,x.o)).not.toBe(browserOperationKey(y.a,y.o));
 expect(schedulingKeyFor(x.a,x.o)).toBe(schedulingKeyFor(y.a,y.o));expect(scopeFor(x.a,x.o)).toEqual(scopeFor(y.a,y.o));
 expect(recoveryRouteKey(x.o,[x.a],[scopeFor(x.a,x.o)])).toBe(recoveryRouteKey(y.o,[y.a],[scopeFor(y.a,y.o)]));
});
it.each(['record','slot','template','binding','context','mode','operation','local-key'] as const)('keeps changed %s distinguishable',change=>{
 const x=frame(),y=frame('new');const c=y.o.controls[0];
 if(change==='record')c.structuralItem!.recordKey='["record","456"]';
 if(change==='slot')c.structuralItem!.slot='other';if(change==='template')c.structuralItem!.template='other';
 if(change==='binding')c.identityContext!.binding='record-456';if(change==='context')y.o.context.account.value='other';
 if(change==='mode')y.o.controls[1].selected=['B'];if(change==='operation')y.a.kind='hover';
 if(change==='local-key')c.stableKey=`structural-item:${JSON.stringify([c.structuralItem!.ownerInstanceId,c.structuralItem!.recordKey,'different-handler'])}`;
 expect(schedulingKeyFor(x.a,x.o)).not.toBe(schedulingKeyFor(y.a,y.o));
});
it('does not manufacture operation conditions from an unverified scheduling hint',()=>{
 const x=frame('old','A',true),y=frame('new','A',true);expect(schedulingKeyFor(x.a,x.o)).toBe(schedulingKeyFor(y.a,y.o));
 expect(browserTargetConditions(x.a,x.o)).toBeUndefined();expect(browserTargetConditions(y.a,y.o)).toBeUndefined();
});
it.each(['id:explicit','structural-item:broken','structural-item:["foreign-owner","record","slot"]'])('retains explicit or unfamiliar encoding %s',key=>{
 const {o,a}=frame();o.controls[0].stableKey=key;expect(browserOperationSchedulingKey(a,o)).toBe(browserOperationKey(a,o));
});
it('adds an audited hint without replacing original source, condition, attempt cache or route debt',()=>{
 const f=fixture(),before=structuredClone(f.item),task={...f.task,rounds:[{tried:[f.item.operationConditionKey!]}],routeRetries:{routes:{old:{unknown:true}}}};
 expect(normalizeOperationScheduling(task,f.host)).toHaveLength(1);
 const {operationSchedulingNormalization,...rest}=f.item;expect(rest).toEqual(before);expect(boundOperationCondition(f.item)).toBe(schedulingKeyFor(f.y.a,f.y.o));
 expect(operationSchedulingAliases(f.item)).toContain(task.rounds[0].tried[0]);expect(task.routeRetries).toEqual({routes:{old:{unknown:true}}});
 vi.mocked(f.host.observation).mockClear();expect(normalizeOperationScheduling(task,f.host)).toEqual([]);expect(f.host.observation).not.toHaveBeenCalled();
});
it('extends an audited hint using only the new source, preserving its different v2 provenance',()=>{
 const f=fixture();normalizeOperationScheduling(f.task,f.host);vi.mocked(f.host.observation).mockClear();
 f.item.evidence.push({sessionId:'session',observationId:f.y.o.id});expect(boundOperationCondition(f.item)).toBe(f.item.operationConditionKey);
 expect(normalizeOperationScheduling(f.task,f.host,[f.item])).toHaveLength(1);expect(f.host.observation).toHaveBeenCalledTimes(1);expect(f.host.observation).toHaveBeenCalledWith('session','new');
 expect(boundOperationCondition(f.item)).toBe(schedulingKeyFor(f.y.a,f.y.o));expect(operationSchedulingAliases(f.item)).toContain(browserOperationKey(f.y.a,f.y.o));expect(f.item.evidence).toHaveLength(2);
});
it('rejects an unproved initial mixture and an appended changed semantic binding',()=>{
 const f=fixture();f.item.evidence.push({sessionId:'session',observationId:'new'});expect(normalizeOperationScheduling(f.task,f.host)).toEqual([]);expect(f.item.operationSchedulingNormalization).toBeUndefined();
 f.item.evidence.pop();normalizeOperationScheduling(f.task,f.host);f.y.o.controls[0].identityContext!.binding='other';f.item.evidence.push({sessionId:'session',observationId:'new'});
 expect(normalizeOperationScheduling(f.task,f.host)).toEqual([{itemId:'item',reason:'source_proof_unavailable'}]);expect(boundOperationCondition(f.item)).toBe(f.item.operationConditionKey);
});
it('validates attempt-only evidence against its actual before observation and preserves the attempt',()=>{
 const f=fixture(),a={id:'attempt',sessionId:'session',beforeId:'old',afterId:'new',action:f.x.a,status:'succeeded'} as ActionAttempt;
 f.attempts.push(a);const ref={sessionId:'session',observationId:'new',attemptId:a.id};f.item.evidence=[ref];f.item.attempts=[{roundId:'round',outcome:'succeeded',evidence:ref}];f.item.status='succeeded';f.item.resolvedBy=ref;
 const before=structuredClone(f.item);expect(normalizeOperationScheduling(f.task,f.host)).toHaveLength(1);
 expect(f.item.operationSchedulingNormalization!.sources).toEqual([JSON.stringify(['session','new','attempt'])]);
 expect(f.host.observation).toHaveBeenCalledWith('session','old');expect(f.host.actions).toHaveBeenCalledWith('session','old');
 const {operationSchedulingNormalization,...rest}=f.item;expect(rest).toEqual(before);expect(f.host.list).toHaveBeenCalledTimes(1);
});
it.each(['missing','foreign-session','wrong-observation','unknown'] as const)('does not normalize %s attempt evidence',kind=>{
 const f=fixture();const ref={sessionId:'session',observationId:'new',attemptId:'attempt'};f.item.evidence=[ref];f.item.attempts=[{roundId:'round',outcome:kind==='unknown'?'unknown':'succeeded',evidence:ref}];
 if(kind!=='missing')f.attempts.push({id:'attempt',sessionId:kind==='foreign-session'?'other':'session',beforeId:'old',afterId:kind==='wrong-observation'?'elsewhere':'new',action:f.x.a,status:kind==='unknown'?'unknown':'succeeded'} as ActionAttempt);
 const before=structuredClone(f.item);expect(normalizeOperationScheduling(f.task,f.host)).toEqual([]);expect(f.item).toEqual(before);
});
it.each([false,true])('preserves split parent proof when a v2 condition child gets a hint (selected=%s)',selected=>{
 const f=fixture(false),ref=f.item.evidence[0],parent:PlanItem={...structuredClone(f.item),id:'parent',status:'superseded',operationConditionKey:'v1-key',conditionMigration:{version:2,status:'split',fromKey:'v1-key',reason:'retained_sources_split',sources:[{...ref,actionId:f.x.a.id}],children:[{itemId:f.item.id,kind:'condition',operationConditionKey:f.item.operationConditionKey,scope:f.item.scope,required:true,dispatchScope:false,sources:[ref]}]}};
 f.item.conditionLineage={parentItemId:'parent',policy:'operation-condition-split-v1',kind:'condition',fromKey:'v1-key'};f.task.plan.unshift(parent);if(selected){f.item.dispatchScope=true;parent.conditionMigration!.children![0].dispatchScope=true;}const before=structuredClone(parent);
 expect(conditionSplitIssues(f.task.plan).size).toBe(0);expect(normalizeOperationScheduling(f.task,f.host)).toHaveLength(1);
 expect(f.item.operationSchedulingNormalization).toBeDefined();expect(boundOperationCondition(f.item)).toBe(schedulingKeyFor(f.x.a,f.x.o));
 expect(boundOperationCondition(f.item)).not.toBe(f.item.operationConditionKey);expect(parent).toEqual(before);expect(conditionSplitIssues(f.task.plan).size).toBe(0);
});
it('projects normalized current and retained source keys without claiming equivalence',()=>{
 const f=fixture();normalizeOperationScheduling(f.task,f.host);
 const host={...f.host,operationCorrespondences:vi.fn(()=>({sessionId:'session',observationId:'new',results:[]}))};
 const {projection}=projectObligations(host as any,f.task,f.y.o,[f.y.a]);expect(projection.entries[0]).toMatchObject({itemId:'item',state:'active',currentActionId:f.y.a.id});
 expect(f.item.status).toBe('pending');expect(f.item.attempts).toEqual([]);expect(f.item.resolvedBy).toBeUndefined();
});
it('invalidates a cached proof when original sources or scope are altered',()=>{
 const f=fixture();normalizeOperationScheduling(f.task,f.host);f.item.scope.label='Other';expect(boundOperationCondition(f.item)).toBe(f.item.operationConditionKey);
 f.item.scope=scopeFor(f.x.a,f.x.o);f.item.evidence=[];expect(boundOperationCondition(f.item)).toBe(f.item.operationConditionKey);
});

it('does not reinterpret a current v3 row as a legacy v1 migration on resume',()=>{
 const f=fixture();f.item.operationConditionKey=schedulingKeyFor(f.x.a,f.x.o);f.item.operationConditionPolicy='browser-operation-key-v3';
 const before=structuredClone(f.item);expect(migrateOperationConditions(f.task,f.host)).toEqual([]);expect(normalizeOperationScheduling(f.task,f.host)).toEqual([]);expect(f.item).toEqual(before);expect(f.host.observation).not.toHaveBeenCalled();
});


it('omits unchanged v2 encodings without changing original fields',()=>{
 const f=fixture();f.x.o.controls[0].stableKey='id:explicit';f.item.scope=scopeFor(f.x.a,f.x.o);f.item.operationConditionKey=browserOperationKey(f.x.a,f.x.o);
 const before=structuredClone(f.item);expect(schedulingKeyFor(f.x.a,f.x.o)).toBe(f.item.operationConditionKey);
 expect(normalizeOperationScheduling(f.task,f.host)).toEqual([]);expect(f.item).toEqual(before);
});
it('keeps compact ref and retry alias integrity fail-closed',()=>{
 const f=fixture();normalizeOperationScheduling(f.task,f.host);const audit=structuredClone(f.item.operationSchedulingNormalization!);
 f.item.operationSchedulingNormalization!.legacyKeys.push('unproved-alias');expect(operationSchedulingAliases(f.item)).toEqual([f.item.operationConditionKey]);
 f.item.operationSchedulingNormalization=structuredClone(audit);f.item.operationSchedulingNormalization.sources[0]=JSON.stringify(['session','other','']);
 f.item.operationSchedulingNormalization.proofHash=operationSchedulingProofHash(f.item.operationSchedulingNormalization);expect(boundOperationCondition(f.item)).toBe(f.item.operationConditionKey);
 f.item.operationSchedulingNormalization=structuredClone(audit);f.item.operationSchedulingNormalization.sources.push(audit.sources[0]);
 f.item.operationSchedulingNormalization.proofHash=operationSchedulingProofHash(f.item.operationSchedulingNormalization);expect(boundOperationCondition(f.item)).toBe(f.item.operationConditionKey);
});
it('native audit hashes equal the existing canonical core hash',async()=>{
 const {hash}=await import('@interaction/core');const f=fixture();normalizeOperationScheduling(f.task,f.host);
 for(const value of [f.item.scope,f.item.operationSchedulingNormalization,[undefined,{a:undefined,b:['x',null,12]}],'literal'])expect(operationSchedulingDigest(value)).toBe(hash(value));
});
it('indexes full literal scopes while rejecting a second identical current action',()=>{
 const f=fixture();f.actions.set('old',[f.x.a,{...f.x.a,id:'duplicate'}]);
 expect(normalizeOperationScheduling(f.task,f.host)).toEqual([]);expect(f.item.operationSchedulingNormalization).toBeUndefined();
});
