import { expect,it,vi } from 'vitest';
import { ExplorerPlugin,ExplorerStore,type PlanItem } from '@interaction/explorer-plugin';
import { recoverStoredScopeSources } from '../packages/explorer-plugin/src/scope-migration.js';
import { scopeFor } from '../packages/explorer-plugin/src/policy.js';
import { explorerFixture } from './explorer-plugin-helpers.js';

it('recovers unique retained peer sources once without changing execution, original scopes or authority',async()=>{
  const f=await explorerFixture('<button id="one" type="button">Run</button><button id="two" type="button">Run</button>'),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
  try{
    const s=await f.host.createSession({url:f.url,headless:true,settleMs:0,observeTimeoutMs:100}),o=f.host.observation(s.id);
    const action=f.host.actions(s.id).find(a=>a.localId===o.controls.find(c=>c.stableKey==='id:one')!.localId&&a.kind==='click')!;
    const task=plugin.create({url:f.url}),ref={sessionId:s.id,observationId:o.id};
    const row:PlanItem={id:'source-less',title:'Run',scope:scopeFor(action,o),prerequisites:[],completion:'Verify',status:'unresolved',required:true,dispatchScope:false,reason:'observed_in_scope',evidence:[],attempts:[]};
    task.plan=[...Array.from({length:100},(_,i)=>({...structuredClone(row),id:`row-${i}`})),{...structuredClone(row),id:'peer',reason:'region_review_required',evidence:[ref]}];
    const scope=JSON.stringify(row.scope),reads=vi.spyOn(f.host,'observation'),actions=vi.spyOn(f.host,'actions');
    const changes=recoverStoredScopeSources(task,f.host);expect(changes).toHaveLength(100);expect(reads).toHaveBeenCalledTimes(2);expect(actions).toHaveBeenCalledTimes(1);
    expect(task.plan.every(i=>i.status==='unresolved'&&!i.resolvedBy&&i.attempts.length===0&&i.dispatchScope===false&&JSON.stringify(i.scope)===scope)).toBe(true);
    expect(task.plan.every(i=>JSON.stringify(i.evidence)===JSON.stringify([ref]))).toBe(true);
    expect(recoverStoredScopeSources(task,f.host)).toEqual([]);expect(reads).toHaveBeenCalledTimes(2);
    expect(f.host.session(s.id).actionCount).toBe(0);
  }finally{await plugin.close();await f.close();}
});

it('keeps absent, ambiguous, user-authorized and unavailable sources unresolved',async()=>{
  const f=await explorerFixture('<button data-testid="duplicate" type="button">Run</button><button data-testid="duplicate" type="button">Run</button>'),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
  try{
    const s=await f.host.createSession({url:f.url,headless:true,settleMs:0,observeTimeoutMs:100}),o=f.host.observation(s.id),actions=f.host.actions(s.id).filter(a=>a.kind==='click');
    const task=plugin.create({url:f.url}),ref={sessionId:s.id,observationId:o.id};
    const row:PlanItem={id:'ambiguous',title:'Run',scope:scopeFor(actions[0],o),prerequisites:[],completion:'Verify',status:'unresolved',required:true,dispatchScope:false,reason:'observed_in_scope',evidence:[],attempts:[]};
    expect(actions.filter(a=>JSON.stringify(scopeFor(a,o))===JSON.stringify(row.scope))).toHaveLength(2);
    task.plan=[row,{...structuredClone(row),id:'peer',reason:'region_review_required',evidence:[ref]},
      {...structuredClone(row),id:'user',dispatchScope:true},
      {...structuredClone(row),id:'missing',scope:{...row.scope,label:'Missing'}},
      {...structuredClone(row),id:'unavailable',scope:{...row.scope,label:'Unavailable'}},
      {...structuredClone(row),id:'unavailable-peer',scope:{...row.scope,label:'Unavailable'},reason:'operation_not_executed',evidence:[{sessionId:s.id,observationId:'unavailable'}]}];
    const saved=JSON.stringify(task);expect(recoverStoredScopeSources(task,f.host)).toEqual([]);expect(JSON.stringify(task)).toBe(saved);
    expect(f.host.session(s.id).actionCount).toBe(0);
  }finally{await plugin.close();await f.close();}
});
