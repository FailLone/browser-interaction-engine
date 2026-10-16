import { expect, it, vi } from 'vitest';
import { ExplorerPlugin, ExplorerStore, type PlanItem } from '@interaction/explorer-plugin';
import { completedOperations } from '../packages/explorer-plugin/src/completion-evidence.js';
import { scopeFor } from '../packages/explorer-plugin/src/policy.js';
import { explorerFixture } from './explorer-plugin-helpers.js';

const options={headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]};

it('batches duplicate historical task proofs while keeping same-name controls and current execution distinct',async()=>{
  const f=await explorerFixture('<button id="one" type="button">Run</button><button id="two" type="button">Run</button>');
  const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
  try{
    const first=await f.host.createSession({...options,url:f.url}),before=f.host.observation(first.id);
    const control=before.controls.find(c=>c.stableKey==='id:one')!,source=f.host.actions(first.id).find(a=>a.localId===control.localId&&a.kind==='click')!;
    const attempt=await f.host.execute(first.id,source.id,'source');expect(attempt.status).toBe('succeeded');await f.host.stop(first.id);
    const next=await f.host.createSession({...options,url:f.url}),o=f.host.observation(next.id),actions=f.host.actions(next.id).filter(a=>a.kind==='click');
    const task=plugin.create({url:f.url}),ref={sessionId:first.id,observationId:before.id,attemptId:attempt.id};
    const item:PlanItem={id:'proof',title:'Prior operation',scope:scopeFor(source,before),prerequisites:[],completion:'Observed success',status:'succeeded',required:true,reason:'action_verified',evidence:[ref],resolvedBy:ref,attempts:[]};
    task.plan=Array.from({length:120},(_,i)=>({...structuredClone(item),id:`duplicate-${i}`}));
    // A legacy coarse task scope may match both occurrences. Only the host can
    // distinguish operation evidence; a task key must never authorize identity.
    task.plan.push({...structuredClone(item),id:'coarse',scope:{url:f.url,label:'Run',kind:'click'}});
    const saved=JSON.stringify(task),events=f.host.store.events(next.id).length,batch=vi.spyOn(f.host,'operationCorrespondences');
    const completed=completedOperations(f.host,task,o,actions);
    expect(batch).toHaveBeenCalledTimes(1);expect(batch.mock.calls[0][1].requests).toHaveLength(2);
    expect([...completed].map(a=>o.controls.find(c=>c.localId===a.localId)?.stableKey)).toEqual(['id:one']);
    expect(JSON.stringify(task)).toBe(saved);expect(f.host.session(next.id).actionCount).toBe(0);
    expect(f.host.list(next.id,'attempt')).toEqual([]);expect(f.host.store.events(next.id)).toHaveLength(events);
    const evidence=batch.mock.results[0].value as ReturnType<typeof f.host.operationCorrespondences>;
    expect(evidence.results.every(p=>!p.currentExecution&&!p.identityAuthorized&&!p.replayAuthorized)).toBe(true);

    // A later read of the same observation must not retain an earlier positive
    // answer if the proof is now unknown or its retained evidence disappears.
    f.host.store.put('attempt',{...attempt,status:'unknown'});
    expect(completedOperations(f.host,task,o,actions).size).toBe(0);
    f.host.store.put('attempt',{...attempt,afterId:undefined});
    expect(completedOperations(f.host,task,o,actions).size).toBe(0);
    expect(batch).toHaveBeenCalledTimes(3);
  }finally{await plugin.close();await f.close();}
});

it('rebuilds task proof selection after scope acceptance changes and never treats review closure as executed evidence',async()=>{
  const f=await explorerFixture('<button id="one" type="button">Run</button>'),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
  try{
    const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),actions=f.host.actions(s.id).filter(a=>a.kind==='click');
    const attempt=await f.host.execute(s.id,actions[0].id,'source');expect(attempt.status).toBe('succeeded');
    const task=plugin.create({url:f.url}),ref={sessionId:s.id,observationId:o.id,attemptId:attempt.id};
    const item:PlanItem={id:'proof',title:'Run',scope:scopeFor(actions[0],o),prerequisites:[],completion:'Observed success',status:'succeeded',required:true,reason:'action_verified',evidence:[ref],resolvedBy:ref,attempts:[]};task.plan=[item];
    const batch=vi.spyOn(f.host,'operationCorrespondences');
    expect(completedOperations(f.host,task,o,actions).size).toBe(1);
    item.required=false;item.status='untested';
    expect(completedOperations(f.host,task,o,actions).size).toBe(0);
    item.required=true;item.status='succeeded';delete item.resolvedBy;
    item.reviewResolvedBy={sessionId:s.id,observationId:o.id,classificationId:'display',classification:'display'};
    expect(completedOperations(f.host,task,o,actions).size).toBe(0);expect(batch).toHaveBeenCalledTimes(1);
    item.resolvedBy=ref;
    expect(completedOperations(f.host,task,o,actions).size).toBe(1);expect(batch).toHaveBeenCalledTimes(2);
  }finally{await plugin.close();await f.close();}
});
