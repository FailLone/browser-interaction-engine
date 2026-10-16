import {expect,it,vi} from 'vitest';
import {InteractionEngine} from '@interaction/core';
import {PlaywrightAdapter} from '@interaction/adapter-playwright';
import {MemoryStore} from '@interaction/storage-memory';
import type {ActionCandidate,Observation} from '@interaction/browser';
import type {PlanItem} from '@interaction/explorer-plugin';
import {keyFor,scopeFor} from '../packages/explorer-plugin/src/policy.js';
import {projectObligations,recoveryConditionVersion,recoveryRouteConditionVersion,recoveryRouteKey,recordRouteRetry,routeRetryEligibility,releaseRouteRetryForProgress,releaseRouteRetriesForVerifiedRecovery,type RouteRetryLedger} from '../packages/explorer-plugin/src/obligation-lifecycle.js';

/** Exercises the real SDK target correspondence; no browser, service or database. */
function fixture(){
  const store=new MemoryStore(),host=new InteractionEngine<any,any>({adapter:new PlaywrightAdapter(),persistence:store});
  const observation=(id:string,name:string,tenant='one')=>{
    const c={localId:id,instanceId:`instance-${id}`,identityId:`identity-${id}`,tag:'a',role:'link',name,label:'',region:'records',form:'',visible:true,enabled:true,editable:false,
      constraints:{type:'a',required:false,valid:true},options:[],actions:['click'],selected:[],
      structuralItem:{ownerInstanceId:`owner-${id}`,rowInstanceId:id,template:'["A",["SPAN","SPAN"]]',slot:'',recordKey:'["href","/records/one"]'},
      identityContext:{scope:'["ancestor-id","records"]',binding:'[["link-destination","https://example.test/records/one",""]]',evidence:['semantic-ancestor-scope/v1','link-destination/v1']},
      reviewBinding:{attributes:{href:'/records/one'}},actionBasis:{click:{status:'supported',evidence:[{source:'html',rule:'hyperlink/v1',facts:{tag:'a',href:'/records/one'}}]}}};
    const o={id,sessionId:`session-${id}`,instanceScope:`document-${id}`,url:'https://example.test/',context:{tenant:{status:'known',value:tenant,source:'fixture'}},gaps:[],stable:true,ruleVersion:'fixture-v1',boundaries:[],regions:[{key:'records',label:'Records',role:'region'}],controls:[c]} as unknown as Observation;
    const action={id:`action-${id}`,sessionId:o.sessionId,observationId:o.id,stateId:`state-${id}`,controlId:c.identityId,localId:c.localId,kind:'click',label:name,risk:'interface',basis:c.actionBasis.click,replayable:true,source:'fixture',excluded:false,sampleValidity:'known',preconditions:{visible:true,enabled:true,identityResolved:true,context:structuredClone(o.context)}} as ActionCandidate;
    store.put('session',{id:o.sessionId,currentObservationId:o.id,options:{exploration:'controls'},actionCount:0});store.put('observation',o);store.put('action',action);return {o,action};
  };
  const item=(source:ReturnType<typeof observation>,id=source.o.id):PlanItem=>({id,title:source.action.label,scope:scopeFor(source.action,source.o),prerequisites:[],completion:'Observed operation',status:'unresolved',required:true,dispatchScope:false,reason:'operation_not_executed',evidence:[{sessionId:source.o.sessionId,observationId:source.o.id}],attempts:[]});
  const publish=(source:ReturnType<typeof observation>,suffix:string)=>{
    source.o.id+=suffix;source.action.id+=suffix;source.action.observationId=source.o.id;
    store.put('observation',source.o);store.put('action',source.action);
    store.put('session',{id:source.o.sessionId,currentObservationId:source.o.id,options:{exploration:'controls'},actionCount:0});
  };
  return {store,host,observation,item,publish};
}

it('converges changing unexecuted native-link labels only through SDK proof, without changing original history',()=>{
  const f=fixture(),sources=Array.from({length:25},(_,i)=>f.observation(`price-${i}`,`Asset $${100+i}`)),current=f.observation('current','Asset $999');
  const task={plan:[...sources,current].map(s=>f.item(s))},saved=JSON.stringify(task),writes=vi.spyOn(f.store,'put');
  const query=vi.spyOn(f.host,'explorationTargetCorrespondences');
  const result=projectObligations(f.host,task,current.o,[current.action]);
  expect(result.projection.counts).toMatchObject({rows:26,active:1,aliases:25,unresolved:26,unresolvedGroups:1});
  expect(result.projection.entries.every(e=>e.correspondence?.evidence.includes('display-name-not-operation-identity'))).toBe(true);
  expect(JSON.stringify(task)).toBe(saved);expect(writes).not.toHaveBeenCalled();expect(f.host.list(current.o.sessionId,'attempt')).toEqual([]);
  expect(result.events.every(e=>!e.currentExecution&&!e.coverageGranted)).toBe(true);
  expect(query.mock.calls.length).toBe(2);expect(query.mock.calls.every(([,input])=>input.requests.length<=16)).toBe(true);
  const restarted=JSON.parse(JSON.stringify(result.projection));
  expect(projectObligations(f.host,task,current.o,[current.action],restarted).events).toEqual([]);
  f.store.close();
});

it('keeps the same control in a changed UI mode as a separate unresolved condition',()=>{
  const f=fixture(),old=f.observation('old','Run'),current=f.observation('current','Run');
  for(const [source,selected] of [[old,['selected']],[current,[]]] as const){
    source.o.controls.push({...structuredClone(source.o.controls[0]),localId:`mode-${source.o.id}`,instanceId:`mode-${source.o.id}`,identityId:`mode-${source.o.id}`,tag:'button',role:'tab',name:'Mode',label:'Mode',stableKey:'id:mode',structuralItem:undefined,identityContext:undefined,selected:[...selected]});
    f.publish(source,'-mode');
  }
  const item={...f.item(old),operationConditionKey:keyFor(old.action,old.o)},task={plan:[item]};
  expect(keyFor(current.action,current.o)).not.toBe(item.operationConditionKey);
  const result=projectObligations(f.host,task,current.o,[current.action]);
  expect(result.projection.entries[0]).toMatchObject({state:'waiting',reason:'operation_conditions_changed'});
  expect(result.projection.counts).toMatchObject({unresolved:1,aliases:0});
  const invalidSource={...item,operationConditionKey:keyFor(current.action,current.o)};
  // A current key is not proof that the old source was created under that mode.
  expect(projectObligations(f.host,{plan:[invalidSource]},current.o,[current.action]).projection.entries[0]).toMatchObject({state:'waiting',reason:'source_condition_unverified'});
  // A user may explicitly supplement this literal target under the current
  // conditions. Its old discovery key remains history, not a hidden constraint.
  expect(projectObligations(f.host,{plan:[{...item,dispatchScope:true}]},current.o,[current.action]).projection.entries[0]).toMatchObject({state:'active',reason:'current_target_observed'});
  f.store.close();
});

it('changes route retry conditions for related blockers and modes, not passive text or unrelated controls',()=>{
  const f=fixture(),source=f.observation('source','Open'),scopes=[scopeFor(source.action,source.o)],initial=recoveryRouteConditionVersion(source.o,[source.action],scopes);
  const changed=structuredClone(source.o);changed.controls[0].displayedText='$100000';changed.id='new-observation';changed.instanceScope='rebuilt-document';
  const action={...source.action,observationId:changed.id};
  changed.controls.push({...structuredClone(changed.controls[0]),localId:'other',instanceId:'other',role:'button',name:'Unrelated',label:'Unrelated',stableKey:'id:other',structuralItem:undefined,identityContext:undefined});
  expect(recoveryRouteConditionVersion(changed,[action],scopes)).toBe(initial);
  const blocked={...action,preconditions:{...action.preconditions,blockers:[{code:'OVERLAY_BLOCKED',evidence:['observed'],unblock:'exit'}]}};
  expect(recoveryRouteConditionVersion(changed,[blocked],scopes)).not.toBe(initial);
  changed.controls.push({...structuredClone(changed.controls[1]),localId:'mode',instanceId:'mode',role:'tab',name:'Mode',label:'Mode',stableKey:'id:mode',selected:['selected']});
  expect(recoveryRouteConditionVersion(changed,[action],scopes)).not.toBe(initial);f.store.close();
});

it('keeps route retry debt across new checkpoints, documents and native-link quote labels',()=>{
  const f=fixture(),old=f.observation('old','Asset $100'),fresh=f.observation('fresh','Asset $999');
  const key=recoveryRouteKey(old.o,[old.action],[scopeFor(old.action,old.o)]);
  expect(recoveryRouteKey(fresh.o,[fresh.action],[scopeFor(fresh.action,fresh.o)])).toBe(key);
  const ledger=recordRouteRetry(undefined,{routeKey:key,conditionVersion:recoveryConditionVersion(old.o),outcome:'unreachable',reason:'route_failed'});
  const freshKey=recoveryRouteKey(fresh.o,[fresh.action],[scopeFor(fresh.action,fresh.o)]);
  expect(routeRetryEligibility(JSON.parse(JSON.stringify(ledger)),freshKey,recoveryConditionVersion(fresh.o)).allowed).toBe(false);
  fresh.o.controls.push({...structuredClone(fresh.o.controls[0]),localId:'mode',instanceId:'mode',role:'tab',name:'Mode',label:'Mode',stableKey:'id:mode',structuralItem:undefined,identityContext:undefined,selected:['selected']});
  expect(recoveryRouteKey(fresh.o,[fresh.action],[scopeFor(fresh.action,fresh.o)])).toBe(key);
  expect(recoveryRouteConditionVersion(fresh.o,[fresh.action],[scopeFor(fresh.action,fresh.o)])).not.toBe(recoveryRouteConditionVersion(old.o,[old.action],[scopeFor(old.action,old.o)]));
  fresh.o.controls[0].identityContext!.scope='other-owner';
  expect(recoveryRouteKey(fresh.o,[fresh.action],[scopeFor(fresh.action,fresh.o)])).not.toBe(key);f.store.close();
});

it('deduplicates target sets but preserves distinct routes and conservatively retains unmatched scope meaning',()=>{
  const f=fixture(),source=f.observation('source','Run'),target=scopeFor(source.action,source.o),review={url:source.o.url,label:'Unclassified',role:'button'},page={url:source.o.url};
  const key=recoveryRouteKey(source.o,[source.action],[target,review,page]);
  expect(recoveryRouteKey(source.o,[source.action],[page,review,target,target])).toBe(key);
  expect(recoveryRouteKey(source.o,[source.action],[target,review])).not.toBe(key);
  expect(recoveryRouteKey(source.o,[source.action],[target],[review,page])).not.toBe(recoveryRouteKey(source.o,[source.action],[target],[page,review]));
  expect(recoveryRouteKey(source.o,[source.action],[{...review,label:'Other'}])).not.toBe(recoveryRouteKey(source.o,[source.action],[review]));f.store.close();
});

it('expires aliases after context, evidence or target ambiguity changes, including after serialization',()=>{
  const f=fixture(),old=f.observation('old','Asset $100'),current=f.observation('current','Asset $200'),task={plan:[f.item(old),f.item(current)]};
  const projection=projectObligations(f.host,task,current.o,[current.action]).projection;
  expect(projection.counts.aliases).toBe(1);
  const other=f.observation('other','Asset $300','other');
  const changed=projectObligations(f.host,task,other.o,[other.action],JSON.parse(JSON.stringify(projection)));
  expect(changed.projection.counts).toMatchObject({aliases:0,waiting:2,unresolvedGroups:2});
  expect(changed.projection.entries.every(e=>e.reason==='source_context_changed')).toBe(true);
  current.o.controls.push({...structuredClone(current.o.controls[0]),localId:'duplicate',instanceId:'duplicate'});f.publish(current,'-ambiguous');
  expect(projectObligations(f.host,task,current.o,[current.action],projection).projection.counts.aliases).toBe(0);
  current.o.controls.pop();f.publish(current,'-restored');
  const query=vi.spyOn(f.host,'explorationTargetCorrespondences').mockImplementation((_sid,input)=>({sessionId:current.o.sessionId,observationId:'stale',results:input.requests.map(request=>({equivalent:true,reason:'fake',source:request.source,target:{sessionId:current.o.sessionId,observationId:current.o.id,actionId:request.actionId},evidence:[],invalidatedBy:[],identityAuthorized:false,replayAuthorized:false,currentExecution:false}))}));
  expect(projectObligations(f.host,task,current.o,[current.action],projection).projection.counts.aliases).toBe(0);query.mockRestore();f.store.close();
});

it('retains hidden, absent and unreachable work without pretending it was removed or covered',()=>{
  const f=fixture(),source=f.observation('source','Asset $100'),task={plan:[f.item(source)]};
  const hidden={...structuredClone(source.o),id:'hidden'};hidden.controls[0].visible=false;
  const hiddenAction={...source.action,id:'hidden-action',observationId:hidden.id,preconditions:{...source.action.preconditions,visible:false}};
  f.store.put('observation',hidden);f.store.put('action',hiddenAction);f.store.put('session',{id:hidden.sessionId,currentObservationId:hidden.id,options:{exploration:'controls'},actionCount:0});
  const hiddenResult=projectObligations(f.host,task,hidden,[hiddenAction]);
  expect(hiddenResult.projection.entries[0]).toMatchObject({state:'waiting',reason:'target_hidden'});
  const absent={...hidden,id:'absent',controls:[]};f.store.put('observation',absent);f.store.put('session',{id:absent.sessionId,currentObservationId:absent.id,options:{exploration:'controls'},actionCount:0});
  const absentResult=projectObligations(f.host,task,absent,[],hiddenResult.projection);
  expect(absentResult.projection.entries[0]).toMatchObject({state:'waiting',reason:'target_not_observed'});
  const failure={itemId:task.plan[0].id,conditionVersion:recoveryConditionVersion(absent),status:'unreachable' as const,reason:'history_entry_missing'};
  expect(projectObligations(f.host,task,absent,[],absentResult.projection,[failure]).projection.entries[0]).toMatchObject({state:'unreachable',reason:'history_entry_missing'});
  const changed={...absent,context:{tenant:{status:'known' as const,value:'other',source:'fixture'}}};
  expect(projectObligations(f.host,task,changed,[],undefined,[failure]).projection.entries[0].state).toBe('waiting');
  expect(task.plan[0]).toMatchObject({status:'unresolved',attempts:[]});expect(task.plan[0].resolvedBy).toBeUndefined();f.store.close();
});

it('never aliases unknown executions, recovery gaps, capabilities or accepted literal task scopes',()=>{
  const f=fixture(),old=f.observation('old','Asset $100'),current=f.observation('current','Asset $200');
  const unknown={...f.item(old,'unknown'),attempts:[{roundId:'round',outcome:'unknown',evidence:{sessionId:old.o.sessionId,observationId:old.o.id,attemptId:'unknown-attempt'}}]};
  const recovery={...f.item(old,'recovery'),reason:'checkpoint_unverified'};
  const capability={...f.item(old,'capability'),required:false,status:'untested' as const,reason:'missing_capability:canvas'};
  const accepted={...f.item(old,'accepted'),dispatchScope:true};
  const task={plan:[unknown,recovery,capability,accepted,f.item(current)]},saved=JSON.stringify(task);
  const result=projectObligations(f.host,task,current.o,[current.action]);
  expect(result.projection.counts.aliases).toBe(0);
  expect(result.projection.entries.find(e=>e.itemId==='unknown')).toMatchObject({state:'active',reason:'execution_result_unresolved'});
  expect(result.projection.entries.find(e=>e.itemId==='capability')).toMatchObject({state:'active',reason:'capability_obligation_preserved'});
  expect(result.projection.counts.unresolved).toBe(5);expect(JSON.stringify(task)).toBe(saved);f.store.close();
});

it('does not collapse same-name distinct operations when the SDK rejects target identity',()=>{
  const f=fixture(),first=f.observation('first','Run'),second=f.observation('second','Run');
  second.o.controls[0].reviewBinding!.attributes.href='/records/two';
  second.o.controls[0].structuralItem!.recordKey='["href","/records/two"]';
  second.o.controls[0].identityContext!.binding='other-destination';f.publish(second,'-different-target');
  const task={plan:[f.item(first),f.item(second)]};
  expect(projectObligations(f.host,task,second.o,[second.action]).projection.counts.aliases).toBe(0);f.store.close();
});

it('uses stable retry conditions, retains A-B-A failures across restart and counts one reservation once',()=>{
  const f=fixture(),a=f.observation('a','Asset $100'),b=f.observation('b','Asset $999');
  const conditionA=recoveryConditionVersion(a.o),conditionB=recoveryConditionVersion({...a.o,context:{tenant:{status:'known',value:'other',source:'fixture'}}});
  expect(recoveryConditionVersion(b.o)).toBe(conditionA);
  expect(recoveryConditionVersion(b.o,['dependency-mode-a'])).not.toBe(recoveryConditionVersion(b.o,['dependency-mode-b']));
  let ledger=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:conditionA,outcome:'no_progress',reason:'reserved',attemptKey:'request'});
  ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:conditionA,outcome:'unverified',reason:'partially_changed_page',attemptKey:'request'});
  expect(ledger.routes.route.conditions[conditionA].attempts).toBe(1);
  expect(routeRetryEligibility(ledger,'route',conditionB).allowed).toBe(true);
  ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:conditionB,outcome:'unreachable',reason:'history_missing'});
  expect(routeRetryEligibility(JSON.parse(JSON.stringify(ledger)),'route',conditionA)).toMatchObject({allowed:false,reason:'condition_attempted'});
  const progress=releaseRouteRetryForProgress(ledger,'route','new-child-covered');
  expect(routeRetryEligibility(progress,'route',conditionA).allowed).toBe(true);
  const used=recordRouteRetry(progress,{routeKey:'route',conditionVersion:conditionA,outcome:'no_progress',reason:'no_new_child'});
  expect(routeRetryEligibility(releaseRouteRetryForProgress(used,'route','new-child-covered'),'route',conditionA).allowed).toBe(false);
  f.store.close();
});

it('saturates condition churn without evicting old debt and never renews unknown results',()=>{
  let ledger:RouteRetryLedger|undefined;
  for(let i=0;i<20;i++)ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:`condition-${i}`,outcome:'unreachable',reason:'new_context'});
  expect(Object.keys(ledger!.routes.route.conditions)).toHaveLength(16);
  expect(routeRetryEligibility(ledger,'route','condition-20')).toMatchObject({allowed:false,reason:'condition_limit'});
  expect(routeRetryEligibility(ledger,'route','condition-0')).toMatchObject({allowed:false,reason:'condition_attempted'});
  ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'condition-0',outcome:'unknown',reason:'dispatched_result_missing'});
  ledger=releaseRouteRetryForProgress(ledger,'route','later-child-success');
  ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'condition-0',outcome:'verified',reason:'later_fresh_session'});
  expect(routeRetryEligibility(ledger,'route','another-document')).toMatchObject({allowed:false,reason:'unknown_result'});
  expect(ledger.routes.route.conditions['condition-0']).toMatchObject({outcome:'unknown',reason:'dispatched_result_missing'});
});

it('renews exactly one route attempt from complete original-source recovery evidence without rewriting unknown history',()=>{
  const f=fixture(),source=f.observation('source','Open'),sid=source.o.sessionId;
  for(const id of ['unknown-a','unknown-b'])f.store.put('attempt',{id,sessionId:sid,status:'unknown'});
  const unknown=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:'condition',outcome:'unknown',reason:'result_missing',attemptKey:'first-request',unknownSource:{sessionId:sid,attemptIds:['unknown-a','unknown-b']}});
  f.store.put('continuation',{id:'partial',sessionId:sid,verifiedRecovery:{attemptIds:['unknown-a'],evidence:['Verified original state']}});
  expect(releaseRouteRetriesForVerifiedRecovery(f.host,unknown,sid).released).toEqual([]);
  f.store.put('continuation',{id:'wrong-session',sessionId:'fresh-session',verifiedRecovery:{attemptIds:['unknown-b'],evidence:['Fresh page available']}});
  expect(releaseRouteRetriesForVerifiedRecovery(f.host,unknown,sid).released).toEqual([]);
  f.store.put('continuation',{id:'remaining',sessionId:sid,verifiedRecovery:{attemptIds:['unknown-b'],evidence:['Verified remaining original result']}});
  const result=releaseRouteRetriesForVerifiedRecovery(f.host,unknown,sid),verificationId=result.released[0].verificationId;
  expect(result.released).toEqual([{routeKey:'route',verificationId,attemptIds:['unknown-a','unknown-b'],continuationIds:['partial','remaining']}]);
  expect(unknown.routes.route.unknown).toBe(true);expect(unknown.routes.route.recoveryVerifications).toBeUndefined();
  expect(result.ledger.routes.route.conditions.condition).toMatchObject({outcome:'unknown',recoveryVerificationId:verificationId});
  expect(result.ledger.routes.route.recoveryVerifications?.[0]).toMatchObject({unknownRecords:[{conditionVersion:'condition',record:{outcome:'unknown',reason:'result_missing',unknownSource:{sessionId:sid,attemptIds:['unknown-a','unknown-b']}}}]});
  expect(routeRetryEligibility(result.ledger,'route','condition')).toMatchObject({allowed:true,reason:'verified_recovery'});
  let used=recordRouteRetry(JSON.parse(JSON.stringify(result.ledger)),{routeKey:'route',conditionVersion:'condition',outcome:'no_progress',reason:'reserved_after_recovery',attemptKey:'second-request'});
  used=recordRouteRetry(used,{routeKey:'route',conditionVersion:'condition',outcome:'unreachable',reason:'still_unreachable',attemptKey:'second-request'});
  expect(used.routes.route.conditions.condition.attempts).toBe(2);
  expect(used.routes.route.recoveryVerifications?.[0].consumedBy).toEqual({conditionVersion:'condition',attemptKey:'second-request'});
  expect(routeRetryEligibility(used,'route','condition')).toMatchObject({allowed:false,reason:'condition_attempted'});
  expect(releaseRouteRetriesForVerifiedRecovery(f.host,JSON.parse(JSON.stringify(used)),sid).released).toEqual([]);
  // Neither a reread nor another continuation for the same original IDs mints
  // a fresh allowance, even if an old unknown report is delivered again.
  used=recordRouteRetry(used,{routeKey:'route',conditionVersion:'condition',outcome:'unknown',reason:'old_report_redelivered',unknownSource:{sessionId:sid,attemptIds:['unknown-a','unknown-b']}});
  f.store.put('continuation',{id:'repeated-verification',sessionId:sid,verifiedRecovery:{attemptIds:['unknown-a','unknown-b'],evidence:['Same original operations reviewed again']}});
  const repeated=releaseRouteRetriesForVerifiedRecovery(f.host,used,sid);
  expect(repeated.released).toEqual([]);expect(routeRetryEligibility(repeated.ledger,'route','new-document').reason).toBe('unknown_result');
  expect(f.host.list<any>(sid,'attempt').map(a=>a.status)).toEqual(['unknown','unknown']);f.store.close();
});

it.each(['missing-attempt','executing','missing-mapping','missing-proof','missing-source'] as const)('keeps unknown routes locked for %s recovery evidence',mode=>{
  const f=fixture(),source=f.observation('source','Open'),sid=source.o.sessionId;
  if(mode!=='missing-attempt')f.store.put('attempt',{id:'unknown',sessionId:sid,status:mode==='executing'?'executing':'unknown'});
  f.store.put('continuation',{id:'verified',sessionId:sid,verifiedRecovery:{attemptIds:['unknown'],evidence:mode==='missing-proof'?[]:['Checked original source']}});
  const ledger=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:'condition',outcome:'unknown',reason:'result_missing',...(mode==='missing-mapping'?{}:{unknownSource:{sessionId:sid,attemptIds:['unknown']}})});
  if(mode==='missing-source')vi.spyOn(f.host,'list').mockImplementation(()=>{throw new Error('Source unavailable');});
  const result=releaseRouteRetriesForVerifiedRecovery(f.host,ledger,sid);
  expect(result.released).toEqual([]);expect(routeRetryEligibility(result.ledger,'route','condition')).toMatchObject({allowed:false,reason:'unknown_result'});expect(result.ledger).toEqual(ledger);f.store.close();
});

it('requires a new exact recovery proof for a later unknown attempt on the same route',()=>{
  const f=fixture(),source=f.observation('source','Open'),sid=source.o.sessionId;
  f.store.put('attempt',{id:'first',sessionId:sid,status:'unknown'});
  f.store.put('continuation',{id:'first-proof',sessionId:sid,verifiedRecovery:{attemptIds:['first'],evidence:['First recovery verified']}});
  let ledger=recordRouteRetry(undefined,{routeKey:'route',conditionVersion:'condition',outcome:'unknown',reason:'first_unknown',unknownSource:{sessionId:sid,attemptIds:['first']}});
  ledger=releaseRouteRetriesForVerifiedRecovery(f.host,ledger,sid).ledger;
  ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'condition',outcome:'no_progress',reason:'reserved',attemptKey:'next-request'});
  f.store.put('attempt',{id:'second',sessionId:sid,status:'unknown'});
  ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'condition',outcome:'unknown',reason:'second_unknown',attemptKey:'next-request',unknownSource:{sessionId:sid,attemptIds:['second']}});
  expect(releaseRouteRetriesForVerifiedRecovery(f.host,ledger,sid).released).toEqual([]);
  f.store.put('continuation',{id:'second-proof',sessionId:sid,verifiedRecovery:{attemptIds:['second'],evidence:['Second recovery independently verified']}});
  const result=releaseRouteRetriesForVerifiedRecovery(f.host,ledger,sid);
  expect(result.released).toHaveLength(1);expect(result.ledger.routes.route.recoveryVerifications?.map(v=>v.attemptIds)).toEqual([['first'],['second']]);
  expect(routeRetryEligibility(result.ledger,'route','condition')).toMatchObject({allowed:true,reason:'verified_recovery'});f.store.close();
});

it('keeps saturated route bounds while retaining the recovered unknown record for audit',()=>{
  const f=fixture(),source=f.observation('source','Open'),sid=source.o.sessionId;
  f.store.put('attempt',{id:'unknown',sessionId:sid,status:'unknown'});f.store.put('continuation',{id:'proof',sessionId:sid,verifiedRecovery:{attemptIds:['unknown'],evidence:['Original result verified']}});
  let ledger:RouteRetryLedger|undefined;
  for(let i=0;i<16;i++)ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:`condition-${i}`,outcome:'unreachable',reason:'no_route'});
  ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'condition-0',outcome:'unknown',reason:'result_missing',unknownSource:{sessionId:sid,attemptIds:['unknown']}});
  ledger=releaseRouteRetriesForVerifiedRecovery(f.host,ledger,sid).ledger;
  ledger=recordRouteRetry(ledger,{routeKey:'route',conditionVersion:'after-recovery',outcome:'no_progress',reason:'reserved',attemptKey:'renewed-request'});
  expect(Object.keys(ledger.routes.route.conditions)).toHaveLength(16);
  expect(ledger.routes.route.recoveryVerifications?.[0].unknownRecords[0]).toMatchObject({conditionVersion:'condition-0',record:{outcome:'unknown'}});
  expect(routeRetryEligibility(ledger,'route','another-condition')).toMatchObject({allowed:false,reason:'condition_limit'});
  expect(routeRetryEligibility(ledger,'route','after-recovery')).toMatchObject({allowed:false,reason:'condition_attempted'});f.store.close();
});
