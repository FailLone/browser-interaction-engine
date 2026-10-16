import {it,expect} from 'vitest';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {explorerFixture} from './explorer-plugin-helpers.js';

it('exposes ordinary UI states without configured models or functionality verdicts',async()=>{
 const f=await explorerFixture(`<input aria-label="Search" value="btc"><button type="button" id="clear" onclick="document.querySelector('input').value=''">Clear</button><button type="button" id="noop">No change</button>`);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
 try{
  const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});
  plugin.revise(t.id,{items:[{title:'Observe button interactions',scope:{url:f.url,role:'button'},prerequisites:[],completion:'Record resulting observed states',required:true,reason:'user scope'}]});
  plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),sid=v.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
  expect(attempts.map(a=>a.action.label)).toEqual(['Clear','No change']);
  expect(attempts.every(a=>a.status==='succeeded'&&a.effectsAssessment==='not-assessed'&&a.action.replayable===false)).toBe(true);
  expect(v.decisions).toHaveLength(0);expect(v.task.usage.modelRequests).toBe(0);
  expect(v.events.filter(e=>e.type==='action.selected')).toHaveLength(2);
  expect(v.task.pendingDispatch).toBeUndefined();
 }finally{await plugin.close();await f.close();}
});

it('keeps native submission as an untested host constraint without asking a model to certify it',async()=>{
 const f=await explorerFixture(`<form><button type="submit">Submit</button></form><button type="button" onclick="this.disabled=true">Open</button>`);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
 try{
  const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:6}});
  plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),attempts=f.host.list<any>(v.task.rounds[0].sessionId,'attempt');
  expect(attempts.map(a=>a.action.label)).toEqual(['Open']);expect(v.task.status).not.toBe('completed');
  expect(v.task.plan.some(i=>i.scope.label==='Submit'&&i.status!=='succeeded')).toBe(true);
  expect(v.decisions).toHaveLength(0);expect(v.task.usage.modelRequests).toBe(0);
 }finally{await plugin.close();await f.close();}
});
