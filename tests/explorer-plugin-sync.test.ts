import { it,expect,vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExplorerStore } from '../packages/explorer-plugin/src/store.js';
import { registerExplorer } from '../packages/explorer-plugin/src/server.js';
import { ExplorerClient,ExplorerTaskFeed } from '../packages/explorer-plugin/src/client.js';
import type { ExplorerPlugin } from '../packages/explorer-plugin/src/runtime.js';
import type { Task,Decision,TaskView } from '../packages/explorer-plugin/src/types.js';

const task=(id='task'):Task=>({id,goal:'Explore',url:'https://example.test/',createdAt:'2026-10-16T00:00:00Z',updatedAt:'2026-10-16T00:00:00Z',revision:1,status:'paused',budget:{rounds:3,actions:300,durationMs:1800000,modelRequests:300},usage:{rounds:1,actions:2,durationMs:100,modelRequests:1},sessionOptions:{},plan:[],rounds:[],sampleExcluded:[],exhaustive:false});
const decision=(id='decision'):Decision=>({id,taskId:'task',revision:1,actor:'jev',purpose:'next-action',provider:'fake',model:'fake',request:{id:'request',purpose:'next-action',kind:'choice',instructions:'Choose',state:{},options:{next:'Next'}},input:{original:'retained input'},status:'requested',startedAt:'2026-10-16T00:00:00Z'});
const changed=(store:ExplorerStore,d:Decision,type=`decision.${d.status}`)=>{store.decision(d);return store.event({taskId:d.taskId,actor:d.actor,type,decisionId:d.id,data:{status:d.status}});};

it('pages updates by event sequence, including changed old decisions, while keeping legacy endpoints',async()=>{
 const store=new ExplorerStore(':memory:');store.save(task());store.save(task('other'));
 const plugin={store,owner:()=>undefined,tasks:()=>store.tasks(),view:(id:string)=>({task:store.task(id),decisions:store.decisions(id),events:store.events(id)}),close:async()=>store.close()} as unknown as ExplorerPlugin;
 const app=Fastify();await registerExplorer(app,plugin);
 try{
  const d=decision(),first=changed(store,d),insertion=store.decisionCursor('task');
  store.event({taskId:'other',actor:'program',type:'other',data:{}});
  d.status='returned';d.answer={value:'next',model:'fake'};const second=changed(store,d);
  const page=await app.inject('/plugins/explorer/v1/tasks/task/updates?after=0&limit=1');expect(page.statusCode).toBe(200);expect(page.headers['cache-control']).toBe('no-store');
  expect(page.json()).toMatchObject({cursor:first.sequence,hasMore:true,decisions:[{id:d.id,status:'returned'}]});
  const next=(await app.inject(`/plugins/explorer/v1/tasks/task/updates?after=${first.sequence}&limit=1`)).json();expect(next.events.map((e:any)=>e.sequence)).toEqual([second.sequence]);expect(next.hasMore).toBe(false);
  d.status='applied';const third=changed(store,d);expect(store.decisionCursor('task')).toBe(insertion);
  const update=(await app.inject(`/plugins/explorer/v1/tasks/task/updates?after=${second.sequence}`)).json();expect(update.cursor).toBe(third.sequence);expect(update.decisions).toMatchObject([{status:'applied',input:{original:'retained input'},answer:{value:'next'}}]);
  const idle=(await app.inject(`/plugins/explorer/v1/tasks/task/updates?after=${third.sequence}`)).json();expect(idle).toMatchObject({cursor:third.sequence,events:[],decisions:[],hasMore:false});
  const legacy=(await app.inject('/plugins/explorer/v1/tasks/task')).json();expect(legacy.decisions).toHaveLength(1);expect(legacy.events).toHaveLength(3);
  expect((await app.inject('/plugins/explorer/v1/tasks/task/events')).json()).toHaveLength(3);
  expect((await app.inject('/plugins/explorer/v1/tasks')).json()[0]).toHaveProperty('plan');
  const summaries=(await app.inject('/plugins/explorer/v1/tasks?summary=true')).json();expect(summaries[0]).toEqual({id:'task',goal:'Explore',url:'https://example.test/',status:'paused',rounds:[]});
  const unchanged=(await app.inject(`/plugins/explorer/v1/tasks/task/updates?after=${third.sequence}&taskVersion=${update.taskVersion}`)).json();expect(unchanged).not.toHaveProperty('task');expect(unchanged).toMatchObject({taskVersion:update.taskVersion,events:[],decisions:[]});
  expect((await app.inject('/plugins/explorer/v1/tasks/missing/updates')).statusCode).toBe(404);
  for(const query of ['after=-1','after=1.5','limit=0','limit=1001'])expect((await app.inject(`/plugins/explorer/v1/tasks/task/updates?${query}`)).statusCode).toBe(400);
 }finally{await app.close();}
});

it('journals restart invalidation so an existing event cursor sees old decisions become stale without resetting budgets',()=>{
 const dir=mkdtempSync(join(tmpdir(),'explorer-sync-')),file=join(dir,'plugin.sqlite');let store=new ExplorerStore(file);
 try{
  const t=task();t.status='running';store.save(t);const d=decision(),cursor=changed(store,d).sequence;store.close();store=new ExplorerStore(file);
  const update=store.updates(t.id,cursor);expect(update.task!.status).toBe('paused');expect(update.task!.usage).toEqual(t.usage);expect(update.decisions).toMatchObject([{id:d.id,status:'stale',reason:'process_restarted'}]);expect(update.events).toMatchObject([{type:'decision.stale',decisionId:d.id},{type:'task.recovered'}]);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

it('retains full history once and merges later status/effect updates without duplicate events or overlapping reads',async()=>{
 const store=new ExplorerStore(':memory:');store.save(task());const d=decision(),first=changed(store,d);const client=new ExplorerClient();
 const initial:TaskView={task:store.task('task'),decisions:store.decisions('task'),events:store.events('task')};
 const initialRead=vi.spyOn(client,'task').mockResolvedValue(initial);const reads=vi.spyOn(client,'updates').mockImplementation(async(id,after,_signal,version)=>store.updates(id,after,1,version));
 try{
  const feed=new ExplorerTaskFeed(client,'task');const a=feed.refresh(),b=feed.refresh();expect(a).toBe(b);await a;
  d.status='applied';d.output={result:'next'};changed(store,d);store.event({taskId:'task',actor:'program',type:'decision.effect',decisionId:d.id,data:{kind:'action',details:{requestId:'dispatch'}}});
  const next=await feed.refresh();expect(initialRead).toHaveBeenCalledTimes(1);expect(reads.mock.calls.map(x=>x[1])).toEqual([first.sequence,first.sequence,first.sequence+1]);expect(next.decisions).toHaveLength(1);expect(next.decisions[0]).toMatchObject({status:'applied',input:{original:'retained input'},output:{result:'next'}});expect(next.events.map(e=>e.sequence)).toEqual([1,2,3]);expect(initial.decisions[0].status).toBe('requested');expect(initial.events).toHaveLength(1);
  const idle=await feed.refresh();expect(idle).toBe(next);expect(idle.events).toHaveLength(3);expect(initialRead).toHaveBeenCalledTimes(1);
 }finally{store.close();}
});

it('invalidates task versions for status and budget writes sharing the same millisecond',()=>{
 const store=new ExplorerStore(':memory:'),clock=vi.spyOn(Date.prototype,'toISOString').mockReturnValue('2026-10-16T00:00:00.000Z');
 try{
  const t=task();store.save(t);const first=store.updates(t.id);expect(store.updates(t.id,0,500,first.taskVersion).task).toBeUndefined();
  t.status='budget_exhausted';t.usage.actions=300;t.budget.actions=500;store.save(t);
  const next=store.updates(t.id,0,500,first.taskVersion);expect(next.taskVersion).not.toBe(first.taskVersion);expect(next.task!.updatedAt).toBe(first.task!.updatedAt);expect(next.task).toMatchObject({status:'budget_exhausted',usage:{actions:300},budget:{actions:500}});
 }finally{clock.mockRestore();store.close();}
});

it('continues after a failed later page without redownloading initial history or losing a boundary event',async()=>{
 const store=new ExplorerStore(':memory:');store.save(task());const d=decision();changed(store,d);const client=new ExplorerClient();
 vi.spyOn(client,'task').mockResolvedValue({task:store.task('task'),decisions:store.decisions('task'),events:[]});
 let fail=true;vi.spyOn(client,'updates').mockImplementation(async(id,after)=>{if(after===1&&fail){fail=false;throw new Error('temporary');}return store.updates(id,after,1);});
 store.event({taskId:'task',actor:'program',type:'decision.effect',decisionId:d.id,data:{kind:'action'}});
 try{
  const feed=new ExplorerTaskFeed(client,'task');await expect(feed.refresh()).rejects.toThrow('temporary');const view=await feed.refresh();expect(client.task).toHaveBeenCalledTimes(1);expect(view.events.map(e=>e.sequence)).toEqual([1,2]);expect(view.decisions).toHaveLength(1);
 }finally{store.close();}
});
