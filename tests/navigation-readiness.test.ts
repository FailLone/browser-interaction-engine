import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {act,pageOf,testEngine} from './helpers.js';

async function fixture(options:{authorized?:boolean;missingReference?:boolean;changingNavigation?:boolean;independentUnknown?:boolean}={}) {
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<nav aria-label="Public navigation" aria-describedby="${options.missingReference?'absent':'description'}"><button id="open" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#links').hidden=false">Open local menu</button><div id="links" hidden><a href="/details">Details</a></div>${options.independentUnknown?'<input id="search" aria-label="Search" value="unchanged"><button aria-controls="missing-panel">Unresolved neighbor</button>':''}</nav><p id="description">Information</p><form><input id="live" aria-label="Live data"></form><script>setInterval(()=>{document.querySelector('#live').value=String(Date.now());${options.changingNavigation?"document.querySelector('#open').setAttribute('data-clock',String(Date.now()));":''}},10)</script>`);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 const f=await testEngine(url,{contextRules:[],exploration:'controls',settleMs:100,observeTimeoutMs:900,
  ...(options.authorized===false?{}:{executionBoundary:{version:1,programNavigation:'public-navigation-v1',urls:[{match:'route',origin:new URL(url).origin,pathnamePattern:'^/.*$'}],allowedOperations:['click','hover','history'],exclusions:[]}})});
 return {...f,close:async()=>{await f.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

it('captures and executes a stable explicit navigation scope while unrelated native fields keep changing',async()=>{
 const f=await fixture();try{
  const before=f.engine.observation(f.sessionId);expect(before.stable).toBe(false);expect(before.gaps.some(g=>g.critical)).toBe(false);
  expect(before.navigationScopes?.some(s=>s.complete&&s.binding?.references.some(r=>r.id==='description'))).toBe(true);
  expect(before.controls.find(c=>c.name==='Open local menu')?.readiness).toBeUndefined();
  expect(before.controls.find(c=>c.name==='Live data')?.readiness?.status).toBe('unstable');
  const result=await act(f.engine,f.sessionId,'Open local menu');expect(result.status,result.reason).toBe('succeeded');
  expect(f.engine.observation(f.sessionId).controls.find(c=>c.name==='Details')?.visible).toBe(true);
  expect(f.engine.list(f.sessionId,'attempt')).toHaveLength(1);
 }finally{await f.close();}
});

it.each(['no-contract','missing-reference','changing-navigation'] as const)('does not invent local readiness: %s',async variation=>{
 const f=await fixture({authorized:variation!=='no-contract',missingReference:variation==='missing-reference',changingNavigation:variation==='changing-navigation'});try{
  const o=f.engine.observation(f.sessionId);expect(o.gaps.some(g=>g.critical)).toBe(true);
  expect(f.engine.actions(f.sessionId).some(a=>a.label==='Open local menu')).toBe(false);
  expect(f.engine.list(f.sessionId,'attempt')).toHaveLength(0);
 }finally{await f.close();}
});

it('retains a missing neighbor reference and complete native field evidence without blocking independent navigation',async()=>{
 const f=await fixture({independentUnknown:true});try{
  const o=f.engine.observation(f.sessionId),scope=o.navigationScopes!.find(s=>s.complete)!;
  expect(scope.binding!.references).toContainEqual({id:'missing-panel',status:'missing'});
  expect(scope.binding!.fields.some(field=>field.value==='unchanged')).toBe(true);
  expect(o.controls.find(c=>c.name==='Unresolved neighbor')?.readiness?.status).toBe('unstable');
  expect(o.controls.find(c=>c.name==='Open local menu')?.readiness).toBeUndefined();
  expect((await act(f.engine,f.sessionId,'Open local menu')).status).toBe('succeeded');
  const current=f.engine.observation(f.sessionId),action=f.engine.actions(f.sessionId).find(a=>a.label==='Open local menu')!;
  await pageOf(f.engine).evaluate(()=>{(document.querySelector('#search') as HTMLInputElement).value='changed property only';});
  expect(await (f.engine as any).driver.preflight(current,action)).toBe('stale');
 }finally{await f.close();}
});

it.each(['external-reference','owner-attribute','handler','replacement','native-field'] as const)('revalidates local readiness against fresh DOM dependencies: %s',async change=>{
 const f=await fixture();try{
  const o=f.engine.observation(f.sessionId),a=f.engine.actions(f.sessionId).find(a=>a.label==='Open local menu')!;
  await pageOf(f.engine).evaluate(change=>{
   if(change==='external-reference')document.querySelector('#description')!.textContent='Changed meaning';
   if(change==='owner-attribute')document.querySelector('nav')!.setAttribute('data-mode','changed');
   if(change==='handler')document.querySelector('#open')!.setAttribute('onclick','differentOperation()');
   if(change==='replacement'){const target=document.querySelector('#open')!;target.replaceWith(target.cloneNode(true));}
   if(change==='native-field')document.querySelector('nav')!.append(document.createElement('input'));
  },change);
  expect(await (f.engine as any).driver.preflight(o,a)).toBe('stale');
  expect(f.engine.list(f.sessionId,'attempt')).toHaveLength(0);
 }finally{await f.close();}
});

it('bounds a disjoint missing reference without clearing target, ambiguous, ancestry or form dependencies',async()=>{
 const f=await fixture({independentUnknown:true});try{
  const {progressDependencies}=await import('../packages/adapter-playwright/src/progress-dependencies.js');
  const o=f.engine.observation(f.sessionId),action=f.engine.actions(f.sessionId).find(a=>a.label==='Open local menu')!,target=o.controls.find(c=>c.localId===action.localId)!;
  const neighbor=o.controls.find(c=>c.name==='Unresolved neighbor')!;
  const unknown={...neighbor,classificationBinding:{...(neighbor.classificationBinding||{}),references:[{id:'missing-panel',missing:true}]}} as typeof neighbor;
  expect(progressDependencies(o,action,[unknown]).allowed).toBe(true);
  const noScope=structuredClone(o);delete noScope.navigationScopes;
  expect(progressDependencies(noScope,action,[unknown]).allowed).toBe(false);
  const legacy=structuredClone(o);for(const scope of legacy.navigationScopes!)delete (scope as Partial<typeof scope>).blockedControlIds;
  expect(progressDependencies(legacy,action,[unknown]).allowed).toBe(false);
  const ambiguous=structuredClone(unknown);ambiguous.classificationBinding!.references![0]={id:'duplicate',ambiguous:true};
  expect(progressDependencies(o,action,[ambiguous]).allowed).toBe(false);
  const cross=structuredClone(unknown);cross.classificationBinding!.references![0]={id:'open',targetInstanceId:target.instanceId};
  expect(progressDependencies(o,action,[cross]).allowed).toBe(false);
  const missingAncestry=structuredClone(unknown);delete missingAncestry.domAncestry;
  expect(progressDependencies(o,action,[missingAncestry]).allowed).toBe(false);
  const targetMissing=structuredClone(o),changed=targetMissing.controls.find(c=>c.localId===action.localId)!;
  changed.classificationBinding={...(changed.classificationBinding||{}),references:[{id:'missing-target-dependency',missing:true}]} as typeof changed.classificationBinding;
  expect(progressDependencies(targetMissing,action,[unknown]).allowed).toBe(false);
  const shared=structuredClone(o),sharedTarget=shared.controls.find(c=>c.localId===action.localId)!;
  sharedTarget.formOwner={instanceId:'form',key:'form',action:o.url,method:'get',target:'',isolated:false};
  expect(progressDependencies(shared,action,[{...unknown,formOwner:sharedTarget.formOwner}]).allowed).toBe(false);
 }finally{await f.close();}
});
