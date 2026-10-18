import {createServer} from 'node:http';
import {expect,it,vi} from 'vitest';
import {PlaywrightAdapter,nativeDocumentReturnReady} from '@interaction/adapter-playwright';
import {act,testEngine,pageOf} from './helpers.js';

it.each([false,true])('observes a committed native navigation while destination fields remain unready (early URL replacement: %s)',async rewrite=>{
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/'?'<a href="/live">Open live page</a>':`<h1>Live page</h1><a href="/">Return</a><form><input id="changing" aria-label="Changing"></form><script>${rewrite?`history.replaceState({},'', '/renamed#mode')`:''};setInterval(()=>document.querySelector('#changing').value=String(Date.now()),10)</script>`);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;
 const f=await testEngine(url,{contextRules:[],exploration:'controls',settleMs:120,observeTimeoutMs:1600});
 try{
  const attempt=await act(f.engine,f.sessionId,'Open live page');const after=f.engine.observation(f.sessionId);
  expect(attempt.status,attempt.reason).toBe('succeeded');const destination=url+(rewrite?'/renamed#mode':'/live');expect(after.url).toBe(destination);expect(after.stable).toBe(false);
  expect(after.navigationCapture).toMatchObject({beforeId:attempt.beforeId,actionId:attempt.action.id,requestedUrl:url+'/live',observedUrl:destination});
  expect(after.navigation!.entries[after.navigation!.currentIndex].method).toBe('GET');
  expect(after.navigationCapture!.samples).toBeGreaterThanOrEqual(2);expect(after.gaps.some(g=>g.critical)).toBe(false);
  expect(after.controls.find(c=>c.name==='Changing')?.readiness?.status).toBe('unstable');
  await expect(act(f.engine,f.sessionId,'Changing','fill','example')).rejects.toHaveProperty('code');
  expect(f.engine.list(f.sessionId,'attempt')).toHaveLength(1);
  const adapter=new PlaywrightAdapter(),before=f.engine.observation(f.sessionId,attempt.beforeId);
  expect(nativeDocumentReturnReady(before,after)).toBe(true);
  for(const change of ['missing-proof','wrong-document','wrong-url','uncommitted-history','critical-gap','new-boundary'] as const){
   const altered=structuredClone(after);
   if(change==='missing-proof')delete altered.navigationCapture;
   if(change==='wrong-document')altered.documentId='another-document';
   if(change==='wrong-url')altered.url=url+'/another';
   if(change==='uncommitted-history')altered.navigation!.entries[altered.navigation!.currentIndex].method='POST';
   if(change==='critical-gap')altered.gaps.push({code:'READ_FAILED',message:'Incomplete',critical:true});
   if(change==='new-boundary')altered.boundaries=[{key:'new-dialog'} as any];
   expect(nativeDocumentReturnReady(before,altered),change).toBe(false);
  }
  for(const change of ['missing-proof','wrong-source','uncommitted-history','critical-gap'] as const){
   const altered=structuredClone(after);if(change==='missing-proof')delete altered.navigationCapture;
   if(change==='wrong-source')altered.navigationCapture!.beforeId='unrelated';
   if(change==='uncommitted-history')altered.navigation!.entries[altered.navigation!.currentIndex].method='POST';
   if(change==='critical-gap')altered.gaps.push({code:'READ_FAILED',message:'Incomplete',critical:true});
   expect(adapter.actionObservationReady(attempt.action,before,altered),change).toBe(false);
  }
 }finally{await f.close();await new Promise<void>(r=>server.close(()=>r()));}
});

it('does not treat a prevented native link with changing local state as a committed navigation',async()=>{
 let navigated=0;const server=createServer((req,res)=>{if(req.url==='/live')navigated++;res.setHeader('Content-Type','text/html');res.end(`<a href="/live" onclick="event.preventDefault();setInterval(()=>document.querySelector('#changing').value=String(Date.now()),10)">Prevented link</a><form><input id="changing" aria-label="Changing"></form>`);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;
 const f=await testEngine(url,{contextRules:[],exploration:'controls',settleMs:120,observeTimeoutMs:800});
 try{const attempt=await act(f.engine,f.sessionId,'Prevented link');expect(attempt.status).toBe('unknown');expect(f.engine.observation(f.sessionId).navigationCapture).toBeUndefined();expect(navigated).toBe(0);expect(f.engine.list(f.sessionId,'attempt')).toHaveLength(1);}
 finally{await f.close();await new Promise<void>(r=>server.close(()=>r()));}
});

it.each([false,true])('recollects a late native URL replacement within one capture deadline (keeps changing: %s)',async keepsChanging=>{
 let navigated=0;const server=createServer((req,res)=>{if(req.url==='/live')navigated++;res.setHeader('Content-Type','text/html');res.end(req.url==='/'?'<a href="/live">Open</a>':'<h1>Destination</h1>');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;
 const f=await testEngine(url,{contextRules:[],exploration:'controls',settleMs:60,observeTimeoutMs:650});
 const page=pageOf(f.engine),screenshot=page.screenshot.bind(page);let changes=0;
 const spy=vi.spyOn(page,'screenshot').mockImplementation(async options=>{
  const result=await screenshot(options);
  if(!changes||keepsChanging){changes++;await page.evaluate(n=>history.replaceState({},'',`/renamed-${n}`),changes);}
  return result;
 });
 try{
  const attempt=await act(f.engine,f.sessionId,'Open'),after=f.engine.observation(f.sessionId);
  expect(navigated).toBe(1);expect(f.engine.list(f.sessionId,'attempt')).toHaveLength(1);
  expect(after.gaps.some(g=>g.code==='EVIDENCE_CONSISTENCY_RETRIED')).toBe(true);
  if(keepsChanging){expect(attempt.status).toBe('unknown');expect(after.gaps.some(g=>g.code==='NAVIGATION_HISTORY_CHANGED'&&g.critical)).toBe(true);}
  else {expect(attempt.status,attempt.reason).toBe('succeeded');expect(after.url).toBe(url+'/renamed-1');expect(after.navigation!.entries[after.navigation!.currentIndex].url).toBe(after.url);expect(after.gaps.some(g=>g.critical)).toBe(false);}
 }finally{spy.mockRestore();await f.close();await new Promise<void>(r=>server.close(()=>r()));}
});

it.each(['push','replace'] as const)('verifies a same-document native HTTP destination with %s history while retaining unready fields',async mode=>{
 let requests=0;const server=createServer((_req,res)=>{requests++;res.setHeader('Content-Type','text/html');res.end(`<a href="/live" onclick="event.preventDefault();history.${mode}State({},'', '/live#view');this.remove();setInterval(()=>document.querySelector('#changing').value=String(Date.now()),10)">Open live page</a><form><input id="changing" aria-label="Changing"></form>`);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;
 const f=await testEngine(url,{contextRules:[],exploration:'controls',settleMs:120,observeTimeoutMs:1000});
 try{
  const initialRequests=requests,attempt=await act(f.engine,f.sessionId,'Open live page'),after=f.engine.observation(f.sessionId),before=f.engine.observation(f.sessionId,attempt.beforeId),adapter=new PlaywrightAdapter();
  expect(attempt.status,attempt.reason).toBe('succeeded');expect(after.documentId).toBe(before.documentId);expect(after.url).toBe(url+'/live#view');
  expect(after.navigationCapture).toMatchObject({version:2,transition:'same-document-url',beforeId:before.id,actionId:attempt.action.id});
  expect(after.controls.find(c=>c.name==='Changing')?.readiness?.status).toBe('unstable');expect(requests).toBe(initialRequests);
  expect(nativeDocumentReturnReady(before,after)).toBe(mode==='push');
  expect(f.engine.list(f.sessionId,'attempt')).toHaveLength(1);
  for(const change of ['wrong-document','wrong-url','wrong-entry','wrong-source-entry','wrong-action','critical-gap','one-sample'] as const){
   const altered=structuredClone(after),p=altered.navigationCapture!;if(p.version!==2)throw Error('missing same-document proof');
   if(change==='wrong-document')altered.documentId='different';if(change==='wrong-url')altered.url=url+'/unexpected';
   if(change==='wrong-entry')p.entryId=-1;if(change==='wrong-source-entry')p.sourceEntryId=-1;if(change==='wrong-action')p.actionId='different';
   if(change==='critical-gap')altered.gaps.push({code:'READ_FAILED',message:'Incomplete',critical:true});if(change==='one-sample')p.samples=1;
   expect(adapter.actionObservationReady(attempt.action,before,altered),change).toBe(false);
  }
 }finally{await f.close();await new Promise<void>(r=>server.close(()=>r()));}
});

it('retains unknown when an intercepted native link changes to an unrelated same-document URL',async()=>{
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<a href="/live" onclick="event.preventDefault();history.replaceState({},'', '/unexpected');this.remove();setInterval(()=>document.querySelector('#changing').value=String(Date.now()),10)">Open</a><form><input id="changing" aria-label="Changing"></form>`);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;
 const f=await testEngine(url,{contextRules:[],exploration:'controls',settleMs:120,observeTimeoutMs:800});
 try{const a=await act(f.engine,f.sessionId,'Open');expect(a.status).toBe('unknown');expect(f.engine.observation(f.sessionId).navigationCapture).toBeUndefined();expect(f.engine.list(f.sessionId,'attempt')).toHaveLength(1);}
 finally{await f.close();await new Promise<void>(r=>server.close(()=>r()));}
});
