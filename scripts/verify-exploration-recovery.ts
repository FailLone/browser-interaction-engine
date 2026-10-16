/** Local, isolated recovery comparison. No production browser/service/task DB.
 * Copy this exact script to the baseline source export and run with Node 24:
 * pnpm exec tsx --conditions=development scripts/verify-exploration-recovery.ts
 *   --variant baseline --revision 4857ad5 --replicate 1 --output /absolute/result.json
 * Refactor uses --variant refactor; aggregate using --summarize /absolute/output-dir.
 */
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {BrowserEngine,type ActionAttempt,type ActionCandidate,type Observation} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import type {Page} from 'playwright';

const {values}=parseArgs({options:{variant:{type:'string'},revision:{type:'string'},replicate:{type:'string'},output:{type:'string'},scenario:{type:'string'},summarize:{type:'string'}},strict:true});
const scenarios=['nested_static','modal_reentry_changed_quote','ready_target_ticking_quote','nested_changed_quote','local_inverse_diverges','unknown_outcome_injected'] as const;
type Scenario=typeof scenarios[number];
type Recovery={id:string;status:string;reason:string;observationId?:string;attemptIds:string[];checks:unknown[];matchedActionIds?:string[];diagnostics?:{strategies?:string[]};checkpointVerified?:boolean;executionAuthorized?:boolean};
type TargetEngine=BrowserEngine&{reachExplorationTarget?:(sid:string,input:{checkpointId:string;observationId:string;actionIds:string[]})=>Promise<Recovery>};
const budget={maxActions:12,maxDurationMs:60000,settleMs:60,observeTimeoutMs:1000,actionTimeoutMs:1500};
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const pageOf=(engine:BrowserEngine)=>(engine as unknown as {driver:{page:Page}}).driver.page;
const fingerprintFiles=['packages/core/src/engine.ts','packages/browser/src/index.ts','packages/adapter-playwright/src/index.ts','packages/adapter-playwright/src/exploration.ts'];
const targetMarkup='<form id="work"><label>Target<input id="target" aria-label="Target" value=""></label></form>';
const quoteMarkup='<form id="quote-form"><label>Quote<input id="quote" readonly value="100"></label></form>';
const instrumentation=`<output id="branch-result" data-hits="0">not triggered</output><script>
 localStorage.loads=String(Number(localStorage.loads||0)+1);
 document.addEventListener('input',event=>{if(event.target.id==='target'){const output=document.querySelector('#branch-result');output.dataset.hits=String(Number(output.dataset.hits)+1);output.textContent='target branch '+event.target.value;}});
 </script>`;
function fixtureHtml(scenario:Scenario){
 let body='';
 if(scenario==='nested_static'||scenario==='nested_changed_quote')body=`<details id="outer"><summary id="open-outer">Outer menu</summary><details id="inner"><summary id="open-inner">Inner menu</summary>${targetMarkup}</details></details>`;
 else if(scenario==='modal_reentry_changed_quote')body=`<button id="open" type="button" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#dialog').showModal()">Open panel</button><dialog id="dialog" aria-label="Trade panel">${targetMarkup}<form method="dialog"><button>Close panel</button></form></dialog>`;
 else if(scenario==='local_inverse_diverges')body='<form id="work"><label>Mode<input id="mode" type="checkbox"></label><label>Target<input id="target" aria-label="Target" value=""></label></form>';
 else body=`${targetMarkup}<button id="noop" type="button">No effect</button>`;
 const quote=['modal_reentry_changed_quote','nested_changed_quote','ready_target_ticking_quote'].includes(scenario)?quoteMarkup:'';
 const change=scenario==='ready_target_ticking_quote'?`let quote=100;setInterval(()=>document.querySelector('#quote').value=String(++quote),15);`:['modal_reentry_changed_quote','nested_changed_quote'].includes(scenario)?`document.querySelector('#quote').value=String(100+Number(localStorage.loads||0));`:'';
 return `<!doctype html><html><head><title>Recovery direction fixture</title><style>body{font:16px sans-serif;padding:24px}input{margin:8px}dialog{min-width:360px}</style></head><body><main>${body}</main>${quote}${instrumentation}<script>${change}</script></body></html>`;
}
function pick(engine:BrowserEngine,sid:string,label:string,kind='click'){
 const found=engine.actions(sid).filter(a=>a.label===label&&a.kind===kind);
 if(found.length!==1)throw new Error(`Expected unique ${kind}:${label}, observed ${found.length}`);
 return found[0];
}
function observationFacts(o:Observation){return {id:o.id,instanceScope:o.instanceScope,url:o.url,stable:o.stable,canonicalHash:sha(o.canonical),gaps:o.gaps.map(g=>({code:g.code,critical:!!g.critical})),boundaries:o.boundaries?.map(b=>({name:b.name,key:b.key})),controls:o.controls.map(c=>({name:c.name,localId:c.localId,visible:c.visible,enabled:c.enabled,readiness:c.readiness?.status}))};}
async function pageFacts(page:Page,scenario:Scenario){
 const facts=await page.evaluate(()=>{
  const target=document.querySelector<HTMLInputElement>('#target'),rect=target?.getBoundingClientRect(),style=target&&getComputedStyle(target),point=rect&&document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
  return {url:location.href,targetPresent:!!target,targetVisible:!!target&&!!rect?.width&&!!rect?.height&&style?.visibility!=='hidden'&&style?.display!=='none',targetEnabled:!!target&&!target.disabled,targetEditable:!!target&&!target.readOnly,
   hitTarget:!!target&&!!point&&(point===target||target.contains(point)),mode:document.querySelector<HTMLInputElement>('#mode')?.checked??null,
   outerOpen:document.querySelector<HTMLDetailsElement>('#outer')?.open??null,innerOpen:document.querySelector<HTMLDetailsElement>('#inner')?.open??null,dialogOpen:document.querySelector<HTMLDialogElement>('#dialog')?.open??null,
   quote:document.querySelector<HTMLInputElement>('#quote')?.value??null,documentLoads:Number(localStorage.loads||0),branchHits:Number(document.querySelector<HTMLOutputElement>('#branch-result')?.dataset.hits||0),branchText:document.querySelector('#branch-result')?.textContent};
 });
 let trialReady=false,trialError:string|undefined;
 if(facts.targetPresent)try{await page.locator('#target').click({trial:true,timeout:400});trialReady=await page.locator('#target').isEditable();}catch(e){trialError=String(e).split('\n')[0];}
 const sourceConditionMatches=scenario==='local_inverse_diverges'?facts.mode===false:scenario.startsWith('nested')?facts.outerOpen===true&&facts.innerOpen===true:scenario==='modal_reentry_changed_quote'?facts.dialogOpen===true:true;
 return {...facts,trialReady,trialError,sourceConditionMatches,physicalArrival:trialReady&&facts.targetVisible&&facts.targetEnabled&&facts.targetEditable&&sourceConditionMatches};
}
async function run(scenario:Scenario,replicate:number,variant:'baseline'|'refactor'){
 let documentRequests=0;
 const html=fixtureHtml(scenario),server=createServer((request,response)=>{if(request.url==='/favicon.ico'){response.writeHead(204);response.end();return;}documentRequests++;response.setHeader('content-type','text/html');response.end(html);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`,directory=mkdtempSync(join(tmpdir(),'bie-direction-recovery-'));
 const engine=new BrowserEngine({persistence:new SqliteStore(join(directory,'engine')),hooks:{samples:()=>['probe']}}) as TargetEngine;
 const startedAt=new Date().toISOString();
 try{
  const session=await engine.createSession({url,headless:true,viewport:{width:1280,height:720},...budget,exploration:'controls',executionPolicy:'interface-only',regionExploration:'off',pageExploration:'all',listExploration:'all',contextRules:[],
   interfaceActions:[{stableKey:'id:open'},{stableKey:'id:noop'}],replayable:[{stableKey:'id:open'},{stableKey:'id:noop'}],reversible:[{stableKey:'id:mode'}]});
  const sid=session.id,page=pageOf(engine),setupAttempts:ActionAttempt[]=[];
  const executeSetup=async(label:string,kind='click',value?:ActionCandidate['value'])=>{const a=pick(engine,sid,label,kind),attempt=await engine.execute(sid,a.id,randomUUID(),value);setupAttempts.push(attempt);if(attempt.status!=='succeeded')throw new Error(`Setup ${label}: ${attempt.status}: ${attempt.reason}`);return attempt;};
  if(scenario.startsWith('nested')){await executeSetup('Outer menu');await executeSetup('Inner menu');}
  if(scenario==='modal_reentry_changed_quote')await executeSetup('Open panel');
  const source=engine.observation(sid),target=pick(engine,sid,'Target','fill'),checkpoint=await engine.createCheckpoint(sid,'Independent target source');
  let injectedAttemptId:string|undefined;
  if(scenario.startsWith('nested'))await page.evaluate(()=>{document.querySelector<HTMLDetailsElement>('#inner')!.open=false;document.querySelector<HTMLDetailsElement>('#outer')!.open=false;const quote=document.querySelector<HTMLInputElement>('#quote');if(quote)quote.value='999';});
  if(scenario==='modal_reentry_changed_quote')await page.evaluate(()=>{document.querySelector<HTMLDialogElement>('#dialog')!.close();document.querySelector('#open')!.setAttribute('aria-expanded','false');document.querySelector<HTMLInputElement>('#quote')!.value='999';});
  if(scenario==='local_inverse_diverges'){
   await executeSetup('Mode','check',true);
   await page.evaluate(()=>document.querySelector('#mode')!.addEventListener('input',()=>{if(!document.querySelector<HTMLInputElement>('#mode')!.checked)document.querySelector('#target')!.remove();}));
  }
  if(scenario==='unknown_outcome_injected'){
   const attempt=await executeSetup('No effect');injectedAttemptId=attempt.id;
   engine.store.put('attempt',{...attempt,status:'unknown',reason:'EXPERIMENT FAULT INJECTION: durable result was lost'} satisfies ActionAttempt);
  }
  await engine.observe(sid);
  const before=engine.observation(sid),beforePage=await pageFacts(page,scenario),priorAttemptIds=new Set(engine.list<ActionAttempt>(sid,'attempt').map(a=>a.id)),requestsBefore=documentRequests;
  let result:Recovery|undefined,recoveryError:string|undefined;
  const start=performance.now();
  try{
   if(variant==='refactor'){
    if(!engine.reachExplorationTarget)throw new Error('Refactor target API unavailable');
    result=await engine.reachExplorationTarget(sid,{checkpointId:checkpoint.id,observationId:source.id,actionIds:[target.id]});
   }else result=await engine.reachCheckpoint(sid,checkpoint.id);
  }catch(error){recoveryError=String(error);}
  const durationMs=performance.now()-start,after=engine.observation(sid),requestsAfter=documentRequests;
  const recoveryAttempts=engine.list<ActionAttempt>(sid,'attempt').filter(a=>!priorAttemptIds.has(a.id));
  // Entry restoration can replace the Playwright Page. Read the active page,
  // never the stale handle from the source checkpoint.
  const activePage=pageOf(engine);
  const oracle=await pageFacts(activePage,scenario),unknownBeforeDispatch=engine.recoveryAssessment(sid).unknownAttempts;
  const reportedArrival=!!result&&['REACHED_VERIFIED','REACHED_ACCEPTABLE','TARGET_REACHED'].includes(result.status);
  const candidates=engine.actions(sid).filter(a=>a.label==='Target'&&a.kind==='fill'),availability=engine.actionAvailability(sid,after.id),candidate=candidates.length===1?candidates[0]:undefined;
  const hostAvailability=candidate?availability.actions.find(a=>a.actionId===candidate.id):undefined;
  let targetAttempt:ActionAttempt|undefined,targetError:{code?:string;message:string}|undefined;
  if(candidate&&(oracle.physicalArrival||reportedArrival||scenario==='unknown_outcome_injected'))try{
   targetAttempt=await engine.execute(sid,candidate.id,randomUUID(),undefined,{profile:'interface-exploration',observationId:after.id});
  }catch(error){targetError={code:(error as {code?:string}).code,message:String(error)};}
  const afterGuarded=await pageFacts(pageOf(engine),scenario),guardedBranchYield=afterGuarded.branchHits>oracle.branchHits;
  let oracleBranchYield=false,oracleProbeError:string|undefined;
  // Measurement-only direct browser input is separate from engine coverage and
  // recovery actions. Unknown-outcome cases intentionally do not dispatch it.
  if(oracle.physicalArrival&&!unknownBeforeDispatch.length)try{await pageOf(engine).locator('#target').fill(`oracle-${replicate}`);oracleBranchYield=(await pageFacts(pageOf(engine),scenario)).branchHits>afterGuarded.branchHits;}catch(error){oracleProbeError=String(error);}
  return {variant,scenario,replicate,startedAt,sessionId:sid,url,fixtureSha256:sha(html),budget,
   source:observationFacts(source),before:observationFacts(before),beforePage,after:observationFacts(after),result,recoveryError,durationMs,
   recoveryAttempts:recoveryAttempts.map(a=>({id:a.id,label:a.action.label,kind:a.action.kind,source:a.action.source,status:a.status,purpose:a.purpose,beforeId:a.beforeId,afterId:a.afterId,reason:a.reason,replayable:a.action.replayable})),
   entryReopenAttempts:recoveryAttempts.filter(a=>a.action.source==='recovery-entry').length,environmentResetAttempts:recoveryAttempts.filter(a=>a.action.source==='recovery-reset').length,documentRequestsDuringRecovery:requestsAfter-requestsBefore,documentChanged:before.instanceScope!==after.instanceScope,
   oracle,reportedArrival,falseArrivalClaim:reportedArrival&&!oracle.physicalArrival,physicalArrivalWithoutPositiveStatus:oracle.physicalArrival&&!reportedArrival,
   hostAvailability,targetExecution:targetAttempt?{id:targetAttempt.id,status:targetAttempt.status,afterId:targetAttempt.afterId,reason:targetAttempt.reason}:undefined,targetError,guardedBranchYield,oracleBranchYield,oracleProbeError,
   unknown:{injected:!!injectedAttemptId,attemptId:injectedAttemptId,unresolvedAfterRecovery:unknownBeforeDispatch.map(a=>a.id),originalStatusAfterMeasurement:injectedAttemptId?engine.list<ActionAttempt>(sid,'attempt').find(a=>a.id===injectedAttemptId)?.status:undefined,positiveStateClaimWithUnresolvedOutcome:reportedArrival&&unknownBeforeDispatch.length>0,guardedDispatchBlocked:!!unknownBeforeDispatch.length&&!targetAttempt&&!!targetError,measurementProbeSkipped:!!unknownBeforeDispatch.length},
   setupAttempts:setupAttempts.map(a=>({id:a.id,label:a.action.label,status:a.status})),measurementOnlyBrowserActions:oracleBranchYield?1:0};
 }catch(error){return {variant,scenario,replicate,startedAt,url,fixtureSha256:sha(html),budget,setupError:String(error)};}
 finally{await engine.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));rmSync(directory,{recursive:true,force:true});}
}

function percentile(values:number[],p:number){const sorted=values.slice().sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]??null;}
function summarize(directory:string){
 const files=readdirSync(directory).filter(f=>/^recovery-(baseline|refactor)-r\d+\.json$/.test(f)).sort();
 const runs=files.flatMap(file=>(JSON.parse(readFileSync(join(directory,file),'utf8')) as {runs:Awaited<ReturnType<typeof run>>[]}).runs);
 const groups=['baseline','refactor'].flatMap(variant=>scenarios.map(scenario=>{
  const rows=runs.filter(r=>r.variant===variant&&r.scenario===scenario),valid=rows.filter(r=>!('setupError' in r));
  const count=(f:(r:typeof valid[number])=>boolean)=>valid.filter(f).length,sum=(f:(r:typeof valid[number])=>number)=>valid.reduce((n,r)=>n+f(r),0);
  return {variant,scenario,sessions:rows.length,validSessions:valid.length,setupErrors:rows.filter(r=>'setupError'in r),reportedArrivals:count(r=>!!r.reportedArrival),physicalArrivals:count(r=>!!r.oracle?.physicalArrival),falseArrivalClaims:count(r=>!!r.falseArrivalClaim),physicalArrivalsWithoutPositiveStatus:count(r=>!!r.physicalArrivalWithoutPositiveStatus),guardedBranchYield:count(r=>!!r.guardedBranchYield),oracleBranchYield:count(r=>!!r.oracleBranchYield),recoveryAttempts:sum(r=>r.recoveryAttempts?.length||0),entryReopens:sum(r=>r.entryReopenAttempts||0),environmentResets:sum(r=>r.environmentResetAttempts||0),documentRequestsDuringRecovery:sum(r=>r.documentRequestsDuringRecovery||0),medianMs:percentile(valid.map(r=>r.durationMs!),.5),p95Ms:percentile(valid.map(r=>r.durationMs!),.95),unknownGuardedDispatchBlocked:count(r=>!!r.unknown?.guardedDispatchBlocked),positiveStateClaimsWithUnresolvedOutcome:count(r=>!!r.unknown?.positiveStateClaimWithUnresolvedOutcome),statuses:valid.reduce<Record<string,number>>((out,r)=>{const key=r.result?.status||'THREW';out[key]=(out[key]||0)+1;return out;},{})};
 }));
 const summary={createdAt:new Date().toISOString(),files,semantics:{baseline:'reachCheckpoint requires strict observable checkpoint equality; a negative status need not mean target absence',refactor:'reachExplorationTarget proves an available historical target sample, not checkpoint equality or execution permission',physicalArrival:'Separate live DOM/Playwright trial readiness plus scenario source-mode checks, independent of SDK return status',guardedBranchYield:'Actual input event counter increase following SDK guarded execution, attempted whenever physically ready even if recovery status negative',oracleBranchYield:'Separate direct browser input event; measurement only, excluded from engine coverage and recovery counts',unknown:'Explicit durable-ledger fault injection; direct oracle dispatch skipped; guarded SDK dispatch must reject',p95:'Nearest-rank; n=5 per scenario/variant means P95 is the observed maximum'},groups};
 writeFileSync(join(directory,'recovery-summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
}
if(values.summarize)summarize(resolve(values.summarize));
else{
 const variant=values.variant,replicate=Number(values.replicate||1);
 if(!['baseline','refactor'].includes(variant||'')||!values.revision||!values.output||!Number.isInteger(replicate)||replicate<1)throw new Error('Require --variant baseline|refactor --revision SHA --replicate N --output absolute.json');
 const selected=values.scenario?scenarios.filter(s=>s===values.scenario):scenarios;if(!selected.length)throw new Error('Unknown scenario');
 const runs:Awaited<ReturnType<typeof run>>[]=[];
 for(const scenario of selected){const row=await run(scenario,replicate,variant as 'baseline'|'refactor');runs.push(row);console.log(JSON.stringify({variant,scenario,replicate,...'setupError'in row?{error:row.setupError}:{status:row.result?.status,physicalArrival:row.oracle?.physicalArrival,guardedBranchYield:row.guardedBranchYield,attempts:row.recoveryAttempts?.length,durationMs:row.durationMs}}));}
 const output=resolve(values.output);mkdirSync(dirname(output),{recursive:true});
 writeFileSync(output,JSON.stringify({createdAt:new Date().toISOString(),variant,declaredEngineRevision:values.revision,node:process.version,cwd:process.cwd(),scriptSha256:sha(readFileSync(new URL(import.meta.url))),engineSourceHashes:Object.fromEntries(fingerprintFiles.map(file=>[file,sha(readFileSync(file))])),runs},null,2)+'\n');
}
