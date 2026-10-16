import { expect, it } from 'vitest';
import type { Page } from 'playwright';
import { ExplorerPlugin, ExplorerStore, type PlanItem, type Round, type Task } from '@interaction/explorer-plugin';
import type { ActionCandidate, Observation } from '@interaction/browser';
import { completedOperations } from '../packages/explorer-plugin/src/completion-evidence.js';
import { includesScope, matches, scopeFor } from '../packages/explorer-plugin/src/policy.js';
import { explorerFixture } from './explorer-plugin-helpers.js';

const html='<script>window.executed=[]</script><div aria-label="Owner A" id="owner-a"><button id="shared" type="button" onclick="executed.push(\'A\')">Run</button></div><div aria-label="Owner B" id="owner-b"><button id="shared" type="button" onclick="executed.push(\'B\')">Run</button></div>';
const options={headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:1000,actionTimeoutMs:2000,maxActions:8,contextRules:[],regionExploration:'off',pageExploration:'all',listExploration:'all',interfaceActions:[{kind:'click'}]};
const pageOf=(f:Awaited<ReturnType<typeof explorerFixture>>)=>(f.host as unknown as {driver:{page:Page}}).driver.page;
const runActions=(f:Awaited<ReturnType<typeof explorerFixture>>,sid:string)=>f.host.actions(sid).filter(a=>a.kind==='click'&&a.label==='Run');
const owner=(a:ActionCandidate,o:Observation)=>o.controls.find(c=>c.localId===a.localId)?.identityContext?.scope;
function proof(source:ActionCandidate,o:Observation,attemptId:string):PlanItem {
  const ref={sessionId:o.sessionId,observationId:o.id,attemptId};
  return {id:'source-proof',title:'Run',scope:scopeFor(source,o),prerequisites:[],completion:'Execute',status:'succeeded',required:true,dispatchScope:false,reason:'action_verified',evidence:[ref],resolvedBy:ref,attempts:[]};
}

it('dispatches both simultaneously available shared-id targets under their different captured owners',async()=>{
  const f=await explorerFixture(html),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
  try {
    const created=plugin.create({url:f.url,budget:{rounds:1,actions:8,durationMs:60000,modelRequests:8},sessionOptions:{headless:true,settleMs:0,observeTimeoutMs:1000,actionTimeoutMs:2000,maxActions:8}});
    plugin.revise(created.id,{items:[{title:'Both',scope:{url:f.url,kind:'click'},prerequisites:[],completion:'Execute every encountered click',required:true,reason:'user goal'}]});
    const session=await f.host.createSession({...options,url:f.url}),before=f.host.observation(session.id),actions=runActions(f,session.id);
    expect(actions).toHaveLength(2);
    const availability=f.host.actionAvailability(session.id,before.id);
    expect(actions.every(a=>availability.actions.find(row=>row.actionId===a.id)?.executable)).toBe(true);
    expect(new Set(actions.map(a=>a.controlId)).size).toBe(2);
    expect(new Set(actions.map(a=>owner(a,before))).size).toBe(2);
    const task=plugin.store.task(created.id),round:Round={id:'round',number:1,sessionId:session.id,startedAt:new Date().toISOString(),status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};
    task.rounds=[round];task.status='running';plugin.store.save(task);
    const runtime=plugin as unknown as {step(task:Task,round:Round,signal:AbortSignal):Promise<boolean>};
    for(let n=0;n<4;n++)await runtime.step(task,round,new AbortController().signal);
    expect(await pageOf(f).evaluate(()=>Reflect.get(window,'executed'))).toEqual(['A','B']);
    expect(new Set(task.plan.filter(i=>i.status==='succeeded'&&i.dispatchScope===false&&i.scope.label==='Run').map(i=>JSON.stringify(i.scope))).size).toBe(2);
    expect(f.host.list(session.id,'attempt')).toHaveLength(2);
    expect(task.plan.some(i=>i.reason==='ambiguous_scope_match'&&i.scope.label==='Run')).toBe(false);
  }finally {await plugin.close();await f.close();}
});

it.each(['same','changed-owner','changed-context','unknown-source','ambiguous-owner'] as const)('checks cold-rebuilt shared targets with retained and legacy scopes: %s',async change=>{
  let markup=html;const f=await explorerFixture(()=>`${markup}<span id="account">${change==='changed-context'&&restarted?'two':'one'}</span>`),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
  let restarted=false;
  try {
    const sessionOptions={...options,url:f.url,contextRules:[{key:'account',selector:'#account',required:true}]};
    const first=await f.host.createSession(sessionOptions),before=f.host.observation(first.id),a=runActions(f,first.id).find(a=>owner(a,before)?.includes('Owner A'))!;
    const attempt=await f.host.execute(first.id,a.id,'source-a');expect(attempt.status).toBe('succeeded');
    const task=plugin.create({url:f.url}),item=proof(a,before,attempt.id);task.plan=[item];
    await f.host.stop(first.id);restarted=true;
    if(change==='changed-owner')markup=html.replace('Owner A','Owner C');
    if(change==='ambiguous-owner')markup=html.replace('Owner B','Owner A');
    if(change==='unknown-source')f.host.store.put('attempt',{...attempt,status:'unknown'});
    const next=await f.host.createSession(sessionOptions),after=f.host.observation(next.id),actions=runActions(f,next.id);
    const check=()=>{
      const covered=[...completedOperations(f.host,task,after,actions)];
      expect(covered.map(a=>owner(a,after))).toEqual(change==='same'?[owner(a,before)]:[]);
      expect(f.host.list(next.id,'attempt')).toEqual([]);
    };
    check();
    // A pre-upgrade row has no captured-binding field. Its real successful
    // attempt still goes to the SDK; no key rewrite or fabricated success.
    item.scope={url:f.url,stableKey:'id:shared',label:'Run',role:'button',kind:'click'};
    check();
  }finally {await plugin.close();await f.close();}
});

it('keeps completely indistinguishable shared targets ambiguous instead of selecting by DOM position',async()=>{
  const f=await explorerFixture(html.replaceAll('Owner B','Owner A')),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
  try {
    const created=plugin.create({url:f.url,budget:{rounds:1,actions:8,durationMs:60000,modelRequests:8},sessionOptions:{headless:true,settleMs:0,observeTimeoutMs:1000,actionTimeoutMs:2000,maxActions:8}});
    plugin.revise(created.id,{items:[{title:'Both',scope:{url:f.url,kind:'click'},prerequisites:[],completion:'Execute',required:true,reason:'user goal'}]});
    const session=await f.host.createSession({...options,url:f.url}),task=plugin.store.task(created.id),round:Round={id:'round',number:1,sessionId:session.id,startedAt:new Date().toISOString(),status:'running',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0};
    task.rounds=[round];task.status='running';plugin.store.save(task);
    const runtime=plugin as unknown as {step(task:Task,round:Round,signal:AbortSignal):Promise<boolean>};
    for(let n=0;n<4;n++)await runtime.step(task,round,new AbortController().signal);
    expect(await pageOf(f).evaluate(()=>Reflect.get(window,'executed'))).toEqual([]);
    expect(task.plan.some(i=>i.reason==='ambiguous_scope_match'&&i.scope.label==='Run')).toBe(true);
    expect(task.plan.every(i=>i.status!=='succeeded')).toBe(true);
  }finally {await plugin.close();await f.close();}
});

it('retains literal old scope authority and exclusions while a captured owner can narrow a target',async()=>{
  const f=await explorerFixture(html);
  try {
    const s=await f.host.createSession({...options,url:f.url}),o=f.host.observation(s.id),actions=runActions(f,s.id),a=actions.find(a=>owner(a,o)?.includes('Owner A'))!,b=actions.find(a=>owner(a,o)?.includes('Owner B'))!;
    const root:PlanItem={id:'root',title:'Run',scope:{url:f.url,stableKey:'id:shared',label:'Run',kind:'click'},prerequisites:[],completion:'Execute',status:'pending',required:true,dispatchScope:true,reason:'user_goal',evidence:[],attempts:[]};
    expect(actions.every(action=>includesScope([root],action,o)==='target')).toBe(true);
    const exclusion={...root,id:'exclude',scope:scopeFor(a,o),status:'excluded' as const,required:false,reason:'user_excluded'};
    expect(includesScope([root,exclusion],a,o)).toBeUndefined();
    expect(includesScope([root,exclusion],b,o)).toBe('target');
    const oldExclusion={...exclusion,scope:root.scope};
    expect(actions.every(action=>includesScope([root,oldExclusion],action,o)===undefined)).toBe(true);
  }finally {await f.close();}
});

it('never transfers A coverage or its pending target to rebuilt B, but retains B scope through reconstruction',async()=>{
  const f=await explorerFixture(html),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
  try {
    const s=await f.host.createSession({...options,url:f.url}),before=f.host.observation(s.id),actions=runActions(f,s.id),a=actions.find(a=>owner(a,before)?.includes('Owner A'))!,b=actions.find(a=>owner(a,before)?.includes('Owner B'))!;
    const aScope=scopeFor(a,before),bScope=scopeFor(b,before),attempt=await f.host.execute(s.id,a.id,'source-a');expect(attempt.status).toBe('succeeded');
    const task=plugin.create({url:f.url});task.plan=[proof(a,before,attempt.id)];
    await pageOf(f).evaluate(()=>{document.querySelector('#owner-a')!.remove();const b=document.querySelector('#owner-b button')!;b.replaceWith(b.cloneNode(true));});
    const after=await f.host.observe(s.id),remaining=runActions(f,s.id);expect(remaining).toHaveLength(1);
    expect(matches(aScope,remaining[0],after)).toBe(false);
    expect(scopeFor(remaining[0],after)).toEqual(bScope);
    expect(completedOperations(f.host,task,after,remaining).size).toBe(0);
    // The old discovery record lacks the new hint. SDK correspondence must still
    // reject A -> B rather than accepting the coarse same-name/same-id scope.
    task.plan[0].scope={url:f.url,stableKey:'id:shared',label:'Run',role:'button',kind:'click'};
    expect(completedOperations(f.host,task,after,remaining).size).toBe(0);
  }finally {await plugin.close();await f.close();}
});
