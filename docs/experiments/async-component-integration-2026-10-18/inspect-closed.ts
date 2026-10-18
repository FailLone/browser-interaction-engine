import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {BrowserEngine,type ActionAttempt} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
const [runArg,outArg]=process.argv.slice(2),run=resolve(runArg),out=resolve(outArg);mkdirSync(out,{recursive:false});
copyFileSync(join(run,'engine/engine.sqlite'),join(out,'engine.sqlite'));
const host=new BrowserEngine({persistence:new SqliteStore(out)}),task=JSON.parse(readFileSync(join(run,'task-final.json'),'utf8'));
try{
 const attempts=task.rounds.flatMap((r:any)=>host.list<ActionAttempt>(r.sessionId,'attempt')).map((a:ActionAttempt)=>{
  const before=host.observation(a.sessionId,a.beforeId),after=a.afterId&&host.observation(a.sessionId,a.afterId);
  return {id:a.id,label:a.action.label,kind:a.action.kind,status:a.status,purpose:a.purpose,beforeId:a.beforeId,afterId:a.afterId,startedAt:a.startedAt,
   sourceURL:before.url,afterURL:after&&after.url,condition:host.operationReceiptCondition(a.sessionId,{attemptId:a.id}),
   witness:after&&after.ownerDependencyDispatch,contentReadiness:after&&after.contentReadiness,
   action:a.action,reason:a.reason,readiness:before.controls.find(c=>c.localId===a.action.localId)?.readiness};
 });
 writeFileSync(join(out,'result.json'),JSON.stringify({attempts},null,2));console.log(JSON.stringify(attempts.map((a:any)=>({label:a.label,status:a.status,verified:a.condition.conditionVerified,reason:a.condition.reason,witness:!!a.witness,content:a.contentReadiness?.status}))));
}finally{await host.close();}
