import {expect,it} from 'vitest';
import {pageOf} from './helpers.js';
import {explorerFixture} from './explorer-plugin-helpers.js';

it.each([false,true])('retains B coverage when A disappears, rebuilt B=%s',async rebuild=>{
 const f=await explorerFixture(`<section aria-label="Fields"><input data-testid="shared-field" aria-label="A"><input data-testid="shared-field" aria-label="B"><button id="remove" type="button" onclick="document.querySelector('[aria-label=A]').remove();${rebuild?"const b=document.querySelector('[aria-label=B]');b.replaceWith(b.cloneNode(true));":''}">Remove A</button></section>`);
 try{
  const s=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui',exploration:'controls',settleMs:0,observeTimeoutMs:100});
  const action=f.host.actions(s.id).find(a=>a.label==='B'&&a.kind==='fill')!;
  const first=f.host.observation(s.id),b=first.controls.find(c=>c.localId===action.localId)!;
  const attempt=await f.host.execute(s.id,action.id,'fill-b',undefined,{observationId:first.id,profile:'observed-ui-exploration'});expect(attempt.status).toBe('succeeded');
  const remove=f.host.actions(s.id).find(a=>a.label==='Remove A')!;
  await f.host.execute(s.id,remove.id,'remove-a',undefined,{observationId:f.host.observation(s.id).id,profile:'observed-ui-exploration'});
  const current=f.host.observation(s.id),next=current.controls.find(c=>c.name==='B'&&c.tag==='input')!;
  expect(current.controls.some(c=>c.name==='A')).toBe(false);expect(next.identityId,JSON.stringify({before:{name:b.name,label:b.label,region:b.region,actions:b.actions,identityContext:b.identityContext,instanceId:b.instanceId},after:{name:next.name,label:next.label,region:next.region,actions:next.actions,identityContext:next.identityContext,instanceId:next.instanceId}})).toBe(b.identityId);
  expect(next.instanceId===b.instanceId).toBe(!rebuild);
  // The sampled value is already present, so no second fill is offered. An
  // absent sibling or a rebuilt DOM node must not invent a new input obligation.
  expect(next.value).toBe(attempt.action.value);
  expect(f.host.actions(s.id).filter(a=>a.localId===next.localId&&a.kind==='fill')).toHaveLength(0);
  expect(f.host.list<any>(s.id,'attempt').filter(a=>a.action.label==='B')).toHaveLength(1);
 }finally{await f.close();}
});


it('proves rebuilt shared-key button correspondence without granting replay or covering its siblings',async()=>{
 const f=await explorerFixture('<section aria-label="Options"><a data-testid="button" href="/register">Convert</a><button data-testid="button" type="button">Open wallet</button><button data-testid="button" type="button">Close</button></section>');
 try{
  const s=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui',exploration:'controls',settleMs:0,observeTimeoutMs:100});
  const first=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.label==='Open wallet')!;
  const attempt=await f.host.execute(s.id,a.id,'open',undefined,{observationId:first.id,profile:'observed-ui-exploration'});
  await pageOf(f.host).reload();const current=await f.host.observe(s.id);
  expect(current.instanceScope).not.toBe(first.instanceScope);
  const actions=f.host.actions(s.id),beforeCount=f.host.session(s.id).actionCount;
  const proof=(label:string)=>f.host.operationCorrespondence(s.id,{observationId:current.id,actionId:actions.find(a=>a.label===label)!.id,source:{sessionId:s.id,attemptId:attempt.id}});
  expect(proof('Open wallet')).toMatchObject({equivalent:true,identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  expect(proof('Open wallet').evidence).toContain('shared-hint-refined-by-unique-semantics');
  expect(proof('Close').equivalent).toBe(false);expect(proof('Convert').equivalent).toBe(false);
  expect(f.host.session(s.id).actionCount).toBe(beforeCount);expect(attempt.action.replayable).toBe(false);
  await f.host.stop(s.id);
  const next=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui',exploration:'controls',settleMs:0,observeTimeoutMs:100});
  const fresh=f.host.observation(next.id),candidate=f.host.actions(next.id).find(a=>a.label==='Open wallet')!;
  const cross=f.host.operationCorrespondence(next.id,{observationId:fresh.id,actionId:candidate.id,source:{sessionId:s.id,attemptId:attempt.id}});
  expect(cross).toMatchObject({equivalent:true,identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  expect(cross.evidence).toContain('independently-resolved-session-identities');
  expect(f.host.list(next.id,'attempt')).toHaveLength(0);expect(f.host.session(next.id).actionCount).toBe(0);
 }finally{await f.close();}
});
