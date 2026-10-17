import {expect,it,vi} from 'vitest';
import {controlReviewConditions,controlReviewKey,controlReuseConditions,hash,type ActionAttempt,type ActionCandidate,type Control,type ControlReviewRecord,type Observation} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';
import {ControlReviews} from '../packages/browser/src/control-reviews.js';

// Authority only: dependency/document correspondence is tested by its consumer.
// Independent in-memory receipts exercise retained provenance without a browser.
const time=(second:number)=>new Date(Date.UTC(2026,9,17,0,0,second)).toISOString();
function control():Control {
 return {localId:'open',instanceId:'open-instance',identityId:'identity',tag:'button',role:'button',name:'Open',label:'Open',stableKey:'id:open',region:'region',regionInstanceId:'region-instance',form:'',selector:'#open',
  rect:{x:0,y:0,width:20,height:20},value:'',displayedText:'Open',checked:null,selected:[],visible:true,enabled:true,editable:false,expanded:null,controls:null,
  constraints:{type:'button',required:false,valid:true},options:[],actions:['click'],discovery:['fixture'],actionBasis:{click:{status:'supported',evidence:[{source:'html',rule:'native-button/v1',facts:{type:'button'}}]}},
  reviewBinding:{parentInstanceId:'parent-instance',attributes:{id:'open',type:'button'}},reviewAttributes:{'data-record':'A'},reviewReuseBinding:{ancestors:[{tag:'section',selector:'#tools',attributes:{id:'tools'},label:'Tools'}]},
  actionable:{visible:true,enabled:true,editable:false,hitTarget:true,unknown:[]}};
}
function observation(id:string,second:number):Observation {
 return {id,sessionId:'session',capturedAt:time(second),documentId:'document',instanceScope:'browser:document',url:'https://fixture.invalid/',title:'Fixture',text:'Open',
  viewport:{width:500,height:300},scroll:{x:0,y:0,maxY:0},controls:[control()],regions:[],context:{account:{status:'known',value:'fixture',source:'declared'}},boundaries:[],
  stable:true,gaps:[],stateId:`state-${id}`,visitId:`visit-${id}`,fingerprint:id,canonical:id,ruleVersion:'observable-v7',cause:'inspection'};
}
function action(o:Observation):ActionCandidate {
 return {id:`action-${o.id}`,sessionId:o.sessionId,observationId:o.id,stateId:o.stateId,controlId:'identity',localId:'open',kind:'click',label:'Open',
  risk:'interface',replayable:false,source:'control',excluded:false,sampleValidity:'known',basis:structuredClone(o.controls[0].actionBasis!.click),
  preconditions:{context:o.context,visible:true,enabled:true,identityResolved:true}};
}
function record(o:Observation,id='review',at=2):ControlReviewRecord {
 const conditions=controlReviewConditions(o.controls[0],o,'click')!;
 return {id,sessionId:o.sessionId,observationId:o.id,localId:o.controls[0].localId,kind:'click',risk:'interface',replayable:false,reason:'Inspect the local interface',
  evidence:['Caller reviewed this exact target'],source:'fixture-reviewer',at:time(at),status:'active',conditions,conditionKey:controlReviewKey(conditions)};
}
function approve(a:ActionCandidate,r:ControlReviewRecord) {
 a.source='control-review';a.basis={status:'supported',evidence:[...a.basis?.evidence||[],{source:r.source,rule:'reviewed-control/v1',facts:{reviewId:r.id,conditionKey:r.conditionKey,sourceObservationId:r.observationId}}]};
 if(r.reusedFrom)a.basis.evidence.push({source:r.source,rule:'reused-control-review/v1',facts:{reviewId:r.id,sourceReviewId:r.reusedFrom.reviewId,conditionKey:r.reusedFrom.conditionKey,businessScope:r.reuse!.businessScope}});
}
function draft(native=false) {
 const original=observation('review-source',0),target=observation('target',1),before=observation('before',3),after=observation('after',5),review=record(original),sourceAction=action(before),targetAction=action(target);
 if(!native){approve(sourceAction,review);approve(targetAction,review);}
 const attempt:ActionAttempt={id:'receipt',sessionId:'session',requestId:'actual-execution',action:sourceAction,beforeId:before.id,afterId:after.id,status:'succeeded',startedAt:time(4),finishedAt:time(6),purpose:'exploration'};
 return {original,target,before,after,review,sourceAction,targetAction,attempt,observations:[original,target,before,after],reviews:[review]};
}
type Draft=ReturnType<typeof draft>;
function fixture(change?:(d:Draft)=>void,native=false) {
 const d=draft(native);change?.(d);const store=new MemoryStore();
 for(const o of d.observations)store.put('observation',o);for(const r of d.reviews)store.put('control-review',r);
 const emit=vi.fn(),reviews=new ControlReviews(store,emit);
 return {...d,store,emit,reviews,query:()=>reviews.coverageAuthority(d.targetAction,d.target,d.attempt,d.before)};
}
function withParent(d:Draft) {
 const original=observation('parent-source',-3);original.instanceScope='prior-document';original.documentId='prior-document';
 original.controls[0].instanceId='prior-instance';original.controls[0].localId='prior-open';original.controls[0].reviewBinding!.parentInstanceId='prior-parent';
 const parent=record(original,'parent-review',-2),reuse={binding:'same-url-context' as const,businessScope:'Fixture public interface'};
 parent.reuse=reuse;parent.reuseConditions=controlReuseConditions(original.controls[0],original,'click')!;
 parent.status='invalidated';parent.invalidation={observationId:d.original.id,reason:'document_changed',at:time(0)};
 d.review.reuse=structuredClone(reuse);d.review.reuseConditions=controlReuseConditions(d.original.controls[0],d.original,'click')!;
 d.review.reusedFrom={reviewId:parent.id,conditionKey:hash({businessScope:reuse.businessScope,conditions:parent.reuseConditions}),evidence:['Explicitly reused exact purpose']};
 d.observations.push(original);d.reviews.push(parent);
 d.sourceAction.basis!.evidence=d.sourceAction.basis!.evidence.filter(e=>e.rule!=='reviewed-control/v1');d.targetAction.basis!.evidence=d.targetAction.basis!.evidence.filter(e=>e.rule!=='reviewed-control/v1');
 approve(d.sourceAction,d.review);approve(d.targetAction,d.review);return parent;
}
function proof(a:ActionCandidate) {return a.basis!.evidence.find(e=>e.rule==='reviewed-control/v1')!;}

it('keeps native supported actions unchanged without consulting review records',()=>{
 const f=fixture(undefined,true),get=vi.spyOn(f.store,'get'),put=vi.spyOn(f.store,'put');const result=f.query();
 expect(result?.source).toBe(f.sourceAction);expect(result?.target).toBe(f.targetAction);expect(get).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();expect(f.emit).not.toHaveBeenCalled();
});

it('revalidates the same supported reviewed operation without mutating the receipt or captured facts',()=>{
 const f=fixture(),before=structuredClone({action:f.targetAction,attempt:f.attempt,observations:f.observations}),put=vi.spyOn(f.store,'put');
 const result=f.query();expect(result?.source).toBe(f.sourceAction);expect(result?.target).toBe(f.targetAction);expect(result?.evidence).toContain(`historical-control-review:${f.review.id}`);
 expect({action:f.targetAction,attempt:f.attempt,observations:f.observations}).toEqual(before);expect(put).not.toHaveBeenCalled();expect(f.emit).not.toHaveBeenCalled();
});

it('allows a later same-review target but does not invent a review for an earlier tentative target',()=>{
 const later=fixture(d=>{d.target.capturedAt=time(8);});expect(later.query()?.target).toBe(later.targetAction);
 const earlier=fixture(d=>{d.targetAction.source='control';d.targetAction.risk='unknown';d.targetAction.basis={status:'tentative',evidence:[]};});
 const original=structuredClone(earlier.targetAction),result=earlier.query();expect(result?.target).toMatchObject({risk:'interface',basis:{status:'supported'}});expect(earlier.targetAction).toEqual(original);
 expect(result?.evidence).toContain('coverage-only-review-clarification');
});

it('accepts only the consumed review invalidation tied to this successful after observation',()=>{
 expect(fixture(d=>{d.review.status='invalidated';d.review.invalidation={observationId:d.after.id,reason:'control_conditions_changed',at:time(5)};}).query()).toBeDefined();
 expect(fixture(d=>{d.review.status='invalidated';d.review.invalidation={observationId:d.before.id,reason:'control_conditions_changed',at:time(3)};}).query()).toBeUndefined();
});

it('honors explicit reuse provenance from an invalidated prior document without treating it as current dispatch permission',()=>{
 const f=fixture(d=>{withParent(d);});expect(f.query()?.evidence).toContain('control-review-provenance:parent-review');
 expect(f.store.get<ControlReviewRecord>('control-review','parent-review')?.status).toBe('invalidated');
});

it.each(['unknown','executing','failed','no-after','foreign-attempt','foreign-action','wrong-before','wrong-target','different-value','source-risk','source-basis'] as const)('rejects an ineligible source receipt: %s',change=>{
 const f=fixture(d=>{
  if(change==='unknown'||change==='executing'||change==='failed')d.attempt.status=change;
  if(change==='no-after')delete d.attempt.afterId;if(change==='foreign-attempt')d.attempt.sessionId='foreign';if(change==='foreign-action')d.sourceAction.sessionId='foreign';
  if(change==='wrong-before')d.attempt.beforeId='wrong';if(change==='wrong-target')d.targetAction.observationId='wrong';if(change==='different-value')d.targetAction.value='other';
  if(change==='source-risk')d.sourceAction.risk='unknown';if(change==='source-basis')d.sourceAction.basis!.status='tentative';
 });expect(f.query()).toBeUndefined();
});

it.each(['revoked','superseded','missing-record','false-record-id','forged-key','forged-source','forged-source-observation','duplicate-proof','different-target-review','orphan-reuse','unknown-proof-rule','missing-native-proof'] as const)('rejects unverified review authority: %s',change=>{
 const f=fixture(d=>{
  if(change==='revoked'||change==='superseded')d.review.status=change;if(change==='missing-record')d.reviews=[];if(change==='false-record-id')d.review.id='other';
  if(change==='forged-key')proof(d.sourceAction).facts.conditionKey='bad';if(change==='forged-source')proof(d.sourceAction).source='other';if(change==='forged-source-observation')proof(d.sourceAction).facts.sourceObservationId=d.before.id;
  if(change==='duplicate-proof')d.sourceAction.basis!.evidence.push(structuredClone(proof(d.sourceAction)));if(change==='different-target-review')proof(d.targetAction).facts.reviewId='other-review';
  if(change==='orphan-reuse')d.sourceAction.basis!.evidence.push({source:d.review.source,rule:'reused-control-review/v1',facts:{reviewId:d.review.id,sourceReviewId:'fake'}});
  if(change==='unknown-proof-rule')d.sourceAction.basis!.evidence.push({source:'fixture',rule:'other-review/v1',facts:{reviewId:d.review.id}});
  if(change==='missing-native-proof'){d.sourceAction.basis!.evidence=[];d.targetAction.basis!.evidence=[];}
 });expect(f.query()).toBeUndefined();
});

it.each(['parent-binding','target-attributes','original-attributes','missing-original','foreign-original','original-rule','source-after-start','review-after-start','original-after-review','invalid-target-time','late-unknown-target','duplicate-target'] as const)('rejects changed binding or unverifiable timing: %s',change=>{
 const f=fixture(d=>{
  if(change==='parent-binding')d.target.controls[0].reviewBinding!.parentInstanceId='other-owner';if(change==='target-attributes')d.target.controls[0].reviewAttributes!['data-record']='B';
  if(change==='original-attributes')d.original.controls[0].reviewAttributes!['data-record']='B';if(change==='missing-original')d.observations=d.observations.filter(o=>o.id!==d.original.id);
  if(change==='foreign-original')d.original.sessionId='foreign';if(change==='original-rule')d.original.ruleVersion='observable-v6';
  if(change==='source-after-start')d.before.capturedAt=time(9);if(change==='review-after-start')d.review.at=time(9);if(change==='original-after-review')d.original.capturedAt=time(3);
  if(change==='invalid-target-time')d.target.capturedAt='invalid';if(change==='late-unknown-target'){d.target.capturedAt=time(8);d.targetAction.source='control';d.targetAction.basis={status:'tentative',evidence:[]};d.targetAction.risk='unknown';}
  if(change==='duplicate-target')d.target.controls.push({...structuredClone(d.target.controls[0]),localId:'other-local'});
 });expect(f.query()).toBeUndefined();
});

it.each(['revoked-parent','superseded-parent','missing-parent','wrong-parent-key','wrong-parent-policy','forged-marker','late-parent','cycle','missing-parent-source'] as const)('rejects an invalid explicit reuse chain: %s',change=>{
 const f=fixture(d=>{
  const parent=withParent(d);
  if(change==='revoked-parent')parent.status='revoked';if(change==='superseded-parent')parent.status='superseded';if(change==='missing-parent')d.reviews=d.reviews.filter(r=>r.id!==parent.id);
  if(change==='wrong-parent-key')d.review.reusedFrom!.conditionKey='forged';if(change==='wrong-parent-policy')parent.reuse!.businessScope='Different purpose';
  if(change==='forged-marker')d.sourceAction.basis!.evidence.find(e=>e.rule==='reused-control-review/v1')!.facts.sourceReviewId='other-parent';if(change==='late-parent')parent.at=time(3);
  if(change==='cycle')parent.reusedFrom={reviewId:d.review.id,conditionKey:'cycle',evidence:['cycle']};
  if(change==='missing-parent-source')d.observations=d.observations.filter(o=>o.id!==parent.observationId);
 });expect(f.query()).toBeUndefined();
});

it('reads fresh authority after a same-instance revocation, including a reused source revocation',()=>{
 for(const reused of [false,true]){
  const f=fixture(d=>{if(reused)withParent(d);});expect(f.query()).toBeDefined();
  const id=reused?'parent-review':f.review.id,r=f.store.get<ControlReviewRecord>('control-review',id)!;r.status='revoked';f.store.put('control-review',r);
  expect(f.query()).toBeUndefined();
 }
});
