import {it,expect} from 'vitest';
import {ExplorerPlugin,ExplorerStore} from '@interaction/explorer-plugin';
import {explorerFixture,fakeProviders} from './explorer-plugin-helpers.js';
import {pageOf} from './helpers.js';
import {controlReviewConditions,controlReviewKey,controlReuseConditions} from '../packages/adapter-playwright/src/control-review.js';
import {purposeConditions} from '../packages/adapter-playwright/src/purpose-review.js';

const metadataHtml=`<div id="own" tabindex="0">Own target</div>
<div id="parent" tabindex="0">Parent<div id="child" tabindex="0">Child</div></div>
<div id="inherited" tabindex="0">Inherited</div><div id="prototype-only" tabindex="0">Prototype only</div><div id="outer-getter" tabindex="0">Outer getter</div>
<div id="event-getter" tabindex="0">Event getter</div><div id="ambiguous" tabindex="0">Ambiguous</div>
<script>
window.getterReads=0;window.handlerCalls=0;
const handler=()=>window.handlerCalls++;
document.getElementById('own').__reactProps$fixture={onClick:handler,onMouseEnter:handler,onMouseLeave:handler};
document.getElementById('child').__reactProps$fixture={onMouseEnter:handler};
document.getElementById('inherited').__reactProps$fixture=Object.create({onMouseEnter:handler});
const inheritedElement=document.getElementById('prototype-only');Object.setPrototypeOf(inheritedElement,Object.create(Object.getPrototypeOf(inheritedElement),{__reactProps$fixture:{value:{onMouseEnter:handler}}}));
Object.defineProperty(document.getElementById('outer-getter'),'__reactProps$fixture',{get(){window.getterReads++;return {onMouseEnter:handler}}});
document.getElementById('event-getter').__reactProps$fixture=Object.defineProperty({},'onMouseEnter',{get(){window.getterReads++;return handler}});
document.getElementById('ambiguous').__reactProps$first={onMouseEnter:handler};
document.getElementById('ambiguous').__reactProps$second={onClick:handler};
</script>`;

it('captures only unique own event data properties as tentative evidence without invoking handlers or getters',async()=>{
 const f=await explorerFixture(metadataHtml);
 try{
  const s=await f.host.createSession({url:f.url,headless:true}),o=f.host.observation(s.id);
  const target=(id:string)=>o.controls.find(c=>c.selector===`#${id}`)!;
  expect(target('own').actionBasis?.click?.status).toBe('tentative');
  expect(target('own').actionBasis?.hover).toMatchObject({status:'tentative',evidence:[{source:'runtime-metadata',rule:'react-event-prop/v1',facts:{eventProperty:'onMouseEnter',purpose:'unknown'}}]});
  expect(target('child').actionBasis?.hover?.status).toBe('tentative');
  for(const id of ['parent','inherited','prototype-only','outer-getter','event-getter','ambiguous']){
   expect(target(id).actionBasis?.hover,id).toBeUndefined();
   expect(target(id).interactionHints?.some(h=>h.rule==='react-event-prop/v1'),id).toBe(false);
  }
  expect(target('ambiguous').interactionHints).toContainEqual({source:'runtime-metadata',rule:'ambiguous-react-event-props/v1',facts:{count:2,purpose:'unknown'}});
  expect(o.gaps.some(g=>g.code==='EVENT_LISTENER_COVERAGE')).toBe(true);
  await f.host.explore(s.id);await f.host.waitForIdle();
  expect(f.host.list(s.id,'attempt')).toHaveLength(0);
  expect(await pageOf(f.host).evaluate(()=>({getters:(window as any).getterReads,handlers:(window as any).handlerCalls}))).toEqual({getters:0,handlers:0});
 }finally{await f.close();}
});

it('rejects a stale event target when its own current handler metadata disappears before dispatch',async()=>{
 const f=await explorerFixture(metadataHtml);
 try{
  const s=await f.host.createSession({url:f.url,headless:true}),o=f.host.observation(s.id),target=o.controls.find(c=>c.selector==='#own')!;
  const action=f.host.actions(s.id).find(a=>a.localId===target.localId&&a.kind==='hover')!;expect(action).toBeDefined();
  await pageOf(f.host).evaluate(()=>{delete (document.getElementById('own') as any).__reactProps$fixture.onMouseEnter;});
  await expect(f.host.execute(s.id,action.id,'stale-runtime-handler')).rejects.toMatchObject({code:'STALE_OBSERVATION'});
  expect(f.host.session(s.id).actionCount).toBe(0);
  expect(f.host.observation(s.id,o.id).controls.find(c=>c.localId===target.localId)?.actionBasis?.hover?.status).toBe('tentative');
  expect(f.host.observation(s.id).controls.find(c=>c.selector==='#own')?.actionBasis?.hover).toBeUndefined();
 }finally{await f.close();}
});

it.each([false,true])('invalidates native operation review and reuse when captured runtime metadata changes (list=%s)',async inList=>{
 const f=await explorerFixture(`${inList?'<div role="listbox" aria-label="Choices">':''}<button id="native" type="button">Native</button>${inList?'</div>':''}<script>document.getElementById("native").__reactProps$fixture={onClick(){},onMouseLeave(){}};</script>`);
 try{
  const s=await f.host.createSession({url:f.url,headless:true}),o=f.host.observation(s.id),target=o.controls.find(c=>c.selector==='#native')!;
  const before=controlReviewKey(controlReviewConditions(target,o,'click')!),reuse=controlReuseConditions(target,o,'click');
  const action=f.host.actions(s.id).find(a=>a.localId===target.localId&&a.kind==='click')!,purpose=inList?purposeConditions(action,target,o):undefined;
  if(inList)expect(purpose).toBeDefined();else expect(reuse).toBeDefined();
  await f.host.command(s.id,{type:'reviewControls',review:{observationId:o.id,source:'explicit-fixture-review',reviews:[{localId:target.localId,kind:'click',risk:'interface',replayable:false,reason:'Explicit fixture review; metadata must remain bound',evidence:[`observation:${o.id}`]}]}});
  expect(f.host.list<any>(s.id,'control-review').some(r=>r.status==='active')).toBe(true);
  await pageOf(f.host).evaluate(()=>{delete (document.getElementById('native') as any).__reactProps$fixture.onMouseLeave;});
  const after=await f.host.observe(s.id),current=after.controls.find(c=>c.selector==='#native')!;
  expect(current.actionBasis?.click?.status).toBe('supported');
  expect(controlReviewKey(controlReviewConditions(current,after,'click')!)).not.toBe(before);
  if(inList)expect(purposeConditions(action,current,after)).not.toEqual(purpose);
  else expect(controlReuseConditions(current,after,'click')).not.toEqual(reuse);
  expect(f.host.list<any>(s.id,'control-review').every(r=>r.status==='invalidated')).toBe(true);
  expect(f.host.list(s.id,'attempt')).toHaveLength(0);
 }finally{await f.close();}
});

it('keeps runtime handler purpose unknown under interface-only exploration while independent work executes',async()=>{
 const f=await explorerFixture('<div id="unknown" tabindex="0">Unknown effect</div><button id="ready" type="button" onclick="this.disabled=true">Ready</button><canvas></canvas><script>document.getElementById("unknown").__reactProps$fixture={onMouseEnter(){window.changed=true}};</script>');
 const providers=fakeProviders(f.url),decide=providers.jev.decide;
 providers.jev.decide=async(request,signal)=>{
  if(request.purpose==='control-classification'&&(request.state as any).material.control.selector==='#unknown'){
   providers.calls.push(request);return {value:'interaction',model:'explicit-interaction',confidence:1};
  }
  if(['control-risk','probe-risk'].includes(request.purpose)&&(request.state as any).material.control.selector==='#unknown'){
   providers.calls.push(request);return {value:Object.fromEntries(Object.keys(request.checks!).map(k=>[k,.5])),model:'explicit-unknown',confidence:1};
  }
  return decide(request,signal);
 };
 const store=new ExplorerStore(':memory:'),plugin=new ExplorerPlugin(f.host,store,providers);
 try{
  const task=plugin.create({url:f.url,coverageContract:{version:1,mode:'exhaustive',roots:[{url:f.url}],exclusions:[],allowedOperations:['click','hover']},budget:{rounds:1,actions:5,durationMs:15000},sessionOptions:{headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'interface-only'}});
  plugin.start(task.id);await plugin.waitForIdle(task.id);const final=store.task(task.id),attempts=final.rounds.flatMap(r=>f.host.list<any>(r.sessionId,'attempt'));
  expect(attempts.some(a=>a.action.label==='Ready'&&a.status==='succeeded')).toBe(true);
  expect(attempts.some(a=>a.action.label==='Unknown effect')).toBe(false);
  expect(providers.calls.some(r=>r.purpose==='probe-risk')).toBe(true);
  expect(final.plan.some(i=>i.required&&i.scope.label==='Unknown effect'&&i.reason==='probe_unresolved')).toBe(true);
  expect(final.plan.some(i=>i.required&&i.reason==='missing_capability:UNSUPPORTED_CANVAS')).toBe(true);
  expect(final.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});
