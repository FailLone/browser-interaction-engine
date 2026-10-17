import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
// Run only with a complete, owned copy: argv[2] is repository root; argv[3]
// contains frozen-copy/ and receives JSON outputs. No live/frozen DB constructor.
const root=process.argv[2],dir=process.argv[3];
assert(root&&dir,'Expected repository root and owned private directory');
assert(!dir.includes('/.data/'),'Do not read a frozen/original task DB through this script');
const load=(name)=>JSON.parse(readFileSync(root+'/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-7/'+name,'utf8'));
const imp=(p)=>import(pathToFileURL(root+'/'+p).href);
const {SqliteStore}=await imp('packages/storage-sqlite/src/index.ts');
const {ObservationObjectStore}=await imp('packages/storage-sqlite/src/observation-store.ts');
const {controlInScope,matches,scopeFor}=await imp('packages/explorer-plugin/src/policy.ts');
const {currentHistoryAnchor}=await imp('packages/explorer-plugin/src/review-recovery.ts');
const {sourceReturnCondition}=await imp('packages/explorer-plugin/src/source-return.ts');
const {browserTargetConditions}=await imp('packages/adapter-playwright/src/target-arrival.ts');
const {browserBranchConditions}=await imp('packages/adapter-playwright/src/branch-conditions.ts');
const require=createRequire(root+'/packages/storage-sqlite/package.json'),Database=require('better-sqlite3');
const db=new Database(dir+'/frozen-copy/engine/engine.sqlite',{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
const storage=Object.create(SqliteStore.prototype);storage.db=db;storage.observations=new ObservationObjectStore(db,()=>{throw Error('FORBIDDEN_WRITE');});
const facts=load('facts.json'),task=load('run/task-after.json'),failed=facts.recoveries[1],sid=failed.result.sessionId;
const obs=(id)=>storage.require('observation',id),actions=(o)=>storage.listByObservation('action',sid,o.id),allAttempts=storage.list('attempt',sid),allCp=storage.list('checkpoint',sid);
const selectedItem=task.plan.find(i=>i.id===failed.selection.itemId),cp=storage.require('checkpoint',failed.result.checkpointId),source=obs(cp.observationId),current=obs(failed.selection.currentObservationId),after=obs(failed.result.observationId),session=storage.require('session',sid);
function smallControl(c,o){return Object.fromEntries(['localId','identityId','hypothesisId','instanceId','identityScope','name','label','tag','role','visible','enabled','actions','checked','expanded','stableKey','identityContext','structuralItem','reviewBinding'].map(k=>[k,c[k]]).concat([['regionLabel',o.regions.find(r=>r.key===c.region)?.label]]));}
function small(o){const aa=actions(o);return {id:o.id,url:o.url,capturedAt:o.capturedAt,instanceScope:o.instanceScope,documentId:o.documentId,stateId:o.stateId,stable:o.stable,gaps:o.gaps,context:o.context,ruleVersion:o.ruleVersion,navigation:o.navigation,boundaries:o.boundaries,
 matchControls:o.controls.filter(c=>controlInScope(selectedItem.scope,c,o,aa)).map(c=>smallControl(c,o)),matchActions:aa.filter(a=>matches(selectedItem.scope,a,o)).map(a=>({id:a.id,localId:a.localId,kind:a.kind,label:a.label,risk:a.risk,basis:a.basis,replayable:a.replayable,excluded:a.excluded,preconditions:a.preconditions})),
 historyAnchor:currentHistoryAnchor(o,current),sourceReturnCondition:sourceReturnCondition(o,current)};}
const cpReports=[];
for(const checkpoint of allCp){const o=obs(checkpoint.observationId),aa=actions(o),cc=o.controls.filter(c=>controlInScope(selectedItem.scope,c,o,aa));
 cpReports.push({id:checkpoint.id,observationId:o.id,at:checkpoint.createdAt,sourceAt:o.capturedAt,url:o.url,historyAnchor:currentHistoryAnchor(o,current),sourceReturnCondition:sourceReturnCondition(o,current),nativeEntry:o.navigation?.entries[o.navigation.currentIndex],browserSessionId:o.navigation?.browserSessionId,instanceScope:o.instanceScope,stable:o.stable,criticalGaps:o.gaps.filter(g=>g.critical),path:checkpoint.path,
 nonreplayable:checkpoint.path.map(id=>allAttempts.find(a=>a.id===id)).filter(a=>!a?.action.replayable).map(a=>({id:a?.id,kind:a?.action.kind,label:a?.action.label,source:a?.action.source,replayable:a?.action.replayable})),matches:cc.map(c=>smallControl(c,o))});}
const trace=cp.path.map(id=>{const a=allAttempts.find(x=>x.id===id);assert(a);return {id,status:a.status,startedAt:a.startedAt,finishedAt:a.finishedAt,beforeId:a.beforeId,afterId:a.afterId,purpose:a.purpose,action:a.action};});
const progress=load('run/summary.json').unkeyedSuccessfulAttempts.map(row=>{const a=allAttempts.find(x=>x.id===row.attemptId),o=obs(a.beforeId);return {attempt:a,before:o,branch:browserBranchConditions(a.action,o),targetConditions:browserTargetConditions(a.action,o)};});
const events=db.prepare('SELECT sequence,type,at,json FROM events WHERE session_id=? AND sequence>(SELECT COALESCE(MAX(sequence),0)-100 FROM events WHERE session_id=?) ORDER BY sequence').all(sid,sid).map(e=>({...e,json:JSON.parse(e.json)}));
const report={sourceRevision:'106a1cdfddfe3e73cab9e01b28ba4dd8439653e2',privateCopy:dir+'/frozen-copy',readOnly:true,totalChanges:db.prepare('SELECT total_changes() AS n').get().n,selectedItem,checkpoint:cp,path:trace,session:{id:session.id,options:session.options,dirty:session.dirty,actionCount:session.actionCount},source:small(source),current:small(current),after:small(after),checkpoints:cpReports,events,unkeyed:progress.map(({attempt:a,before:o,branch,targetConditions})=>({id:a.id,kind:a.action.kind,label:a.action.label,value:a.action.value,replayable:a.action.replayable,beforeId:o.id,branch:!!branch,targetConditions:!!targetConditions})),route:task.scheduling.routes[failed.selection.routeKey],routeDebt:task.routeRetries.routes[failed.selection.routeKey]};
writeFileSync(dir+'/diagnosis.json',JSON.stringify(report,null,2));writeFileSync(dir+'/unkeyed-frames.json',JSON.stringify(progress));
writeFileSync(dir+'/recovery-frames.json',JSON.stringify({source,current,after}));db.close();
console.log(JSON.stringify({selectedItem:report.selectedItem,checkpoint:cp,path:trace.map(a=>({id:a.id,kind:a.action.kind,label:a.action.label,replayable:a.action.replayable,source:a.action.source,at:a.startedAt})),source:report.source,current:report.current,after:report.after,checkpoints:cpReports.map(({matches,...r})=>({...r,matches:matches.map(c=>({localId:c.localId,name:c.name,visible:c.visible,hypothesisId:c.hypothesisId,identityScope:c.identityScope}))})),unkeyed:report.unkeyed,totalChanges:report.totalChanges},null,2));
