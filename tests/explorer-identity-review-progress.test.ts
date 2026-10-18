import {it,expect} from 'vitest';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {explorerFixture,fakeProviders} from './explorer-plugin-helpers.js';

it('counts finite current-occurrence resolution as real review progress under interface-only policy',async()=>{
 const f=await explorerFixture(Array.from({length:6},()=>'<label>Toggle<input type="checkbox" disabled></label>').join('')+'<button id="ready" type="button" onclick="this.disabled=true">Ready</button><canvas></canvas>');
 const store=new ExplorerStore(':memory:'),providers=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const task=plugin.create({url:f.url,budget:{rounds:1,actions:20,durationMs:20000},sessionOptions:{coveragePolicy:'finite-ui-v1',executionPolicy:'interface-only',headless:true}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),events=store.events(task.id);
  const resolved=events.filter(e=>e.type==='program.review'&&(e.data as any).reason==='independent_current_target');
  expect(resolved.length).toBeGreaterThanOrEqual(6);
  const attempts=final.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(attempts.some(a=>a.status==='succeeded'&&a.action.label==='Ready')).toBe(true);
  expect(attempts.some(a=>a.action.kind==='check')).toBe(false);
  expect(final.status).not.toBe('completed');
  expect(final.plan.some(i=>i.required&&i.reason==='missing_capability:UNSUPPORTED_CANVAS')).toBe(true);
 }finally{await plugin.close();await f.close();}
});
