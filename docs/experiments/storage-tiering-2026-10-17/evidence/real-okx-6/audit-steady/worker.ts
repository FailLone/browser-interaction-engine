/** Independent-process fixed-input CPU counterfactual. No SDK, database or browser construction. */
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
async function run(Plugin:any,normalize:boolean){
 const task=structuredClone(m.before);task.rounds.at(-1).entryPath=structuredClone(reconciled.data.path);task.rounds.at(-1).position=structuredClone(reconciled.data.position);
 const initial=structuredClone(task),allCalls:any[]=[],allEvents:any[]=[],allReturns:any[]=[],allSaves:any[]=[],phases:any[]=[];
 const allowed:any={events:new EventEmitter(),observation:(sid:string,id?:string)=>{allCalls.push({name:'observation',id:id||currentId,implicit:!id});const value=m.observations[id||currentId];assert(value&&value.sessionId===sid);allReturns.push({name:'observation',value});return value;},actions:(sid:string,id?:string)=>{allCalls.push({name:'actions',id:id||currentId});assert.equal(m.observations[id||currentId].sessionId,sid);const value=m.actions[id||currentId]||[];allReturns.push({name:'actions',value});return value;},list:(sid:string,kind:string)=>{allCalls.push({name:'list',sid,kind});assert.equal(kind,'attempt');const value=m.attempts.filter((a:any)=>a.sessionId===sid);allReturns.push({name:'list',value});return value;}};
 const host=new Proxy(allowed,{get(target,key){if(key in target)return target[key];return (...args:any[])=>{allCalls.push({name:'forbidden',method:String(key),args});throw Error(`FORBIDDEN_HOST:${String(key)}`);};}});

 const sink:any={save:(t:any)=>allSaves.push({rows:t.plan.length}),event:(e:any)=>{allEvents.push(structuredClone(e));return e;},close:()=>{}};
 const constructorStart=performance.now(),plugin=new Plugin(host,sink,{}),constructorMs=performance.now()-constructorStart;
 let normalizationMs=0,normalizedBefore=0,normalizationReads:any,normalizationCpu={user:0,system:0,total:0};
 try{
  if(normalize){const cpuStart=process.cpuUsage(),t=performance.now();plugin.normalizeScheduling(task,task.plan,plugin.normalizationReader());normalizationMs=performance.now()-t;normalizationCpu=cpuMs(process.cpuUsage(cpuStart));normalizedBefore=task.plan.filter((i:any)=>i.operationSchedulingNormalization).length;}
  let callOffset=0,eventOffset=0,returnOffset=0,saveOffset=0;
  for(let phase=1;phase<=3;phase++){
   const original=phase===1?initial:structuredClone(task),oldIds=new Set(original.plan.map((i:any)=>i.id));
   normalizationReads=counter(allCalls.slice(callOffset));
   const preAuditReads=allCalls.length-callOffset,preAuditReturns=allReturns.length-returnOffset,preAuditEvents=allEvents.length-eventOffset,afterNormalizationBytes={task:bytes(task),plan:bytes(task.plan),auditBytes:task.plan.reduce((n:number,i:any)=>n+(i.operationSchedulingNormalization?bytes(i.operationSchedulingNormalization):0),0)};
   const auditCpuStart=process.cpuUsage(),t=performance.now(),incomplete=plugin.auditRemainingScopes(task,task.rounds.at(-1),o,snapshot,new Set()),auditMs=performance.now()-t,auditCpu=cpuMs(process.cpuUsage(auditCpuStart));
   const calls=allCalls.slice(callOffset),events=allEvents.slice(eventOffset),returns=allReturns.slice(returnOffset),saves=allSaves.slice(saveOffset),name=config.variant+'-audit-'+phase,restoreRecordedPath=true;
  const added=task.plan.filter((i:any)=>!oldIds.has(i.id)),changedOld:any[]=[];
  for(const before of original.plan){const after=task.plan.find((i:any)=>i.id===before.id);assert(after,'old row removed');const fields=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k]));if(fields.length)changedOld.push({itemId:before.id,reason:before.reason,label:before.scope.label,fields,sourceAdded:after.evidence.filter((e:any)=>!before.evidence.some((b:any)=>JSON.stringify(b)===JSON.stringify(e)))});
   for(const key of ['id','status','required','dispatchScope','reason','scope','prerequisites','completion','attempts','operationConditionKey','operationConditionPolicy','conditionMigration','conditionLineage','conditionSplit','resolvedBy','reviewResolvedBy','coverageResolvedBy'])assert.deepEqual(after[key],before[key],`old ${before.id} changed ${key}`);
   for(const ref of before.evidence)assert(after.evidence.some((e:any)=>JSON.stringify(e)===JSON.stringify(ref)),'old source lost');
  }
  assert.deepEqual(task.rounds,original.rounds);assert.deepEqual(task.routeRetries,original.routeRetries);assert.deepEqual(task.scheduling,original.scheduling);
  const emittedAudit=events.filter(e=>e.type==='scope.audit');assert.equal(emittedAudit.length,1);assert.deepEqual(emittedAudit[0].data.obligations,audit.data.obligations);
  const report={name,restoreRecordedPath,inputTaskSha256:jsonHash(original),inputTaskRows:original.plan.length,resultTaskRows:task.plan.length,newRows:added.length,newByReason:countBy(added,'reason'),newByStatus:countBy(added,'status'),beforeByStatus:countBy(original.plan,'status'),afterByStatus:countBy(task.plan,'status'),normalizedBefore,normalizationReads,auditReads:counter(calls.slice(preAuditReads)),totalReads:counter(calls),eventCounts:countBy(events,'type'),pendingActions:{recorded:pending.size,emitted:emittedAudit[0].data.pendingActions.length,omitted: [...pending].filter(id=>!emittedAudit[0].data.pendingActions.includes(id))},incomplete:[...incomplete],bytes:{originalTask:bytes(original),originalPlan:bytes(original.plan),afterNormalization:afterNormalizationBytes,finalTask:bytes(task),finalPlan:bytes(task.plan),taskIncrement:bytes(task)-bytes(original),planIncrement:bytes(task.plan)-bytes(original.plan),addedRows:bytes(added),normalizationAuditTotal:task.plan.reduce((n:number,i:any)=>n+(i.operationSchedulingNormalization?bytes(i.operationSchedulingNormalization):0),0),emittedEvents:bytes(events)},oldIntegrity:{allOldRowsPresent:true,allStatusesAttemptsOriginalKeysPrerequisitesAndResultsUnchanged:true,allOldSourcesRetained:true,roundsTriedAndRoutesUnchanged:true},changedOld,addedRows:added.map((i:any)=>({id:i.id,reason:i.reason,status:i.status,scope:i.scope,operationConditionKey:i.operationConditionKey,operationConditionPolicy:i.operationConditionPolicy,prerequisites:i.prerequisites,evidence:i.evidence})),phaseTimingsMs:{constructor:phase===1?constructorMs:0,startupNormalization:normalizationMs,audit:auditMs,normalizationPlusAudit:normalizationMs+auditMs},phaseCpuMs:{startupNormalization:normalizationCpu,audit:auditCpu},logicalReturnedJsonBytes:{startupNormalization:returnedBytes(returns.slice(0,preAuditReturns)),audit:returnedBytes(returns.slice(preAuditReturns))},saveCalls:saves.length,process:{pid:process.pid,version:process.version,resourceUsage:process.resourceUsage(),memoryUsage:process.memoryUsage()}};
   assert.equal(report.totalReads.counts.forbidden,0);
   assert.equal(report.pendingActions.recorded,204);assert.equal(report.pendingActions.emitted,204);assert.deepEqual(report.pendingActions.omitted,[]);
   // Additional carry-forward oracle: original task state is never recreated between audits.
   assert.deepEqual(task.plan.slice(0,original.plan.length).map((i:any)=>i.id),original.plan.map((i:any)=>i.id),'old row order changed');
   assert.deepEqual(task.pendingDispatch,original.pendingDispatch,'pending dispatch changed');
   assert.equal(jsonHash(task.rounds),jsonHash(initial.rounds));assert.equal(jsonHash(task.routeRetries??null),jsonHash(initial.routeRetries??null));assert.equal(jsonHash(task.scheduling??null),jsonHash(initial.scheduling??null));
   if(phase===1)assert.equal(report.inputTaskSha256,config.expectedReconciledTaskSha256);
   else assert.equal(report.inputTaskSha256,phases.at(-1).outputTaskSha256,'task was reset between phases');
   phases.push({...report,phase,startupNormalizationApplied:phase===1&&normalize,outputTaskSha256:jsonHash(task),cumulativeEvents:allEvents.length,cumulativeSaveCalls:allSaves.length,carryForward:{samePlugin:true,sameTaskObject:true,sameSnapshot:true,previousStateHashMatches:true,oldRowOrderUnchanged:true,pendingDispatchUnchanged:true},auditEventCounts:countBy(events.slice(preAuditEvents),'type')});
   callOffset=allCalls.length;eventOffset=allEvents.length;returnOffset=allReturns.length;saveOffset=allSaves.length;normalizationMs=0;normalizationCpu={user:0,system:0,total:0};normalizedBefore=0;
  }
  return phases;
 }finally{await plugin.close();}
}
try{
 const phases=await run(Plugin,config.normalize);
 assert.equal(networkCalls,0);assert.equal(jsonHash(m.before),inputs.taskBefore);assert.equal(jsonHash(o),inputs.currentObservation);assert.equal(jsonHash(actions),inputs.allActions);assert.equal(jsonHash(audit),inputs.scopeAuditEvent);assert.equal(jsonHash(snapshot),inputs.snapshot);
 writeFileSync(config.output,JSON.stringify({protocol:'run6-serial-carried-state-audit-cpu-v1',revision:config.revision,variant:config.variant,sourceRoot:realpathSync(config.sourceRoot),inputs,recordedReconciliation:{sequence:reconciled.sequence,path:reconciled.data.path,position:reconciled.data.position},setupTimingsMs:{materialHashReadAndParse:materialLoadMs,moduleImport:moduleImportMs},phases,safety:{sdkConstructors:0,browserCalls:0,providerCalls:0,networkCalls,originalOrFrozenDBOpened:0},limits:['Same static c11 snapshot/pending facts, not a new capture or live resumed run.','Task, plugin and cumulative events/saves are carried forward. Startup normalization occurs only once; audit-internal normalization remains actual product behavior.','A recording memory sink is sufficient for these methods, which do not read persisted events/decisions here. Forbidden host/store behavior must fail rather than be fabricated.','Original integrity oracle is repeated against each phase input; no product/oracle changes.','No actual unknown action/route flag exists in this real fixed fixture.']},null,2)+'\n');
 console.log(JSON.stringify(phases.map(r=>({phase:r.phase,timings:r.phaseTimingsMs,newRows:r.newRows,calls:r.auditReads.counts,eventCounts:r.eventCounts,bytes:r.bytes}))));
}finally{globalThis.fetch=oldFetch;}
