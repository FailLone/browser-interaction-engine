import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {BrowserEngine,browserComponentCorrespondence,PlaywrightAdapter,type ActionCandidate} from '@interaction/browser';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {SqliteStore} from '@interaction/storage-sqlite';
import {MemoryStore} from '@interaction/storage-memory';
import {hash} from '@interaction/core';
import {operationSourceCompletion} from '../packages/explorer-plugin/src/operation-source-completion.js';
import {scopeFor,schedulingKeyFor} from '../packages/explorer-plugin/src/policy.js';
import {ExplorerPlugin,ExplorerStore,providersFromEnv,type PlanItem} from '@interaction/explorer-plugin';
import {writeFileSync,mkdirSync} from 'node:fs';

async function fixture(durable=false,generated=false,nested=false){
 let version=0,variant="content";
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Catalog</title><header><nav aria-label="Catalog navigation"><ul aria-label="Categories"><li data-record="${variant==='record'?'other':'catalog'}"><a href="${variant==='destination'?'/catalog?account=other':'/catalog'}">Catalog</a><details ${variant==='mode'?'open':''}><summary ${generated?`id="more-${version}" aria-controls="contents-${version}"`:''}>More information</summary><div ${generated?`id="contents-${variant==='broken-reference'?'missing':version}"`:''}><p>${version&&variant!=='ids'?'Updated catalog description':'Catalog description'}</p>${nested?`<details><summary>Alpha</summary><p>${version?'Updated Alpha information':'Alpha information'}</p></details>`:'<a href="/alpha">Alpha</a>'}<a href="/beta">Beta</a>${version&&variant!=='ids'?'<a href="/gamma">Gamma</a>':''}</div></details></li><li><a href="/help">Help</a><details><summary>Support information</summary><p>Contact options</p><a href="/contact">Contact</a></details></li></ul></nav></header>`.replace(generated?/<\/?(?:ul|li)\b[^>]*>/g:/$^/g,''));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 const directory=resolve(`.data/component-correspondence/cold-browser-${Date.now()}`),engine=new BrowserEngine({persistence:durable?new SqliteStore(directory):new MemoryStore()});
 const options={url,headless:true,coveragePolicy:'finite-ui-v1' as const,executionPolicy:'observed-ui' as const,settleMs:25,observeTimeoutMs:500,exploration:'controls' as const,listExploration:'all' as const,
  executionBoundary:{version:1 as const,programNavigation:'public-navigation-v1' as const,urls:[{match:'route' as const,origin:new URL(url).origin,pathnamePattern:'^/.*$'}],exclusions:[],allowedOperations:['click','history']}};
 const session=await engine.createSession(options);
 return {engine,directory,session,url,options,change:(kind='content')=>{version++;variant=kind;},close:async()=>{await engine.close();await new Promise<void>(r=>server.close(()=>r()));}};
}
const target=(f:Awaited<ReturnType<typeof fixture>>,sid:string)=>f.engine.actions(sid).find(a=>a.label==='More information'&&a.kind==='click')!;
it('consumes complete program correspondence and preserves changed children as unexecuted work',async()=>{
 const f=await fixture();try{
  const source=target(f,f.session.id),before=f.engine.observation(f.session.id);
  await f.engine.stop(f.session.id);const next=await f.engine.createSession(f.options),action=target(f,next.id),current=f.engine.observation(next.id);
  const material=f.engine.componentCorrespondenceMaterial(next.id,{observationId:current.id,actionId:action.id,source:{sessionId:f.session.id,observationId:before.id,actionId:source.id}});
  expect(material,JSON.stringify({material,sourceControl:before.controls.find(c=>c.localId===source.localId),regions:before.regionCandidates?.map(r=>({id:r.id,nodes:r.fragment?.nodes.length}))})).toMatchObject({status:'same'});
  const proof=f.engine.explorationTargetCorrespondences(next.id,{observationId:current.id,requests:[{actionId:action.id,source:{sessionId:f.session.id,observationId:before.id,actionId:source.id}}]}).results[0];
  expect(proof.equivalent).toBe(true);expect(f.engine.list(next.id,'attempt')).toEqual([]);
  const receipt=await f.engine.execute(next.id,action.id,'program-component',undefined,{profile:'observed-ui-exploration',observationId:current.id});expect(receipt.status).toBe('succeeded');
  expect(f.engine.observation(next.id).controls.filter(c=>c.visible).map(c=>c.name)).toContain('Beta');
 }finally{await f.close();}
});
it('requires a pair-local answer for complete changed material, then relocates and executes while rejecting business changes',async()=>{
 const f=await fixture(true);try{
  const source=target(f,f.session.id),before=f.engine.observation(f.session.id);f.change();
  await f.engine.stop(f.session.id);const next=await f.engine.createSession(f.options),action=target(f,next.id),current=f.engine.observation(next.id);
  const input={observationId:current.id,actionId:action.id,source:{sessionId:f.session.id,observationId:before.id,actionId:source.id}};
  const material=f.engine.componentCorrespondenceMaterial(next.id,input);
  expect(material).toMatchObject({status:'uncertain'});
  const baseline=f.engine.explorationTargetCorrespondences(next.id,{observationId:current.id,requests:[input]}).results[0];
  expect(baseline.equivalent).toBe(false);
  f.engine.recordComponentCorrespondence(next.id,{...input,sourceMaterialKey:hash(material.sourceMaterial!),targetMaterialKey:hash(material.targetMaterial!),conditionKey:material.conditionKey!,evidence:['offline-test-pair-judgment']});
  const proof=f.engine.explorationTargetCorrespondences(next.id,{observationId:current.id,requests:[input]}).results[0];expect(proof.equivalent).toBe(true);expect(proof.evidence.some(x=>x.startsWith('external-component:'))).toBe(true);
  const item:PlanItem={id:'retained-original-child',title:source.label,scope:scopeFor(source,before),prerequisites:[],completion:'actual original child',status:'unresolved',reason:'observed_in_scope',required:true,dispatchScope:false,operationConditionPolicy:'browser-operation-key-v3',operationConditionKey:schedulingKeyFor(source,before),evidence:[{sessionId:before.sessionId,observationId:before.id}],attempts:[]};
  const association=operationSourceCompletion(f.engine).prepareAssociation(item,action);expect(association).toBeDefined();
  const receipt=await f.engine.execute(next.id,action.id,'external-component',undefined,{profile:'observed-ui-exploration',observationId:current.id});expect(receipt.status).toBe('succeeded');
  expect(f.engine.observation(next.id).controls.filter(c=>c.visible).map(c=>c.name)).toContain('Gamma');
  const complete=operationSourceCompletion(f.engine,receipt);expect(complete.associate(item,receipt,association)).toBe(true);
  const ref={sessionId:receipt.sessionId,observationId:receipt.afterId!,attemptId:receipt.id};item.evidence.push(ref);item.attempts.push({roundId:'fixture-round',outcome:receipt.status,evidence:ref,sourceAssociation:association});item.resolvedBy=ref;
  expect(complete(item)).toBe(true);
  const unbound=structuredClone(item);delete unbound.attempts[0].sourceAssociation;expect(complete(unbound)).toBe(false);
  const unrelated=structuredClone(item);unrelated.evidence.unshift({sessionId:current.sessionId,observationId:current.id});expect(complete(unrelated)).toBe(false);
  writeFileSync(f.directory+'/original-item.json',JSON.stringify(item));await f.engine.close();
  const cold=JSON.parse(execFileSync(process.execPath,['--import','tsx','--conditions=development','docs/experiments/component-correspondence-2026-10-18/cold-receipt.ts',f.directory,f.directory+'/original-item.json'],{encoding:'utf8'}));expect(cold.completed).toBe(true);expect(cold.pid).not.toBe(process.pid);
  // This is an offline adapter/SDK test, not evidence of a real model's accuracy.
 }finally{await f.close();}
});

it.each(['record','destination','mode','broken-reference'])('rejects changed %s even when labels and layout are similar',async(kind)=>{
 const f=await fixture(false,kind==='broken-reference');try{const source=target(f,f.session.id),before=f.engine.observation(f.session.id);f.change(kind);await f.engine.stop(f.session.id);
  const next=await f.engine.createSession(f.options),action=target(f,next.id),current=f.engine.observation(next.id),input={observationId:current.id,actionId:action.id,source:{sessionId:before.sessionId,observationId:before.id,actionId:source.id}};
  const material=f.engine.componentCorrespondenceMaterial(next.id,input);expect(['conflict','unavailable']).toContain(material.status);
  expect(()=>f.engine.recordComponentCorrespondence(next.id,{...input,sourceMaterialKey:'fabricated',targetMaterialKey:'fabricated',conditionKey:'fabricated',evidence:['yes']})).toThrow();
 }finally{await f.close();}
});

it.each([false,true])('the plugin completes the original child with changed material=%s',async(changed)=>{
 const f=await fixture(false,false,true),store=new ExplorerStore(':memory:');
 const real=process.env.COMPONENT_REAL_PROVIDER==='1';let questions=0;
 const providers=!changed?{}:real?providersFromEnv():{jev:{name:'offline',model:'fixture',decide:async(request:any)=>{questions++;expect(request.purpose).toBe('component-correspondence');return {value:true,probability:.99,model:'offline'};}}};
 const plugin=new ExplorerPlugin(f.engine,store,providers);
 try{
  const entry=target(f,f.session.id);await f.engine.execute(f.session.id,entry.id,'discover-original-child',undefined,{profile:'observed-ui-exploration',observationId:entry.observationId});
  const source=f.engine.actions(f.session.id).find(a=>a.label==='Alpha'&&a.kind==='click')!,before=f.engine.observation(f.session.id);if(changed)f.change();await f.engine.stop(f.session.id);
  const task=plugin.create({url:f.url,goal:'Visit Alpha through More information',coverageContract:{version:1,mode:'targeted',programNavigation:'public-navigation-v1',roots:[{url:f.url}],routes:[{origin:new URL(f.url).origin,pathnamePattern:'^/alpha$',scope:{}}],allowedOperations:['click'],exclusions:[]},
   sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',headless:true,settleMs:25,observeTimeoutMs:500},budget:{rounds:1,actions:3,durationMs:25000,modelRequests:2}});
  const original:PlanItem={id:'retained-original-child',title:source.label,scope:scopeFor(source,before),prerequisites:[{url:f.url,kind:'click',label:'More information'}],completion:'actual original child',status:'unresolved',reason:'observed_in_scope',required:true,dispatchScope:false,operationConditionPolicy:'browser-operation-key-v3',operationConditionKey:schedulingKeyFor(source,before),evidence:[{sessionId:before.sessionId,observationId:before.id}],attempts:[]};
  task.plan.push({id:'explicit-authority',title:'Alpha',scope:{url:f.url,kind:'click',label:'Alpha'},prerequisites:[{url:f.url,kind:'click',label:'More information'}],completion:'Open requested component',status:'pending',reason:'explicit_scope',required:true,dispatchScope:true,evidence:[],attempts:[]},original);store.save(task);plugin.start(task.id);await plugin.waitForIdle(task.id);
  const final=store.task(task.id),item=final.plan.find(i=>i.id===original.id),events=store.events(task.id),decisions=store.decisions(task.id);
  mkdirSync('.data/component-correspondence',{recursive:true});writeFileSync(`.data/component-correspondence/plugin-${real?'real':'offline'}-proof-${Date.now()}.json`,JSON.stringify({final,events,decisions,questions,componentQuestions:[...store.fragmentRecords.rows(task.id,'componentQuestions')]},null,2));
  expect(item?.scope).toEqual(original.scope);expect(item?.operationConditionKey).toBe(original.operationConditionKey);
  expect(item?.status,JSON.stringify({reason:final.reason,item,decisions})).toBe('succeeded');expect(item?.resolvedBy?.attemptId).toBeDefined();expect(item?.conditionCompletion?.status).toBe('verified');
  expect(events.some(e=>e.type==='component.correspondence_recorded')).toBe(changed);if(!real)expect(questions).toBe(changed?1:0);if(!changed)expect(decisions).toEqual([]);
 }finally{await plugin.close();store.close();await f.close();}
});

it('rebinds complete local generated IDs and IDREFs without a model question',async()=>{
 const f=await fixture(false,true);try{const source=target(f,f.session.id),before=f.engine.observation(f.session.id);f.change('ids');await f.engine.stop(f.session.id);
  const next=await f.engine.createSession(f.options),action=target(f,next.id),current=f.engine.observation(next.id);
  const material=f.engine.componentCorrespondenceMaterial(next.id,{observationId:current.id,actionId:action.id,source:{sessionId:before.sessionId,observationId:before.id,actionId:source.id}});expect(material.status).toBe('same');
 }finally{await f.close();}
});
