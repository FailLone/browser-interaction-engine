import {copyFileSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
const root=process.cwd(),out=fileURLToPath(new URL('.',import.meta.url));
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {deepStrictEqual} from 'node:assert';
const {SqliteStore}=await import(pathToFileURL(join(root,'packages/storage-sqlite/src/index.ts')).href);
const {BrowserEngine,BrowserAdapter}=await import(pathToFileURL(join(root,'packages/browser/src/index.ts')).href);
const {completedOperations}=await import(pathToFileURL(join(root,'packages/explorer-plugin/src/completion-evidence.ts')).href);
const {projectObligations}=await import(pathToFileURL(join(root,'packages/explorer-plugin/src/obligation-lifecycle.ts')).href);
const {reviewGapChanges}=await import(pathToFileURL(join(root,'packages/explorer-plugin/src/review-ledger.ts')).href);
const {reviewRecoveryChanges}=await import(pathToFileURL(join(root,'packages/explorer-plugin/src/review-recovery.ts')).href);
const frozen=root+'/.data/okx-storage-acceptance-20261017-v1-frozen-4',directory=mkdtempSync(join(tmpdir(),'okx-run4-action-query-'));
const serialize=value=>JSON.stringify(value,(_key,v)=>v instanceof Set?{$set:[...v]}:v);
copyFileSync(frozen+'/engine/engine.sqlite',directory+'/engine.sqlite');
const task=JSON.parse(readFileSync(frozen+'/runs/5f350d86-b9dd-43e5-ac07-43a79a9e30f0/task-after.json','utf8'));
let driverStarts=0;BrowserAdapter.prototype.start=async function(){driverStarts++;throw Error('Offline probe forbids driver start');};
const openStart=performance.now(),store=new SqliteStore(directory),openMs=performance.now()-openStart;
const index=store.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='entities_action_observation'").get().sql;
store.db.exec('DROP INDEX entities_action_observation');const buildStart=performance.now();store.db.exec(index);const indexBuildMs=performance.now()-buildStart;
let counters={},active=false;
for(const method of ['get','list','listByObservation']){const original=store[method].bind(store);store[method]=(...args)=>{const t=performance.now();const value=original(...args);if(active){const key=method+':'+args[0],v=counters[key]??={calls:0,rows:0,elapsedMs:0};v.calls++;v.rows+=Array.isArray(value)?value.length:value?1:0;v.elapsedMs+=performance.now()-t;}return value;};}
const host=new BrowserEngine({persistence:store}),scoped=host.store.listByObservation;
const sid=task.rounds.at(-1).sessionId,oid='d0b567f7-791f-49b5-9a0d-80a6cd81ed35';
store.put('session',{...host.session(sid),currentObservationId:oid});
const o=host.observation(sid),actions=host.actions(sid),eventsBefore=store.events(sid,0,1000000).length;
const results=[],baseline=new Map();let equalities=0;
function measure(mode,pass,name,fn){
 counters={};active=true;const started=performance.now();const value=fn();const elapsedMs=performance.now()-started;active=false;
 const data=serialize(value),digest=createHash('sha256').update(data).digest('hex');
 if(mode==='fallback'){baseline.set(name,value);writeFileSync(join(out,'query-baseline-values',`${name}-baseline.json.gz`),gzipSync(data+'\n',{mtime:0}));}
 else {deepStrictEqual(value,baseline.get(name),`${name}: complete indexed/fallback result mismatch`);equalities++;}
 results.push({mode,pass,name,elapsedMs,sha256:digest,bytes:Buffer.byteLength(data),reads:counters});return value;
}
try{
 for(let pass=0;pass<2;pass++)for(const mode of ['fallback','indexed']){
  host.store.listByObservation=mode==='indexed'?scoped:undefined;
  measure(mode,pass,'actions',()=>host.actions(sid));
  measure(mode,pass,'interpretation',()=>host.controlInterpretationSnapshot(sid,o.id));
  measure(mode,pass,'availability',()=>host.actionAvailability(sid,o.id));
  const snapshot=measure(mode,pass,'snapshot-current',()=>host.explorationSnapshot(sid,o.id,{includeHistoryAudit:false}));
  measure(mode,pass,'review-ledger',()=>reviewGapChanges(task,o,host));
  measure(mode,pass,'completed',()=>completedOperations(host,task,o,[...actions,...snapshot.operationCandidates]));
  measure(mode,pass,'obligation-projection',()=>projectObligations(host,task,o,snapshot.operationCandidates,task.obligations));
  measure(mode,pass,'review-recovery-checkpoint',()=>reviewRecoveryChanges(task,o,host,{checkpointId:'offline-profile-only'}));
 }
 const eventsAfter=store.events(sid,0,1000000).length;deepStrictEqual(eventsAfter,eventsBefore);
 const sourceFiles=['packages/core/src/ports.ts','packages/core/src/engine.ts','packages/storage-sqlite/src/index.ts','packages/storage-memory/src/index.ts','packages/storage-retained/src/index.ts','tests/action-observation-query.test.ts'];
 const sourceSha256=Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')]));
 const report={sourceCommit:'868e8b47afd31782161deba4f8bd7a14e0349430 plus uncommitted scoped-query patch',sourceSha256,directory,sourceObservationId:oid,taskPlanCount:task.plan.length,controls:o.controls.length,currentActions:actions.length,openMs,indexBuildMs,equalities,eventsBefore,eventsAfter,driverStarts,limitations:['Same current implementation, optional query disabled/enabled; all eight complete results compared with deepStrictEqual twice.','Final 539-row task against pre-24h observation, not the exact historic task state.','Two calls per API per mode, not statistical benchmark. API decoded-row counts, not physical I/O.','Index build measured once by dropping/recreating only the new index on an exclusive copy; no original/frozen writes.'],results};
 writeFileSync(join(out,'okx-run4-action-query-comparison.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({directory,openMs,indexBuildMs,equalities,eventsBefore,eventsAfter,driverStarts,results:results.map(r=>({name:r.name,mode:r.mode,pass:r.pass,elapsedMs:r.elapsedMs,actionReads:Object.fromEntries(Object.entries(r.reads).filter(([k])=>k.endsWith(':action')))}))},null,2));
}finally{await host.close();}
