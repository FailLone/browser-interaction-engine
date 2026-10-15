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
it('never replays an unknown dispatched outcome after restart',async()=>{
 const f=await explorerFixture();const path=join(f.dir,'plugin.sqlite');let unknownId:string|undefined;let dispatches=0;
 const host=new Proxy(f.host,{get(target,key){if(key==='execute')return async(...args:Parameters<typeof target.execute>)=>{dispatches++;const attempt=await target.execute(...args);unknownId=attempt.id;return {...attempt,status:'unknown' as const};};if(key==='list')return (sid:string,kind:string)=>target.list<any>(sid,kind).map(x=>kind==='attempt'&&x.id===unknownId?{...x,status:'unknown'}:x);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 let plugin=new ExplorerPlugin(host,new ExplorerStore(path),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,goal:'Unknown test',sessionOptions:{settleMs:0,observeTimeoutMs:100}});plugin.start(t.id);await plugin.waitForIdle();expect(plugin.view(t.id).task.pendingDispatch).toBeDefined();expect(dispatches).toBe(1);await plugin.close();
 plugin=new ExplorerPlugin(host,new ExplorerStore(path),fakeProviders(f.url));plugin.start(t.id);await plugin.waitForIdle();expect(dispatches).toBe(1);expect(plugin.view(t.id).task.reason).toBe('UNKNOWN_DISPATCH_REQUIRES_REVIEW');
 }finally{await plugin.close();await f.close();}
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
   return {model:'mock',value:{items:[{title:'Click Alpha',scope,prerequisites:[],completion:'Verify click',required:true,reason:'Observed action'}]}};
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
