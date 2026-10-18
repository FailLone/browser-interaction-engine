import {it,expect} from 'vitest';
import {ExplorerPlugin,ExplorerStore,type CoverageContract} from '@interaction/explorer-plugin';
import {coverageContractSchema} from '../packages/explorer-plugin/src/schema.js';
import {contractProposalError} from '../packages/explorer-plugin/src/coverage-contract.js';
import {explorerFixture,fakeProviders} from './explorer-plugin-helpers.js';

it('requires declared exhaustive roots to remain whole pages and targeted roots to remain bounded',()=>{
 const base={version:1,exclusions:[],allowedOperations:['click']};
 expect(coverageContractSchema.safeParse({...base,mode:'exhaustive',roots:[{url:'https://example.test/'}]}).success).toBe(true);
 expect(coverageContractSchema.safeParse({...base,mode:'exhaustive',roots:[{label:'Easy'}]}).success).toBe(false);
 expect(coverageContractSchema.safeParse({...base,mode:'targeted',roots:[{}]}).success).toBe(false);
 expect(coverageContractSchema.safeParse({...base,mode:'targeted',roots:[{region:'Navigation'}]}).success).toBe(true);
});

it('rejects model expansion, excluded overlap, unauthorized operations and outside prerequisites',()=>{
 const contract:CoverageContract={version:1,mode:'targeted',roots:[{url:'https://example.test/',region:'Navigation'}],exclusions:[{scope:{label:'Restricted'},instruction:'Do not use Restricted'}],allowedOperations:['click','hover']};
 const valid={scope:{url:'https://example.test/',region:'Navigation',label:'Open',kind:'click'},prerequisites:[]};
 expect(contractProposalError(contract,valid)).toBeUndefined();
 expect(contractProposalError(contract,{...valid,scope:{url:'https://example.test/'}})).toBe('outside_contract_root');
 expect(contractProposalError(contract,{...valid,scope:{...valid.scope,label:'Restricted'}})).toBe('excluded_scope_overlap');
 expect(contractProposalError(contract,{...valid,scope:{...valid.scope,kind:'fill'}})).toBe('operation_not_authorized');
 expect(contractProposalError(contract,{...valid,prerequisites:[{url:'https://other.test/',kind:'click'}]})).toBe('outside_contract_root');
});

it('persists caller roots and exclusions without asking a model to replace the task',async()=>{
 const f=await explorerFixture();const store=new ExplorerStore(':memory:'),providers=fakeProviders(f.url,{url:'https://outside.test/'}),plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const contract:CoverageContract={version:1,mode:'targeted',roots:[{url:f.url,label:'Alpha',kind:'click'}],exclusions:[{scope:{label:'Beta'},instruction:'Leave Beta alone'}],allowedOperations:['click']};
  const task=plugin.create({url:f.url,goal:'Specific caller task',coverageContract:contract,budget:{rounds:1,actions:4,durationMs:15000},sessionOptions:{headless:true,coveragePolicy:'finite-ui-v1'}});
  contract.roots[0].label='Mutated input';plugin.start(task.id);await plugin.waitForIdle(task.id);
  const result=store.task(task.id);expect(result.coverageContract?.roots[0].label).toBe('Alpha');
  expect(result.plan.filter(i=>i.dispatchScope===true).map(i=>i.scope)).toEqual([{url:f.url,label:'Alpha',kind:'click'}]);
  expect(result.plan.find(i=>i.reason==='user_excluded')).toMatchObject({required:false,status:'excluded',scope:{label:'Beta'}});
  expect(providers.calls.some(c=>['initial-plan','task-intent'].includes(c.purpose))).toBe(false);
  expect(plugin.coverageLedger(task.id).coverageContract).toEqual(result.coverageContract);
  expect(()=>plugin.revise(task.id,{items:[]})).toThrow('CONTRACT_REVISION_REQUIRES_NEW_TASK');
  expect(f.host.list<any>(result.rounds[0].sessionId,'attempt').filter(a=>a.status==='succeeded').map(a=>a.action.label)).toContain('Alpha');
  expect(f.host.list<any>(result.rounds[0].sessionId,'attempt').some(a=>a.action.label==='Beta')).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it('retains a forbidden operation as required untested coverage while allowing another operation',async()=>{
 const f=await explorerFixture('<label>Text<input id="text"></label><button id="ready" type="button" onclick="this.disabled=true">Ready</button>');const store=new ExplorerStore(':memory:'),providers=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const task=plugin.create({url:f.url,goal:'All controls',coverageContract:{version:1,mode:'exhaustive',roots:[{url:f.url}],exclusions:[],allowedOperations:['click']},budget:{rounds:1,actions:6,durationMs:15000},sessionOptions:{headless:true,coveragePolicy:'finite-ui-v1'}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const result=store.task(task.id);
  expect(result.status).not.toBe('completed');
  expect(result.plan.some(i=>i.required&&i.scope.kind==='fill'&&i.reason==='operation_not_authorized_by_contract'&&i.status!=='succeeded')).toBe(true);
  const attempts=result.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(attempts.some(a=>a.action.label==='Ready'&&a.status==='succeeded')).toBe(true);
  expect(attempts.some(a=>a.action.kind==='fill')).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it('grounds header scope in captured structure without model-selected labels or unrelated page work',async()=>{
 const f=await explorerFixture('<div role="banner"><nav><button id="header-action" type="button" onclick="this.disabled=true">Header action</button><canvas></canvas></nav></div><footer><button id="footer-action" type="button">Footer action</button></footer><canvas></canvas>');
 const store=new ExplorerStore(':memory:'),providers=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const task=plugin.create({url:f.url,goal:'Explore header navigation',coverageContract:{version:1,mode:'targeted',roots:[{url:f.url,landmark:'banner'}],exclusions:[],allowedOperations:['click']},budget:{rounds:1,actions:5,durationMs:15000},sessionOptions:{headless:true,coveragePolicy:'finite-ui-v1'}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const result=store.task(task.id),attempts=result.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(attempts.some(a=>a.action.label==='Header action'&&a.status==='succeeded')).toBe(true);
  expect(attempts.some(a=>a.action.label==='Footer action')).toBe(false);
  expect(result.plan.some(i=>i.required&&i.reason==='missing_capability:UNSUPPORTED_CANVAS')).toBe(true);
  const unsupported=store.events(task.id).find(e=>e.type==='scope.unsupported')?.data as any;
  expect(unsupported.limitations).toHaveLength(1);expect(unsupported.limitations[0].coverageScope.landmark).toBe('banner');
  expect(result.status).not.toBe('completed');expect(providers.calls.some(c=>c.purpose==='initial-plan')).toBe(false);
  expect(providers.calls.some(c=>c.purpose==='region-review')).toBe(false);
  const partitions=store.events(task.id).filter(e=>e.type==='program.review'&&(e.data as any).reason==='contract_region_partition');
  expect(partitions.length).toBeGreaterThan(0);
  for(const event of partitions){
   const data=event.data as any,o=f.host.observation(event.sessionId!,data.sourceObservationId);
   expect(data).toMatchObject({executionAuthorized:false,details:{groupingOnly:true,coverageGranted:false}});
   for(const region of data.command.review.regions){
    expect(region.pageTraversal).toBe(false);
    for(const id of region.controlIds)expect(o.controls.find(c=>c.localId===id)?.landmark).toBe('banner');
   }
  }
 }finally{await plugin.close();await f.close();}
});

it('keeps interface-only operation and probe uncertainty after caller-authorized structural grouping',async()=>{
 const f=await explorerFixture('<div id="unknown" role="button" tabindex="0" onclick="window.changed=true">Unresolved effect</div><button id="ready" type="button" onclick="this.disabled=true">Ready</button><canvas></canvas>');
 const store=new ExplorerStore(':memory:'),providers=fakeProviders(f.url),decide=providers.jev.decide;
 providers.jev.decide=async (request,context)=>{
  if(['control-risk','probe-risk'].includes(request.purpose)&&(request.state as any).material.control.selector==='#unknown'){
   providers.calls.push(request);return {value:Object.fromEntries(Object.keys(request.checks!).map(key=>[key,.5])),model:'mock-uncertain',confidence:1};
  }
  if(request.purpose==='control-classification'){
   providers.calls.push(request);return {value:'interaction',model:'mock-explicit',confidence:1};
  }
  return decide(request,context);
 };
 providers.llm.decide=async (request,context)=>{
  if(request.purpose==='operation-clarification'){
   providers.calls.push(request);return {value:{choice:'uncertain',evidenceRefs:[],reason:'Effect is not established',interfaceOnly:null,externalWrite:null},model:'mock-uncertain',confidence:1};
  }
  return decide(request,context);
 };
 const plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const contract:CoverageContract={version:1,mode:'exhaustive',roots:[{url:f.url}],exclusions:[],allowedOperations:['click','hover','focus']};
  const task=plugin.create({url:f.url,coverageContract:contract,budget:{rounds:1,actions:5,durationMs:15000},sessionOptions:{headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'interface-only'}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),attempts=final.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(providers.calls.some(r=>r.purpose==='region-review')).toBe(false);
  expect(providers.calls.some(r=>r.purpose==='control-risk')).toBe(true);
  expect(providers.calls.some(r=>r.purpose==='probe-risk')).toBe(true);
  expect(attempts.some(a=>a.status==='succeeded'&&a.action.label==='Ready')).toBe(true);
  expect(attempts.some(a=>a.action.label==='Unresolved effect')).toBe(false);
  expect(final.plan.some(i=>i.required&&i.scope.label==='Unresolved effect'&&i.reason==='operation_risk_unresolved')).toBe(true);
  expect(final.plan.some(i=>i.required&&i.reason==='missing_capability:UNSUPPORTED_CANVAS')).toBe(true);
  expect(final.status).not.toBe('completed');expect(plugin.coverageLedger(task.id).coverageContract).toEqual(contract);
 }finally{await plugin.close();await f.close();}
});

it('retains caller route language and binds scopes only to observed matching URLs',async()=>{
 const {contractExecutionBoundary,observedContractRoots}=await import('../packages/explorer-plugin/src/coverage-contract.js');
 const {executionURLAllowed}=await import('@interaction/browser');
 const contract:CoverageContract={version:1,mode:'targeted',roots:[{url:'https://example.test/start',landmark:'banner'}],routes:[{origin:'https://example.test',pathnamePattern:'^/(?:[a-z]{2}/)?info/?$',scope:{}}],exclusions:[],allowedOperations:['click','history']};
 const original=structuredClone(contract),boundary=contractExecutionBoundary(contract);
 for(const url of ['https://example.test/info','https://example.test/en/info/?x=1#part','https://example.test/zh/info']){
  expect(executionURLAllowed(boundary,url)).toBe(true);
  expect(observedContractRoots(contract,url)).toEqual([{scope:{url},declaration:{kind:'route',index:0}}]);
  expect(contractProposalError(contract,{scope:{url,label:'Information',kind:'click'},prerequisites:[]})).toBeUndefined();
 }
 for(const url of ['https://example.test/login','https://other.test/info','https://example.test/info/child','http://example.test/info']){
  expect(executionURLAllowed(boundary,url)).toBe(false);expect(observedContractRoots(contract,url)).toEqual([]);
  expect(contractProposalError(contract,{scope:{url},prerequisites:[]})).toBe('outside_contract_root');
 }
 expect(contract).toEqual(original);
 expect(coverageContractSchema.safeParse({...contract,routes:[{...contract.routes![0],pathnamePattern:'info'}]}).success).toBe(false);
 expect(coverageContractSchema.safeParse({...contract,routes:[{...contract.routes![0],pathnamePattern:'^[$'}]}).success).toBe(false);
 expect(coverageContractSchema.safeParse({...contract,routes:[{...contract.routes![0],origin:'https://example.test/path'}]}).success).toBe(false);
});

it('materializes a caller route on real arrival and keeps the original root and exact URL evidence',async()=>{
 const f=await explorerFixture('<div role="banner"><a href="/info?source=entry#details">Next</a></div><button type="button">Page action</button>');
 const store=new ExplorerStore(':memory:'),providers=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const contract:CoverageContract={version:1,mode:'targeted',roots:[{url:f.url,landmark:'banner'}],routes:[{origin:new URL(f.url).origin,pathnamePattern:'^/info$',scope:{}}],exclusions:[],allowedOperations:['click','history']};
  const task=plugin.create({url:f.url,coverageContract:contract,budget:{rounds:1,actions:3,durationMs:15000},sessionOptions:{headless:true,coveragePolicy:'finite-ui-v1'}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const result=store.task(task.id),url=new URL('/info?source=entry#details',f.url).href;
  expect(result.coverageContract).toEqual(contract);
  expect(result.plan.some(i=>i.dispatchScope&&i.scope.url===f.url&&i.scope.landmark==='banner')).toBe(true);
  expect(result.plan.some(i=>i.dispatchScope&&i.scope.url===url&&!i.scope.landmark)).toBe(true);
  const event=store.events(task.id).find(e=>e.type==='scope.contract_url_bound')!;
  expect(event.data).toMatchObject({declaration:{kind:'route',index:0},scope:{url},urlAuthorizationOnly:true,coverageGranted:false});
  const attempts=result.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(attempts.some(a=>a.action.label==='Page action'&&f.host.observation(a.sessionId,a.beforeId).url===f.url)).toBe(false);
  expect(attempts.some(a=>a.action.label==='Page action'&&a.status==='succeeded'&&f.host.observation(a.sessionId,a.beforeId).url===url)).toBe(true);
 }finally{await plugin.close();await f.close();}
});
