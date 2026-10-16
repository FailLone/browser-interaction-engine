import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {BrowserEngine,type ActionAttempt,type Observation} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';
import {ExplorerPlugin,ExplorerStore,type Provider,type Round,type Task} from '@interaction/explorer-plugin';
import {browserOperationKey} from '../packages/adapter-playwright/src/exploration.js';
import {completedOperations} from '../packages/explorer-plugin/src/completion-evidence.js';
import type {Page} from 'playwright';

// An independent, bounded differential experiment. This file is copied unchanged
// into each source revision. The browser's event log is the coverage oracle;
// scheduler completion and queue size are recorded only as implementation claims.
const args=new Map(process.argv.slice(2).map(value=>{const [key,...rest]=value.replace(/^--/,'').split('=');return [key,rest.join('=')];}));
const revision=args.get('revision'),output=args.get('output');
if(!revision||!output)throw new Error('Required: --revision=<source-commit> --output=<absolute-json-path>');
const runs=Number(args.get('runs')||5),ticks=Number(args.get('ticks')||100),phaseSteps=4;
if(!Number.isInteger(runs)||runs<1||!Number.isInteger(ticks)||ticks<1)throw new Error('runs and ticks must be positive integers');
const allScenarios=['public-form-cycle','shared-id-rebuild','price-known','price-unknown','nonlocal-dependency'] as const;
type Scenario=typeof allScenarios[number];
const requested=args.get('scenarios')?.split(',')||allScenarios;
if(requested.some(name=>!allScenarios.includes(name as Scenario)))throw new Error('Unknown scenario');
const scenarios=requested as Scenario[];
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const budget={rounds:1,actions:8,durationMs:60000,modelRequests:8};
const sessionOptions={headless:true,settleMs:0,observeTimeoutMs:1000,actionTimeoutMs:2000,maxActions:8};
const field='<label>Price<input id="quote" value="100" readonly></label>';
const later='<button id="later" type="button" disabled>Later</button>';
function fixtureHtml(scenario:Scenario){
  const oracle=`<script>window.record=function(branch){const request=new XMLHttpRequest();request.open('POST','/oracle?branch='+encodeURIComponent(branch),false);request.send();};</script>`;
  const mode='<label>Mode<select id="mode"><option value="A">A</option><option value="B">B</option></select></label>';
  let content:string;
  if(scenario==='public-form-cycle')content=`<form id="form">${mode}<button id="run" type="button" onclick="record('form:'+mode.value);mode.value=mode.value==='A'?'B':'A'">Run</button></form>${field}`;
  else if(scenario==='shared-id-rebuild')content=`<div id="owner-a" aria-label="Owner A"><button id="shared" type="button" onclick="record('shared:A')">Run</button></div><div id="owner-b" aria-label="Owner B"><button id="shared" type="button" onclick="record('shared:B')">Run</button></div>${later}${field}`;
  else if(scenario==='nonlocal-dependency')content=`<form id="remote-form">${mode}</form><form id="action-form"><button id="run" type="button" onclick="record('nonlocal:'+document.querySelector('#mode').value)">Run</button></form>${later}${field}`;
  else content=`<form id="form">${scenario==='price-unknown'?'<button id="uncertain" type="button" role="option" disabled>Uncertain mode</button>':''}<button id="run" type="button" onclick="record('price:run')">Run</button></form>${later}${field}`;
  return `<!doctype html><html><head><title>Independent exploration condition experiment</title></head><body>${oracle}${content}</body></html>`;
}
const expectedBranches=(s:Scenario)=>s==='public-form-cycle'?['form:A','form:B']:s==='shared-id-rebuild'?['shared:A','shared:B']:s==='nonlocal-dependency'?['nonlocal:A','nonlocal:B']:['price:run'];
type OracleEvent={branch:string;sequence:number;at:number};
const pageOf=(host:BrowserEngine)=>(host as unknown as {driver:{page:Page}}).driver.page;
const errorText=(e:unknown)=>e instanceof Error?`${e.name}: ${e.message}`:String(e);
async function experiment(scenario:Scenario,run:number){
  const started=performance.now(),html=fixtureHtml(scenario),host=new BrowserEngine({persistence:new MemoryStore()});
  const calls:{actor:string;purpose:string;kind:string}[]=[],errors:string[]=[],keyRows:{observationId:string;stateId:string;targetId?:string;key:string}[]=[];
  const provider=(actor:string):Provider=>({name:'experiment-counting-no-model',model:'none',async decide(request){calls.push({actor,purpose:request.purpose,kind:request.kind});throw new Error(`EXPERIMENT_MODEL_NOT_AVAILABLE:${request.purpose}`);}});
  const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),{jev:provider('jev'),llm:provider('llm')});
  const eventLog:OracleEvent[]=[];
  const site=createServer((req,res)=>{if(req.url?.startsWith('/oracle?')){eventLog.push({branch:new URL(req.url,'http://fixture').searchParams.get('branch')!,sequence:eventLog.length+1,at:performance.now()-started});res.writeHead(204);res.end();return;}res.setHeader('Content-Type','text/html');res.end(html);});
  await new Promise<void>(done=>site.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${(site.address() as {port:number}).port}/`;
  let sid='',task:Task|undefined,stepCalls=0,phaseRecord:unknown[]=[],oracle:OracleEvent[]=[];
  const captureKeys=(o:Observation)=>{for(const a of host.actions(o.sessionId,o.id).filter(a=>a.label==='Run'&&a.kind==='click'))keyRows.push({observationId:o.id,stateId:o.stateId,targetId:a.controlId,key:browserOperationKey(a,o)});};
  const onEvent=(event:{type:string;sessionId:string;data:unknown})=>{if(event.type==='observation.created'){const id=(event.data as {observationId:string}).observationId;captureKeys(host.observation(event.sessionId,id));}};
  host.events.on('event',onEvent);
  const pageOracle=async()=>structuredClone(eventLog);
  // For phases with one current Run target, the fixture names the branch that a
  // click would invoke. With simultaneous shared-id targets we report coverage
  // claims without claiming to infer their DOM binding from the engine itself.
  const checkpoint=async(label:string,currentBranch?:string)=>{
    const o=host.observation(sid),actions=host.actions(sid).filter(a=>a.kind==='click'&&a.label==='Run'),seen=await pageOracle();
    const completed=task?completedOperations(host,task,o,actions):new Set();
    const claim=actions.length===1&&completed.has(actions[0]);
    const row={label,observationId:o.id,stateId:o.stateId,currentBranch:currentBranch||null,oracle:seen.map(e=>e.branch),operationKeys:actions.map(a=>browserOperationKey(a,o)),
      coverageClaims:actions.map(a=>({actionId:a.id,controlId:a.controlId,completed:completed.has(a)})),
      falseCoverage:!!currentBranch&&claim&&!seen.some(e=>e.branch===currentBranch),planRows:task?.plan.length||0,
      pendingPlanRows:task?.plan.filter(i=>i.required&&!['succeeded','excluded'].includes(i.status)).length||0,attemptCount:host.list(sid,'attempt').length};
    phaseRecord.push(row);return row;
  };
  try{
    const created=plugin.create({url,budget,sessionOptions});
    plugin.revise(created.id,{items:[{title:'Exercise encountered click branches',scope:{url,kind:'click'},prerequisites:[],completion:'Observe encountered branches, retaining unavailable clicks',required:true,reason:'Explicit experiment instruction'}]});
    if(scenario==='public-form-cycle'){
      // A normal public lifecycle; the first UI action exposes B immediately,
      // and B returns to A. No test code selects a candidate or calls step.
      plugin.start(created.id);await plugin.waitForIdle(created.id);task=plugin.store.task(created.id);sid=task.rounds.at(-1)?.sessionId||'';
      if(!sid)throw new Error('Public plugin created no session');
      const value=await pageOf(host).locator('#mode').inputValue();await checkpoint('public-run-finished',`form:${value}`);
    }else{
      const session=await host.createSession({...sessionOptions,url,exploration:'controls',contextRules:[],regionExploration:'off',pageExploration:'all',listExploration:'all',interfaceActions:[{kind:'click'}]});sid=session.id;
      task=plugin.store.task(created.id);
      const round:Round={id:randomUUID(),number:1,sessionId:sid,startedAt:new Date().toISOString(),status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};
      task.rounds=[round];task.status='running';plugin.store.save(task);
      const runtime=plugin as unknown as {step(task:Task,round:Round,signal:AbortSignal):Promise<boolean>};
      const steps=async(count:number)=>{for(let n=0;n<count;n++){stepCalls++;try{await runtime.step(task!,round,new AbortController().signal);}catch(e){errors.push(errorText(e));break;}}};
      await checkpoint('initial',scenario==='nonlocal-dependency'?'nonlocal:A':scenario.startsWith('price')?'price:run':undefined);
      await steps(phaseSteps);await checkpoint('after-initial',scenario==='nonlocal-dependency'?'nonlocal:A':scenario.startsWith('price')?'price:run':undefined);
      if(scenario==='shared-id-rebuild'){
        await pageOf(host).evaluate(()=>{document.querySelector('#owner-a')!.remove();const b=document.querySelector('#owner-b button')!;b.replaceWith(b.cloneNode(true));});
        await host.observe(sid);await checkpoint('A-removed-B-rebuilt-before-dispatch','shared:B');await steps(phaseSteps);await checkpoint('A-removed-B-rebuilt-after-dispatch','shared:B');
        await pageOf(host).evaluate(()=>{const b=document.querySelector('#owner-b button')!;b.replaceWith(b.cloneNode(true));});
        await host.observe(sid);await steps(phaseSteps);await checkpoint('same-B-rebuilt-again','shared:B');
      }else if(scenario==='nonlocal-dependency'){
        await pageOf(host).evaluate(()=>{(document.querySelector('#mode') as HTMLSelectElement).value='B';});await host.observe(sid);
        await checkpoint('nonlocal-B-before-dispatch','nonlocal:B');await steps(phaseSteps);await checkpoint('nonlocal-B-after-dispatch','nonlocal:B');
      }else{
        for(let n=1;n<=ticks;n++){
          await pageOf(host).evaluate(n=>{(document.querySelector('#quote') as HTMLInputElement).value=String(100+n);},n);await host.observe(sid);await steps(1);await checkpoint(`price-tick-${n}`,'price:run');
        }
      }
    }
    oracle=await pageOracle();
  }catch(e){errors.push(errorText(e));if(sid)try{oracle=await pageOracle();}catch{}}
  const attempts=sid?host.list<ActionAttempt>(sid,'attempt'):[],distinct=[...new Set(oracle.map(e=>e.branch))],expected=expectedBranches(scenario);
  const rows=phaseRecord as {falseCoverage:boolean;planRows:number;pendingPlanRows:number;operationKeys:string[];label:string}[];
  const result={scenario,run,sourceRevision:revision,fixtureSha256:sha(html),
    method:scenario==='public-form-cycle'?'public plugin.start/waitForIdle lifecycle':'single-step SDK/plugin mechanism experiment',
    expectedBranches:expected,observedBranches:distinct,missingBranches:expected.filter(branch=>!distinct.includes(branch)),oracle,
    metrics:{actualActions:attempts.length,successfulActions:attempts.filter(a=>a.status==='succeeded').length,recoveryActions:attempts.filter(a=>a.purpose==='recovery').length,
      oracleClicks:oracle.length,newDistinctBranches:distinct.length,duplicateOracleClicks:oracle.length-distinct.length,
      falseCoverageChecks:rows.filter(r=>r.falseCoverage).length,retryKeyCount:new Set(keyRows.map(r=>r.key)).size,
      priceTickRetryKeyCount:scenario.startsWith('price')?new Set(rows.filter(r=>r.label.startsWith('price-tick')).flatMap(r=>r.operationKeys)).size:null,
      observedStateCount:new Set(keyRows.map(r=>r.stateId)).size,stepCalls,modelRequests:calls.length,jevCalls:calls.filter(c=>c.actor==='jev').length,llmCalls:calls.filter(c=>c.actor==='llm').length,
      initialPlanRows:rows[0]?.planRows||0,finalPlanRows:rows.at(-1)?.planRows||0,finalPendingRows:rows.at(-1)?.pendingPlanRows||0,wallTimeMs:Math.round(performance.now()-started)},
    taskStatus:task?.status,taskReason:task?.reason||null,modelCalls:calls,errors,phaseRecord,keyRows,
    attempts:attempts.map(a=>({id:a.id,beforeId:a.beforeId,afterId:a.afterId,status:a.status,purpose:a.purpose,label:a.action.label,kind:a.action.kind,controlId:a.action.controlId}))};
  host.events.off('event',onEvent);await plugin.close();await host.close();await new Promise<void>(done=>site.close(()=>done()));
  return result;
}
const evidence={schemaVersion:1,generatedAt:new Date().toISOString(),sourceRevision:revision,sourceRoot:root,node:process.version,
  modulePaths:{browser:import.meta.resolve('@interaction/browser'),plugin:import.meta.resolve('@interaction/explorer-plugin')},
  sourceHashes:Object.fromEntries(['packages/adapter-playwright/src/exploration.ts','packages/explorer-plugin/src/runtime.ts','packages/core/src/engine.ts'].map(path=>[path,sha(readFileSync(resolve(root,path),'utf8'))])),
  scriptSha256:sha(readFileSync(fileURLToPath(import.meta.url),'utf8')),protocol:{runs,ticks,phaseSteps,budget,sessionOptions,scenarios,oracle:'Independent onclick HTTP append log, persistent across reloads; no inference from queue completion',
    models:'Counting providers throw on request; no real JEV or LLM is configured',limitations:['The bounded mechanism scenarios call private step to apply identical external event streams; they do not test the full run loop.','The public form cycle exercises public start/waitForIdle.','Nonlocal JavaScript dependencies are deliberately undeclared and can defeat the current local dependency abstraction.','This is a controlled direction test, not an exhaustion or real-site performance claim.']},results:[] as Awaited<ReturnType<typeof experiment>>[]};
for(let run=1;run<=runs;run++)for(const scenario of scenarios){const result=await experiment(scenario,run);evidence.results.push(result);console.log(JSON.stringify({scenario,run,...result.metrics,missing:result.missingBranches,errors:result.errors}));mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(resolve(output),JSON.stringify(evidence,null,2)+'\n');}
