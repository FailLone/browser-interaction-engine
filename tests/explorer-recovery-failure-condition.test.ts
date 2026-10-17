import {expect,it} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Observation} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type PlanItem} from '@interaction/explorer-plugin';
import {recordRouteRetry,retainRouteFailureCondition,routeRetryEligibility,releaseRouteRetryForProgress,releaseRouteRetriesForVerifiedRecovery,recoveryRouteConditionVersion,recoveryRouteKey} from '../packages/explorer-plugin/src/obligation-lifecycle.js';
import {recoveryFailureCondition} from '../packages/explorer-plugin/src/recovery-failure.js';

const observation=(id='landing'):Observation=>({id,sessionId:'session',url:'https://fixture.test/',ruleVersion:'observable-v7',context:{},stable:true,gaps:[],boundaries:[],regions:[],controls:[]} as unknown as Observation);
const reason='replay_target_not_unique_or_missing';
const evidence={sessionId:'session',observationId:'landing'};

it('does not count a failed landing condition as another attempt or a new retry after restart',()=>{
 const resultCondition=recoveryFailureCondition(observation(),'landing-condition',reason)!;
 let ledger=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:'start-condition',attemptKey:'attempt',outcome:'no_progress',reason:'reserved'});
 ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'start-condition',attemptKey:'attempt',outcome:'unverified',reason,evidence,resultCondition});
 ledger=JSON.parse(JSON.stringify(ledger));
 expect(Object.keys(ledger.routes.route.conditions)).toEqual(['start-condition']);
 expect(ledger.routes.route.conditions['start-condition']).toMatchObject({attempts:1,resultCondition});
 expect(routeRetryEligibility(ledger,'route','start-condition')).toMatchObject({allowed:false,reason:'condition_attempted',attempts:1});
 expect(routeRetryEligibility(ledger,'route','landing-condition')).toMatchObject({allowed:false,reason:'failed_result_condition',attempts:0});
 expect(routeRetryEligibility(ledger,'route','different-route-condition').allowed).toBe(true);
 expect(routeRetryEligibility(ledger,'new-observed-path','landing-condition').allowed).toBe(true);
});

it('retains the original record and exact evidence when upgrading a legacy failure',()=>{
 const original=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:'start-condition',attemptKey:'attempt',outcome:'unverified',reason,evidence});
 const before=structuredClone(original),condition=recoveryFailureCondition(observation(),'landing-condition',reason)!;
 const upgraded=retainRouteFailureCondition(original,'route','start-condition',condition);
 expect(original).toEqual(before);expect(upgraded.routes.route.conditions['start-condition']).toEqual({...before.routes.route.conditions['start-condition'],resultCondition:condition});
 expect(retainRouteFailureCondition(upgraded,'route','start-condition',condition)).toEqual(upgraded);
 expect(retainRouteFailureCondition(original,'route','start-condition',{...condition,evidence:{...evidence,sessionId:'another'}})).toEqual(original);
 expect(retainRouteFailureCondition(original,'route','start-condition',{...condition,evidence:{...evidence,observationId:'different'}})).toEqual(original);
 expect(retainRouteFailureCondition(original,'missing','start-condition',condition)).toEqual(original);
});

it('allows a later complete retry after a solely unstable result, but retains separate stable replay failure evidence',()=>{
 const unstable={...observation(),stable:false,gaps:[{code:'UNSTABLE',message:'Rendering still changes',critical:false}]};
 expect(recoveryFailureCondition(unstable,'landing-condition','Entry replay verification: UNVERIFIED')).toBeUndefined();
 expect(recoveryFailureCondition(unstable,'landing-condition',reason)).toBeUndefined();
 const interactive={...unstable,gaps:[...unstable.gaps,{code:'INTERACTION_STABLE',message:'Interaction projection is stable',critical:false}]};
 expect(recoveryFailureCondition(interactive,'landing-condition',reason)?.basis).toBe('replay-target-unavailable');
 expect(recoveryFailureCondition(interactive,'landing-condition','Entry replay verification: UNVERIFIED')).toBeUndefined();
 const ledger=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:'start-condition',outcome:'unverified',reason:'Entry replay verification: UNVERIFIED',evidence,resultCondition:recoveryFailureCondition(unstable,'landing-condition','Entry replay verification: UNVERIFIED')});
 expect(routeRetryEligibility(ledger,'route','landing-condition').allowed).toBe(true);
 expect(recoveryFailureCondition(observation(),'landing-condition','Entry replay verification: UNVERIFIED')?.basis).toBe('complete-observation');
});

it('does not turn missing or unknown captured facts into a failed-result condition',()=>{
 expect(recoveryFailureCondition({...observation(),gaps:[{code:'TRUNCATED',message:'Missing controls',critical:true}]},'landing-condition',reason)).toBeUndefined();
 expect(recoveryFailureCondition({...observation(),context:{account:{status:'unknown',source:'fixture',value:null}}},'landing-condition',reason)).toBeUndefined();
});

it('keeps unknown debt dominant and consumes only the original SDK continuation allowance',()=>{
 const resultCondition=recoveryFailureCondition(observation(),'landing-condition',reason)!;
 let ledger=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:'start-condition',attemptKey:'failed',outcome:'unverified',reason,evidence,resultCondition});
 ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'other-condition',attemptKey:'unknown',outcome:'unknown',reason:'outcome missing',evidence,unknownSource:{sessionId:'session',attemptIds:['unknown']}});
 expect(routeRetryEligibility(ledger,'route','landing-condition').reason).toBe('unknown_result');
 expect(releaseRouteRetryForProgress(ledger,'route','child-complete')).toEqual(ledger);
 const host={list:(_sid:string,kind:string)=>kind==='attempt'?[{id:'unknown',sessionId:'session',status:'unknown'}]:[{id:'continuation',sessionId:'session',verifiedRecovery:{attemptIds:['unknown'],evidence:['SDK verified recovery']}}]} as any;
 const released=releaseRouteRetriesForVerifiedRecovery(host,ledger,'session');
 expect(routeRetryEligibility(released.ledger,'route','landing-condition')).toMatchObject({allowed:true,reason:'verified_recovery'});
 let used=recordRouteRetry(released.ledger,{routeKey:'route',conditionVersion:'landing-condition',attemptKey:'renewed',outcome:'no_progress',reason:'reserved'});
 used=recordRouteRetry(used,{routeKey:'route',conditionVersion:'landing-condition',attemptKey:'renewed',outcome:'unverified',reason,evidence,resultCondition});
 expect(used.routes.route.conditions['landing-condition'].attempts).toBe(1);
 expect(routeRetryEligibility(used,'route','landing-condition').allowed).toBe(false);
 expect(releaseRouteRetriesForVerifiedRecovery(host,used,'session').released).toEqual([]);
 expect(used.routes.route.recoveryVerifications?.[0].unknownRecords[0].record.outcome).toBe('unknown');
});

it('new verified child progress renews the route once without being confused with another capture',()=>{
 const resultCondition=recoveryFailureCondition(observation(),'landing-condition',reason)!;
 const failed=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:'start-condition',outcome:'unreachable',reason,evidence,resultCondition});
 const renewed=releaseRouteRetryForProgress(failed,'route','child-completed');
 expect(routeRetryEligibility(renewed,'route','landing-condition').allowed).toBe(true);
 const used=recordRouteRetry(renewed,{routeKey:'route',conditionVersion:'landing-condition',outcome:'unverified',reason,evidence,resultCondition});
 expect(routeRetryEligibility(releaseRouteRetryForProgress(used,'route','child-completed'),'route','landing-condition').allowed).toBe(false);
});

it('one verified continuation cannot forget another failed landing when the same start record is reused',()=>{
 const landing=recoveryFailureCondition(observation(),'landing-condition',reason)!;
 let ledger=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:'start-condition',attemptKey:'first',outcome:'unverified',reason,evidence,resultCondition:landing});
 ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'unknown-condition',attemptKey:'unknown',outcome:'unknown',reason:'unknown',evidence,unknownSource:{sessionId:'session',attemptIds:['unknown']}});
 const host={list:(_sid:string,kind:string)=>kind==='attempt'?[{id:'unknown',sessionId:'session',status:'unknown'}]:[{id:'continued',sessionId:'session',verifiedRecovery:{attemptIds:['unknown'],evidence:['SDK proof']}}]} as any;
 ledger=releaseRouteRetriesForVerifiedRecovery(host,ledger,'session').ledger;
 ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'start-condition',attemptKey:'second',outcome:'no_progress',reason:'reserved'});
 const next=recoveryFailureCondition(observation('next'),'next-condition',reason)!;
 ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'start-condition',attemptKey:'second',outcome:'unverified',reason,evidence:next.evidence,resultCondition:next});
 expect(ledger.routes.route.conditions['start-condition'].attempts).toBe(2);
 expect(routeRetryEligibility(ledger,'route','landing-condition')).toMatchObject({allowed:false,reason:'failed_result_condition'});
 expect(routeRetryEligibility(ledger,'route','next-condition')).toMatchObject({allowed:false,reason:'failed_result_condition'});
 expect(ledger.routes.route.failedResultConditions?.['landing-condition'].attemptKey).toBe('first');
 expect(routeRetryEligibility(ledger,'route','untried-condition').allowed).toBe(true);
});

it('bounds failed-result history without evicting old conditions and reopening their retries',()=>{
 let ledger;
 for(let index=0;index<20;index++)ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'start-condition',attemptKey:`attempt-${index}`,outcome:'unverified',reason,evidence,resultCondition:recoveryFailureCondition(observation(),`landing-${index}`,reason)});
 expect(Object.keys(ledger!.routes.route.failedResultConditions!)).toHaveLength(16);
 expect(routeRetryEligibility(ledger,'route','landing-0').reason).toBe('failed_result_condition');
 expect(routeRetryEligibility(ledger,'route','another-condition').reason).toBe('condition_limit');
});

it('100 passive price and capture changes cannot renew the same absent-target failure',()=>{
 const source=observation(),scope={url:source.url,label:'Missing Wallet',role:'button'},condition=recoveryRouteConditionVersion(source,[],[scope]);
 const ledger=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:'previous-page',outcome:'unverified',reason,evidence,resultCondition:recoveryFailureCondition(source,condition,reason)});
 for(let tick=0;tick<100;tick++){
  const current={...source,id:`capture-${tick}`,canonical:`Price ${tick}`,controls:[{localId:`quote-${tick}`,name:`Price ${tick}`}]} as Observation;
  expect(routeRetryEligibility(ledger,'route',recoveryRouteConditionVersion(current,[],[scope]))).toMatchObject({allowed:false,reason:'failed_result_condition'});
 }
 expect(Object.keys(ledger.routes.route.conditions)).toEqual(['previous-page']);expect(ledger.routes.route.conditions['previous-page'].attempts).toBe(1);
});

it.each(['stable-replay-failure','only-unstable','current-target-visible'] as const)('uses retained legacy failure evidence in the actual scheduler: %s',async variant=>{
 const source={...observation('source'),canonical:'original-modal',controls:[{localId:'wallet',name:'Wallet',label:'Wallet',role:'button',tag:'button',region:'dialog',visible:true,enabled:true}]} as Observation;
 const landing={...observation(),canonical:'missing-modal',stable:false,gaps:[{code:'UNSTABLE',message:'Passive rendering',critical:false},...(variant==='only-unstable'?[]:[{code:'INTERACTION_STABLE',message:'Controls settled',critical:false}])]};
 const current={...observation('current'),canonical:'current-frame',...(variant==='current-target-visible'?{controls:structuredClone(source.controls)}:{})};
 const scope={url:source.url,label:'Wallet',role:'button'},item:PlanItem={id:'wallet-review',title:'Review Wallet',scope,prerequisites:[],completion:'Review the target',required:true,dispatchScope:false,status:'unresolved',reason:'operation_basis_unconfirmed',evidence:[{sessionId:'session',observationId:source.id}],attempts:[]};
 const checkpoint={id:'checkpoint',sessionId:'session',observationId:source.id,stateId:'state'};
 const rows=new Map([source,landing,current].map(o=>[o.id,o]));
 const host={events:new EventEmitter(),session:()=>({id:'session',options:{},actionCount:0,currentObservationId:current.id}),actionAvailability:()=>({observationId:current.id,revision:'fixture-revision',actions:[]}),observation:(_sid:string,id?:string)=>{const o=rows.get(id||current.id);if(!o)throw Error('missing');return o;},actions:()=>[],list:(_sid:string,kind:string)=>kind==='checkpoint'?[checkpoint]:[],interactionTransition:()=>({retainedControls:[]}),recoveryAssessment:()=>({unknownAttempts:[]})} as unknown as ExplorerHost;
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'));
 try{
  const task=plugin.create({url:source.url,coverageMode:'all'});task.status='running';
  task.plan=[{...item,id:'root',scope:{url:source.url},dispatchScope:true,status:'pending',evidence:[]},item];
  task.rounds=[{id:'round',number:1,sessionId:'session',startedAt:new Date().toISOString(),status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
  const key=recoveryRouteKey(source,[],[scope]),conditionVersion=recoveryRouteConditionVersion(current,[],[scope]),failedReason=variant==='only-unstable'?'Entry replay verification: UNVERIFIED':reason;
  task.scheduling={version:1,localSelections:0,legacyUnmappedRouteKeys:[],routes:{[key]:{sessionId:'session',observationId:source.id,checkpointId:checkpoint.id,targets:[scope],path:[],itemIds:[item.id],memberKeys:[key],pathKeys:[],failure:{status:'invalidated',reason:failedReason,conditionVersion,targets:[scope]}}}};
  task.routeRetries=recordRouteRetry(undefined,{routeKey:key,conditionVersion:'old-entry',attemptKey:'old-attempt',outcome:'unverified',reason:failedReason,evidence});
  const before=structuredClone(task.plan),runtime=plugin as any;
  const selected=await runtime.scheduledRecovery(task,task.rounds[0],current,[],host.actionAvailability('session',current.id),runtime.routeConditionReader(current,[]));
  if(variant==='only-unstable'){
   expect(selected?.routeKey).toBe(key);expect(task.routeRetries.routes[key].failedResultConditions).toBeUndefined();
  }else{
   expect(selected).toBeUndefined();
   // A visible same-name control without captured classification/conditions is
   // not proof of current review equivalence. Existing failed-route debt still
   // prevents a retry, including the current-target-visible fixture.
   expect(task.scheduling.deferred?.[item.id].reason).toBe('route_retry_failed_result_condition');
   expect(task.routeRetries.routes[key].conditions['old-entry'].resultCondition).toMatchObject({conditionVersion,basis:'replay-target-unavailable'});
  }
  expect(task.plan).toEqual(before);expect(task.routeRetries.routes[key].conditions['old-entry'].attempts).toBe(1);
  expect(Object.keys(task.routeRetries.routes[key].conditions)).toEqual(['old-entry']);
 }finally{await plugin.close();}
});
