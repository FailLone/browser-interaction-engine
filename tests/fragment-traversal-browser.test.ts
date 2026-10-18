import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {BrowserEngine,browserTraversalFragments,type ActionAttempt,type Observation} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {scopeFor,schedulingKeyFor} from '../packages/explorer-plugin/src/policy.js';
import type {PlanItem} from '@interaction/explorer-plugin';
import {pageOf} from './helpers.js';
import {explorerFixture} from './explorer-plugin-helpers.js';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {initialFragmentLedger,registerFragmentObservation,recordFragmentOutcome,fragmentActionEvidence,preferFragmentCandidate,fragmentStateOrder,revokeFragmentMappings,linkFragmentObligations,fragmentObligationSampled} from '../packages/explorer-plugin/src/fragment-traversal.js';

async function fixture(){
 const nav='<header><nav aria-label="Public navigation"><details id="menu"><summary>Menu</summary><a href="/b">Overview</a><a href="/detail">Original detail</a></details></nav></header>';
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Fragments</title></head><body>'+(['/','/b'].includes(req.url||'')?nav:'')+(req.url==='/b'?'<main><a href="/c">Unique destination</a></main>':'')+'<canvas></canvas></body></html>');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 const dir=mkdtempSync(join(tmpdir(),'fragment-browser-')),host=new BrowserEngine({persistence:new SqliteStore(join(dir,'engine'))});
 return {url,dir,host,close:async()=>{await host.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}};
}
const options=(url:string)=>({url,coveragePolicy:'finite-ui-v1' as const,executionPolicy:'observed-ui' as const,headless:true,settleMs:50,observeTimeoutMs:1200,
 executionBoundary:{version:1 as const,programNavigation:'public-navigation-v1' as const,allowedOperations:['click','hover','focus','history'],urls:[{origin:new URL(url).origin,pathnamePattern:'^/.*$',match:'route' as const}],exclusions:[]}});
it('imports late mappings from actual receipts, survives serialization, and rejects changed guards and unknown receipts',async()=>{
 const f=await fixture();try{
  const s=await f.host.createSession(options(f.url)),a=f.host.observation(s.id),actions=f.host.actions(s.id),l=initialFragmentLedger();
  const front=registerFragmentObservation(l,a,actions,'authority',new Set(actions.map(a=>a.id))),menu=actions.find(a=>a.label==='Menu'&&a.kind==='click')!;
  writeFileSync(resolve('.data/broader-ui/fragment-capture-debug.json'),JSON.stringify({a,actions}));
  expect(front.byAction.has(menu.id),JSON.stringify(browserTraversalFragments(a,actions,'authority'))).toBe(true);
  const attempt=await f.host.execute(s.id,menu.id,'real-menu',undefined,{observationId:a.id,profile:'observed-ui-exploration'});
  expect(attempt.status).toBe('succeeded');expect(recordFragmentOutcome(l,front,attempt)).toBe(true);expect(recordFragmentOutcome(l,front,attempt)).toBe(false);
  const item:PlanItem={id:'explicit-revision-case',title:'Pending',scope:scopeFor(menu,a),prerequisites:[],completion:'real receipt',required:true,status:'pending',reason:'observed_in_scope',dispatchScope:false,evidence:[{sessionId:a.sessionId,observationId:a.id}],attempts:[],operationConditionKey:schedulingKeyFor(menu,a)};
  linkFragmentObligations(l,front,a,actions,[item]);expect(fragmentObligationSampled(l,item)).toBe(true);
  const revised=structuredClone(l);registerFragmentObservation(revised,a,actions,'explicitly-revised-authority',new Set(actions.map(a=>a.id)));
  expect(fragmentObligationSampled(revised,item)).toBe(false);expect(item.status).toBe('pending');expect(item.resolvedBy).toBeUndefined();
  const opened=f.host.observation(s.id),next=f.host.actions(s.id).find(a=>a.label==='Overview'&&a.kind==='click')!;
  await f.host.execute(s.id,next.id,'real-next',undefined,{observationId:opened.id,profile:'observed-ui-exploration'});
  const b=f.host.observation(s.id),ba=f.host.actions(s.id),warm=registerFragmentObservation(l,b,ba,'authority',new Set(ba.map(a=>a.id))),bm=ba.find(a=>a.label==='Menu'&&a.kind==='click')!;
  expect(fragmentActionEvidence(l,warm,bm.id)).toMatchObject({pruned:true,originAttemptIds:[attempt.id],coverageGranted:false});
  const onceBounded=structuredClone(l);onceBounded.bounded=true;
  const later=registerFragmentObservation(onceBounded,{...b,url:new URL('/later',b.url).href},ba,'authority',new Set(ba.map(a=>a.id)));
  expect(later.registered).toBeGreaterThan(0);expect(fragmentActionEvidence(onceBounded,later,bm.id)?.pruned).toBe(true);
  const cold=JSON.parse(JSON.stringify(l)),again=registerFragmentObservation(cold,b,ba,'authority',new Set(ba.map(a=>a.id)));
  expect(fragmentActionEvidence(cold,again,bm.id)).toEqual(fragmentActionEvidence(l,warm,bm.id));
  expect(preferFragmentCandidate(cold,again,ba.map(a=>({actionId:a.id})))).toEqual(preferFragmentCandidate(l,warm,ba.map(a=>({actionId:a.id}))));
  expect(fragmentStateOrder(cold,b)).toEqual(fragmentStateOrder(l,b));
  const restoredAccess=fragmentActionEvidence(cold,again,bm.id)!;revokeFragmentMappings(cold,restoredAccess.candidateId!,'explicit mismatch');expect(fragmentActionEvidence(cold,again,bm.id)?.pruned).toBe(false);
  expect(cold.events).toHaveLength(1);
  registerFragmentObservation(cold,{...b,url:new URL('/d',b.url).href},ba,'authority',new Set(ba.map(a=>a.id)));
  const afterRevocation=registerFragmentObservation(cold,b,ba,'authority',new Set(ba.map(a=>a.id)));
  expect(fragmentActionEvidence(cold,afterRevocation,bm.id)?.pruned).toBe(false);
  expect(recordFragmentOutcome(cold,again,{...attempt,id:'in-flight',beforeId:b.id,action:bm,status:'unknown',afterId:undefined})).toBe(false);
  const revoked=registerFragmentObservation(cold,b,ba,'changed-authority',new Set(ba.map(a=>a.id)));expect(fragmentActionEvidence(cold,revoked,bm.id)?.pruned).toBe(false);
  for(const change of ['destination','wrapper','reorder','options','mode','context','truncated'] as const){
    const changed=structuredClone(b),target=changed.controls.find(c=>c.localId===bm.localId)!;
    if(change==='destination')for(const region of changed.regionCandidates||[])for(const n of region.fragment?.nodes||[])if(n.attributes.href)n.attributes.href=new URL('/different',b.url).href;
    if(change==='wrapper')for(const region of changed.regionCandidates||[])if(region.fragment)region.fragment.nodes[1].path='./wrapper/'+region.fragment.nodes[1].path;
    if(change==='reorder')for(const region of changed.regionCandidates||[])region.fragment?.nodes.reverse();
    if(change==='options')target.options.push({value:'new',label:'new',disabled:false});
    if(change==='mode')target.pressed=true;
    if(change==='context')changed.context={variant:{status:'known',value:'B',source:'fixture'}} as Observation['context'];
    if(change==='truncated')target.classificationBinding={nodes:[],text:'',truncated:true};
    const changedFront=registerFragmentObservation(l,changed,ba,'authority',new Set(ba.map(a=>a.id)));
    expect(fragmentActionEvidence(l,changedFront,bm.id)?.pruned,change).not.toBe(true);
  }
  const missing=structuredClone(b);missing.controls.find(c=>c.localId===bm.localId)!.reviewBinding=undefined;
  expect(browserTraversalFragments(missing,ba,'authority').flatMap(f=>f.candidates).some(c=>c.actionId===bm.id)).toBe(false);
 }finally{await f.close();}
});
it('prunes the shared menu on B, executes its unique link, then actually restores and executes the original child',async()=>{
 const f=await fixture(),store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,{});try{
  const task=plugin.create({url:f.url,coverageContract:{version:1,mode:'exhaustive',programNavigation:'public-navigation-v1',roots:[{url:f.url}],routes:[{origin:new URL(f.url).origin,pathnamePattern:'^/.*$',scope:{}}],allowedOperations:['click','hover','focus','history'],exclusions:[]},
   sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:50,observeTimeoutMs:1200},budget:{rounds:1,actions:10,durationMs:35000}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),events=store.events(task.id),attempts=final.rounds.flatMap(r=>f.host.list<ActionAttempt>(r.sessionId,'attempt'));
  mkdirSync(resolve('.data/broader-ui'),{recursive:true});writeFileSync(resolve('.data/broader-ui/fragment-browser-proof.json'),JSON.stringify({task:final,events,attempts,observations:final.rounds.flatMap(r=>f.host.list<Observation>(r.sessionId,'observation'))}));
  expect(attempts.some(a=>a.action.label==='Unique destination'&&a.status==='succeeded'),final.reason).toBe(true);
  expect(attempts.filter(a=>a.action.label==='Menu'&&f.host.observation(a.sessionId,a.beforeId).url===new URL('/b',f.url).href)).toHaveLength(0);
  expect(events.some(e=>e.type==='fragment.frontier'&&(e.data as any).pruned.some((p:any)=>p.originAttemptIds.length))).toBe(true);
  const restored=attempts.find(a=>a.action.label==='Menu'&&a.repetitionSource);expect(restored).toBeDefined();expect(restored?.status).toBe('succeeded');
  const original=final.plan.find(i=>i.scope.label==='Original detail'&&i.resolvedBy?.attemptId);expect(original?.status,final.reason).toBe('succeeded');
  expect(original?.conditionCompletion?.status).toBe('verified');expect(original?.resolvedBy?.attemptId).not.toBe(restored?.id);
  expect(final.plan.some(i=>i.required&&i.status!=='succeeded')).toBe(true);expect(store.decisions(task.id)).toEqual([]);
 }finally{await plugin.close();await f.close();}
});

it('actually executes the same operation in two observed external modes without sharing access',async()=>{
 const f=await explorerFixture(`<aside><select id="mode" aria-label="Mode"><option>A</option><option>B</option></select></aside><nav><details id="apply" ontoggle="document.querySelector('output').textContent=document.querySelector('select').value"><summary>Apply</summary><p>Content</p></details></nav><output></output>`);
 try{
  const s=await f.host.createSession(options(f.url)),l=initialFragmentLedger(),receipts:ActionAttempt[]=[];
  for(const mode of ['A','B']){
   if(mode==='B'){await pageOf(f.host).evaluate(()=>{document.querySelector('select')!.value='B';document.querySelector('details')!.open=false;});await f.host.observe(s.id);}
   const o=f.host.observation(s.id),actions=f.host.actions(s.id),a=actions.find(a=>a.label==='Apply'&&a.kind==='click')!;
   const front=registerFragmentObservation(l,o,actions,'mode-authority',new Set(actions.map(a=>a.id)));
   expect(front.byAction.has(a.id)).toBe(true);expect(fragmentActionEvidence(l,front,a.id)?.pruned).toBe(false);
   const receipt=await f.host.execute(s.id,a.id,'mode-'+mode,undefined,{observationId:o.id,profile:'observed-ui-exploration'});receipts.push(receipt);
   expect(receipt.status).toBe('succeeded');expect(await pageOf(f.host).locator('output').textContent()).toBe(mode);expect(recordFragmentOutcome(l,front,receipt)).toBe(true);
  }
  expect(l.events.map(e=>e.id)).toEqual(receipts.map(a=>a.id));
 }finally{await f.close();}
});

it('declines oversized fragments while leaving native execution available',async()=>{
 const f=await explorerFixture('<nav aria-label="Large"><details><summary>Open</summary>'+('<span>child</span>'.repeat(260))+'</details></nav>');
 try{
  const s=await f.host.createSession(options(f.url)),o=f.host.observation(s.id),actions=f.host.actions(s.id),a=actions.find(a=>a.label==='Open')!;
  expect(browserTraversalFragments(o,actions,'authority')).toEqual([]);
  const receipt=await f.host.execute(s.id,a.id,'unmapped-native',undefined,{observationId:o.id,profile:'observed-ui-exploration'});expect(receipt.status).toBe('succeeded');
 }finally{await f.close();}
});
