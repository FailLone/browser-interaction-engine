import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { Observation, Checkpoint } from '@interaction/browser';
import { ExplorerPlugin, type ExplorerHost, type ExplorerStore, type PlanItem, type Round } from '@interaction/explorer-plugin';
import { recordRouteRetry, routeRetryEligibility } from '../packages/explorer-plugin/src/obligation-lifecycle.js';

const url='https://review-arrival.fixture.invalid/';
function fixture() {
  const control={localId:'usd',instanceId:'node-usd',identityId:'identity-usd',identityScope:'semantic',stableKey:'id:usd',
    tag:'div',role:'generic',name:'USD',label:'USD',region:'document',form:'',selector:'#usd',visible:true,enabled:true,editable:false,
    readOnly:false,value:'',displayedText:'USD',checked:null,selected:[],expanded:null,actions:[],actionBasis:{},
    constraints:{type:'div',required:false,valid:true},rect:{x:0,y:0,width:40,height:30},
    actionable:{visible:true,enabled:true,hitTarget:true,unknown:[]},reviewBinding:{parentInstanceId:'parent',attributes:{id:'usd'}},
    reviewReuseBinding:{ancestors:[{tag:'main',attributes:{id:'calculator'},label:'Calculator'}]},
    classificationBinding:{truncated:false,text:'USD',nodes:[{instanceId:'node-usd',parentInstanceId:'parent',tag:'div',attributes:{id:'usd'}}],references:[]},
  } as unknown as Observation['controls'][number];
  const source={id:'source',sessionId:'session',instanceScope:'document',url,ruleVersion:'observable-v8',context:{},stable:true,gaps:[],
    controls:[control,{...structuredClone(control),localId:'mode',instanceId:'node-mode',stableKey:'id:mode',tag:'input',role:'checkbox',checked:false},
      {...structuredClone(control),localId:'missing-mode',instanceId:'node-missing',stableKey:'id:missing',tag:'input',role:'checkbox',checked:null}],regions:[{key:'document',label:'Document',role:'document'}],components:[],boundaries:[],overlays:[],canonical:'source',stateId:'source-state',
  } as unknown as Observation;
  let current={...structuredClone(source),id:'covered',canonical:'covered',stateId:'covered-state',boundaries:[{key:'modal',name:'Intro',region:'modal'}],
    overlays:[{key:'modal',name:'Intro',kind:'modal',controlIds:[],exitControlIds:[]}]} as unknown as Observation;
  const observations=new Map([[source.id,source],[current.id,current]]);
  const checkpoint={id:'checkpoint',sessionId:'session',observationId:source.id,stateId:source.stateId,context:{},path:[],predicates:[],acceptable:[]} as unknown as Checkpoint;
  const events:{type:string;data:any}[]=[];
  let unknown=false,wrongContract=false,tamper:string|undefined;
  const availability=()=>({sessionId:'session',observationId:current.id,revision:'fixture',actions:[]});
  const noEffect=()=>vi.fn(async()=>{throw Error('Unexpected browser operation');});
  const host={events:new EventEmitter(),session:()=>({id:'session',currentObservationId:current.id,actionCount:0,options:{executionPolicy:'interface-only'}}),
    observation:vi.fn((_sid:string,id?:string)=>{const o=observations.get(id||current.id);if(!o)throw Error('Missing observation');return o;}),
    actions:()=>[],list:(_sid:string,kind:string)=>kind==='checkpoint'?[checkpoint]:[],
    interactionTransition:()=>({retainedControls:[]}),actionAvailability:availability,boundaryState:()=>({verified:false}),
    recoveryAssessment:()=>({unknownAttempts:unknown?[{id:'unknown',sessionId:'session',status:'unknown'}]:[],blockingBoundaryExit:false}),
    explorationSnapshot:()=>({actions:[],operationCandidates:[],availability:availability()}),
    controlInterpretationSnapshot:()=>({actions:[],nonInteractive:[],retainedClassifications:[]}),
    controlClassificationMaterial:()=>({sessionId:'session',observationId:current.id,controls:[]}),
    controlReviewMaterial:()=>({sessionId:'session',observationId:current.id,controls:[]}),
    regionReviewMaterial:()=>({enabled:false}),explorationReviewMaterial:()=>({groups:[]}),
    reachControlReviewTarget:vi.fn(async(_sid:string,input:any)=>{
      expect(input).toMatchObject({checkpointId:checkpoint.id,observationId:source.id,localId:'usd',currentObservationId:current.id});
      current={...structuredClone(source),id:'exposed',canonical:'different-live-page',stateId:'new-state'};
      current.controls[1].checked=true;observations.set(current.id,current);
      const proof={targetMatched:true,reviewable:true,sourceEquivalent:'unknown',source:{sessionId:'session',observationId:source.id,localId:'usd'},
        target:{sessionId:'session',observationId:current.id,localId:'usd'},preflightRequired:true,identityAuthorized:false,replayAuthorized:false,
        currentExecution:false,executionAuthorized:false,coverageGranted:false,checkpointVerified:false,reason:'Recorded current facts',evidence:[]};
      return {id:'review-result',sessionId:'session',checkpointId:checkpoint.id,observationId:current.id,status:wrongContract?'REACHED_VERIFIED':'CURRENT_REVIEWABLE',
        reason:'Current material exposed; historical branch conditions unavailable',attemptIds:['close'],checks:[],remainingFrontier:0,
        targetObservationId:source.id,targetLocalId:tamper==='target'?'wrong-control':'usd',proof:tamper==='proof'?{...proof,target:{...proof.target,observationId:'stale'}}:proof,
        requireSourceEquivalent:false,matchedLocalId:'usd',sourceEquivalent:'unknown',checkpointVerified:false,coverageGranted:false,currentExecution:tamper==='currentExecution',executionAuthorized:false};
    }),
    reachCheckpoint:noEffect(),reachExplorationTarget:noEffect(),returnToObservedSource:noEffect(),execute:noEffect(),observe:noEffect(),createSession:noEffect(),
  } as unknown as ExplorerHost;
  const store={save:vi.fn(),close:()=>{},decisionCursor:()=>0,decisions:()=>[],event:(event:any)=>{events.push(event);return event;}} as unknown as ExplorerStore;
  const plugin=new ExplorerPlugin(host,store),task=plugin.create({url,coverageMode:'all'}),runtime=plugin as any;
  const authority={id:'authority',title:'Page',scope:{url},dispatchScope:true,required:true,status:'pending',reason:'accepted scope',prerequisites:[],completion:'Explore',evidence:[],attempts:[]} as PlanItem;
  const review={...structuredClone(authority),id:'review',scope:{url,label:'USD',role:'generic'},dispatchScope:false,reason:'classification_unresolved',status:'unresolved',
    evidence:[{sessionId:'session',observationId:source.id}]} as PlanItem;
  task.plan=[authority,review];task.status='running';
  const round={id:'round',sessionId:'session',number:1,status:'running',startedAt:new Date().toISOString(),actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0} as Round;
  task.rounds=[round];
  const reconcile=runtime.reconcileReviewLedger.bind(runtime),recordGap=runtime.gap.bind(runtime);
  // Exercise real selection, final revalidation, recovery dispatch, result and
  // retry accounting. Independent audit/model/coverage paths have no work here.
  runtime.retainHostLimitations=runtime.reconcileReviewLedger=runtime.applyReviewRecoveryChanges=async()=>{};
  runtime.auditRemainingScopes=runtime.updateObligations=()=>{};runtime.normalizeScheduling=()=>false;
  runtime.gap=()=>review;
  const select=()=>runtime.scheduledRecovery(task,round,current,[],availability(),runtime.routeConditionReader(current,[]));
  const step=()=>runtime.step(task,round,new AbortController().signal);
  return {plugin,host,task,round,review,source,events,select,step,reconcile,recordGap,
    setCurrent:(o:Observation)=>{current=o;observations.set(o.id,o);},current:()=>current,unknown:()=>{unknown=true;},wrong:()=>{wrongContract=true;},tamper:(kind:string)=>{tamper=kind;},
    duplicate:()=>source.controls.push({...structuredClone(control),localId:'other',instanceId:'node-other'})};
}

it('selects a review target without inventing an operation or requiring a strict checkpoint candidate',async()=>{
  const f=fixture();try{
    f.host.checkpointRecoveryCandidates=vi.fn(()=>{throw Error('Review arrival must not require strict checkpoint feasibility');});
    const selected=await f.select();
    expect(selected).toMatchObject({itemId:'review',reviewLocalId:'usd',targetActionIds:[],returnToSource:false});
    selected.revalidate();
    expect(f.host.checkpointRecoveryCandidates).not.toHaveBeenCalled();expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
    expect(f.task.scheduling!.routes[selected.routeKey].arrivalMode).toBe('control-review');
    expect(f.review.status).toBe('unresolved');
  }finally{await f.plugin.close();}
});

it('continues at exposed current material, retains historical debt and does not navigate again for the same material',async()=>{
  const f=fixture();try{
    const first=await f.select(),route=f.task.scheduling!.routes[first.routeKey];
    f.task.scheduling!.routes['old-strict']={...structuredClone(route),arrivalMode:undefined};
    f.task.routeRetries=recordRouteRetry(undefined,{routeKey:'old-strict',conditionVersion:'old-failed-condition',outcome:'unverified',reason:'old strict failure'});
    const old=structuredClone(f.task.routeRetries.routes['old-strict']),plan=structuredClone(f.task.plan);
    expect(await f.step()).toBe(true);
    expect(f.host.reachControlReviewTarget).toHaveBeenCalledOnce();expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
    expect(f.host.reachExplorationTarget).not.toHaveBeenCalled();expect(f.task.plan).toEqual(plan);
    expect(f.task.routeRetries!.routes['old-strict']).toEqual(old);
    const record=Object.values(f.task.routeRetries!.routes[first.routeKey].conditions)[0];
    expect(record).toMatchObject({outcome:'review_material_available',attempts:1,resultCondition:{basis:'review-material-observed'}});
    expect(f.task.routeRetries!.routes[first.routeKey].completedProgressKeys).toEqual([]);
    expect(f.task.routeRetries!.routes[first.routeKey].failedResultConditions).toBeUndefined();
    expect(f.round.entryPath).toEqual([]);expect(f.round.position?.observationId).toBe('exposed');
    expect(f.events.find(e=>e.type==='recovery.review_material_available')?.data).toMatchObject({sourceEquivalent:'unknown',coverageGranted:false,checkpointVerified:false});
    expect(await f.select()).toBeUndefined();expect(f.host.reachControlReviewTarget).toHaveBeenCalledOnce();
    expect(f.task.scheduling!.deferred?.review.reason).toBe('route_retry_review_material_available');
    // JSON roundtrip models persistence without starting another browser/store.
    const debt=JSON.parse(JSON.stringify(f.task.routeRetries));
    expect(routeRetryEligibility(debt,first.routeKey,record.resultCondition!.conditionVersion)).toMatchObject({allowed:false,reason:'review_material_available'});
    f.current().controls[1].checked=false;
    const changed=await f.select();expect(changed).toMatchObject({itemId:'review',reviewLocalId:'usd'});
    expect(changed.conditionVersion).not.toBe(record.resultCondition!.conditionVersion);
    expect(routeRetryEligibility(debt,first.routeKey,changed.conditionVersion).allowed).toBe(true);
  }finally{await f.plugin.close();}
});

it('keeps missing API compatibility strict and refuses ambiguous review targets with the new API',async()=>{
  const f=fixture();try{
    f.duplicate();expect(await f.select()).toBeUndefined();
    f.source.controls.pop();delete f.host.reachControlReviewTarget;
    const selected=await f.select();expect(selected.reviewLocalId).toBeUndefined();expect(selected.targetActionIds).toEqual([]);
  }finally{await f.plugin.close();}
});

it('rejects strict success returned through the review-only contract',async()=>{
  const f=fixture();try{
    f.wrong();expect(await f.step()).toBe(true);
    expect(f.events.find(e=>e.type==='recovery.contract_rejected')?.data).toMatchObject({hostResultStatus:'REACHED_VERIFIED'});
    expect(f.events.some(e=>e.type==='recovery.review_material_available')).toBe(false);
    expect(Object.values(f.task.routeRetries!.routes).flatMap(r=>Object.values(r.conditions)).every(r=>r.outcome==='unverified')).toBe(true);
    expect(f.review.status).toBe('unresolved');
  }finally{await f.plugin.close();}
});

it('does not use the new arrival contract to escape unknown source execution debt',async()=>{
  const f=fixture();try{
    const selected=await f.select();
    f.task.routeRetries=recordRouteRetry(undefined,{routeKey:'old-unknown',conditionVersion:'unknown-A',outcome:'unknown',reason:'process interrupted'});
    expect(await f.select()).toBeUndefined();expect(f.host.reachControlReviewTarget).not.toHaveBeenCalled();
    // Simulate an unknown result arriving after candidate validation but before
    // dispatch; the durable SDK outcome gate must still dominate this contract.
    (f.plugin as any).scheduledRecovery=async()=>({...selected,revalidate:()=>{}});
    f.unknown();await expect(f.step()).rejects.toMatchObject({code:'UNKNOWN_DISPATCH_REQUIRES_REVIEW'});
    expect(f.host.reachControlReviewTarget).not.toHaveBeenCalled();expect(selected.reviewLocalId).toBe('usd');
  }finally{await f.plugin.close();}
});

it.each(['currentExecution','target','proof'])('rejects a review arrival with mismatched %s facts',async kind=>{
  const f=fixture();try{f.tamper(kind);expect(await f.step()).toBe(true);
    expect(f.events.some(e=>e.type==='recovery.contract_rejected')).toBe(true);
    expect(f.events.some(e=>e.type==='recovery.review_material_available')).toBe(false);
    expect(f.review.status).toBe('unresolved');
  }finally{await f.plugin.close();}
});

function classificationFixture() {
  const f=fixture(),revoked=new Set<string>();
  f.host.discoveryScanMaterial=(()=>({sessionId:'session',observationId:f.current().id})) as unknown as ExplorerHost['discoveryScanMaterial'];
  const pinResult={trackedObservations:0,retainedObservations:0,logicalBytes:0,memoryBytes:0,maxMemoryBytes:0,statuses:{},protected:[],legacyEvidenceIncluded:false,workingRecordsIncluded:false};
  f.host.pinEvidence=vi.fn(async()=>pinResult);
  f.host.controlInterpretationSnapshot=((_sid:string,_id:string,input:any)=>({
    sessionId:'session',observationId:f.current().id,executionAuthorized:false,actions:[],
    nonInteractive:revoked.has(f.current().id)?[]:[{sessionId:'session',observationId:f.current().id,localId:'usd',classificationId:f.current().id,classification:'container'}],
    retainedClassifications:(input?.retainedClassifications||[]).map((source:any)=>({source,localId:'usd',retained:!revoked.has(source.classificationId),currentApplicability:false,executionAuthorized:false})),
  })) as unknown as ExplorerHost['controlInterpretationSnapshot'];
  f.host.controlReviewTargetCorrespondence=((sid:string,input:any)=>({
    targetMatched:true,reviewable:true,sourceEquivalent:f.host.observation(sid,input.observationId).controls[1].checked===f.host.observation(input.source.sessionId,input.source.observationId).controls[1].checked?'equivalent':'different',
    conditionKey:`review-condition:${f.host.observation(sid,input.observationId).controls[1].checked}`,
    source:input.source,target:{sessionId:sid,observationId:input.observationId,localId:input.localId},preflightRequired:true,
    identityAuthorized:false,replayAuthorized:false,executionAuthorized:false,currentExecution:false,coverageGranted:false,checkpointVerified:false,
  })) as ExplorerHost['controlReviewTargetCorrespondence'];
  return {...f,revoked,pinResult};
}

it('commits independent A/B review proofs, keeps them when a new gap arrives, and retracts only revoked sources',async()=>{
  const f=classificationFixture();try{
    const b={...structuredClone(f.source),id:'mode-b'};b.controls[1].checked=true;f.setCurrent(b);f.setCurrent(f.source);
    f.review.evidence.push({sessionId:'session',observationId:b.id});
    const signal=new AbortController().signal;
    await f.reconcile(f.task,f.current(),signal);
    expect(f.review.status).toBe('unresolved');expect(f.review.reviewSourceProofs?.bindings.map(x=>x.source.observationId)).toEqual(['source']);
    f.setCurrent(b);await f.reconcile(f.task,b,signal);
    expect(f.review.status).toBe('succeeded');expect(f.review.reviewSourceProofs?.bindings.map(x=>x.source.observationId)).toEqual(['source','mode-b']);
    const proofs=structuredClone(f.review.reviewSourceProofs);
    const c={...structuredClone(b),id:'new-source'};f.setCurrent(c);
    f.recordGap(f.task,f.review.reason,f.review.scope,true,[],false,c);
    expect(f.review.status).toBe('unresolved');expect(f.review.reviewResolvedBy).toBeUndefined();expect(f.review.reviewSourceProofs).toEqual(proofs);
    expect(f.review.evidence.map(x=>x.observationId)).toEqual(['source','mode-b','new-source']);
    f.revoked.add('source');(f.plugin as any).retractReviewLedger(f.task,c);
    expect(f.review.reviewSourceProofs?.bindings.map(x=>x.source.observationId)).toEqual(['mode-b']);expect(f.review.status).toBe('unresolved');
    expect(f.host.execute).not.toHaveBeenCalled();expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
  }finally{await f.plugin.close();}
});

it('refuses a review proof revoked while pinning instead of committing a stale success',async()=>{
  const f=classificationFixture();try{
    f.setCurrent(f.source);f.host.pinEvidence=vi.fn(async()=>{f.revoked.add('source');return f.pinResult;});
    await expect(f.reconcile(f.task,f.source,new AbortController().signal)).rejects.toMatchObject({code:'STALE_DECISION'});
    expect(f.review.status).toBe('unresolved');expect(f.review.reviewSourceProofs).toBeUndefined();expect(f.review.reviewResolvedBy).toBeUndefined();
    expect(f.events.some(e=>e.type==='review.resolved')).toBe(false);
  }finally{await f.plugin.close();}
});

function retainBranchCheckpoint(f:ReturnType<typeof classificationFixture>,branch:Observation) {
  const checkpoints=f.host.list<Checkpoint>('session','checkpoint');
  f.host.list=((_sid:string,kind:string)=>kind==='checkpoint'?[...checkpoints,{...checkpoints[0],id:`checkpoint-${branch.id}`,observationId:branch.id,stateId:branch.stateId}]:[]) as ExplorerHost['list'];
}
function sourceArrival(f:ReturnType<typeof classificationFixture>) {
  const reach=vi.fn(async(sid:string,input:Parameters<NonNullable<ExplorerHost['reachControlReviewTarget']>>[1])=>{
    expect(input.requireSourceEquivalent).toBe(true);
    const source=f.host.observation(sid,input.observationId),arrived={...structuredClone(source),id:`arrived-${source.id}`};
    f.setCurrent(arrived);
    const proof=f.host.controlReviewTargetCorrespondence!(sid,{observationId:arrived.id,localId:input.localId,source:{sessionId:sid,observationId:source.id,localId:input.localId}});
    return {id:'source-arrival',sessionId:sid,checkpointId:input.checkpointId,observationId:arrived.id,status:'CURRENT_REVIEWABLE' as const,
      requireSourceEquivalent:true,targetObservationId:source.id,targetLocalId:input.localId,matchedLocalId:input.localId,sourceEquivalent:proof.sourceEquivalent,proof,
      reason:'Source conditions reached',attemptIds:['restore-mode'],checks:[],remainingFrontier:0,
      checkpointVerified:false as const,coverageGranted:false as const,currentExecution:false as const,executionAuthorized:false as const};
  });
  f.host.reachControlReviewTarget=reach;return reach;
}

it('pursues unreviewed A after classifying B without spending B new-material wait again',async()=>{
  const f=classificationFixture();try{
    f.revoked.add(f.current().id); // Initial material has no negative classification.
    const fresh=await f.select();expect(fresh.requireSourceEquivalent).toBe(false);
    expect(await f.step()).toBe(true);
    const oldRoute=structuredClone(f.task.routeRetries!.routes[fresh.routeKey]),b=f.current();
    f.review.evidence.push({sessionId:'session',observationId:b.id});retainBranchCheckpoint(f,b);
    await f.reconcile(f.task,b,new AbortController().signal);
    expect(f.review.reviewSourceProofs?.bindings.map(binding=>binding.source.observationId)).toEqual([b.id]);
    const selected=await f.select();
    expect(selected).toMatchObject({source:{id:f.source.id},reviewLocalId:'usd',requireSourceEquivalent:true});
    expect(selected.routeKey).not.toBe(fresh.routeKey);
    expect(f.task.scheduling!.routes[selected.routeKey]).toMatchObject({requireSourceEquivalent:true,sourceCondition:'review-condition:false'});
    const reach=sourceArrival(f);expect(await f.step()).toBe(true);
    expect(reach).toHaveBeenCalledOnce();expect(reach.mock.calls[0][1]).toMatchObject({observationId:f.source.id,requireSourceEquivalent:true});
    expect(f.current().controls[1].checked).toBe(false);expect(f.task.routeRetries!.routes[fresh.routeKey]).toEqual(oldRoute);
    expect(f.events.some(event=>event.type==='recovery.contract_rejected')).toBe(false);
    expect(f.review.status).toBe('unresolved');expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
  }finally{await f.plugin.close();}
});

it('keeps A and B source arrival budgets separate while unknown debt crosses both review contracts',async()=>{
  const f=classificationFixture();try{
    const b={...structuredClone(f.source),id:'source-b',canonical:'source-b',stateId:'source-b'};b.controls[1].checked=true;f.setCurrent(b);retainBranchCheckpoint(f,b);
    f.setCurrent({...structuredClone(f.source),id:'live-a',canonical:'live-a',stateId:'live-a'});
    f.review.evidence=[{sessionId:'session',observationId:b.id}];
    const bRoute=await f.select();expect(bRoute.requireSourceEquivalent).toBe(true);
    f.task.routeRetries=recordRouteRetry(undefined,{routeKey:bRoute.routeKey,conditionVersion:bRoute.conditionVersion,outcome:'unverified',reason:'B path failed'});
    const oldDebt=structuredClone(f.task.routeRetries.routes[bRoute.routeKey]);
    f.review.evidence.unshift({sessionId:'session',observationId:f.source.id});
    f.setCurrent(b);
    await f.reconcile(f.task,b,new AbortController().signal);
    const aRoute=await f.select();
    expect(aRoute).toMatchObject({source:{id:f.source.id},requireSourceEquivalent:true});expect(aRoute.routeKey).not.toBe(bRoute.routeKey);
    expect(f.task.scheduling!.routes[aRoute.routeKey].sourceCondition).toBe('review-condition:false');
    expect(f.task.scheduling!.routes[bRoute.routeKey].sourceCondition).toBe('review-condition:true');
    expect(f.task.routeRetries!.routes[bRoute.routeKey]).toEqual(oldDebt);
    f.task.routeRetries=recordRouteRetry(f.task.routeRetries,{routeKey:'unknown-new-material',conditionVersion:'unknown',outcome:'unknown',reason:'interrupted arrival'});
    expect(await f.select()).toBeUndefined();expect(f.task.scheduling!.deferred?.review.reason).toBe('source_return_unknown_route_debt');
    expect(f.host.reachControlReviewTarget).not.toHaveBeenCalled();
  }finally{await f.plugin.close();}
});

function unavailableReviewSource(f:ReturnType<typeof classificationFixture>) {
  const read=f.host.controlReviewTargetCorrespondence!;
  const unavailable=new Set([f.source.id]);
  const correspondence=vi.fn((sid:string,input:Parameters<typeof read>[1])=>{
    const proof=read(sid,input);
    return unavailable.has(input.source.observationId)?{...proof,conditionKey:undefined,
      sourceConditionAssessment:{status:'unavailable' as const,reason:'selector_identity_unresolved',localId:'missing-mode'}}:proof;
  });
  f.host.controlReviewTargetCorrespondence=correspondence;
  return {unavailable,correspondence};
}

it('retains explicitly incomplete review sources and selects a different source without spending a recovery',async()=>{
  const f=classificationFixture();try{
    const b={...structuredClone(f.source),id:'source-b',canonical:'source-b',stateId:'source-b'};b.controls[1].checked=true;
    f.setCurrent(b);retainBranchCheckpoint(f,b);
    f.setCurrent({...structuredClone(f.source),id:'live',canonical:'live',stateId:'live'});
    f.review.evidence=[{sessionId:'session',observationId:b.id},{sessionId:'session',observationId:f.source.id}];
    const plan=structuredClone(f.task.plan),audit=unavailableReviewSource(f);
    const selected=await f.select();
    expect(selected).toMatchObject({itemId:'review',source:{id:b.id},requireSourceEquivalent:true});
    expect(audit.correspondence).toHaveBeenCalledTimes(2); // one existing self-query per source
    expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toBeUndefined();
    expect(f.host.reachControlReviewTarget).not.toHaveBeenCalled();expect(f.host.reachCheckpoint).not.toHaveBeenCalled();
  }finally{await f.plugin.close();}
});

it('defers an incomplete review item and advances to another item while retaining both obligations',async()=>{
  const f=classificationFixture();try{
    const b={...structuredClone(f.source),id:'other-source',canonical:'other-source',stateId:'other-source'};b.controls[1].checked=true;
    f.setCurrent(b);retainBranchCheckpoint(f,b);
    f.setCurrent({...structuredClone(f.source),id:'live',canonical:'live',stateId:'live'});
    f.task.plan.push({...structuredClone(f.review),id:'other-review',evidence:[{sessionId:'session',observationId:b.id}]});
    const plan=structuredClone(f.task.plan);unavailableReviewSource(f);
    expect(await f.select()).toMatchObject({itemId:'other-review',source:{id:b.id},requireSourceEquivalent:true});
    expect(f.task.scheduling!.deferred?.review.reason).toBe('review_source_conditions_unavailable:selector_identity_unresolved');
    expect(f.task.plan).toEqual(plan);expect(f.task.routeRetries).toBeUndefined();
  }finally{await f.plugin.close();}
});

it('reconsiders a source when its explicit assessment changes and rejects a newly unavailable final selection',async()=>{
  const f=classificationFixture();try{
    const audit=unavailableReviewSource(f);
    expect(await f.select()).toBeUndefined();expect(await f.select()).toBeUndefined();
    expect(f.events.filter(e=>e.type==='obligation.route_unavailable')).toHaveLength(1);
    expect(f.review.status).toBe('unresolved');expect(f.task.routeRetries).toBeUndefined();
    audit.unavailable.clear();const selected=await f.select();expect(selected.source.id).toBe(f.source.id);
    audit.unavailable.add(f.source.id);
    expect(()=>selected.revalidate()).toThrowError(expect.objectContaining({code:'STALE_DECISION'}));
    expect(f.host.reachControlReviewTarget).not.toHaveBeenCalled();
  }finally{await f.plugin.close();}
});

it('still obtains new review material with incomplete history and preserves unknown debt after restart',async()=>{
  const f=classificationFixture();try{
    unavailableReviewSource(f);f.revoked.add(f.current().id);
    expect(await f.select()).toMatchObject({requireSourceEquivalent:false,source:{id:f.source.id}});
    f.task.routeRetries=JSON.parse(JSON.stringify(recordRouteRetry(undefined,{routeKey:'old-unknown',conditionVersion:'old',outcome:'unknown',reason:'interrupted execution'})));
    expect(await f.select()).toBeUndefined();expect(f.task.scheduling!.deferred?.review.reason).toBe('source_return_unknown_route_debt');
    expect(f.host.reachControlReviewTarget).not.toHaveBeenCalled();expect(f.review.status).toBe('unresolved');
  }finally{await f.plugin.close();}
});

it.each(['legacy-no-assessment','mismatched-reference','contradictory-key'])('does not exclude a source on %s diagnostic hints',async kind=>{
  const f=classificationFixture();try{
    const read=f.host.controlReviewTargetCorrespondence!;
    f.host.controlReviewTargetCorrespondence=(sid,input)=>{
      const proof=read(sid,input);
      return {...proof,conditionKey:kind==='contradictory-key'?proof.conditionKey:undefined,
        source:kind==='mismatched-reference'?{...proof.source,observationId:'other'}:proof.source,
        ...kind==='legacy-no-assessment'?{}:{sourceConditionAssessment:{status:'unavailable',reason:'selector_identity_unresolved'}}};
    };
    expect(await f.select()).toMatchObject({source:{id:f.source.id},requireSourceEquivalent:true});
    expect(f.task.scheduling!.deferred?.review).toBeUndefined();
  }finally{await f.plugin.close();}
});

function sourceProofRefusal(f:ReturnType<typeof classificationFixture>,attemptIds:string[]=[],unknown=false) {
  // The target is already exposed, as in the retained OKX failure. The base
  // fixture's unrelated modal would legitimately add a missing-exit gap.
  f.setCurrent({...structuredClone(f.source),id:'review-current',canonical:'review-current',stateId:'review-current'});
  f.host.reachControlReviewTarget=vi.fn(async(sid:string,input:Parameters<NonNullable<ExplorerHost['reachControlReviewTarget']>>[1]):ReturnType<NonNullable<ExplorerHost['reachControlReviewTarget']>>=>{
    const proof=f.host.controlReviewTargetCorrespondence!(sid,{observationId:f.current().id,localId:input.localId,
      source:{sessionId:sid,observationId:input.observationId,localId:input.localId}});
    if(unknown)f.unknown();
    return {id:'source-refusal',sessionId:sid,checkpointId:input.checkpointId,observationId:f.current().id,status:'UNVERIFIED',
      reason:'Target arrival verification: UNVERIFIED',attemptIds,checks:[{name:'historical-review-source-conditions',result:'unknown'}],remainingFrontier:0,
      requireSourceEquivalent:true,targetObservationId:input.observationId,targetLocalId:input.localId,sourceEquivalent:'unknown',
      proof:{...proof,sourceEquivalent:'unknown',currentConditionAssessment:{status:'unavailable',reason:'selector_state_missing',localId:'missing-mode'}},
      checkpointVerified:false,coverageGranted:false,currentExecution:false,executionAuthorized:false};
  });
  const gaps=vi.fn(f.recordGap);(f.plugin as any).gap=gaps;return gaps;
}

it('records a zero-action historical review refusal without inventing checkpoint failure evidence',async()=>{
  const f=classificationFixture();try{
    const gaps=sourceProofRefusal(f),plan=structuredClone(f.task.plan);
    expect(await f.step()).toBe(true);expect(gaps).not.toHaveBeenCalled();expect(f.task.plan).toEqual(plan);
    const record=Object.values(f.task.routeRetries!.routes).flatMap(route=>Object.values(route.conditions))[0];
    expect(record).toMatchObject({outcome:'unverified',reason:'review_source_conditions_unavailable',attempts:1});
    expect(f.events.find(e=>e.type==='recovery.review_source_unverified')?.data).toMatchObject({itemId:'review',sourceObservationId:'source',
      reason:'review_source_conditions_unavailable',checkpointVerified:false,coverageGranted:false,currentExecution:false});
    expect(f.events.find(e=>e.type==='recovery.result')?.data.reason).toBe('Target arrival verification: UNVERIFIED');
    expect(await f.select()).toBeUndefined();expect(f.host.reachControlReviewTarget).toHaveBeenCalledOnce();
  }finally{await f.plugin.close();}
});

it('keeps checkpoint failure evidence when a historical review refusal follows an actual recovery attempt',async()=>{
  const f=classificationFixture();try{
    const gaps=sourceProofRefusal(f,['boundary-exit']);
    expect(await f.step()).toBe(true);
    expect(gaps).toHaveBeenCalledWith(f.task,'checkpoint_unverified',{url});
    expect(f.events.some(e=>e.type==='recovery.review_source_unverified')).toBe(false);
    expect(f.review.status).toBe('unresolved');
  }finally{await f.plugin.close();}
});

it('blocks unknown execution discovered after historical review refusal instead of treating it as source-only debt',async()=>{
  const f=classificationFixture();try{
    sourceProofRefusal(f,[],true);
    await expect(f.step()).rejects.toMatchObject({code:'UNKNOWN_DISPATCH_REQUIRES_REVIEW'});
    expect(f.events.some(e=>e.type==='recovery.review_source_unverified')).toBe(false);
    expect(Object.values(f.task.routeRetries!.routes).flatMap(route=>Object.values(route.conditions)).some(row=>row.outcome==='unknown')).toBe(true);
    expect(f.review.status).toBe('unresolved');
  }finally{await f.plugin.close();}
});

it.each(['rejected-success','proof-authority','missing-target','ambiguous-target'])('does not normalize historical review refusal with %s facts',async kind=>{
  const f=classificationFixture();try{
    const gaps=sourceProofRefusal(f),reach=f.host.reachControlReviewTarget!;
    f.host.reachControlReviewTarget=vi.fn(async(sid,input)=>{
      const result=await reach(sid,input);
      if(kind==='rejected-success')return {...result,status:'CURRENT_REVIEWABLE' as const,matchedLocalId:'usd'};
      // Deliberately malformed host facts must retain the ordinary failure path.
      if(kind==='proof-authority')return {...result,proof:{...result.proof!,executionAuthorized:true as unknown as false}};
      if(kind==='missing-target')return {...result,proof:{...result.proof!,target:{...result.proof!.target,localId:'absent'}}};
      f.current().controls.push(structuredClone(f.current().controls[0]));return result;
    });
    expect(await f.step()).toBe(true);
    expect(gaps).toHaveBeenCalledWith(f.task,'checkpoint_unverified',{url});
    expect(f.events.some(e=>e.type==='recovery.review_source_unverified')).toBe(false);
    expect(f.review.status).toBe('unresolved');
    if(kind==='rejected-success'){
      expect(f.events.find(e=>e.type==='recovery.contract_rejected')?.data.hostResultStatus).toBe('CURRENT_REVIEWABLE');
      expect(Object.values(f.task.routeRetries!.routes).flatMap(route=>Object.values(route.conditions))).toEqual([
        expect.objectContaining({outcome:'unverified',reason:'host_recovery_contract_mismatch'})]);
    }
  }finally{await f.plugin.close();}
});
