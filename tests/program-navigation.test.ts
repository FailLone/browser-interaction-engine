import {expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createServer} from 'vite';
import {BrowserEngine,PlaywrightAdapter,programNavigationAllowed,programNavigationProbe,type Observation} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {explorerFixture} from './explorer-plugin-helpers.js';
import {pageOf} from './helpers.js';
import {bindGuardedReentryRoute} from '../scripts/okx-plugin-loop-acceptance.js';

async function delegatedFixture(reveals=true,initialPopup=false,changingDestination=false,dualEntry=false,recordRows=false,destinationNavigation=false,destinationUnknown=false){
 mkdirSync(resolve('.data'),{recursive:true});const dir=mkdtempSync(resolve('.data/program-menu-')),site=join(dir,'site');mkdirSync(site);
 writeFileSync(join(site,'index.html'),'<!doctype html><html><head><title>Navigation fixture</title></head><body><div id="root"></div><script type="module" src="/menu.jsx"></script></body></html>');
 writeFileSync(join(site,'menu.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';function App(){const [open,setOpen]=React.useState(false);const [notice,setNotice]=React.useState(${initialPopup}&&sessionStorage.getItem('skipNotice')!=='true');return <>{notice&&<div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.4)',zIndex:10}}><div role="dialog" aria-modal="true" tabIndex={0} aria-label="Service notice" style={{position:'absolute',left:300,top:150,width:400,padding:30,background:'white'}}><button type="button" role="tab" onClick={e=>{e.currentTarget.disabled=true}}>Read notice</button><div tabIndex={0}>Unresolved notice container<label><input type="checkbox" onChange={e=>sessionStorage.setItem("skipNotice",String(e.target.checked))}/>Do not show again</label><button type="button" onClick={()=>{throw Error('Unauthorized notice action')}}>Continue</button></div><button type="button" onClick={()=>setNotice(false)}>Close</button></div></div>}<header><nav>${recordRows?'<div tabIndex={0} aria-label="Navigation owner">':''}<div id="menu" ${dualEntry?'role="button" onClick={()=>setOpen(true)}':''} tabIndex={0} aria-label="Information menu" aria-expanded={open} aria-controls="links" onMouseEnter={()=>{${reveals?'setOpen(true)':''}}} onMouseLeave={()=>setOpen(false)} style={{position:'relative',width:220,padding:20,cursor:'pointer'}}>Information<div id="links" hidden={!open} style={{position:'absolute',top:'100%',left:0,width:220,background:'white',padding:10}}>${recordRows?'<ul aria-label="Information pages"><li><a href="/overview" onMouseEnter={e=>e.currentTarget.className="highlight"}>Overview</a></li><li><a href="/details" onMouseEnter={e=>e.currentTarget.className="highlight"}>Details</a></li></ul>':'<a href="/overview">Overview</a><br/><a href="/details">Details</a>'}</div></div>${recordRows?'</div>':''}</nav></header><main>{${reveals}&&<button role="tab" onClick={e=>{e.currentTarget.disabled=true}}>Unrelated view</button>}<canvas/>${recordRows?'<div tabIndex={0}>Unrelated twin</div><div tabIndex={0}>Unrelated twin</div>':''}<div tabindex="0" aria-label="Unresolved unrelated">Unknown</div></main></>};createRoot(document.getElementById('root')).render(<App/>);`);
 const pages=(req:any,res:any,next:()=>void)=>{if(['/overview','/details'].includes(req.url||'')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Overview</title></head><body><h1>Public overview</h1><canvas></canvas>'+(destinationNavigation?'<nav aria-label="Destination navigation"><details><summary>Destination menu</summary><a href="/details">Destination details</a></details></nav>':'')+(destinationUnknown?'<form><div role="slider" tabindex="0" aria-label="Unresolved slider" aria-labelledby="missing-label">Unresolved slider</div></form>':'')+(changingDestination?'<form><input aria-label="Changing quote" id="changing"></form><script>setInterval(()=>document.querySelector("#changing").value=String(Date.now()),10)</script>':'')+'</body></html>');}else next();};
 const server=await createServer({configFile:false,root:site,plugins:[{name:'fixture-public-pages',configureServer(server){server.middlewares.use(pages);}}],server:{host:'127.0.0.1',port:0},logLevel:'silent'});await server.listen();
 const url=server.resolvedUrls!.local[0],host=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine'))});
 return {url,host,close:async()=>{await host.close();await server.close();rmSync(dir,{recursive:true,force:true});}};
}
const contract=(url:string)=>({version:1 as const,mode:'exhaustive' as const,programNavigation:'public-navigation-v1' as const,roots:[{url}],routes:[{origin:new URL(url).origin,pathnamePattern:'^/(overview|details)$',scope:{}}],exclusions:[],allowedOperations:['click','hover','focus','history']});

it('prepares and explores ready destination navigation before returning to retained source work on a changing page',async()=>{
 const f=await delegatedFixture(true,false,true,true,false,true,true),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,{});
 try{
  const task=plugin.create({url:f.url,coverageContract:contract(f.url),sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:100,observeTimeoutMs:1000},budget:{rounds:1,actions:10,durationMs:25000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);
  const final=store.task(task.id),attempts=final.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  const menu=attempts.findIndex(a=>a.action.label==='Destination menu'&&a.status==='succeeded'),returned=attempts.findIndex(a=>a.action.kind==='history');
  expect(menu,JSON.stringify({reason:final.reason,attempts:attempts.map(a=>[a.action.label,a.status,a.reason])})).toBeGreaterThan(0);
  expect(returned,JSON.stringify(attempts.map(a=>[a.action.label,a.status]))).toBeGreaterThan(menu);
  const before=f.host.observation(attempts[menu].sessionId,attempts[menu].beforeId);expect(before.url).toBe(new URL('/overview',f.url).href);
  expect(before.stable).toBe(false);expect(before.controls.find(c=>c.name==='Changing quote')?.readiness?.status).toBe('unstable');
  expect(attempts.some(a=>a.action.label==='Destination details'&&a.status==='succeeded')).toBe(true);
  expect(store.events(task.id).some(e=>e.type==='navigation.local_opportunity')).toBe(true);
  const opportunities=store.events(task.id).filter(e=>e.type==='navigation.local_opportunity').map(e=>(e.data as any).scopeKey);
  expect(new Set(opportunities).size).toBe(opportunities.length);
  expect(final.plan.some(i=>i.required&&i.scope.label==='Unresolved slider'&&i.status!=='succeeded')).toBe(true);
  expect(store.decisions(task.id)).toEqual([]);expect(final.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('continues the original recorded entry after native source return before a fresh alternative trigger or background action',async()=>{
 const f=await delegatedFixture(true,false,true,true),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,{});
 try{
  const task=plugin.create({url:f.url,coverageContract:contract(f.url),sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:120,observeTimeoutMs:800},budget:{rounds:1,actions:12,durationMs:30000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);
  const final=store.task(task.id),sid=final.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt'),events=store.events(task.id);
  const returned=attempts.findIndex(a=>a.action.kind==='history');expect(returned).toBeGreaterThan(0);
  expect(attempts[0].action.kind).toBe('click');
  const entry=attempts[returned+1];expect(entry.action.label).toBe('Information menu');expect(entry.action.kind).toBe('click');expect(entry.status).toBe('succeeded');
  expect(events.find(e=>e.type==='action.scheduled'&&(e.data as any).requestId===entry.requestId)?.data).toMatchObject({purpose:'prerequisite',actionId:entry.action.id});
  expect(events.some(e=>e.type==='recovery.continuation_selected')).toBe(true);
  const proposal=events.find(e=>e.type==='branch.reentry_planned')?.data as any;
  expect(proposal?.target.label).toBe('Details');
  const original=final.plan.find(i=>i.id===proposal.itemId)!;expect(original.status).toBe('succeeded');
  const child=attempts.find(a=>a.id===original.resolvedBy?.attemptId);expect(child?.action.label).toBe('Details');expect(child?.status).toBe('succeeded');
  expect(child.id).not.toBe(entry.id);expect(original.conditionCompletion?.status).toBe('verified');
  expect(store.decisions(task.id)).toEqual([]);expect(final.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('retains the real reveal source and continues a rebuilt list child after later preparation observations',async()=>{
 const f=await delegatedFixture(true,false,true,true,true),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,{});
 let pendingAtChild=0;const execute=f.host.execute.bind(f.host);f.host.execute=async(...args)=>{const action=f.host.actions(args[0]).find(a=>a.id===args[1]);if(action?.kind==='click'&&action.label==='Details')pendingAtChild=f.host.list<any>(args[0],'hypothesis').filter(h=>h.status==='pending').length;return execute(...args);};
 try{
  const task=plugin.create({url:f.url,coverageContract:contract(f.url),sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:120,observeTimeoutMs:800},budget:{rounds:1,actions:14,durationMs:30000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);
  const final=store.task(task.id),sid=final.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt'),events=store.events(task.id);
  writeFileSync(resolve('.data/program-first/list-chain-diagnostic.json'),JSON.stringify({task:final,attempts,events,observations:f.host.list(sid,'observation')}));
  const planned=events.find(e=>e.type==='branch.reentry_planned')!,proposal=planned?.data as any;
  expect(proposal,final.reason).toBeDefined();
  const original=final.plan.find(i=>i.id===proposal.itemId)!;
  const scheduled=events.find(e=>e.sequence>planned.sequence&&e.type==='action.scheduled'&&(e.data as any).purpose==='prerequisite')!;
  const entry=attempts.find(a=>a.requestId===(scheduled.data as any).requestId)!;
  const binding=bindGuardedReentryRoute(original,{planned:proposal,sequence:planned.sequence,sessionId:planned.sessionId,observationId:planned.observationId},sid,entry.action.id,entry.beforeId,{observation:f.host.observation.bind(f.host),actions:f.host.actions.bind(f.host),interactionTransition:f.host.interactionTransition.bind(f.host),attempt:(_sid,id)=>attempts.find(a=>a.id===id)});
  expect(binding).toMatchObject({available:true});
  if(!binding.available)throw Error(binding.reason);
  expect(original.status,JSON.stringify({reason:final.reason,original,attempts:attempts.map(a=>({kind:a.action.kind,label:a.action.label,status:a.status}))})).toBe('succeeded');
  const child=attempts.find(a=>a.id===original.resolvedBy?.attemptId)!;
  expect(pendingAtChild).toBeGreaterThan(0);
  expect(child.id).not.toBe(entry.id);expect(child.action.kind).toBe('click');expect(original.conditionCompletion?.status).toBe('verified');
  expect(f.host.explorationTargetCorrespondences(sid,{observationId:child.beforeId,requests:[{actionId:child.action.id,source:binding.binding.source}]}).results[0]).toMatchObject({equivalent:true,identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  const source=f.host.observation(sid,proposal.route.at(-1).evidence.observationId),current=f.host.observation(sid,child.beforeId);
  const old=source.controls.find(c=>c.name===child.action.label&&c.tag==='a')!,fresh=current.controls.find(c=>c.localId===child.action.localId)!;
  expect(old.identityScope).toBe('instance');expect(fresh.identityScope).toBe('instance');expect(old.stableKey).not.toBe(fresh.stableKey);expect(source.documentId).not.toBe(current.documentId);
  expect(original.evidence.some(e=>e.observationId!==source.id&&!e.attemptId)).toBe(true);
  expect(events.some(e=>e.type==='branch.children_retained'&&(e.data as any).itemIds.includes(original.id))).toBe(true);
  expect(store.decisions(task.id)).toEqual([]);
 }finally{await plugin.close();await f.close();}
});

it.each([false,true,'preference','changing-destination'] as const)('opens a real delegated menu and resumes its original child with no configured models (initial popup: %s)',async initialPopup=>{
 const f=await delegatedFixture(true,!!initialPopup,initialPopup==='changing-destination'),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,{});
 try{
  const task=plugin.create({url:f.url,coverageContract:{...contract(f.url),...(initialPopup==='preference'?{noticePreferences:['Do not show again'],allowedOperations:[...contract(f.url).allowedOperations,'check']}:{})},sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:initialPopup==='changing-destination'?120:0,observeTimeoutMs:800},budget:{rounds:1,actions:14,durationMs:30000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),sid=final.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
  if(initialPopup==='changing-destination')writeFileSync(resolve('.data/program-first/changing-destination-diagnostic.json'),JSON.stringify({task:final,attempts,events:store.events(task.id),observations:f.host.list(sid,'observation')}));
  if(initialPopup){expect(attempts.find(a=>a.action.kind==='click')?.action.label,JSON.stringify({reason:final.reason,attempts})).toBe('Read notice');expect(attempts[0].status).toBe('succeeded');expect(attempts.some(a=>a.action.label==='Continue')).toBe(false);expect(attempts.filter(a=>a.action.kind==='check')).toHaveLength(initialPopup==='preference'?1:0);if(initialPopup==='preference'){expect(attempts.findIndex(a=>a.action.kind==='check')).toBeGreaterThan(attempts.findIndex(a=>a.action.label==='Read notice'));expect(attempts.findIndex(a=>a.action.label==='Close')).toBeGreaterThan(attempts.findIndex(a=>a.action.kind==='check'));expect(attempts.filter(a=>a.action.label==='Close')).toHaveLength(1);expect(f.host.observation(sid,attempts.find(a=>a.action.kind==='check').afterId).controls.find(c=>c.name==='Do not show again')?.checked).toBe(true);expect(final.plan.some(i=>i.required&&i.status!=='succeeded'&&i.scope.label==='Continue')).toBe(true);}expect(final.status).not.toBe('configuration_required');}
  const navigationAttempts=attempts.filter(a=>a.action.boundary?.intent!=='exit'&&a.action.kind!=='check'&&a.action.label!=='Read notice');
  expect(navigationAttempts.slice(0,2).map(a=>[a.action.kind,a.status]),JSON.stringify({reason:final.reason,events:store.events(task.id).slice(-5)})).toEqual([['hover','succeeded'],['click','succeeded']]);
  const [hover,navigation]=navigationAttempts;expect(hover.action.source).toBe('program-navigation-observation');expect(hover.action.risk).toBe('unknown');expect(hover.effectsAssessment).toBe('not-assessed');
  expect(f.host.observation(sid,hover.beforeId).controls.find(c=>c.name==='Overview')?.visible).not.toBe(true);
  expect(f.host.observation(sid,hover.afterId).controls.find(c=>c.name==='Overview')?.visible).toBe(true);
  expect(f.host.observation(sid,navigation.afterId).url).toBe(new URL('/overview',f.url).href);
  expect(attempts.some(a=>a.action.kind==='click'&&a.action.label==='Details'&&a.status==='succeeded'),JSON.stringify({reason:final.reason,attempts:attempts.map(a=>({kind:a.action.kind,label:a.action.label,status:a.status,repetition:a.repetitionSource})),events:store.events(task.id).slice(-5)})).toBe(true);
  expect(attempts.some(a=>a.action.kind==='hover'&&a.repetitionSource&&a.status==='succeeded')).toBe(true);
  expect(store.decisions(task.id)).toEqual([]);expect(final.status).not.toBe('completed');
  if(initialPopup==='changing-destination'){
   expect(store.events(task.id).some(e=>e.type==='review.deferred_for_source_return')).toBe(true);
   expect(f.host.observation(sid,navigation.afterId).stable).toBe(false);
   expect(f.host.observation(sid,navigation.afterId).controls.find(c=>c.name==='Changing quote')?.readiness?.status).toBe('unstable');
   expect(attempts.some(a=>a.action.label==='Changing quote')).toBe(false);
  }
  expect(final.plan.some(i=>i.required&&i.reason==='missing_capability:UNSUPPORTED_CANVAS')).toBe(true);
  const repeated=attempts.find(a=>a.repetitionSource)!;expect(repeated.action.replayable).toBe(false);expect(repeated.effectsAssessment).toBe('not-assessed');
  writeFileSync(resolve(initialPopup==='preference'?'.data/program-first/preference-chain-proof.json':initialPopup?'.data/program-first/popup-chain-proof.json':'.data/stage2-program-navigation-proof.json'),JSON.stringify({diagnosticOnly:true,notOKXAcceptance:true,task:final,attempts,events:store.events(task.id),observations:f.host.list(sid,'observation'),decisions:store.decisions(task.id)},null,2));
 }finally{await plugin.close();await f.close();}
});

it('executes a native details menu without a semantic review',async()=>{
 const f=await explorerFixture('<nav><details><summary>Menu</summary><a href="/overview">Overview</a></details></nav><canvas/>'),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,{});
 try{
  const task=plugin.create({url:f.url,coverageContract:contract(f.url),sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true},budget:{rounds:1,actions:2,durationMs:15000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),attempts=final.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(attempts.some(a=>a.action.label==='Menu'&&a.status==='succeeded'),final.reason).toBe(true);expect(store.decisions(task.id)).toEqual([]);expect(final.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it.each(['disabled','offline'] as const)('does not repeat a no-effect observation with models %s or fabricate an interface effect',async mode=>{
 const offline={name:'deliberately-offline',model:'none',decide:async()=>{throw new Error('PROVIDER_UNAVAILABLE_TEST');}};
 const f=await delegatedFixture(false),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,mode==='offline'?{jev:offline,llm:offline}:{});
 try{
  const task=plugin.create({url:f.url,coverageContract:contract(f.url),sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true},budget:{rounds:1,actions:5,durationMs:15000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),attempts=final.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(attempts.map(a=>a.action.kind),final.reason).toEqual(['hover']);expect(attempts[0].effectsAssessment).toBe('not-assessed');expect(final.status).not.toBe('completed');
  expect(final.plan.some(i=>i.required&&i.status!=='succeeded')).toBe(true);expect(final.status).not.toBe('configuration_required');
  expect(store.events(task.id).some(e=>e.type==='model.fallback_not_needed'&&(e.data as any).reason==='no_new_concrete_operation_gap')).toBe(true);
  expect(store.decisions(task.id)).toEqual([]);
 }finally{await plugin.close();await f.close();}
});

it('rejects unapproved, form, outside-route, stale and capability-dependent program candidates at actual dispatch',async()=>{
 const f=await explorerFixture('<nav><div id="dependent" tabindex="0" aria-label="Dependent menu" style="width:220px;height:80px">Menu<canvas width="10" height="10"></canvas></div><button id="business" type="button" onclick="window.businessWrites++">Purchase</button><a id="outside" href="https://example.org/">Outside</a><form><button id="submit">Submit</button></form></nav><script>window.businessWrites=0;document.getElementById("dependent").__reactProps$fixture={onMouseEnter(){}};</script>');
 try{
  const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',executionBoundary:{version:1,programNavigation:'public-navigation-v1',allowedOperations:['click','hover'],urls:[{url:f.url,match:'exact'}],exclusions:[]}}),o=f.host.observation(s.id),actions=f.host.actions(s.id);
  for(const name of ['Dependent menu','Purchase','Outside','Submit']){
   const action=actions.find(a=>a.label===name)!;expect(action,name).toBeDefined();
   await expect(f.host.execute(s.id,action.id,`reject-${name}`,undefined,{observationId:o.id,profile:'observed-ui-exploration'})).rejects.toHaveProperty('code');
  }
  expect(f.host.list(s.id,'attempt')).toEqual([]);expect(await pageOf(f.host).evaluate(()=>(window as any).businessWrites)).toBe(0);
  const c=o.controls.find(c=>c.name==='Dependent menu')!,probe=programNavigationProbe(c,o,'hover');
  expect(programNavigationAllowed(undefined,probe,o)).toBe(false);
  const boundary=f.host.session(s.id).options.executionBoundary!;
  expect(programNavigationAllowed({...boundary,allowedOperations:['click']},probe,o)).toBe(false);
  expect(programNavigationAllowed({...boundary,exclusions:[{label:c.name}]},probe,o)).toBe(false);
  expect(programNavigationAllowed(boundary,{...probe,observationId:'old'},o)).toBe(false);
  const noOwn:Observation={...o,controls:o.controls.map(x=>x===c?{...x,interactionHints:[]}:x)};
  expect(programNavigationAllowed(boundary,probe,noOwn)).toBe(false);
 }finally{await f.close();}
});

it('revalidates current event evidence instead of retaining a program observation grant after metadata removal',async()=>{
 const f=await delegatedFixture();
 try{
  const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',executionBoundary:{version:1,programNavigation:'public-navigation-v1',allowedOperations:['hover'],urls:[{url:f.url,match:'exact'}],exclusions:[]}}),o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.kind==='hover')!;
  expect(a.source).toBe('program-navigation-observation');
  await pageOf(f.host).evaluate(()=>{const el=document.querySelector('#menu')!;const key=Object.getOwnPropertyNames(el).find(k=>k.startsWith('__reactProps$'))!;(el as any)[key]={...(el as any)[key],onMouseEnter:undefined};if((el as any)[key].onMouseEnter!==undefined)throw Error('fixture mutation did not apply');});
  await expect(f.host.execute(s.id,a.id,'stale-program-event',undefined,{observationId:o.id,profile:'observed-ui-exploration'})).rejects.toMatchObject({code:'STALE_OBSERVATION'});
  expect(f.host.session(s.id).actionCount).toBe(0);expect(f.host.list(s.id,'attempt')).toEqual([]);
 }finally{await f.close();}
});

it.each(['unlisted','outside','form','blocked'] as const)('does not expand notice preference authority to %s controls',async mode=>{
 const checkbox='<input id="preference" type="checkbox" aria-label="Do not show again">';
 const body=mode==='outside'?checkbox:`<div role="dialog" aria-modal="true" tabindex="0">${mode==='form'?`<form>${checkbox}</form>`:checkbox}</div>`;
 const f=await explorerFixture(body);
 try{
  const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',executionBoundary:{version:1,programNavigation:'public-navigation-v1',noticePreferences:mode==='unlisted'?[]:['Do not show again'],urls:[{url:f.url,match:'exact'}],allowedOperations:['check'],exclusions:[]}});
  if(mode==='blocked'){await pageOf(f.host).evaluate(()=>{const cover=document.createElement('div');Object.assign(cover.style,{position:'fixed',inset:'0',zIndex:'1000',background:'white'});document.body.append(cover);});await f.host.observe(s.id);}
  const o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.kind==='check')!;
  await expect(f.host.execute(s.id,a.id,`forbidden-${mode}`,undefined,{observationId:o.id,profile:'observed-ui-exploration'})).rejects.toHaveProperty('code');
  expect(await pageOf(f.host).locator('#preference').isChecked()).toBe(false);expect(f.host.list(s.id,'attempt')).toEqual([]);
 }finally{await f.close();}
});

it('finishes executable inner-modal work beyond the background quota, retains blocked duties and exits outward without models',async()=>{
 const children=Array.from({length:5},(_,i)=>`<button role="tab" onclick="this.disabled=true">Inner ${i}</button>`).join('');
 const f=await explorerFixture(`<button role="tab" onclick="this.disabled=true">Background</button><div id="outer" role="dialog" aria-modal="true" aria-label="Outer notice" tabindex="0" style="position:fixed;inset:40px;background:white"><button role="tab" onclick="this.disabled=true">Outer work</button><button onclick="document.querySelector('#outer').remove()">Close outer</button><div id="inner" role="dialog" aria-modal="true" aria-label="Inner notice" tabindex="0" style="position:fixed;inset:80px;background:white;z-index:10">${children}<button disabled>Unavailable</button><button onclick="window.unapproved=true">Unapproved</button><button onclick="document.querySelector('#inner').remove()">Close inner</button></div></div>`),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,{});
 try{
  const task=plugin.create({url:f.url,coverageContract:contract(f.url),sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:0,observeTimeoutMs:500},budget:{rounds:1,actions:12,durationMs:20000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),attempts=final.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(attempts.map(a=>a.action.label),final.reason).toEqual(['Inner 0','Inner 1','Inner 2','Inner 3','Inner 4','Close inner','Outer work','Close outer','Background']);
  expect(attempts.every(a=>a.status==='succeeded')).toBe(true);expect(store.decisions(task.id)).toEqual([]);
  expect(final.plan.some(i=>i.required&&i.scope.label==='Unapproved'&&i.status!=='succeeded')).toBe(true);expect(final.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('prepares the active notice before background navigation on a continuously changing page',async()=>{
 const html='<header><nav aria-label="Public navigation"><details><summary>Background menu</summary><a href="/overview">Overview</a></details></nav></header><form><input id="quote" aria-label="Changing quote"></form><div style="position:fixed;inset:0;background:#fff9;z-index:5"><div role="dialog" aria-modal="true" aria-label="Notice" style="position:absolute;top:100px;left:100px;background:white;padding:20px"><label><input id="remember" type="checkbox">Remember notice</label><button type="button" onclick="this.parentElement.parentElement.remove()">Close</button></div></div><script>setInterval(()=>document.querySelector("#quote").value=String(Date.now()),10)</script>';
 const f=await explorerFixture(html),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,{});
 try{
  const task=plugin.create({url:f.url,coverageContract:{...contract(f.url),noticePreferences:['Remember notice'],allowedOperations:['check','click','hover','history']},sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:100,observeTimeoutMs:1000},budget:{rounds:1,actions:2,durationMs:15000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);
  const final=store.task(task.id),attempts=final.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(attempts.map(a=>[a.action.label,a.action.kind,a.status])).toEqual([['Remember notice','check','succeeded'],['Close','click','succeeded']]);
  const before=f.host.observation(attempts[0].sessionId,attempts[0].beforeId);expect(before.stable).toBe(false);expect(before.boundaries).toHaveLength(1);
  expect(f.host.observation(attempts[0].sessionId,attempts[0].afterId).controls.find(c=>c.name==='Remember notice')?.checked).toBe(true);
  const closeBefore=f.host.observation(attempts[1].sessionId,attempts[1].beforeId),after=f.host.observation(attempts[1].sessionId,attempts[1].afterId),adapter=new PlaywrightAdapter();
  expect(after.boundaryExitCapture?.samples).toBeGreaterThanOrEqual(2);expect(after.controls.find(c=>c.name==='Changing quote')?.readiness?.status).toBe('unstable');
  for(const change of ['not-closed','wrong-parent','wrong-document','wrong-url','wrong-context','critical-gap','missing-proof','one-sample'] as const){
   const altered=structuredClone(after);
   if(change==='not-closed')altered.boundaries=closeBefore.boundaries;if(change==='wrong-parent')altered.boundaries=[{key:'other'} as any];
   if(change==='wrong-document')altered.documentId='other';if(change==='wrong-url')altered.url+='other';
   if(change==='wrong-context')altered.context={changed:{value:'other',status:'known',source:'test'}};
   if(change==='critical-gap')altered.gaps.push({code:'READ_FAILED',message:'Incomplete',critical:true});
   if(change==='missing-proof')delete altered.boundaryExitCapture;if(change==='one-sample')altered.boundaryExitCapture!.samples=1;
   expect(adapter.actionObservationReady(attempts[1].action,closeBefore,altered),change).toBe(false);
  }
  expect(final.plan.some(i=>i.required&&i.status!=='succeeded'&&i.scope.label==='Changing quote')).toBe(true);
  expect(store.decisions(task.id)).toEqual([]);
 }finally{await plugin.close();await f.close();}
});
