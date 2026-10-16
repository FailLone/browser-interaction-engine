import {expect,it} from 'vitest';
import {join} from 'node:path';
import type {ActionCandidate,Observation} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type Task,type Round,type PlanItem} from '@interaction/explorer-plugin';
import {scopeFor} from '../packages/explorer-plugin/src/policy.js';
import {capturedRoute,routeToTarget} from '../packages/explorer-plugin/src/reentry-evidence.js';
import {explorerFixture} from './explorer-plugin-helpers.js';

type Scheduler={neededEntry(t:Task,r:Round,a:ActionCandidate,o:Observation):boolean;recordEntry(t:Task,r:Round,a:ActionCandidate,o:Observation):void};
it('requires observed target routes and a new child completion before repeating entry, across restart',async()=>{
 const f=await explorerFixture(`<button id="open" type="button" onclick="document.getElementById('menu').hidden=false">Open</button><div id="menu" hidden><button id="first" onclick="this.disabled=true;document.getElementById('menu').hidden=true">First</button><button id="second">Second</button></div><button id="close" onclick="document.getElementById('menu').hidden=true">Close</button>`),file=join(f.dir,'reentry.sqlite');
 let plugin=new ExplorerPlugin(f.host,new ExplorerStore(file));
 try{
  const s=await f.host.createSession({url:f.url,headless:true,settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]});
  const click=async(label:string)=>f.host.execute(s.id,f.host.actions(s.id).find(a=>a.label===label&&a.kind==='click')!.id,crypto.randomUUID());
  const initial=f.host.observation(s.id),open=f.host.actions(s.id).find(a=>a.label==='Open')!;await click('Open');const opened=f.host.observation(s.id);
  const route=capturedRoute(scopeFor(open,initial),initial,opened,f.host.interactionTransition(s.id,initial.id,opened.id).revealedControlIds)!;expect(route.targets.map(s=>s.label)).toEqual(['First','Second']);
  await click('Close');let o=f.host.observation(s.id),entry=f.host.actions(s.id).find(a=>a.label==='Open')!;
  let task=plugin.create({url:f.url}),round:Round={id:'round',number:1,sessionId:s.id,startedAt:new Date().toISOString(),status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};
  task.rounds=[round];task.usage={rounds:1,actions:7,modelRequests:9,durationMs:1234};
  const root:PlanItem={id:'root',title:'All',scope:{url:f.url},prerequisites:[],completion:'Fresh evidence',status:'pending',required:true,dispatchScope:true,reason:'user_goal',evidence:[],attempts:[]};
  const item=(label:string):PlanItem=>({...structuredClone(root),id:label,scope:scopeFor(f.host.actions(s.id,opened.id).find(a=>a.label===label)!,opened),prerequisites:[scopeFor(entry,o)],dispatchScope:false,status:'unresolved',reason:'operation_not_executed'});
  task.plan=[root,item('First'),item('Second')];const scheduler=()=>plugin as unknown as Scheduler;
  expect(scheduler().neededEntry(task,round,entry,o)).toBe(false); // A legacy dependency is not a route proof.
  round.entryRoutes=[route];expect(scheduler().neededEntry(task,round,entry,o)).toBe(true);scheduler().recordEntry(task,round,entry,o);
  task.plan.push({...item('Second'),id:'price-change',scope:{url:f.url,label:'Quote 999',kind:'click'}});
  expect(scheduler().neededEntry(task,round,entry,o)).toBe(false);plugin.store.save(task);const usage=structuredClone(task.usage);
  await plugin.close();plugin=new ExplorerPlugin(f.host,new ExplorerStore(file));task=plugin.store.task(task.id);round=task.rounds[0];
  expect(scheduler().neededEntry(task,round,entry,o)).toBe(false);expect(task.usage).toEqual(usage);
  const nextRound={...structuredClone(round),id:'next-round',number:2,reentries:[],reentryProgress:undefined,entryRoutes:undefined};task.rounds.push(nextRound);
  expect(scheduler().neededEntry(task,nextRound,entry,o)).toBe(false);task.rounds.pop();
  expect(plugin.store.events(task.id).filter(e=>e.type==='branch.reentry_planned')).toHaveLength(1);
  const event=plugin.store.events(task.id).find(e=>e.type==='branch.reentry_planned')!;expect((event.data as any).itemId).toBe('First');expect((event.data as any).route[0].evidence.observationId).toBe(opened.id);
  await click('Open');const source=f.host.observation(s.id),attempt=await click('First');expect(attempt.status).toBe('succeeded');
  Object.assign(task.plan.find(i=>i.id==='First')!,{status:'succeeded',resolvedBy:{sessionId:s.id,observationId:source.id,attemptId:attempt.id}});
  o=f.host.observation(s.id);entry=f.host.actions(s.id).find(a=>a.label==='Open')!;
  expect(scheduler().neededEntry(task,round,entry,o)).toBe(true);scheduler().recordEntry(task,round,entry,o);
  task.plan.push({...structuredClone(task.plan.find(i=>i.id==='First')!),id:'duplicate-success'});
  expect(scheduler().neededEntry(task,round,entry,o)).toBe(false);expect(task.usage).toEqual(usage);
  expect(task.plan.find(i=>i.id==='Second')?.status).toBe('unresolved');
  await click('Open');o=f.host.observation(s.id);entry=f.host.actions(s.id).find(a=>a.label==='Open')!;
  round.reentries=[];round.reentryProgress={}; // Visible-but-blocked work still does not justify reopening.
  expect(scheduler().neededEntry(task,round,entry,o)).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it('uses only observed chains, keeps nested routes and terminates cycles without borrowing another context',()=>{
 const scope=(label:string)=>({url:'https://fixture.test/',label,role:'button',kind:'click'}),evidence={sessionId:'s',beforeId:'before',observationId:'after'};
 const o={context:{}};
 const context='44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
 const route=(a:string,b:string)=>({entry:scope(a),targets:[scope(b)],context,evidence});
 const task={rounds:[{entryRoutes:[route('Parent','Nested'),route('Nested','Child'),route('Nested','Parent')]}]} as Task;
 expect(routeToTarget(task,scope('Parent'),scope('Child'),o)?.map(r=>r.entry.label)).toEqual(['Parent','Nested']);
 expect(routeToTarget(task,scope('Parent'),scope('Unrelated'),o)).toBeUndefined();
 expect(routeToTarget(task,scope('Parent'),scope('Child'),{context:{tenant:{status:'known',value:'other',source:'fixture'}}})).toBeUndefined();
});
