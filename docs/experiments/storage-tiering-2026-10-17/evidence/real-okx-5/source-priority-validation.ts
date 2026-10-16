/** No dispatch: compare frozen baseline/patched scheduler reads and selections. */
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {BrowserAdapter,BrowserEngine} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerPlugin,ExplorerStore,type ExplorerHost,type Task} from '@interaction/explorer-plugin';
import {digest} from '../../../../../packages/explorer-plugin/src/policy.js';
const root=resolve(import.meta.dirname,'../../../../..'),out=import.meta.dirname,frozen=join(root,'.data/okx-storage-acceptance-20261017-v1-frozen-5');
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),hash=(p:string)=>sha(readFileSync(p));
const runtimePath='packages/explorer-plugin/src/runtime.ts',patchedRuntimeSha=hash(join(root,runtimePath)),baselineHead='de88210e0b50d6c851569c2de1bcb254f3ff430b';
const baseline=execFileSync('git',['show',`${baselineHead}:${runtimePath}`],{cwd:root,encoding:'utf8'}),helpers:Record<string,string>={};
const rewritten=baseline.replace(/from '(\.\/[^']+)';/g,(_all,relative:string)=>{const p=`packages/explorer-plugin/src/${relative.slice(2).replace(/\.js$/,'.ts')}`,expected=sha(execFileSync('git',['show',`${baselineHead}:${p}`],{cwd:root}));assert.equal(hash(join(root,p)),expected);helpers[p]=expected;return `from '${pathToFileURL(join(root,p)).href}';`;});
const originalFiles=['engine/engine.sqlite','plugin/explorer.sqlite'],originalHashes=Object.fromEntries(originalFiles.map(p=>[p,hash(join(frozen,p))]));
const rawFiles=['task-before.json','task-after.json','summary.json'],rawHashes=Object.fromEntries(rawFiles.map(p=>[p,hash(join(out,p))]));
const material=JSON.parse(readFileSync(JSON.parse(readFileSync(join(out,'plan-source-extraction.json'),'utf8')).material,'utf8'));
const temporary=mkdtempSync(join(tmpdir(),'okx-run5-priority-validation-'));cpSync(frozen,join(temporary,'full'),{recursive:true});
writeFileSync(join(temporary,'runtime-de88210.mts'),rewritten);symlinkSync(join(root,'node_modules'),join(temporary,'node_modules'),'dir');
const {ExplorerPlugin:BaselineExplorerPlugin}=await import(pathToFileURL(join(temporary,'runtime-de88210.mts')).href);
let browserCalls=0,networkCalls=0,forbiddenCalls=0;const oldStart=BrowserAdapter.prototype.start,oldFetch=globalThis.fetch;
BrowserAdapter.prototype.start=async()=>{browserCalls++;throw Error('FORBIDDEN_BROWSER');};globalThis.fetch=async()=>{networkCalls++;throw Error('FORBIDDEN_NETWORK');};
const persistence=new SqliteStore(join(temporary,'full/engine')),engine=new BrowserEngine({persistence}),plugins:ExplorerPlugin[]=[];
try{
 const after=material.after as Task,before=material.before as Task,events=material.events as any[],selected=events.find(e=>e.type==='recovery.selected').data,lastCurrent=events.filter(e=>e.type==='obligation.selected'&&e.data.kind==='current').at(-1)!.data;
 const rootId='bf26248e-e22f-4c69-80b0-1e4edfe65dca',sid=after.rounds.at(-1)!.sessionId,o=engine.observation(sid,selected.currentObservationId),actions=engine.actions(sid,o.id);
 const taskBefore=()=>{const task=structuredClone(after);task.plan=task.plan.filter(i=>i.reason!=='checkpoint_unverified'||before.plan.some(old=>old.id===i.id));delete task.routeRetries!.routes[selected.routeKey];delete task.scheduling!.routes[selected.routeKey];task.scheduling!.cursor=lastCurrent.itemId;task.scheduling!.selection={itemId:lastCurrent.itemId,kind:'current',actionId:lastCurrent.actionId,source:lastCurrent.source};task.scheduling!.localSelections=3;task.rounds.at(-1)!.position={sessionId:sid,observationId:o.id,instanceScope:o.instanceScope,url:o.url,contextKey:digest(o.context),boundaryKeys:o.boundaries?.map(b=>b.key)||[]};return task;};
 const run=(name:string,Plugin:any,pageOnly=false)=>{
  const task=taskBefore();if(pageOnly)task.plan=task.plan.filter(i=>i.id===rootId);assert(task.plan.filter(i=>i.required).every(i=>i.scope.url!==o.url));
  const calls:{method:string;observationId?:string;kind?:string;beforeId?:string;afterId?:string}[]=[],allowed=new Set(['observation','actions','list','session','interactionTransition']);
  const host=new Proxy(engine,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return (...args:any[])=>{const method=String(key);if(!allowed.has(method)){forbiddenCalls++;throw Error(`FORBIDDEN_HOST:${method}`);}calls.push({method,...['observation','actions'].includes(method)?{observationId:args[1]}:{},...method==='list'?{kind:args[1]}:{},...method==='interactionTransition'?{beforeId:args[1],afterId:args[2]}:{}});return value.apply(target,args);};}}) as unknown as ExplorerHost;
  const plugin=new Plugin(host,new ExplorerStore(':memory:'));plugins.push(plugin);const planJson=JSON.stringify(task.plan),debtJson=JSON.stringify(task.routeRetries),routes=structuredClone(task.scheduling!.routes);
  const result=(plugin as any).scheduledRecovery(task,task.rounds.at(-1),o,actions,{observationId:o.id,actions:[]},(plugin as any).routeConditionReader(o,actions));
  assert.equal(JSON.stringify(task.plan),planJson);assert.equal(JSON.stringify(task.routeRetries),debtJson);
  const routeAnchorRefreshes:{key:string;before:{observationId:string;checkpointId?:string};after:{observationId:string;checkpointId?:string}}[]=[];
  for(const [key,route] of Object.entries(routes)){
   const next=task.scheduling!.routes[key];assert(next);
   if(key===result?.routeKey){
    const {observationId:oldObservationId,checkpointId:oldCheckpointId,...oldSemantic}=route;
    const {observationId:newObservationId,checkpointId:newCheckpointId,...newSemantic}=next;
    assert.deepEqual(newSemantic,oldSemantic);
    if(oldObservationId!==newObservationId||oldCheckpointId!==newCheckpointId)routeAnchorRefreshes.push({key,before:{observationId:oldObservationId,checkpointId:oldCheckpointId},after:{observationId:newObservationId,checkpointId:newCheckpointId}});
   }else assert.deepEqual(next,route);
  }
  const counts=Object.fromEntries([...new Set(calls.map(c=>c.method))].map(method=>[method,calls.filter(c=>c.method===method).length]));
  const uniqueIds=Object.fromEntries(['observation','actions'].map(method=>[method,[...new Set(calls.filter(c=>c.method===method).map(c=>c.observationId))]]));
  return {name,pageOnly,planRows:task.plan.length,selected:{itemId:result?.itemId,sourceObservationId:result?.source.id,checkpointId:result?.frame.checkpointId,returnToSource:result?.returnToSource,routeKey:result?.routeKey},counts,uniqueIds,calls,planUnchanged:true,allOldRetryDebtUnchanged:true,allOldRouteSemanticsUnchanged:true,allNonselectedOldRoutesUnchanged:true,routeAnchorRefreshes,oldRouteCount:Object.keys(routes).length,newRoutes:Object.entries(task.scheduling!.routes).filter(([key])=>!(key in routes)).map(([key,route])=>({key,...route}))};
 };
 const baselineFull=run('de88210 full plan',BaselineExplorerPlugin),baselinePage=run('de88210 page-only qualification',BaselineExplorerPlugin,true),patchedFull=run('patched full plan',ExplorerPlugin),patchedPage=run('patched page-only qualification',ExplorerPlugin,true);
 assert.equal(baselineFull.selected.itemId,selected.itemId);for(const row of [baselinePage,patchedFull,patchedPage]){assert.equal(row.selected.itemId,rootId);assert.equal(row.selected.sourceObservationId,'fe3ed5c7-d5dd-4c76-9628-870ddb441ee9');assert.equal(row.selected.checkpointId,'36360018-2a62-475d-80a5-b8d375c0b9e9');assert.equal(row.selected.returnToSource,true);}
 assert(!patchedFull.newRoutes.some(route=>route.itemIds.includes(selected.itemId)));assert.equal(hash(join(root,runtimePath)),patchedRuntimeSha);assert(Object.entries(helpers).every(([p,h])=>hash(join(root,p))===h));assert(Object.entries(originalHashes).every(([p,h])=>hash(join(frozen,p))===h));assert(Object.entries(rawHashes).every(([p,h])=>hash(join(out,p))===h));assert.equal(browserCalls+networkCalls+forbiddenCalls,0);
 const report={protocol:'run5-source-priority-validation-v1',baseline:{head:baselineHead,runtimeSha256:sha(baseline),relativeHelpersMatchBaseline:helpers},patched:{head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirtyRuntimeSha256:patchedRuntimeSha,unchangedDuringReplay:true},integrity:{originalHashes,rawHashes,allUnchanged:true,completePrivateCopy:true,taskStateChanges:'memory only',browserCalls,networkCalls,providerCalls:0,forbiddenCalls},reconstruction:'Same reconstruction as plan-source-diagnosis: remove only the post-selection failed route/retry and gap, restore cursor to announced; retain successes and all old debt. Availability irrelevant for remote scopes because every required target URL differs from help.',cases:[baselineFull,baselinePage,patchedFull,patchedPage],limits:['Source-position candidate only; no browser/history execution or successful arrival asserted.','Read counts, not elapsed-time benchmark. All cases use the same immutable input and reader implementation.','Early eligible native candidates reduce reads here; no fixed upper bound is asserted if many candidates are invalid or no native source exists.']};
 writeFileSync(join(out,'source-priority-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({patchedRuntimeSha,cases:report.cases.map(r=>({name:r.name,selected:r.selected,counts:r.counts,uniqueCounts:Object.fromEntries(Object.entries(r.uniqueIds).map(([k,v])=>[k,(v as unknown[]).length])),planUnchanged:r.planUnchanged,debtUnchanged:r.allOldRetryDebtUnchanged,oldRouteSemanticsUnchanged:r.allOldRouteSemanticsUnchanged,routeAnchorRefreshes:r.routeAnchorRefreshes,newRouteKeys:r.newRoutes.map(x=>x.key)})),integrity:report.integrity},null,2));
}finally{for(const plugin of plugins)await plugin.close();await engine.close();BrowserAdapter.prototype.start=oldStart;globalThis.fetch=oldFetch;rmSync(temporary,{recursive:true,force:true});}
