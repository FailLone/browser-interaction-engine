import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {BrowserEngine,BrowserAdapter,type BrowserCommandEvent} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';
import {actualLocalReceipt} from '../packages/adapter-playwright/src/local-operation-receipt.js';

async function fixture(mode='local',mutate='none',settleMs=25) {
 const html=`<!doctype html><header><nav><ul><li data-record="A" data-mode="cash"><a href="/catalog">Catalog</a><details><summary aria-describedby="hint">More</summary><p id="hint">Description</p><a href="/destination?market=BTC${mode==='added-fragment'?'':'#spot'}" ${mode==='prevent'?'onclick="event.preventDefault()"':mode==='wrong'?'onclick="event.preventDefault();location.href=\'/unrelated\'"':''}>Market</a><input aria-label="Related mode" value="cash"></details></li></ul></nav></header><main><input aria-label="Outside value" value="1">${mutate==='truncation'?'<span data-extra="outside">Independent</span>'.repeat(1100):''}</main>`;
 const server=createServer((req,res)=>{if(mode==='redirect'&&req.url?.startsWith('/destination')){res.writeHead(302,{Location:'/unrelated'});res.end();return;}
  res.setHeader('Content-Type','text/html');res.end(req.url==='/'?html:`<h1>Arrived</h1>${mode==='query'?'<script>history.replaceState({},"","/destination?market=ETH#spot")</script>':(mode==='fragment'||mode==='added-fragment')?'<script>history.replaceState({},"","/destination?market=BTC#other")</script>':''}`);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const store=new MemoryStore(),events:BrowserCommandEvent[]=[];let driver:BrowserAdapter|undefined,mutation:Promise<unknown>|undefined;
 const engine=new BrowserEngine({persistence:store,hooks:{browserInstrumentation:{observe(e){events.push(e);if(driver&&e.command==='execute'&&e.phase==='before'&&(e.input.action as any).label===(mode==='local'?'More':'Market')){
  mutation=driver.page!.evaluate(kind=>{const record=document.querySelector('li')!,more=document.querySelector('summary')!;
   if(kind==='outside')document.querySelector<HTMLInputElement>('main input')!.value='2';
   if(kind==='record')record.setAttribute('data-record','B');
   if(kind==='mode')record.setAttribute('data-mode','margin');
   if(kind==='field')document.querySelector<HTMLInputElement>('details input')!.value='margin';
   if(kind==='destination')document.querySelector('details a')!.setAttribute('href','/different');
   if(kind==='reference')document.querySelector('#hint')!.remove();
   if(kind==='ambiguous')document.querySelector('nav')!.append(document.querySelector('#hint')!.cloneNode(true));
   if(kind==='ancestor')document.querySelector('header')!.setAttribute('data-owner','different');
   if(kind==='obstruction'){const block=document.createElement('div');block.setAttribute('role','dialog');block.style.cssText='position:fixed;inset:0;background:white;z-index:9999';document.body.append(block);}
   if(kind==='instance'){more.replaceWith(more.cloneNode(true));}
  },mutate);
 }}}}});
 const url=`http://127.0.0.1:${(server.address() as any).port}/`,session=await engine.createSession({url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui',settleMs,observeTimeoutMs:600,actionTimeoutMs:400,evidence:{enabled:false},
  executionBoundary:{version:1,programNavigation:'public-navigation-v1',urls:[{match:'route',origin:new URL(url).origin,pathnamePattern:'^/.*$'}],exclusions:[],allowedOperations:['click']}});
 driver=(engine as unknown as {driver:BrowserAdapter}).driver;
 const execute=async(label:string)=>{const action=engine.actions(session.id).find(a=>a.label===label&&a.kind==='click')!;return engine.execute(session.id,action.id,`local-${label}`,undefined,{profile:'observed-ui-exploration',observationId:action.observationId});};
 return {engine,store,session,driver,events,execute,mutation:()=>mutation,async close(){await engine.close();await new Promise<void>(r=>server.close(()=>r()));}};
}

it.each(['none','outside','truncation'])('verifies actual local work with %s outside evidence and retains the final bounded sample',async mutate=>{
 const f=await fixture('local',mutate);try{
  const before=f.engine.observation(f.session.id),receipt=await f.execute('More');await f.mutation();
  const after=f.engine.observation(f.session.id,receipt.afterId!),condition=f.engine.operationReceiptCondition(f.session.id,{attemptId:receipt.id});
  expect(receipt.status).toBe('succeeded');expect(condition,JSON.stringify(after.localDispatchAudit)).toMatchObject({conditionVerified:true,policy:'browser-local-operation-receipt-v1'});
  expect(after.localDispatchAudit?.status).toBe('matched');expect(after.localDispatchAudit?.sourceArtifact).toBe(after.localDispatchAudit?.finalArtifact);
  const evidence=await f.store.evidence.get(after.localDispatchAudit!.finalArtifact!);expect(evidence).toBeDefined();expect(evidence!.data.length).toBeLessThan(524289);
  const material=JSON.parse(new TextDecoder().decode(evidence!.data));expect(material.scope.binding.markup).toContain('More');expect(material.scope.binding.markup).not.toContain('Outside value');
  if(mutate==='outside')expect(after.ownerDependencyDispatch).toBeUndefined();
  if(mutate==='truncation')expect(before.ownerDependencies?.nodes.length).toBe(768);
  expect(await f.driver.page!.locator('details').getAttribute('open')).not.toBeNull();
 }finally{await f.close();}
});

it.each(['record','mode','field','destination','reference','ambiguous','ancestor','obstruction','instance'])('rejects changed necessary local %s at actual native dispatch',async mutate=>{
 const f=await fixture('local',mutate);try{
  const receipt=await f.execute('More');await f.mutation();const after=f.engine.observation(f.session.id,receipt.afterId!);
  expect(f.engine.operationReceiptCondition(f.session.id,{attemptId:receipt.id}).conditionVerified).toBe(false);
  if(!['instance','obstruction'].includes(mutate)){
   expect(receipt.status).toBe('succeeded');expect(after.localDispatchAudit?.status).toBe('rejected');expect(after.localDispatchAudit?.reason).toMatch(/changed|unresolved/);
   expect(await f.store.evidence.get(after.localDispatchAudit!.finalArtifact!)).toBeDefined();
   if(after.localDispatchAudit?.reason==='local_dependencies_changed')expect(after.localDispatchAudit.changedParts?.length).toBeGreaterThan(0);
   expect(await f.driver.page!.locator('details').getAttribute('open')).not.toBeNull();
  }
 }finally{await f.close();}
});

it.each(['native','prevent','wrong','redirect','query','fragment'])('binds a native navigation receipt to the exact source and destination (%s)',async mode=>{
 const f=await fixture(mode);try{
  await f.execute('More');const before=f.engine.observation(f.session.id),receipt=await f.execute('Market'),after=f.engine.observation(f.session.id,receipt.afterId!),condition=f.engine.operationReceiptCondition(f.session.id,{attemptId:receipt.id});
  expect(receipt.status,receipt.reason).toBe('succeeded');expect(condition.conditionVerified,JSON.stringify({condition,audit:after.localDispatchAudit,capture:after.navigationCapture})).toBe(mode==='native');
  if(mode==='native'){
   expect(condition.policy).toBe('browser-native-navigation-receipt-v1');expect(after.documentId).not.toBe(before.documentId);
   expect(condition).toMatchObject({identityAuthorized:false,replayAuthorized:false,currentExecution:false,arrivalVerified:false});
   for(const change of ['stale-source','missing-dispatch','wrong-action','wrong-history','interrupted','missing-arrival']){
    const b=structuredClone(before),a=structuredClone(after),r=structuredClone(receipt);
    if(change==='stale-source')b.id='other';if(change==='missing-dispatch')delete r.dispatchWitness;
    if(change==='wrong-action')a.localDispatchAudit!.actionId='other';if(change==='wrong-history')a.navigation!.browserSessionId='other';
    if(change==='interrupted')a.gaps.push({code:'OBSERVATION_INTERRUPTED',message:'test',critical:true});
    if(change==='missing-arrival')delete a.navigationCapture;
    expect(actualLocalReceipt(r.action,b,a,r,f.engine.session(f.session.id)),change).toHaveProperty('unavailable');
   }
  }
 }finally{await f.close();}
});

it('withholds local completion if shared final-sample storage fails',async()=>{
 const f=await fixture('local','outside');try{
  const put=f.store.evidence.put.bind(f.store.evidence);f.store.evidence.put=async(key,value)=>{if(key.startsWith('dispatch-local-'))throw Error('storage failure');return put(key,value);};
  const receipt=await f.execute('More'),after=f.engine.observation(f.session.id,receipt.afterId!);
  expect(receipt.status).toBe('succeeded');expect(after.localDispatchAudit?.reason).toBe('local_dispatch_storage_failed');
  expect(f.engine.operationReceiptCondition(f.session.id,{attemptId:receipt.id}).conditionVerified).toBe(false);
 }finally{await f.close();}
});

it('uses the existing final document/URL observation as a second native position sample with zero settle time',async()=>{
 const f=await fixture('native','none',0);try{
  await f.execute('More');const receipt=await f.execute('Market'),after=f.engine.observation(f.session.id,receipt.afterId!);
  expect(after.navigationCapture).toMatchObject({version:1,finalPositionSample:true,samples:2});
  expect(f.engine.operationReceiptCondition(f.session.id,{attemptId:receipt.id})).toMatchObject({conditionVerified:true,policy:'browser-native-navigation-receipt-v1'});
 }finally{await f.close();}
});

it('proves an exact initial native destination before a same-loader fragment addition without treating that view as verified',async()=>{
 const f=await fixture('added-fragment');try{
  await f.execute('More');const receipt=await f.execute('Market'),before=f.engine.observation(f.session.id,receipt.beforeId),after=f.engine.observation(f.session.id,receipt.afterId!);
  expect(after.url).toMatch(/#other$/);expect(after.localDispatchAudit?.nativeNavigation?.events.map(e=>e.kind)).toEqual(['commit','same-document']);
  expect(f.engine.operationReceiptCondition(f.session.id,{attemptId:receipt.id})).toMatchObject({conditionVerified:true,policy:'browser-native-navigation-receipt-v1',arrivalVerified:false,replayAuthorized:false});
  for(const bad of ['missing-commit','different-loader','truncated','wrong-commit','unrelated-transition','explicit-source-fragment']){
   const a=structuredClone(after),b=structuredClone(before);const trace=a.localDispatchAudit!.nativeNavigation!;
   if(bad==='missing-commit')trace.events.shift();if(bad==='different-loader')trace.finalLoaderId='other';if(bad==='truncated')trace.truncated=true;
   if(bad==='wrong-commit')trace.events[0].url+='#changed';if(bad==='unrelated-transition')trace.events[1].url='/another';
   if(bad==='explicit-source-fragment')receipt.action.basis!.evidence.find(e=>e.rule==='hyperlink/v1')!.facts.href+='#required';
   expect(actualLocalReceipt(receipt.action,b,a,receipt,f.engine.session(f.session.id)),bad).toHaveProperty('unavailable');
  }
 }finally{await f.close();}
});
