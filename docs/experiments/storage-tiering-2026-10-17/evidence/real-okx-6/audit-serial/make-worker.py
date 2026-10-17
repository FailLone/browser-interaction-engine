from pathlib import Path
import hashlib,json
root=Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine')
p=root/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/full-audit-counterfactual-indexed.ts'
s=p.read_text()
run=s[s.index('async function run('):s.index('\ntry{\n const originalPathBaseline')]
oracle=run[run.index('  const added='):run.index('  const report=')]
header='''/** Independent-process fixed-input CPU counterfactual. No SDK, database or browser construction. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import {performance} from 'node:perf_hooks';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const fileHash=(file:string)=>hash(readFileSync(file));
const jsonHash=(x:unknown)=>hash(JSON.stringify(x));
const bytes=(x:unknown)=>Buffer.byteLength(JSON.stringify(x));
const stageStart=performance.now();
assert.equal(fileHash(config.material),config.materialSha256);
const m=JSON.parse(readFileSync(config.material,'utf8'));
const materialLoadMs=performance.now()-stageStart;
const currentId='c11abe9e-e2a4-44f2-bf53-64ebf22a1dd2',o=m.observations[currentId],actions=m.actions[currentId];
const audit=m.events.find((e:any)=>e.type==='scope.audit'&&e.data.observationId===currentId),pending=new Set(audit.data.pendingActions),identityIds=new Set(audit.data.obligations.identities);
const snapshot={actions,availability:{observationId:o.id,actions:audit.data.operationFacts},operationCandidates:actions.filter((a:any)=>pending.has(a.id)),revision:audit.data.revision,
 obligations:{...audit.data.obligations,identities:o.controls.filter((c:any)=>identityIds.has(c.hypothesisId)).map((c:any)=>({id:c.hypothesisId,localId:c.localId}))}};
assert.equal(actions.length,206);assert.equal(snapshot.operationCandidates.length,204);assert.equal(snapshot.obligations.identities.length,identityIds.size);
const inputs={taskBefore:jsonHash(m.before),currentObservation:jsonHash(o),allActions:jsonHash(actions),scopeAuditEvent:jsonHash(audit),snapshot:jsonHash(snapshot),materialSha256:config.materialSha256};
assert.deepEqual(inputs,config.expectedInputs,'fixed input differs from original indexed counterfactual');
const reconciled=m.events.find((e:any)=>e.type==='recovery.position_reconciled'&&e.data.position?.observationId===currentId);assert(reconciled);assert.deepEqual(reconciled.data.path,[]);assert.equal(reconciled.sequence,2952);
const beforeIds=new Set(m.before.plan.map((i:any)=>i.id)),realNewGaps=m.after.plan.filter((i:any)=>!beforeIds.has(i.id)&&i.status==='unresolved');assert.equal(realNewGaps.length,174);assert(realNewGaps.every((i:any)=>JSON.stringify(i.prerequisites)==='[]'));
const counter=(calls:any[])=>({counts:Object.fromEntries(['observation','actions','list','interactionTransition','forbidden'].map(name=>[name,calls.filter(c=>c.name===name).length])),uniqueObservationIds:[...new Set(calls.filter(c=>c.name==='observation').map(c=>c.id))],uniqueActionObservationIds:[...new Set(calls.filter(c=>c.name==='actions').map(c=>c.id))]});
function countBy(rows:any[],field:string){return rows.reduce((r:any,i:any)=>(r[i[field]]=(r[i[field]]||0)+1,r),{});}
let networkCalls=0;const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{networkCalls++;throw Error('FORBIDDEN_NETWORK');};
const importStart=performance.now();
const {ExplorerPlugin:Plugin}=await import(pathToFileURL(join(config.sourceRoot,'packages/explorer-plugin/src/runtime.ts')).href);
const moduleImportMs=performance.now()-importStart;
const cpuMs=(usage:NodeJS.CpuUsage)=>({user:usage.user/1000,system:usage.system/1000,total:(usage.user+usage.system)/1000});
const returnedBytes=(rows:any[])=>({total:rows.reduce((n,row)=>n+bytes(row.value),0),byMethod:Object.fromEntries(['observation','actions','list'].map(name=>[name,rows.filter(row=>row.name===name).reduce((n,row)=>n+bytes(row.value),0)])),note:'Logical JSON byte length of returned references; memory host performs no JSON/SQLite decoding. Calculated outside measured phases.'});
'''
# Keep the complete original audit and integrity oracle; instrumentation only surrounds it.
run=run.replace('saves:any[]=[];', 'saves:any[]=[],returns:any[]=[];')
run=run.replace('assert(value&&value.sessionId===sid);return value;',"assert(value&&value.sessionId===sid);returns.push({name:'observation',value});return value;")
run=run.replace("return m.actions[id||currentId]||[];", "const value=m.actions[id||currentId]||[];returns.push({name:'actions',value});return value;")
run=run.replace("return m.attempts.filter((a:any)=>a.sessionId===sid);", "const value=m.attempts.filter((a:any)=>a.sessionId===sid);returns.push({name:'list',value});return value;")
run=run.replace('const plugin=new Plugin(host,sink,{}),start=performance.now();','const constructorStart=performance.now(),plugin=new Plugin(host,sink,{}),constructorMs=performance.now()-constructorStart;')
run=run.replace('let normalizationMs=0,normalizedBefore=0,normalizationReads:any;', 'let normalizationMs=0,normalizedBefore=0,normalizationReads:any,normalizationCpu={user:0,system:0,total:0};')
run=run.replace('if(normalize){const t=performance.now();', 'if(normalize){const cpuStart=process.cpuUsage(),t=performance.now();')
run=run.replace('normalizationMs=performance.now()-t;normalizedBefore=', 'normalizationMs=performance.now()-t;normalizationCpu=cpuMs(process.cpuUsage(cpuStart));normalizedBefore=')
run=run.replace('const preAuditReads=calls.length,afterNormalizationBytes=', 'const preAuditReads=calls.length,preAuditReturns=returns.length,afterNormalizationBytes=')
run=run.replace('const t=performance.now(),incomplete=', 'const auditCpuStart=process.cpuUsage(),t=performance.now(),incomplete=')
run=run.replace('auditMs=performance.now()-t;', 'auditMs=performance.now()-t,auditCpu=cpuMs(process.cpuUsage(auditCpuStart));')
run=run.replace('mixedElapsedMsNotBenchmark:{normalization:normalizationMs,audit:auditMs,total:performance.now()-start}', 'phaseTimingsMs:{constructor:constructorMs,startupNormalization:normalizationMs,audit:auditMs,normalizationPlusAudit:normalizationMs+auditMs},phaseCpuMs:{startupNormalization:normalizationCpu,audit:auditCpu},logicalReturnedJsonBytes:{startupNormalization:returnedBytes(returns.slice(0,preAuditReturns)),audit:returnedBytes(returns.slice(preAuditReturns))},saveCalls:saves.length,process:{pid:process.pid,version:process.version,resourceUsage:process.resourceUsage(),memoryUsage:process.memoryUsage()}')
assert run[run.index('  const added='):run.index('  const report=')]==oracle
footer='''
try{
 const report=await run(config.variant,Plugin,config.normalize,true);
 assert.equal(report.inputTaskSha256,config.expectedReconciledTaskSha256);
 assert.equal(report.pendingActions.recorded,204);assert.equal(report.pendingActions.emitted,204);assert.deepEqual(report.pendingActions.omitted,[]);
 assert.equal(networkCalls,0);
 assert.equal(jsonHash(m.before),inputs.taskBefore);assert.equal(jsonHash(o),inputs.currentObservation);assert.equal(jsonHash(actions),inputs.allActions);assert.equal(jsonHash(audit),inputs.scopeAuditEvent);assert.equal(jsonHash(snapshot),inputs.snapshot);
 const artifact={protocol:'run6-serial-full-audit-cpu-v1',revision:config.revision,variant:config.variant,sourceRoot:realpathSync(config.sourceRoot),inputs,recordedReconciliation:{sequence:reconciled.sequence,path:reconciled.data.path,position:reconciled.data.position},setupTimingsMs:{materialHashReadAndParse:materialLoadMs,moduleImport:moduleImportMs},report,safety:{sdkConstructors:0,browserCalls:0,providerCalls:0,networkCalls,originalOrFrozenDBOpened:0},limits:['Full methods use recording memory host and sink. No SQLite, capture, network, model, complete task resume or end-to-end run is measured.','Only the recorded path and position are restored to task-before. Other live preaudit state is not reconstructed.','Same explicit empty completed set as the original oracle; all recorded 204 pending candidates and 206 actions remain.','JSON bytes are logical serialization, not physical storage or bytes actually read from a database.','The retained fixture has its original unknown debt only; no synthetic unknown scenarios are added.','Fresh process first-call measurements include each version actual initialization/JIT behavior; they are not warmed steady-state measurements.']};
 writeFileSync(config.output,JSON.stringify(artifact,null,2)+'\\n');console.log(JSON.stringify({variant:config.variant,revision:config.revision,inputTask:report.inputTaskSha256,newRows:report.newRows,phases:report.phaseTimingsMs,bytes:report.bytes,calls:report.totalReads.counts}));
}finally{globalThis.fetch=oldFetch;}
'''
worker=header+run+footer
out=Path('/tmp/bie-run6-audit-serial-prep');(out/'worker.ts').write_text(worker)
(out/'oracle-equivalence.json').write_text(json.dumps({'originalScript':str(p),'originalScriptSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'workerSha256':hashlib.sha256(worker.encode()).hexdigest(),'originalOracleSha256':hashlib.sha256(oracle.encode()).hexdigest(),'workerOracleSha256':hashlib.sha256(run[run.index('  const added='):run.index('  const report=')].encode()).hexdigest(),'oracleByteIdentical':True,'oracleContains':['all retained old fields and attempts/statuses/results','all old exact source refs','rounds and entry path','routeRetries and scheduling debt','one scope.audit with exact recorded obligations'],'workerAddsAssertions':['204 emitted; 0 omitted','input task reconciliation hash','unchanged original input task/observation/actions/audit/snapshot','zero forbidden host/network'],'changes':'Per-process version, only recorded empty path; measurement instrumentation and logical-byte counters outside phase clocks.'},indent=2)+'\n')
