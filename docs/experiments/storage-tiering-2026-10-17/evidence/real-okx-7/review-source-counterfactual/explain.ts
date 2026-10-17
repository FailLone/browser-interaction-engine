/** Explain the new selector events against exact retained material. Read-only; no selector rerun. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const directory=process.argv[2],setup=JSON.parse(readFileSync(join(directory,'setup.json'),'utf8')),root=setup.archive.root;
const load=(name:string)=>JSON.parse(gunzipSync(readFileSync(join(directory,name))).toString());
const before=load('baseline-semantic.json.gz'),after=load('current-semantic.json.gz'),input=JSON.parse(readFileSync(setup.input,'utf8'));
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
assert.deepEqual(before.input,after.input);assert.equal(after.input.plan.length,803);
globalThis.fetch=async()=>{throw Error('FORBIDDEN_NETWORK');};
const imports=async(path:string)=>import(pathToFileURL(join(root,path)).href);
const {BrowserEngine,browserTargetConditions}=await imports('packages/browser/src/index.ts');
const {SqliteStore}=await imports('packages/storage-sqlite/src/index.ts');
const {ObservationObjectStore}=await imports('packages/storage-sqlite/src/observation-store.ts');
const {controlScopeMatcher,broadScope}=await imports('packages/explorer-plugin/src/policy.ts');
const {observationActionIndex}=await imports('packages/explorer-plugin/src/observation-action-index.ts');
const {boundOperationCondition}=await imports('packages/explorer-plugin/src/plan-state.ts');
const {controlReviewGapReasons}=await imports('packages/explorer-plugin/src/review-ledger.ts');
const {prioritizeReviewAnchors,validReviewRecoveryWait}=await imports('packages/explorer-plugin/src/review-recovery.ts');
const require=createRequire(join(root,'packages/storage-sqlite/package.json')),Database=require('better-sqlite3');
const db=new Database(join(setup.copy,'engine/engine.sqlite'),{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
const storage=Object.create(SqliteStore.prototype);storage.db=db;storage.observations=new ObservationObjectStore(db,()=>{throw Error('FORBIDDEN_WRITE');});
const facade=Object.create(BrowserEngine.prototype);facade.store=new Proxy(storage,{get(target,key){if(key==='recordReadIsolation')return target[key];if(['require','list','listByObservation'].includes(String(key)))return target[key].bind(target);return ()=>{throw Error('FORBIDDEN_STORAGE:'+String(key));};}});
const facts=new Map<string,any>();
function read(id:string){
 if(!facts.has(id)){
  const source=storage.require('observation',id);assert.equal(source.sessionId,input.sessionId);
  const actions=storage.listByObservation('action',input.sessionId,id);
  facts.set(id,{source,actions,inScope:controlScopeMatcher(source,actions),index:observationActionIndex(source,actions)});
 }
 return facts.get(id);
}
const current=read(input.currentId),checkpoints=storage.list('checkpoint',input.sessionId),byObservation=new Map<string,any[]>();
for(const cp of checkpoints){const list=byObservation.get(cp.observationId)||[];list.push(cp);byObservation.set(cp.observationId,list);}
const initialEventCounts=new Map<string,number>();for(const event of before.events){const key=hash(event);initialEventCounts.set(key,(initialEventCounts.get(key)||0)+1);}
const added:any[]=[];
for(const [index,event] of after.events.entries()){
 const key=hash(event),count=initialEventCounts.get(key)||0;
 if(count)initialEventCounts.set(key,count-1);else added.push({index,event});
}
function candidates(item:any){
 const refs=[...new Set(item.evidence.filter((r:any)=>r.sessionId===input.sessionId&&!r.attemptId).map((r:any)=>r.observationId))].reverse() as string[];
 let rows=refs.length?refs.flatMap(ref=>[...(byObservation.get(ref)||[])].reverse()):broadScope(item.scope)||!item.evidence.length?[...checkpoints].reverse():[];
 if(!item.scope.kind&&controlReviewGapReasons.has(item.reason))rows=prioritizeReviewAnchors(rows,current.source,(id:string)=>read(id).source);
 return rows;
}
function controlFacts(source:any,control:any){
 const active=source.boundaries?.at(-1),members=active&&new Set(source.overlays?.find((o:any)=>o.key===active.key)?.controlIds||[]);
 return {control,visible:control.visible,enabled:control.enabled,activeBoundaryKey:active?.key??null,inActiveBoundary:!active||members.has(control.localId),availableForReview:!!control.visible&&(!active||members.has(control.localId))};
}
function candidateFacts(item:any,checkpoint:any){
 const f=read(checkpoint.observationId),o=f.source,preGateBlocked:any[]=[];
 if(o.gaps.some((g:any)=>g.critical))preGateBlocked.push('critical_gap');
 if(Object.values(o.context).some((c:any)=>c.status!=='known'))preGateBlocked.push('unknown_context');
 if(item.scope.url&&item.scope.url!==o.url)preGateBlocked.push('source_url_mismatch');
 const matches=o.controls.filter((c:any)=>f.inScope(item.scope,c)).map((c:any)=>controlFacts(o,c)),condition=boundOperationCondition(item);
 const allTargets=f.index.matching(item.scope),targets=allTargets.filter((a:any)=>!condition||condition===f.index.condition(a));
 const targetConditions=targets.length===1?browserTargetConditions(targets[0],o):undefined;
 return {checkpointId:checkpoint.id,observationId:o.id,sourceSha256:hash(o),sourceActionsSha256:hash(f.actions),preGateBlocked,sourceUrl:o.url,sourceContext:o.context,sourceGaps:o.gaps,boundaries:o.boundaries??[],overlays:(o.overlays??[]).map((r:any)=>({key:r.key,controlIds:r.controlIds})),matchingControls:matches,availableForReview:matches.some((r:any)=>r.availableForReview),boundOperationCondition:condition??null,matchingActions:allTargets.map((a:any)=>({action:a,schedulingCondition:f.index.condition(a),matchesBoundCondition:!condition||condition===f.index.condition(a)})),filteredTargetCount:targets.length,browserTargetConditions:targetConditions??null,concreteTargetVerified:targets.length===1&&!!targetConditions};
}
const explained=added.map(({index,event})=>{
 assert.equal(event.type,'obligation.route_unavailable');const matches=after.input.plan.filter((i:any)=>i.id===event.data.itemId);assert.equal(matches.length,1);
 const item=matches[0],reason=event.data.reason,result:any={eventIndex:index,event,item,sourceCandidates:[],basisVerified:false};
 if(reason==='unchanged_unresolved_review'){
  result.waitValid=validReviewRecoveryWait(after.input,item,current.source,(id:string)=>read(id).source);result.basisVerified=result.waitValid;result.basis='Exact production wait validator; persisted unresolved review still matches retained material.';
 }else{
  result.sourceCandidates=candidates(item).map((cp:any)=>candidateFacts(item,cp));
  if(reason==='source_review_target_not_available'){
   const eligible=result.sourceCandidates.filter((r:any)=>!r.preGateBlocked.length);result.basisVerified=eligible.length>0&&eligible.every((r:any)=>!r.availableForReview);result.basis='Every retained candidate passing prior context/URL/gap gates lacks a visible matching member of its active boundary.';
  }else if(reason==='source_target_unverified'){
   result.basisVerified=!!item.scope.kind&&result.sourceCandidates.length>0&&result.sourceCandidates.every((r:any)=>r.preGateBlocked.length||!r.concreteTargetVerified);result.basis='No candidate passes both exact target/operation-condition matching and SDK target-condition proof.';
  }else if(reason==='current_review_occurrence_present'){
   result.currentPresence=result.sourceCandidates.flatMap((r:any)=>{
    const source=read(r.observationId),previous=new Set(source.source.controls.filter((c:any)=>source.inScope(item.scope,c)).map((c:any)=>c.localId));
    const transition=BrowserEngine.prototype.interactionTransition.call(facade,input.sessionId,source.source.id,current.source.id),retained=transition.retainedControls.filter((c:any)=>previous.has(c.beforeLocalId)),ids=new Set(retained.map((c:any)=>c.afterLocalId));
    return current.source.controls.filter((c:any)=>c.visible&&c.enabled&&(ids.has(c.localId)||current.inScope(item.scope,c))).map((c:any)=>({sourceObservationId:source.source.id,currentControl:c,directScopeMatch:current.inScope(item.scope,c),retainedMappings:retained.filter((r:any)=>r.afterLocalId===c.localId)}));
   });result.basisVerified=result.currentPresence.length>0;result.basis='Exact SDK retained-control transition or literal scope match provides a visible enabled current review occurrence.';
  }else result.basis='Unrecognized reason: retained as unresolved diagnostic, not assumed proven.';
 }
 assert(result.basisVerified,`No independent basis for event ${index}: ${reason}`);return result;
});
const selectedFacts=(semantic:any)=>{
 const selected=semantic.selected;if(!selected)return null;const item=semantic.input.plan.find((i:any)=>i.id===selected.itemId);assert(item);
 const checkpoint=checkpoints.find((cp:any)=>cp.id===selected.frame.checkpointId);assert(checkpoint);
 return {item,choice:{itemId:selected.itemId,routeKey:selected.routeKey,checkpointId:checkpoint.id,sourceObservationId:selected.source.id,returnToSource:selected.returnToSource,targetActionIds:selected.targetActionIds},reviewOnly:!item.scope.kind&&controlReviewGapReasons.has(item.reason),...candidateFacts(item,checkpoint)};
};
const baselineSelected=selectedFacts(before),currentSelected=selectedFacts(after);
assert(!currentSelected?.reviewOnly||currentSelected.availableForReview,'New selector still chose an unavailable review scene');
const result={baselineSelected,currentSelected,newEvents:explained,everyNewDeferHasIndependentBasis:explained.every(r=>r.basisVerified),sourceMaterial:[...facts.values()].map(f=>({observationId:f.source.id,observationSha256:hash(f.source),actionsSha256:hash(f.actions)})),readBoundary:{engineConstructors:0,sqliteStoreConstructors:0,pluginConstructors:0,selectorReruns:0,readonly:db.readonly,queryOnly:db.pragma('query_only',{simple:true}),totalChanges:db.prepare('SELECT total_changes() AS n').get().n},limitation:'One behavior-only fixed terminal-task counterfactual, no actual navigation, execution or restoration. These post-run exact source proofs are outside worker timings.'};
assert.equal(result.readBoundary.totalChanges,0);db.close();writeFileSync(join(directory,'event-basis.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({newEvents:explained.length,everyBasisVerified:result.everyNewDeferHasIndependentBasis,selected:after.selected?.itemId??null,baselineSourceAvailable:baselineSelected?.availableForReview,sourceObservations:facts.size}));
