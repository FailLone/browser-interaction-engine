import {expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createServer} from 'vite';
import {BrowserEngine,programNavigationAllowed,programNavigationProbe,type Observation} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {explorerFixture} from './explorer-plugin-helpers.js';
import {pageOf} from './helpers.js';

async function delegatedFixture(reveals=true){
 mkdirSync(resolve('.data'),{recursive:true});const dir=mkdtempSync(resolve('.data/program-menu-')),site=join(dir,'site');mkdirSync(site);
 writeFileSync(join(site,'index.html'),'<!doctype html><html><head><title>Navigation fixture</title></head><body><div id="root"></div><script type="module" src="/menu.jsx"></script></body></html>');
 writeFileSync(join(site,'menu.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';function App(){const [open,setOpen]=React.useState(false);return <><header><nav><div id="menu" tabIndex={0} aria-label="Information menu" aria-expanded={open} aria-controls="links" onMouseEnter={()=>{${reveals?'setOpen(true)':''}}} onMouseLeave={()=>setOpen(false)} style={{position:'relative',width:220,padding:20,cursor:'pointer'}}>Information<div id="links" hidden={!open} style={{position:'absolute',top:'100%',left:0,width:220,background:'white',padding:10}}><a href="/overview">Overview</a><br/><a href="/details">Details</a></div></div></nav></header><main><canvas/><div tabindex="0" aria-label="Unresolved unrelated">Unknown</div></main></>};createRoot(document.getElementById('root')).render(<App/>);`);
 const pages=(req:any,res:any,next:()=>void)=>{if(['/overview','/details'].includes(req.url||'')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Overview</title></head><body><h1>Public overview</h1><canvas/></body></html>');}else next();};
 const server=await createServer({configFile:false,root:site,plugins:[{name:'fixture-public-pages',configureServer(server){server.middlewares.use(pages);}}],server:{host:'127.0.0.1',port:0},logLevel:'silent'});await server.listen();
 const url=server.resolvedUrls!.local[0],host=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine'))});
 return {url,host,close:async()=>{await host.close();await server.close();rmSync(dir,{recursive:true,force:true});}};
}
const contract=(url:string)=>({version:1 as const,mode:'exhaustive' as const,programNavigation:'public-navigation-v1' as const,roots:[{url}],routes:[{origin:new URL(url).origin,pathnamePattern:'^/(overview|details)$',scope:{}}],exclusions:[],allowedOperations:['click','hover','focus','history']});

it('opens a real delegated menu and navigates to its newly revealed child with no configured models',async()=>{
 const f=await delegatedFixture(),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,{});
 try{
  const task=plugin.create({url:f.url,coverageContract:contract(f.url),sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:0,observeTimeoutMs:500},budget:{rounds:1,actions:10,durationMs:30000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),sid=final.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
  expect(attempts.slice(0,2).map(a=>[a.action.kind,a.status]),JSON.stringify({reason:final.reason,events:store.events(task.id).slice(-5)})).toEqual([['hover','succeeded'],['click','succeeded']]);
  const [hover,navigation]=attempts;expect(hover.action.source).toBe('program-navigation-observation');expect(hover.action.risk).toBe('unknown');expect(hover.effectsAssessment).toBe('not-assessed');
  expect(f.host.observation(sid,hover.beforeId).controls.find(c=>c.name==='Overview')?.visible).not.toBe(true);
  expect(f.host.observation(sid,hover.afterId).controls.find(c=>c.name==='Overview')?.visible).toBe(true);
  expect(f.host.observation(sid,navigation.afterId).url).toBe(new URL('/overview',f.url).href);
  expect(attempts.some(a=>a.action.kind==='click'&&a.action.label==='Details'&&a.status==='succeeded'),JSON.stringify({reason:final.reason,attempts:attempts.map(a=>({kind:a.action.kind,label:a.action.label,status:a.status,repetition:a.repetitionSource})),events:store.events(task.id).slice(-5)})).toBe(true);
  expect(attempts.some(a=>a.action.kind==='hover'&&a.repetitionSource&&a.status==='succeeded')).toBe(true);
  expect(store.decisions(task.id)).toEqual([]);expect(final.status).not.toBe('completed');
  expect(final.plan.some(i=>i.required&&i.reason==='missing_capability:UNSUPPORTED_CANVAS')).toBe(true);
  expect(store.events(task.id).some(e=>e.type==='model.fallback_needed')).toBe(true);
  const repeated=attempts.find(a=>a.repetitionSource)!;expect(repeated.action.replayable).toBe(false);expect(repeated.effectsAssessment).toBe('not-assessed');
  writeFileSync(resolve('.data/stage2-program-navigation-proof.json'),JSON.stringify({diagnosticOnly:true,notOKXAcceptance:true,task:final,attempts,events:store.events(task.id),observations:f.host.list(sid,'observation'),decisions:store.decisions(task.id)},null,2));
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
  expect(final.plan.some(i=>i.required&&i.status!=='succeeded')).toBe(true);
  const decisions=store.decisions(task.id);if(mode==='disabled')expect(decisions).toEqual([]);else {expect(decisions.length).toBeGreaterThan(0);expect(decisions.every(d=>!d.answer)).toBe(true);const events=store.events(task.id);expect(events.findIndex(e=>e.type==='action.dispatch')).toBeLessThan(events.findIndex(e=>e.type==='decision.requested'));}
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
