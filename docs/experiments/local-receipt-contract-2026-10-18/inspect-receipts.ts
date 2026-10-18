/** Closed-run copy only; no source DB is opened or repaired. */
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {BrowserEngine,type ActionAttempt} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {FileEvidenceStore} from '../../../packages/storage-sqlite/src/evidence.js';
const [runArg,outArg]=process.argv.slice(2),run=resolve(runArg),out=resolve(outArg);mkdirSync(out,{recursive:false});
copyFileSync(join(run,'engine/engine.sqlite'),join(out,'engine.sqlite'));
const host=new BrowserEngine({persistence:new SqliteStore(out)}),evidence=new FileEvidenceStore(join(run,'engine/evidence')),
 task=JSON.parse(readFileSync(join(run,'task-final.json'),'utf8')),materials:Record<string,unknown>={};
try{
 const attempts=[];
 for(const a of task.rounds.flatMap((r:any)=>host.list<ActionAttempt>(r.sessionId,'attempt')) as ActionAttempt[]){
  const before=host.observation(a.sessionId,a.beforeId),after=a.afterId?host.observation(a.sessionId,a.afterId):undefined,audit=after?.localDispatchAudit;
  for(const key of new Set([audit?.sourceArtifact,audit?.finalArtifact].filter((k):k is string=>!!k))){
   if(!(key in materials)){const stored=await evidence.get(key);materials[key]=stored?JSON.parse(new TextDecoder().decode(stored.data)):{unavailable:true};}
  }
  attempts.push({id:a.id,label:a.action.label,kind:a.action.kind,status:a.status,purpose:a.purpose,action:a.action,beforeId:a.beforeId,afterId:a.afterId,sourceURL:before.url,afterURL:after?.url,
   documentChanged:after&&after.documentId!==before.documentId,condition:host.operationReceiptCondition(a.sessionId,{attemptId:a.id}),
   ownerWitness:after?.ownerDependencyDispatch,localAudit:audit,navigationCapture:after?.navigationCapture,
   history:{before:before.navigation,after:after?.navigation},reason:a.reason});
 }
 const children=task.plan.filter((i:any)=>i.reason==='observed_in_scope'&&i.resolvedBy?.attemptId).map((i:any)=>({id:i.id,scope:i.scope,status:i.status,conditionCompletion:i.conditionCompletion,resolvedBy:i.resolvedBy,source:i.evidence[0],associations:i.attempts.map((a:any)=>a.sourceAssociation)}));
 writeFileSync(join(out,'result.json'),JSON.stringify({attempts,children},null,2));writeFileSync(join(out,'dispatch-materials.json'),JSON.stringify(materials));
 console.log(JSON.stringify({attempts:attempts.map(a=>({label:a.label,status:a.status,changedDocument:a.documentChanged,verified:a.condition.conditionVerified,reason:a.condition.reason,local:a.localAudit?.reason,changed:a.localAudit?.changedParts,trace:a.localAudit?.nativeNavigation})),children:children.map((i:any)=>({id:i.id,label:i.scope.label,status:i.status,condition:i.conditionCompletion?.status}))}));
}finally{await host.close();}
