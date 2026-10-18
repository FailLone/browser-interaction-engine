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
