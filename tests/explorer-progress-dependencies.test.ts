import {it,expect} from 'vitest';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {progressDependencies} from '../packages/explorer-plugin/src/progress-dependencies.js';
import {explorerFixture,fakeProviders} from './explorer-plugin-helpers.js';

it('bounds a canvas gap to captured DOM while preserving unknown contents and SDK obstruction checks',async()=>{
 const f=await explorerFixture('<section><canvas></canvas></section><button type="button" id="ready">Ready</button><button type="button" id="dependent"><canvas></canvas>Dependent</button>');
 try{
  const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1'}),o=f.host.observation(s.id),actions=f.host.actions(s.id),ready=actions.find(a=>a.label==='Ready')!,dependent=actions.find(a=>a.label==='Dependent')!;
  expect(o.gaps.filter(g=>g.code==='UNSUPPORTED_CANVAS')).toHaveLength(2);
  expect(o.gaps.filter(g=>g.code==='UNSUPPORTED_CANVAS').every(g=>g.coverageScope?.complete)).toBe(true);
  expect(progressDependencies(o,ready,[])).toMatchObject({allowed:true,blockers:[]});
  expect(progressDependencies(o,dependent,[]).blockers.some(b=>b.reason==='capability_dependency')).toBe(true);
  const unproved=structuredClone(o);delete unproved.gaps.find(g=>g.code==='UNSUPPORTED_CANVAS')!.coverageScope;
  expect(progressDependencies(unproved,ready,[]).allowed).toBe(false);
  const occluded=structuredClone(o);occluded.controls.find(c=>c.localId===ready.localId)!.actionable.hitTarget=false;
  expect(progressDependencies(occluded,ready,[]).blockers.some(b=>b.reason==='target_hit_unproved')).toBe(true);
  const critical=structuredClone(o);critical.gaps[0].critical=true;expect(progressDependencies(critical,ready,[]).allowed).toBe(false);
 }finally{await f.close();}
});

it('holds an unresolved ancestor, shared form or missing ancestry while allowing a disjoint reviewed native control',async()=>{
 const f=await explorerFixture('<div id="unknown" onclick="window.x=1"><button type="button" id="inside">Inside</button></div><button type="button" id="outside">Outside</button>');
 try{
  const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1'}),o=f.host.observation(s.id),actions=f.host.actions(s.id),unknown=o.controls.find(c=>c.selector==='#unknown')!;
  const inside=actions.find(a=>a.label==='Inside'&&a.localId!==unknown.localId)!,outside=actions.find(a=>a.label==='Outside')!;
  expect(progressDependencies(o,inside,[unknown]).blockers.some(b=>b.reason==='review_dependency')).toBe(true);
  expect(progressDependencies(o,outside,[unknown]).allowed).toBe(true);
  const missing=structuredClone(unknown);delete missing.domAncestry;expect(progressDependencies(o,outside,[missing]).allowed).toBe(false);
  const altered=structuredClone(o),target=altered.controls.find(c=>c.localId===outside.localId)!;
  target.formOwner={instanceId:'form',key:'form',action:f.url,method:'get',target:'',isolated:false};
  const sibling={...unknown,formOwner:target.formOwner};expect(progressDependencies(altered,outside,[sibling]).allowed).toBe(false);
 }finally{await f.close();}
});

it('executes an independent DOM task but keeps the canvas obligation and overall coverage incomplete',async()=>{
 const f=await explorerFixture('<section><canvas></canvas></section><button id="ready" type="button" onclick="this.disabled=true">Ready</button>');const store=new ExplorerStore(':memory:'),providers=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const task=plugin.create({url:f.url,goal:'All controls',coverageContract:{version:1,mode:'exhaustive',roots:[{url:f.url}],exclusions:[],allowedOperations:['click','scroll']},budget:{rounds:1,actions:5,durationMs:15000},sessionOptions:{coveragePolicy:'finite-ui-v1',headless:true}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const result=store.task(task.id);
  expect(result.status).not.toBe('completed');
  expect(result.plan.find(i=>i.reason==='missing_capability:UNSUPPORTED_CANVAS')).toMatchObject({required:true,status:'unresolved'});
  expect(result.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt')).some(a=>a.action.label==='Ready'&&a.status==='succeeded')).toBe(true);
  expect(store.events(task.id).some(e=>e.type==='progress.dependencies'&&(e.data as any).allowed===true&&(e.data as any).independent.length>0)).toBe(true);
 }finally{await plugin.close();await f.close();}
});

it('gives a ready action a turn before reviewing every independent unknown, then resumes review',async()=>{
 const unknowns=Array.from({length:18},(_,i)=>`<div tabindex="0" aria-label="Unresolved ${i}">Unresolved ${i}</div>`).join('');
 const f=await explorerFixture(`${unknowns}<button id="ready" type="button" onclick="this.disabled=true">Ready</button>`),store=new ExplorerStore(':memory:'),providers=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const task=plugin.create({url:f.url,goal:'All controls',coverageContract:{version:1,mode:'exhaustive',roots:[{url:f.url}],exclusions:[],allowedOperations:['click']},budget:{rounds:1,actions:5,durationMs:15000},sessionOptions:{coveragePolicy:'finite-ui-v1',headless:true}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);
  const events=store.events(task.id),dispatch=events.findIndex(e=>e.type==='action.dispatch');
  const classifications=events.map((e,i)=>({e,i})).filter(({e})=>e.type==='decision.requested'&&(e.data as any).purpose==='control-classification');
  expect(dispatch).toBeGreaterThan(-1);expect(classifications.some(({i})=>i>dispatch)).toBe(true);
  expect(classifications.filter(({i})=>i<dispatch).length).toBeLessThan(18);
  expect(events.some(e=>e.type==='progress.dependencies'&&(e.data as any).independent.length>0)).toBe(true);
 }finally{await plugin.close();await f.close();}
});

it('continues another native task after a session limit while retaining the canvas completeness blocker',async()=>{
 const f=await explorerFixture('<canvas></canvas><button id="a" type="button" onclick="this.disabled=true">First</button><button id="b" type="button" onclick="this.disabled=true">Second</button>');
 const store=new ExplorerStore(':memory:'),providers=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const task=plugin.create({url:f.url,goal:'All controls',coverageContract:{version:1,mode:'exhaustive',roots:[{url:f.url}],exclusions:[],allowedOperations:['click']},budget:{rounds:3,actions:5,durationMs:20000},sessionOptions:{coveragePolicy:'finite-ui-v1',headless:true,maxActions:1}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const result=store.task(task.id),attempts=result.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(result.rounds.length).toBeGreaterThan(1);
  expect(attempts.filter(a=>a.status==='succeeded').map(a=>a.action.label)).toEqual(['First','Second']);
  expect(result.plan.some(i=>i.required&&i.reason==='missing_capability:UNSUPPORTED_CANVAS'&&i.status!=='succeeded')).toBe(true);
  expect(result.status).not.toBe('completed');
  const assessments=store.events(task.id).filter(e=>e.type==='round.progress_assessed').map(e=>e.data as any);
  expect(assessments.some(a=>a.independent&&a.retainedLimitationIds.length>0&&a.readyActionIds.length>0)).toBe(true);
 }finally{await plugin.close();await f.close();}
});
