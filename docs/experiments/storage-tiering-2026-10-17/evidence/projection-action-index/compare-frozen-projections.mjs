/** Run from repository root. All SQLite constructors target one exclusive copy. */
import {copyFileSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir,cpus} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {deepStrictEqual} from 'node:assert';
const root=process.cwd(),out=fileURLToPath(new URL('.',import.meta.url)),frozen=join(root,'.data/okx-storage-acceptance-20261017-v1-frozen-4');
const digest=data=>createHash('sha256').update(data).digest('hex');
const sourceFiles=['packages/explorer-plugin/src/observation-action-index.ts','packages/explorer-plugin/src/obligation-lifecycle.ts','packages/explorer-plugin/src/policy.ts','packages/core/src/engine.ts','packages/storage-sqlite/src/index.ts','tests/explorer-observation-action-index.test.ts'];
const sourceHashes=()=>Object.fromEntries(sourceFiles.map(path=>[path,digest(readFileSync(join(root,path)))]));
const sourceSha256=sourceHashes(),databaseSha256=digest(readFileSync(join(frozen,'engine/engine.sqlite')));
const baselineSource=join(out,'baseline-before-index.ts'),baselineSha256=digest(readFileSync(baselineSource));
const {SqliteStore}=await import(pathToFileURL(join(root,'packages/storage-sqlite/src/index.ts')).href);
const {BrowserEngine,BrowserAdapter}=await import(pathToFileURL(join(root,'packages/browser/src/index.ts')).href);
const {projectObligations:oldProject}=await import(pathToFileURL(baselineSource).href);
const {projectObligations:newProject}=await import(pathToFileURL(join(root,'packages/explorer-plugin/src/obligation-lifecycle.ts')).href);
const directory=mkdtempSync(join(tmpdir(),'okx-projection-action-index-'));
copyFileSync(join(frozen,'engine/engine.sqlite'),join(directory,'engine.sqlite'));
const taskPath=join(frozen,'runs/5f350d86-b9dd-43e5-ac07-43a79a9e30f0/task-after.json'),taskBytes=readFileSync(taskPath),task=JSON.parse(taskBytes);
let driverStarts=0;BrowserAdapter.prototype.start=async function(){driverStarts++;throw Error('Offline projection probe forbids driver start');};
const store=new SqliteStore(directory);let counters={},active=false;
for(const method of ['get','list','listByObservation']){
 const original=store[method].bind(store);store[method]=(...args)=>{const t=performance.now(),value=original(...args);if(active){const key=method+':'+args[0],entry=counters[key]??={calls:0,rows:0,elapsedMs:0};entry.calls++;entry.rows+=Array.isArray(value)?value.length:value?1:0;entry.elapsedMs+=performance.now()-t;}return value;};
}
const host=new BrowserEngine({persistence:store}),correspondences=host.explorationTargetCorrespondences.bind(host);
host.explorationTargetCorrespondences=(...args)=>{const t=performance.now(),value=correspondences(...args);if(active){const entry=counters['api:explorationTargetCorrespondences']??={calls:0,rows:0,elapsedMs:0};entry.calls++;entry.rows+=args[1].requests.length;entry.elapsedMs+=performance.now()-t;}return value;};
const sid=task.rounds.at(-1).sessionId,frames=[
 {name:'post-region-review-before-scroll',id:'5f80a3df-8355-444a-8499-4a625cb89577'},
 {name:'pre-24h',id:'d0b567f7-791f-49b5-9a0d-80a6cd81ed35'},
 {name:'final-unverified-recovery',id:'c4fae20b-a313-48bb-a1f6-22f793550193'}];
const results=[],comparisons=[];let equalities=0;
try{
 for(const frame of frames){
  store.put('session',{...host.session(sid),currentObservationId:frame.id});
  const o=host.observation(sid),snapshot=host.explorationSnapshot(sid,o.id,{includeHistoryAudit:false}),current=snapshot.operationCandidates;
  const beforeEvents=store.events(sid,0,1000000).length,beforeChanges=store.db.prepare('SELECT total_changes() AS n').get().n,taskBefore=JSON.stringify(task);
  let canonical;
  for(let pass=1;pass<=3;pass++){
   const outputs={};
   for(const variant of pass%2?['old','new']:['new','old']){
    counters={};active=true;const started=performance.now(),cpu=process.cpuUsage();
    const value=(variant==='old'?oldProject:newProject)(host,task,o,current,task.obligations);
    const elapsedMs=performance.now()-started,cpuUs=process.cpuUsage(cpu);active=false;
    const text=JSON.stringify(value),sha256=digest(text);outputs[variant]=value;
    results.push({frame:frame.name,observationId:frame.id,pass,variant,elapsedMs,cpuUs,resultSha256:sha256,resultBytes:Buffer.byteLength(text),counts:value.projection.counts,reads:counters});
    if(canonical===undefined){canonical=value;writeFileSync(join(out,`${frame.name}-result.json.gz`),gzipSync(text+'\n',{mtime:0}));}else deepStrictEqual(value,canonical,'Repeated same-frame output changed');
   }
   deepStrictEqual(outputs.new,outputs.old,`Old/new projection/events differ on ${frame.id} pass ${pass}`);equalities++;
  }
  const afterEvents=store.events(sid,0,1000000).length,afterChanges=store.db.prepare('SELECT total_changes() AS n').get().n;
  deepStrictEqual(afterEvents,beforeEvents);deepStrictEqual(afterChanges,beforeChanges);deepStrictEqual(JSON.stringify(task),taskBefore);
  comparisons.push({...frame,sessionId:sid,controls:o.controls.length,actions:snapshot.actions.length,operationCandidates:current.length,criticalGaps:o.gaps.filter(g=>g.critical).map(g=>g.code),eventsBefore:beforeEvents,eventsAfter:afterEvents,totalChangesBefore:beforeChanges,totalChangesAfter:afterChanges,taskUnchanged:true});
 }
 deepStrictEqual(sourceHashes(),sourceSha256,'Frozen source changed during probe');
 deepStrictEqual(digest(readFileSync(join(frozen,'engine/engine.sqlite'))),databaseSha256,'Frozen database bytes changed');
 const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 const summary=comparisons.map(frame=>{const times=Object.fromEntries(['old','new'].map(variant=>[variant,results.filter(r=>r.frame===frame.name&&r.variant===variant).map(r=>r.elapsedMs)]));return {frame:frame.name,timesMs:times,medianOldMs:median(times.old),medianNewMs:median(times.new),medianRatio:median(times.new)/median(times.old)};});
 const report={directory,node:process.version,cpu:cpus()[0]?.model,cpuCount:cpus().length,sourceSha256,baselineSha256,databaseSha256,taskSha256:digest(taskBytes),taskPlanCount:task.plan.length,driverStarts,equalities,comparisons,summary,limitations:['Three alternating old/new calls per frame in one process; diagnostic timings only, not whole-cycle speedup or a macro benchmark.','Each frame uses the same final 539-row task. Old/new are compared within that frame, never across time frames; this is not a historical task replay.','A dedicated agent CPU window was requested; unrelated operating-system activity and small tests elsewhere are not fully controlled.','Store wrappers count returned decoded API rows, not physical I/O. SDK correspondence calls/requests are counted unchanged.','Only the isolated copy receives constructor recovery/current-observation writes. Timed projections cause zero SQL writes/events and do not mutate task data.'],results};
 writeFileSync(join(out,'comparison.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({directory,driverStarts,equalities,comparisons,summary},null,2));
}catch(error){writeFileSync(join(out,'comparison-failed.json'),JSON.stringify({message:error.message,stack:error.stack,driverStarts,results},null,2)+'\n');throw error;}
finally{await host.close();}
