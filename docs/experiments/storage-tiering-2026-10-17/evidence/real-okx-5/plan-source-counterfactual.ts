/** In-memory scheduling reconstruction; SDK readers use a complete private copy. */
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {BrowserAdapter,BrowserEngine,browserTargetConditions,classificationCorrespondenceConditions,type Observation,type ActionCandidate} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type Task} from '@interaction/explorer-plugin';
import {orderedObligations} from '../../../../../packages/explorer-plugin/src/obligation-scheduler.js';
import {currentHistoryAnchor} from '../../../../../packages/explorer-plugin/src/review-recovery.js';
import {pageSourceObligation,sourceReturnCondition} from '../../../../../packages/explorer-plugin/src/source-return.js';
import {controlScopeMatcher,scopeFor,digest} from '../../../../../packages/explorer-plugin/src/policy.js';
import {browserBranchConditions} from '../../../../../packages/adapter-playwright/src/branch-conditions.js';
const root=resolve(import.meta.dirname,'../../../../..'),out=import.meta.dirname,frozen=join(root,'.data/okx-storage-acceptance-20261017-v1-frozen-5');
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const paths=['packages/explorer-plugin/src/runtime.ts','packages/explorer-plugin/src/obligation-scheduler.ts','packages/explorer-plugin/src/source-return.ts','packages/explorer-plugin/src/review-recovery.ts','packages/core/src/engine.ts'];
const sources=Object.fromEntries(paths.map(p=>[p,hash(join(root,p))])),inputs=Object.fromEntries(['engine/engine.sqlite','plugin/explorer.sqlite'].map(p=>[p,hash(join(frozen,p))]));
const extracted=JSON.parse(readFileSync(join(out,'plan-source-extraction.json'),'utf8')),material=JSON.parse(readFileSync(extracted.material,'utf8'));
const {before,after,events}=material as {before:Task;after:Task;events:any[]};
const temporary=mkdtempSync(join(tmpdir(),'okx-run5-schedule-copy-'));cpSync(frozen,join(temporary,'full'),{recursive:true});
const baselineHead='de88210e0b50d6c851569c2de1bcb254f3ff430b',baselineRuntime=execFileSync('git',['show',`${baselineHead}:packages/explorer-plugin/src/runtime.ts`],{cwd:root,encoding:'utf8'});
const helperHashes:Record<string,string>={};
const rewritten=baselineRuntime.replace(/from '(\.\/[^']+)';/g,(all,relative:string)=>{
 const path=`packages/explorer-plugin/src/${relative.slice(2).replace(/\.js$/,'.ts')}`,expected=createHash('sha256').update(execFileSync('git',['show',`${baselineHead}:${path}`],{cwd:root})).digest('hex');
 assert.equal(hash(join(root,path)),expected,`baseline helper changed: ${path}`);helperHashes[path]=expected;
 return `from '${pathToFileURL(join(root,path)).href}';`;
});
writeFileSync(join(temporary,'runtime-de88210.mts'),rewritten);symlinkSync(join(root,'node_modules'),join(temporary,'node_modules'),'dir');
const {ExplorerPlugin:BaselineExplorerPlugin}=await import(pathToFileURL(join(temporary,'runtime-de88210.mts')).href);
let browserCalls=0,networkCalls=0,forbiddenHostCalls=0;const previousStart=BrowserAdapter.prototype.start,previousFetch=globalThis.fetch;
BrowserAdapter.prototype.start=async()=>{browserCalls++;throw Error('FORBIDDEN_BROWSER');};globalThis.fetch=async()=>{networkCalls++;throw Error('FORBIDDEN_NETWORK');};
const store=new SqliteStore(join(temporary,'full/engine')),engine=new BrowserEngine({persistence:store});
const allowed=new Set(['observation','actions','list','session','interactionTransition']),calls:Record<string,number>={};
const host=new Proxy(engine,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return (...args:unknown[])=>{const name=String(key);calls[name]=(calls[name]||0)+1;if(!allowed.has(name)){forbiddenHostCalls++;throw Error(`FORBIDDEN_HOST_METHOD:${name}`);}return value.apply(target,args);};}}) as unknown as ExplorerHost;
const plugins:ExplorerPlugin[]=[];
try{
 const selectedEvent=events.find(e=>e.type==='recovery.selected'),selectedId=selectedEvent.data.itemId,routeKey=selectedEvent.data.routeKey;
 const sid=after.rounds.at(-1)!.sessionId,current=engine.observation(sid,selectedEvent.data.currentObservationId),actions=engine.actions(sid,current.id),rootId='bf26248e-e22f-4c69-80b0-1e4edfe65dca';
 const previousSelection=events.filter(e=>e.type==='obligation.selected'&&e.data.kind==='current').at(-1)!.data;
 const reconstruct=()=>{
  const task=structuredClone(after);task.plan=task.plan.filter(i=>i.reason!=='checkpoint_unverified'||before.plan.some(b=>b.id===i.id));
  // Only undo the recovery selected after d4d54ab3. Preserve all three real
  // successful actions, newly retained sources/waits and pre-existing debt.
  delete task.routeRetries!.routes[routeKey];delete task.scheduling!.routes[routeKey];
  task.scheduling!.cursor=previousSelection.itemId;task.scheduling!.selection={itemId:previousSelection.itemId,kind:'current',actionId:previousSelection.actionId,source:previousSelection.source};task.scheduling!.localSelections=3;
  task.rounds.at(-1)!.position={sessionId:sid,observationId:current.id,instanceScope:current.instanceScope,url:current.url,contextKey:digest(current.context),boundaryKeys:current.boundaries?.map(b=>b.key)||[]};
  return task;
 };
 const run=(mode:'original'|'omit-selected-review'|'page-authority-only')=>{
  const task=reconstruct();if(mode==='omit-selected-review')task.plan=task.plan.filter(i=>i.id!==selectedId);if(mode==='page-authority-only')task.plan=task.plan.filter(i=>i.id===rootId);
  assert(task.plan.filter(i=>i.required).every(i=>i.scope.url!==current.url));
  const plugin=new BaselineExplorerPlugin(host,new ExplorerStore(':memory:'));plugins.push(plugin);const planBefore=JSON.stringify(task.plan),ordered=orderedObligations(task.plan,task.scheduling!);
  const result=(plugin as any).scheduledRecovery(task,task.rounds.at(-1),current,actions,{observationId:current.id,actions:[]},(plugin as any).routeConditionReader(current,actions));
  assert.equal(JSON.stringify(task.plan),planBefore);
  return {mode,planRows:task.plan.length,rootOrderedIndex:ordered.findIndex(i=>i.id===rootId),firstOrdered:ordered.slice(0,5).map(i=>({id:i.id,reason:i.reason,scope:i.scope})),selected:result&&{itemId:result.itemId,checkpointId:result.frame.checkpointId,sourceObservationId:result.source.id,returnToSource:result.returnToSource,routeKey:result.routeKey,conditionVersion:result.conditionVersion,targetActionIds:result.targetActionIds,path:result.frame.path},rootDeferred:task.scheduling?.deferred?.[rootId],planUnchanged:true};
 };
 const replay=run('original');assert.equal(replay.selected?.itemId,selectedId);assert.equal(replay.selected?.sourceObservationId,'d0b567f7-791f-49b5-9a0d-80a6cd81ed35');
 const withoutUsd=run('omit-selected-review'),page=run('page-authority-only');assert.equal(page.selected?.returnToSource,true);assert.equal(page.selected?.sourceObservationId,'fe3ed5c7-d5dd-4c76-9628-870ddb441ee9');assert.equal(page.selected?.checkpointId,'36360018-2a62-475d-80a5-b8d375c0b9e9');
 const item=after.plan.find(i=>i.id===selectedId)!,rootItem=after.plan.find(i=>i.id===rootId)!;
 const frameFacts=Object.values(material.observations as Record<string,Observation>).map(o=>{
  const matches=controlScopeMatcher(o,material.actions[o.id]||[]),targets=o.controls.filter(c=>matches(item.scope,c)),boundary=o.boundaries?.at(-1),overlay=boundary&&o.overlays?.find(v=>v.key===boundary.key);
  return {id:o.id,url:o.url,stable:o.stable,navigation:o.navigation,context:o.context,boundaries:o.boundaries,historyAnchor:currentHistoryAnchor(o,current),sourceReturnCondition:sourceReturnCondition(o,current),checkpoints:material.checkpoints.filter((cp:any)=>cp.observationId===o.id).map((cp:any)=>({id:cp.id,path:cp.path})),usdTargets:targets.map(c=>({localId:c.localId,instanceId:c.instanceId,name:c.name,role:c.role,visible:c.visible,enabled:c.enabled,hypothesisId:c.hypothesisId,insideActiveBoundary:!boundary||!!overlay?.controlIds.includes(c.localId),classification:classificationCorrespondenceConditions(c,o)}))};
 });
 const attemptFacts=material.attempts.map((a:any)=>{const o=material.observations[a.beforeId] as Observation;return {id:a.id,status:a.status,beforeId:a.beforeId,afterId:a.afterId,kind:a.action.kind,label:a.action.label,value:a.action.value,instanceScope:o.instanceScope,localId:a.action.localId,branchAvailable:!!browserBranchConditions(a.action,o),targetConditionsAvailable:!!browserTargetConditions(a.action,o),sourceScope:scopeFor(a.action,o)};});
 const first=material.attempts[0],later=engine.observation(sid,'fe3ed5c7-d5dd-4c76-9628-870ddb441ee9'),candidates=engine.actions(sid,later.id).filter(a=>a.kind===first.action.kind&&a.value===first.action.value&&a.localId===first.action.localId);
 const sameInstanceCoverage=candidates.map(action=>engine.operationCorrespondence(sid,{observationId:later.id,actionId:action.id,source:{sessionId:sid,attemptId:first.id}}));
 assert.equal(candidates.length,1);assert.equal(sameInstanceCoverage[0].equivalent,false);assert.equal(sameInstanceCoverage[0].reason,'operation_conditions_unavailable');
 const result={protocol:'run5-plan-source-diagnosis-v1',head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),baseline:{head:baselineHead,runtimeSha256:createHash('sha256').update(baselineRuntime).digest('hex'),runtimeLoadedFrom:'private temporary module; only relative import locations rewritten',helpersCheckedAgainstBaseline:helperHashes,workingTreeRuntimeNotUsed:true},sourceHashes:sources,inputHashes:inputs,integrity:{completePrivateFrozenCopy:true,pluginStore:'memory only',sourceInputsUnchanged:paths.filter(p=>!p.endsWith('/runtime.ts')).every(p=>hash(join(root,p))===sources[p])&&Object.entries(helperHashes).every(([p,h])=>hash(join(root,p))===h)&&Object.entries(inputs).every(([p,h])=>hash(join(frozen,p))===h),browserCalls,networkCalls,forbiddenHostCalls,providerCalls:0,hostCalls:calls},reconstruction:{description:'Final task minus the one new failed recovery route/retry and post-failure checkpoint gap; restore cursor to real last current selection. All 3 successes and source/wait updates preserved. No original or copied file task store is edited.',availability:'Empty facts are sufficient for this remote-only replay: every required plan scope URL differs from current help URL; current matching actions cannot affect the original-page candidates.',previousSelection},selectedItem:item,root:{id:rootId,status:rootItem.status,pageSourceObligation:pageSourceObligation(rootItem),directSources:rootItem.evidence.filter(ref=>!ref.attemptId).length},counterfactuals:[replay,withoutUsd,page],frames:frameFacts,attempts:attemptFacts,sameInstanceSuccessfulEvidence:{scope:'Read-only public operationCorrespondence; first check=true success vs same instance check=true after check=false',sameInstance:first.action.localId===candidates[0].localId,sourceAttemptId:first.id,targetObservationId:later.id,results:sameInstanceCoverage},selectedCheckpoint:material.checkpoints.find((cp:any)=>cp.id===selectedEvent.data.checkpointId),counts:{before:before.plan.length,after:after.plan.length,added:after.plan.filter(i=>!before.plan.some(b=>b.id===i.id)).map(i=>({id:i.id,status:i.status,reason:i.reason,scope:i.scope,attempts:i.attempts}))},events:events.filter(e=>['action.selected','obligation.selected','recovery.selected','recovery.result','obligation.route_unavailable','review.source_retained','review.recovery_waiting'].includes(e.type))};
 assert(result.integrity.sourceInputsUnchanged);assert.equal(browserCalls+networkCalls+forbiddenHostCalls,0);writeFileSync(join(out,'plan-source-diagnosis.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({counterfactuals:result.counterfactuals,attempts:attemptFacts,sameInstanceCoverage:result.sameInstanceSuccessfulEvidence,frames:frameFacts.map(o=>({id:o.id,anchor:o.historyAnchor,condition:!!o.sourceReturnCondition,usd:o.usdTargets.map(t=>({visible:t.visible,active:t.insideActiveBoundary,projection:!!t.classification}))})),integrity:result.integrity},null,2));
}finally{for(const plugin of plugins)await plugin.close();await engine.close();BrowserAdapter.prototype.start=previousStart;globalThis.fetch=previousFetch;rmSync(temporary,{recursive:true,force:true});}
