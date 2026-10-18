import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {PlaywrightAdapter} from '@interaction/adapter-playwright';
import {act,testEngine} from './helpers.js';

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
