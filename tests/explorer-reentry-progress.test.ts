import {expect,it} from 'vitest';
import {join} from 'node:path';
import type {ActionCandidate,Observation} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type Task,type Round,type PlanItem} from '@interaction/explorer-plugin';
import {scopeFor} from '../packages/explorer-plugin/src/policy.js';
import {capturedRoute,routeToTarget} from '../packages/explorer-plugin/src/reentry-evidence.js';
import {explorerFixture} from './explorer-plugin-helpers.js';

type Scheduler={freshAction(t:Task,r:Round,a:ActionCandidate,o:Observation,completed:boolean):boolean;neededEntry(t:Task,r:Round,a:ActionCandidate,o:Observation):boolean;recordEntry(t:Task,r:Round,a:ActionCandidate,o:Observation):void};
it('requires observed target routes and a new child completion before repeating entry, across restart',async()=>{
 const f=await explorerFixture(`<button id="open" type="button" onclick="document.getElementById('menu').hidden=false">Open</button><div id="menu" hidden><button id="first" onclick="this.disabled=true;document.getElementById('menu').hidden=true">First</button><button id="second">Second</button></div><button id="close" onclick="document.getElementById('menu').hidden=true">Close</button>`),file=join(f.dir,'reentry.sqlite');
 let plugin=new ExplorerPlugin(f.host,new ExplorerStore(file));
 try{
  const s=await f.host.createSession({url:f.url,headless:true,settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]});
  const click=async(label:string)=>f.host.execute(s.id,f.host.actions(s.id).find(a=>a.label===label&&a.kind==='click')!.id,crypto.randomUUID());
  const initial=f.host.observation(s.id),open=f.host.actions(s.id).find(a=>a.label==='Open')!,openedAttempt=await click('Open');const opened=f.host.observation(s.id);
  const route=capturedRoute(scopeFor(open,initial),initial,opened,f.host.interactionTransition(s.id,initial.id,opened.id).revealedControlIds)!;expect(route.targets.map(s=>s.label)).toEqual(['First','Second']);
  await click('Close');let o=f.host.observation(s.id),entry=f.host.actions(s.id).find(a=>a.label==='Open')!;
  let task=plugin.create({url:f.url}),round:Round={id:'round',number:1,sessionId:s.id,startedAt:new Date().toISOString(),status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};
  task.rounds=[round];task.usage={rounds:1,actions:7,modelRequests:9,durationMs:1234};
  const root:PlanItem={id:'root',title:'All',scope:{url:f.url},prerequisites:[],completion:'Fresh evidence',status:'pending',required:true,dispatchScope:true,reason:'user_goal',evidence:[],attempts:[]};
  const item=(label:string):PlanItem=>({...structuredClone(root),id:label,scope:scopeFor(f.host.actions(s.id,opened.id).find(a=>a.label===label)!,opened),prerequisites:[scopeFor(entry,o)],dispatchScope:false,status:'unresolved',reason:'operation_not_executed'});
  task.plan=[root,item('First'),item('Second')];const scheduler=()=>plugin as unknown as Scheduler;
  expect(scheduler().neededEntry(task,round,entry,o)).toBe(false); // A legacy dependency is not a route proof.
  task.plan.push({...structuredClone(root),id:'historical-entry',scope:scopeFor(open,initial),dispatchScope:false,status:'succeeded',resolvedBy:{sessionId:s.id,observationId:initial.id,attemptId:openedAttempt.id}});
  expect(scheduler().neededEntry(task,round,entry,o)).toBe(true);expect(round.entryRoutes).toEqual([route]);
  expect(plugin.store.events(task.id).find(e=>e.type==='branch.route_recovered')?.data).toMatchObject({historicalEvidenceOnly:true,executionAuthorized:false,evidence:{attemptId:openedAttempt.id}});
  expect(f.host.list(s.id,'attempt')).toHaveLength(2);scheduler().recordEntry(task,round,entry,o);
  task.plan.push({...item('Second'),id:'price-change',scope:{url:f.url,label:'Quote 999',kind:'click'}});
  expect(scheduler().neededEntry(task,round,entry,o)).toBe(false);plugin.store.save(task);const usage=structuredClone(task.usage);
  await plugin.close();plugin=new ExplorerPlugin(f.host,new ExplorerStore(file));task=plugin.store.task(task.id);round=task.rounds[0];
  expect(scheduler().neededEntry(task,round,entry,o)).toBe(false);expect(task.usage).toEqual(usage);
  // A new document or changed review can make the host reject old operation
  // equivalence. That does not restore an entry's no-progress allowance.
  expect(scheduler().freshAction(task,round,entry,o,false)).toBe(false);
  expect(plugin.store.events(task.id).filter(e=>e.type==='branch.revalidation_deferred')).toHaveLength(1);
  expect(task.plan.find(i=>i.reason==='entry_revalidation_deferred')).toMatchObject({status:'unresolved',dispatchScope:false});
  expect(task.usage).toEqual(usage);
  const nextRound={...structuredClone(round),id:'next-round',number:2,reentries:[],reentryProgress:undefined,entryRoutes:undefined};task.rounds.push(nextRound);
  expect(scheduler().neededEntry(task,nextRound,entry,o)).toBe(false);expect(scheduler().freshAction(task,nextRound,entry,o,false)).toBe(false);task.rounds.pop();
  expect(scheduler().freshAction(task,round,entry,{...o,context:{tenant:{status:'known',value:'other',source:'fixture'}}},false)).toBe(true);
  expect(scheduler().freshAction(task,round,{...entry,value:'different'},o,false)).toBe(true);
  expect(scheduler().freshAction(task,round,{...entry,boundary:{intent:'exit',key:'active'} as ActionCandidate['boundary']},{...o,boundaries:[{key:'active'}] as Observation['boundaries']},false)).toBe(true);
  expect(plugin.store.events(task.id).filter(e=>e.type==='branch.reentry_planned')).toHaveLength(1);
  const event=plugin.store.events(task.id).find(e=>e.type==='branch.reentry_planned')!;expect((event.data as any).itemId).toBe('First');expect((event.data as any).route[0].evidence.observationId).toBe(opened.id);
  await click('Open');const source=f.host.observation(s.id),attempt=await click('First');expect(attempt.status).toBe('succeeded');
  Object.assign(task.plan.find(i=>i.id==='First')!,{status:'succeeded',resolvedBy:{sessionId:s.id,observationId:source.id,attemptId:attempt.id}});
  o=f.host.observation(s.id);entry=f.host.actions(s.id).find(a=>a.label==='Open')!;
  expect(scheduler().freshAction(task,round,entry,o,false)).toBe(true);expect(scheduler().neededEntry(task,round,entry,o)).toBe(true);scheduler().recordEntry(task,round,entry,o);
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

it.each(['unknown','executing','failed'])('does not reconstruct legacy routes from a %s operation',status=>{
 const control={localId:'entry',name:'Open',role:'button',stableKey:'id:open'},o={sessionId:'s',id:'o',url:'https://fixture.test/',controls:[control],regions:[],context:{}} as unknown as Observation;
 const action={localId:'entry',label:'Open',kind:'click'} as ActionCandidate,scope=scopeFor(action,o);
 const attempt={id:'source',sessionId:'s',status,afterId:'after'};
 let reads=0;const plugin=Object.create(ExplorerPlugin.prototype) as any;
 plugin.host={list:()=>[attempt],observation:()=>{reads++;throw new Error('Unknown results have no route proof');}};
 plugin.store={save:()=>{throw new Error('No route should be saved');}};
 const round={sessionId:'s'} as Round,task={plan:[{scope,resolvedBy:{sessionId:'s',attemptId:'source'},attempts:[]}],rounds:[round]} as unknown as Task;
 plugin.restoreEntryRoutes(task,round,action,o);
 expect(reads).toBe(0);expect(round.entryRoutes).toBeUndefined();expect(attempt.status).toBe(status);
});
