import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {BrowserEngine,type Observation} from '@interaction/browser';
import {meterReadinessBrowser} from './readiness-budget.js';
import {MemoryStore} from '@interaction/storage-memory';
import {ExplorerPlugin,ExplorerStore,coverageLedger} from '@interaction/explorer-plugin';

/** A separate test-site extension and its own ephemeral HTTP/browser sessions. */
export async function runAsyncReadiness(scenario:string,out?:string,options:{actions?:number;timeoutMs?:number;delay?:number}={}) {
 const events:unknown[]=[],meter=meterReadinessBrowser(),{began,commands,captures}=meter;
 const server=createServer((req,res)=>{
  if(req.url==='/__event'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{events.push(JSON.parse(body));res.end('ok');});return;}
  if(req.url?.startsWith('/async-result/')){events.push({type:'destination',url:req.url,at:Date.now()});res.end('<!doctype html><title>Result</title><main><h1>Record reached</h1></main>');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(readFileSync(resolve('apps/test-site/async-readiness.html')));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${(server.address() as any).port}/async-readiness.html?scenario=${scenario}&delay=${options.delay??100}`;
 const host=new BrowserEngine({persistence:new MemoryStore()}),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(host,store,{});
 const createSession=host.createSession.bind(host);host.createSession=options=>createSession({...options as Record<string,unknown>,evidence:{enabled:false}});
 let result:any;
 try{
  const task=plugin.create({url,coverageContract:{version:1,mode:'exhaustive',programNavigation:'public-navigation-v1',roots:[{url}],routes:[{origin:new URL(url).origin,pathnamePattern:'^/async-result/.*$',scope:{}}],exclusions:[],allowedOperations:['click']},
   sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:0,observeTimeoutMs:options.timeoutMs??(scenario==='never'?240:800)},budget:{rounds:1,actions:options.actions??2,durationMs:60000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),attempts=final.rounds.flatMap(r=>host.list<any>(r.sessionId,'attempt')),observations=final.rounds.flatMap(r=>host.list<Observation>(r.sessionId,'observation'));
  result={scenario,elapsedMs:Date.now()-began,commands:commands.length,waits:commands.filter(c=>c.method==='waitForCaptureSample').length,allCountedCommands:commands.length,budgetRejected:meter.rejected,commandLog:commands,applicationEvents:events,captures,attempts,task:final,events:store.events(task.id),observations,coverage:coverageLedger(host,final),modelRequests:final.usage.modelRequests};
  if(out){mkdirSync(out,{recursive:true});writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));}
  return result;
 }finally{await plugin.close();await host.close();await new Promise<void>(r=>server.close(()=>r()));meter.restore();}
}
if(process.argv[1]?.endsWith('/async-readiness-fixture.ts')){
 const result=await runAsyncReadiness(process.argv[2]||'delayed',resolve(process.argv[3]||'.data/async-readiness-debug'));
 console.log(JSON.stringify({elapsedMs:result.elapsedMs,count:result.allCountedCommands,status:result.task.status,reason:result.task.reason,attempts:result.attempts.map((a:any)=>[a.action.label,a.action.kind,a.status]),events:result.applicationEvents,captures:result.captures},null,2));
}
