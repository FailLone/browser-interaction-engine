from pathlib import Path
import hashlib,json
first=Path('/tmp/bie-run6-audit-serial-prep/worker.ts').read_text()
original=Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine/docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/full-audit-counterfactual-indexed.ts').read_text()
header=first[:first.index('async function run(')]
oracle=original[original.index('  const added='):original.index('  const report=')]
report=first[first.index('  const report='):first.index('\n  assert.equal(report.totalReads')]
host=first[first.index(' const allowed:any='):first.index(' // Full runtime audit')].replace('calls.push','allCalls.push').replace('returns.push','allReturns.push')
run='''async function run(Plugin:any,normalize:boolean){
 const task=structuredClone(m.before);task.rounds.at(-1).entryPath=structuredClone(reconciled.data.path);task.rounds.at(-1).position=structuredClone(reconciled.data.position);
 const initial=structuredClone(task),allCalls:any[]=[],allEvents:any[]=[],allReturns:any[]=[],allSaves:any[]=[],phases:any[]=[];
'''+host+'''
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
'''+oracle+report+'''
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
 writeFileSync(config.output,JSON.stringify({protocol:'run6-serial-carried-state-audit-cpu-v1',revision:config.revision,variant:config.variant,sourceRoot:realpathSync(config.sourceRoot),inputs,recordedReconciliation:{sequence:reconciled.sequence,path:reconciled.data.path,position:reconciled.data.position},setupTimingsMs:{materialHashReadAndParse:materialLoadMs,moduleImport:moduleImportMs},phases,safety:{sdkConstructors:0,browserCalls:0,providerCalls:0,networkCalls,originalOrFrozenDBOpened:0},limits:['Same static c11 snapshot/pending facts, not a new capture or live resumed run.','Task, plugin and cumulative events/saves are carried forward. Startup normalization occurs only once; audit-internal normalization remains actual product behavior.','A recording memory sink is sufficient for these methods, which do not read persisted events/decisions here. Forbidden host/store behavior must fail rather than be fabricated.','Original integrity oracle is repeated against each phase input; no product/oracle changes.','No actual unknown action/route flag exists in this real fixed fixture.']},null,2)+'\\n');
 console.log(JSON.stringify(phases.map(r=>({phase:r.phase,timings:r.phaseTimingsMs,newRows:r.newRows,calls:r.auditReads.counts,eventCounts:r.eventCounts,bytes:r.bytes}))));
}finally{globalThis.fetch=oldFetch;}
'''
run=run.replace('constructor:constructorMs,','constructor:phase===1?constructorMs:0,')
assert oracle in run
out=Path('/tmp/bie-run6-audit-steady-prep');worker=header+run;(out/'worker.ts').write_text(worker)
(out/'oracle-equivalence.json').write_text(json.dumps({'originalOracleSha256':hashlib.sha256(oracle.encode()).hexdigest(),'workerOracleSha256':hashlib.sha256(run[run.index('  const added='):run.index('  const report=')].encode()).hexdigest(),'oracleByteIdentical':True,'workerSha256':hashlib.sha256(worker.encode()).hexdigest(),'carryForward':'Single plugin/task/host/sink; only report views sliced. No state reset, startup normalization runs once.','newAssertions':['all 204 pending emitted','old row order unchanged','pendingDispatch unchanged','original route/scheduling/round hashes unchanged','phase input task hash equals preceding output task hash']},indent=2)+'\n')
