// Archived prototype experiment: first apply pending-operation-prototype/prototype.patch in an isolated checkout. The current product deliberately omits this prototype.
/** Frozen-data accounting plus a focused two-frame operation audit. Copies only;
 * all action execution, browser startup and network methods are forbidden. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {BrowserAdapter,BrowserEngine} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerPlugin,ExplorerStore,type Task,type PlanItem,type ExplorerHost} from '@interaction/explorer-plugin';
import {digest,keyFor,scopeFor} from '../../../../../packages/explorer-plugin/src/policy.js';

const root=resolve(import.meta.dirname,'../../../../..'),out=import.meta.dirname,frozen=join(root,'.data/okx-storage-acceptance-20261017-v1-frozen-4');
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const sourcePaths=['packages/explorer-plugin/src/pending-operation.ts','packages/explorer-plugin/src/runtime.ts','packages/explorer-plugin/src/policy.ts','packages/explorer-plugin/src/obligation-lifecycle.ts'];
const sourceHashes=Object.fromEntries(sourcePaths.map(p=>[p,hash(readFileSync(join(root,p)))]));
const rawPaths=['task-before.json','task-after.json'];
const rawHashes=Object.fromEntries(rawPaths.map(p=>[p,hash(readFileSync(join(out,p)))]));
const inputPaths=['engine/engine.sqlite','plugin/explorer.sqlite'];
const inputHashes=Object.fromEntries(inputPaths.map(p=>[p,hash(readFileSync(join(frozen,p)))]));
const before=JSON.parse(readFileSync(join(out,'task-before.json'),'utf8')) as Task,after=JSON.parse(readFileSync(join(out,'task-after.json'),'utf8')) as Task;
const oldIds=new Set(before.plan.map(i=>i.id)),added=after.plan.filter(i=>!oldIds.has(i.id));
const count=(items:PlanItem[],field:(i:PlanItem)=>string)=>Object.fromEntries([...items.reduce((m,i)=>m.set(field(i),(m.get(field(i))||0)+1),new Map<string,number>())].sort(([a],[b])=>a.localeCompare(b)));
const groupKey=(item:PlanItem)=>digest({scope:item.scope,condition:item.operationConditionKey,policy:item.operationConditionPolicy,required:item.required,dispatch:item.dispatchScope,path:item.prerequisites});
const groups=new Map<string,PlanItem[]>();for(const item of after.plan){const key=groupKey(item),items=groups.get(key)||[];items.push(item);groups.set(key,items);}
const paired=[...groups].filter(([,items])=>items.some(i=>i.reason==='observed_in_scope')&&items.some(i=>i.reason==='operation_not_executed'));
const unfinished=paired.filter(([,items])=>items.some(i=>i.reason==='observed_in_scope'&&i.status==='pending'&&!i.attempts.length)&&items.some(i=>i.reason==='operation_not_executed'&&i.status==='unresolved'&&!i.attempts.length));
const samples=paired.filter(([,items])=>['1W','1h','24h','Trade'].includes(String(items[0].scope.label))).map(([key,items])=>({key,items:items.map(i=>({id:i.id,scope:i.scope,reason:i.reason,status:i.status,attempts:i.attempts,evidence:i.evidence}))}));
const temp=mkdtempSync(join(tmpdir(),'okx-plan-growth-diagnosis-'));
for(const folder of ['engine','plugin'])mkdirSync(join(temp,folder));for(const path of inputPaths)copyFileSync(join(frozen,path),join(temp,path));
let browserStarts=0,networkCalls=0,forbiddenHostCalls=0;const oldStart=BrowserAdapter.prototype.start,oldFetch=globalThis.fetch;
BrowserAdapter.prototype.start=async()=>{browserStarts++;throw Error('FORBIDDEN_BROWSER');};globalThis.fetch=async()=>{networkCalls++;throw Error('FORBIDDEN_NETWORK');};
const store=new SqliteStore(join(temp,'engine')),engine=new BrowserEngine({persistence:store}),eventStore=new ExplorerStore(join(temp,'plugin/explorer.sqlite'));
const readMethods=new Set(['observation','actions','session']),hostCalls:Record<string,number>={};
const host=new Proxy(engine,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return (...args:unknown[])=>{const name=String(key);hostCalls[name]=(hostCalls[name]||0)+1;if(!readMethods.has(name)){forbiddenHostCalls++;throw Error(`FORBIDDEN_HOST_METHOD:${name}`);}return value.apply(target,args);};}}) as unknown as ExplorerHost;
const temporaryPlugins:ExplorerPlugin[]=[];
try{
 const events:ReturnType<ExplorerStore['events']>=[];for(;;){const batch=eventStore.events(after.id,events.at(-1)?.sequence||0,1000);events.push(...batch);if(batch.length<1000)break;}
 const sid=after.rounds.at(-1)!.sessionId,frameIds=['5f80a3df-8355-444a-8499-4a625cb89577','c446073e-8db5-49cd-b6d3-0052622bb861'];
 const discovery=after.plan.find(i=>i.id==='9200acd8-1ca1-4997-a13e-d683206e5e04')!;
 const run=(coalesce:boolean)=>{
  const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'));temporaryPlugins.push(plugin);
  const task=structuredClone(after);task.plan=[structuredClone(after.plan.find(i=>i.id==='bf26248e-e22f-4c69-80b0-1e4edfe65dca')!),structuredClone(discovery)];
  task.plan[0].status='pending';const rootBefore=JSON.stringify(task.plan[0]);task.plan[1].status='pending';task.plan[1].attempts=[];task.plan[1].evidence=[{sessionId:sid,observationId:frameIds[0]}];
  delete task.obligations;delete task.pendingDispatch;delete task.unverifiedNavigations;
  const round=task.rounds.at(-1)!;round.stack=[];round.entryPath=[];round.tried=[];
  const gap=(plugin as any).gap.bind(plugin);
  if(!coalesce)(plugin as any).gap=(...args:any[])=>{args[8]=false;return gap(...args);};
  const frames=[];
  for(const id of frameIds){
   const o=engine.observation(sid,id),actions=engine.actions(sid,id),matches=actions.filter(a=>digest(scopeFor(a,o))===digest(discovery.scope));assert.equal(matches.length,1);
   const action=matches[0],event=events.find(e=>e.type==='scope.audit'&&(e.data as any).observationId===id)!,raw=event.data as any;
   assert(raw.pendingActions.includes(action.id));const fact=raw.operationFacts.find((f:any)=>f.actionId===action.id);assert.equal(fact.executable,true);assert.equal(keyFor(action,o),discovery.operationConditionKey);
   const snapshot={revision:raw.revision,actions,operationCandidates:[action],availability:{observationId:id,sessionId:sid,actions:[fact]},obligations:{criticalGaps:[],regions:[],pageTraversal:false,classifications:[],operations:[],identities:[],discovery:false}};
   (plugin as any).auditRemainingScopes(task,round,o,snapshot,new Set());
   frames.push({observationId:id,scopeAuditSequence:event.sequence,matchingCurrentActions:matches.length,condition:keyFor(action,o),rows:task.plan.length,operationRows:task.plan.filter(i=>i.scope.kind).map(i=>({id:i.id,reason:i.reason,status:i.status,evidence:i.evidence,attempts:i.attempts}))});
  }
  assert.equal(JSON.stringify(task.plan[0]),rootBefore);assert(task.plan.slice(1).every(i=>i.status!=='succeeded'&&!i.attempts.length));return frames;
 };
 const featureDisabled=run(false),sameFrameFix=run(true);
 assert.equal(featureDisabled[0].rows,3);assert.equal(sameFrameFix[0].rows,2);assert.equal(featureDisabled[1].rows,3);assert.equal(sameFrameFix[1].rows,3);
 const sourceUnchanged=sourcePaths.every(p=>hash(readFileSync(join(root,p)))===sourceHashes[p]),inputUnchanged=inputPaths.every(p=>hash(readFileSync(join(frozen,p)))===inputHashes[p]),rawUnchanged=rawPaths.every(p=>hash(readFileSync(join(out,p)))===rawHashes[p]);
 assert(sourceUnchanged&&inputUnchanged&&rawUnchanged);assert.equal(browserStarts+networkCalls+forbiddenHostCalls,0);
 const report={protocol:'run4-plan-growth-diagnosis-v1',at:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceHashes,sourceHash:hash(JSON.stringify(sourceHashes)),inputHashes,rawHashes,sourceUnchanged,inputUnchanged,rawUnchanged,
  scope:{originalDatabaseConnections:0,copiesOnly:true,browserStarts,networkCalls,providerCalls:0,forbiddenHostCalls,hostCalls},
  counts:{before:before.plan.length,after:after.plan.length,added:added.length,statusBefore:count(before.plan,i=>i.status),statusAfter:count(after.plan,i=>i.status),statusAdded:count(added,i=>i.status),reasonAdded:count(added,i=>i.reason),sourceAdded:count(added,i=>i.evidence[0]?.observationId||'none'),kindAdded:count(added,i=>i.scope.kind?'operation':'control-or-other-review'),dispatchAdded:count(added,i=>String(i.dispatchScope))},
  pairedAccounting:{grouping:'Exact scope + condition + condition policy + required + dispatchScope + prerequisites; this diagnostic grouping alone is not identity proof',groups:paired.length,observedRows:paired.flatMap(([,rows])=>rows.filter(i=>i.reason==='observed_in_scope')).length,gapRows:paired.flatMap(([,rows])=>rows.filter(i=>i.reason==='operation_not_executed')).length,unattemptedPendingAndUnresolvedGroups:unfinished.length,allUnfinishedRowsNew:unfinished.every(([,rows])=>rows.filter(i=>['observed_in_scope','operation_not_executed'].includes(i.reason)&&!i.attempts.length).every(i=>!oldIds.has(i.id))),onlyPassiveReasons:paired.filter(([,rows])=>rows.every(i=>['observed_in_scope','operation_not_executed'].includes(i.reason))).length,samples},
  projection:{observationId:after.obligations?.observationId,counts:after.obligations?.counts,lastPlanRows:after.plan.length,entries:after.obligations?.entries.length},
  focusedOfflineAudit:{scope:'Root authority plus real 1W item; actual immutable observations/actions and recorded executable scope.audit facts; empty review facts and empty completed set deliberately isolate duplicate operation registration. Not a full task replay or performance benchmark.',featureDisabledComparator:'Same current runtime with only new gap coalescing disabled; original raw task JSON preserves the actual 868e8b47 behavior.',featureDisabled,sameFrameFix,firstFrameRowsAvoided:1,secondFrameNetRowsAvoided:0,newExecutionOrCoverage:false},
  correspondenceProbe:JSON.parse(readFileSync(join(out,'plan-growth-probe.json'),'utf8')),
  limits:['No cross-observation identity is inferred from keyFor or literal scope. Existing double rows remain, including attempts and unknown debt.','Same-frame reduction does not promise a lower final run4 plan: unverified later-frame correspondence may retain a separate audit gap.','335 unresolved and 181 pending are statuses, not 516 uniquely distinct operations; review and execution obligations retain their different roles.']};
 writeFileSync(join(out,'plan-growth-diagnosis.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({counts:report.counts,paired:{groups:paired.length,unfinished:unfinished.length},firstFrameRowsAvoided:1,secondFrameNetRowsAvoided:0,browserStarts,networkCalls,sourceUnchanged,inputUnchanged,rawUnchanged},null,2));
}finally{for(const plugin of temporaryPlugins)await plugin.close();eventStore.close();await engine.close();BrowserAdapter.prototype.start=oldStart;globalThis.fetch=oldFetch;rmSync(temp,{recursive:true,force:true});}
