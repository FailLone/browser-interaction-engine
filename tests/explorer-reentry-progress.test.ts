import {expect,it} from 'vitest';
import {join} from 'node:path';
import type {ActionCandidate,Observation} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type Task,type Round,type PlanItem} from '@interaction/explorer-plugin';
import {scopeFor} from '../packages/explorer-plugin/src/policy.js';
import {explorerFixture} from './explorer-plugin-helpers.js';

type Scheduler={neededEntry(t:Task,r:Round,a:ActionCandidate,o:Observation):boolean;recordEntry(t:Task,r:Round,a:ActionCandidate,o:Observation):void};
it('bounds entry retries across changing unfinished labels and restart, renewing only after a distinct child completion',async()=>{
  const f=await explorerFixture('<button id="open" type="button">Open</button><button id="child" type="button">Child</button>'),file=join(f.dir,'reentry.sqlite');
  let plugin=new ExplorerPlugin(f.host,new ExplorerStore(file));
  try{
    const s=await f.host.createSession({url:f.url,headless:true,settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]});
    let o=f.host.observation(s.id),entry=f.host.actions(s.id).find(a=>a.label==='Open')!;
    let task=plugin.create({url:f.url}),round:Round={id:'round',number:1,sessionId:s.id,startedAt:new Date().toISOString(),status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};
    task.rounds=[round];task.usage={rounds:1,actions:7,modelRequests:9,durationMs:1234};
    const root:PlanItem={id:'root',title:'All',scope:{url:f.url},prerequisites:[],completion:'Fresh evidence',status:'pending',required:true,dispatchScope:true,reason:'user_goal',evidence:[],attempts:[]};
    task.plan=[root];let sequence=0;
    const addMissing=()=>task.plan.push({...structuredClone(root),id:`missing-${sequence}`,scope:{url:f.url,label:`Quote ${sequence++}`,kind:'click'},prerequisites:[scopeFor(entry,o)],dispatchScope:false,status:'unresolved',reason:'operation_not_executed'});
    const scheduler=()=>plugin as unknown as Scheduler;
    for(let i=0;i<3;i++){addMissing();expect(scheduler().neededEntry(task,round,entry,o)).toBe(true);scheduler().recordEntry(task,round,entry,o);}
    addMissing();expect(scheduler().neededEntry(task,round,entry,o)).toBe(false);plugin.store.save(task);const before=structuredClone(task.usage);
    await plugin.close();plugin=new ExplorerPlugin(f.host,new ExplorerStore(file));task=plugin.store.task(task.id);round=task.rounds[0];
    addMissing();expect(scheduler().neededEntry(task,round,entry,o)).toBe(false);expect(task.usage).toEqual(before);
    expect(plugin.store.events(task.id).filter(e=>e.type==='branch.reentry_deferred')).toHaveLength(1);
    expect(task.plan.filter(i=>i.id!=='root').every(i=>i.status==='unresolved'&&!i.resolvedBy)).toBe(true);

    // Real child success is new evidence. The bookkeeping below never dispatches
    // an entry itself, and duplicate success rows must not renew its allowance.
    const child=f.host.actions(s.id).find(a=>a.label==='Child')!,source=o,attempt=await f.host.execute(s.id,child.id,'child-success');
    expect(attempt.status).toBe('succeeded');o=f.host.observation(s.id);entry=f.host.actions(s.id).find(a=>a.label==='Open')!;
    const completed:PlanItem={...structuredClone(root),id:'child',scope:scopeFor(child,source),prerequisites:[scopeFor(entry,o)],dispatchScope:false,status:'succeeded',resolvedBy:{sessionId:s.id,observationId:source.id,attemptId:attempt.id}};
    task.plan.push(completed);
    expect(scheduler().neededEntry(task,round,entry,o)).toBe(true);scheduler().recordEntry(task,round,entry,o);
    for(let i=0;i<2;i++){addMissing();task.plan.push({...structuredClone(completed),id:`duplicate-${i}`});expect(scheduler().neededEntry(task,round,entry,o)).toBe(true);scheduler().recordEntry(task,round,entry,o);}
    addMissing();expect(scheduler().neededEntry(task,round,entry,o)).toBe(false);
    expect(f.host.list(s.id,'attempt')).toHaveLength(1);expect(task.usage).toEqual(before);
  }finally{await plugin.close();await f.close();}
});
