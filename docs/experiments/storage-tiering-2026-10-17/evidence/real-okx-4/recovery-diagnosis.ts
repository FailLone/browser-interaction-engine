/** Offline forensic reader. Frozen inputs are copied; SDK runs only on private
 * copies and BrowserAdapter.start is forbidden. No browser/provider calls. */
import {createHash} from 'node:crypto';
import {copyFileSync,mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {BrowserAdapter,BrowserEngine,type Observation,type ActionCandidate} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerPlugin,ExplorerStore,type Task} from '@interaction/explorer-plugin';
import {controlInScope,matches,digest} from '../../../../../packages/explorer-plugin/src/policy.js';
import {recoveryRouteConditionVersion,recoveryConditionVersion,routeRetryEligibility} from '../../../../../packages/explorer-plugin/src/obligation-lifecycle.js';
const root=resolve(import.meta.dirname,'../../../../..'),frozen=join(root,'.data/okx-storage-acceptance-20261017-v1-frozen-4'),out=import.meta.dirname,temp=mkdtempSync(join(tmpdir(),'okx-run4-recovery-'));
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const sourceFiles=['packages/explorer-plugin/src/runtime.ts','packages/explorer-plugin/src/obligation-lifecycle.ts','packages/core/src/engine.ts','packages/explorer-plugin/src/source-return.ts'];
const baselineHead='868e8b47afd31782161deba4f8bd7a14e0349430';
const sourceHashes=Object.fromEntries(sourceFiles.map(p=>[p,sha(readFileSync(join(root,p)))]));
for(const p of sourceFiles)if(sourceHashes[p]!==sha(execFileSync('git',['show',`${baselineHead}:${p}`],{cwd:root})))throw Error(`Source is no longer the forensic baseline: ${p}`);
const inputs=['engine/engine.sqlite','plugin/explorer.sqlite'];
const beforeHashes=Object.fromEntries(inputs.map(p=>[p,sha(readFileSync(join(frozen,p)))]));
for(const folder of ['engine','plugin'])mkdirSync(join(temp,folder));
for(const path of inputs)copyFileSync(join(frozen,path),join(temp,path));
let browserStarts=0;BrowserAdapter.prototype.start=async()=>{browserStarts++;throw Error('FORBIDDEN_BROWSER_START');};
const store=new SqliteStore(join(temp,'engine')),host=new BrowserEngine({persistence:store}),pluginStore=new ExplorerStore(join(temp,'plugin/explorer.sqlite')),plugin=new ExplorerPlugin(host,pluginStore);
const before=JSON.parse(readFileSync(join(out,'task-before.json'),'utf8')) as Task,after=JSON.parse(readFileSync(join(out,'task-after.json'),'utf8')) as Task;
const sid=after.rounds.at(-1)!.sessionId,itemId='93cb64e4-ff77-4bdd-85f2-bd5bc01007b6',routeKey='4781b6c8347fe7977def58b6636fb39c8f1c8f0d8582dd8e1123dce010069d29',item=after.plan.find(i=>i.id===itemId)!,route=after.scheduling!.routes[routeKey];
const events:ReturnType<ExplorerStore['events']>=[];for(;;){const batch=pluginStore.events(after.id,events.at(-1)?.sequence??0,1000);events.push(...batch);if(batch.length<1000)break;}
const recoveries=events.filter(e=>e.type==='recovery.selected'),selected=recoveries.findLast(e=>(e.data as any).routeKey===routeKey)!;
const currentId=(selected.data as any).currentObservationId,finalId='c4fae20b-a313-48bb-a1f6-22f793550193';
const timeline=events.filter(e=>e.at>='2026-10-16T21:39:01.237Z'&&['action.selected','recovery.selected','recovery.result','recovery.source_reached','obligation.selected','recovery.position_reconciled'].includes(e.type));
const oldSelection=recoveries.find(e=>(e.data as any).routeKey===routeKey)!;
const ids=[...new Set([route.observationId,(oldSelection.data as any).sourceObservationId,'4e5563f8-5b8c-472f-a61e-bcd74b30a378','c7aabb3a-529d-417d-847f-f439613d2138',(oldSelection.data as any).currentObservationId,'cfc205c1-bab5-4b44-8bc7-9d2b4c498948',...timeline.flatMap(e=>[(e.data as any).sourceObservationId,(e.data as any).currentObservationId,(e.data as any).observationId]).filter(Boolean),currentId,finalId])];
const slimAction=(a:ActionCandidate)=>({id:a.id,kind:a.kind,label:a.label,value:a.value,localId:a.localId,risk:a.risk,replayable:a.replayable,excluded:a.excluded,exclusionReason:a.exclusionReason,basis:a.basis,preconditions:a.preconditions});
const conditionReader=(o:Observation,a:ActionCandidate[])=>(plugin as any).routeConditionReader(o,a)(route) as string|undefined;
try{
 const observations=ids.map(id=>{
  const o=host.observation(sid,id),actions=host.actions(sid,id),targetControls=o.controls.filter(c=>controlInScope(item.scope,c,o,actions)),targetActions=actions.filter(a=>matches(item.scope,a,o));
  return {id,capturedAt:o.capturedAt,cause:o.cause,url:o.url,instanceScope:o.instanceScope,stateId:o.stateId,stable:o.stable,gaps:o.gaps,context:o.context,ruleVersion:o.ruleVersion,canonicalSha256:sha(o.canonical),
   boundaries:o.boundaries,regions:o.regions.map(r=>({key:r.key,label:r.label,role:r.role})),controlCount:o.controls.length,actionCount:actions.length,
   targetControls:targetControls.map(c=>({localId:c.localId,name:c.name,label:c.label,visible:c.visible,enabled:c.enabled,role:c.role,stableKey:c.stableKey,region:c.region,actionBasis:c.actionBasis,reviewBinding:c.reviewBinding,classificationBinding:c.classificationBinding})),
   sameNameControls:o.controls.filter(c=>[c.name,c.label].includes('Go to OKX Wallet')).map(c=>({localId:c.localId,name:c.name,visible:c.visible,enabled:c.enabled,region:c.region})),targetActions:targetActions.map(slimAction),
   routeCondition:conditionReader(o,actions),directRouteCondition:recoveryRouteConditionVersion(o,actions,[...route.path,...route.targets]),baseRecoveryCondition:recoveryConditionVersion(o),
   conditionInputWhenTargetAbsent:targetActions.length?undefined:{policy:'explorer-recovery-condition-v1',url:o.url,ruleVersion:o.ruleVersion,context:Object.fromEntries(Object.entries(o.context).map(([key,v])=>[key,{status:v.status,value:v.value}])),boundaries:(o.boundaries||[]).map(b=>({name:b.name,region:(()=>{const r=o.regions.find(r=>r.key===b.region);return r&&{label:r.label,role:r.role};})()})),targets:[digest({index:0,match:targetActions.length?'ambiguous':'absent'})]},
   navigation:o.navigation};
 });
 const current=host.observation(sid,currentId),currentActions=host.actions(sid,currentId),condition=conditionReader(current,currentActions)!;
 const cp=store.get<any>('checkpoint','7d7c3b8d-5dc6-45dc-a77a-13f5b3eab8ec');
 const attempts=host.list<any>(sid,'attempt').filter(a=>a.startedAt>='2026-10-16T21:39:01.237Z').map(a=>({id:a.id,status:a.status,purpose:a.purpose,startedAt:a.startedAt,finishedAt:a.finishedAt,beforeId:a.beforeId,afterId:a.afterId,action:{kind:a.action.kind,label:a.action.label,source:a.action.source,risk:a.action.risk,replayable:a.action.replayable},reason:a.reason}));
 const allEngineEvents:ReturnType<SqliteStore['events']>=[];for(;;){const batch=store.events(sid,allEngineEvents.at(-1)?.sequence??0,1000);allEngineEvents.push(...batch);if(batch.length<1000)break;}
 const engineEvents=allEngineEvents.filter(e=>e.type==='checkpoint.result');
 const sourcesUnchanged=sourceFiles.every(p=>sha(readFileSync(join(root,p)))===sourceHashes[p]);if(!sourcesUnchanged)throw Error('Forensic source changed during offline diagnosis');
 const result={protocol:'run4-recovery-diagnosis-v1',at:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceBaseline:baselineHead,sourceHashes,sourcesUnchanged,scope:{frozen,temporary:temp,originalDatabaseConnections:0,scriptFrozenDatabaseConnections:0,browserStarts,providerCalls:0,copiesOnly:true},inputHashes:beforeHashes,selected,timeline,selectedItem:item,
  checkpoint:cp,routeBefore:before.scheduling?.routes[routeKey],routeAfter:route,retryBefore:before.routeRetries?.routes[routeKey],retryAfter:after.routeRetries?.routes[routeKey],
  eligibilityAgainstBefore:routeRetryEligibility(before.routeRetries,routeKey,condition),failureLandingEqualsCurrent:before.scheduling?.routes[routeKey].failure?.conditionVersion===condition,
  projections:{before:before.obligations?.entries.filter(e=>e.itemId===itemId),after:after.obligations?.entries.filter(e=>e.itemId===itemId)},observations,
  currentTargetReadOnlyFacts:{observationId:currentId,matchingControls:current.controls.filter(c=>controlInScope(item.scope,c,current,currentActions)).length,matchingActions:currentActions.filter(a=>matches(item.scope,a,current)).length,limitation:'No live driver validation or dispatch performed. Historical actionAvailability is not used: that API reads the final session cursor, so it cannot reconstruct pre-recovery executable work.'},attempts,engineEvents,
  originalHashesUnchanged:inputs.every(p=>sha(readFileSync(join(frozen,p)))===beforeHashes[p])};
 writeFileSync(join(out,'recovery-diagnosis.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({report:join(out,'recovery-diagnosis.json'),selectedItem:item.scope,eligibility:result.eligibilityAgainstBefore,failureLandingEqualsCurrent:result.failureLandingEqualsCurrent,observations:observations.map(o=>({id:o.id,url:o.url,stable:o.stable,critical:o.gaps.filter(g=>g.critical),wallet:o.targetControls.length,actions:o.targetActions.length,condition:o.routeCondition})),browserStarts,originalHashesUnchanged:result.originalHashesUnchanged},null,2));
}finally{await plugin.close();await host.close();rmSync(temp,{recursive:true,force:true});}
