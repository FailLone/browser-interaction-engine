import {expect,it,vi} from 'vitest';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {explorerFixture,fakeProviders} from './explorer-plugin-helpers.js';
import {pageOf} from './helpers.js';

// This restoration contract starts with an unfinished control unavailable until
// the route is visited; model ranking no longer dictates an artificial order.
function routePrerequisite(host:any,sourceReturn=true){let left=false;return new Proxy(host,{get(target,key){
 if(key==='returnToObservedSource'&&!sourceReturn)return undefined;
 if(key==='explorationSnapshot')return(...args:any[])=>{const v=target.explorationSnapshot(...args);if(left)return v;return {...v,availability:{...v.availability,actions:v.availability.actions.map((fact:any)=>v.actions.find((a:any)=>a.id===fact.actionId)?.label==='Leave'?fact:{...fact,executable:false,blockers:[{code:'ACTION_BLOCKED',reason:'fixture_route_precondition',evidence:[]}]})}};};
 if(key==='actionAvailability')return(...args:any[])=>{const v=target.actionAvailability(...args);if(left)return v;const actions=target.actions(args[0]);return {...v,actions:v.actions.map((fact:any)=>actions.find((a:any)=>a.id===fact.actionId)?.label==='Leave'?fact:{...fact,executable:false,blockers:[{code:'ACTION_BLOCKED',reason:'fixture_route_precondition',evidence:[]}]})};};
 if(key==='execute')return async(...args:any[])=>{const a=await target.execute(...args);if(a.action.label==='Leave')left=true;return a;};
 const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}});}

it('requests host-verified return to the accepted page after navigation without asking a model to rediscover the task boundary',async()=>{
 const f=await explorerFixture(`<a href="/elsewhere">Leave</a><button id="remaining" type="button" onclick="this.disabled=true">Remaining</button><script>if(location.pathname==='/elsewhere')document.body.innerHTML='<p>Destination</p>'</script>`),providers=fakeProviders(f.url),decide=providers.jev.decide;
 providers.jev.decide=async(r,s)=>{if(r.purpose==='next-action'){const entry=Object.entries(r.options!).find(([,o])=>(o as any).label==='Leave');if(entry)return {model:'fixture',value:entry[0],confidence:1};}return decide(r,s);};
 const plugin=new ExplorerPlugin(routePrerequisite(f.host),new ExplorerStore(':memory:'),providers);
 try{
  const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});plugin.start(task.id);await plugin.waitForIdle();const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId;
  expect(view.task.status,JSON.stringify({reason:view.task.reason,events:view.events.filter(e=>e.type.startsWith('recovery.'))})).toBe('completed');
  const attempts=f.host.list<any>(sid,'attempt');expect(attempts.map(a=>a.action.label)).toEqual(['Leave','Return to observed page','Remaining']);expect(attempts.every(a=>a.status==='succeeded')).toBe(true);
  expect(view.events.find(e=>e.type==='recovery.selected')?.data).toMatchObject({reason:'unfinished_observed_targets',hostVerificationRequired:true});
  expect(view.events.find(e=>e.type==='recovery.result')?.data).toMatchObject({status:'TARGET_REACHED',checkpointVerified:false,currentExecution:false});
  expect(view.decisions.some(d=>d.purpose==='recovery-selection')).toBe(false);expect(view.task.usage.actions).toBe(3);
 }finally{await plugin.close();await f.close();}
});

it.each(['UNVERIFIED','UNREACHABLE'] as const)('legacy host retains unfinished work after %s without inventing success or retrying the same route',async(status)=>{
 const f=await explorerFixture(`<a href="/elsewhere">Leave</a><button type="button" onclick="document.documentElement.dataset.remaining=String(Number(document.documentElement.dataset.remaining||0)+1)">Remaining</button><script>if(location.pathname==='/elsewhere')document.body.innerHTML='<p>Destination</p>'</script>`),providers=fakeProviders(f.url),decide=providers.jev.decide;
 providers.jev.decide=async(r,s)=>{if(r.purpose==='next-action'){const entry=Object.entries(r.options!).find(([,o])=>(o as any).label==='Leave');if(entry)return {model:'fixture',value:entry[0],confidence:1};}return decide(r,s);};
 const checkpoint=vi.spyOn(f.host,'reachCheckpoint').mockImplementation(async(sid,id)=>({id:'strict-unverified',sessionId:sid,checkpointId:id,status,reason:'Fixture: history entry no longer available',checks:[],attemptIds:[],observationId:f.host.observation(sid).id,remainingFrontier:1}));
 const recovery=vi.spyOn(f.host,'reachExplorationTarget').mockImplementation(async(sid,input)=>({id:'unverified',sessionId:sid,checkpointId:input.checkpointId,targetObservationId:input.observationId,targetActionIds:input.actionIds,matchedActionIds:[],matches:[],checkpointVerified:false,currentExecution:false,executionAuthorized:false,status,reason:'Fixture: history entry no longer available',checks:[],attemptIds:[],observationId:f.host.observation(sid).id,remainingFrontier:1}));
 const plugin=new ExplorerPlugin(routePrerequisite(f.host,false),new ExplorerStore(':memory:'),providers);
 try{
  const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(recovery).toHaveBeenCalledTimes(1);expect(checkpoint).toHaveBeenCalledTimes(1);expect(v.task.status).not.toBe('completed');
  expect(v.task.plan.some(i=>i.scope.label==='Remaining'&&i.required&&i.status!=='succeeded')).toBe(true);
  expect(v.events.find(e=>e.type==='recovery.result')?.data).toMatchObject({status});
  const item=v.task.plan.find(i=>i.scope.label==='Remaining'&&i.required&&i.status!=='succeeded')!;
  expect(v.task.obligations?.entries.find(e=>e.itemId===item.id)).toMatchObject({state:status==='UNREACHABLE'?'unreachable':'waiting',reason:'Fixture: history entry no longer available'});
  expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').map(a=>a.action.label)).toEqual(['Leave']);expect(v.task.usage.actions).toBe(1);
  expect(await pageOf(f.host).evaluate(()=>Number(document.documentElement.dataset.remaining||0))).toBe(0);expect(item.attempts).toEqual([]);expect(item.resolvedBy).toBeUndefined();
 }finally{await plugin.close();await f.close();}
});


it.each(['UNVERIFIED','UNREACHABLE'] as const)('legacy host uses one strict checkpoint fallback after target verification is %s, then requires a real click before completion',async(status)=>{
 const f=await explorerFixture(`<a href="/elsewhere">Leave</a><button type="button" onclick="document.documentElement.dataset.remaining=String(Number(document.documentElement.dataset.remaining||0)+1)">Remaining</button><script>if(location.pathname==='/elsewhere')document.body.innerHTML='<p>Destination</p>'</script>`),providers=fakeProviders(f.url);
 const recovery=vi.spyOn(f.host,'reachExplorationTarget').mockImplementation(async(sid,input)=>({id:'target-proof-unavailable',sessionId:sid,checkpointId:input.checkpointId,targetObservationId:input.observationId,targetActionIds:input.actionIds,matchedActionIds:[],matches:[],checkpointVerified:false,currentExecution:false,executionAuthorized:false,status,reason:'Fixture: target verification unavailable; strict checkpoint verification remains available',checks:[],attemptIds:[],observationId:f.host.observation(sid).id,remainingFrontier:1}));
 // This is a stronger verification goal for the same checkpoint, not evidence
 // of a different known path. The real SDK performs and verifies the return.
 const checkpoint=vi.spyOn(f.host,'reachCheckpoint'),plugin=new ExplorerPlugin(routePrerequisite(f.host,false),new ExplorerStore(':memory:'),providers);
 try{
  const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});plugin.start(task.id);await plugin.waitForIdle();const v=plugin.view(task.id),sid=v.task.rounds[0].sessionId;
  expect(recovery).toHaveBeenCalledTimes(1);expect(checkpoint).toHaveBeenCalledTimes(1);expect(checkpoint.mock.calls[0]).toEqual([sid,recovery.mock.calls[0][1].checkpointId]);
  expect(v.events.filter(e=>e.type==='recovery.result').map(e=>(e.data as any).status)).toEqual([status,'REACHED_VERIFIED']);
  const attempts=f.host.list<any>(sid,'attempt');expect(attempts.map(a=>[a.action.label,a.purpose,a.status])).toEqual([['Leave','external','succeeded'],['Return to observed page','recovery','succeeded'],['Remaining','external','succeeded']]);
  expect(await pageOf(f.host).evaluate(()=>Number(document.documentElement.dataset.remaining||0))).toBe(1);
  const remaining=v.task.plan.filter(item=>item.required&&item.scope.label==='Remaining');expect(remaining.length).toBeGreaterThan(0);
  for(const item of remaining){expect(item.status).toBe('succeeded');expect(item.resolvedBy?.attemptId).toBe(attempts[2].id);}
  expect(v.task.status).toBe('completed');expect(v.task.usage.actions).toBe(3);expect(v.decisions.some(d=>d.purpose==='recovery-selection')).toBe(false);
 }finally{await plugin.close();await f.close();}
});


// A page-only obligation uses the optional source-position API. Its result is
// separate from target arrival and can never settle the failed target record.
it.each(['UNVERIFIED','UNREACHABLE'] as const)('retains target and source-return failures after %s without a strict fallback',async(status)=>{
 const f=await explorerFixture(`<a href="/elsewhere">Leave</a><button type="button" onclick="document.documentElement.dataset.remaining=String(Number(document.documentElement.dataset.remaining||0)+1)">Remaining</button><script>if(location.pathname==='/elsewhere')document.body.innerHTML='<p>Destination</p>'</script>`),providers=fakeProviders(f.url);
 const recovery=vi.spyOn(f.host,'reachExplorationTarget').mockImplementation(async(sid,input)=>({id:'target-failed',sessionId:sid,checkpointId:input.checkpointId,targetObservationId:input.observationId,targetActionIds:input.actionIds,matchedActionIds:[],matches:[],checkpointVerified:false,currentExecution:false,executionAuthorized:false,status,reason:'Fixture: target arrival unavailable',checks:[],attemptIds:[],observationId:f.host.observation(sid).id,remainingFrontier:1}));
 const returned=vi.spyOn(f.host,'returnToObservedSource').mockImplementation(async(sid,input)=>({id:'source-failed',sessionId:sid,sourceObservationId:input.observationId,observationId:f.host.observation(sid).id,status,reason:'Fixture: native source position unavailable',attemptIds:[],checks:[],diagnostics:{unassessedEffectAttemptIds:[]},checkpointVerified:false,currentExecution:false,executionAuthorized:false,sourceStateRestored:false}));
 const checkpoint=vi.spyOn(f.host,'reachCheckpoint'),plugin=new ExplorerPlugin(routePrerequisite(f.host),new ExplorerStore(':memory:'),providers);
 try{
  const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});plugin.start(task.id);await plugin.waitForIdle();const v=plugin.view(task.id),sid=v.task.rounds[0].sessionId;
  expect(recovery).toHaveBeenCalledTimes(1);expect(returned).toHaveBeenCalledTimes(1);expect(checkpoint).not.toHaveBeenCalled();
  expect(v.events.filter(e=>e.type==='recovery.result').map(e=>(e.data as any).status)).toEqual([status,status]);
  expect(v.events.some(e=>e.type==='recovery.source_reached'||e.type==='recovery.target_reached')).toBe(false);
  expect(v.task.status).not.toBe('completed');
  const remaining=v.task.plan.filter(i=>i.scope.label==='Remaining'&&i.required);expect(remaining.length).toBeGreaterThan(0);
  for(const item of remaining){expect(item.status).not.toBe('succeeded');expect(item.attempts).toEqual([]);expect(item.resolvedBy).toBeUndefined();}
  const records=Object.values(v.task.routeRetries!.routes).flatMap(route=>Object.values(route.conditions));
  expect(records).toHaveLength(2);expect(records.every(record=>record.attempts===1&&record.outcome===status.toLowerCase())).toBe(true);
  expect(new Set(records.map(record=>record.reason))).toEqual(new Set(['Fixture: target arrival unavailable','Fixture: native source position unavailable']));
  expect(f.host.list<any>(sid,'attempt').map(a=>a.action.label)).toEqual(['Leave']);expect(v.task.usage.actions).toBe(1);
  expect(await pageOf(f.host).evaluate(()=>Number(document.documentElement.dataset.remaining||0))).toBe(0);
 }finally{await plugin.close();await f.close();}
});

it.each(['UNVERIFIED','UNREACHABLE'] as const)('keeps %s target debt when native source return succeeds and requires an actual remaining click',async(status)=>{
 const f=await explorerFixture(`<a href="/elsewhere">Leave</a><button type="button" onclick="document.documentElement.dataset.remaining=String(Number(document.documentElement.dataset.remaining||0)+1)">Remaining</button><script>if(location.pathname==='/elsewhere')document.body.innerHTML='<p>Destination</p>'</script>`),providers=fakeProviders(f.url);
 const recovery=vi.spyOn(f.host,'reachExplorationTarget').mockImplementation(async(sid,input)=>({id:'target-failed',sessionId:sid,checkpointId:input.checkpointId,targetObservationId:input.observationId,targetActionIds:input.actionIds,matchedActionIds:[],matches:[],checkpointVerified:false,currentExecution:false,executionAuthorized:false,status,reason:'Fixture: target arrival unavailable',checks:[],attemptIds:[],observationId:f.host.observation(sid).id,remainingFrontier:1}));
 const returned=vi.spyOn(f.host,'returnToObservedSource'),checkpoint=vi.spyOn(f.host,'reachCheckpoint'),plugin=new ExplorerPlugin(routePrerequisite(f.host),new ExplorerStore(':memory:'),providers);
 try{
  const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});plugin.start(task.id);await plugin.waitForIdle();const v=plugin.view(task.id),sid=v.task.rounds[0].sessionId;
  expect(recovery).toHaveBeenCalledTimes(1);expect(returned).toHaveBeenCalledTimes(1);expect(checkpoint).not.toHaveBeenCalled();
  const results=v.events.filter(e=>e.type==='recovery.result').map(e=>e.data as any);expect(results.map(result=>result.status)).toEqual([status,'SOURCE_REACHED']);
  expect(results[1]).toMatchObject({checkpointVerified:false,currentExecution:false,executionAuthorized:false,sourceStateRestored:false});
  const attempts=f.host.list<any>(sid,'attempt');expect(attempts.map(a=>[a.action.label,a.purpose,a.status])).toEqual([['Leave','external','succeeded'],['Return to observed page','recovery','succeeded'],['Remaining','external','succeeded']]);
  expect(await pageOf(f.host).evaluate(()=>Number(document.documentElement.dataset.remaining||0))).toBe(1);
  const remaining=v.task.plan.filter(item=>item.required&&item.scope.label==='Remaining');expect(remaining.length).toBeGreaterThan(0);
  for(const item of remaining){expect(item.status).toBe('succeeded');expect(item.resolvedBy?.attemptId).toBe(attempts[2].id);}
  // Actual target progress may renew its scheduling budget; the failed arrival
  // result itself remains an immutable audit fact, never rewritten as success.
  expect(results[0]).toMatchObject({id:'target-failed',status,reason:'Fixture: target arrival unavailable',checkpointVerified:false,currentExecution:false,executionAuthorized:false});
  expect(v.task.status).toBe('completed');expect(v.task.usage.actions).toBe(3);expect(v.decisions.some(d=>d.purpose==='recovery-selection')).toBe(false);
 }finally{await plugin.close();await f.close();}
});
