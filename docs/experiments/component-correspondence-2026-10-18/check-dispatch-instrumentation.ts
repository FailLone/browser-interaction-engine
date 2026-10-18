import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {BrowserEngine,BrowserAdapter} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';

// Causal local probe only. The original OKX harness and adapter are unchanged.
// Transparent wrappers reproduce the original worker's method instrumentation.
const html='<!doctype html><header><nav aria-label="Catalog"><ul><li data-record="catalog"><a href="/catalog">Catalog</a><details><summary>More</summary><a href="/alpha">Alpha</a></details></li></ul></nav></header>';
const site=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${(site.address() as any).port}/`,results=[];
try{for(const wrapped of [false,true]){
 const engine=new BrowserEngine({persistence:new MemoryStore()});let reads=0,dispatches=0;
 try{
  const session=await engine.createSession({url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',settleMs:25,observeTimeoutMs:500,
   executionBoundary:{version:1,programNavigation:'public-navigation-v1',urls:[{match:'route',origin:new URL(url).origin,pathnamePattern:'^/.*$'}],exclusions:[],allowedOperations:['click']}});
  const driver=(engine as unknown as {driver:BrowserAdapter}).driver;
  if(wrapped){const read=driver.readDOM.bind(driver),execute=driver.execute.bind(driver);
   driver.readDOM=async(...args)=>{reads++;return read(...args);};
   driver.execute=async(...args)=>{dispatches++;return execute(...args);};}
  const action=engine.actions(session.id).find(a=>a.label==='More'&&a.kind==='click')!;
  const attempt=await engine.execute(session.id,action.id,`instrumentation-${wrapped}`,undefined,{profile:'observed-ui-exploration',observationId:action.observationId});
  const after=engine.observation(session.id,attempt.afterId!),condition=engine.operationReceiptCondition(session.id,{attemptId:attempt.id});
  results.push({wrapped,attempt,condition,witness:after.ownerDependencyDispatch||null,actualOpen:await driver.page!.locator('details').getAttribute('open'),reads,dispatches});
 }finally{await engine.close();}
}}finally{await new Promise<void>(r=>site.close(()=>r()));}
writeFileSync(process.argv[2],JSON.stringify({fixture:html,paidRequests:0,results},null,2));
console.log(results.map(({wrapped,attempt,condition,witness,actualOpen,reads,dispatches})=>({wrapped,success:attempt.status,verified:condition.conditionVerified,reason:condition.reason,witness:!!witness,actualOpen,reads,dispatches})));
