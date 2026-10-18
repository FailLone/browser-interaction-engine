import {it,expect} from 'vitest';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {BrowserEngine,type Observation,type SessionOptions} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';
import {runAsyncReadiness} from '../scripts/async-readiness-fixture.js';
import {meterReadinessBrowser} from '../scripts/readiness-budget.js';
import {pageOf,act} from './helpers.js';
import {disclosureObservationReady} from '../packages/adapter-playwright/src/capture-readiness.js';

it.each(['delayed','live','mixed'])('actual plugin discovers and dispatches a late child with outside ticks (%s)',async scenario=>{
 const result=await runAsyncReadiness(scenario,resolve(`.data/readiness-tests/${scenario}`));
 expect(result.commands).toBeLessThanOrEqual(40);expect(result.budgetRejected).toBe(0);expect(result.elapsedMs).toBeLessThan(60000);
 expect(result.attempts.map((a:any)=>[a.action.label,a.status])).toEqual([[scenario==='mixed'?'Existing child':'Information','succeeded'],['Record late','succeeded']]);
 expect(result.applicationEvents.filter((e:any)=>e.type==='link')).toHaveLength(1);
 expect(result.applicationEvents.some((e:any)=>e.type==='destination'&&e.url==='/async-result/late')).toBe(true);
 expect(result.applicationEvents.find((e:any)=>e.type==='child-added').ticks).toBeGreaterThan(0);
 expect(result.modelRequests).toBe(0);
 const acquired=result.observations.find((o:Observation)=>o.contentReadiness?.transitions.some(t=>t.addedControlIds.length));
 expect(acquired).toBeDefined();expect(acquired.contentReadiness.status).toBe('observed');
 expect(acquired.contentReadiness.transitions.some((t:any)=>t.signals.some((s:any)=>s.kind===(scenario==='live'?'live-placeholder':'busy')))).toBe(true);
 const child=result.attempts[1];expect(result.observations.find((o:Observation)=>o.id===child.afterId).url).toContain('/async-result/late');
 expect(result.attempts.filter((a:any)=>a.action.label===result.attempts[0].action.label)).toHaveLength(1);
});

it('times out content acquisition without making the observed opening or independent action unknown',async()=>{
 const r=await runAsyncReadiness('never',resolve('.data/readiness-tests/never'));
 expect(r.commands).toBeLessThanOrEqual(40);expect(r.budgetRejected).toBe(0);
 expect(r.attempts.map((a:any)=>[a.action.label,a.status])).toEqual([['Information','succeeded'],['Record independent','succeeded']]);
 const pending=r.observations.find((o:Observation)=>o.contentReadiness?.status==='unknown');
 expect(pending.contentReadiness.stop).toBe('deadline');expect(pending.contentReadiness.waitedMs).toBeLessThan(800);
 expect(pending.controls.find((c:any)=>c.name==='Information').readiness.status).toBe('unstable');
 expect(pending.controls.find((c:any)=>c.name==='Record independent').readiness).toBeUndefined();
 expect(r.coverage.unknownDependencies.observations.some((g:any)=>g.code==='ASYNC_CONTENT_PENDING')).toBe(true);
 expect(r.task.status).not.toBe('completed');expect(r.task.plan.some((i:any)=>i.required&&i.reason==='interaction_unstable'&&i.status==='unresolved')).toBe(true);expect(r.modelRequests).toBe(0);
 const a=r.attempts[0],before=r.observations.find((o:Observation)=>o.id===a.beforeId),after=r.observations.find((o:Observation)=>o.id===a.afterId);
 expect(disclosureObservationReady(a.action,before,after)).toBe(true);
 for(const invalid of [{...after,disclosureCapture:undefined},{...after,url:after.url+'#changed'},
  {...after,disclosureCapture:{...after.disclosureCapture,samples:1}},{...after,disclosureCapture:{...after.disclosureCapture,actionId:'other'}},
  {...after,boundaries:[{key:'other',kind:'modal'}]},{...after,gaps:[...after.gaps,{code:'MISSING',critical:true}]}]){
  expect(disclosureObservationReady(a.action,before,invalid)).toBe(false);
 }
});

async function sdkFixture(html:string,options:Partial<SessionOptions>={}){
 const meter=meterReadinessBrowser(),server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html>'+html);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${(server.address() as any).port}/`,engine=new BrowserEngine({persistence:new MemoryStore()});
 const s=await engine.createSession({url,headless:true,exploration:'controls',coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',settleMs:0,observeTimeoutMs:240,evidence:{enabled:false},
  executionBoundary:{version:1,programNavigation:'public-navigation-v1',urls:[{match:'route',origin:new URL(url).origin,pathnamePattern:'^/.*$'}],allowedOperations:['click','select'],exclusions:[]},...options});
 return {engine,sid:s.id,meter,async edit(fn:()=>void){meter.charge('fixture-mutation');await pageOf(engine).evaluate(fn);},async close(){try{await engine.close();await new Promise<void>(r=>server.close(()=>r()));expect(meter.commands.length).toBeLessThanOrEqual(40);expect(meter.rejected).toBe(0);expect(Date.now()-meter.began).toBeLessThan(60000);}finally{meter.restore();}}};
}

it('uses the ready disclosure when a sibling field inside the same navigation keeps changing',async()=>{
 const f=await sdkFixture(`<nav><details><summary>Menu</summary><a href="/child">Child</a></details><input aria-label="Other live field" id="quote"></nav><script>setInterval(()=>quote.value=String(Date.now()),10)</script>`,{settleMs:40});
 try{
  expect(f.engine.observation(f.sid).controls.find(c=>c.name==='Menu')?.readiness).toBeUndefined();
  const receipt=await act(f.engine,f.sid,'Menu');expect(receipt.status,receipt.reason).toBe('succeeded');
  const after=f.engine.observation(f.sid);expect(after.controls.find(c=>c.name==='Child')?.visible).toBe(true);
  expect(after.controls.find(c=>c.name==='Other live field')?.readiness?.status).toBe('unstable');
  expect(after.gaps.some(g=>g.critical)).toBe(false);
 }finally{await f.close();}
});

it.each(['destination','option','mode','record','reference','obstruction'] as const)('rejects stale local material when related %s changes',async kind=>{
 const f=await sdkFixture(`<nav><details open><summary>Menu</summary><a href="/first" data-record-id="one">Child</a><select aria-label="Option"><option value="one">One</option><option value="two">Two</option></select><span id="mode" aria-selected="true">Mode</span><p id="meaning">Meaning</p></details></nav>`);
 try{
  const o=f.engine.observation(f.sid),a=f.engine.actions(f.sid).find(a=>a.label==='Child')!;
  f.meter.charge('fixture-mutation');await pageOf(f.engine).evaluate(kind=>{
   if(kind==='destination')document.querySelector('a')!.setAttribute('href','/second');
   if(kind==='option')(document.querySelector('select') as HTMLSelectElement).value='two';
   if(kind==='mode')document.querySelector('#mode')!.setAttribute('aria-selected','false');
   if(kind==='record')document.querySelector('a')!.setAttribute('data-record-id','two');
   if(kind==='reference')document.querySelector('a')!.setAttribute('aria-describedby','absent');
   if(kind==='obstruction'){const dialog=document.createElement('dialog');dialog.innerHTML='<button>Close</button>';document.body.append(dialog);dialog.showModal();}
  },kind);
  expect(await (f.engine as any).driver.preflight(o,a)).toBe('stale');expect(f.engine.list(f.sid,'attempt')).toHaveLength(0);
  const refreshed=await f.engine.observe(f.sid);
  if(kind==='destination')expect(refreshed.controls.find(c=>c.name==='Child')?.reviewBinding?.attributes.href).toBe('/second');
  if(kind==='record')expect(refreshed.controls.find(c=>c.name==='Child')?.reviewAttributes?.['data-record-id']).toBe('two');
  if(kind==='option')expect(refreshed.controls.find(c=>c.name==='Option')?.selected).toEqual(['two']);
  if(kind==='obstruction')expect(f.engine.actionAvailability(f.sid,refreshed.id).actions.filter(a=>f.engine.actions(f.sid).some(candidate=>candidate.id===a.actionId&&candidate.label==='Child')).every(a=>!a.executable)).toBe(true);
 }finally{await f.close();}
});

it.each(['missing','ambiguous','bounded','progress'])('retains unknown acquisition and blocks the dependent entry (%s)',async kind=>{
 const body=kind==='progress'?'<progress></progress>':kind==='bounded'?'<div>'.repeat(520)+'</div>'.repeat(520):'';
 const refs=kind==='missing'?'missing':'panel';
 const f=await sdkFixture(`<nav><button type="button" aria-expanded="true" aria-controls="${refs}">Pending</button><section id="panel">${body}</section>${kind==='ambiguous'?'<section id="panel"></section>':''}</nav><nav><a href="/independent">Independent</a></nav>`);
 try{
  const o=f.engine.observation(f.sid);expect(o.contentReadiness?.status).toBe('unknown');expect(o.gaps.some(g=>g.code==='ASYNC_CONTENT_PENDING')).toBe(true);
  expect(o.controls.find(c=>c.name==='Pending')?.readiness?.status).toBe('unstable');expect(o.controls.find(c=>c.name==='Independent')?.readiness).toBeUndefined();
  expect(o.gaps.some(g=>g.critical)).toBe(false);
 }finally{await f.close();}
});

it('keeps a popup boundary that appears while a disclosure is loading',async()=>{
 const f=await sdkFixture(`<nav><details><summary onclick="setTimeout(()=>{document.querySelector('dialog').showModal()},80)">Menu</summary><div aria-busy="true">Pending</div><a href="/child">Child</a></details></nav><dialog><button type="button" onclick="this.closest('dialog').close()">Close</button></dialog>`);
 try{
  await act(f.engine,f.sid,'Menu');const o=f.engine.observation(f.sid);
  expect(o.boundaries?.length).toBeGreaterThan(0);
  const child=f.engine.actionAvailability(f.sid,o.id).actions.filter(a=>f.engine.actions(f.sid).some(candidate=>candidate.id===a.actionId&&candidate.label==='Child'));expect(child.every(a=>!a.executable)).toBe(true);
  expect(f.engine.list<any>(f.sid,'attempt').some(a=>a.action.label==='Child')).toBe(false);
 }finally{await f.close();}
});

it('retains disclosure inventory truncation instead of treating an omitted trigger as ready',async()=>{
 const f=await sdkFixture('<nav>'+Array.from({length:25},(_,i)=>`<details><summary>Menu ${i}</summary></details>`).join('')+'</nav>');
 try{
  const o=f.engine.observation(f.sid),last=o.controls.find(c=>c.name==='Menu 24')!;
  expect(last.readiness?.status).toBe('unstable');expect(o.contentReadiness?.scopes.some(s=>s.reasons.includes('disclosure_bound'))).toBe(true);
  expect(o.controls.find(c=>c.name==='Menu 0')?.readiness).toBeUndefined();
 }finally{await f.close();}
});
