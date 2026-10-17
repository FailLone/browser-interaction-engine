import {createServer} from 'node:http';
import {afterEach,expect,it,vi} from 'vitest';
import type {ActionAttempt,ActionCandidate} from '@interaction/browser';
import {pageOf,testEngine} from './helpers.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function fixture(html:string,options:Parameters<typeof testEngine>[1]={}) {
 const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end(html);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 cleanups.push(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
 const t=await testEngine(url,{contextRules:[],exploration:'controls',...options},{samples:()=>['2']});cleanups.push(t.close);return t;
}
function action(t:Awaited<ReturnType<typeof fixture>>,label:string,kind='click') {
 const result=t.engine.actions(t.sessionId).filter(a=>a.label===label&&a.kind===kind);expect(result).toHaveLength(1);return result[0];
}
async function target(t:Awaited<ReturnType<typeof fixture>>,a:ActionCandidate) {
 const cp=await t.engine.createCheckpoint(t.sessionId,'target baseline');
 return {checkpointId:cp.id,observationId:a.observationId,actionIds:[a.id]};
}

it('verifies a ready target beside a ticking quote without claiming strict checkpoint restoration or execution',async()=>{
 const t=await fixture('<form id="order"><label>Amount<input id="amount" value="1"></label></form><a id="quote" href="/quote">BTC 100</a><script>let n=100;setInterval(()=>document.querySelector("#quote").textContent="BTC "+(++n),15)</script>',{settleMs:80,observeTimeoutMs:260});
 const old=action(t,'Amount','fill'),input=await target(t,old),before=t.engine.observation(t.sessionId);
 expect(before.stable).toBe(false);
 const strict=await t.engine.reachCheckpoint(t.sessionId,input.checkpointId);expect(strict.status).toBe('UNVERIFIED');
 const reached=await t.engine.reachExplorationTarget(t.sessionId,input);
 expect(reached).toMatchObject({status:'TARGET_REACHED',checkpointVerified:false,currentExecution:false,attemptIds:[]});
 expect(reached.matches).toHaveLength(1);expect(reached.matches[0]).toMatchObject({replayAuthorized:false,currentExecution:false,identityAuthorized:false});
 expect(t.engine.observation(t.sessionId).canonical).not.toBe(before.canonical);
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt')).toHaveLength(0);
 expect(t.engine.list(t.sessionId,'reach')).toHaveLength(1);expect(t.engine.list(t.sessionId,'target-reach')).toHaveLength(1);
});

it('matches unexecuted rebuilt targets but rejects changed declared context and ambiguous bindings',async()=>{
 const t=await fixture('<form id="order"><label>Amount<input id="amount" value="1"></label></form>');
 const old=action(t,'Amount','fill'),input=await target(t,old),before=t.engine.observation(t.sessionId);
 await pageOf(t.engine).evaluate(()=>{const field=document.querySelector('#amount')!;field.replaceWith(field.cloneNode(true));});
 await t.engine.observe(t.sessionId);
 const fresh=action(t,'Amount','fill'),batch=t.engine.explorationTargetCorrespondences(t.sessionId,{observationId:fresh.observationId,requests:[{actionId:fresh.id,source:{sessionId:t.sessionId,observationId:old.observationId,actionId:old.id}}]});
 expect(batch.results[0]).toMatchObject({equivalent:true,currentExecution:false,replayAuthorized:false});
 expect(t.engine.observation(t.sessionId).controls.find(c=>c.localId===fresh.localId)?.instanceId).not.toBe(before.controls.find(c=>c.localId===old.localId)?.instanceId);
 expect((await t.engine.reachExplorationTarget(t.sessionId,input)).status).toBe('TARGET_REACHED');
 await pageOf(t.engine).evaluate(()=>{document.querySelector('form')!.append(document.querySelector('label')!.cloneNode(true));});
 await t.engine.observe(t.sessionId);
 const candidates=t.engine.actions(t.sessionId).filter(a=>a.label==='Amount'&&a.kind==='fill');expect(candidates).toHaveLength(2);
 const ambiguous=t.engine.explorationTargetCorrespondences(t.sessionId,{observationId:candidates[0].observationId,requests:candidates.map(a=>({actionId:a.id,source:{sessionId:t.sessionId,observationId:old.observationId,actionId:old.id}}))});
 expect(ambiguous.results.every(p=>!p.equivalent)).toBe(true);
});

it('exits an actual modal through the existing recovery ledger and verifies the target independently',async()=>{
 const t=await fixture('<form id="order"><label>Amount<input id="amount" value="1"></label></form><dialog id="gate" aria-label="Introduction"><form method="dialog"><button>Close</button></form></dialog>');
 const input=await target(t,action(t,'Amount','fill'));
 await pageOf(t.engine).evaluate(()=>document.querySelector('dialog')!.showModal());await t.engine.observe(t.sessionId);
 const result=await t.engine.reachExplorationTarget(t.sessionId,input);
 expect(result.status,JSON.stringify(result)).toBe('TARGET_REACHED');expect(result.diagnostics?.strategies).toContain('boundary_exit');expect(result.attemptIds).toHaveLength(1);
 expect(t.engine.observation(t.sessionId).boundaries).toHaveLength(0);
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt')[0]).toMatchObject({purpose:'recovery',status:'succeeded'});
});

it('reports actual same-URL partial recovery after a declared inverse diverges',async()=>{
 const t=await fixture('<main><label>Mode<input id="mode" type="checkbox"></label><a id="next" href="/next">Next</a></main>',{reversible:[{stableKey:'id:mode'}]});
 const input=await target(t,action(t,'Next'));
 const check=action(t,'Mode','check');await t.engine.execute(t.sessionId,check.id,crypto.randomUUID(),true);
 await pageOf(t.engine).evaluate(()=>document.querySelector('#mode')!.addEventListener('input',()=>{if(!(document.querySelector('#mode') as HTMLInputElement).checked)document.querySelector('#next')?.remove();}));
 const before=t.engine.observation(t.sessionId),result=await t.engine.reachExplorationTarget(t.sessionId,input),after=t.engine.observation(t.sessionId);
 expect(result.status).toBe('UNVERIFIED');expect(result.reason).toContain('restoration diverged');expect(result.attemptIds).toHaveLength(1);
 expect(result.observationId).toBe(after.id);expect(after.id).not.toBe(before.id);expect(after.url).toBe(before.url);expect(after.controls.some(c=>c.name==='Next')).toBe(false);
 expect(result.checkpointVerified).toBe(false);
});

it('preserves unknown outcomes and rejects unassessed repetition inside queued dispatch',async()=>{
 const t=await fixture('<button id="open" type="button">Open</button><label>Amount<input id="amount" value="1"></label>',{executionPolicy:'observed-ui'});
 const input=await target(t,action(t,'Amount','fill')),open=action(t,'Open');
 const first=await t.engine.execute(t.sessionId,open.id,crypto.randomUUID(),undefined,{profile:'observed-ui-exploration',observationId:open.observationId});
 expect(first).toMatchObject({status:'succeeded',effectsAssessment:'not-assessed',action:{replayable:false}});
 const fresh=action(t,'Open'),source={sessionId:t.sessionId,attemptId:first.id};
 expect(t.engine.repetitionAssessment(t.sessionId,{observationId:fresh.observationId,actionId:fresh.id,source})).toMatchObject({repeatable:false,reason:'source_not_replayable'});
 await expect(t.engine.execute(t.sessionId,fresh.id,crypto.randomUUID(),undefined,{profile:'observed-ui-exploration',observationId:fresh.observationId,repetitionSource:source})).rejects.toMatchObject({code:'REPETITION_NOT_VERIFIED'});
 // Inject the crash-ledger condition; browser recovery must not erase it or attach/capture as proof.
 t.engine.store.put('attempt',{...first,status:'unknown',reason:'Result was not durably recorded'} satisfies ActionAttempt);
 const observe=vi.spyOn(t.engine as unknown as {capture:()=>Promise<unknown>},'capture'),result=await t.engine.reachExplorationTarget(t.sessionId,input);
 expect(result).toMatchObject({status:'UNVERIFIED',attemptIds:[],matchedActionIds:[]});expect(observe).not.toHaveBeenCalled();
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt')[0].status).toBe('unknown');
});

it('rejects changed context and semantic form binding without attempting recovery',async()=>{
 const t=await fixture('<select id="context"><option>A</option><option>B</option></select><form id="order"><label>Amount<input id="amount" value="1"></label></form>',{contextRules:[{key:'mode',selector:'#context'}]});
 const old=action(t,'Amount','fill'),input=await target(t,old);
 await pageOf(t.engine).selectOption('#context','B');await t.engine.observe(t.sessionId);
 const changed=await t.engine.reachExplorationTarget(t.sessionId,input);expect(changed.status).toBe('PRECONDITIONS_CHANGED');expect(changed.attemptIds).toEqual([]);
 await pageOf(t.engine).evaluate(()=>{(document.querySelector('#context') as HTMLSelectElement).value='A';document.querySelector('form')!.id='different-owner';});await t.engine.observe(t.sessionId);
 const fresh=action(t,'Amount','fill');
 const proof=t.engine.explorationTargetCorrespondences(t.sessionId,{observationId:fresh.observationId,requests:[{actionId:fresh.id,source:{sessionId:t.sessionId,observationId:old.observationId,actionId:old.id}}]}).results[0];
 expect(proof.equivalent).toBe(false);
});

it('does not borrow readiness from a stable sibling form',async()=>{
 const t=await fixture('<form id="one"><label>Changing<input id="changing" value="1"></label></form><form id="two"><label>Stable<input id="stable" value="1"></label></form><script>let n=1;setInterval(()=>document.querySelector("#changing").value=String(++n),15)</script>',{settleMs:80,observeTimeoutMs:260});
 const input=await target(t,action(t,'Changing','fill'));
 expect(t.engine.observation(t.sessionId).controls.find(c=>c.name==='Changing')?.readiness?.status).toBe('unstable');
 const result=await t.engine.reachExplorationTarget(t.sessionId,input);expect(result.status).toBe('UNVERIFIED');expect(result.matchedActionIds).toEqual([]);
 const stable=await target(t,action(t,'Stable','fill'));
 expect((await t.engine.reachExplorationTarget(t.sessionId,stable)).status).toBe('TARGET_REACHED');
});

it('revalidates repetition after an awaited driver validation rather than trusting the planning read',async()=>{
 const t=await fixture('<label>Amount<input id="amount" value="1"></label>');
 const firstAction=action(t,'Amount','fill'),first=await t.engine.execute(t.sessionId,firstAction.id,crypto.randomUUID());
 await pageOf(t.engine).evaluate(()=>{(document.querySelector('#amount') as HTMLInputElement).value='1';});await t.engine.observe(t.sessionId);
 const fresh=action(t,'Amount','fill'),source={sessionId:t.sessionId,attemptId:first.id};
 expect(t.engine.repetitionAssessment(t.sessionId,{observationId:fresh.observationId,actionId:fresh.id,source}).repeatable).toBe(true);
 const driver=(t.engine as unknown as {driver:{validate:(a:ActionCandidate,c?:unknown)=>Promise<void>}}).driver,validate=driver.validate.bind(driver);
 vi.spyOn(driver,'validate').mockImplementation(async(a,c)=>{await validate(a,c);t.engine.store.put('attempt',{...first,action:{...first.action,replayable:false}});});
 await expect(t.engine.execute(t.sessionId,fresh.id,crypto.randomUUID(),undefined,{profile:'interface-exploration',observationId:fresh.observationId,repetitionSource:source})).rejects.toMatchObject({code:'REPETITION_NOT_VERIFIED'});
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt')).toHaveLength(1);
});

it('carries unexecuted target evidence into a fresh browser session without granting historical execution',async()=>{
 const t=await fixture('<form id="order"><label>Amount<input id="amount" value="1"></label></form>');
 const old=action(t,'Amount','fill'),source={sessionId:t.sessionId,observationId:old.observationId,actionId:old.id},options=t.engine.session(t.sessionId).options;
 await t.engine.stop(t.sessionId);const session=await t.engine.createSession(options),fresh=t.engine.actions(session.id).find(a=>a.kind==='fill')!;
 const result=t.engine.explorationTargetCorrespondences(session.id,{observationId:fresh.observationId,requests:[{actionId:fresh.id,source}]}).results[0];
 expect(result).toMatchObject({equivalent:true,source,currentExecution:false,replayAuthorized:false,identityAuthorized:false});
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt')).toEqual([]);expect(t.engine.list<ActionAttempt>(session.id,'attempt')).toEqual([]);
});

it('continues a verified recorded source path without entry reload when only unrelated document state differs',async()=>{
 const t=await fixture('<button id="open" type="button" aria-expanded="false" onclick="this.setAttribute(\'aria-expanded\',\'true\');document.querySelector(\'#details\').hidden=false">Open</button><form id="details" hidden><label>Amount<input id="amount" value="1"></label></form><label>Quote<input id="quote" readonly></label><script>const visit=Number(localStorage.visit||0)+1;localStorage.visit=String(visit);document.querySelector("#quote").value=String(visit)</script>',{interfaceActions:[{stableKey:'id:open'}],replayable:[{stableKey:'id:open'}]});
 const open=action(t,'Open'),first=await t.engine.execute(t.sessionId,open.id,crypto.randomUUID()),input=await target(t,action(t,'Amount','fill')),original=t.engine.observation(t.sessionId);
 expect(first.action.replayable).toBe(true);
 await pageOf(t.engine).evaluate(()=>{(document.querySelector('#details') as HTMLElement).hidden=true;document.querySelector('#open')!.setAttribute('aria-expanded','false');(document.querySelector('#quote') as HTMLInputElement).value='different';});await t.engine.observe(t.sessionId);
 const result=await t.engine.reachExplorationTarget(t.sessionId,input);
 expect(result.status,JSON.stringify(result)).toBe('TARGET_REACHED');expect(result.diagnostics?.strategies).toContain('recorded_source_path');expect(result.diagnostics?.strategies).not.toContain('entry_replay');
 expect(t.engine.observation(t.sessionId).canonical).not.toBe(original.canonical);
 expect(result.attemptIds).toHaveLength(1);
 const replay=t.engine.list<ActionAttempt>(t.sessionId,'attempt').find(a=>a.id===result.attemptIds[0])!;
 expect(replay).toMatchObject({purpose:'recovery',status:'succeeded',repetitionSource:{sessionId:t.sessionId,attemptId:first.id}});
});

it('reports arrival independently of pending region decisions and leaves actual dispatch gated',async()=>{
 const t=await fixture('<form id="order"><label>Amount<input id="amount" value="1"></label></form>',{regionExploration:'review'});
 const input=await target(t,action(t,'Amount','fill')),result=await t.engine.reachExplorationTarget(t.sessionId,input);
 expect(result).toMatchObject({status:'TARGET_REACHED',executionAuthorized:false,currentExecution:false});
 const actionId=result.matchedActionIds[0],availability=result.dispatchAvailability!.actions.find(a=>a.actionId===actionId)!;
 expect(availability).toMatchObject({executable:false,blockers:[{reason:'region_review_required'}]});
 await expect(t.engine.execute(t.sessionId,actionId,crypto.randomUUID(),undefined,{profile:'interface-exploration',observationId:result.observationId!})).rejects.toMatchObject({code:'ACTION_BLOCKED'});
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt')).toEqual([]);
});

it('continues deterministic recovery for a settled mechanical obstruction without claiming early arrival',async()=>{
 const t=await fixture('<style>body:has(#first[open]) #second{transform:translateX(-3000px)}</style><details id="first"><summary>First</summary><p>First body</p></details><details id="second"><summary>Second</summary><p>Second body</p></details>');
 const second=action(t,'Second'),input=await target(t,second),first=action(t,'First');await t.engine.execute(t.sessionId,first.id,crypto.randomUUID());
 const blocked=t.engine.actions(t.sessionId).find(a=>a.label==='Second')!;expect(blocked.preconditions.blockers?.some(b=>b.code==='outside_scrollable_area')).toBe(true);
 const result=await t.engine.reachExplorationTarget(t.sessionId,input);
 expect(result.status,JSON.stringify(result)).toBe('TARGET_REACHED');expect(result.attemptIds.length).toBeGreaterThan(0);expect(result.diagnostics?.strategies).toContain('entry_replay');
 const reached=t.engine.actions(t.sessionId).find(a=>result.matchedActionIds.includes(a.id))!;expect(reached.preconditions.blockers||[]).toEqual([]);
 expect(t.engine.list<ActionAttempt>(t.sessionId,'attempt').some(a=>a.action.label==='Second')).toBe(false);
});
