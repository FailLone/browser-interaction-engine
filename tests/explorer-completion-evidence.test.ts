import { expect, it, vi } from 'vitest';
import { ExplorerPlugin, ExplorerStore, type PlanItem, type Task, type Round } from '@interaction/explorer-plugin';
import type { Observation } from '@interaction/browser';
import { completedOperations } from '../packages/explorer-plugin/src/completion-evidence.js';
import { scopeFor } from '../packages/explorer-plugin/src/policy.js';
import { explorerFixture, fakeProviders } from './explorer-plugin-helpers.js';

const options={headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]};

it('records every audit gap against one source without rereading the large observation for each target',async()=>{
  const f=await explorerFixture(Array.from({length:30},(_,i)=>`<button id="target-${i}" type="button">Target ${i}</button>`).join(''));
  const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
  try{
    const s=await f.host.createSession({...options,url:f.url}),first=f.host.observation(s.id),task=plugin.create({url:f.url});
    const round:Round={id:'round',number:1,sessionId:s.id,startedAt:new Date().toISOString(),status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};
    task.rounds=[round];task.plan=[{id:'root',title:'All controls',scope:{url:f.url},prerequisites:[],completion:'Audit every control',status:'pending',required:true,dispatchScope:true,reason:'user_goal',evidence:[],attempts:[]}];
    const audit=plugin as unknown as {auditRemainingScopes(task:Task,round:Round,o:Observation,snapshot:ReturnType<typeof f.host.explorationSnapshot>):Set<string>};
    for(const pass of [0,1]){
      const o=pass===0?first:await f.host.observe(s.id);
      // Build the host facts outside the measured gap loop. Even with historical
      // evidence in the task, the explicit source must be this supplied version.
      const snapshot=f.host.explorationSnapshot(s.id,o.id);
      const reads=vi.spyOn(f.host,'observation');audit.auditRemainingScopes(task,round,o,snapshot);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(1);reads.mockRestore();
      const gaps=task.plan.filter(i=>i.dispatchScope===false&&i.scope.kind==='click');expect(gaps).toHaveLength(30);
      expect(gaps.every(i=>i.evidence.some(e=>e.sessionId===s.id&&e.observationId===o.id))).toBe(true);
      expect(gaps.every(i=>i.status!=='succeeded'&&!i.resolvedBy&&i.attempts.length===0)).toBe(true);
    }
    expect(f.host.session(s.id).actionCount).toBe(0);
  }finally{await plugin.close();await f.close();}
});

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


it('retains the discovery observation for unexecuted siblings without inventing evidence for missing legacy rows',async()=>{
  const f=await explorerFixture('<button id="one" type="button" onclick="this.disabled=true">One</button><button id="two" type="button">Two</button>');
  const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
  try{
    const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:1}});
    plugin.revise(task.id,{items:[{title:'All',scope:{url:f.url},prerequisites:[],completion:'Verify all',required:true,reason:'user goal'}]});
    const saved=plugin.store.task(task.id);
    saved.plan.push({id:'legacy-missing',title:'Old missing target',scope:{url:f.url,label:'Old missing target',kind:'click'},prerequisites:[],completion:'Verify',required:true,dispatchScope:false,status:'unresolved',reason:'observed_in_scope',evidence:[],attempts:[]});plugin.store.save(saved);
    const session=await f.host.createSession({...options,url:f.url}),round:Round={id:'round',number:1,sessionId:session.id,startedAt:new Date().toISOString(),status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};
    saved.rounds=[round];saved.status='running';plugin.store.save(saved);
    const runtime=plugin as unknown as {step(task:Task,round:Round,signal:AbortSignal):Promise<boolean>};
    for(let n=0;n<15&&!f.host.session(session.id).actionCount;n++)await runtime.step(saved,round,new AbortController().signal);
    const result=plugin.store.task(task.id),sid=session.id,attempt=f.host.list<any>(sid,'attempt')[0];
    expect(attempt.status).toBe('succeeded');expect(result.usage.actions).toBe(1);
    const sibling=result.plan.find(i=>i.reason==='observed_in_scope'&&i.scope.label==='Two')!;
    expect(sibling).toBeDefined();expect(sibling.status).not.toBe('succeeded');expect(sibling.resolvedBy).toBeUndefined();expect(sibling.attempts).toEqual([]);
    expect(sibling.evidence).toContainEqual({sessionId:sid,observationId:attempt.beforeId});
    const source=f.host.observation(sid,sibling.evidence[0].observationId);
    expect(f.host.actions(sid,source.id).some(a=>JSON.stringify(scopeFor(a,source))===JSON.stringify(sibling.scope))).toBe(true);
    const legacy=result.plan.find(i=>i.id==='legacy-missing')!;
    expect(legacy.evidence).toEqual([]);expect(legacy.status).not.toBe('succeeded');expect(legacy.resolvedBy).toBeUndefined();
  }finally{await plugin.close();await f.close();}
});

it('lets host evidence reconcile stale derived scope encodings without broadening user scopes or same-name controls',async()=>{
  const f=await explorerFixture('<button id="one" type="button">Run</button><button id="two" type="button">Run</button>');
  const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
  try{
    const first=await f.host.createSession({...options,url:f.url}),before=f.host.observation(first.id);
    const source=f.host.actions(first.id).find(a=>a.localId===before.controls.find(c=>c.stableKey==='id:one')!.localId&&a.kind==='click')!;
    const attempt=await f.host.execute(first.id,source.id,'original');expect(attempt.status).toBe('succeeded');await f.host.stop(first.id);
    const next=await f.host.createSession({...options,url:f.url}),o=f.host.observation(next.id),actions=f.host.actions(next.id).filter(a=>a.kind==='click');
    const task=plugin.create({url:f.url}),ref={sessionId:first.id,observationId:before.id,attemptId:attempt.id};
    const item:PlanItem={id:'legacy-proof',title:'Recorded operation',scope:{...scopeFor(source,before),stableKey:'legacy-key-format',region:'Earlier review label'},prerequisites:[],completion:'Verify',status:'succeeded',required:true,dispatchScope:false,reason:'observed_in_scope',evidence:[ref],resolvedBy:ref,attempts:[]};task.plan=[item];
    const saved=JSON.stringify(task),batch=vi.spyOn(f.host,'operationCorrespondences');
    expect([...completedOperations(f.host,task,o,actions)].map(a=>o.controls.find(c=>c.localId===a.localId)?.stableKey)).toEqual(['id:one']);
    expect(batch).toHaveBeenCalledTimes(1);expect(batch.mock.calls[0][1].requests).toHaveLength(2);
    expect(JSON.stringify(task)).toBe(saved);expect(f.host.session(next.id).actionCount).toBe(0);expect(f.host.list(next.id,'attempt')).toEqual([]);
    item.dispatchScope=true;
    expect(completedOperations(f.host,task,o,actions).size).toBe(0);
    delete item.dispatchScope;
    expect(completedOperations(f.host,task,o,actions).size).toBe(0);
    item.dispatchScope=false;f.host.store.put('attempt',{...attempt,status:'unknown'});
    expect(completedOperations(f.host,task,o,actions).size).toBe(0);
  }finally{await plugin.close();await f.close();}
});
