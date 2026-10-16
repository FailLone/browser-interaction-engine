import {createServer} from 'node:http';
import {afterEach,expect,it} from 'vitest';
import type {ActionAttempt} from '@interaction/browser';
import {pageOf,testEngine} from './helpers.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(html:string){
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(html);});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 cleanup.push(()=>new Promise<void>(done=>server.close(()=>done())));
 const t=await testEngine(`http://127.0.0.1:${(server.address() as {port:number}).port}/`,{contextRules:[],exploration:'controls',observeTimeoutMs:1000},{samples:()=>['2']});cleanup.push(t.close);return t;
}
const pick=(t:Awaited<ReturnType<typeof fixture>>,label:string,kind='click')=>{
 const matches=t.engine.actions(t.sessionId).filter(a=>a.label===label&&a.kind===kind);expect(matches).toHaveLength(1);return matches[0];
};
const nested=(field:string,quote=false)=>`<details id="outer"><summary id="open-outer">Outer</summary><section id="navigation" aria-label="Navigation"><label>Mode<select id="mode"><option>A</option><option>B</option></select></label><details id="inner"><summary id="open-inner">Inner</summary><form id="work">${field}</form></details></section></details>
 ${quote?'<form id="quote-form"><label>Quote<input id="quote" readonly></label></form><script>localStorage.loads=String(Number(localStorage.loads||0)+1);document.querySelector("#quote").value=localStorage.loads;</script>':''}
 <output id="hits">0</output><script>document.addEventListener('input',event=>{if(event.target.id==='target')document.querySelector('#hits').textContent=String(Number(document.querySelector('#hits').textContent)+1)});</script>`;
const field='<label>Target<input id="target"></label>';
async function prepare(t:Awaited<ReturnType<typeof fixture>>,kind='fill'){
 const path:ActionAttempt[]=[];
 for(const label of ['Outer','Inner'])path.push(await t.engine.execute(t.sessionId,pick(t,label).id,crypto.randomUUID()));
 expect(path.every(a=>a.status==='succeeded')).toBe(true);
 const a=pick(t,'Target',kind),checkpoint=await t.engine.createCheckpoint(t.sessionId,'nested target');
 await pageOf(t.engine).evaluate(()=>{document.querySelector<HTMLDetailsElement>('#inner')!.open=false;document.querySelector<HTMLDetailsElement>('#outer')!.open=false;const quote=document.querySelector<HTMLInputElement>('#quote');if(quote)quote.value='999';});
 await t.engine.observe(t.sessionId);
 return {input:{checkpointId:checkpoint.id,observationId:a.observationId,actionIds:[a.id]},path};
}

it('captures native hidden descendants without hiding the active summary or requiring pointer hit testing for inputs',async()=>{
 const t=await fixture(`<details id="outer"><summary id="summary" aria-label="Outer"><span>Outer</span><input id="summary-input" aria-label="Summary input"></summary>
 <summary id="extra-summary">Extra summary</summary><details id="inner" open><summary id="inner-summary">Inner</summary><input id="hidden-input" aria-label="Hidden input"><select id="hidden-select" aria-label="Hidden select"><option>A</option><option>B</option></select></details></details>
 <div style="content-visibility:hidden"><input id="content-hidden" aria-label="Content hidden"></div>
 <input id="transparent" aria-label="Transparent" style="opacity:0"><input id="covered" aria-label="Covered"><div id="cover" style="position:fixed;background:red;z-index:9999"></div>`);
 const ids=['summary','summary-input','extra-summary','inner-summary','hidden-input','hidden-select','content-hidden','transparent','covered'];
 const check=async()=>{const o=await t.engine.observe(t.sessionId);for(const id of ids){const c=o.controls.find(c=>c.stableKey===`id:${id}`)!;expect(c, id).toBeDefined();expect(c.visible,id).toBe(await pageOf(t.engine).locator(`#${id}`).isVisible());}return o;};
 let o=await check();expect(o.controls.find(c=>c.stableKey==='id:hidden-input')?.visible).toBe(false);expect(o.controls.find(c=>c.stableKey==='id:summary-input')?.visible).toBe(true);
 expect(t.engine.actions(t.sessionId).some(a=>a.label==='Hidden input'||a.label==='Hidden select')).toBe(false);
 await pageOf(t.engine).evaluate(()=>{document.querySelector<HTMLDetailsElement>('#outer')!.open=true;const r=document.querySelector('#covered')!.getBoundingClientRect();Object.assign(document.querySelector<HTMLElement>('#cover')!.style,{left:`${r.x}px`,top:`${r.y}px`,width:`${r.width}px`,height:`${r.height}px`});});
 o=await check();expect(o.controls.find(c=>c.stableKey==='id:hidden-input')?.visible).toBe(true);
 const covered=pick(t,'Covered','fill'),cp=await t.engine.createCheckpoint(t.sessionId,'covered native input');
 expect(o.controls.find(c=>c.stableKey==='id:covered')?.actionable.hitTarget).toBe(false);
 const reached=await t.engine.reachExplorationTarget(t.sessionId,{checkpointId:cp.id,observationId:o.id,actionIds:[covered.id]});
 expect(reached.status).toBe('TARGET_REACHED');
 expect((await t.engine.execute(t.sessionId,reached.matchedActionIds[0],crypto.randomUUID(),undefined,{profile:'interface-exploration',observationId:reached.observationId!})).status).toBe('succeeded');
 expect(await pageOf(t.engine).locator('#covered').inputValue()).toBe('2');
});

it.each(['fill','select'] as const)('recovers a hidden nested %s target before claiming arrival and dispatching it',async kind=>{
 const t=await fixture(nested(kind==='fill'?field:'<label>Target<select id="target"><option>1</option><option>2</option></select></label>'));
 const {input}=await prepare(t,kind),before=t.engine.observation(t.sessionId);
 expect(before.controls.find(c=>c.stableKey==='id:target')?.visible).toBe(false);
 const reached=await t.engine.reachExplorationTarget(t.sessionId,input);
 expect(reached.status,JSON.stringify(reached)).toBe('TARGET_REACHED');expect(reached.attemptIds).toHaveLength(2);
 expect(await pageOf(t.engine).locator('#target').isVisible()).toBe(true);
 const attempt=await t.engine.execute(t.sessionId,reached.matchedActionIds[0],crypto.randomUUID(),undefined,{profile:'interface-exploration',observationId:reached.observationId!});
 expect(attempt.status).toBe('succeeded');expect(await pageOf(t.engine).locator('#target').inputValue()).toBe('2');expect(await pageOf(t.engine).locator('#hits').textContent()).toBe('1');
});

it.each(['checkpoint','target'] as const)('keeps the %s recovery contract across a changed passive quote between nested replay steps',async contract=>{
 const t=await fixture(nested(field,true)),{input}=await prepare(t);
 if(contract==='checkpoint'){
  const result=await t.engine.reachCheckpoint(t.sessionId,input.checkpointId);expect(result.status).toBe('UNREACHABLE');expect(result.reason).toBe('replay_state_diverged');
 }else{
  const result=await t.engine.reachExplorationTarget(t.sessionId,input);expect(result.status,JSON.stringify(result)).toBe('TARGET_REACHED');expect(result.checkpointVerified).toBe(false);expect(result.attemptIds).toHaveLength(3);
  const attempt=await t.engine.execute(t.sessionId,result.matchedActionIds[0],crypto.randomUUID(),undefined,{profile:'interface-exploration',observationId:result.observationId!});
  expect(attempt.status).toBe('succeeded');expect(await pageOf(t.engine).locator('#hits').textContent()).toBe('1');
 }
});

it('rejects dispatch if a native ancestor closes after arrival was observed',async()=>{
 const t=await fixture(nested(field)),{input}=await prepare(t);
 const result=await t.engine.reachExplorationTarget(t.sessionId,input);expect(result.status).toBe('TARGET_REACHED');
 const attempts=t.engine.list(t.sessionId,'attempt').length;
 await pageOf(t.engine).evaluate(()=>{document.querySelector<HTMLDetailsElement>('#outer')!.open=false;});
 await expect(t.engine.execute(t.sessionId,result.matchedActionIds[0],crypto.randomUUID(),undefined,{profile:'interface-exploration',observationId:result.observationId!})).rejects.toMatchObject({code:'STALE_OBSERVATION'});
 expect(t.engine.list(t.sessionId,'attempt')).toHaveLength(attempts);expect(await pageOf(t.engine).locator('#hits').textContent()).toBe('0');
 expect(t.engine.observation(t.sessionId).controls.find(c=>c.stableKey==='id:target')?.visible).toBe(false);
});

it.each(['target-missing','recovery-unknown'] as const)('does not certify arrival when the last replay step leaves %s',async fault=>{
 const html=nested(field,true),t=await fixture(fault==='target-missing'?html.replace('id="open-inner"','id="open-inner" onclick="if(Number(localStorage.loads)>1)document.querySelector(\'#target\').remove()"'):html),{input}=await prepare(t);
 let unknownId:string|undefined;
 t.engine.events.on('event',event=>{
  if(fault!=='recovery-unknown'||event.type!=='action.completed')return;
  const attempt=event.data as ActionAttempt;
  if(attempt.purpose==='recovery'&&attempt.action.label==='Inner'){unknownId=attempt.id;t.engine.store.put('attempt',{...attempt,status:'unknown'});}
 });
 const result=await t.engine.reachExplorationTarget(t.sessionId,input),actual=t.engine.observation(t.sessionId);
 expect(result).toMatchObject({status:fault==='target-missing'?'UNREACHABLE':'UNVERIFIED',checkpointVerified:false,matchedActionIds:[],observationId:actual.id});
 expect(result.attemptIds).toHaveLength(3);expect(await pageOf(t.engine).locator('#hits').textContent()).toBe('0');
 if(fault==='target-missing'){expect(result.reason).toBe('target_not_reached');expect(await pageOf(t.engine).locator('#target').count()).toBe(0);}
 else{
  expect(unknownId).toBeDefined();expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt').find(a=>a.id===unknownId)?.status).toBe('unknown');
  expect(await pageOf(t.engine).locator('#target').isVisible()).toBe(true);
  await expect(t.engine.execute(t.sessionId,pick(t,'Target','fill').id,crypto.randomUUID(),undefined,{profile:'interface-exploration',observationId:actual.id})).rejects.toMatchObject({code:'UNKNOWN_ACTION_OUTCOME'});
 }
});

it.each(['unknown-source','nonreplayable-source','changed-mode'] as const)('refuses the next replay step when %s invalidates its evidence',async fault=>{
 const html=nested(field,true);
 // The fixture itself changes the mode on entry replay. Context init scripts
 // would be lost when recovery replaces the entire browser context.
 const t=await fixture(fault==='changed-mode'?html.replace('id="open-outer"','id="open-outer" onclick="if(Number(localStorage.loads)>1)document.querySelector(\'#mode\').value=\'B\'"'):html),{input,path}=await prepare(t);
 let injected=false;
 t.engine.events.on('event',event=>{
  if(event.type!=='action.completed')return;const attempt=event.data as ActionAttempt;
  if(attempt.purpose!=='recovery'||attempt.action.label!=='Outer')return;
  if(fault==='changed-mode')return;
  injected=true;t.engine.store.put('attempt',fault==='unknown-source'?{...path[1],status:'unknown'}:{...path[1],action:{...path[1].action,replayable:false}});
 });
 const result=await t.engine.reachExplorationTarget(t.sessionId,input);
 if(fault==='changed-mode')expect(await pageOf(t.engine).locator('#mode').inputValue()).toBe('B');else expect(injected).toBe(true);
 expect(result.status).not.toBe('TARGET_REACHED');
 if(fault==='unknown-source')expect(result.reason).toBe('unknown_execution_outcome');
 if(fault==='nonreplayable-source')expect(result.reason).toBe('path_contains_nonreplayable_action');
 if(fault==='changed-mode')expect(result.reason).toMatch(/conditions_changed/);
 const attempts=t.engine.list<ActionAttempt>(t.sessionId,'attempt').filter(a=>a.purpose==='recovery');
 expect(attempts.map(a=>a.action.label)).toEqual(['Reopen session entry','Outer']);expect(await pageOf(t.engine).locator('#hits').textContent()).toBe('0');
 if(fault==='unknown-source')expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt').find(a=>a.id===path[1].id)?.status).toBe('unknown');
});
