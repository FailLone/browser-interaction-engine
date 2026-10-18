import {createServer} from 'node:http';import {writeFileSync} from 'node:fs';import assert from 'node:assert/strict';
import {BrowserEngine,type BrowserCommandEvent,BrowserAdapter} from '@interaction/browser';import {MemoryStore} from '@interaction/storage-memory';
const output=process.argv[2],rows=[];
for(const mutate of [false,true]){
 const html='<!doctype html><header><nav><ul><li data-record="A"><a href="/catalog">Catalog</a><details><summary>More</summary><a href="/child">Child</a></details></li></ul></nav></header><main><form><input type="number" value="1" aria-label="Independent number"></form></main>';
 const server=createServer((_q,r)=>{r.setHeader('Content-Type','text/html');r.end(html);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const began=Date.now(),events:BrowserCommandEvent[]=[];let driver:BrowserAdapter|undefined;let mutation:Promise<unknown>|undefined;let commands=0;const fixtureCalls:string[]=[];
 const charge=(method:string)=>{if(++commands>40||Date.now()-began>25000)throw Error('LOCAL_COUNTEREXAMPLE_BUDGET');if(method.startsWith('fixture:'))fixtureCalls.push(method);};
 const host=new BrowserEngine({persistence:new MemoryStore(),hooks:{browserInstrumentation:{publicInventory:true,observe(e){events.push(structuredClone(e));if(e.phase==='before'){
  charge(e.command);
  if(mutate&&e.command==='execute'){charge('fixture:outside-input-mutation');mutation=driver!.page!.locator('input').evaluate((el:HTMLInputElement)=>{el.value='2';});}
 }}}}});
 try{
  const url=`http://127.0.0.1:${(server.address() as any).port}/`,session=await host.createSession({url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',settleMs:25,observeTimeoutMs:500,evidence:{enabled:false},executionBoundary:{version:1,programNavigation:'public-navigation-v1',urls:[{match:'route',origin:new URL(url).origin,pathnamePattern:'^/.*$'}],exclusions:[],allowedOperations:['click']}});
  driver=(host as unknown as {driver:BrowserAdapter}).driver;
  const action=host.actions(session.id).find(a=>a.kind==='click'&&a.label==='More')!,before=host.observation(session.id);
  const receipt=await host.execute(session.id,action.id,'graph-scope',undefined,{profile:'observed-ui-exploration',observationId:action.observationId});await mutation;
  const after=host.observation(session.id,receipt.afterId!),condition=host.operationReceiptCondition(session.id,{attemptId:receipt.id});
  charge('fixture:details-read');const actualOpen=await driver.page!.locator('details').getAttribute('open')!==null;
  charge('fixture:number-read');const numberAfter=await driver.page!.locator('input').inputValue();
  const result={mutate,commands,fixtureCalls,elapsedMs:Date.now()-began,originalBoundary:events.filter(e=>e.phase==='before'&&['start','execute'].includes(e.command)).length,actualOpen,numberBefore:before.controls.find(c=>c.name==='Independent number')?.value,numberAfter,receipt,condition,witness:after.ownerDependencyDispatch,events};
  assert.equal(result.actualOpen,true);assert.equal(receipt.status,'succeeded');assert.equal(condition.conditionVerified,!mutate);assert.equal(!!result.witness,!mutate);assert.equal(result.originalBoundary,2);rows.push(result);
 }finally{await host.close();await new Promise<void>(r=>server.close(()=>r()));const row=rows.at(-1);if(row?.mutate===mutate){row.commands=commands;row.elapsedMs=Date.now()-began;}}
}
writeFileSync(output,JSON.stringify({purpose:'Causal native-driver graph scope counterexample; not a reconstruction of the unretained final OKX DOM sample',rows},null,2));console.log(JSON.stringify(rows.map(({mutate,commands,elapsedMs,actualOpen,numberBefore,numberAfter,condition,witness})=>({mutate,commands,elapsedMs,actualOpen,numberBefore,numberAfter,reason:condition.reason,verified:condition.conditionVerified,witness:!!witness}))));
