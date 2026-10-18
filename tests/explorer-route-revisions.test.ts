import {expect,it,vi} from 'vitest';
import type {ActionAttempt,ActionCandidate,Observation} from '@interaction/browser';
import {ExplorerPlugin,ExplorerStore,type EntryRoute,type Scope,type Task,type Round,type PlanItem} from '@interaction/explorer-plugin';
import {capturedRoute,routeFinder,routeKey,routeToTarget} from '../packages/explorer-plugin/src/reentry-evidence.js';
import {digest,keyFor,scopeFor} from '../packages/explorer-plugin/src/policy.js';
import {explorerFixture} from './explorer-plugin-helpers.js';
import {pageOf} from './helpers.js';

it('deduplicates a native route into the same named boundary across fresh documents',async()=>{
  const f=await explorerFixture('<button id="open" type="button" onclick="document.querySelector(\'dialog\').showModal()">Open</button><dialog aria-label="Choices"><button id="child" type="button">Child</button></dialog>');
  try{
    const capture=async()=>{
      const s=await f.host.createSession({url:f.url,headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:1000,interfaceActions:[{kind:'click'}]});
      const before=f.host.observation(s.id),action=f.host.actions(s.id).find(a=>a.label==='Open')!,attempt=await f.host.execute(s.id,action.id,crypto.randomUUID()),after=f.host.observation(s.id);
      const revealed=f.host.interactionTransition(s.id,before.id,after.id).revealedControlIds;
      const route=capturedRoute(scopeFor(action,before),before,after,revealed,attempt)!;
      expect(route.expected?.boundaryKeys).toHaveLength(1);expect(route.expected?.boundaryConditionKey).toBeDefined();
      return {route,before,after,attempt,revealed};
    };
    const a=await capture();await f.host.stop(a.before.sessionId);const b=await capture();
    expect(a.before.documentId).not.toBe(b.before.documentId);
    expect(routeKey(a.route)).toBe(routeKey(b.route));
    expect(routeKey({...b.route,expected:{...b.route.expected!,boundaryKeys:['other-instance-boundary']}})).toBe(routeKey(a.route));
    const reviewed=(reviewId:string,conditionKey='same-condition')=>capturedRoute(a.route.entry,a.before,a.after,a.revealed,{...a.attempt,action:{...a.attempt.action,basis:{status:'supported',evidence:[{source:'fixture-review',rule:'reviewed-control/v1',facts:{reviewId,sourceObservationId:reviewId,evidence:[reviewId],conditionKey,reason:'UI reveal'}}]}}})!;
    expect(routeKey(reviewed('one'))).toBe(routeKey(reviewed('two')));
    expect(routeKey(reviewed('one'))).not.toBe(routeKey(reviewed('two','changed-condition')));
  }finally{await f.close();}
});

it('preserves observed mode/policy route revisions and selects a currently verified B route after historical A',async()=>{
  const f=await explorerFixture(`<form id="settings"><select id="mode" aria-label="Mode"><option value="a">A</option><option value="b">B</option></select>
    <button id="open" type="button" onclick="document.querySelector('#menu').hidden=false">Open</button></form>
    <div id="menu" hidden><button type="button" id="nested">Nested</button></div>`);
  try{
    const s=await f.host.createSession({url:f.url,headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]});
    const open=()=>f.host.actions(s.id).find(a=>a.label==='Open'&&a.kind==='click')!;
    const capture=async()=>{
      const before=f.host.observation(s.id),action=open(),attempt=await f.host.execute(s.id,action.id,crypto.randomUUID()),after=f.host.observation(s.id);
      expect(attempt.status).toBe('succeeded');
      const route=capturedRoute(scopeFor(action,before),before,after,f.host.interactionTransition(s.id,before.id,after.id).revealedControlIds,attempt)!;
      expect(route.sourceConditionKey).toBe(keyFor(attempt.action,before));
      expect(route.sourcePolicy).toMatchObject({replayable:true,risk:'interface'});
      return {before,after,attempt,route};
    };
    const a=await capture();
    await pageOf(f.host).evaluate(()=>{document.querySelector<HTMLElement>('#menu')!.hidden=true;(document.querySelector('#mode') as HTMLSelectElement).value='b';});
    await f.host.observe(s.id);const b=await capture();
    expect(a.route.entry).toEqual(b.route.entry);expect(a.route.targets).toEqual(b.route.targets);
    expect(routeKey(a.route)).not.toBe(routeKey(b.route));
    expect(routeKey({...b.route,evidence:{sessionId:'other',beforeId:'other-before',observationId:'other-after',attemptId:'other-attempt'}})).toBe(routeKey(b.route));
    expect(routeKey({...b.route,sourcePolicy:{...b.route.sourcePolicy!,replayable:false}})).not.toBe(routeKey(b.route));
    expect(routeKey({...b.route,sourcePolicy:{...b.route.sourcePolicy!,basisKey:'different-review-basis'}})).not.toBe(routeKey(b.route));
    await pageOf(f.host).evaluate(()=>{document.querySelector<HTMLElement>('#menu')!.hidden=true;});
    const current=await f.host.observe(s.id),action=open(),task={rounds:[{entryRoutes:[a.route,b.route]}]} as Task,target=b.route.targets[0];
    const assessment=(route:EntryRoute)=>f.host.repetitionAssessment(s.id,{observationId:current.id,actionId:action.id,source:{sessionId:route.evidence.sessionId,attemptId:route.evidence.attemptId!}});
    expect(assessment(a.route).repeatable).toBe(false);expect(assessment(b.route).repeatable).toBe(true);
    // Historical bookkeeping retains insertion order; traversal selection uses
    // live SDK evidence before traversing the first edge.
    expect(routeFinder(task,scopeFor(action,current),current)(target)?.[0]).toBe(a.route);
    expect(routeFinder(task,scopeFor(action,current),current,r=>assessment(r).repeatable)(target)?.[0]).toBe(b.route);
    expect(routeFinder(task,scopeFor(action,current),current,()=>false)(target)).toBeUndefined();
    // Spending A's no-progress allowance does not erase the observed B route,
    // but returning to A still retains its debt instead of resetting on revisit.
    const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
    try{
      const saved=plugin.create({url:f.url}),round:Round={id:'r',number:1,sessionId:s.id,startedAt:new Date().toISOString(),status:'paused',actions:0,stack:[],entryPath:[],entryRoutes:[a.route,b.route],reentries:[],tried:[],reviewed:[],noProgress:0};
      const root:PlanItem={id:'root',title:'All',scope:{url:f.url},prerequisites:[],completion:'Observe branches',status:'pending',required:true,dispatchScope:true,reason:'user_goal',evidence:[],attempts:[]};
      saved.rounds=[round];saved.plan=[root,{...structuredClone(root),id:'child',scope:target,prerequisites:[a.route.entry],dispatchScope:false,status:'unresolved',reason:'operation_not_executed'}];
      const scheduler=plugin as unknown as {neededEntry(t:Task,r:Round,a:ActionCandidate,o:Observation):boolean;recordEntry(t:Task,r:Round,a:ActionCandidate,o:Observation):void};
      const mode=async(value:string)=>{await pageOf(f.host).evaluate(value=>{(document.querySelector('#mode') as HTMLSelectElement).value=value;},value);return f.host.observe(s.id);};
      const modeA=await mode('a'),entryA=open();expect(scheduler.neededEntry(saved,round,entryA,modeA)).toBe(true);scheduler.recordEntry(saved,round,entryA,modeA);
      expect(scheduler.neededEntry(saved,round,entryA,modeA)).toBe(false);
      const modeB=await mode('b'),entryB=open();expect(scheduler.neededEntry(saved,round,entryB,modeB)).toBe(true);scheduler.recordEntry(saved,round,entryB,modeB);
      const againA=await mode('a');expect(scheduler.neededEntry(saved,round,open(),againA)).toBe(false);
    }finally{await plugin.close();}
    expect(capturedRoute(a.route.entry,a.before,a.after,a.route.targets.map(t=>a.after.controls.find(c=>c.name===t.label)!.localId),{...a.attempt,status:'unknown'})).toBeUndefined();
    const wrongAction=a.before.controls.find(c=>c.stableKey==='id:mode')!;
    expect(capturedRoute(a.route.entry,a.before,a.after,[],{...a.attempt,action:{...a.attempt.action,localId:wrongAction.localId,label:'Mode',kind:'select'}})).toBeUndefined();
    expect(f.host.list<ActionAttempt>(s.id,'attempt')).toHaveLength(2);
  }finally{await f.close();}
});

it('does not downgrade a selected reentry into fresh execution when its permission changes during checkpoint creation',async()=>{
  const f=await explorerFixture('<button id="open" type="button" onclick="document.querySelector(\'#menu\').hidden=false">Open</button><div id="menu" hidden><button id="child" type="button">Child</button></div>');
  let plugin:ExplorerPlugin|undefined;
  try{
    const s=await f.host.createSession({url:f.url,headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100,regionExploration:'off',pageExploration:'all',listExploration:'all',interfaceActions:[{kind:'click'}]});
    const before=f.host.observation(s.id),action=f.host.actions(s.id).find(a=>a.label==='Open')!,attempt=await f.host.execute(s.id,action.id,'historical-open'),after=f.host.observation(s.id);
    const route=capturedRoute(scopeFor(action,before),before,after,f.host.interactionTransition(s.id,before.id,after.id).revealedControlIds,attempt)!;
    await pageOf(f.host).evaluate(()=>{document.querySelector<HTMLElement>('#menu')!.hidden=true;});
    const current=await f.host.observe(s.id),entry=f.host.actions(s.id).find(a=>a.label==='Open')!;
    const host=new Proxy(f.host,{get(target,key){
      if(key==='createCheckpoint')return async(...args:Parameters<typeof target.createCheckpoint>)=>{
        const result=await target.createCheckpoint(...args);
        target.store.put('attempt',{...attempt,action:{...attempt.action,replayable:false}});
        return result;
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'));
    const task=plugin.create({url:f.url,budget:{actions:8,rounds:1}}),round:Round={id:'r',number:1,sessionId:s.id,startedAt:new Date().toISOString(),status:'running',actions:0,stack:[],entryPath:[],entryRoutes:[route],reentries:[],tried:[keyFor(entry,current)],reviewed:[],noProgress:0};
    const root:PlanItem={id:'root',title:'All',scope:{url:f.url},prerequisites:[],completion:'Observe branches',status:'pending',required:true,dispatchScope:true,reason:'user_goal',evidence:[],attempts:[]};
    task.rounds=[round];task.plan=[root,{...structuredClone(root),id:'child',scope:route.targets[0],prerequisites:[route.entry],dispatchScope:false,status:'unresolved',reason:'operation_not_executed'}];task.status='running';plugin.store.save(task);
    const scheduler=plugin as unknown as {step(t:Task,r:Round,signal:AbortSignal):Promise<boolean>;neededEntry(t:Task,r:Round,a:ActionCandidate,o:Observation):boolean};
    expect(scheduler.neededEntry(task,round,entry,current)).toBe(true);
    const dispatch=vi.spyOn(f.host,'execute');
    await expect(scheduler.step(task,round,new AbortController().signal)).rejects.toMatchObject({code:'REENTRY_EVIDENCE_CHANGED'});
    expect(dispatch).not.toHaveBeenCalled();expect(f.host.list<ActionAttempt>(s.id,'attempt')).toHaveLength(1);
    expect(f.host.list<ActionAttempt>(s.id,'attempt')[0].status).toBe('succeeded');
    expect(task.pendingDispatch).toBeUndefined();expect(round.reentries).toEqual([]);
  }finally{await plugin?.close();await f.close();}
});

it('filters only first edges, preserving nested paths, cycles and legacy route bookkeeping',()=>{
  const scope=(label:string):Scope=>({url:'https://fixture.test/',label,role:'button',kind:'click'}),context=digest({});
  const route=(entry:string,target:string,condition:string):EntryRoute=>({entry:scope(entry),targets:[scope(target)],context,sourceConditionKey:condition,evidence:{sessionId:'s',beforeId:'before',observationId:'after'}});
  const a=route('Open','Nested','A'),b=route('Open','Nested','B'),nested=route('Nested','Child','nested'),cycle=route('Nested','Open','cycle');
  const task={rounds:[{entryRoutes:[a,b,nested,cycle]}]} as Task,predicate=vi.fn((route:EntryRoute)=>route.sourceConditionKey==='B');
  const finder=routeFinder(task,scope('Open'),{context:{}},predicate);
  expect(finder(scope('Child'))).toEqual([b,nested]);expect(finder(scope('Missing'))).toBeUndefined();
  expect(predicate.mock.calls.map(([r])=>r)).toEqual([a,b]);
  expect(routeToTarget(task,scope('Open'),scope('Child'),{context:{}})).toEqual([a,nested]);
  expect(routeToTarget(task,scope('Open'),scope('Child'),{context:{tenant:{status:'known',source:'fixture',value:'other'}}},predicate)).toBeUndefined();
  expect(routeKey({...a,targets:[scope('Nested'),scope('Child')]})).toBe(routeKey({...a,targets:[scope('Child'),scope('Nested'),scope('Child')]}));
  expect(routeKey({...a,sourceConditionKey:undefined})).not.toBe(routeKey(a));
});

it('bridges only the current first occurrence with independent SDK permission and keeps historical deeper edges exact',()=>{
  const scope=(label:string,key:string):Scope=>({url:'https://fixture.test/',label,role:'button',kind:'click',stableKey:key});
  const route=(entry:Scope,target:Scope):EntryRoute=>({entry,targets:[target],context:digest({}),evidence:{sessionId:'s',beforeId:'before',observationId:'after'}});
  const old=scope('Open','old-record'),current=scope('Open','new-record'),nested=scope('Nested','nested-old'),child=scope('Child','child');
  const first=route(old,nested),second=route(nested,child),impostor=route(scope('Nested','nested-other'),scope('Unrelated','unrelated'));
  const task={rounds:[{entryRoutes:[first,second,impostor]}]} as Task;
  expect(routeFinder(task,current,{context:{}})(child)).toBeUndefined();
  const permitted=vi.fn((r:EntryRoute)=>r===first);
  const find=routeFinder(task,current,{context:{}},undefined,permitted);
  expect(find(child)).toEqual([first,second]);expect(find(impostor.targets[0])).toBeUndefined();
  expect(routeFinder(task,current,{context:{}},()=>false,permitted)(child)).toBeUndefined();
  expect(routeFinder(task,current,{context:{tenant:{status:'known',source:'fixture',value:'changed'}}},undefined,permitted)(child)).toBeUndefined();
});
