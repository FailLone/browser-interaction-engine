import {it,expect} from 'vitest';
import {executionBoundaryFailure,executionURLAllowed,type BrowserExecutionBoundary,type ActionCandidate,type Observation} from '@interaction/browser';
import {explorerFixture} from './explorer-plugin-helpers.js';

it('separates URL authorization from exact source URLs, including network requests without fragments',()=>{
 const b:BrowserExecutionBoundary={version:1,allowedOperations:['click'],urls:[{url:'https://example.test/info#one',match:'exact'}],exclusions:[]};
 expect(executionURLAllowed(b,'https://example.test/info#two')).toBe(false);
 expect(executionURLAllowed(b,'https://example.test/info',true)).toBe(true);
 b.urls[0].match='origin-path';expect(executionURLAllowed(b,'https://example.test/info?tracking=1#two')).toBe(true);
 expect(executionURLAllowed(b,'https://example.test/login')).toBe(false);expect(executionURLAllowed(b,'https://other.test/info')).toBe(false);
});

it('enforces the persisted boundary for SDK commands, probes and recovery validation',async()=>{
 const f=await explorerFixture('<button id="ready" type="button">Ready</button><a href="/outside">Outside</a>');
 try{
  const boundary:BrowserExecutionBoundary={version:1,allowedOperations:['click'],urls:[{url:f.url,match:'exact'}],exclusions:[{label:'Ready',kind:'click'}]};
  const s=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui',executionBoundary:boundary}),o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.label==='Ready'&&a.kind==='click')!;
  expect(f.host.actionAvailability(s.id).actions.find(x=>x.actionId===a.id)?.blockers.some(b=>b.code==='ACTION_OUTSIDE_EXECUTION_BOUNDARY')).toBe(true);
  await expect(f.host.execute(s.id,a.id,'denied-direct')).rejects.toMatchObject({code:'ACTION_OUTSIDE_EXECUTION_BOUNDARY'});
  await expect(f.host.command(s.id,{type:'probe',observationId:o.id,localId:a.localId,kind:'hover',requestId:'denied-probe',guard:{observationId:o.id,profile:'observed-ui-probe'}})).rejects.toMatchObject({code:'ACTION_OUTSIDE_EXECUTION_BOUNDARY'});
  // This is the SDK's shared validator reached by real replay/runAction, not a
  // plugin selection callback. A phase change must not change caller authority.
  const validate=(f.host as unknown as {validatePreparedAction(a:ActionCandidate,o:Observation,purpose:'recovery'):void}).validatePreparedAction.bind(f.host);
  expect(()=>validate(a,o,'recovery')).toThrow('target_excluded_by_execution_boundary');
  const link=f.host.actions(s.id).find(a=>a.label==='Outside')!;
  expect(executionBoundaryFailure(boundary,link,o)).toBe('destination_outside_execution_boundary');
  expect(f.host.list(s.id,'attempt')).toHaveLength(0);
 }finally{await f.close();}
});

it('applies local capability dependency checks to actual SDK dispatch, without granting ancestor coverage',async()=>{
 const f=await explorerFixture('<button id="dependent" type="button"><canvas></canvas>Dependent</button><button id="independent" type="button">Independent</button>');
 try{
  const s=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui',coveragePolicy:'finite-ui-v1'}),o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.label==='Dependent')!;
  await expect(f.host.execute(s.id,a.id,'deny-dependent',undefined,{observationId:o.id,profile:'observed-ui-exploration'})).rejects.toMatchObject({code:'ACTION_DEPENDENCIES_UNPROVED'});
  const b=f.host.actions(s.id).find(a=>a.label==='Independent')!,result=await f.host.execute(s.id,b.id,'run-independent',undefined,{observationId:o.id,profile:'observed-ui-exploration'});
  expect(result.status).toBe('succeeded');expect(f.host.observation(s.id).gaps.some(g=>g.code==='UNSUPPORTED_CANVAS')).toBe(true);
 }finally{await f.close();}
});

it.each([true,false])('checks caller operations during real SDK recovery with a retained canvas (history authorized: %s)',async authorized=>{
 const f=await explorerFixture('<a href="/next">Next</a><button id="child" type="button">Original child</button><canvas></canvas>');
 try{
  const boundary:BrowserExecutionBoundary={version:1,allowedOperations:authorized?['click','history','navigate']:['click'],urls:[{origin:new URL(f.url).origin,pathnamePattern:'^/(?:next)?$',match:'route'}],exclusions:[]};
  const s=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui',coveragePolicy:'finite-ui-v1',executionBoundary:boundary});
  const source=f.host.observation(s.id),checkpoint=await f.host.createCheckpoint(s.id,'Original page');
  const next=f.host.actions(s.id).find(a=>a.label==='Next'&&a.kind==='click')!;
  expect((await f.host.execute(s.id,next.id,'leave-original',undefined,{observationId:source.id,profile:'observed-ui-exploration'})).status).toBe('succeeded');
  expect(f.host.observation(s.id).url).toBe(new URL('/next',f.url).href);
  const result=await f.host.reachCheckpoint(s.id,checkpoint.id),attempts=f.host.list<any>(s.id,'attempt');
  const recovery=attempts.filter(a=>a.purpose==='recovery');
  if(authorized){
   expect(f.host.observation(s.id).url).toBe(f.url);
   expect(recovery.some(a=>a.action.kind==='history'&&a.status==='succeeded')).toBe(true);
   expect(f.host.observation(s.id).gaps.some(g=>g.code==='UNSUPPORTED_CANVAS')).toBe(true);
  }else{
   expect(result.status).not.toMatch(/^REACHED_/);
   expect(recovery.some(a=>a.status==='succeeded')).toBe(false);
   expect(f.host.observation(s.id).url).toBe(new URL('/next',f.url).href);
  }
  expect(attempts.some(a=>a.action.label==='Original child')).toBe(false);
 }finally{await f.close();}
});
