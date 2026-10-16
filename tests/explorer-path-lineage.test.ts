import {expect,it,vi} from 'vitest';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {scopeFor} from '../packages/explorer-plugin/src/policy.js';
import {explorerFixture,fakeProviders} from './explorer-plugin-helpers.js';

function lineage() {
 const a={localId:'entry',instanceId:'entry-instance',name:'Second',role:'button',tag:'button',visible:true,enabled:true,stableKey:'id:second'};
 const before={id:'before',sessionId:'s',url:'https://fixture.test/',instanceScope:'document',controls:[a],regions:[],context:{},boundaries:[],gaps:[]};
 const after={...structuredClone(before),id:'after',controls:[{...a,localId:'new-local'}]};
 const action={id:'a',localId:'new-local',label:'Second',kind:'click'} as any;
 const first={url:before.url,label:'First',kind:'click'},round={entryPath:[first],stack:[{observationId:'before',remaining:[],path:[]}]} as any;
 const transition={verified:true,navigated:false,entered:[],exited:[],revealedControlIds:['child'],retainedControls:[{beforeLocalId:'entry',afterLocalId:'new-local'}]};
 const host={observation:vi.fn(()=>before),interactionTransition:vi.fn(()=>transition),boundaryState:vi.fn(()=>({verified:true}))};
 const plugin=Object.create(ExplorerPlugin.prototype) as any;plugin.host=host;
 const task={plan:[]};
 return {plugin,host,task,round,before,after,action,first,transition};
}

it('uses observed occurrence continuity for a sibling absent from frame.remaining and starts its own branch',()=>{
 const f=lineage(),path=f.plugin.pathForAction(f.round,f.action,f.after);expect(path).toEqual([]);
 f.plugin.trackTransition(f.task,f.round,f.after,{...f.after,id:'result'},scopeFor(f.action,f.after as any),path);
 expect(f.round.entryPath.map((s:any)=>s.label)).toEqual(['Second']);
 expect(f.round.stack[0].remaining).toEqual([]);
});

it.each(['same-name-new-occurrence','changed-target','new-document','changed-context','unverified'] as const)('does not shorten a necessary path using %s',change=>{
 const f=lineage();f.round.stack[0].remaining=[scopeFor(f.action,f.after as any)];
 if(change==='same-name-new-occurrence')f.transition.retainedControls=[];
 if(change==='changed-target'){f.round.stack[0].remaining=[];f.before.controls[0].name='Different';}
 if(change==='new-document')f.after.instanceScope='another-document';
 if(change==='changed-context')Object.assign(f.after.context,{tenant:{status:'known',value:'another'}});
 if(change==='unverified'){f.transition.verified=false;f.transition.retainedControls=[];}
 expect(f.plugin.pathForAction(f.round,f.action,f.after)).toEqual([f.first]);
});

it('preserves nested entry paths and restores the observed outside route before considering newly visible exit siblings',()=>{
 const f=lineage(),navigate={label:'Go to page',kind:'click'},open={label:'Open dialog',kind:'click'},disclose={label:'Show details',kind:'click'};
 f.round.stack=[{observationId:'before',remaining:[],path:[navigate]}];f.round.entryPath=[navigate,open,disclose];
 f.transition.exited=['dialog'] as never;f.transition.revealedControlIds=['background'];
 f.plugin.trackTransition(f.task,f.round,{...f.before,boundaries:[{key:'dialog'}]},f.after,{label:'Close',kind:'click'},[navigate,open,disclose]);
 expect(f.round.entryPath).toEqual([navigate]);
 f.transition.exited=[];f.transition.entered=['nested'] as never;
 f.plugin.trackTransition(f.task,f.round,f.before,f.after,{label:'Nested',kind:'click'},[navigate,open]);
 expect(f.round.entryPath).toEqual([navigate,open,{label:'Nested',kind:'click'}]);
});

it('does not alter the route on an unverified transition',()=>{
 const f=lineage();f.transition.verified=false;
 f.plugin.trackTransition(f.task,f.round,f.before,f.after,{label:'Second',kind:'click'},[]);
 expect(f.round.entryPath).toEqual([f.first]);
});

it('records independent disclosures and their children on separate routes while preserving all execution obligations',async()=>{
 const f=await explorerFixture(`<button id="first" type="button" onclick="document.getElementById('a').hidden=false">First FAQ</button><button id="second" type="button" onclick="document.getElementById('b').hidden=false">Second FAQ</button><div id="a" hidden><button type="button" onclick="this.disabled=true">First child</button></div><div id="b" hidden><button type="button" onclick="this.disabled=true">Second child</button></div>`),providers=fakeProviders(f.url);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers);
 try{
  const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:4}});plugin.start(t.id);await plugin.waitForIdle();
  const task=plugin.view(t.id).task,attempts=f.host.list<any>(task.rounds[0].sessionId,'attempt');
  // Ready children retain locality before another disclosure; route lineage must
  // still keep the second FAQ independent of the first branch.
  expect(attempts.map(a=>a.action.label)).toEqual(['First FAQ','First child','Second FAQ','Second child']);expect(attempts.every(a=>a.status==='succeeded')).toBe(true);
  for(const [label,path] of [['First FAQ',[]],['Second FAQ',[]],['First child',['First FAQ']],['Second child',['Second FAQ']]] as const){
   const items=task.plan.filter(i=>i.scope.label===label&&i.scope.kind==='click');expect(items.length).toBeGreaterThan(0);
   expect(items.every(i=>JSON.stringify(i.prerequisites.map(p=>p.label))===JSON.stringify(path)),JSON.stringify(items)).toBe(true);
  }
  expect(task.usage.actions).toBe(4);expect(task.exhaustive).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it('reads continuity once per frame within a synchronous pass and rechecks on the next pass',()=>{
 const f=lineage(),resolve=f.plugin.pathResolver(f.round,f.after),scope=scopeFor(f.action,f.after as any);
 expect(resolve(scope,f.action.localId)).toEqual([]);expect(resolve(scope,f.action.localId)).toEqual([]);
 expect(f.host.interactionTransition).toHaveBeenCalledTimes(1);
 f.transition.retainedControls=[];
 expect(f.plugin.pathResolver(f.round,f.after)(scope,f.action.localId)).toEqual([f.first]);
 expect(f.host.interactionTransition).toHaveBeenCalledTimes(2);
 f.after.instanceScope='other';f.plugin.pathResolver(f.round,f.after)(scope,f.action.localId);
 expect(f.host.interactionTransition).toHaveBeenCalledTimes(2);
});
