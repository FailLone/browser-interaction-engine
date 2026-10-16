import {copyFileSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {SqliteStore} from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/storage-sqlite/src/index.ts';
import {BrowserEngine,BrowserAdapter} from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/browser/src/index.ts';
import {completedOperations} from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/completion-evidence.ts';
import {projectObligations} from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/obligation-lifecycle.ts';
import {reviewGapChanges} from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/review-ledger.ts';
import {reviewRecoveryChanges} from '/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/packages/explorer-plugin/src/review-recovery.ts';
const root='/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine',frozen=root+'/.data/okx-storage-acceptance-20261017-v1-frozen-4',directory=mkdtempSync(join(tmpdir(),'okx-run4-profile-'));
copyFileSync(frozen+'/engine/engine.sqlite',directory+'/engine.sqlite');
const task=JSON.parse(readFileSync(frozen+'/runs/5f350d86-b9dd-43e5-ac07-43a79a9e30f0/task-after.json','utf8'));
let driverStarts=0;BrowserAdapter.prototype.start=async function(){driverStarts++;throw Error('Offline probe forbids driver start');};
const store=new SqliteStore(directory);
let counters={},active=false;
for(const method of ['get','list']){const original=store[method].bind(store);store[method]=(...args)=>{const t=performance.now();const value=original(...args);if(active){const key=method+':'+args[0],v=counters[key]??={calls:0,rows:0,elapsedMs:0};v.calls++;v.rows+=Array.isArray(value)?value.length:value?1:0;v.elapsedMs+=performance.now()-t;}return value;};}
const host=new BrowserEngine({persistence:store});
const sid=task.rounds.at(-1).sessionId,oid='d0b567f7-791f-49b5-9a0d-80a6cd81ed35';
store.put('session',{...host.session(sid),currentObservationId:oid});
const o=host.observation(sid),actions=host.actions(sid);
const results=[];
const summarize=v=>v instanceof Set?{size:v.size}:Array.isArray(v)?{length:v.length}:v?.projection?{counts:v.projection.counts}:v?.actions?{actions:v.actions.length,operationCandidates:v.operationCandidates?.length}:v?.operations?{controls:v.operations.controls.length}:{};
function measure(name,fn){counters={};active=true;const started=performance.now();const value=fn();const elapsedMs=performance.now()-started;active=false;results.push({name,elapsedMs,output:summarize(value),reads:Object.fromEntries(Object.entries(counters).sort((a,b)=>b[1].elapsedMs-a[1].elapsedMs))});return value;}
try{
 for(let pass=0;pass<2;pass++){
  measure(`actions-${pass}`,()=>host.actions(sid));
  measure(`interpretation-${pass}`,()=>host.controlInterpretationSnapshot(sid,o.id));
  measure(`availability-${pass}`,()=>host.actionAvailability(sid,o.id));
  const snapshot=measure(`snapshot-current-${pass}`,()=>host.explorationSnapshot(sid,o.id,{includeHistoryAudit:false}));
  measure(`review-ledger-${pass}`,()=>reviewGapChanges(task,o,host));
  measure(`completed-${pass}`,()=>completedOperations(host,task,o,[...actions,...snapshot.operationCandidates]));
  measure(`obligation-projection-${pass}`,()=>projectObligations(host,task,o,snapshot.operationCandidates,task.obligations));
  measure(`review-recovery-checkpoint-${pass}`,()=>reviewRecoveryChanges(task,o,host,{checkpointId:'offline-profile-only'}));
 }
 const result={sourceCommit:'868e8b47afd31782161deba4f8bd7a14e0349430',directory,sourceObservationId:oid,taskPlanCount:task.plan.length,controls:o.controls.length,currentActions:actions.length,limitations:['Final task plan projected against the pre-24h observation; not a replay of the historic task snapshot.','Two sequential calls per probe, not a statistical benchmark; timers include only in-process synchronous wall time.','Read wrappers count API rows, not physical I/O or peak memory; no browser or provider is run.'],driverStarts,results};
 writeFileSync('/tmp/okx-run4-offline-profile.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({driverStarts,directory,results:results.map(({name,elapsedMs,output,reads})=>({name,elapsedMs,output,topReads:Object.entries(reads).slice(0,3)}))},null,2));
}finally{await host.close();}
