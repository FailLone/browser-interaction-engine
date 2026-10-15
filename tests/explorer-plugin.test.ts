import { explorerFixture, fakeProviders } from './explorer-plugin-helpers.js';
import { it,expect } from 'vitest';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync,rmSync,readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractionEngine } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin,ExplorerStore,type Provider,type ModelRequest } from '@interaction/explorer-plugin';
import { createServer } from '../apps/server/src/server.js';
it('explores real browser actions with an independent ledger and leaves engine mode manual',async()=>{
 const f=await explorerFixture();const providers=fakeProviders(f.url);const plugin=new ExplorerPlugin(f.host,new ExplorerStore(join(f.dir,'plugin.sqlite')),providers);
 try{const t=plugin.create({url:f.url,goal:'Verify both buttons',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,modelRequests:80}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.reason,JSON.stringify({task:v.task,decisions:v.decisions.map(d=>({p:d.purpose,s:d.status,r:d.reason}))},null,2)).toBe('current_plan_verified');
 const sid=v.task.rounds[0].sessionId;expect(f.host.session(sid).mode).toBe('manual');expect(f.host.list<any>(sid,'attempt').filter(a=>a.status==='succeeded'&&a.purpose==='external').map(a=>a.action.label)).toEqual(expect.arrayContaining(['Alpha','Beta']));
 expect(v.events.some(e=>e.actor==='jev')).toBe(true);expect(v.events.some(e=>e.actor==='llm')).toBe(true);expect(v.task.exhaustive).toBe(false);
 }finally{await plugin.close();await f.close();}
});
it('scopes ungrouped candidates and guards application commands while a model is pending',async()=>{
 const f=await explorerFixture();const providers=fakeProviders(f.url,{url:f.url,label:'Alpha',kind:'click'});let release!:()=>void;const original=providers.llm.decide;
 providers.llm.decide=async(r,s)=>{await new Promise<void>(resolve=>release=resolve);return original(r,s);};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers);const app=await createServer(f.host,{explorer:plugin});
 try{const t=plugin.create({url:f.url,goal:'Only Alpha',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,20));
 const sid=plugin.view(t.id).task.rounds[0].sessionId;const busy=await app.inject({method:'POST',url:`/v1/sessions/${sid}/commands`,payload:{type:'explore'}});expect(busy.statusCode).toBe(409);
 const read=await app.inject(`/v1/sessions/${sid}/observation`);expect(read.statusCode).toBe(200);
 const pause=await app.inject({method:'POST',url:`/v1/sessions/${sid}/commands`,payload:{type:'pause'}});expect(pause.statusCode).toBe(200);release();await plugin.waitForIdle();expect(f.host.session(sid).actionCount).toBe(0);
 providers.llm.decide=original;plugin.start(t.id);await plugin.waitForIdle();expect(f.host.list<any>(sid,'attempt').filter(a=>a.purpose==='external').map(a=>a.action.label)).not.toContain('Beta');
 }finally{await app.close();await f.close();}
});
it('does not modify SDK packages or import private implementation',()=>{
 const source=readdirSync('packages/explorer-plugin/src').filter(f=>/\.tsx?$/.test(f)).map(f=>readFileSync(`packages/explorer-plugin/src/${f}`,'utf8')).join('\n');
 expect(source).not.toMatch(/@interaction\/(core|adapter-playwright|browser)\//);expect(source).not.toMatch(/host\.(store|driver|explore)|as any\)\.(store|driver)/);
 for(const name of ['core','browser','client','adapter-playwright'])expect(readFileSync(`packages/${name}/package.json`,'utf8')).not.toContain('explorer-plugin');
});
it('continues remaining scopes in a fresh round without resetting total budget or replaying success',async()=>{
 const f=await explorerFixture();const providers=fakeProviders(f.url);const plugin=new ExplorerPlugin(f.host,new ExplorerStore(join(f.dir,'plugin.sqlite')),providers);
 try{const t=plugin.create({url:f.url,goal:'Both buttons across rounds',sessionOptions:{maxActions:1,settleMs:0,observeTimeoutMs:100},budget:{rounds:3,actions:5}});plugin.start(t.id);await plugin.waitForIdle();const task=plugin.view(t.id).task;
 expect(task.status,JSON.stringify(task,null,2)).toBe('completed');expect(task.rounds).toHaveLength(2);expect(task.usage.actions).toBe(2);
 const actions=task.rounds.map(r=>f.host.list<any>(r.sessionId,'attempt').map(a=>a.action.label));expect(actions).toEqual([['Alpha'],['Beta']]);
 expect(task.plan.find(i=>i.scope.label==='Alpha')?.resolvedBy?.sessionId).toBe(task.rounds[0].sessionId);
 expect(providers.calls.some(r=>r.purpose==='followup-strategy')).toBe(true);expect(providers.calls.some(r=>r.purpose==='followup-plan')).toBe(false);
 }finally{await plugin.close();await f.close();}
});
it('traverses admissible actions on JEV ranking ties without LLM fallback or out-of-scope execution',async()=>{
 const f=await explorerFixture();const p=fakeProviders(f.url,{url:f.url,label:'Alpha',kind:'click'});const original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='next-action'?{value:'uncertain',confidence:.4,model:'mock-jev'}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Only Alpha',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status).toBe('completed');expect(v.decisions.filter(d=>d.actor==='llm').map(d=>d.purpose)).toEqual(['initial-plan']);
 expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').filter(a=>a.purpose==='external').map(a=>a.action.label)).toEqual(['Alpha']);
 expect(v.decisions.find(d=>d.purpose==='next-action')?.resolution).toMatchObject({source:'program',reason:'stable_candidate_order'});
 }finally{await plugin.close();await f.close();}
});
it('generates a follow-up plan only after JEV identifies a need for new planning',async()=>{
 const f=await explorerFixture();const p=fakeProviders(f.url);const original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='followup-strategy'?{value:'replan',confidence:.95,model:'mock-jev'}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Both buttons across rounds',sessionOptions:{maxActions:1,settleMs:0,observeTimeoutMs:100},budget:{rounds:3,actions:5}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status).toBe('completed');expect(v.task.usage.actions).toBe(2);
 const strategy=v.decisions.findIndex(d=>d.purpose==='followup-strategy'),generation=v.decisions.findIndex(d=>d.purpose==='followup-plan');
 expect(strategy).toBeGreaterThan(-1);expect(generation).toBeGreaterThan(strategy);expect(v.decisions[generation].actor).toBe('llm');
 }finally{await plugin.close();await f.close();}
});
it('retains sampled-out ranges and can explicitly select them for a later round',async()=>{
 const f=await explorerFixture('<select aria-label="Choice" onchange="document.querySelector(\'output\').textContent=this.value"><option>A</option><option>B</option><option>C</option><option>D</option></select><output></output>');const p=fakeProviders(f.url);const original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='scope-review'?{value:(r.state as any).material.material?.group?.kind==='similar-list'?'sample':((r.state as any).material.group?.kind==='similar-list'?'sample':'all'),confidence:1,model:'mock'}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Sample list',coverageMode:'representative',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:3}});plugin.start(t.id);await plugin.waitForIdle();let task=plugin.view(t.id).task;
 expect(task.status,JSON.stringify(task,null,2)).toBe('completed');const untested=task.plan.filter(i=>i.status==='untested'&&i.reason==='sample_unselected');expect(untested.length).toBeGreaterThan(0);
 const item=untested.find(i=>i.scope.value==='B')||untested[0];const firstCount=task.usage.actions;const firstSid=task.rounds[0].sessionId;
 plugin.revise(t.id,{itemIds:[item.id]},true);p.jev.decide=original;plugin.start(t.id);await plugin.waitForIdle();task=plugin.view(t.id).task;
 expect(task.plan.find(i=>i.id===item.id)?.status,JSON.stringify(task,null,2)).toBe('succeeded');expect(task.usage.actions).toBeGreaterThan(firstCount);expect(task.rounds.at(-1)?.sessionId).not.toBe(firstSid);expect(task.plan.some(i=>i.status==='untested')).toBe(true);
 }finally{await plugin.close();await f.close();}
});
it('restores paused tasks and counters from plugin storage without changing historical engine records',async()=>{
 const f=await explorerFixture();const path=join(f.dir,'plugin.sqlite');let plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,goal:'Missing target',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});const stored=plugin.store.task(t.id);stored.status='running';stored.usage.modelRequests=7;stored.activeSince=Date.now()-100;plugin.store.save(stored);await plugin.close();
 plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),fakeProviders(f.url));const recovered=plugin.view(t.id).task;expect(recovered.status).toBe('paused');expect(recovered.usage.modelRequests).toBe(7);expect(recovered.usage.durationMs).toBeGreaterThanOrEqual(100);expect(f.host.sessions()).toEqual([]);
 }finally{await plugin.close();await f.close();}
});
it('records missing service configuration and exposes no key through HTTP',async()=>{
 const f=await explorerFixture();const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),{});const app=await createServer(f.host,{explorer:plugin});
 try{const t=plugin.create({url:f.url,goal:'Explore'});expect(plugin.start(t.id).status).toBe('configuration_required');expect(f.host.sessions()).toHaveLength(0);const response=await app.inject('/plugins/explorer/v1/status');expect(response.json().providers.llm.configured).toBe(false);expect(response.body).not.toMatch(/apiKey|authorization/);
 }finally{await app.close();await f.close();}
});
it('keeps exhausted totals until an explicit budget extension, then resumes a selected gap',async()=>{
 const f=await explorerFixture();const p=fakeProviders(f.url);const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Both',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{actions:1,rounds:1}});plugin.start(t.id);await plugin.waitForIdle();let task=plugin.view(t.id).task;expect(task.status).toBe('budget_exhausted');expect(task.usage.actions).toBe(1);expect(()=>plugin.start(t.id)).toThrow();
 const remaining=task.plan.find(i=>i.scope.label==='Beta')!;expect(remaining).toBeDefined();plugin.revise(t.id,{itemIds:[remaining.id]},true);plugin.extendBudget(t.id,{actions:2,rounds:1,durationMs:60000,modelRequests:30});plugin.start(t.id);await plugin.waitForIdle();task=plugin.view(t.id).task;
 expect(task.plan.find(i=>i.id===remaining.id)?.status,JSON.stringify(task,null,2)).toBe('succeeded');expect(task.usage.actions).toBe(2);expect(task.budget.actions).toBe(3);
 }finally{await plugin.close();await f.close();}
});
it('leaves absent targets unresolved instead of inferring completion',async()=>{
 const f=await explorerFixture();const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url,{url:f.url,label:'Missing',kind:'click'}));
 try{const t=plugin.create({url:f.url,goal:'Missing',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const task=plugin.view(t.id).task;expect(task.status).not.toBe('completed');expect(task.usage.actions).toBe(0);expect(task.plan.some(i=>i.required&&i.status==='unresolved')).toBe(true);
 }finally{await plugin.close();await f.close();}
});
it('explores a nested dialog and verifies return before continuing the parent branch',async()=>{
 const f=await explorerFixture('<button id="open" type="button" onclick="document.querySelector(\'dialog\').showModal()">Open</button><button id="sibling" type="button" onclick="this.disabled=true">Sibling</button><dialog aria-label="Options"><button id="inner" type="button" onclick="this.disabled=true">Inner</button><button id="close" type="button" onclick="document.querySelector(\'dialog\').close()">Close</button></dialog>');
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,goal:'Explore dialog and sibling',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:2,modelRequests:100}});plugin.start(t.id);await plugin.waitForIdle();const task=plugin.view(t.id).task;const attempts=task.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
 expect(attempts.filter(a=>a.status==='succeeded').map(a=>a.action.label),JSON.stringify({decisions:plugin.view(t.id).decisions.map(d=>({purpose:d.purpose,status:d.status,value:d.answer?.value,options:d.purpose==='next-action'?d.request.options:undefined})),task,attempts:attempts.map(a=>({label:a.action.label,status:a.status}))},null,2)).toEqual(expect.arrayContaining(['Open','Inner','Close','Sibling']));
 expect(task.status,JSON.stringify(task,null,2)).toBe('completed');
 }finally{await plugin.close();await f.close();}
});
it('reviews the active dialog before background controls and resumes background work after exit',async()=>{
 const f=await explorerFixture('<div tabindex="0" aria-label="Background information">Background information</div><button id="sibling" type="button" onclick="this.disabled=true">Sibling</button><dialog aria-label="Options"><button id="inner" type="button" onclick="this.disabled=true">Inner</button><button id="close" type="button" onclick="document.querySelector(\'dialog\').close()">Close</button></dialog><script>document.querySelector("dialog").showModal()</script>');
 const providers=fakeProviders(f.url);const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,modelRequests:100}});plugin.start(t.id);await plugin.waitForIdle();const view=plugin.view(t.id),sid=view.task.rounds[0].sessionId;
 const attempts=f.host.list<any>(sid,'attempt').filter(a=>a.status==='succeeded');const labels=attempts.map(a=>a.action.label);
 expect(labels,JSON.stringify({task:view.task,decisions:view.decisions.map(d=>({purpose:d.purpose,status:d.status,reason:d.reason}))},null,2)).toEqual(expect.arrayContaining(['Inner','Close','Sibling']));
 expect(labels.indexOf('Inner')).toBeLessThan(labels.indexOf('Close'));expect(labels.indexOf('Close')).toBeLessThan(labels.indexOf('Sibling'));
 const backgroundReview=view.decisions.find(d=>d.purpose==='control-classification'&&(d.request.state as any).material.control.name==='Background information');
 expect(backgroundReview).toBeDefined();expect(f.host.observation(sid,backgroundReview!.observationId).boundaries).toHaveLength(0);
 for(const d of view.decisions.filter(d=>d.purpose==='control-classification')){const o=f.host.observation(sid,d.observationId);if(o.boundaries?.length)expect(o.overlays?.find(b=>b.key===o.boundaries!.at(-1)!.key)?.controlIds).toContain((d.request.state as any).material.control.localId);}
 const regions=view.decisions.filter(d=>d.purpose==='region-review');expect(regions.length).toBeGreaterThan(1);
 expect((regions[0].request.state as any).material.controls.map((c:any)=>c.name||c.label)).not.toContain('Sibling');
 for(const d of regions){const material=(d.request.state as any).material;expect(material.candidate).not.toHaveProperty('binding');expect(material.candidate).not.toHaveProperty('reuseBinding');expect(material.candidate.memberCount).toBeGreaterThanOrEqual(material.controls.length);}
 expect(view.task.status,JSON.stringify(view.task,null,2)).toBe('completed');
 }finally{await plugin.close();await f.close();}
});
it.each(['close','noop','changed'])('reviews an outside exit and verifies its %s result before background work',async(effect)=>{
 const f=await explorerFixture(`<style>#outside{position:fixed;inset:0;background:#eee}#amount,#sibling{position:absolute;top:20px;z-index:1}#amount{left:10px}#sibling{left:400px}#panel{position:absolute;top:100px;left:100px;width:200px;height:160px;background:white;z-index:2}</style><div id="outside"></div><input id="amount" aria-label="Amount" value="42"><button id="sibling" type="button" onclick="this.disabled=true">Sibling</button><div id="panel" role="listbox" aria-label="Options"><button type="button" onclick="this.disabled=true">Inside</button></div><script>document.addEventListener('click',e=>{if(e.target.id==='outside'){${effect==='noop'?'':`panel.hidden=true;${effect==='changed'?"amount.value='99'":''}`}}})</script>`);
 const providers=fakeProviders(f.url),original=providers.jev.decide;providers.jev.decide=async(r,s)=>{const a=await original(r,s);if(r.purpose==='boundary-exit-risk'&&(r.state as any).material.candidate.selector!=='#outside')return {...a,value:{interface_exit:.01,external_exit:.5}};return a;};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:20,modelRequests:100}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),sid=v.task.rounds[0].sessionId;const attempts=f.host.list<any>(sid,'attempt'),exits=f.host.list<any>(sid,'boundary-exit-result');
 expect(exits.length,JSON.stringify({task:v.task,decisions:v.decisions.map(d=>({purpose:d.purpose,status:d.status,reason:d.reason})),attempts:attempts.map(a=>({label:a.action.label,status:a.status}))},null,2)).toBeGreaterThan(0);
 if(effect!=='noop')expect(exits).toHaveLength(1);else {const values=attempts.filter(a=>a.action.kind==='dismiss').map(a=>a.action.value);expect(new Set(values).size).toBe(values.length);}
 expect(exits.every(r=>r.status===(effect==='close'?'verified':effect==='noop'?'not_closed':'changed'))).toBe(true);expect(v.decisions.some(d=>d.purpose==='boundary-exit-risk'&&d.status==='applied')).toBe(true);
 const labels=attempts.map(a=>a.action.label);if(effect==='close'){expect(labels).toContain('Sibling');expect(labels.indexOf('Attempt reviewed outside exit')).toBeLessThan(labels.indexOf('Sibling'));}else expect(labels).not.toContain('Sibling');
 if(effect==='changed'){expect(v.task.reason).toBe('BOUNDARY_EXIT_UNVERIFIED');const count=attempts.length;plugin.start(t.id);await plugin.waitForIdle();expect(f.host.list<any>(sid,'attempt')).toHaveLength(count);expect(plugin.view(t.id).task.reason).toBe('BOUNDARY_EXIT_UNVERIFIED');}
 if(effect==='noop')expect(v.task.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});
it('never replays an unknown dispatched outcome after restart',async()=>{
 const f=await explorerFixture();const path=join(f.dir,'plugin.sqlite');let unknownId:string|undefined;let dispatches=0;
 const host=new Proxy(f.host,{get(target,key){if(key==='execute')return async(...args:Parameters<typeof target.execute>)=>{dispatches++;const attempt=await target.execute(...args);unknownId=attempt.id;return {...attempt,status:'unknown' as const};};if(key==='list')return (sid:string,kind:string)=>target.list<any>(sid,kind).map(x=>kind==='attempt'&&x.id===unknownId?{...x,status:'unknown'}:x);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 let plugin=new ExplorerPlugin(host,new ExplorerStore(path),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,goal:'Unknown test',sessionOptions:{settleMs:0,observeTimeoutMs:100}});plugin.start(t.id);await plugin.waitForIdle();expect(plugin.view(t.id).task.pendingDispatch).toBeDefined();expect(dispatches).toBe(1);await plugin.close();
 plugin=new ExplorerPlugin(host,new ExplorerStore(path),fakeProviders(f.url));plugin.start(t.id);await plugin.waitForIdle();expect(dispatches).toBe(1);expect(plugin.view(t.id).task.reason).toBe('UNKNOWN_DISPATCH_REQUIRES_REVIEW');
 }finally{await plugin.close();await f.close();}
});
it('isolates a terminal unknown hyperlink in a new round without replaying it or claiming coverage',async()=>{
 const f=await explorerFixture('<a href="?destination=1">Details</a><button type="button" onclick="this.disabled=true">Independent</button>');
 const providers=fakeProviders(f.url),original=providers.jev.decide;let unknownId:string|undefined;let links=0;const path=join(f.dir,'plugin.sqlite');
 providers.jev.decide=async(r,s)=>{if(r.purpose==='next-action'){const link=Object.entries(r.options!).find(([,a])=>(a as any).label==='Details');if(link)return {model:'mock',value:link[0],confidence:1};}return original(r,s);};
 const host=new Proxy(f.host,{get(target,key){if(key==='execute')return async(...args:Parameters<typeof target.execute>)=>{const a=await target.execute(...args);if(a.action.label==='Details'){links++;unknownId=a.id;return {...a,status:'unknown' as const};}return a;};if(key==='list')return (sid:string,kind:string)=>target.list<any>(sid,kind).map(x=>kind==='attempt'&&x.id===unknownId?{...x,status:'unknown'}:x);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 let plugin=new ExplorerPlugin(host,new ExplorerStore(path),providers);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:3,actions:10,modelRequests:100}});plugin.start(t.id);await plugin.waitForIdle();let view=plugin.view(t.id);
 expect(links).toBe(1);expect(view.task.rounds).toHaveLength(2);expect(view.task.usage.actions).toBe(2);expect(view.task.unverifiedNavigations).toEqual([{sourceUrl:f.url,targetUrl:f.url+'?destination=1',evidence:expect.objectContaining({attemptId:unknownId,sessionId:view.task.rounds[0].sessionId})}]);
 expect(f.host.list<any>(view.task.rounds[1].sessionId,'attempt').map(a=>a.action.label)).toEqual(['Independent']);expect(view.task.status).not.toBe('completed');expect(view.task.pendingDispatch).toBeUndefined();expect(view.task.plan.some(i=>i.scope.label==='Details'&&i.status==='unresolved')).toBe(true);expect(view.events.some(e=>e.type==='navigation.isolated')).toBe(true);
 await plugin.close();plugin=new ExplorerPlugin(host,new ExplorerStore(path),providers);plugin.start(t.id);await plugin.waitForIdle();view=plugin.view(t.id);
 expect(links).toBe(1);expect(view.task.usage.actions).toBe(2);expect(view.task.unverifiedNavigations).toHaveLength(1);expect(view.task.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});
it.each(['dirty','executing','unfinished'])('keeps %s unknown hyperlink outcomes blocked',async(mode)=>{
 const f=await explorerFixture('<a href="?destination=1">Details</a>');let dispatched=false,unknownId:string|undefined;
 const changed=(a:any)=>({...a,status:mode==='executing'?'executing':'unknown',...(mode==='unfinished'?{finishedAt:undefined}:{})});
 const host=new Proxy(f.host,{get(target,key){if(key==='execute')return async(...args:Parameters<typeof target.execute>)=>{const a=await target.execute(...args);dispatched=true;unknownId=a.id;return changed(a);};if(key==='session')return (sid:string)=>({...target.session(sid),...(dispatched&&mode==='dirty'?{dirty:true}:{})});if(key==='list')return (sid:string,kind:string)=>target.list<any>(sid,kind).map(x=>kind==='attempt'&&x.id===unknownId?changed(x):x);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);expect(v.task.reason).toBe('UNKNOWN_DISPATCH_REQUIRES_REVIEW');expect(v.task.rounds).toHaveLength(1);expect(v.task.pendingDispatch).toBeDefined();expect(v.task.unverifiedNavigations).toBeUndefined();}
 finally{await plugin.close();await f.close();}
});
it('keeps same-name ambiguous targets unresolved without selecting an arbitrary occurrence',async()=>{
 const f=await explorerFixture('<button type="button">Duplicate</button><button type="button">Duplicate</button>');const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,goal:'Ambiguity',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const task=plugin.view(t.id).task;expect(task.usage.actions).toBe(0);expect(task.plan.some(i=>i.reason==='ambiguous_scope_match')).toBe(true);expect(task.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});
it('revalidates changed dispatch bindings instead of treating old success as the new case',async()=>{
 let entries=0;const f=await explorerFixture(()=>{entries++;return `<button id="alpha" type="button" onclick="this.dataset.variant='${entries===1?'old':'new'}';this.disabled=true">Alpha</button><button id="beta" type="button" onclick="this.disabled=true">Beta</button>`;});
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,goal:'Both buttons',sessionOptions:{maxActions:1,settleMs:0,observeTimeoutMs:100},budget:{rounds:3,actions:5}});plugin.start(t.id);await plugin.waitForIdle();const task=plugin.view(t.id).task;
 expect(task.status,JSON.stringify(task,null,2)).toBe('completed');expect(task.rounds.map(r=>f.host.list<any>(r.sessionId,'attempt').map(a=>a.action.label))).toEqual([['Alpha'],['Alpha'],['Beta']]);expect(task.usage.actions).toBe(3);
 }finally{await plugin.close();await f.close();}
});
it('grounds plans in accessible action names and samples only current reviewed members',async()=>{
 const f=await explorerFixture('<button type="button" onclick="this.disabled=true">Alpha</button>');const p=fakeProviders(f.url);const original=p.jev.decide;let sawRetiredMember=false;
 p.llm.decide=async(r,s)=>{
  if(r.purpose==='initial-plan'){
   const observation=(r.state as any).material.observation;
   expect(observation.controls[0].label).toBe('Alpha');
   const scope=observation.actions.find((a:any)=>a.label==='Alpha'&&a.kind==='click');expect(scope).toBeDefined();
   return {model:'mock',value:{mode:'targeted',items:[{title:'Click Alpha',scope,prerequisites:[],completion:'Verify click',required:true,reason:'Observed action'}]}};
  }
  return original(r,s);
 };
 p.jev.decide=async(r,s)=>{
  if(r.purpose==='scope-review'){
   const group=(r.state as any).material.group;sawRetiredMember ||= group.historicalMemberCount>0;
   expect(group.members.every((m:any)=>f.host.actions(group.sessionId).some(a=>a.id===m.actionId))).toBe(true);
   return {model:'mock',value:'sample',confidence:1};
  }
  return original(r,s);
 };
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Click Alpha once',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const task=plugin.view(t.id).task;
 expect(sawRetiredMember).toBe(true);expect(task.status,JSON.stringify(task)).toBe('completed');expect(task.usage.actions).toBe(1);expect(task.plan.some(i=>i.reason==='sample_unselected')).toBe(false);
 }finally{await plugin.close();await f.close();}
});
it('retries initial planning after a provider timeout without turning the error into an execution scope',async()=>{
 const f=await explorerFixture();const p=fakeProviders(f.url);const original=p.llm.decide;let fail=true;
 p.llm.decide=async(r,s)=>{if(fail){fail=false;const {ExplorerError}=await import('@interaction/explorer-plugin');throw new ExplorerError('PROVIDER_TIMEOUT');}return original(r,s);};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Both controls',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();let view=plugin.view(t.id);expect(view.task.reason).toBe('PROVIDER_TIMEOUT');expect(view.task.plan).toEqual([]);expect(view.task.usage.actions).toBe(0);
 plugin.start(t.id);await plugin.waitForIdle();view=plugin.view(t.id);expect(view.task.status).toBe('completed');expect(view.decisions.filter(d=>d.purpose==='initial-plan')).toHaveLength(2);expect(view.events.some(e=>e.type==='decision.effect'&&(e.data as any).kind==='plan')).toBe(true);expect(view.events.some(e=>e.type==='action.verified'&&(e.data as any).decisionId)).toBe(true);
 }finally{await plugin.close();await f.close();}
});

it.each(['sample','skip','uncertain'])('preserves all in-scope actions when JEV suggests %s without sampling permission',async(value)=>{
 const f=await explorerFixture(),p=fakeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='scope-review'?{value,confidence:1,model:'mock'}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'All observed buttons',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status,JSON.stringify(v.task)).toBe('completed');expect(v.task.usage.actions).toBe(2);expect(v.decisions.filter(d=>d.actor==='llm').map(d=>d.purpose)).toEqual(['initial-plan']);
 expect(v.decisions.filter(d=>d.purpose==='scope-review').every(d=>d.answer?.value===value&&d.resolution?.value==='all')).toBe(true);
 expect(v.task.plan.some(i=>i.reason==='sample_unselected'||i.reason==='scope_excluded')).toBe(false);
 }finally{await plugin.close();await f.close();}
});
it('does not grant an operation on ambiguous external-effect evidence, even if LLM would approve',async()=>{
 const f=await explorerFixture(),p=fakeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.kind==='checklist'?{value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,k.startsWith('interface_')?.99:.5])),model:'mock'}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'All buttons',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status).not.toBe('completed');expect(v.task.usage.actions).toBe(0);expect(v.task.plan.some(i=>i.required&&i.reason==='operation_risk_unresolved')).toBe(true);
 expect(v.decisions.filter(d=>d.actor==='llm').map(d=>d.purpose)).toEqual(['initial-plan']);
 const judgments=v.decisions.filter(d=>d.purpose==='control-risk');expect(judgments.length).toBeGreaterThan(0);expect(judgments.length).toBeLessThanOrEqual(4);
 expect(v.events.filter(e=>e.type==='decision.effect'&&(e.data as any).kind==='evidence-refresh')).toHaveLength(2);
 }finally{await plugin.close();await f.close();}
});
it('preserves configuration, history and total counters while starting a fresh session for old routing rules',async()=>{
 const f=await explorerFixture(),p=fakeProviders(f.url);const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Both buttons',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:3}});plugin.start(t.id);await plugin.waitForIdle();const old=plugin.view(t.id),sid=old.task.rounds[0].sessionId;
 const saved=plugin.store.task(t.id);saved.status='paused';saved.rounds[0].status='paused';delete saved.rounds[0].policyVersion;plugin.store.save(saved);plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.rounds.at(-1)?.sessionId).not.toBe(sid);expect(v.task.usage.rounds).toBe(2);expect(v.task.usage.modelRequests).toBeGreaterThanOrEqual(old.task.usage.modelRequests);expect(v.events.some(e=>e.type==='routing.updated')).toBe(true);
 expect(v.decisions.filter(d=>d.sessionId===sid)).toEqual(old.decisions);
 }finally{await plugin.close();await f.close();}
});

it.each([true,false])('finishes the exact settings flow without recovery or touching unrelated controls (named select: %s)',async(namedSelect)=>{
 const f=await explorerFixture('<button type="button" aria-controls="settings" onclick="document.querySelector(\'dialog\').showModal()">Other settings</button><button type="button" onclick="this.textContent=\'WRONG\'">Unrelated</button><select aria-label="Unrelated choice"><option>AAA</option><option>BBB</option></select><div style="height:1500px"></div><dialog id="settings" aria-label="Other settings"><select aria-label="Time in force"><option>GTC</option><option>IOC</option></select><button type="button" onclick="document.querySelector(\'dialog\').close()">Done</button></dialog>');
 const p=fakeProviders(f.url),original=p.jev.decide;
 const scopes=[{url:f.url,label:'Other settings',role:'button',kind:'click'},{url:f.url,...(namedSelect?{label:'Time in force',role:'combobox'}:{}),kind:'select',value:'IOC'},{url:f.url,label:'Done',role:'button',kind:'click'}];
 p.llm.decide=async()=>({model:'mock',value:{mode:'targeted',items:scopes.map((scope,index)=>({title:scope.label||'Select IOC',scope,prerequisites:index?[scopes[index-1]]:[],completion:'Observe the requested transition',required:true,reason:'Explicit user target'}))}});
 p.jev.decide=async(r,s)=>r.purpose==='recovery-selection'?{model:'mock',value:'uncertain',confidence:.6}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Open settings, select IOC, close settings only',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,modelRequests:30}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status,JSON.stringify(v.task)).toBe('completed');expect(v.task.usage.actions).toBe(3);
 const attempts=f.host.list<any>(v.task.rounds[0].sessionId,'attempt');expect(attempts.map(a=>[a.action.label,a.action.value])).toEqual([['Other settings',undefined],['Time in force','IOC'],['Done',undefined]]);
 expect(v.decisions.some(d=>d.purpose==='recovery-selection')).toBe(false);
 expect(v.decisions.filter(d=>d.purpose==='control-risk').every(d=>!JSON.stringify(d.request.state).includes('Unrelated'))).toBe(true);
 expect(v.task.plan.filter(i=>i.dispatchScope).map(i=>i.scope.label)).toEqual(['Other settings',namedSelect?'Time in force':undefined,'Done']);
 expect(v.task.plan.filter(i=>i.required&&i.status!=='succeeded')).toEqual([]);
 }finally{await plugin.close();await f.close();}
});
it('restores legacy authority from the original plan, never from a page gap or derived outside target',async()=>{
 const f=await explorerFixture(),p=fakeProviders(f.url,{url:f.url,label:'Alpha',kind:'click'}),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Only Alpha',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:2}});plugin.start(t.id);await plugin.waitForIdle();const saved=plugin.store.task(t.id);
 const originalId=saved.plan[0].id;saved.status='paused';saved.rounds[0].status='paused';
 saved.plan.push({...structuredClone(saved.plan[0]),id:'legacy-gap',scope:{url:f.url},status:'unresolved',reason:'recovery_unresolved',resolvedBy:undefined,attempts:[],evidence:[]});
 saved.plan.push({...structuredClone(saved.plan[0]),id:'legacy-outside',scope:{url:f.url,label:'Beta',kind:'click'},status:'pending',reason:'observed_in_scope',resolvedBy:undefined,attempts:[],evidence:[]});
 for(const item of saved.plan)delete item.dispatchScope;plugin.store.save(saved);plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.plan.find(i=>i.id===originalId)?.dispatchScope).toBe(true);expect(v.task.plan.find(i=>i.id==='legacy-gap')?.dispatchScope).toBe(false);expect(v.task.plan.find(i=>i.id==='legacy-outside')?.dispatchScope).toBe(false);
 expect(v.task.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt')).map(a=>a.action.label)).toEqual(['Alpha']);
 expect(v.events.some(e=>e.type==='plan.authority_restored')).toBe(true);expect(v.task.plan.find(i=>i.id==='legacy-gap')?.status).toBe('unresolved');
 }finally{await plugin.close();await f.close();}
});

it.each([undefined,'','   '])('defaults an omitted or blank task to program-owned exhaustive coverage without LLM (%s)',async(goal)=>{
 const f=await explorerFixture(),p=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),{jev:p.jev});
 try{const t=plugin.create({url:f.url,...(goal===undefined?{}:{goal}),sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status,JSON.stringify(v.task)).toBe('completed');expect(v.task.intent).toMatchObject({mode:'exhaustive',source:'default',boundary:'current-page',url:f.url,exclusions:[]});expect(v.task.goal).toBe('');expect(v.task.usage.actions).toBe(2);
 expect(v.decisions.every(d=>d.actor==='jev')).toBe(true);expect(v.decisions.some(d=>d.purpose==='task-intent'||d.purpose==='initial-plan')).toBe(false);
 expect(v.events.some(e=>e.type==='plan.initialized'&&e.actor==='program')).toBe(true);expect(v.task.plan.filter(i=>i.dispatchScope).map(i=>i.scope)).toEqual([{url:f.url}]);
 }finally{await plugin.close();await f.close();}
});
it('uses JEV alone to recognize a written exhaustive task and discovers controls absent at startup',async()=>{
 const f=await explorerFixture('<button type="button" onclick="this.disabled=true;const b=document.createElement(\'button\');b.type=\'button\';b.textContent=\'Revealed\';b.onclick=()=>b.disabled=true;document.querySelector(\'main\').append(b)">Expand</button>');
 const p=fakeProviders(f.url),original=p.jev.decide;p.jev.decide=async(r,s)=>r.purpose==='task-intent'?{value:'exhaustive',confidence:.95,model:'mock'}:r.purpose==='scope-review'?{value:'sample',confidence:1,model:'mock'}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),{jev:p.jev});
 try{const t=plugin.create({url:f.url,goal:'尽可能穷尽当前页面所有 UI 交互',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status,JSON.stringify(v.task)).toBe('completed');expect(v.task.intent).toMatchObject({mode:'exhaustive',source:'jev'});expect(v.decisions.filter(d=>d.purpose==='task-intent')).toHaveLength(1);expect(v.decisions.some(d=>d.actor==='llm')).toBe(false);
 expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').map(a=>a.action.label)).toEqual(['Expand','Revealed']);expect(v.task.plan.filter(i=>i.dispatchScope).map(i=>i.scope)).toEqual([{url:f.url}]);
 expect(v.events.some(e=>e.type==='decision.effect'&&(e.data as any).kind==='task-route'&&(e.data as any).details.next==='program-root')).toBe(true);
 }finally{await plugin.close();await f.close();}
});
it.each([{value:'targeted',confidence:1},{value:'uncertain',confidence:1},{value:'exhaustive',confidence:.4},{value:'unsupported',confidence:.4}])('generates a typed target plan when JEV cannot establish unrestricted exhaustion (%s)',async(judgment)=>{
 const f=await explorerFixture(),p=fakeProviders(f.url,{url:f.url,label:'Alpha',kind:'click'}),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='task-intent'?{...judgment,model:'mock'}:original(r,s);const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Only Alpha',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status).toBe('completed');expect(v.task.intent).toMatchObject({mode:'targeted',source:'llm'});expect(v.decisions.slice(0,2).map(d=>[d.actor,d.purpose])).toEqual([['jev','task-intent'],['llm','initial-plan']]);expect(v.decisions.filter(d=>d.actor==='llm')).toHaveLength(1);expect(v.decisions[1].triggeredBy).toBe(v.decisions[0].id);
 expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').map(a=>a.action.label)).toEqual(['Alpha']);expect(v.events.some(e=>e.type==='decision.effect'&&(e.data as any).kind==='intent')).toBe(true);
 }finally{await plugin.close();await f.close();}
});
it('understands structured exhaustive intent with quoted exclusions without letting the model enumerate the root',async()=>{
 const f=await explorerFixture(),p=fakeProviders(f.url);p.llm.decide=async()=>({model:'mock',value:{mode:'exhaustive',boundary:'current-page',exclusions:[{scope:{label:'Beta',kind:'click'},instruction:'不要操作 Beta'}]}});
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'穷尽页面，但不要操作 Beta',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status,JSON.stringify(v.task)).toBe('completed');expect(v.task.intent).toMatchObject({mode:'exhaustive',source:'llm'});expect(v.task.plan.filter(i=>i.dispatchScope).map(i=>i.scope)).toEqual([{url:f.url}]);expect(v.task.plan.find(i=>i.reason==='user_excluded')).toMatchObject({status:'excluded',required:false,dispatchScope:false});
 expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').map(a=>a.action.label)).toEqual(['Alpha']);
 expect(v.decisions.filter(d=>d.purpose==='control-risk').every(d=>!(d.request.state as any).material.control.label.includes('Beta'))).toBe(true);
 }finally{await plugin.close();await f.close();}
});
it.each([
 {mode:'exhaustive',boundary:'current-page',exclusions:[],items:[]},
 {mode:'exhaustive',boundary:'current-page',exclusions:[{scope:{},instruction:'穷尽当前页面'}]},
 {mode:'exhaustive',boundary:'current-page',exclusions:[{scope:{label:'Beta'},instruction:'made up exclusion'}]},
 {mode:'targeted',items:[]},
 {items:[]},
])('rejects ambiguous or ungrounded structured intent before executing (%s)',async(value)=>{
 const f=await explorerFixture(),p=fakeProviders(f.url);p.llm.decide=async()=>({model:'mock',value});const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'穷尽当前页面',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);expect(v.task.status).not.toBe('completed');expect(v.task.usage.actions).toBe(0);expect(v.task.plan).toEqual([]);expect(v.decisions.find(d=>d.actor==='llm')?.status).not.toBe('applied');
 }finally{await plugin.close();await f.close();}
});
it('halts an unsupported JEV classification without LLM or action dispatch',async()=>{
 const f=await explorerFixture(),p=fakeProviders(f.url);p.jev.decide=async()=>({model:'mock',value:'unsupported',confidence:.99});const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),{jev:p.jev});
 try{const t=plugin.create({url:f.url,goal:'穷尽整个网站并审查所有视觉缺陷',sessionOptions:{settleMs:0,observeTimeoutMs:100}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);expect(v.task.reason).toBe('TASK_SCOPE_UNSUPPORTED');expect(v.task.intent).toMatchObject({mode:'unsupported',source:'jev'});expect(v.task.usage.actions).toBe(0);expect(v.decisions).toHaveLength(1);
 }finally{await plugin.close();await f.close();}
});
it('allows clearing a goal to switch to default exhaustion and preserves cumulative usage',async()=>{
 const f=await explorerFixture(),p=fakeProviders(f.url,{url:f.url,label:'Alpha',kind:'click'}),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Only Alpha',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:3}});plugin.start(t.id);await plugin.waitForIdle();const before=plugin.view(t.id);plugin.revise(t.id,{goal:'   ',coverageMode:'all'});delete plugin.router.providers.llm;
 plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);expect(v.task.status).toBe('completed');expect(v.task.intent).toMatchObject({mode:'exhaustive',source:'default'});expect(v.task.goal).toBe('');expect(v.task.usage.actions).toBeGreaterThan(before.task.usage.actions);expect(v.decisions.filter(d=>d.actor==='llm')).toHaveLength(1);
 }finally{await plugin.close();await f.close();}
});
it('preserves a default exhaustive root and its budgets after storage restart',async()=>{
 const f=await explorerFixture(),p=fakeProviders(f.url),path=join(f.dir,'default.sqlite');let plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),{jev:p.jev});
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100,maxActions:1},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const before=plugin.view(t.id);await plugin.close();plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),{jev:p.jev});plugin.extendBudget(t.id,{rounds:1,actions:2,durationMs:10000,modelRequests:30});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status,JSON.stringify(v.task)).toBe('completed');expect(v.task.intent).toEqual(before.task.intent);expect(v.task.usage.actions).toBe(2);expect(v.task.usage.modelRequests).toBeGreaterThan(before.task.usage.modelRequests);expect(v.events.filter(e=>e.type==='plan.initialized')).toHaveLength(1);expect(v.decisions.some(d=>d.actor==='llm')).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it('does not release an ordinary idle session when starting a new default task',async()=>{
 const f=await explorerFixture(),p=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),{jev:p.jev});
 try{const ordinary=await f.host.createSession({url:f.url,settleMs:0,observeTimeoutMs:100});const t=plugin.create({url:f.url});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);expect(v.task.reason).toBe('ACTIVE_SESSION');expect(v.task.usage.actions).toBe(0);expect(f.host.session(ordinary.id).status).toBe('idle');expect(v.events.some(e=>e.type==='session.released')).toBe(false);
 }finally{await plugin.close();await f.close();}
});
