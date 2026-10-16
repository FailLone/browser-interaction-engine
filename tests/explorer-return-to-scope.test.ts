import {expect,it,vi} from 'vitest';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {explorerFixture,fakeProviders} from './explorer-plugin-helpers.js';

it('requests host-verified return to the accepted page after navigation without asking a model to rediscover the task boundary',async()=>{
 const f=await explorerFixture(`<a href="/elsewhere">Leave</a><button id="remaining" type="button" onclick="this.disabled=true">Remaining</button><script>if(location.pathname==='/elsewhere')document.body.innerHTML='<p>Destination</p>'</script>`),providers=fakeProviders(f.url),decide=providers.jev.decide;
 providers.jev.decide=async(r,s)=>{if(r.purpose==='next-action'){const entry=Object.entries(r.options!).find(([,o])=>(o as any).label==='Leave');if(entry)return {model:'fixture',value:entry[0],confidence:1};}return decide(r,s);};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers);
 try{
  const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});plugin.start(task.id);await plugin.waitForIdle();const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId;
  expect(view.task.status,JSON.stringify({reason:view.task.reason,events:view.events.filter(e=>e.type.startsWith('recovery.'))})).toBe('completed');
  const attempts=f.host.list<any>(sid,'attempt');expect(attempts.map(a=>a.action.label)).toEqual(['Leave','Return to observed page','Remaining']);expect(attempts.every(a=>a.status==='succeeded')).toBe(true);
  expect(view.events.find(e=>e.type==='recovery.selected')?.data).toMatchObject({reason:'return_to_accepted_page',hostVerificationRequired:true});
  expect(view.events.find(e=>e.type==='recovery.result')?.data).toMatchObject({status:'REACHED_VERIFIED'});
  expect(view.decisions.some(d=>d.purpose==='recovery-selection')).toBe(false);expect(view.task.usage.actions).toBe(3);
 }finally{await plugin.close();await f.close();}
});

it('retains unfinished work when the host cannot verify return, without inventing recovery success or retrying the same checkpoint',async()=>{
 const f=await explorerFixture(`<a href="/elsewhere">Leave</a><button type="button">Remaining</button><script>if(location.pathname==='/elsewhere')document.body.innerHTML='<p>Destination</p>'</script>`),providers=fakeProviders(f.url),decide=providers.jev.decide;
 providers.jev.decide=async(r,s)=>{if(r.purpose==='next-action'){const entry=Object.entries(r.options!).find(([,o])=>(o as any).label==='Leave');if(entry)return {model:'fixture',value:entry[0],confidence:1};}return decide(r,s);};
 const recovery=vi.spyOn(f.host,'reachCheckpoint').mockImplementation(async(sid,checkpointId)=>({id:'unverified',sessionId:sid,checkpointId,status:'UNVERIFIED',reason:'Fixture: history entry no longer available',checks:[],attemptIds:[],observationId:f.host.observation(sid).id,remainingFrontier:1}));
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers);
 try{
  const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(recovery).toHaveBeenCalledTimes(1);expect(v.task.status).not.toBe('completed');
  expect(v.task.plan.some(i=>i.scope.label==='Remaining'&&i.required&&i.status!=='succeeded')).toBe(true);
  expect(v.events.find(e=>e.type==='recovery.result')?.data).toMatchObject({status:'UNVERIFIED'});
  expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').map(a=>a.action.label)).toEqual(['Leave']);expect(v.task.usage.actions).toBe(1);
 }finally{await plugin.close();await f.close();}
});
