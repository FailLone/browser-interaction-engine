import { explorerFixture, fakeProviders } from './explorer-plugin-helpers.js';
import { it,expect } from 'vitest';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync,rmSync,readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractionEngine } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { ExplorerPlugin,ExplorerStore,ExplorerError,type Provider,type ModelRequest } from '@interaction/explorer-plugin';
import { createServer } from '../apps/server/src/server.js';
import { digest,scopeFor,scopeControlKey } from '../packages/explorer-plugin/src/policy.js';
import { remapStoredScopes } from '../packages/explorer-plugin/src/scope-migration.js';

const repeatedRecords=()=>`<section aria-label="Records">${['Alpha','Beta','Gamma'].map(name=>`<article data-key="${name}"><span>${name}</span><button type="button" onclick="this.disabled=true">Visit ${name}</button></article>`).join('')}</section>`;
it.each(['all','partial','across-rounds'] as const)('reconciles repeated legacy field gaps only after %s matching controls are verified',async(mode)=>{
 const f=await explorerFixture(`<section aria-label="Measurements"><div><span>Length</span><input placeholder="0"></div><div><span>Width</span><input placeholder="0"></div></section>`),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100,...(mode==='across-rounds'?{maxActions:1}:{})},budget:{rounds:mode==='across-rounds'?3:1,actions:mode==='partial'?1:10}});
  plugin.revise(t.id,{items:[{title:'Measurements',scope:{url:f.url},prerequisites:[],completion:'Verify every field',required:true,reason:'user goal'}]});
  const saved=plugin.store.task(t.id);
  for(const reason of ['ambiguous_scope_match','operation_unavailable'])saved.plan.push({...structuredClone(saved.plan[0]),id:reason,scope:{url:f.url,label:'0',role:'textbox',kind:'fill',value:'example'},status:'unresolved',reason,dispatchScope:false});
  plugin.store.save(saved);plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),attempts=v.task.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  const gaps=v.task.plan.filter(i=>['ambiguous_scope_match','operation_unavailable'].includes(i.id));
  expect(attempts).toHaveLength(mode==='partial'?1:2);expect(attempts.every(a=>a.status==='succeeded')).toBe(true);
  if(mode!=='partial'){expect(gaps.map(i=>i.status)).toEqual(['succeeded','succeeded']);expect(v.task.status).toBe('completed');}
  else{expect(gaps.every(i=>i.status!=='succeeded')).toBe(true);expect(v.task.status).not.toBe('completed');}
  expect(new Set(v.task.plan.filter(i=>i.scope.stableKey?.startsWith('explorer:context:v1:')&&i.status==='succeeded').map(i=>i.scope.stableKey)).size).toBe(mode==='partial'?1:2);
  if(mode==='across-rounds')expect(v.task.rounds).toHaveLength(2);
 }finally{await plugin.close();await f.close();}
});

it.each(['disappeared','missing-source','unknown','capability'] as const)('preserves a %s obligation while settling matching field gaps',async(mode)=>{
 let labels=['Length','Width'];const f=await explorerFixture(()=>`<section aria-label="Measurements">${labels.map(label=>`<div><span>${label}</span><input placeholder="0"></div>`).join('')}</section>`),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const evidence:{sessionId:string;observationId:string}[]=[];
  if(mode==='disappeared'){const source=await f.host.createSession({url:f.url,settleMs:0,observeTimeoutMs:100});evidence.push({sessionId:source.id,observationId:f.host.observation(source.id).id});await f.host.stop(source.id);labels=['Length'];}
  if(mode==='missing-source')evidence.push({sessionId:'unavailable-session',observationId:'unavailable-observation'});
  const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:10}});
  plugin.revise(t.id,{items:[{title:'Measurements',scope:{url:f.url},prerequisites:[],completion:'Verify every field',required:true,reason:'user goal'}]});
  const saved=plugin.store.task(t.id),reason=mode==='unknown'?'unknown_action_outcome':mode==='capability'?'missing_capability:test':'ambiguous_scope_match';
  saved.plan.push({...structuredClone(saved.plan[0]),id:'legacy-gap',scope:{url:f.url,label:'0',role:'textbox',kind:'fill',value:'example'},status:'unresolved',reason,dispatchScope:false,evidence});
  plugin.store.save(saved);plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),gap=v.task.plan.find(i=>i.id==='legacy-gap')!;
  expect(v.task.usage.actions).toBe(mode==='disappeared'?1:2);expect(gap.status).not.toBe('succeeded');expect(v.task.status).not.toBe('completed');expect(gap.reason).toBe(reason);
  if(mode==='unknown'||mode==='capability'){expect(gap.attempts).toEqual([]);expect(gap.resolvedBy).toBeUndefined();}
 }finally{await plugin.close();await f.close();}
});

it('does not reuse a completed coarse field scope for a newly revealed semantic field',async()=>{
 const f=await explorerFixture(`<section aria-label="Measurements"><div id="fields"><div><span>Length</span><input placeholder="0"></div><div><span>Width</span><input placeholder="0"></div></div><button type="button" onclick="this.disabled=true;document.getElementById('fields').innerHTML='<div><span>Depth</span><input placeholder=0></div>'">Next</button></section>`),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:10}});
  plugin.revise(t.id,{items:[{title:'Measurements',scope:{url:f.url},prerequisites:[],completion:'Verify every field',required:true,reason:'user goal'}]});
  const saved=plugin.store.task(t.id);saved.plan.push({...structuredClone(saved.plan[0]),id:'legacy-gap',scope:{url:f.url,label:'0',role:'textbox',kind:'fill',value:'example'},status:'unresolved',reason:'ambiguous_scope_match',dispatchScope:false});plugin.store.save(saved);
  plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),sid=v.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
  const bindings=attempts.filter(a=>a.action.kind==='fill').map(a=>f.host.observation(sid,a.beforeId).controls.find(c=>c.localId===a.action.localId)!.identityContext?.binding);
  expect(bindings).toEqual([expect.stringContaining('Length'),expect.stringContaining('Width'),expect.stringContaining('Depth')]);expect(v.task.status).toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it.each(['distinct','ambiguous'] as const)('uses public semantic context to distinguish %s unnamed-key fields without guessing an occurrence',async(mode)=>{
 const descriptions=mode==='distinct'?['Length','Width']:['Value','Value'];
 const f=await explorerFixture(`<section aria-label="Measurements">${descriptions.map(label=>`<div><span>${label}</span><input placeholder="0"></div>`).join('')}</section>`),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:10}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),sid=v.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
  if(mode==='distinct'){
   expect(attempts).toHaveLength(2);expect(attempts.every(a=>a.action.kind==='fill'&&a.status==='succeeded')).toBe(true);expect(v.task.status).toBe('completed');
   const sources=attempts.map(a=>{const o=f.host.observation(sid,a.beforeId);const c=o.controls.find(c=>c.localId===a.action.localId)!;expect(c.stableKey).toBeUndefined();return {binding:c.identityContext?.binding,key:scopeFor(a.action,o).stableKey};});expect(new Set(sources.map(s=>s.key)).size).toBe(2);expect(sources.every(s=>s.key?.startsWith('explorer:context:v1:'))).toBe(true);expect(sources.map(s=>s.binding)).toEqual(expect.arrayContaining([expect.stringContaining('Length'),expect.stringContaining('Width')]));
  }else{expect(attempts).toEqual([]);expect(v.task.status).not.toBe('completed');expect(v.task.plan.some(i=>i.reason==='ambiguous_scope_match')).toBe(true);}
 }finally{await plugin.close();await f.close();}
});

it('keeps contextual hints separate from stable and list-record keys, values and execution identifiers',()=>{
 const control={tag:'input',role:'textbox',name:'0',constraints:{type:'text'},identityContext:{scope:'Measurements',binding:'Length',evidence:['local-field-description/v1']}} as any;
 const key=scopeControlKey(control);expect(key).toMatch(/^explorer:context:v1:/);expect(scopeControlKey({...control,localId:'fresh',instanceId:'fresh',value:'100'})).toBe(key);expect(scopeControlKey({...control,identityContext:{...control.identityContext,binding:'Width'}})).not.toBe(key);
 expect(scopeControlKey({...control,stableKey:'id:field'})).toBe('id:field');expect(scopeControlKey({...control,list:{instanceId:'list'}})).toBeUndefined();expect(scopeControlKey({...control,structuralItem:{ownerInstanceId:'owner',slot:'0'}})).toBeUndefined();expect(scopeControlKey({...control,identityContext:{evidence:[]}})).toBeUndefined();
 const task={plan:[{scope:{stableKey:key},prerequisites:[]}],rounds:[]} as any;expect(remapStoredScopes(task,{} as any)).toEqual([]);
});

it('matches contextual fields across rounds while keeping actual attempts in their original sessions',async()=>{
 const f=await explorerFixture(`<section aria-label="Measurements"><div><span>Length</span><input placeholder="0"></div><div><span>Width</span><input placeholder="0"></div></section>`),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{maxActions:1,settleMs:0,observeTimeoutMs:100},budget:{rounds:3,actions:3}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);expect(v.task.status).toBe('completed');expect(v.task.rounds).toHaveLength(2);expect(v.task.usage.actions).toBe(2);
  const bindings=v.task.rounds.map(r=>{const attempts=f.host.list<any>(r.sessionId,'attempt');expect(attempts).toHaveLength(1);const a=attempts[0];expect(a.status).toBe('succeeded');return f.host.observation(r.sessionId,a.beforeId).controls.find(c=>c.localId===a.action.localId)!.identityContext?.binding;});expect(new Set(bindings).size).toBe(2);
 }finally{await plugin.close();await f.close();}
});

it('provides semantic field evidence with exact scopes so a target plan selects only the intended field',async()=>{
 const f=await explorerFixture(`<section aria-label="Measurements"><div><span>Length</span><input placeholder="0"></div><div><span>Width</span><input placeholder="0"></div></section>`),p=fakeProviders(f.url),original=p.llm.decide;
 p.llm.decide=async(r,s)=>{if(r.purpose!=='initial-plan')return original(r,s);const candidate=(r.state as any).material.observation.contextualActions?.find((a:any)=>a.context?.binding?.includes('Width'));expect(candidate).toBeDefined();return {model:'mock',value:{mode:'targeted',items:[{title:'Width',scope:candidate.scope,prerequisites:[],completion:'Fill Width',required:true,reason:'user target'}]}};};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Fill Width only',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),sid=v.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');expect(v.task.status).toBe('completed');expect(attempts).toHaveLength(1);const a=attempts[0];expect(f.host.observation(sid,a.beforeId).controls.find(c=>c.localId===a.action.localId)!.identityContext?.binding).toContain('Width');
  const selection=v.decisions.find(d=>d.purpose==='next-action')!;expect((selection.request.options![String(selection.answer!.value)] as any).context.binding).toContain('Width');
 }finally{await plugin.close();await f.close();}
});

it.each(['same-document','new-document'] as const)('exits a reappearing boundary in %s even when its close operation succeeded earlier',async(mode)=>{
 const f=await explorerFixture(`<div id="gate" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white;z-index:10"><button type="button" id="close" onclick="document.querySelector('#gate').hidden=true">Close</button></div><button type="button" id="next" onclick="${mode==='same-document'?`this.disabled=true;document.querySelector('#gate').hidden=false`:`sessionStorage.setItem('next-done','yes');location.reload()`}">Next</button><button type="button" id="last" onclick="this.disabled=true">Last</button><script>if(sessionStorage.getItem('next-done'))document.querySelector('#next').disabled=true</script>`),p=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1,actions:12}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),attempts=f.host.list<any>(v.task.rounds[0].sessionId,'attempt');
  expect(attempts.map(a=>a.action.label)).toEqual(['Close','Next','Close','Last']);expect(attempts.every(a=>a.status==='succeeded')).toBe(true);expect(v.task.status).toBe('completed');expect(v.decisions.some(d=>d.purpose==='recovery-selection')).toBe(false);expect(v.task.usage.actions).toBe(4);
 }finally{await plugin.close();await f.close();}
});

it('does not repeat an ineffective exit while the same boundary remains observed',async()=>{
 const f=await explorerFixture('<div id="gate" role="dialog" aria-modal="true"><button type="button" id="close">Close</button></div>'),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:12}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),attempts=f.host.list<any>(v.task.rounds[0].sessionId,'attempt');expect(attempts.filter(a=>a.action.label==='Close')).toHaveLength(1);expect(v.task.usage.actions).toBeLessThan(12);expect(v.task.status).not.toBe('completed');}
 finally{await plugin.close();await f.close();}
});

it('grounds recovery judgments in both observations and the unfinished branch before verified restoration',async()=>{
 const f=await explorerFixture(`<div id="choices">${['First','Second'].map(name=>`<button type="button" onclick="document.querySelector('#choices').hidden=true">${name}</button>`).join('')}</div>`),p=fakeProviders(f.url),original=p.jev.decide,requests:any[]=[];
 p.jev.decide=async(r,s)=>{if(r.purpose!=='recovery-selection')return original(r,s);const m=(r.state as any).material;requests.push(m);return {model:'mock',confidence:1,value:m.current?.observationId!==m.target?.observationId&&m.target?.url===f.url&&m.unfinishedTargets?.some((x:any)=>x.scope.label==='Second'&&x.currentlyExecutable===false)?'recover':'uncertain'};};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:10}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),attempts=f.host.list<any>(v.task.rounds[0].sessionId,'attempt');
  expect(attempts.filter(a=>a.action.kind==='click').map(a=>a.action.label)).toEqual(['First','Second']);expect(v.task.status).toBe('completed');expect(requests).toHaveLength(1);expect(requests[0].goal).not.toBe('');expect(requests[0].unfinishedTargets.every((x:any)=>x.historicalEvidenceOnly)).toBe(true);
  expect(v.events.some(e=>e.type==='recovery.result'&&['REACHED_VERIFIED','REACHED_ACCEPTABLE'].includes((e.data as any).status))).toBe(true);expect(v.decisions.some(d=>d.actor==='llm')).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it.each([2,3,5])('finishes available new controls before replaying an entry and returns for all %i children',async(count)=>{
 const children=['First','Second','Third','Fourth','Fifth'].slice(0,count);
 const f=await explorerFixture(`<button id="open" type="button" onclick="document.getElementById('menu').hidden=false">Open</button><div id="menu" hidden>${children.map(name=>`<button type="button" onclick="this.disabled=true;document.getElementById('menu').hidden=true">${name}</button>`).join('')}</div><button type="button" onclick="this.disabled=true;document.getElementById('menu').hidden=true">Outside</button>`),p=fakeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>{if(r.purpose==='next-action'){const options=Object.entries(r.options!) as [string,any][];const selected=['Open','First','Outside',...children.slice(1)].map(label=>options.find(([,o])=>o.label===label)).find(Boolean)!;return {model:'mock',value:selected[0],confidence:1};}return original(r,s);};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:15}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),attempts=f.host.list<any>(v.task.rounds[0].sessionId,'attempt');
  expect(attempts.map(a=>a.action.label)).toEqual(['Open','First','Outside',...children.slice(1).flatMap(name=>['Open',name])]);expect(v.task.status).toBe('completed');
  expect(v.events.some(e=>e.type==='action.priority'&&(e.data as any).deferred.some((a:any)=>a.label==='Open'))).toBe(true);
  const reentry=v.decisions.filter(d=>d.purpose==='next-action').map(d=>d.request.options![String(d.answer!.value)] as any).find(o=>o.reentry);expect(reentry).toMatchObject({label:'Open',purpose:'prerequisite',reentry:true});
  expect(children.every(name=>v.task.plan.some(i=>i.scope.label===name&&i.status==='succeeded'))).toBe(true);
 }finally{await plugin.close();await f.close();}
});

it('does not replay an unchanged missing branch when unrelated work changes the coverage ledger',async()=>{
 const f=await explorerFixture(`<button id="open" type="button" onclick="document.getElementById('result').textContent='Opened'">Open</button><output id="result"></output><button type="button" onclick="this.disabled=true">Outside</button>`),p=fakeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='recovery-selection'?{model:'mock',value:'uncertain',confidence:1}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});
  plugin.revise(t.id,{items:[{title:'Page',scope:{url:f.url},prerequisites:[],completion:'Verify discovered controls',required:true,reason:'user scope'}]});
  const saved=plugin.store.task(t.id);saved.plan.push({...structuredClone(saved.plan[0]),id:'missing-child',title:'Missing child',scope:{url:f.url,label:'Child',kind:'click'},prerequisites:[{url:f.url,label:'Open',kind:'click'}],dispatchScope:false,status:'unresolved',reason:'operation_not_executed'});plugin.store.save(saved);
  plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),attempts=f.host.list<any>(v.task.rounds[0].sessionId,'attempt');
  expect(attempts.map(a=>a.action.label)).toEqual(['Open','Outside']);
  expect(v.task.plan.find(i=>i.id==='missing-child')?.status).not.toBe('succeeded');expect(v.task.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it.each(['current','longer-path','legacy-v2'])('preserves branch retry limits across restart, unrelated gaps and duplicate evidence rows: %s',async(mode)=>{
 const f=await explorerFixture(`<button id="open" type="button" onclick="document.getElementById('result').textContent='Opened'">Open</button><output id="result"></output><button type="button" onclick="this.disabled=true">Outside</button>`),p=fakeProviders(f.url),original=p.jev.decide,path=join(f.dir,'branch.sqlite');
 let began!:()=>void,release!:()=>void,hold=true;const waiting=new Promise<void>(r=>began=r);
 p.jev.decide=async(r,s)=>{if(r.purpose==='recovery-selection')return {model:'mock',value:'uncertain',confidence:1};if(hold&&r.purpose==='next-action'&&Object.values(r.options!).some((o:any)=>o.label==='Outside')&&!Object.values(r.options!).some((o:any)=>o.label==='Open')){hold=false;began();await new Promise<void>(resolve=>release=resolve);}return original(r,s);};
 let plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});
  plugin.revise(t.id,{items:[{title:'Page',scope:{url:f.url},prerequisites:[],completion:'Verify discovered controls',required:true,reason:'user scope'}]});
  const saved=plugin.store.task(t.id);saved.plan.push({...structuredClone(saved.plan[0]),id:'missing-child',scope:{url:f.url,label:'Child',kind:'click'},prerequisites:[{url:f.url,label:'Open',kind:'click'}],dispatchScope:false,status:'unresolved',reason:'operation_not_executed'});plugin.store.save(saved);
  plugin.start(t.id);await waiting;await plugin.pause(t.id);release();const before=plugin.view(t.id),sid=before.task.rounds[0].sessionId;expect(before.task.usage.actions).toBe(1);await plugin.close();
  plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),p);const restored=plugin.store.task(t.id),child=restored.plan.find(i=>i.id==='missing-child')!;
  if(mode==='legacy-v2'){
    const source=f.host.list<any>(sid,'attempt').find(a=>a.action.label==='Open')!,o=f.host.observation(sid,source.beforeId);
    restored.rounds[0].reentries=[`branch-v2:${digest({scope:scopeFor(source.action,o),pending:[digest({scope:child.scope,prerequisites:child.prerequisites})]})}`];
  }
  restored.plan.push({...structuredClone(child),id:'duplicate-child',reason:'operation_unavailable'},{...structuredClone(child),id:'unrelated-gap',scope:{url:f.url,label:'Elsewhere',kind:'click'},prerequisites:[]});plugin.store.save(restored);
  if(mode==='longer-path'){for(const item of restored.plan.filter(i=>['missing-child','duplicate-child'].includes(i.id)))item.prerequisites=[{url:f.url,label:'Earlier',kind:'click'},...item.prerequisites,...item.prerequisites];plugin.store.save(restored);}
  plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(v.task.rounds).toHaveLength(1);expect(v.task.usage.actions).toBe(2);expect(v.task.usage.modelRequests).toBeGreaterThanOrEqual(before.task.usage.modelRequests);
  expect(f.host.list<any>(sid,'attempt').map(a=>a.action.label)).toEqual(['Open','Outside']);
  expect(v.task.plan.filter(i=>['missing-child','duplicate-child','unrelated-gap'].includes(i.id)).every(i=>i.status!=='succeeded')).toBe(true);expect(v.task.status).not.toBe('completed');
 }finally{release?.();await plugin.close();await f.close();}
});

it.each(['whole-page','targeted','after-last-action'] as const)('retains host coverage limitations for %s without treating other successes as coverage',async(mode)=>{
 const f=await explorerFixture(mode==='after-last-action'?`<button type="button" onclick="this.disabled=true;document.querySelector('main').appendChild(document.createElement('canvas'))">Ready</button>`:`<canvas id="chart"></canvas><button type="button" onclick="this.disabled=true">Ready</button>`),p=fakeProviders(f.url,{url:f.url,label:'Ready',kind:'click'}),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,...(mode==='targeted'?{goal:'Click Ready'}:{}),sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:mode==='after-last-action'?1:10}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),sid=v.task.rounds[0].sessionId;
  expect(f.host.observation(sid).gaps.some(g=>g.code==='UNSUPPORTED_CANVAS'&&!g.critical)).toBe(true);
  expect(f.host.list<any>(sid,'attempt').map(a=>a.action.label)).toEqual(['Ready']);
  const gap=v.task.plan.find(i=>i.reason==='missing_capability:UNSUPPORTED_CANVAS');
  if(mode==='targeted'){expect(v.task.status).toBe('completed');expect(gap).toBeUndefined();}
  else{expect(v.task.status).not.toBe('completed');expect(gap).toMatchObject({required:true,status:'unresolved',dispatchScope:false,attempts:[]});expect(gap!.resolvedBy).toBeUndefined();
   const event=v.events.find(e=>e.type==='scope.unsupported')!;expect(event).toBeDefined();expect((event.data as any).limitations.some((g:any)=>g.code==='UNSUPPORTED_CANVAS')).toBe(true);
   expect(f.host.observation(sid,gap!.evidence[0].observationId).gaps.some(g=>g.code==='UNSUPPORTED_CANVAS')).toBe(true);
  }
 }finally{await plugin.close();await f.close();}
});

it.each([false,true])('continues untested controls after persisting unsupported-content acceptance without clearing budgets or unknown outcomes (%s)',async(unknown)=>{
 const f=await explorerFixture('<canvas id="chart"></canvas><button type="button" onclick="this.disabled=true">Ready</button><button type="button" onclick="this.disabled=true">Next</button>'),path=join(f.dir,'limitations.sqlite');let plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:2,actions:1}});plugin.start(t.id);await plugin.waitForIdle();
  const before=plugin.view(t.id).task,canvas=before.plan.find(i=>i.reason==='missing_capability:UNSUPPORTED_CANVAS')!;expect(canvas.required).toBe(true);
  if(unknown){before.plan.push({...structuredClone(canvas),id:'unknown',reason:'unknown_action_outcome',scope:{url:f.url,label:'Prior navigation',kind:'click'}});plugin.store.save(before);}
  const accepted=plugin.acceptLimitations(t.id,{codes:['UNSUPPORTED_CANVAS'],reason:'Canvas may remain untested'});
  expect(accepted.usage).toEqual(before.usage);expect(accepted.budget).toEqual(before.budget);expect(accepted.plan.filter(i=>i.dispatchScope)).toEqual(before.plan.filter(i=>i.dispatchScope));
  expect(accepted.plan.find(i=>i.id===canvas.id)).toMatchObject({required:false,status:'untested',evidence:canvas.evidence});expect(accepted.plan.find(i=>i.id===canvas.id)?.resolvedBy).toBeUndefined();
  await plugin.close();plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),fakeProviders(f.url));expect(plugin.view(t.id).task.acceptedLimitations).toEqual(accepted.acceptedLimitations);
  plugin.extendBudget(t.id,{rounds:1,actions:2,durationMs:60000,modelRequests:100});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(v.task.usage.actions).toBe(2);expect(v.task.plan.find(i=>i.id===canvas.id)?.status).toBe('untested');
  expect(v.task.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt')).map(a=>a.action.label)).toEqual(['Ready','Next']);
  expect(v.task.plan.find(i=>i.id===canvas.id)?.attempts).toEqual([]);expect(v.task.plan.find(i=>i.id===canvas.id)?.resolvedBy).toBeUndefined();
  if(unknown){expect(v.task.status).not.toBe('completed');expect(v.task.plan.find(i=>i.id==='unknown')).toMatchObject({required:true,status:'unresolved'});}
  else{expect(v.task.status).toBe('completed');plugin.revise(t.id,{itemIds:[canvas.id]},true);expect(plugin.view(t.id).task.acceptedLimitations).toEqual([]);expect(plugin.view(t.id).task.plan.find(i=>i.id===canvas.id)?.required).toBe(true);}
 }finally{await plugin.close();await f.close();}
});

it('rejects unobserved, critical and unknown-dispatch limitation acceptance atomically',async()=>{
 const f=await explorerFixture('<canvas></canvas>');let critical=false;
 const host=new Proxy(f.host,{get(target,key){if(key==='observation')return (...args:Parameters<typeof target.observation>)=>{const o=target.observation(...args);return critical?{...o,gaps:o.gaps.map(g=>({...g,critical:true}))}:o;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}}),plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const before=plugin.view(t.id).task;
  for(const codes of [['UNSUPPORTED_CANVAS','UNSUPPORTED_IFRAME'],['unknown_action_outcome']])expect(()=>plugin.acceptLimitations(t.id,{codes,reason:'Accept only evidenced limits'})).toThrow();
  critical=true;expect(()=>plugin.acceptLimitations(t.id,{codes:['UNSUPPORTED_CANVAS'],reason:'Cannot waive critical evidence'})).toThrow('INVALID_LIMITATION');critical=false;
  expect(plugin.view(t.id).task).toEqual(before);
  before.pendingDispatch={sessionId:before.rounds[0].sessionId,requestId:'unknown',actionId:'unknown',itemIds:[],observationId:host.observation(before.rounds[0].sessionId).id};plugin.store.save(before);
  expect(()=>plugin.acceptLimitations(t.id,{codes:['UNSUPPORTED_CANVAS'],reason:'Cannot waive an unknown dispatch'})).toThrow('UNKNOWN_DISPATCH_REQUIRES_REVIEW');expect(plugin.view(t.id).task).toEqual(before);
 }finally{await plugin.close();await f.close();}
});

it('matches repeated records across fresh documents without treating history as a new execution',async()=>{
 const f=await explorerFixture(repeatedRecords());const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{maxActions:1,settleMs:0,observeTimeoutMs:100},budget:{rounds:4,actions:5,modelRequests:200}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(v.task.status,JSON.stringify({task:v.task,decisions:v.decisions.map(d=>({p:d.purpose,r:d.reason}))})).toBe('completed');
  const attempts=v.task.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(attempts.map(a=>a.action.label)).toEqual(['Visit Alpha','Visit Beta','Visit Gamma']);expect(v.task.usage.actions).toBe(3);
  const first=attempts[0],source=f.host.observation(first.sessionId,first.beforeId),old=source.controls.find(c=>c.localId===first.action.localId)!;
  expect(old.structuralItem?.recordKey).toBeTruthy();expect(scopeFor(first.action,source).stableKey).toMatch(/^explorer:record:v1:/);
  const last=f.host.observation(v.task.rounds.at(-1)!.sessionId),current=last.controls.find(c=>c.name==='Visit Alpha')!;
  expect(current.stableKey).not.toBe(old.stableKey);
  expect(v.task.plan.find(i=>i.scope.label==='Visit Alpha'&&i.status==='succeeded')?.resolvedBy?.attemptId).toBe(first.id);
 }finally{await plugin.close();await f.close();}
});
it('migrates legacy scope keys using retained original evidence and preserves unresolved unmatched scopes',async()=>{
 const f=await explorerFixture(repeatedRecords());const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:3,actions:1}});plugin.start(t.id);await plugin.waitForIdle();const saved=plugin.store.task(t.id),sid=saved.rounds[0].sessionId,o=f.host.observation(sid);
  const beta=saved.plan.find(i=>i.scope.label==='Visit Beta')!;expect(beta).toBeDefined();const control=o.controls.find(c=>c.name==='Visit Beta')!;
  beta.scope.stableKey=control.stableKey;const missing={...structuredClone(beta),id:'missing-evidence',scope:{...beta.scope,stableKey:'unknown-old-key'},evidence:[]};saved.plan.push(missing);
  const before=structuredClone({usage:saved.usage,attempts:beta.attempts,evidence:beta.evidence,required:beta.required,dispatchScope:beta.dispatchScope,status:beta.status});
  const changes=remapStoredScopes(saved,f.host);expect(changes.some(c=>c.before.stableKey===control.stableKey)).toBe(true);expect(beta.scope.stableKey).toMatch(/^explorer:record:v1:/);expect(missing.scope.stableKey).toBe('unknown-old-key');
  expect({usage:saved.usage,attempts:beta.attempts,evidence:beta.evidence,required:beta.required,dispatchScope:beta.dispatchScope,status:beta.status}).toEqual(before);
  // Exercise the automatic migration path too, then supplement only this exact record.
  beta.scope.stableKey=control.stableKey;plugin.store.save(saved);plugin.revise(t.id,{itemIds:[beta.id]},true);plugin.extendBudget(t.id,{rounds:1,actions:1,durationMs:60000,modelRequests:100});plugin.start(t.id);await plugin.waitForIdle();const view=plugin.view(t.id);
  expect(view.task.plan.find(i=>i.id===beta.id)?.status,JSON.stringify(view.task)).toBe('succeeded');expect(view.events.some(e=>e.type==='scope.remapped')).toBe(true);expect(view.task.usage.actions).toBe(2);
  expect(f.host.list<any>(view.task.rounds.at(-1)!.sessionId,'attempt').map(a=>a.action.label)).toEqual(['Visit Beta']);
 }finally{await plugin.close();await f.close();}
});
it('does not arbitrarily execute colliding semantic record scopes',async()=>{
 const f=await explorerFixture(`<section>${Array.from({length:3},()=>'<article data-key="duplicate"><span>Same record</span><button type="button" onclick="this.disabled=true">Visit</button></article>').join('')}</section>`);const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,modelRequests:100}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(v.task.usage.actions).toBe(0);expect(v.task.status).not.toBe('completed');expect(v.task.plan.some(i=>i.reason==='ambiguous_scope_match')).toBe(true);
 }finally{await plugin.close();await f.close();}
});
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
it('uses only public host APIs and keeps the SDK independent of the optional explorer',()=>{
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
it.each(['after-action','dispatch-preflight'] as const)('continues after the host time limit at %s without resetting aggregate usage',async(mode)=>{
 const f=await explorerFixture(),expired=new Set<string>();let rejected=false;
 const host=new Proxy(f.host,{get(target,key){
  if(key==='session')return(sid:string)=>{const s=target.session(sid);return expired.has(sid)?{...s,elapsedMs:s.options.maxDurationMs}:s;};
  if(key==='execute')return async(...args:Parameters<typeof target.execute>)=>{
   if(mode==='dispatch-preflight'&&!rejected){rejected=true;expired.add(args[0]);throw new ExplorerError('BUDGET_EXHAUSTED');}
   const a=await target.execute(...args);if(mode==='after-action')expired.add(args[0]);return a;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:3,actions:5}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(v.task.status,JSON.stringify({reason:v.task.reason,rounds:v.task.rounds.map(r=>r.status)})).toBe('completed');expect(v.task.rounds).toHaveLength(2);expect(v.task.usage.actions).toBe(2);expect(v.task.pendingDispatch).toBeUndefined();
  expect(v.task.rounds.map(r=>f.host.list<any>(r.sessionId,'attempt').map(a=>a.action.label))).toEqual(mode==='after-action'?[['Alpha'],['Beta']]:[[],['Alpha','Beta']]);
  expect(v.task.usage.modelRequests).toBe(v.decisions.length);expect(v.events.some(e=>e.type==='round.session_limit')).toBe(true);
 }finally{await plugin.close();await f.close();}
});
it('resumes an expired unplanned session without mistaking an empty plan for completion',async()=>{
 const f=await explorerFixture(),providers=fakeProviders(f.url),expired=new Set<string>();
 const host=new Proxy(f.host,{get(target,key){if(key==='session')return(sid:string)=>{const s=target.session(sid);return expired.has(sid)?{...s,elapsedMs:s.options.maxDurationMs}:s;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),{jev:providers.jev});
 try{const t=plugin.create({url:f.url,goal:'Both controls',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:3,actions:5}});plugin.start(t.id);await plugin.waitForIdle();const before=plugin.view(t.id);
  expect(before.task.status).toBe('configuration_required');expect(before.task.plan).toHaveLength(0);expired.add(before.task.rounds[0].sessionId);
  plugin.router.providers.llm=providers.llm;plugin.start(t.id);await plugin.waitForIdle();const after=plugin.view(t.id);
  expect(after.task.status,JSON.stringify(after.task)).toBe('completed');expect(after.task.rounds).toHaveLength(2);expect(after.task.usage.actions).toBe(2);expect(after.task.usage.modelRequests).toBeGreaterThan(before.task.usage.modelRequests);
  expect(f.host.list<any>(before.task.rounds[0].sessionId,'attempt')).toHaveLength(0);expect(after.events.some(e=>e.type==='round.session_limit'&&(e.data as any).planInitialized===false)).toBe(true);
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
it('audits newly revealed controls when the opening action consumes the last action budget',async()=>{
 const f=await explorerFixture('<button id="open" type="button" onclick="document.querySelector(\'dialog\').showModal()">Open</button><dialog aria-label="New scope"><button type="button">New operation</button><button type="button" onclick="document.querySelector(\'dialog\').close()">Close</button></dialog>');const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:1}});plugin.start(t.id);await plugin.waitForIdle();const view=plugin.view(t.id);
  expect(view.task.status).toBe('budget_exhausted');expect(view.task.usage.actions).toBe(1);expect(view.task.plan.some(i=>i.required&&i.scope.label==='New operation'&&i.status==='unresolved')).toBe(true);
  expect(view.events.some(e=>e.type==='scope.audit'&&(e.data as any).pendingReview)).toBe(true);expect(view.task.plan.find(i=>i.dispatchScope)?.status).not.toBe('succeeded');
 }finally{await plugin.close();await f.close();}
});
it.each([true,false])('reopens the recorded entry path after an action budget boundary (selected supplement: %s)',async(supplement)=>{
 const f=await explorerFixture('<button type="button" onclick="document.querySelector(\'dialog\').showModal()">Open</button><button type="button">Unrelated</button><dialog aria-label="New scope"><button type="button" onclick="this.disabled=true">New operation</button><button type="button" onclick="document.querySelector(\'dialog\').close()">Close</button></dialog>');const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:1}});plugin.start(t.id);await plugin.waitForIdle();let task=plugin.view(t.id).task;
  const target=task.plan.find(i=>i.scope.label==='New operation'&&i.status==='unresolved')!;expect(target).toBeDefined();
  expect(task.plan.filter(i=>i.scope.label==='Unrelated').every(i=>!i.prerequisites.length)).toBe(true);
  if(supplement)plugin.revise(t.id,{itemIds:[target.id]},true);plugin.extendBudget(t.id,{rounds:1,actions:supplement?2:3,durationMs:60000,modelRequests:80});plugin.start(t.id);await plugin.waitForIdle();task=plugin.view(t.id).task;
  expect(task.plan.find(i=>i.id===target.id)?.status,JSON.stringify(task)).toBe('succeeded');
  expect(f.host.list<any>(task.rounds.at(-1)!.sessionId,'attempt').map(a=>a.action.label)).toEqual(supplement?['Open','New operation']:['Unrelated','Open','New operation']);
  expect(task.usage.actions).toBe(supplement?3:4);expect(task.plan.find(i=>i.id===target.id)?.prerequisites.map(s=>s.label)).toEqual(['Open']);
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
it('preserves real parent fields rather than default null/empty fields on a large page',async()=>{
 const f=await explorerFixture(`<style>#outside{position:fixed;inset:0;background:#eee}#fields{position:absolute;top:20px;left:10px;z-index:1}#panel{position:absolute;top:100px;left:100px;width:200px;height:160px;background:white;z-index:2}</style><div id="outside"></div>${Array.from({length:125},(_,i)=>`<button type="button">Static ${i}</button>`).join('')}<div id="fields"><input aria-label="Amount" value="42"><input aria-label="Unchecked" type="checkbox"><select aria-label="Empty choice"></select><select aria-label="Selected choice"><option selected>A</option></select><input aria-label="Read only" value="retained" readonly></div><div id="panel" role="listbox" aria-label="Options"><button type="button" onclick="this.disabled=true">Inside</button></div><script>document.addEventListener('click',e=>{if(e.target.id==='outside')panel.hidden=true})</script>`);
 const providers=fakeProviders(f.url),original=providers.jev.decide;providers.jev.decide=async(r,s)=>{const a=await original(r,s);if(r.purpose==='boundary-exit-risk'&&(r.state as any).material.candidate.selector!=='#outside')return {...a,value:{interface_exit:.01,external_exit:.5}};return a;};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1,actions:3,modelRequests:30}});plugin.start(t.id);await plugin.waitForIdle();const view=plugin.view(t.id),sid=view.task.rounds[0].sessionId;
  const exits=f.host.list<any>(sid,'boundary-exit-result');expect(exits.map(x=>x.status),JSON.stringify({reason:view.task.reason,plan:view.task.plan})).toEqual(['verified']);
  const judgment=view.decisions.find(d=>d.purpose==='boundary-exit-risk'&&d.status==='applied')!;const fields=(judgment.request.state as any).material.preserved;
  expect(fields.map((c:any)=>c.name).sort()).toEqual(['Amount','Empty choice','Read only','Selected choice','Unchecked']);expect(fields.find((c:any)=>c.name==='Unchecked').checked).toBe(false);expect(fields.find((c:any)=>c.name==='Empty choice').selected).toEqual([]);
  expect(view.task.plan.some(i=>i.reason==='boundary_preservation_limit')).toBe(false);expect(view.task.usage.actions).toBe(3);expect(view.task.status).not.toBe('completed');expect(view.task.plan.some(i=>i.required&&i.scope.label?.startsWith('Static ')&&i.status!=='succeeded')).toBe(true);
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
it('retries a required interface exit after a real browser restart without resetting history or totals',async()=>{
 const server=httpServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><main><h1>Page</h1><button id="sibling" type="button" onclick="this.disabled=true">Sibling</button><dialog aria-label="Notice"><button type="button" onclick="document.querySelector(\'dialog\').close()">Close</button></dialog></main><script>document.querySelector("dialog").showModal()</script>');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`,dir=mkdtempSync(join(tmpdir(),'explorer-reattach-')),path=join(dir,'plugin.sqlite');
 let host=new InteractionEngine({persistence:new SqliteStore(join(dir,'engine'))});const providers=fakeProviders(url),original=providers.jev.decide;
 let notified=false,notify!:()=>void;const waiting=new Promise<void>(resolve=>notify=resolve);
 providers.jev.decide=async(r,s)=>{const oid=(r.state as any).observationId;if(!notified&&host.sessions().length&&oid&&!host.observation(host.sessions()[0].id,oid).boundaries?.length){notified=true;notify();return new Promise(()=>{});}return original(r,s);};
 let plugin=new ExplorerPlugin(host,new ExplorerStore(path),providers);
 try{const task=plugin.create({url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,modelRequests:100}});plugin.start(task.id);await waiting;await plugin.pause(task.id);const before=plugin.view(task.id),sid=before.task.rounds[0].sessionId,priorInstance=host.observation(sid).instanceScope;
  expect(host.list<any>(sid,'attempt').map(a=>a.action.label)).toEqual(['Close']);await plugin.close();await host.close();
  host=new InteractionEngine({persistence:new SqliteStore(join(dir,'engine'))});plugin=new ExplorerPlugin(host,new ExplorerStore(path),providers);plugin.start(task.id);await plugin.waitForIdle();const after=plugin.view(task.id);
  expect(host.observation(sid).instanceScope).not.toBe(priorInstance);expect(after.task.rounds).toHaveLength(1);expect(after.task.status,JSON.stringify(after.task)).toBe('completed');expect(host.list<any>(sid,'attempt').map(a=>a.action.label)).toEqual(['Close','Close','Sibling']);
  expect(after.task.usage.actions).toBe(3);expect(after.task.usage.modelRequests).toBeGreaterThan(before.task.usage.modelRequests);expect(after.events.some(e=>e.type==='round.reattached'&&(e.data as any).attemptCacheReset)).toBe(true);
 }finally{await plugin.close();await host.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
it.each([false,true])('isolates an unknown hyperlink without replaying it, including a host time limit: %s',async(timeLimit)=>{
 const f=await explorerFixture('<a href="?destination=1">Details</a><button type="button" onclick="this.disabled=true">Independent</button>'+(timeLimit?'<button type="button" onclick="this.disabled=true">Independent two</button>':'')),expired=new Set<string>();
 const providers=fakeProviders(f.url),original=providers.jev.decide;let unknownId:string|undefined;let links=0;const path=join(f.dir,'plugin.sqlite');
 providers.jev.decide=async(r,s)=>{if(r.purpose==='next-action'){const link=Object.entries(r.options!).find(([,a])=>(a as any).label==='Details');if(link)return {model:'mock',value:link[0],confidence:1};}return original(r,s);};
 const host=new Proxy(f.host,{get(target,key){if(key==='execute')return async(...args:Parameters<typeof target.execute>)=>{const a=await target.execute(...args);if(a.action.label==='Details'){links++;unknownId=a.id;const unknown={...a,status:'unknown' as const};target.store.put('attempt',unknown);return unknown;}if(timeLimit)expired.add(args[0]);return a;};if(key==='session')return(sid:string)=>{const s=target.session(sid);return expired.has(sid)?{...s,elapsedMs:s.options.maxDurationMs}:s;};if(key==='list')return (sid:string,kind:string)=>target.list<any>(sid,kind).map(x=>kind==='attempt'&&x.id===unknownId?{...x,status:'unknown'}:x);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 let plugin=new ExplorerPlugin(host,new ExplorerStore(path),providers);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:3,actions:10,modelRequests:100}});plugin.start(t.id);await plugin.waitForIdle();let view=plugin.view(t.id);
 expect(links).toBe(1);expect(view.task.rounds).toHaveLength(timeLimit?3:2);expect(view.task.usage.actions).toBe(timeLimit?3:2);expect(view.task.unverifiedNavigations).toEqual([{sourceUrl:f.url,targetUrl:f.url+'?destination=1',evidence:expect.objectContaining({attemptId:unknownId,sessionId:view.task.rounds[0].sessionId})}]);
 expect(f.host.list<any>(view.task.rounds[1].sessionId,'attempt').map(a=>a.action.label)).toEqual(['Independent']);expect(view.task.status).not.toBe('completed');expect(view.task.pendingDispatch).toBeUndefined();expect(view.task.plan.some(i=>i.scope.label==='Details'&&i.status==='unresolved')).toBe(true);expect(view.events.some(e=>e.type==='navigation.isolated')).toBe(true);
 if(timeLimit){expect(f.host.list<any>(view.task.rounds[2].sessionId,'attempt').map(a=>a.action.label)).toEqual(['Independent two']);expect(view.events.some(e=>e.type==='round.session_limit')).toBe(true);}
 await plugin.close();plugin=new ExplorerPlugin(host,new ExplorerStore(path),providers);plugin.start(t.id);await plugin.waitForIdle();view=plugin.view(t.id);
 expect(links).toBe(1);expect(view.task.usage.actions).toBe(timeLimit?3:2);expect(view.task.unverifiedNavigations).toHaveLength(1);expect(view.task.status).not.toBe('completed');
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
it('grounds plans in accessible action names and records current members when retaining scopes',async()=>{
 const f=await explorerFixture('<button type="button" onclick="this.disabled=true">Alpha</button>');const p=fakeProviders(f.url);const original=p.jev.decide;
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
  if(r.purpose==='scope-review')throw new Error('Explicit target retention must not call a model');
  return original(r,s);
 };
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Click Alpha once',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const view=plugin.view(t.id),task=view.task;
 const retained=view.events.filter(e=>e.type==='scope.retained');expect(retained.length).toBeGreaterThan(0);expect(retained.every(e=>(e.data as any).groups.every((g:any)=>g.historicalMemberCount>=0))).toBe(true);
 for(const event of retained){const data=event.data as any,current=f.host.actions(event.sessionId!,data.sourceObservationId);expect(data.groups.every((g:any)=>g.actionIds.every((id:string)=>current.some(a=>a.id===id)))).toBe(true);}
 expect(task.status,JSON.stringify(task)).toBe('completed');expect(task.usage.actions).toBe(1);expect(task.plan.some(i=>i.reason==='sample_unselected')).toBe(false);
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

it('retains all in-scope members with a program decision when sampling is not authorized',async()=>{
 const f=await explorerFixture(),p=fakeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>{if(r.purpose==='scope-review')throw new Error('Fixed coverage must not call a model');return original(r,s);};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'All observed buttons',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
 expect(v.task.status,JSON.stringify(v.task)).toBe('completed');expect(v.task.usage.actions).toBe(2);expect(v.decisions.filter(d=>d.actor==='llm').map(d=>d.purpose)).toEqual(['initial-plan']);
 expect(v.decisions.filter(d=>d.purpose==='scope-review')).toHaveLength(0);expect(v.events.some(e=>e.actor==='program'&&e.type==='scope.retained'&&(e.data as any).executionAuthorized===false)).toBe(true);
 expect(v.task.plan.some(i=>i.reason==='sample_unselected'||i.reason==='scope_excluded')).toBe(false);
 }finally{await plugin.close();await f.close();}
});
it('retains multiple scopes atomically and retries a stale batch without marking members executed',async()=>{
 const f=await explorerFixture(['One','Two','Three'].map(name=>`<section aria-label="${name}"><h2>${name}</h2><button type="button" onclick="this.disabled=true">${name}</button></section>`).join(''));let rejected=false,maxBatch=0;
 const host=new Proxy(f.host,{get(target,key){if(key==='command')return async(sid:string,command:any)=>{if(command.type==='decideExplorationGroups'){maxBatch=Math.max(maxBatch,command.resolutions.length);if(!rejected){rejected=true;throw new ExplorerError('STALE_GROUP_DECISION');}}return target.command(sid,command);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(rejected).toBe(true);expect(maxBatch).toBeGreaterThan(1);expect(v.task.usage.actions).toBe(1);expect(v.task.status).toBe('budget_exhausted');
  expect(v.events.some(e=>e.type==='step.invalidated'&&(e.data as any).reason==='STALE_GROUP_DECISION')).toBe(true);expect(v.events.some(e=>e.type==='scope.retained')).toBe(true);
  expect(v.task.plan.some(i=>i.required&&i.status==='unresolved')).toBe(true);expect(v.decisions.some(d=>d.purpose==='scope-review')).toBe(false);
 }finally{await plugin.close();await f.close();}
});
it('keeps JEV sampling and action choices while omitting the historical ledger from their prompts',async()=>{
 const f=await explorerFixture('<select aria-label="Choice"><option>A</option><option>B</option><option>C</option></select>'),p=fakeProviders(f.url),original=p.jev.decide;let requests=0,selections=0;
 p.jev.decide=async(r,s)=>{if(['scope-review','next-action'].includes(r.purpose)){const state=(r.state as any).material;expect(state.plan).toHaveLength(1);expect(JSON.stringify(r.state)).not.toContain('historical-ledger-marker');expect(JSON.stringify(r.state).length).toBeLessThan(30000);if(r.purpose==='scope-review'){requests++;expect(state.allowedReductions).toEqual(['sample']);return {model:'mock',value:'sample',confidence:1};}selections++;for(const option of Object.values(r.options||{}) as any[])if(option.scope?.stableKey)expect(option.scope.stableKey).toMatch(/^sha256:[a-f0-9]{64}$/);}return original(r,s);};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,goal:'Representative choices',coverageMode:'representative',sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.revise(t.id,{items:[{title:'Choice scope',scope:{url:f.url},prerequisites:[],completion:'Verify selected choices',required:true,reason:'user scope'}]});
  const saved=plugin.store.task(t.id);for(let i=0;i<400;i++)saved.plan.push({id:`history-${i}`,title:'historical-ledger-marker',scope:{url:f.url,label:`Historical ${i}`},prerequisites:[],completion:'Unverified',required:i%2===0,dispatchScope:false,status:'untested',reason:'historical-ledger-marker',evidence:[],attempts:[]});plugin.store.save(saved);
  plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);expect(requests).toBeGreaterThan(0);expect(selections).toBeGreaterThan(0);expect(v.task.plan.some(i=>i.reason==='sample_unselected'&&i.status==='untested')).toBe(true);expect(v.task.plan.filter(i=>i.title==='historical-ledger-marker')).toHaveLength(400);
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
