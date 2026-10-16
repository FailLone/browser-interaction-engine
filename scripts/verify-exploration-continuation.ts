import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {BrowserEngine,type ActionAttempt,type Observation} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerPlugin,ExplorerStore,type ModelRequest,type Provider,type Task} from '@interaction/explorer-plugin';

// Runs only self-owned temporary browsers, HTTP fixtures and SQLite stores.
// The oracle is declared here before execution; task.status is never coverage.
// Example: pnpm exec tsx --conditions=development scripts/verify-exploration-continuation.ts --label refactor --repeats 5 --out docs/experiments/layered-direction-2026-10-16/continuation-refactor.json
const args=Object.fromEntries(process.argv.slice(2).reduce<string[][]>((out,value,index,all)=>value.startsWith('--')?[...out,[value.slice(2),all[index+1]]]:out,[]));
const label=args.label||'refactor',repeats=Number(args.repeats||5),selected=args.scenario;
const output=resolve(args.out||`docs/experiments/layered-direction-2026-10-16/continuation-${label}.json`);
if(!Number.isInteger(repeats)||repeats<1||repeats>20)throw new Error('--repeats must be 1..20');
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
let revision=args.revision;
try{revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{if(!revision)throw new Error('Supply --revision for an exported source tree');}
const scenarios=['cold_nested_restart','failed_recovery_restart','unknown_recovery_restart'] as const;
type Scenario=typeof scenarios[number];
type Phase='before_restart'|'after_restart';
type AttemptSummary={id:string;sessionId:string;label:string;kind:string;purpose?:string;status:string;phase:Phase;beforeId:string;afterId?:string;elapsedMs:number;before?:unknown;after?:unknown};
type RecoveryCall={api:string;phase:Phase;beforeObservationId:string;beforeCondition:string;oracleCovered:string[];status?:string;reason?:string;elapsedMs:number;attemptIds:string[];fault?:string;actualBrowserRecovery:boolean;result?:unknown};
const result:any={label,revision,runtimeSha256:sha(readFileSync(resolve('packages/explorer-plugin/src/runtime.ts'),'utf8')),scriptSha256:sha(readFileSync(new URL(import.meta.url),'utf8')),startedAt:new Date().toISOString(),node:process.version,repeats,
 methodology:{oracle:'Fixed declared leaf names, credited only for actual onclick HTTP events retained across browser restarts. Attempts, completion and empty queues are separately checked claims.',
  providers:'Deterministic fixture decision providers; request counts are orchestration counts, not live-model quality or latency.',
  scope:'Independent local fixtures only; one browser at a time; no existing service, browser, or task database.',
  unknownFault:'After the SDK performs a real browser recovery, its owned temporary attempt record is changed to unknown to simulate a durable-result fault; original status must remain unknown.',
  unavailableFault:'Before restart only, recovery calls return UNVERIFIED without dispatching any browser action. After restart the fault is removed.',
  timeLimits:'60 second task duration and 75 second outer phase timeout; observe timeout 1000ms; settle 0ms.',
  retryMetric:'A failed recovery repeated under the same normalized visible-control conditions without new oracle coverage; phase and generated observation/document IDs do not reset this metric.',
  limits:'Small controlled fixtures with explicit safe-repeat contracts. Results cannot establish real-site exhaustion, arbitrary browser snapshot restoration, or live-model efficiency.'},runs:[],complete:false};
mkdirSync(dirname(output),{recursive:true});
const save=()=>writeFileSync(output,JSON.stringify(result,null,2)+'\n');save();

function providers(calls:any[]){
 const decide=(actor:'jev'|'llm')=>async(r:ModelRequest)=>{
  calls.push({actor,purpose:r.purpose,kind:r.kind});let value:unknown;const material=(r.state as any).material;
  if(r.kind==='generate'){
   if(r.purpose==='input-samples')value={samples:['sample']};
   else if(r.purpose==='followup-plan')value={items:material.unfinished.map((i:any)=>({title:i.title,scope:i.scope,prerequisites:i.prerequisites,completion:i.completion,required:i.required,reason:i.reason}))};
   else value={purpose:'Choose a fixture option',businessScope:'Local verification fixture'};
  }else if(r.kind==='checklist')value=Object.fromEntries(Object.keys(r.checks!).map(k=>[k,k.startsWith('interface_')?.99:.01]));
  else if(r.kind==='noul')value=true;
  else{
   value=Object.keys(r.options!).find(k=>k!=='uncertain')!;
   if(r.purpose==='control-classification')value='display';
   if(r.purpose==='scope-review')value='all';
   if(r.purpose==='list-purpose')value='uncertain';
   if(r.purpose==='next-action'){
    const entries=Object.entries(r.options!) as [string,any][];
    value=['Close gate','Open menu','Open submenu','Branch A','Branch B','Outside'].map(name=>entries.find(([,option])=>option.label===name)).find(Boolean)?.[0]||value;
   }
  }
  return {value,model:'fixture-deterministic',confidence:1};
 };
 return {jev:{name:'fixture-jev',model:'fixture',decide:decide('jev')} as Provider,llm:{name:'fixture-llm',model:'fixture',decide:decide('llm')} as Provider};
}
const html=(scenario:Scenario)=>scenario==='cold_nested_restart'?`<!doctype html><html><head><title>Continuation oracle</title></head><body><main><h1>Continuation fixture</h1>
 <button id="open-menu" type="button" onclick="document.getElementById('menu').hidden=false">Open menu</button>
 <section id="menu" aria-label="Menu" hidden><button id="open-submenu" type="button" onclick="document.getElementById('submenu').hidden=false">Open submenu</button>
 <section id="submenu" aria-label="Submenu" hidden>${['A','B'].map(name=>`<button id="branch-${name}" type="button" onclick="this.disabled=true;document.getElementById('submenu').hidden=true;document.getElementById('menu').hidden=true">Branch ${name}</button>`).join('')}</section></section>
 <button id="outside" type="button" onclick="this.disabled=true">Outside</button>
 <dialog aria-label="Initial gate"><button type="button" onclick="document.querySelector('dialog').close()">Close gate</button></dialog>
 <script>document.querySelector('dialog').showModal()</script></main></body></html>`:
 `<!doctype html><html><head><title>Recovery oracle</title></head><body><main><h1>Recovery fixture</h1><section id="choices" aria-label="Choices">${['A','B'].map(name=>`<button id="branch-${name}" type="button" onclick="this.disabled=true;document.getElementById('choices').hidden=true">Branch ${name}</button>`).join('')}</section></main></body></html>`;
const condition=(o:Observation)=>sha(JSON.stringify({url:o.url,context:Object.fromEntries(Object.entries(o.context).map(([key,v])=>[key,{status:v.status,value:v.value}])),boundaries:o.boundaries?.map(b=>b.name),controls:o.controls.map(c=>({name:c.name,role:c.role,visible:c.visible,enabled:c.enabled,selected:c.selected})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}));
const controlFacts=(o:Observation,label:string)=>o.controls.filter(c=>c.name===label||c.label===label).map(c=>({visible:c.visible,enabled:c.enabled,role:c.role,binding:c.identityContext?.binding}));
const isSuccess=(a:ActionAttempt)=>a.status==='succeeded'&&a.purpose!=='recovery';

async function run(scenario:Scenario,iteration:number){
 const begun=performance.now(),directory=mkdtempSync(join(tmpdir(),`bie-continuation-${label}-`)),engineDir=join(directory,'engine'),pluginDb=join(directory,'plugin.sqlite');
 const oracle=scenario==='cold_nested_restart'?['Branch A','Branch B','Outside']:['Branch A','Branch B'];
 let phase:Phase='before_restart',host:BrowserEngine,plugin:ExplorerPlugin,taskId='',paused=false,pauseJob:Promise<unknown>|undefined,unknownInjected=false;
 const modelCalls:any[]=[],attemptPhases=new Map<string,Phase>(),attemptTimes=new Map<string,number>(),recoveries:RecoveryCall[]=[],injectedUnknownIds:string[]=[],errors:any[]=[],phaseResults:any[]=[];
 let createCalls=0,hostConstructs=0,hostCloses=0,pluginConstructs=0,pluginCloses=0;
 const oracleEvents:{label:string;phase:Phase;sequence:number;at:number;attemptId?:string;purpose?:string}[]=[];
 let currentAttempt:ActionAttempt|undefined;
 const instrumentation=`<script>document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;const request=new XMLHttpRequest();request.open('POST','/oracle?label='+encodeURIComponent(button.textContent.trim()),false);request.send();},true)</script>`;
 const fixture=html(scenario).replace('<body>','<body>'+instrumentation);
 const server=createServer((req,res)=>{if(req.url?.startsWith('/oracle?')){oracleEvents.push({label:new URL(req.url,'http://fixture').searchParams.get('label')!,phase,sequence:oracleEvents.length+1,at:performance.now()-begun,attemptId:currentAttempt?.id,purpose:currentAttempt?.purpose});res.writeHead(204);res.end();return;}res.setHeader('content-type','text/html');res.end(req.url==='/favicon.ico'?'':fixture);});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
 const readAttempts=(task:Task)=>task.rounds.flatMap(r=>host.list<ActionAttempt>(r.sessionId,'attempt'));
 const covered=()=>[...new Set(oracleEvents.map(event=>event.label).filter(name=>oracle.includes(name)))].sort();
 const createHost=()=>{
  hostConstructs++;const next=new BrowserEngine({persistence:new SqliteStore(engineDir)});
  const create=next.createSession.bind(next);next.createSession=input=>{createCalls++;return create({...input as Record<string,unknown>,interfaceActions:['Open menu','Open submenu','Branch A','Branch B','Outside'].map(name=>({kind:'click',name}))});};
  next.events.on('event',event=>{
   const a=event.data as ActionAttempt;
   if(event.type==='action.started'){currentAttempt=a;attemptPhases.set(a.id,phase);attemptTimes.set(a.id,performance.now());}
   if(event.type==='action.completed')currentAttempt=undefined;
   if(event.type==='action.completed'&&scenario==='cold_nested_restart'&&phase==='before_restart'&&a.action.label==='Branch A'&&!paused){paused=true;pauseJob=plugin.pause(taskId);}
  });
  for(const api of ['reachCheckpoint','reachExplorationTarget'] as const){
   const original=(next as any)[api];if(typeof original!=='function')continue;
   (next as any)[api]=async(sid:string,input:any)=>{
    const before=next.observation(sid),start=performance.now();
    const call:RecoveryCall={api,phase,beforeObservationId:before.id,beforeCondition:condition(before),oracleCovered:covered(),elapsedMs:0,attemptIds:[],actualBrowserRecovery:true};recoveries.push(call);
    try{
     let reached:any;
     if(scenario==='failed_recovery_restart'&&phase==='before_restart'){
      call.actualBrowserRecovery=false;call.fault='recovery_unavailable_before_restart';
      reached={id:randomUUID(),sessionId:sid,checkpointId:typeof input==='string'?input:input.checkpointId,observationId:before.id,status:'UNVERIFIED',reason:'Experiment fault: recovery endpoint unavailable',checks:[{name:'experiment-fault',result:'unknown'}],attemptIds:[],remainingFrontier:1};
     }else{
      reached=await original.call(next,sid,input);
      if(scenario==='unknown_recovery_restart'&&phase==='before_restart'&&!unknownInjected&&reached.attemptIds.length){
       const id=reached.attemptIds.at(-1)!,a=next.list<ActionAttempt>(sid,'attempt').find(a=>a.id===id)!;
       next.store.put('attempt',{...a,status:'unknown',reason:'Experiment fault: durable recovery result unavailable'} satisfies ActionAttempt);
       injectedUnknownIds.push(id);unknownInjected=true;call.fault='post_recovery_durable_result_unknown';
      }
     }
     call.status=reached.status;call.reason=reached.reason;call.attemptIds=[...reached.attemptIds];call.result={observationId:reached.observationId,checks:reached.checks,checkpointVerified:reached.checkpointVerified};return reached;
    }catch(error){call.status='THREW';call.reason=String(error);throw error;}finally{call.elapsedMs=Math.round(performance.now()-start);}
   };
  }
  return next;
 };
 const createPlugin=()=>{pluginConstructs++;return new ExplorerPlugin(host,new ExplorerStore(pluginDb),providers(modelCalls));};
 const phaseRun=async()=>{
  const start=performance.now(),beforeCalls=modelCalls.length,beforeCreate=createCalls;let timeout:ReturnType<typeof setTimeout>|undefined;
  try{plugin.start(taskId);await Promise.race([plugin.waitForIdle(),new Promise<void>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Experiment phase timeout')),75000);})]);if(pauseJob)await pauseJob;}
  catch(error){errors.push({phase,error:String(error),code:(error as any).code});if(plugin.owner()===taskId)await plugin.pause(taskId).catch(()=>{});}
  finally{if(timeout)clearTimeout(timeout);}
  const task=plugin.view(taskId).task;
  const snapshot={phase,elapsedMs:Math.round(performance.now()-start),status:task.status,reason:task.reason,covered:covered(),missing:oracle.filter(name=>!covered().includes(name)),rounds:task.rounds.length,newSessions:createCalls-beforeCreate,
   modelRequests:modelCalls.slice(beforeCalls).reduce((counts,c)=>(counts[c.actor]++,counts),{jev:0,llm:0}),usage:structuredClone(task.usage),
   plan:task.plan.map(i=>({id:i.id,label:i.scope.label,scope:i.scope,status:i.status,required:i.required,reason:i.reason,evidence:i.evidence,attempts:i.attempts,resolvedBy:i.resolvedBy})),
   unverifiedRecoveries:(task as any).unverifiedRecoveries,unknownAttempts:readAttempts(task).filter(a=>a.status==='unknown'||a.status==='executing').map(a=>({id:a.id,sessionId:a.sessionId,purpose:a.purpose,status:a.status,label:a.action.label}))};
  phaseResults.push(snapshot);return task;
 };
 let initial:Task|undefined,final:Task|undefined,priorDocument:string|undefined,nextDocument:string|undefined;
 try{
  host=createHost();plugin=createPlugin();const task=plugin.create({url,sessionOptions:{executionPolicy:'interface-only',settleMs:0,observeTimeoutMs:1000,maxDepth:12},budget:{rounds:scenario==='cold_nested_restart'?2:1,actions:24,modelRequests:100,durationMs:60000}});taskId=task.id;
  initial=await phaseRun();const sid=initial.rounds.at(-1)?.sessionId;if(sid)priorDocument=host.observation(sid).instanceScope;
  await plugin.close();pluginCloses++;
  if(scenario!=='failed_recovery_restart'){await host.close();hostCloses++;host=createHost();}
  phase='after_restart';pauseJob=undefined;plugin=createPlugin();
  if(initial.status!=='completed'&&scenario!=='cold_nested_restart')plugin.extendBudget(taskId,{rounds:1,actions:4,durationMs:60000,modelRequests:30});
  final=await phaseRun();const finalSid=final.rounds.at(-1)?.sessionId;if(finalSid)nextDocument=host.observation(finalSid).instanceScope;
  const attempts=readAttempts(final),summaries:AttemptSummary[]=attempts.map(a=>({id:a.id,sessionId:a.sessionId,label:a.action.label,kind:a.action.kind,purpose:a.purpose,status:a.status,phase:attemptPhases.get(a.id)||'before_restart',beforeId:a.beforeId,afterId:a.afterId,elapsedMs:a.finishedAt?Date.parse(a.finishedAt)-Date.parse(a.startedAt):0,
   before:controlFacts(host.observation(a.sessionId,a.beforeId),a.action.label),after:a.afterId?controlFacts(host.observation(a.sessionId,a.afterId),a.action.label):undefined}));
  const actualCovered=covered(),missing=oracle.filter(name=>!actualCovered.includes(name));
  const outstandingUnknown=attempts.filter(a=>a.status==='unknown'||a.status==='executing');
  const beforeMissing=phaseResults[0].missing as string[],priorPending=initial.plan.filter(i=>i.required&&!['succeeded','excluded'].includes(i.status)&&i.scope.label&&beforeMissing.includes(i.scope.label));
  const lostPending=priorPending.filter(i=>!actualCovered.includes(i.scope.label!)&&!final!.plan.some(next=>next.required&&!['succeeded','excluded'].includes(next.status)&&next.scope.label===i.scope.label)).map(i=>({id:i.id,label:i.scope.label}));
  const incorrectlySettled=priorPending.filter(i=>!actualCovered.includes(i.scope.label!)&&final!.plan.find(next=>next.id===i.id)?.status==='succeeded').map(i=>({id:i.id,label:i.scope.label}));
  const leafCounts=Object.fromEntries(oracle.map(name=>[name,oracleEvents.filter(event=>event.label===name).length]));
  let necessaryReentries=0,unnecessaryReentries=0;const seenEntries=new Set<string>(),seenLeaves=new Set<string>();
  for(const event of oracleEvents){if(oracle.includes(event.label)){seenLeaves.add(event.label);continue;}if(!['Close gate','Open menu','Open submenu'].includes(event.label))continue;if(seenEntries.has(event.label)){const required=event.label==='Close gate'?oracle:['Branch A','Branch B'];if(required.some(name=>!seenLeaves.has(name)))necessaryReentries++;else unnecessaryReentries++;}seenEntries.add(event.label);}
  let repeatedNoProgressRecoveries=0;const failedConditions=new Set<string>();
  for(const recovery of recoveries){const key=JSON.stringify([recovery.beforeCondition,recovery.oracleCovered]);if(failedConditions.has(key))repeatedNoProgressRecoveries++;if(['UNREACHABLE','UNVERIFIED','THREW'].includes(recovery.status||''))failedConditions.add(key);else failedConditions.delete(key);}
  const events=plugin.store.events(taskId,0,10000).filter(e=>e.actor==='program'&&/recovery|round|halt|completed|reattach|reentry/.test(e.type)).map(e=>({type:e.type,sessionId:e.sessionId,data:e.data}));
  return {scenario,iteration,url,fixtureSha256:sha(fixture),oracleEvents,valid:scenario==='cold_nested_restart'?paused:scenario==='unknown_recovery_restart'?unknownInjected:recoveries.some(r=>r.fault==='recovery_unavailable_before_restart'),
   oracle:{mustExecute:oracle,covered:actualCovered,missing,lostPending,incorrectlySettled,priorPending:priorPending.map(i=>({id:i.id,label:i.scope.label})),newAfterRestart:actualCovered.filter(name=>!phaseResults[0].covered.includes(name)),leafCounts},
   metrics:{incorrectCompletion:final.status==='completed'&&(missing.length>0||outstandingUnknown.length>0),unknownRetained:injectedUnknownIds.every(id=>attempts.some(a=>a.id===id&&a.status==='unknown')),
    unresolvedUnknown:outstandingUnknown.length,successfulExplorationAfterInjectedUnknown:unknownInjected?attempts.filter(a=>isSuccess(a)&&attempts.indexOf(a)>attempts.findIndex(first=>first.id===injectedUnknownIds[0])).length:0,
    duplicateLeafExecutions:Object.values(leafCounts).reduce((sum,n)=>sum+Math.max(0,n-1),0),necessaryReentries,unnecessaryReentries,recoveryCalls:recoveries.length,actualBrowserRecoveryCalls:recoveries.filter(r=>r.actualBrowserRecovery).length,
    injectedRecoveryFailures:recoveries.filter(r=>r.fault==='recovery_unavailable_before_restart').length,recoveryHostSuccesses:recoveries.filter(r=>['TARGET_REACHED','REACHED_VERIFIED','REACHED_ACCEPTABLE'].includes(r.status||'')).length,
    repeatedNoProgressRecoveries,elapsedMs:Math.round(performance.now()-begun),recoveryElapsedMs:recoveries.reduce((sum,r)=>sum+r.elapsedMs,0),jev:modelCalls.filter(c=>c.actor==='jev').length,llm:modelCalls.filter(c=>c.actor==='llm').length},
   restart:{pluginConstructs,pluginClosesBeforeFinish:pluginCloses,hostConstructs,hostClosesBeforeFinish:hostCloses,documentChanged:priorDocument!==nextDocument,priorDocument,nextDocument,sessionCreates:createCalls},
   injectedUnknownIds,phases:phaseResults,attempts:summaries,recoveries,modelCalls,events,errors};
 }catch(error){return {scenario,iteration,valid:false,errors:[...errors,{phase,error:String(error),stack:(error as Error).stack}],phases:phaseResults,recoveries,modelCalls,elapsedMs:Math.round(performance.now()-begun)};}
 finally{if(plugin!){await plugin.close().catch(()=>{});pluginCloses++;}if(host!){await host.close().catch(()=>{});hostCloses++;}await new Promise<void>(done=>server.close(()=>done()));rmSync(directory,{recursive:true,force:true});}
}

for(const scenario of scenarios.filter(s=>!selected||s===selected))for(let iteration=1;iteration<=repeats;iteration++){
 const trial=await run(scenario,iteration);result.runs.push(trial);save();console.log(JSON.stringify({label,scenario,iteration,valid:trial.valid,metrics:(trial as any).metrics,oracle:(trial as any).oracle,errors:trial.errors}));
}
result.complete=true;result.finishedAt=new Date().toISOString();save();
