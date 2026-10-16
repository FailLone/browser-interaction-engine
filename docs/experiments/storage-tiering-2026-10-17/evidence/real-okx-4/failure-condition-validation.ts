/** Offline acceptance against frozen observations; never opens original DBs. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {BrowserAdapter,BrowserEngine,type Observation} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type Task} from '@interaction/explorer-plugin';
import {routeRetryEligibility} from '../../../../../packages/explorer-plugin/src/obligation-lifecycle.js';
import {recoveryFailureCondition} from '../../../../../packages/explorer-plugin/src/recovery-failure.js';

const root=resolve(import.meta.dirname,'../../../../..'),out=import.meta.dirname;
const frozen=join(root,'.data/okx-storage-acceptance-20261017-v1-frozen-4');
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const sourceFiles=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','packages'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(p=>p.includes('/src/')&&/\.tsx?$/.test(p)).sort();
const sourceHashes=Object.fromEntries(sourceFiles.map(p=>[p,sha(readFileSync(join(root,p)))]));
const sourceTreeSha256=sha(JSON.stringify(sourceHashes));
const rawFiles=['task-before.json','recovery-diagnosis.json'];
const rawHashes=Object.fromEntries(rawFiles.map(p=>[p,sha(readFileSync(join(out,p)))]));
const inputs=['engine/engine.sqlite','plugin/explorer.sqlite'];
const inputHashes=Object.fromEntries(inputs.map(p=>[p,sha(readFileSync(join(frozen,p)))]));
const temp=mkdtempSync(join(tmpdir(),'okx-run4-failure-validation-'));
for(const folder of ['engine','plugin'])mkdirSync(join(temp,folder));
for(const path of inputs)copyFileSync(join(frozen,path),join(temp,path));
let browserStarts=0,networkCalls=0,forbiddenHostCalls=0;
const previousStart=BrowserAdapter.prototype.start,previousFetch=globalThis.fetch;
BrowserAdapter.prototype.start=async()=>{browserStarts++;throw Error('FORBIDDEN_BROWSER_START');};
globalThis.fetch=async()=>{networkCalls++;throw Error('FORBIDDEN_NETWORK');};
const store=new SqliteStore(join(temp,'engine')),engine=new BrowserEngine({persistence:store});
const readMethods=new Set(['observation','actions','list','session','interactionTransition']);
const hostCalls:Record<string,number>={};
const host=new Proxy(engine,{get(target,key){
 const value=Reflect.get(target,key,target);
 if(typeof value!=='function')return value;
 return (...args:unknown[])=>{
  const name=String(key);hostCalls[name]=(hostCalls[name]||0)+1;
  if(!readMethods.has(name)){forbiddenHostCalls++;throw Error(`FORBIDDEN_HOST_METHOD:${name}`);}
  return value.apply(target,args);
 };
}}) as unknown as ExplorerHost;
const pluginStore=new ExplorerStore(join(temp,'plugin/explorer.sqlite')),plugin=new ExplorerPlugin(host,pluginStore);
const baseline=JSON.parse(readFileSync(join(out,'recovery-diagnosis.json'),'utf8'));
const before=JSON.parse(readFileSync(join(out,'task-before.json'),'utf8')) as Task;
const itemId='93cb64e4-ff77-4bdd-85f2-bd5bc01007b6',rootId='bf26248e-e22f-4c69-80b0-1e4edfe65dca';
const routeKey='4781b6c8347fe7977def58b6636fb39c8f1c8f0d8582dd8e1123dce010069d29';
const entryCondition='a1a0eef525eeba31e0a479f73e7ff106f4fa052469fb38a2c969b8e699edd3d4';
const landingCondition='613636bec2298b894b26fcc0bd8d6988679dcdf22c7e3b5520c0378b2fac5bcb';
const sid=before.rounds.at(-1)!.sessionId,current=engine.observation(sid,'9ca9a659-c1af-47c6-af1c-40b77b5803a3'),actions=engine.actions(sid,current.id);
const subset=()=>{const task=structuredClone(before);task.plan=task.plan.filter(item=>[itemId,rootId].includes(item.id));if(task.obligations)task.obligations.entries=task.obligations.entries.filter(e=>[itemId,rootId].includes(e.itemId));return task;};
const select=(task:Task)=>(plugin as any).scheduledRecovery(task,task.rounds.at(-1),current,actions,{observationId:current.id,actions:[]},(plugin as any).routeConditionReader(current,actions));
const allEvents=()=>{const result:ReturnType<ExplorerStore['events']>=[];for(;;){const batch=pluginStore.events(before.id,result.at(-1)?.sequence??0,1000);result.push(...batch);if(batch.length<1000)return result;}};
try{
 const task=subset(),planBefore=JSON.stringify(task.plan),originalRecord=structuredClone(task.routeRetries!.routes[routeKey].conditions[entryCondition]);
 const eventCursor=allEvents().at(-1)!.sequence;
 const condition=(plugin as any).routeConditionReader(current,actions)(task.scheduling!.routes[routeKey]);
 assert.equal(condition,landingCondition);
 assert.deepEqual(baseline.eligibilityAgainstBefore,{allowed:true,reason:'new_condition',attempts:0});
 const beforeEligibility=routeRetryEligibility(task.routeRetries,routeKey,condition);
 const selected=select(task);assert.equal(selected,undefined);
 const record=task.routeRetries!.routes[routeKey].conditions[entryCondition];
 const {resultCondition,...retainedOriginal}=record;
 assert.deepEqual(retainedOriginal,originalRecord);
 assert.equal(resultCondition?.conditionVersion,landingCondition);
 assert.equal(resultCondition?.basis,'replay-target-unavailable');
 assert.equal(resultCondition?.evidence.observationId,'cfc205c1-bab5-4b44-8bc7-9d2b4c498948');
 assert.equal(record.attempts,1);
 assert.deepEqual(Object.keys(task.routeRetries!.routes[routeKey].conditions),[entryCondition]);
 const afterEligibility=routeRetryEligibility(task.routeRetries,routeKey,condition);
 assert.deepEqual(afterEligibility,{allowed:false,reason:'failed_result_condition',attempts:0});
 assert.equal(task.scheduling!.deferred![itemId].reason,'route_retry_failed_result_condition');
 assert.equal(JSON.stringify(task.plan),planBefore);
 const ledgerFirst=JSON.stringify(task.routeRetries),eventsFirst=allEvents().filter(e=>e.sequence>eventCursor);
 assert.equal(select(task),undefined);assert.equal(JSON.stringify(task.routeRetries),ledgerFirst);
 const eventsSecond=allEvents().filter(e=>e.sequence>eventCursor);
 assert.equal(eventsSecond.length,eventsFirst.length);

 // The observation and reason below are real. Only their association with the
 // old Wallet ledger is counterfactual, to isolate the migration boundary.
 const final=engine.observation(sid,'c4fae20b-a313-48bb-a1f6-22f793550193');
 const pureReason='Entry replay verification: UNVERIFIED';
 assert.equal(final.stable,false);assert.equal(recoveryFailureCondition(final,landingCondition,pureReason),undefined);
 const unstableTask=subset(),unstableRecord=unstableTask.routeRetries!.routes[routeKey].conditions[entryCondition];
 unstableRecord.reason=pureReason;unstableRecord.evidence={sessionId:sid,observationId:final.id};
 unstableTask.scheduling!.routes[routeKey].failure!.reason=pureReason;
 const unstableSelected=select(unstableTask);
 assert.equal(unstableSelected?.itemId,itemId);assert.equal(unstableSelected?.routeKey,routeKey);
 assert.equal(unstableTask.routeRetries!.routes[routeKey].conditions[entryCondition].resultCondition,undefined);
 assert.equal(unstableTask.routeRetries!.routes[routeKey].failedResultConditions,undefined);
 assert.equal(unstableTask.routeRetries!.routes[routeKey].conditions[entryCondition].attempts,1);

 const originalsUnchanged=inputs.every(p=>sha(readFileSync(join(frozen,p)))===inputHashes[p]);
 const rawUnchanged=rawFiles.every(p=>sha(readFileSync(join(out,p)))===rawHashes[p]);
 const sourcesUnchanged=sourceFiles.every(p=>sha(readFileSync(join(root,p)))===sourceHashes[p]);
 assert.equal(originalsUnchanged,true);assert.equal(rawUnchanged,true);assert.equal(sourcesUnchanged,true);
 assert.equal(browserStarts,0);assert.equal(networkCalls,0);assert.equal(forbiddenHostCalls,0);
 const result={protocol:'run4-failure-condition-validation-v1',at:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceTreeSha256,sourceHashes,sourcesUnchanged,
  scope:{frozen,temporary:temp,originalDatabaseConnections:0,frozenDatabaseConnections:0,scriptOnlyCopies:true,browserStarts,networkCalls,forbiddenHostCalls,hostCalls,
   subset:{task:before.id,planItemIds:[rootId,itemId],currentObservationId:current.id,availability:'Empty read-only availability is sufficient for the absent Wallet target. This is scheduledRecovery only, not full-step execution or historical fresh-work eligibility.'}},
  inputHashes,rawHashes,originalsUnchanged,rawUnchanged,
  baselineOldDecision:baseline.eligibilityAgainstBefore,beforeEligibility,afterEligibility,
  legacy:{selected:null,recordBefore:originalRecord,recordAfter:record,failedResultConditions:task.routeRetries!.routes[routeKey].failedResultConditions,attemptCountUnchanged:true,startingConditionCount:1,planUnchanged:JSON.stringify(task.plan)===planBefore,itemStatus:task.plan.find(i=>i.id===itemId)!.status,deferred:task.scheduling!.deferred![itemId],events:eventsFirst,idempotentLedger:true,idempotentEvents:true},
  solelyUnstable:{observationId:final.id,stable:final.stable,criticalGaps:final.gaps.filter(g=>g.critical),interactionStable:final.gaps.some(g=>g.code==='INTERACTION_STABLE'),reason:pureReason,helperResult:null,
   counterfactualLedgerAssociation:true,explanation:'Real run4 final observation/reason substituted into the original Wallet retry record solely to exercise the migration guard; this is not a claim that the historic ledger had that association.',
   scheduledItemId:unstableSelected.itemId,scheduledRouteKey:unstableSelected.routeKey,retainedAlias:false,attempts:unstableTask.routeRetries!.routes[routeKey].conditions[entryCondition].attempts,dispatched:false}};
 writeFileSync(join(out,'failure-condition-validation.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({report:join(out,'failure-condition-validation.json'),sourceTreeSha256,beforeEligibility,afterEligibility,planUnchanged:result.legacy.planUnchanged,idempotent:true,solelyUnstableAlias:false,browserStarts,networkCalls,forbiddenHostCalls,originalsUnchanged,rawUnchanged,sourcesUnchanged},null,2));
}finally{
 await plugin.close();await engine.close();BrowserAdapter.prototype.start=previousStart;globalThis.fetch=previousFetch;rmSync(temp,{recursive:true,force:true});
}
