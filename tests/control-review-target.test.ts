import { expect, it, vi } from 'vitest';
import { InteractionEngine, id, now, type ActionAttempt, type InteractionAdapter, type InteractionDriver, type ObservationData } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { PlaywrightAdapter, browserControlReviewMaterialKey, createBrowserControlReviewMaterialKey, browserControlReviewTargetCorrespondence, type ActionCandidate, type Control, type Observation, type Session, type SessionOptions } from '@interaction/browser';

const url='https://review-target.fixture.invalid/';
function control(localId:string,role='generic',name='USD'):Control {
  return {localId,instanceId:`document:${localId}`,identityId:`identity:${localId}`,tag:'div',role,name,label:name,stableKey:`id:${localId}`,region:'document',
    identityContext:{scope:'converter',binding:localId,evidence:['captured-owner']},visible:true,enabled:true,readOnly:false,editable:false,
    value:'',displayedText:name,selected:[],checked:null,pressed:null,expanded:null,actions:[],actionBasis:{},constraints:{type:'div',required:false,valid:true},options:[],
    actionable:{visible:true,enabled:true,hitTarget:true,unknown:[]},reviewBinding:{parentInstanceId:'document:owner',attributes:{id:localId}},
    reviewReuseBinding:{ancestors:[{tag:'main',attributes:{id:'converter'},label:'Converter'}]},
    classificationBinding:{truncated:false,text:name,nodes:[{instanceId:`document:${localId}`,parentInstanceId:'document:owner',tag:'div',attributes:{id:localId}}],references:[]},
  } as unknown as Control;
}
function observed():Observation {
  return {id:'source',sessionId:'session',documentId:'document',instanceScope:'document',url,ruleVersion:'observable-v8',context:{},stable:true,gaps:[],
    controls:[control('usd'),{...control('mode','checkbox','Mode'),checked:false}],regions:[{key:'document',role:'document',label:'Document'}],components:[],boundaries:[],overlays:[],
    scroll:{x:0,y:0},stateId:'state',canonical:'source',fingerprint:'source'} as unknown as Observation;
}

// Only the driver is a memory state machine. The real core queue, attempt
// ledger, recovery stages, identity assignment and browser review projection
// are exercised. No browser, server, SQLite or provider is constructed.
class Driver implements InteractionDriver<Observation,SessionOptions> {
  layers=0; quote=1; connectedState=false; unknownMode=false; staleReview=false;
  readonly reopen=vi.fn(async()=>{throw Error('Entry reopening is forbidden by this fixture');});
  readonly execute=vi.fn(async(a:ActionCandidate)=>{if(a.kind!=='click'||!a.boundary)throw Error('Only existing boundary exits are allowed');this.layers--;this.quote++;});
  readonly preflight=vi.fn(async(_o:Observation,_a?:ActionCandidate,reviewIds?:string[])=>reviewIds?.length&&this.staleReview?'stale' as const:'valid' as const);
  async start(){this.connectedState=true;}
  connected(){return this.connectedState;}
  async close(){this.connectedState=false;}
  async validate(){ }
  async capture():Promise<ObservationData<Observation>> {
    const o=observed();
    if(this.unknownMode)delete (o.controls[1] as Partial<Control>).checked;
    o.controls.push({...control('quote','textbox','BTC output'),tag:'input',readOnly:true,value:String(this.quote)});
    for(let layer=1;layer<=this.layers;layer++){
      const c={...control(`close-${layer}`,'button',`Close ${layer}`),tag:'button',actions:['click'],actionBasis:{click:{status:'supported' as const,evidence:[{source:'html',rule:'native-button/v1',facts:{type:'button'}}]}}};
      o.controls.push(c);
      o.boundaries!.push({key:`modal-${layer}`,name:`Dialog ${layer}`,region:'document',evidence:['owned-fixture-boundary']});
      o.overlays!.push({key:`modal-${layer}`,name:`Dialog ${layer}`,kind:'modal',selector:`#modal-${layer}`,parentRegion:'document',evidence:['owned-fixture-boundary'],controlIds:[c.localId],exitControlIds:[c.localId]});
    }
    return {...o,capturedAt:now()};
  }
  async discover(o:Observation,s:Session):Promise<ActionCandidate[]> {
    const active=o.overlays?.at(-1);if(!active)return [];
    const c=o.controls.find(c=>c.localId===active.exitControlIds[0])!;
    return [{id:id(),sessionId:s.id,observationId:o.id,stateId:o.stateId,controlId:c.identityId,localId:c.localId,kind:'click',label:c.name,
      risk:'interface',replayable:true,excluded:false,sampleValidity:'known',source:'fixture',basis:c.actionBasis!.click,boundary:{key:active.key,intent:'exit'},
      preconditions:{context:o.context,visible:true,enabled:true,identityResolved:true,targetResolved:true}}];
  }
}
function adapter(driver:Driver):InteractionAdapter<Observation,SessionOptions>&{createDriver:ReturnType<typeof vi.fn>} {
  const browser=new PlaywrightAdapter();
  return {ruleVersion:browser.ruleVersion,parseOptions:browser.parseOptions,createDriver:vi.fn(()=>driver),signature:browser.signature,
    normalize:browser.normalize,compare:browser.compare,constrain:a=>a,testPredicate:browser.testPredicate,replayMatches:browser.replayMatches,
    returnAction:browser.returnAction,entryAction:browser.entryAction,controlCorrespondence:browser.controlCorrespondence,
    controlReviewTargetCorrespondence:browser.controlReviewTargetCorrespondence};
}
async function fixture(layers=1,unknownMode=false) {
  const driver=new Driver();driver.unknownMode=unknownMode;
  const store=new MemoryStore(),platform=adapter(driver),engine=new InteractionEngine({adapter:platform,persistence:store});
  const session=await engine.createSession({url,exploration:'controls',maxActions:10,maxDurationMs:10000});
  const source=engine.observation(session.id),checkpoint=await engine.createCheckpoint(session.id,'review source');
  driver.layers=layers;driver.quote++;await engine.observe(session.id);
  const input={checkpointId:checkpoint.id,observationId:source.id,localId:'usd'};
  return {driver,store,platform,engine,session,source,input};
}

it.each([1,2])('stops after %i existing boundary exits at current review material, without whole-page replay',async layers=>{
  const f=await fixture(layers,true);try{
    const result=await f.engine.reachControlReviewTarget(f.session.id,{...f.input,currentObservationId:f.engine.observation(f.session.id).id});
    expect(result).toMatchObject({status:'CURRENT_REVIEWABLE',sourceEquivalent:'unknown',matchedLocalId:'usd',checkpointVerified:false,currentExecution:false,executionAuthorized:false,coverageGranted:false});
    expect(result.attemptIds).toHaveLength(layers);expect(f.driver.execute).toHaveBeenCalledTimes(layers);expect(f.driver.reopen).not.toHaveBeenCalled();
    expect(result.diagnostics?.strategies).toEqual(['verify_current','boundary_exit']);
    expect(f.engine.observation(f.session.id).canonical).not.toBe(f.source.canonical);
    expect(f.engine.list<ActionAttempt>(f.session.id,'attempt').every(a=>a.status==='succeeded'&&a.purpose==='recovery'&&a.action.kind==='click')).toBe(true);
    expect(f.driver.preflight.mock.calls.some(([,a,ids])=>!a&&ids?.[0]==='usd')).toBe(true);
    expect(f.engine.list(f.session.id,'reach')).toEqual([]);expect(f.engine.list(f.session.id,'review-target-reach')).toHaveLength(1);
  }finally{await f.engine.close();}
});

it('keeps current reviewability separate from changed nonlocal A/B conditions',()=>{
  const before=observed(),current=structuredClone(before);current.id='current';current.controls[1].checked=true;
  expect(browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current)).toMatchObject({targetMatched:true,reviewable:true,sourceEquivalent:'different'});
  expect(browserControlReviewMaterialKey(before.controls[0],before)).not.toBe(browserControlReviewMaterialKey(current.controls[0],current));
});

it('binds negative waiting to raw mode facts even when another missing mode prevents equivalence',()=>{
  const before=observed();before.controls.push({...control('unknown','checkbox','Unknown'),checked:null});
  const current=structuredClone(before);current.controls[1].checked=true;
  const retained=structuredClone(before);retained.id='another-record';
  const a=browserControlReviewTargetCorrespondence(before.controls[0],before,retained.controls[0],retained);
  const b=browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current);
  expect(a).toMatchObject({reviewable:true,sourceEquivalent:'unknown'});expect(b).toMatchObject({reviewable:true,sourceEquivalent:'unknown'});
  expect(a.currentMaterialKey).toBeTruthy();expect(b.currentMaterialKey).not.toBe(a.currentMaterialKey);
});

it('settles only the same recorded occurrence when missing branches prevent historical equivalence',()=>{
  const before=observed();before.controls[1].checked=null;
  const self=browserControlReviewTargetCorrespondence(before.controls[0],before,before.controls[0],before);
  expect(self).toMatchObject({reviewable:true,sourceEquivalent:'equivalent'});expect(self.conditionKey).toBeUndefined();expect(self.currentMaterialKey).toBeTruthy();
  const copied=structuredClone(before);
  expect(browserControlReviewTargetCorrespondence(before.controls[0],before,copied.controls[0],copied)).toMatchObject({reviewable:true,sourceEquivalent:'unknown'});
  const a=observed(),b=structuredClone(a);b.controls[1].checked=true;
  const aKey=browserControlReviewTargetCorrespondence(a.controls[0],a,a.controls[0],a).conditionKey;
  const bKey=browserControlReviewTargetCorrespondence(b.controls[0],b,b.controls[0],b).conditionKey;
  expect(aKey).toBeTruthy();expect(bKey).toBeTruthy();expect(aKey).not.toBe(bKey);
});

it.each<{reason:string;localId:string;change:(o:Observation)=>void}>([
  {reason:'selector_state_missing',localId:'mode',change:o=>{o.controls[1].checked=null;}},
  {reason:'selector_unstable',localId:'mode',change:o=>{o.controls[1].readiness={status:'unstable',reason:'changing-selector'};}},
  {reason:'selector_identity_hypothesis',localId:'mode',change:o=>{o.controls[1].hypothesisId='unresolved-selector';}},
  {reason:'selector_instance_bound',localId:'mode',change:o=>{o.controls[1].identityScope='instance';}},
  {reason:'selector_record_key_missing',localId:'mode',change:o=>{o.controls[1].structuralItem={ownerInstanceId:'owner',rowInstanceId:'row',template:'mode-row',slot:'mode'};}},
  {reason:'selector_binding_duplicate',localId:'duplicate-mode',change:o=>{o.controls.push({...structuredClone(o.controls[1]),localId:'duplicate-mode',instanceId:'document:duplicate-mode'});}},
  {reason:'selector_limit_exceeded',localId:'mode-32',change:o=>{for(let n=1;n<=32;n++)o.controls.push({...control(`mode-${n}`,'checkbox',`Mode ${n}`),checked:false});}},
])('reports the first portable selector rejection $reason while preserving reflexive review proof',({reason,localId,change})=>{
  const o=observed();change(o);o.controls.push({...control('later-missing','checkbox','Later missing'),checked:null});
  const snapshot=structuredClone(o),result=browserControlReviewTargetCorrespondence(o.controls[0],o,o.controls[0],o);
  expect(result).toMatchObject({targetMatched:true,reviewable:true,sourceEquivalent:'equivalent',reason:'same_recorded_review_occurrence',
    sourceConditionAssessment:{status:'unavailable',reason,localId},currentConditionAssessment:{status:'unavailable',reason,localId}});
  expect(result.conditionKey).toBeUndefined();expect(result.currentMaterialKey).toBeTruthy();expect(o).toEqual(snapshot);
});

it('keeps source and current condition diagnostics separate without changing available keys or evidence',()=>{
  const before=observed(),current=structuredClone(before);current.id='current';
  const complete=browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current);
  expect(complete).toMatchObject({sourceEquivalent:'equivalent',sourceConditionAssessment:{status:'available'},currentConditionAssessment:{status:'available'}});
  before.controls[1].hypothesisId='old-unresolved-selector';
  const missingSource=browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current);
  expect(missingSource).toMatchObject({reviewable:true,sourceEquivalent:'unknown',sourceConditionAssessment:{status:'unavailable',reason:'selector_identity_hypothesis',localId:'mode'},currentConditionAssessment:{status:'available'}});
  expect(missingSource.conditionKey).toBe(complete.conditionKey);expect(missingSource.evidence).toEqual(complete.evidence);
  delete before.controls[1].hypothesisId;current.controls[1].checked=null;
  const missingCurrent=browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current);
  expect(missingCurrent).toMatchObject({reviewable:true,sourceEquivalent:'unknown',sourceConditionAssessment:{status:'available'},currentConditionAssessment:{status:'unavailable',reason:'selector_state_missing',localId:'mode'}});
  expect(missingCurrent.conditionKey).toBeUndefined();expect(missingCurrent.evidence).toEqual(complete.evidence);
});

it.each<{reason:string;change:(o:Observation)=>void}>([
  {reason:'review_classification_material_incomplete',change:o=>{o.controls[0].classificationBinding!.truncated=true;}},
  {reason:'review_boundary_name_missing',change:o=>{o.boundaries=[{key:'source-modal',name:'',region:'document',evidence:[]}];}},
  {reason:'review_boundary_overlay_missing',change:o=>{o.boundaries=[{key:'source-modal',name:'Source modal',region:'document',evidence:[]}];}},
  {reason:'review_rule_version_incompatible',change:o=>{o.ruleVersion='observable-v6';}},
])('reports unavailable historical review conditions for $reason without weakening the current proof',({reason,change})=>{
  const before=observed(),current=structuredClone(before);current.id='current';
  const key=browserControlReviewTargetCorrespondence(current.controls[0],current,current.controls[0],current).conditionKey;
  change(before);
  const result=browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current);
  expect(result).toMatchObject({reviewable:true,sourceEquivalent:'unknown',sourceConditionAssessment:{status:'unavailable',reason},currentConditionAssessment:{status:'available'}});
  expect(result.conditionKey).toBe(key);
});

it('passes portable condition diagnostics through SDK self queries without authorizing historical recovery',async()=>{
  const f=await fixture(0,true);try{
    const o=f.engine.observation(f.session.id),source={sessionId:f.session.id,observationId:o.id,localId:'usd'};
    const result=f.engine.controlReviewTargetCorrespondence(f.session.id,{observationId:o.id,localId:'usd',source});
    expect(result).toMatchObject({sourceEquivalent:'equivalent',reviewable:true,sourceConditionAssessment:{status:'unavailable',reason:'selector_state_missing',localId:'mode'},
      currentConditionAssessment:{status:'unavailable',reason:'selector_state_missing',localId:'mode'},executionAuthorized:false,replayAuthorized:false,coverageGranted:false,checkpointVerified:false});
    expect(result.conditionKey).toBeUndefined();expect(f.driver.execute).not.toHaveBeenCalled();expect(f.driver.reopen).not.toHaveBeenCalled();
  }finally{await f.engine.close();}
});

it('compares complete v7 and v8 review conditions without migrating strict checkpoints or merging A/B',()=>{
  const before=observed();before.ruleVersion='observable-v7';
  const current=structuredClone(before);current.id='current-v8';current.ruleVersion='observable-v8';
  const snapshot=structuredClone(before),browser=new PlaywrightAdapter();
  const same=browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current);
  expect(same).toMatchObject({reviewable:true,sourceEquivalent:'equivalent'});expect(same.conditionKey).toBeTruthy();
  expect(browser.normalize(before)).not.toBe(browser.normalize(current));expect(before).toEqual(snapshot);
  current.controls[1].checked=true;
  const changed=browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current);
  expect(changed).toMatchObject({reviewable:true,sourceEquivalent:'different'});expect(changed.conditionKey).not.toBe(same.conditionKey);
  before.ruleVersion='observable-v6';current.controls[1].checked=false;
  expect(browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current)).toMatchObject({reviewable:true,sourceEquivalent:'unknown'});
});

it('requires historical A conditions and uses an existing safe local restoration instead of accepting current B',async()=>{
  const f=await fixture(0);try{
    let mode=true;
    const capture=f.driver.capture.bind(f.driver);
    f.driver.capture=async()=>{
      const o=await capture(),c=o.controls[1];c.checked=mode;c.actions=['check'];
      c.actionBasis={check:{status:'supported',evidence:[{source:'caller',rule:'fixture-observed-mode/v1',facts:{kind:'check'}}]}};
      return o;
    };
    const action=(o:Observation,s:Session):ActionCandidate=>{
      const c=o.controls[1];return {id:id(),sessionId:s.id,observationId:o.id,stateId:o.stateId,controlId:c.identityId,localId:c.localId,kind:'check',label:c.name,value:false,
        risk:'interface',replayable:true,excluded:false,sampleValidity:'known',source:'fixture-observed-mode',basis:c.actionBasis!.check,
        preconditions:{context:o.context,visible:true,enabled:true,identityResolved:true,targetResolved:true}};
    };
    f.driver.discover=async(o,s)=>[action(o,s)];
    f.driver.execute.mockImplementation(async a=>{if(a.kind!=='check'||a.localId!=='mode'||typeof a.value!=='boolean')throw Error('Only declared mode restoration is supported');mode=a.value;});
    f.platform.restorationStep=(_source,current,session)=>{
      if(!current.controls[1].checked)return;
      const expected=structuredClone(current);expected.controls[1].checked=false;
      return {action:action(current,session),expectedCanonical:f.platform.normalize(expected),evidence:['Fixture declares exact native mode restoration']};
    };
    // Default behavior intentionally exposes new B material without settling A.
    const fresh=await f.engine.reachControlReviewTarget(f.session.id,f.input);
    expect(fresh).toMatchObject({status:'CURRENT_REVIEWABLE',requireSourceEquivalent:false,sourceEquivalent:'different',attemptIds:[]});
    const result=await f.engine.reachControlReviewTarget(f.session.id,{...f.input,requireSourceEquivalent:true});
    expect(result).toMatchObject({status:'CURRENT_REVIEWABLE',requireSourceEquivalent:true,sourceEquivalent:'equivalent',matchedLocalId:'usd',checkpointVerified:false});
    expect(result.attemptIds).toHaveLength(1);expect(result.diagnostics?.strategies).toContain('declared_local_restore');
    expect(f.driver.execute).toHaveBeenCalledTimes(1);expect(f.driver.reopen).not.toHaveBeenCalled();
    expect(f.engine.observation(f.session.id).canonical).not.toBe(f.source.canonical);
    expect(f.engine.list<ActionAttempt>(f.session.id,'attempt')[0]).toMatchObject({status:'succeeded',purpose:'recovery',action:{kind:'check',localId:'mode',value:false}});
  }finally{await f.engine.close();}
});

it('stops historical review recovery with unknown branch evidence without performing actions',async()=>{
  const f=await fixture(0,true);try{
    const result=await f.engine.reachControlReviewTarget(f.session.id,{...f.input,requireSourceEquivalent:true});
    expect(result).toMatchObject({status:'UNVERIFIED',requireSourceEquivalent:true,sourceEquivalent:'unknown',attemptIds:[]});
    expect(result.diagnostics?.strategies).toEqual(['verify_current']);expect(result.matchedLocalId).toBeUndefined();
    expect(f.driver.execute).not.toHaveBeenCalled();expect(f.driver.reopen).not.toHaveBeenCalled();
    const fresh=await f.engine.reachControlReviewTarget(f.session.id,f.input);
    expect(fresh).toMatchObject({status:'CURRENT_REVIEWABLE',requireSourceEquivalent:false,sourceEquivalent:'unknown',attemptIds:[]});
  }finally{await f.engine.close();}
});

it('does not reset negative navigation waiting for passive component prices but does for selected modes',()=>{
  const before=observed();before.components=[{id:'quote-list',parentId:'root',basis:{status:'supported',evidence:[]},
    members:[{localId:'price',name:'BTC 0.00001225'},{localId:'mode',selected:false}]}] as unknown as Observation['components'];
  const current=structuredClone(before);current.components![0].members[0].name='BTC 0.00001224';
  expect(browserControlReviewMaterialKey(before.controls[0],before)).toBe(browserControlReviewMaterialKey(current.controls[0],current));
  current.components![0].members[1].selected=true;
  expect(browserControlReviewMaterialKey(before.controls[0],before)).not.toBe(browserControlReviewMaterialKey(current.controls[0],current));
});

it('shares document projections across target keys without changing captured facts',()=>{
  const before=observed(),snapshot=structuredClone(before),targets=[...before.controls];
  const expected=targets.map(c=>browserControlReviewMaterialKey(c,before));
  const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};
  freeze(before);
  const reads={controls:0,components:0},o=new Proxy(before,{get(target,key,receiver){
    if(key==='controls'||key==='components')reads[key]++;
    return Reflect.get(target,key,receiver);
  }});
  const read=createBrowserControlReviewMaterialKey(o);
  expect(targets.map(read)).toEqual(expected);expect(targets.map(read)).toEqual(expected);
  expect(reads).toEqual({controls:1,components:1});expect(before).toEqual(snapshot);
});

it('rejects incomplete competitors and changed owners without trusting names or shared keys',()=>{
  const before=observed(),current=structuredClone(before);current.instanceScope='new-document';current.controls[0].instanceId='new-document:usd';
  const rival=structuredClone(current.controls[0]);rival.localId='rival';rival.instanceId='new-document:rival';rival.classificationBinding!.truncated=true;current.controls.push(rival);
  expect(browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current)).toMatchObject({reviewable:false,reason:'review_target_ambiguous'});
  current.controls.pop();current.controls[0].identityContext!.scope='other-owner';
  expect(browserControlReviewTargetCorrespondence(before.controls[0],before,current.controls[0],current)).toMatchObject({targetMatched:false,reviewable:false});
});

it('rejects a stale live review target and never labels it arrived',async()=>{
  const f=await fixture(0);try{
    f.driver.staleReview=true;
    const result=await f.engine.reachControlReviewTarget(f.session.id,f.input);
    expect(result).toMatchObject({status:'UNVERIFIED',attemptIds:[],checkpointVerified:false});expect(result.matchedLocalId).toBeUndefined();
    expect(f.driver.execute).not.toHaveBeenCalled();expect(f.driver.reopen).not.toHaveBeenCalled();
  }finally{await f.engine.close();}
});

it('blocks a retained unknown after restart before driver attachment or new material can change its result',async()=>{
  const f=await fixture();
  const reached=await f.engine.reachControlReviewTarget(f.session.id,f.input),attempt=f.engine.list<ActionAttempt>(f.session.id,'attempt')[0];
  expect(reached.status).toBe('CURRENT_REVIEWABLE');f.store.put('attempt',{...attempt,status:'unknown',reason:'crash before durable result'});
  await f.engine.close();
  const driver=new Driver(),platform=adapter(driver),engine=new InteractionEngine({adapter:platform,persistence:f.store});
  try{
    const result=await engine.reachControlReviewTarget(f.session.id,f.input);
    expect(result).toMatchObject({status:'UNVERIFIED',sourceEquivalent:'unknown',attemptIds:[]});
    expect(platform.createDriver).not.toHaveBeenCalled();expect(driver.execute).not.toHaveBeenCalled();expect(driver.reopen).not.toHaveBeenCalled();
    expect(engine.list<ActionAttempt>(f.session.id,'attempt')[0].status).toBe('unknown');
  }finally{await engine.close();}
});

it('queries historical record batches once per observation without mutation or full action/history reads',async()=>{
  const f=await fixture(0);try{
    const current=f.engine.observation(f.session.id),list=vi.spyOn(f.store,'list'),put=vi.spyOn(f.store,'put'),get=vi.spyOn(f.store,'get');
    const source={sessionId:f.session.id,observationId:current.id,localId:'usd'};
    const batch=f.engine.controlReviewTargetCorrespondences(f.session.id,{observationId:f.source.id,requests:[{localId:'usd',source},{localId:'usd',source},
      {localId:'mode',source:{...source,localId:'mode'}}]});
    expect(batch.results).toHaveLength(3);
    expect(batch.results.every(r=>r.targetMatched&&r.reviewable&&r.sourceEquivalent==='equivalent'&&r.preflightRequired&&!r.executionAuthorized&&!r.currentExecution&&!r.coverageGranted)).toBe(true);
    expect(list).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
    expect(get.mock.calls.filter(([kind])=>kind==='observation').map(([,id])=>id)).toEqual([f.source.id,current.id]);
    expect(f.engine.controlReviewTargetCorrespondence(f.session.id,{observationId:'missing',localId:'usd',source})).toMatchObject({reviewable:false,sourceEquivalent:'unknown'});
    await expect(f.engine.reachControlReviewTarget(f.session.id,{...f.input,currentObservationId:f.source.id})).rejects.toThrow('Browser cursor changed');
  }finally{await f.engine.close();}
});

it('stops remaining recorded replay steps when review arrival verification requests resolution',async()=>{
  const f=await fixture();try{
    await f.engine.reachControlReviewTarget(f.session.id,f.input);
    const old=f.engine.list<ActionAttempt>(f.session.id,'attempt')[0];
    f.driver.layers=1;await f.engine.observe(f.session.id);f.driver.execute.mockClear();
    // This test isolates the existing replay loop's callback protocol. The
    // actual unknown/readiness gates are covered above; no operation policy is
    // claimed by this fixture-only repeatability grant.
    vi.spyOn(f.engine,'repetitionAssessment').mockImplementation((sid,input)=>({repeatable:true,reason:'fixture-repeatable',conditionKey:'fixture',evidence:[],
      source:input.source,target:{sessionId:sid,observationId:input.observationId,actionId:input.actionId},dispatchRevalidationRequired:true}));
    const reached=vi.fn(async()=> 'stop' as const),performed:string[]=[];
    const replay=f.engine as unknown as {replay(sid:string,ids:string[],writes:boolean,performed:string[],arrival:()=>Promise<'stop'>):Promise<{failure?:string}>};
    const result=await replay.replay(f.session.id,[old.id,old.id],false,performed,reached);
    expect(result.failure).toBe('review_arrival_unverified');expect(performed).toHaveLength(1);
    expect(f.driver.execute).toHaveBeenCalledTimes(1);expect(reached).toHaveBeenCalledTimes(1);
  }finally{await f.engine.close();}
});
