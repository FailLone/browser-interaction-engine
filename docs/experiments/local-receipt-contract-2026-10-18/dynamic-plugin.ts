import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {BrowserEngine,type BrowserCommandEvent,type ActionAttempt} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {SqliteStore} from '@interaction/storage-sqlite';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const dir=resolve(process.argv[2]);mkdirSync(dir,{recursive:true});
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/'?`<!doctype html><header><nav><details><summary>Markets</summary><a href="/alpha?mode=cash#spot">Alpha</a><a href="/beta?mode=cash#spot">Beta</a></details></nav></header><main><input readonly aria-label="Independent quote" value="1"></main><script>setInterval(()=>document.querySelector('input').value=String(Date.now()),20)</script>`:'<!doctype html><h1>Destination</h1><p>Navigation arrived</p>');});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
const events:BrowserCommandEvent[]=[],began=Date.now();let native=0;
const host=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine')),hooks:{browserInstrumentation:{observe(e){events.push(e);if(e.phase==='before'&&['start','execute'].includes(e.command)&&++native>40)throw Error('NATIVE_LIMIT');if(Date.now()-began>60000)throw Error('TIME_LIMIT');}}}}),store=new ExplorerStore(join(dir,'explorer.sqlite')),plugin=new ExplorerPlugin(host,store,{});
let closed=false;
try{
 const task=plugin.create({url,goal:'Explore each original market once and return naturally for remaining work',coverageContract:{version:1,mode:'exhaustive',programNavigation:'public-navigation-v1',roots:[{url}],routes:[{origin:new URL(url).origin,pathnamePattern:'^/.*$',scope:{}}],allowedOperations:['click','history'],exclusions:[]},
  sessionOptions:{headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',settleMs:60,observeTimeoutMs:1200},budget:{rounds:1,actions:16,durationMs:45000,modelRequests:1}});
 plugin.start(task.id);await plugin.waitForIdle(task.id);
 const final=store.task(task.id),attempts=final.rounds.flatMap(r=>host.list<ActionAttempt>(r.sessionId,'attempt')),
  conditions=attempts.map(a=>({id:a.id,label:a.action.label,condition:host.operationReceiptCondition(a.sessionId,{attemptId:a.id})})),fragments=store.exportFragments(task.id),pluginEvents=store.events(task.id);
 const result={pid:process.pid,url,elapsedMs:Date.now()-began,native,final,attempts,conditions,fragments,pluginEvents,events};writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2));writeFileSync(join(dir,'task-id'),task.id);
 console.log(JSON.stringify({status:final.status,reason:final.reason,elapsedMs:result.elapsedMs,native,attempts:attempts.map(a=>[a.action.kind,a.action.label,a.status]),originals:final.plan.filter(i=>['Alpha','Beta'].includes(i.scope.label||'')).map(i=>({id:i.id,label:i.scope.label,status:i.status,reason:i.reason,completion:i.conditionCompletion,sourceAssociation:i.attempts.map(a=>a.sourceAssociation)})),events:pluginEvents.map(e=>e.type).filter(t=>/fragment|reentry|source/.test(t))}));
 assert.equal(final.usage.modelRequests,0);
 assert.equal(attempts.filter(a=>a.action.kind==='history'&&a.status==='succeeded').length>=1,true);
 const originals=final.plan.filter(i=>['Alpha','Beta'].includes(i.scope.label||'')&&i.reason!=='explicit_scope');
 for(const label of ['Alpha','Beta'])assert(originals.some(i=>i.scope.label===label&&i.status==='succeeded'&&i.conditionCompletion?.status==='verified'),label);
 const first=attempts.find(a=>a.action.label==='Alpha')!,second=attempts.find(a=>a.action.label==='Beta')!,beta=originals.find(i=>i.scope.label==='Beta')!;
 assert(beta.evidence.some(e=>!e.attemptId&&Date.parse(host.observation(e.sessionId,e.observationId!).capturedAt)<Date.parse(first.startedAt)),'Beta was retained before leaving');
 assert(attempts.some(a=>a.action.kind==='history'&&a.status==='succeeded'&&Date.parse(a.startedAt)>Date.parse(first.startedAt)&&Date.parse(a.startedAt)<Date.parse(second.startedAt)),'Actual natural history return');
 assert.equal(attempts.filter(a=>a.action.label==='Markets'&&a.status==='succeeded').length,2);
 await plugin.close();await host.close();store.close();closed=true;
 const cold=[];
 for(const item of originals){const itemPath=join(dir,`${item.scope.label}-original.json`);writeFileSync(itemPath,JSON.stringify(item));
  const verified=JSON.parse(execFileSync(process.execPath,['--import','tsx','--conditions=development','docs/experiments/component-correspondence-2026-10-18/cold-receipt.ts',join(dir,'engine'),itemPath],{encoding:'utf8'}));assert(verified.completed);assert.notEqual(verified.pid,process.pid);cold.push(verified);}
 writeFileSync(join(dir,'cold-completion.json'),JSON.stringify(cold,null,2));
 assert.equal(attempts.filter(a=>['Alpha','Beta'].includes(a.action.label)&&a.status==='succeeded').length,2);
}finally{if(!closed){await plugin.close();await host.close();store.close();}await new Promise<void>(r=>server.close(()=>r()));}
