// Closed-copy benchmark; never opens original evidence with a writable store.
import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SqliteStore} from '@interaction/storage-sqlite';
import {BrowserEngine} from '@interaction/browser';
import {scopeForControl,scopeFor} from '../../../packages/explorer-plugin/src/policy.ts';
const input=resolve(process.argv[2]),output=resolve(process.argv[3]);
const old=await import(pathToFileURL(resolve(process.argv[4])).href);
const {capturedRoute,routeControl,routeControlScope}=await import(pathToFileURL(resolve(process.argv[5])).href);
mkdirSync(output,{recursive:false});mkdirSync(join(output,'copy'));
copyFileSync(join(input,'engine/engine.sqlite'),join(output,'copy/engine.sqlite'));
const store=new SqliteStore(join(output,'copy')),engine=new BrowserEngine({persistence:store});
try{
 const task=JSON.parse(readFileSync(join(input,'task-final.json'))),results=[];
 const attempts=task.rounds.flatMap(r=>engine.list(r.sessionId,'attempt')).filter(a=>a.status==='succeeded'&&a.afterId);
 for(const a of attempts){
  const before=engine.observation(a.sessionId,a.beforeId),after=engine.observation(a.sessionId,a.afterId);
  for(const o of [before,after])for(const c of o.controls)
   if(JSON.stringify(routeControl(scopeForControl(c,o)))!==JSON.stringify(routeControlScope(c,o)))throw Error('ROUTE_SCOPE_PARITY_FAILED');
  const revealed=engine.interactionTransition(a.sessionId,before.id,after.id).revealedControlIds;
  const entry=scopeFor(a.action,before),args=[entry,before,after,revealed,a];
  let start=performance.now();const prior=old.capturedRoute(...args),oldMs=performance.now()-start;
  start=performance.now();const indexed=capturedRoute(...args),indexedMs=performance.now()-start;
  if(JSON.stringify(prior)!==JSON.stringify(indexed))throw Error('FULL_ROUTE_PARITY_FAILED');
  results.push({attemptId:a.id,label:a.action.label,beforeControls:before.controls.length,afterControls:after.controls.length,revealed:revealed.length,routeTargets:prior?.targets.length||0,oldMs,indexedMs,exactParity:true});
 }
 const result={input,results,limitations:'Full route and every control projection compared on actual retained source/receipt pairs. Single offline samples include JIT effects; no browser throughput or strict-chain claim.'};
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await engine.close();}
