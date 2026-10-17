import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {BrowserEngine,type BrowserAdapter,type ActionAttempt,type SessionOptions} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {act,pageOf} from './helpers.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanups.splice(0).reverse())await close();});
const work='<div id="usd" tabindex="0" aria-label="USD">USD</div><form id="order"><label>Amount<input id="amount" value="1" oninput="this.dataset.edits=String(Number(this.dataset.edits||0)+1)"></label></form>';
const quote='<label>Quote<input id="quote" readonly value="100"></label>';
const menus=`<button id="outer" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#outer-body').hidden=false">Outer</button><section id="outer-body" hidden><button id="inner" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#inner-body').hidden=false">Inner</button><section id="inner-body" hidden>${work}</section></section>${quote}`;
async function fixture(html:string,options:Partial<SessionOptions>={}) {
 const began=performance.now(),stages:unknown[]=[];let visits=0;
 const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end(`${html}<script>document.querySelector('#quote').value=String(${++visits})</script>`);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 cleanups.push(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
 const directory=mkdtempSync(join(tmpdir(),'review-target-live-')),url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
 const t={engine:new BrowserEngine({persistence:new SqliteStore(directory)}),sessionId:'',stages,visits:()=>visits,
  async restart(){await t.engine.close();t.engine=new BrowserEngine({persistence:new SqliteStore(directory)});},
  async stage<T>(name:string,run:()=>Promise<T>):Promise<T>{const start=performance.now();try{return await run();}finally{stages.push({name,ms:Math.round(performance.now()-start),visits});}}};
 cleanups.push(async()=>{console.info('live-recovery-stages',JSON.stringify(stages));await t.engine.close();rmSync(directory,{recursive:true,force:true});});
 const session=await t.engine.createSession({url,headless:true,contextRules:[],exploration:'controls',settleMs:50,observeTimeoutMs:500,actionTimeoutMs:1500,...options});
 t.sessionId=session.id;stages.push({name:'setup',ms:Math.round(performance.now()-began)});return t;
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function source(t:Fixture){
 const o=t.engine.observation(t.sessionId),controls=o.controls.filter(c=>c.name==='USD');expect(controls).toHaveLength(1);
 const checkpoint=await t.engine.createCheckpoint(t.sessionId,'review work');
 return {checkpointId:checkpoint.id,observationId:o.id,localId:controls[0].localId,requireSourceEquivalent:true};
}
async function reachAndContinue(t:Fixture,input:Awaited<ReturnType<typeof source>>){
 const result=await t.stage('recovery',()=>t.engine.reachControlReviewTarget(t.sessionId,input));
 t.stages.push({result:result.status,reason:result.reason,checks:result.checks,attempts:result.attemptIds.length,strategies:result.diagnostics?.strategies});
 expect(result,JSON.stringify(result)).toMatchObject({status:'CURRENT_REVIEWABLE',sourceEquivalent:'equivalent',checkpointVerified:false,currentExecution:false,coverageGranted:false});
 // Independent live-page oracle; the subsequent action still goes through the SDK.
 expect(await pageOf(t.engine).locator('#usd').isVisible()).toBe(true);
 expect(await pageOf(t.engine).locator('#amount').inputValue()).toBe('1');
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt').filter(a=>a.action.label==='Amount')).toEqual([]);
 const receipt=await t.stage('new-input',()=>act(t.engine,t.sessionId,'Amount','fill','2'));
 expect(receipt).toMatchObject({status:'succeeded',purpose:'external'});
 expect(await pageOf(t.engine).locator('#amount').inputValue()).toBe('2');
 expect(await pageOf(t.engine).locator('#amount').getAttribute('data-edits')).toBe('1');
 const condition=t.engine.operationReceiptCondition(t.sessionId,{attemptId:receipt.id});
 t.stages.push({receipt:{status:receipt.status,conditionVerified:condition.conditionVerified,reason:condition.reason},recoveryOperations:result.attemptIds.map(id=>t.engine.list<ActionAttempt>(t.sessionId,'attempt').find(a=>a.id===id)?.action.label)});
 expect(condition.conditionVerified,JSON.stringify(condition)).toBe(true);
 return result;
}
const menuOptions={interfaceActions:[{stableKey:'id:outer'},{stableKey:'id:inner'}],replayable:[{stableKey:'id:outer'},{stableKey:'id:inner'}]};
async function openMenus(t:Fixture){await act(t.engine,t.sessionId,'Outer');await act(t.engine,t.sessionId,'Inner');}

it.each([false,true])('locally reopens retained hidden nested review targets without entry reload (changed quote: %s)',async changedQuote=>{
 const t=await fixture(menus,menuOptions);await openMenus(t);const input=await source(t),visits=t.visits();
 await pageOf(t.engine).evaluate(()=>{for(const id of ['outer','inner']){document.querySelector(`#${id}`)!.setAttribute('aria-expanded','false');(document.querySelector(`#${id}-body`) as HTMLElement).hidden=true;}});
 if(changedQuote)await pageOf(t.engine).locator('#quote').evaluate(el=>(el as HTMLInputElement).value='200');
 await t.engine.observe(t.sessionId);
 const result=await reachAndContinue(t,input);
 expect(result.diagnostics?.strategies).toContain('recorded_path');expect(result.attemptIds).toHaveLength(2);
 expect(t.visits()).toBe(visits);expect(result.diagnostics?.strategies).not.toContain('entry_replay');
});

it('restores multiple declared modes despite passive quote changes while preserving distinct A/B conditions',async()=>{
 const t=await fixture(`<label>Mode<input id="mode" type="checkbox" onchange="document.querySelector('#quote').value=String(Number(document.querySelector('#quote').value)+1)"></label><label>Option<input id="option" type="checkbox" onchange="document.querySelector('#quote').value=String(Number(document.querySelector('#quote').value)+1)"></label>${work}${quote}`,{reversible:[{stableKey:'id:mode'},{stableKey:'id:option'}]});
 const input=await source(t),original=t.engine.observation(t.sessionId),visits=t.visits();
 await act(t.engine,t.sessionId,'Mode','check',true);await act(t.engine,t.sessionId,'Option','check',true);
 const current=t.engine.observation(t.sessionId),control=current.controls.find(c=>c.name==='USD')!;
 expect(t.engine.controlReviewTargetCorrespondence(t.sessionId,{observationId:current.id,localId:control.localId,source:{sessionId:t.sessionId,observationId:input.observationId,localId:input.localId}}).sourceEquivalent).toBe('different');
 const result=await reachAndContinue(t,input);
 expect(result.diagnostics?.strategies).toContain('declared_local_restore');expect(result.attemptIds).toHaveLength(2);
 const steps=t.engine.store.events(t.sessionId).filter(e=>e.type==='checkpoint.local_restore');expect(steps).toHaveLength(2);
 expect(steps.map(e=>(e.data as {postcondition:{result:string}}).postcondition.result)).toEqual(['pass','pass']);
 expect(await pageOf(t.engine).locator('#mode').isChecked()).toBe(false);expect(await pageOf(t.engine).locator('#option').isChecked()).toBe(false);
 expect(t.engine.observation(t.sessionId).canonical).not.toBe(original.canonical);expect(t.visits()).toBe(visits);
});

it('replays a nested review source after a real browser restart and retains unknown blocking across another restart',async()=>{
 const t=await fixture(menus,menuOptions);await openMenus(t);const input=await source(t),original=t.engine.observation(t.sessionId);
 await t.stage('restart',()=>t.restart());
 const result=await reachAndContinue(t,input);
 expect(result.diagnostics?.strategies).toContain('recorded_source_path');expect(result.diagnostics?.strategies).not.toContain('entry_replay');
 expect(t.engine.observation(t.sessionId).instanceScope).not.toBe(original.instanceScope);
 expect(result.attemptIds).toHaveLength(2);expect(t.visits()).toBe(2);
 const attempts=t.engine.list<ActionAttempt>(t.sessionId,'attempt'),interrupted=attempts.find(a=>a.action.label==='Amount')!;
 // Deterministic durable-ledger fault injection; only this temporary test store is changed.
 t.engine.store.put('attempt',{...interrupted,status:'unknown',reason:'Injected missing durable result'} satisfies ActionAttempt);
 await t.restart();
 const blocked=await t.stage('unknown-restart',()=>t.engine.reachControlReviewTarget(t.sessionId,input));
 expect(blocked).toMatchObject({status:'UNVERIFIED',attemptIds:[]});expect(blocked.reason).toContain('Unknown execution outcome');
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt')).toHaveLength(attempts.length);
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt').find(a=>a.id===interrupted.id)?.status).toBe('unknown');
 expect((t.engine as unknown as {driver?:unknown}).driver).toBeUndefined();
});

it('uses full entry replay when a changed mode prevents every current path continuation',async()=>{
 const t=await fixture(`${menus}<label>Mode<input id="mode" type="checkbox"></label>`,menuOptions);
 await openMenus(t);const input=await source(t);await act(t.engine,t.sessionId,'Mode','check',true);
 await pageOf(t.engine).evaluate(()=>{for(const id of ['outer','inner']){document.querySelector(`#${id}`)!.setAttribute('aria-expanded','false');(document.querySelector(`#${id}-body`) as HTMLElement).hidden=true;}});
 await t.engine.observe(t.sessionId);const result=await reachAndContinue(t,input);
 expect(result.diagnostics?.strategies).toContain('entry_replay');expect(result.attemptIds).toHaveLength(3);expect(t.visits()).toBe(2);
 expect(await pageOf(t.engine).locator('#mode').isChecked()).toBe(false);
});

it('keeps a failed source path outstanding without retrying through entry reload',async()=>{
 const t=await fixture(menus,menuOptions);await openMenus(t);const input=await source(t);
 await pageOf(t.engine).evaluate(()=>{
  for(const id of ['outer','inner']){document.querySelector(`#${id}`)!.setAttribute('aria-expanded','false');(document.querySelector(`#${id}-body`) as HTMLElement).hidden=true;}
  (document.querySelector('#quote') as HTMLInputElement).value='200';
  document.querySelector('#inner')!.addEventListener('click',e=>e.stopImmediatePropagation(),true);
 });
 await t.engine.observe(t.sessionId);const result=await t.stage('failed-source-path',()=>t.engine.reachControlReviewTarget(t.sessionId,input));
 t.stages.push({status:result.status,reason:result.reason,attempts:result.attemptIds.length,strategies:result.diagnostics?.strategies});
 expect(result.status).toBe('UNREACHABLE');expect(result.reason).toBe('target_not_reached');expect(result.attemptIds).toHaveLength(2);
 expect(result.diagnostics?.strategies).toContain('recorded_source_path');expect(result.diagnostics?.strategies).not.toContain('entry_replay');expect(t.visits()).toBe(1);
 expect(await pageOf(t.engine).locator('#usd').isVisible()).toBe(false);
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt').filter(a=>a.action.label==='Amount')).toEqual([]);
});

it('preserves an unknown arrival preflight without immediately retrying it to success',async()=>{
 const t=await fixture(menus,menuOptions);await openMenus(t);const input=await source(t);
 await pageOf(t.engine).evaluate(()=>{
  for(const id of ['outer','inner']){document.querySelector(`#${id}`)!.setAttribute('aria-expanded','false');(document.querySelector(`#${id}-body`) as HTMLElement).hidden=true;}
  (document.querySelector('#quote') as HTMLInputElement).value='200';
 });
 await t.engine.observe(t.sessionId);
 const driver=(t.engine as unknown as {driver:BrowserAdapter}).driver,preflight=driver.preflight.bind(driver);let reviewChecks=0;
 // A transient uncertainty at the exact arrival boundary. A second unchecked
 // retry would say valid; recovery must preserve the first stop instead.
 vi.spyOn(driver,'preflight').mockImplementation(async(o,a,ids)=>ids?.length?++reviewChecks===1?'stale':'valid':preflight(o,a,ids));
 const result=await t.stage('unknown-arrival-preflight',()=>t.engine.reachControlReviewTarget(t.sessionId,input));
 expect(result).toMatchObject({status:'UNVERIFIED',coverageGranted:false,currentExecution:false});expect(reviewChecks).toBe(1);
 expect(result.attemptIds).toHaveLength(2);expect(t.visits()).toBe(1);
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt').filter(a=>a.action.label==='Amount')).toEqual([]);
});

it.each(['removed-review-target','changed-editable-sibling','aria-readonly-sibling','strict-checkpoint'])('stops after the first inverse for %s',async variant=>{
 const t=await fixture(`<label>Mode<input id="mode" type="checkbox" onchange="document.querySelector('#quote').value=String(Number(document.querySelector('#quote').value)+1)"></label><label>Option<input id="option" type="checkbox"></label>${work}${quote}<label>Aria only<input id="aria-only" aria-readonly="true" value="1"></label>`,{reversible:[{stableKey:'id:mode'},{stableKey:'id:option'}]});
 const input=await source(t);await act(t.engine,t.sessionId,'Mode','check',true);await act(t.engine,t.sessionId,'Option','check',true);
 if(variant!=='strict-checkpoint')await pageOf(t.engine).evaluate(variant=>document.querySelector('#mode')!.addEventListener('change',()=>{
  if(!(document.querySelector('#mode') as HTMLInputElement).checked){if(variant==='removed-review-target')document.querySelector('#usd')!.remove();else (document.querySelector(variant==='aria-readonly-sibling'?'#aria-only':'#amount') as HTMLInputElement).value='unexpected';}
 }),variant);
 const result=await t.stage(variant,async()=>variant==='strict-checkpoint'?await t.engine.reachCheckpoint(t.sessionId,input.checkpointId):await t.engine.reachControlReviewTarget(t.sessionId,input));
 expect(result).toMatchObject({status:'UNVERIFIED'});expect(result.reason).toContain('restoration diverged');expect(result.attemptIds).toHaveLength(1);
 expect(await pageOf(t.engine).locator('#option').isChecked()).toBe(true);
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt').filter(a=>a.action.label==='Amount')).toEqual([]);
});
