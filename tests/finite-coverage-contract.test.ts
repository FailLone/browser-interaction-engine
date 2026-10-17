import {it,expect} from 'vitest';
import {explorerFixture} from './explorer-plugin-helpers.js';
import {browserOperationKey,browserTargetConditions,browserControlBindingKey} from '@interaction/browser';
import {finiteNavigationState} from '../packages/adapter-playwright/src/finite-coverage.js';

it('keeps finite operation obligations stable across unrelated selectors but retains constraints and target disclosure branches',async()=>{
 const f=await explorerFixture('<label>Pair<select id="pair"><option>A</option><option>B</option></select></label><label>Amount<input id="amount" type="number" min="1"></label><button aria-expanded="false" type="button">Open</button>');
 try{const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1'});const o=f.host.observation(s.id),a=f.host.actions(s.id).find(a=>a.label==='Amount'&&a.kind==='fill')!;const changed=structuredClone(o);changed.controls.find(c=>c.selector==='#pair')!.selected=['B'];
 expect(browserOperationKey(a,o)).toBe(browserOperationKey(a,changed));expect(browserTargetConditions(a,o)?.key).toBe(browserTargetConditions(a,changed)?.key);
 expect(finiteNavigationState(o)).not.toEqual(finiteNavigationState(changed));changed.controls.find(c=>c.localId===a.localId)!.constraints.min='2';expect(browserOperationKey(a,o)).not.toBe(browserOperationKey(a,changed));
 const button=f.host.actions(s.id).find(a=>a.label==='Open')!;const expanded=structuredClone(o);expanded.controls.find(c=>c.localId===button.localId)!.expanded=true;expect(browserOperationKey(button,o)).not.toBe(browserOperationKey(button,expanded));
 const legacy=structuredClone(o);delete legacy.coveragePolicy;const legacyChanged=structuredClone(changed);delete legacyChanged.coveragePolicy;expect(browserOperationKey(a,legacy)).not.toBe(browserOperationKey(a,legacyChanged));
 }finally{await f.close();}
});
it('binds symmetric controls to distinct document instances, never ordinal or label identity',async()=>{
 const f=await explorerFixture('<label>Reference<input type="text"></label><label>Reference<input type="text"></label>');
 try{const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1'}),o=f.host.observation(s.id);const refs=o.controls.filter(c=>c.tag==='input');expect(refs).toHaveLength(2);expect(browserControlBindingKey(refs[0],o)).not.toBe(browserControlBindingKey(refs[1],o));const rebuilt=structuredClone(o);rebuilt.instanceScope='new-document';expect(browserControlBindingKey(refs[0],o)).not.toBe(browserControlBindingKey(refs[0],rebuilt));
 }finally{await f.close();}
});
it('allows explicitly scoped local simulation while preserving submission risk and refusing other URLs',async()=>{
 const f=await explorerFixture('<form onsubmit="event.preventDefault()"><button>Submit</button></form>');
 try{const no=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui'});let a=f.host.actions(no.id).find(a=>a.label==='Submit')!;expect(f.host.actionAvailability(no.id).actions.find(x=>x.actionId===a.id)?.blockers.some(b=>b.reason==='submission_not_authorized')).toBe(true);
 await f.host.stop(no.id);
 const yes=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui',coveragePolicy:'finite-ui-v1',localSimulation:{url:f.url}});a=f.host.actions(yes.id).find(a=>a.label==='Submit')!;expect(a.risk).toBe('submission');expect(f.host.actionAvailability(yes.id).actions.find(x=>x.actionId===a.id)?.executable).toBe(true);const receipt=await f.host.execute(yes.id,a.id,'local-submit',undefined,{profile:'observed-ui-exploration',observationId:a.observationId});expect(receipt.status).toBe('succeeded');expect(f.host.operationReceiptCondition(yes.id,{attemptId:receipt.id}).conditionVerified).toBe(true);expect(receipt.effectsAssessment).toBe('not-assessed');
 await f.host.stop(yes.id);
 const other=await f.host.createSession({url:f.url,headless:true,executionPolicy:'observed-ui',localSimulation:{url:f.url+'different'}});a=f.host.actions(other.id).find(a=>a.label==='Submit')!;expect(f.host.actionAvailability(other.id).actions.find(x=>x.actionId===a.id)?.blockers.some(b=>b.reason==='submission_not_authorized')).toBe(true);
 }finally{await f.close();}
});

it('keeps anonymous native target references stable through sibling deletion, addition and reordering, but not replacement',async()=>{
 const {pageOf}=await import('./helpers.js');const f=await explorerFixture('<section id="siblings"><label>Reference<input></label><label>Reference<input></label></section><label>Stable<input id="stable"></label>');
 try{const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1'});const first=f.host.observation(s.id),fields=first.controls.filter(c=>c.tag==='input'&&!c.stableKey),b=fields[1],original=browserControlBindingKey(b,first);const stable=first.controls.find(c=>c.selector==='#stable')!,stableKey=browserControlBindingKey(stable,first);
 const p=pageOf(f.host);await p.evaluate(()=>{const parent=document.querySelector('#siblings')!;(window as any).survivor=parent.lastElementChild;parent.firstElementChild!.remove();});await f.host.observe(s.id);let o=f.host.observation(s.id);expect(browserControlBindingKey(o.controls.find(c=>c.instanceId===b.instanceId)!,o)).toBe(original);
 await p.evaluate(()=>{const parent=document.querySelector('#siblings')!;parent.insertAdjacentHTML('beforeend','<label>Reference<input></label>');parent.append((window as any).survivor);});await f.host.observe(s.id);o=f.host.observation(s.id);expect(browserControlBindingKey(o.controls.find(c=>c.instanceId===b.instanceId)!,o)).toBe(original);
 await p.evaluate(()=>{const el=(window as any).survivor.querySelector('input');el.replaceWith(el.cloneNode());const stable=document.querySelector('#stable')!;stable.replaceWith(stable.cloneNode());});await f.host.observe(s.id);o=f.host.observation(s.id);expect(o.controls.some(c=>c.instanceId===b.instanceId)).toBe(false);expect(o.controls.filter(c=>c.tag==='input'&&!c.stableKey).every(c=>browserControlBindingKey(c,o)!==original)).toBe(true);expect(browserControlBindingKey(o.controls.find(c=>c.selector==='#stable')!,o)).toBe(stableKey);
 }finally{await f.close();}
});

it('abstracts only native passive readouts and preserves navigation guards, controls, page and boundaries',async()=>{
 const f=await explorerFixture('<input id="quote" readonly aria-label="Quote 1" value="1"><button id="open" aria-expanded="false">Open</button><input id="amount" value="1">');
 try{const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1'});const o=f.host.observation(s.id),base=finiteNavigationState(o);const refreshed=structuredClone(o),q=refreshed.controls.find(c=>c.selector==='#quote')!;q.value='2';q.name='Quote 2';q.label='Quote 2';q.reviewBinding!.attributes['aria-label']='Quote 2';expect(finiteNavigationState(refreshed)).toEqual(base);
 for(const change of [(x:typeof o)=>{x.url+='/other';},(x:typeof o)=>{x.controls=x.controls.filter(c=>c.selector!=='#open');},(x:typeof o)=>{x.controls.find(c=>c.selector==='#open')!.enabled=false;},(x:typeof o)=>{x.controls.find(c=>c.selector==='#open')!.expanded=true;},(x:typeof o)=>{x.controls.find(c=>c.selector==='#amount')!.value='2';},(x:typeof o)=>{x.boundaries=[{key:'dialog',name:'Confirm',region:'dialog',evidence:[]}];}] ) {const changed=structuredClone(o);change(changed);expect(finiteNavigationState(changed)).not.toEqual(base);}
 }finally{await f.close();}
});

it('does not manufacture an operation from an exact empty handler while retaining opaque or nonempty handlers',async()=>{
 const f=await explorerFixture('<div id="empty">Container</div><div id="real">Actual handler</div><script>document.querySelector("#empty").onclick=function noop$1() {};document.querySelector("#real").onclick=function(){window.clicked=true}</script>');
 try{const s=await f.host.createSession({url:f.url,headless:true});const o=f.host.observation(s.id);expect(o.controls.some(c=>c.selector==='#empty')).toBe(false);expect(o.controls.find(c=>c.selector==='#real')?.actionBasis?.click?.status).toBe('tentative');
 }finally{await f.close();}
});

it('rejects unknown, failed, missing dispatch, wrong-instance and incomplete finite receipts without changing actual outcome',async()=>{
 const f=await explorerFixture('<button id="native" type="button" onclick="this.dataset.clicked=\'yes\'">Native operation</button>');
 try{const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui'});const a=f.host.actions(s.id).find(a=>a.label==='Native operation')!;expect(a.risk).toBe('unknown');const receipt=await f.host.execute(s.id,a.id,'witness-native',undefined,{profile:'observed-ui-exploration',observationId:a.observationId});expect(f.host.operationReceiptCondition(s.id,{attemptId:receipt.id}).conditionVerified).toBe(true);
 const before=f.host.observation(s.id,receipt.beforeId),after=f.host.observation(s.id,receipt.afterId!);
 const changes=[(r:typeof receipt)=>{r.status='unknown';},(r:typeof receipt)=>{r.status='failed';},(r:typeof receipt)=>{delete r.dispatchWitness;},(r:typeof receipt)=>{r.dispatchWitness!.instanceId='another-node';},(r:typeof receipt)=>{r.dispatchWitness!.actionKey='another-action';},(r:typeof receipt)=>{r.dispatchWitness!.returnedAt=new Date(Date.parse(after.capturedAt)+1).toISOString();},(r:typeof receipt)=>{r.dispatchWitness!.returnedAt=new Date(Date.parse(r.startedAt)-1).toISOString();}];
 for(const change of changes){const altered=structuredClone(receipt);change(altered);f.host.store.put('attempt',altered);expect(f.host.operationReceiptCondition(s.id,{attemptId:receipt.id}).conditionVerified).toBe(false);f.host.store.put('attempt',receipt);}
 const {MemoryStore}=await import('@interaction/storage-memory');const {BrowserEngine}=await import('@interaction/browser');
 for(const change of ['wrong-instance','incomplete-after']){const store=new MemoryStore();for(const kind of ['session','observation','action','attempt','frontier','identity','hypothesis','control-review','scope','continuation','boundary-exit-result','exploration-group'])for(const row of f.host.store.list<any>(kind,s.id)){const copy=structuredClone(row);if(kind==='observation'&&copy.id===before.id&&change==='wrong-instance')copy.controls.find((c:any)=>c.localId===a.localId).instanceId='replaced';if(kind==='observation'&&copy.id===after.id&&change==='incomplete-after')copy.gaps.push({code:'INCOMPLETE',message:'Negative fixture',critical:true});store.put(kind,copy);}const reader=new BrowserEngine({persistence:store});try{expect(reader.operationReceiptCondition(s.id,{attemptId:receipt.id}).conditionVerified).toBe(false);}finally{await reader.close();}}
 expect(f.host.operationReceiptCondition(s.id,{attemptId:receipt.id}).conditionVerified).toBe(true);
 }finally{await f.close();}
});

it('finite sampling does not turn a revoked reviewed operation into native coverage',async()=>{
 const f=await explorerFixture('<button id="native" type="button">Native operation</button>');
 try{const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui'}),o=f.host.observation(s.id);const [review]=await f.host.reviewControls(s.id,{observationId:o.id,source:'test-authority',reviews:[{localId:o.controls.find(c=>c.selector==='#native')!.localId,kind:'click',risk:'interface',replayable:false,reason:'Local native test',evidence:['Owned fixture']}]});const a=f.host.actions(s.id).find(a=>a.label==='Native operation')!;const receipt=await f.host.execute(s.id,a.id,'reviewed-native',undefined,{profile:'observed-ui-exploration',observationId:a.observationId});expect(f.host.operationReceiptCondition(s.id,{attemptId:receipt.id}).conditionVerified).toBe(true);
 await f.host.command(s.id,{type:'revokeControlReview',revocation:{reviewId:review.id,source:'negative-test',reason:'Withdraw authority'}});expect(f.host.operationReceiptCondition(s.id,{attemptId:receipt.id}).conditionVerified).toBe(false);
 }finally{await f.close();}
});

it('does not use the finite switch to erase a missing anonymous-target condition witness',async()=>{
 const f=await explorerFixture('<label>Reference<input></label><label>Reference<input></label>');
 try{const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui'});const o=f.host.observation(s.id),target=o.controls.find(c=>c.tag==='input'&&c.hypothesisId);expect(target).toBeDefined();const a=f.host.actions(s.id).find(a=>a.localId===target!.localId&&a.kind==='fill')!;const receipt=await f.host.execute(s.id,a.id,'unresolved-reference',undefined,{profile:'observed-ui-exploration',observationId:a.observationId});expect(receipt.status).toBe('succeeded');expect(receipt.dispatchWitness).toBeDefined();const proof=f.host.operationReceiptCondition(s.id,{attemptId:receipt.id});expect(proof.actualSuccess).toBe(true);expect(proof.status).toBe('document');
 const {MemoryStore}=await import('@interaction/storage-memory');const {BrowserEngine}=await import('@interaction/browser');const store=new MemoryStore();for(const kind of ['session','observation','action','attempt','frontier','identity','hypothesis','control-review','scope','continuation','boundary-exit-result','exploration-group'])for(const row of f.host.store.list<any>(kind,s.id)){const copy=structuredClone(row);if(kind==='observation'&&copy.id===receipt.afterId)delete copy.ownerDependencyDispatch;store.put(kind,copy);}const reader=new BrowserEngine({persistence:store});try{expect(reader.operationReceiptCondition(s.id,{attemptId:receipt.id})).toMatchObject({actualSuccess:true,conditionVerified:false,reason:'dispatch_witness_missing'});}finally{await reader.close();}
 }finally{await f.close();}
});


it('reports sampled obligations separately from observed combinations and unproved dependencies',async()=>{
 const {coverageLedger}=await import('@interaction/explorer-plugin');const f=await explorerFixture('<button id="native" type="button">Native operation</button>');
 try{const s=await f.host.createSession({url:f.url,headless:true,coveragePolicy:'finite-ui-v1',executionPolicy:'observed-ui'});const a=f.host.actions(s.id).find(a=>a.label==='Native operation')!;
 const receipt=await f.host.execute(s.id,a.id,'ledger-native',undefined,{profile:'observed-ui-exploration',observationId:a.observationId});
 const task={id:'ledger-projection-test',sessionOptions:{coveragePolicy:'finite-ui-v1'},rounds:[{sessionId:s.id}],plan:[{id:'sample',required:true,scope:{kind:'click'},status:'succeeded',attempts:[],resolvedBy:{sessionId:s.id,observationId:receipt.afterId!,attemptId:receipt.id},conditionCompletion:{status:'verified'},evidence:[{sessionId:s.id,observationId:receipt.beforeId}]}]} as any;
 const ledger=coverageLedger(f.host,task);expect(ledger.finite).toMatchObject({total:1,verified:1,remaining:[]});expect(ledger.conditionCombinations.exhaustive).toBe(false);expect(ledger.unknownDependencies.status).toBe('unproved');expect(ledger.conditionCombinations.rows.flatMap(r=>Object.values(r.operations)).flatMap(o=>o.executed).some(e=>e.attemptId===receipt.id&&e.verified)).toBe(true);
 task.plan.push({...task.plan[0],id:'related',resolvedBy:undefined,coverageResolvedBy:{observation:{sessionId:s.id,observationId:receipt.afterId!},relatedItemIds:['sample']}});
 expect(coverageLedger(f.host,task).finite).toMatchObject({total:2,verified:2,remaining:[]});
 task.plan[1].coverageResolvedBy.relatedItemIds=['missing'];expect(coverageLedger(f.host,task).finite).toMatchObject({verified:1,remaining:['related']});task.plan[1].coverageResolvedBy.relatedItemIds=['sample'];
 const altered=structuredClone(receipt);delete altered.dispatchWitness;f.host.store.put('attempt',altered);expect(coverageLedger(f.host,task).finite).toMatchObject({verified:0,remaining:['sample','related']});
 }finally{await f.close();}
});
