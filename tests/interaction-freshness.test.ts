import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {BrowserEngine,type ActionAttempt,type SessionOptions,type ControlReviewInput,type EngineHooks} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';
import {pageOf} from './helpers.js';

const html=`<button id="quote" type="button">Quote 1</button><input id="background" aria-label="Background" value="1">
 <div id="context">A</div><div id="panel" role="dialog" aria-modal="true" style="position:fixed;left:100px;top:100px;width:300px;height:160px;background:white;z-index:5">
 <h2>Notice</h2><input aria-label="Inside" value="unchanged"><button id="close" type="button" onclick="document.querySelector('#panel').remove();window.closedCount++">Close</button></div>
 <script>window.closedCount=0;window.bump=()=>{quote.textContent='Quote '+Math.random();background.value=String(Math.random())}</script>`;
async function fixture(body:string|Record<string,string>=html,options:Partial<SessionOptions>={},hooks:EngineHooks={}){
 const server=createServer((q,res)=>{res.setHeader('Content-Type','text/html');res.end(typeof body==='string'?body:body[q.url!]||'<p>Missing page</p>')});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const engine=new BrowserEngine({persistence:new MemoryStore(),hooks});const s=await engine.createSession({url:`http://127.0.0.1:${(server.address() as any).port}`,headless:true,settleMs:100,observeTimeoutMs:900,...options});
 return {engine,sid:s.id,close:async()=>{await engine.close();await new Promise<void>(r=>server.close(()=>r()))}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function review(t:Fixture,name='Close'):ControlReviewInput{const o=t.engine.observation(t.sid);const c=o.controls.find(c=>c.name===name)!;return {observationId:o.id,source:'external-review',reviews:[{localId:c.localId,kind:'click',risk:'interface',reason:'Review this current interface control',evidence:['Current exact target and intended operation']}]}}
const action=(t:Fixture,name='Close')=>t.engine.actions(t.sid).find(a=>a.label===name&&a.kind==='click')!;

it('records and dispatches a stable modal exit despite changing background controls, retaining full before/after evidence',async()=>{
 const t=await fixture();try{
  const original=t.engine.observation(t.sid);const input=review(t);await pageOf(t.engine).evaluate(()=>(window as any).bump());
  const [r]=await t.engine.reviewControls(t.sid,input);expect(r.status).toBe('active');const prepared=action(t);
  await pageOf(t.engine).evaluate(()=>(window as any).bump());const result=await t.engine.execute(t.sid,prepared.id,'exit-background');
  expect(result.status).toBe('succeeded');expect(await pageOf(t.engine).evaluate(()=>(window as any).closedCount)).toBe(1);
  expect(t.engine.observation(t.sid).boundaries).toEqual([]);expect(t.engine.observation(t.sid).controls.find(c=>c.selector==='#quote')?.name).not.toBe('Quote 1');
  expect(t.engine.observation(t.sid,original.id)).toEqual(original);expect(t.engine.list<ActionAttempt>(t.sid,'attempt')).toHaveLength(1);
 }finally{await t.close()}
});

it('settles the active boundary while native background controls keep updating, without calling the full page stable',async()=>{
 const t=await fixture(html.replace('</script>',';setInterval(window.bump,30)</script>'));try{
  const o=t.engine.observation(t.sid);expect(o.stable).toBe(false);expect(o.gaps.some(g=>g.code==='INTERACTION_STABLE')).toBe(true);expect(o.gaps.some(g=>g.critical)).toBe(false);
  await t.engine.reviewControls(t.sid,review(t));expect(t.engine.list(t.sid,'control-review')).toHaveLength(1);
 }finally{await t.close()}
});

it.each(['inside-value','target-name','target-parent','target-replace','target-disable','target-handler','occlude','new-modal','owner-replace','url','context'] as const)('rejects a current modal exit after %s changes',async change=>{
 const t=await fixture(html,{contextRules:[{key:'mode',selector:'#context'}]});try{
  await t.engine.reviewControls(t.sid,review(t));const prepared=action(t);
  await pageOf(t.engine).evaluate(change=>{const close=document.querySelector('#close')!,panel=document.querySelector('#panel')!;
   if(change==='inside-value')(panel.querySelector('input') as HTMLInputElement).value='changed';
   if(change==='target-name')close.textContent='Submit';
   if(change==='target-parent'){const p=document.createElement('div');panel.append(p);p.append(close)}
   if(change==='target-replace')close.replaceWith(close.cloneNode(true));
   if(change==='target-disable')close.setAttribute('disabled','');
   if(change==='target-handler')close.setAttribute('onclick','window.other=1');
   if(change==='occlude'){const el=document.createElement('div');el.style.cssText='position:fixed;inset:0;z-index:99;background:red';document.body.append(el)}
   if(change==='new-modal'){const el=document.createElement('dialog');el.innerHTML='<button>Different exit</button>';document.body.append(el);el.showModal()}
   if(change==='owner-replace'){const el=panel.cloneNode(false);while(panel.firstChild)el.appendChild(panel.firstChild);panel.replaceWith(el)}
   if(change==='url')history.pushState({},'','#other');
   if(change==='context')document.querySelector('#context')!.textContent='B';
  },change);
  await expect(t.engine.execute(t.sid,prepared.id,'changed-exit')).rejects.toMatchObject({code:change==='context'?'PRECONDITIONS_CHANGED':'STALE_OBSERVATION'});
  expect(t.engine.session(t.sid).actionCount).toBe(0);expect(await pageOf(t.engine).evaluate(()=>(window as any).closedCount)).toBe(0);
 }finally{await t.close()}
});

it('keeps stateful preflight strict and does not ignore an outside target',async()=>{
 const strict=await fixture(html,{exploration:'stateful'});try{
  const input=review(strict);await pageOf(strict.engine).evaluate(()=>(window as any).bump());
  await expect(strict.engine.reviewControls(strict.sid,input)).rejects.toMatchObject({code:'STALE_CONTROL_REVIEW'});
 }finally{await strict.close()}
 const t=await fixture();try{
  const prepared=action(t,'Quote 1');await pageOf(t.engine).evaluate(()=>(window as any).bump());
  await expect(t.engine.execute(t.sid,prepared.id,'outside-target')).rejects.toMatchObject({code:'STALE_OBSERVATION'});expect(t.engine.session(t.sid).actionCount).toBe(0);
 }finally{await t.close()}
});

it('does not accept an obsolete tentative target description as a current control judgment',async()=>{
 const t=await fixture('<div id="custom" style="cursor:pointer">Open details</div>');try{
  const input=review(t,'Open details');await pageOf(t.engine).locator('#custom').evaluate(el=>el.textContent='Delete account');
  await expect(t.engine.reviewControls(t.sid,input)).rejects.toMatchObject({code:'STALE_CONTROL_REVIEW'});expect(t.engine.list(t.sid,'control-review')).toEqual([]);
 }finally{await t.close()}
});

it('returns by verified native history while unrelated destination controls change, without exploring them',async()=>{
 const t=await fixture({'/':'<a href="/b">To B</a>','/b':'<button id="quote" type="button">Quote 1</button><input aria-label="Unapproved B" value="1">'});try{
  await t.engine.execute(t.sid,action(t,'To B').id,'to-b');const driver=(t.engine as any).driver;const original=driver.preflight.bind(driver);let checked=false;
  driver.preflight=async(o:any,ids:string[],candidate:any)=>{
    if(candidate?.kind==='history'){checked=true;await pageOf(t.engine).locator('#quote').evaluate(el=>el.textContent='Quote 2')}
    return original(o,ids,candidate);
  };
  await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(checked).toBe(true);
  const attempts=t.engine.list<ActionAttempt>(t.sid,'attempt');expect(attempts.map(a=>a.action.label)).toEqual(['To B','Return to observed page']);
  expect(attempts.every(a=>a.status==='succeeded')).toBe(true);expect(t.engine.observation(t.sid).url.endsWith('/')).toBe(true);
  expect(t.engine.report(t.sid).pageExploration?.lastReturn?.status).toBe('returned');
 }finally{await t.close()}
});

it.each(['modal','url','context'] as const)('does not use history-scoped freshness to ignore a changed %s',async change=>{
 const t=await fixture({'/':'<a href="/b">To B</a><span id="context">A</span>','/b':'<span id="context">A</span><input aria-label="Unapproved B">'}, {contextRules:[{key:'mode',selector:'#context'}]});try{
  await t.engine.execute(t.sid,action(t,'To B').id,'to-b');const driver=(t.engine as any).driver;const original=driver.preflight.bind(driver);
  driver.preflight=async(o:any,ids:string[],candidate:any)=>{
    if(candidate?.kind==='history')await pageOf(t.engine).evaluate(change=>{
      if(change==='modal'){const el=document.createElement('dialog');el.innerHTML='<button>Close</button>';document.body.append(el);el.showModal()}
      if(change==='url')history.pushState({},'','#different');
      if(change==='context')document.querySelector('#context')!.textContent='B';
    },change);
    return original(o,ids,candidate);
  };
  await t.engine.explore(t.sid);await t.engine.waitForIdle();expect(t.engine.list<ActionAttempt>(t.sid,'attempt').map(a=>a.action.label)).toEqual(['To B']);
  expect(t.engine.observation(t.sid).url).toContain('/b');expect(t.engine.report(t.sid).pageExploration?.lastReturn?.status).not.toBe('returned');
 }finally{await t.close()}
});

it('allows a current boundary Escape after background changes but does not grant whole-page stability',async()=>{
 const t=await fixture('<button id="quote">Quote 1</button><div id="panel" popover><input aria-label="Inside"></div><script>panel.showPopover()</script>');try{
  const prepared=t.engine.actions(t.sid).find(a=>a.kind==='press'&&a.value==='Escape')!;
  await pageOf(t.engine).locator('#quote').evaluate(el=>el.textContent='Quote 2');
  expect((await t.engine.execute(t.sid,prepared.id,'escape-current')).status).toBe('succeeded');
  expect(t.engine.observation(t.sid).boundaries).toEqual([]);expect(t.engine.session(t.sid).actionCount).toBe(1);
 }finally{await t.close()}
});
