import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {BrowserEngine,type BrowserCommandEvent,type EngineHooks,BrowserAdapter} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';

async function fixture(observe?:NonNullable<EngineHooks['browserInstrumentation']>['observe']){
 const html='<!doctype html><header><nav><ul><li data-record="A"><a href="/catalog">Catalog</a><details><summary onclick="window.actualRecord=this.closest(\'li\').dataset.record">More</summary><a href="/child">Child</a></details></li></ul></nav></header>';
 const server=createServer((_q,r)=>{r.setHeader('Content-Type','text/html');r.end(html);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${(server.address() as any).port}/`,events:BrowserCommandEvent[]=[],host=new BrowserEngine({persistence:new MemoryStore(),hooks:{browserInstrumentation:{publicInventory:true,observe(e){events.push(structuredClone(e));observe?.(e);}}}});
 const session=await host.createSession({url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',settleMs:25,observeTimeoutMs:500,evidence:{enabled:false},
  executionBoundary:{version:1,programNavigation:'public-navigation-v1',urls:[{match:'route',origin:new URL(url).origin,pathnamePattern:'^/.*$'}],exclusions:[],allowedOperations:['click']}});
 const driver=(host as unknown as {driver:BrowserAdapter}).driver,action=host.actions(session.id).find(a=>a.label==='More'&&a.kind==='click')!;
 return {host,session,driver,events,action,execute:()=>host.execute(session.id,action.id,'instrumented-input',undefined,{profile:'observed-ui-exploration',observationId:action.observationId}),
  async close(){await host.close();await new Promise<void>(r=>server.close(()=>r()));}};
}

it('keeps native dispatch evidence with detached accounting and counts the original startup/dispatch boundary',async()=>{
 const f=await fixture(e=>{if(e.command==='execute'&&e.phase==='before'){(e.input.action as any).label='forged';return {ownerDependencyDispatch:{fabricated:true}} as any;}});
 try{
  const receipt=await f.execute(),after=f.host.observation(f.session.id,receipt.afterId!);
  expect(receipt.status).toBe('succeeded');expect(receipt.action.label).toBe('More');expect(after.ownerDependencyDispatch?.actionId).toBe(f.action.id);
  expect(f.host.operationReceiptCondition(f.session.id,{attemptId:receipt.id}).conditionVerified).toBe(true);
  const admitted=f.events.filter(e=>e.phase==='before');expect(admitted.filter(e=>['start','execute'].includes(e.command)).map(e=>e.command)).toEqual(['start','execute']);
  expect(admitted.some(e=>e.command==='readDOM')).toBe(true);expect(admitted.some(e=>e.command==='waitForCaptureSample')).toBe(true);
  expect(admitted.filter(e=>e.command==='inventory')).toHaveLength(3);
  for(const e of admitted)expect(f.events.filter(end=>end.id===e.id&&end.phase==='after')).toHaveLength(1);
  expect(await f.driver.page!.evaluate(()=>(window as any).actualRecord)).toBe('A');
 }finally{await f.close();}
});

it.each(['execute','readDOM'] as const)('still withholds witness for a custom %s implementation that calls the original',async method=>{
 const f=await fixture();try{
  const original=(f.driver[method] as any).bind(f.driver);(f.driver as any)[method]=async(...args:any[])=>original(...args);
  const receipt=await f.execute();expect(receipt.status).toBe('succeeded');expect(f.host.observation(f.session.id,receipt.afterId!).ownerDependencyDispatch).toBeUndefined();
  expect(f.host.operationReceiptCondition(f.session.id,{attemptId:receipt.id})).toMatchObject({actualSuccess:true,conditionVerified:false});
 }finally{await f.close();}
});

it('charges a rejected dispatch before any native effect and retains its failed event',async()=>{
 const f=await fixture(e=>{if(e.command==='execute'&&e.phase==='before')throw Error('FIXTURE_COMMAND_BUDGET');});try{
  const receipt=await f.execute();expect(receipt.status).not.toBe('succeeded');expect(await f.driver.page!.locator('details').getAttribute('open')).toBeNull();
  expect(f.events.filter(e=>e.command==='execute'&&e.phase==='before')).toHaveLength(1);
  expect(f.events.find(e=>e.command==='execute'&&e.phase==='after')).toMatchObject({status:'failed',operationStarted:false});
  expect(f.host.observation(f.session.id,receipt.afterId!).ownerDependencyDispatch).toBeUndefined();
 }finally{await f.close();}
});

it('cannot run a completion observer between the final witness sample and actual input',async()=>{
 let executing=false,readCompletion:Promise<unknown>|undefined,oracleAtObserver:Promise<unknown>|undefined;
 const f=await fixture(e=>{
  if(e.command==='execute'&&e.phase==='before')executing=true;
  if(executing&&e.command==='readDOM'&&e.phase==='after'){
   oracleAtObserver=f.driver.page!.evaluate(()=>(window as any).actualRecord);
   readCompletion=f.driver.page!.locator('li').evaluate(el=>el.setAttribute('data-record','B'));
  }
  if(e.command==='execute'&&e.phase==='after')executing=false;
 });try{
  await f.execute();await readCompletion;expect(await oracleAtObserver).toBe('A');
  expect(await f.driver.page!.evaluate(()=>(window as any).actualRecord)).toBe('A');
 }finally{await f.close();}
});

it('does not accept a fabricated custom DOM read as native dispatch evidence',async()=>{
 const f=await fixture();try{
  const before=f.host.observation(f.session.id);await f.driver.page!.locator('li').evaluate(el=>el.setAttribute('data-record','B'));
  (f.driver as any).readDOM=async()=>structuredClone(before);
  const receipt=await f.execute();expect(await f.driver.page!.evaluate(()=>(window as any).actualRecord)).toBe('B');
  expect(f.host.observation(f.session.id,receipt.afterId!).ownerDependencyDispatch).toBeUndefined();
  expect(f.host.operationReceiptCondition(f.session.id,{attemptId:receipt.id}).conditionVerified).toBe(false);
 }finally{await f.close();}
});

it('counts recovery startup in the same original command boundary',async()=>{
 const f=await fixture();try{
  await f.execute();await f.driver.reopen();
  expect(f.events.filter(e=>e.phase==='before'&&['start','execute'].includes(e.command)).map(e=>e.command)).toEqual(['start','execute','start']);
  expect(f.events.some(e=>e.phase==='after'&&e.command==='reopen'&&e.status==='returned')).toBe(true);
 }finally{await f.close();}
});

it('retains falsy thrown failures and drains deferred events even if an observer fails',async()=>{
 const {BrowserCommandInstrumentation}=await import('../packages/adapter-playwright/src/browser-instrumentation.js');
 const events:BrowserCommandEvent[]=[];
 const meter=new BrowserCommandInstrumentation({observe(e){events.push(structuredClone(e));if(e.command==='readDOM'&&e.phase==='after')throw 0;}});
 let failed=false,caught:unknown;
 try{await meter.run('execute',{},async()=>{await meter.run('readDOM',{},async()=>1);await meter.run('readDOM',{},async()=>2);});}catch(e){failed=true;caught=e;}
 expect(failed).toBe(true);expect(caught).toBe(0);expect(events.filter(e=>e.phase==='after')).toHaveLength(3);
 let nullFailure=false;try{await meter.run('start',{},async()=>{throw null;});}catch(e){nullFailure=e===null;}
 expect(nullFailure).toBe(true);expect(events.at(-1)).toMatchObject({command:'start',status:'failed',error:'null'});
});
