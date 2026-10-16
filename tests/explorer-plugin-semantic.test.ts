import { join } from 'node:path';
import { it,expect,vi } from 'vitest';
import { ExplorerPlugin,ExplorerStore,type Decision } from '@interaction/explorer-plugin';
import { semanticRejection,type SemanticReview } from '../packages/explorer-plugin/src/semantic-review.js';
import { reviewNext,unresolvedPurposeKey,type ReviewContext } from '../packages/explorer-plugin/src/reviews.js';
import { explorerFixture,fakeProviders,semanticPopupHtml } from './explorer-plugin-helpers.js';
import { remapStoredReviewScopes } from '../packages/explorer-plugin/src/scope-migration.js';
import { reviewGapChanges } from '../packages/explorer-plugin/src/review-ledger.js';

const grounded={choice:'click',evidenceRefs:['current','actions','effect:click'],reason:'Captured child choice panel supports a local expansion.',interfaceOnly:true,externalWrite:false};
const separateRegions=`${Array.from({length:7},(_,i)=>`<section aria-label="Region ${i}"><h2>Region ${i}</h2><button type="button" onclick="this.disabled=true">Action ${i}</button></section>`).join('')}<script>document.addEventListener('DOMContentLoaded',()=>{document.querySelector('main>h1').remove();const main=document.querySelector('main');main.replaceWith(...main.children)})</script>`;
const probeFixture=(reveals=true)=>`<div id="mystery" role="button" tabindex="0" aria-label="Mystery" aria-haspopup="menu" style="width:180px;height:40px">Mystery</div><div id="panel" hidden><button type="button" onclick="this.disabled=true">Revealed</button></div><script>document.getElementById('mystery').addEventListener('mouseenter',()=>{${reveals?"document.getElementById('panel').hidden=false":""}})</script>`;
function probeProviders(url:string,mode:'allow'|'uncertain'|'external'='allow') {
 const p=fakeProviders(url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>{
  if(r.purpose==='control-classification'&&(r.state as any).material.control.name==='Mystery')return {model:'mock',value:'interaction',confidence:1};
  if(r.purpose==='control-risk'&&(r.state as any).material.control.name==='Mystery')return {model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.01]))};
  if(r.purpose==='probe-risk')return {model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,mode==='uncertain'?.5:k==='interface_hover'||mode==='external'&&k==='external_hover'?.99:.01]))};
  return original(r,s);
 };return p;
}

it('uses an independently approved probe to reveal UI behind an interactive control with unresolved click purpose',async()=>{
 const f=await explorerFixture(probeFixture()),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),probeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:4}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),sid=v.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
  expect(attempts.map(a=>[a.action.kind,a.action.label,a.status])).toEqual([['hover','hover: Mystery','succeeded'],['click','Revealed','succeeded']]);
  const probe=attempts[0];expect(f.host.observation(sid,probe.beforeId).controls.find(c=>c.name==='Revealed')?.visible).not.toBe(true);expect(f.host.observation(sid,probe.afterId).controls.find(c=>c.name==='Revealed')?.visible).toBe(true);
  expect(v.task.usage.actions).toBe(2);expect(v.task.pendingDispatch).toBeUndefined();expect(v.task.status).not.toBe('completed');
  expect(v.task.plan.some(i=>i.scope.label==='Mystery'&&i.status==='unresolved')).toBe(true);
  expect(v.events.find(e=>e.type==='probe.verified')?.data).toMatchObject({attemptId:probe.id,status:'succeeded',executionCoverage:false});
  expect(v.events.some(e=>e.type==='decision.effect'&&(e.data as any).kind==='probe')).toBe(true);
  expect(v.decisions.some(d=>d.actor==='llm')).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it.each(['uncertain','external'] as const)('does not probe on %s probe evidence even for a probe_required classification',async(mode)=>{
 const f=await explorerFixture(probeFixture()),p=probeProviders(f.url,mode),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'&&(r.state as any).material.control.name==='Mystery'?{model:'mock',value:'probe_required',confidence:1}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:4}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(f.host.list(v.task.rounds[0].sessionId,'attempt')).toEqual([]);expect(v.task.plan.some(i=>i.scope.label==='Mystery'&&i.reason==='probe_unresolved'&&i.status==='unresolved')).toBe(true);expect(v.task.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('retains a no-effect probe as evidence without repeating it or granting a click',async()=>{
 const f=await explorerFixture(probeFixture(false)),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),probeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:4}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),attempts=f.host.list<any>(v.task.rounds[0].sessionId,'attempt');
  expect(attempts.map(a=>a.action.kind)).toEqual(['hover']);expect(v.task.status).not.toBe('completed');expect(v.task.plan.some(i=>i.scope.label==='Mystery'&&i.status==='unresolved')).toBe(true);
 }finally{await plugin.close();await f.close();}
});

it.each(['unknown','missing-record'] as const)('persists %s probe dispatch across restart and never blindly retries it',async(mode)=>{
 const f=await explorerFixture(probeFixture()),path=join(f.dir,'probe.sqlite');let count=0,unknownId:string|undefined,plugin:ExplorerPlugin;
 const host=new Proxy(f.host,{get(target,key){
  if(key==='command')return async(sid:string,command:any)=>{if(command.type!=='probe')return target.command(sid,command);count++;expect(plugin.store.tasks()[0].pendingDispatch?.probe).toMatchObject({localId:command.localId,kind:'hover'});if(mode==='missing-record')throw new Error('connection_lost');const attempt=await target.command(sid,command) as any;unknownId=attempt.id;return {...attempt,status:'unknown'};};
  if(key==='list')return (sid:string,kind:string)=>target.list<any>(sid,kind).map(x=>kind==='attempt'&&x.id===unknownId?{...x,status:'unknown'}:x);
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 plugin=new ExplorerPlugin(host,new ExplorerStore(path),probeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:2,actions:5}});plugin.start(t.id);await plugin.waitForIdle();let v=plugin.view(t.id);
  expect(v.task.reason).toBe('UNKNOWN_DISPATCH_REQUIRES_REVIEW');expect(v.task.pendingDispatch?.probe?.kind).toBe('hover');expect(count).toBe(1);const usage={...v.task.usage};await plugin.close();
  plugin=new ExplorerPlugin(host,new ExplorerStore(path),probeProviders(f.url));plugin.start(t.id);await plugin.waitForIdle();v=plugin.view(t.id);
  expect(count).toBe(1);expect(v.task.pendingDispatch?.probe?.kind).toBe('hover');expect(v.task.reason).toBe('UNKNOWN_DISPATCH_REQUIRES_REVIEW');expect(v.task.usage.actions).toBe(usage.actions);expect(v.task.usage.modelRequests).toBe(usage.modelRequests);
  expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').every(a=>a.action.source==='external-probe')).toBe(true);
 }finally{await plugin.close();await f.close();}
});

it('cancels a pending probe judgment on takeover without dispatching its late approval',async()=>{
 const f=await explorerFixture(probeFixture()),p=probeProviders(f.url),original=p.jev.decide;let began!:()=>void,resolve!:(v:any)=>void;const waiting=new Promise<void>(r=>began=r);
 p.jev.decide=async(r,s)=>r.purpose==='probe-risk'?new Promise(done=>{resolve=done;began();}):original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await waiting;await plugin.pause(t.id);resolve({model:'mock',value:{interface_hover:.99,external_hover:.01,interface_focus:.01,external_focus:.01}});await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(v.task.status).toBe('paused');expect(v.task.pendingDispatch).toBeUndefined();expect(f.host.list(v.task.rounds[0].sessionId,'attempt')).toEqual([]);expect(v.decisions.find(d=>d.purpose==='probe-risk')?.status).toBe('cancelled');
 }finally{await plugin.close();await f.close();}
});

it('waits for an issued probe on takeover, records its result and does not dispatch revealed controls',async()=>{
 const f=await explorerFixture(probeFixture());let began!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>began=r),held=new Promise<void>(r=>release=r);
 const host=new Proxy(f.host,{get(target,key){if(key==='command')return async(sid:string,command:any)=>{const result=await target.command(sid,command);if(command.type==='probe'){began();await held;}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),probeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await waiting;expect(plugin.store.task(t.id).pendingDispatch?.probe).toBeDefined();const paused=plugin.pause(t.id);release();await paused;const v=plugin.view(t.id);
  expect(v.task.status).toBe('paused');expect(v.task.pendingDispatch).toBeUndefined();expect(v.task.usage.actions).toBe(1);expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').map(a=>a.action.kind)).toEqual(['hover']);expect(v.events.find(e=>e.type==='probe.verified')?.data).toMatchObject({status:'succeeded',executionCoverage:false});
 }finally{release();await plugin.close();await f.close();}
});

it('rejects stale probe approval after a new observation and never executes it',async()=>{
 const f=await explorerFixture(probeFixture()),p=probeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>{const result=await original(r,s);if(r.purpose==='probe-risk')await f.host.observe(f.host.sessions()[0].id);return result;};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,modelRequests:80}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(v.decisions.some(d=>d.purpose==='probe-risk'&&d.status==='stale')).toBe(true);expect(f.host.list(v.task.rounds[0].sessionId,'attempt')).toEqual([]);expect(v.task.pendingDispatch).toBeUndefined();
 }finally{await plugin.close();await f.close();}
});

it('retains newly revealed controls when a probe consumes the last action budget',async()=>{
 const f=await explorerFixture(probeFixture()),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),probeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(v.task.usage.actions).toBe(1);expect(v.task.pendingDispatch).toBeUndefined();expect(v.task.status).not.toBe('completed');expect(v.task.plan.some(i=>i.required&&i.scope.label==='Revealed'&&i.status!=='succeeded'&&i.prerequisites.some(p=>p.label==='Mystery'&&p.kind==='hover'))).toBe(true);
 }finally{await plugin.close();await f.close();}
});

it('keeps a missing probe capability as a gap while continuing other available controls',async()=>{
 const f=await explorerFixture(probeFixture(false)+'<button type="button" onclick="this.disabled=true">Ready</button>');
 const host=new Proxy(f.host,{get(target,key){if(key==='command')return (sid:string,cmd:any)=>{if(cmd.type==='probe')throw Object.assign(new Error('Unsupported'),{code:'UNSUPPORTED_PROBE'});return target.command(sid,cmd);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),probeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:4}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(v.task.pendingDispatch).toBeUndefined();expect(v.task.plan.some(i=>i.required&&i.reason==='missing_capability:probe'&&i.status==='unresolved')).toBe(true);expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').map(a=>a.action.label)).toEqual(['Ready']);expect(v.task.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('limits probes and revealed work to the accepted target scope',async()=>{
 const f=await explorerFixture(probeFixture()+'<div role="button" tabindex="0" aria-label="Other">Other</div>'),p=probeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{model:'mock',value:'interaction',confidence:1}:r.purpose==='control-risk'?{model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.01]))}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:4}});plugin.revise(t.id,{items:[{title:'Mystery',scope:{url:f.url,label:'Mystery'},prerequisites:[],required:true,completion:'Verify Mystery',reason:'user target'}]});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id);
  expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').map(a=>a.action.label)).toEqual(['hover: Mystery']);expect(v.decisions.filter(d=>d.purpose==='probe-risk').every(d=>(d.request.state as any).material.control.name==='Mystery')).toBe(true);expect(v.task.status).not.toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('batches non-overlapping region judgments while retaining every source decision and current binding',async()=>{
 const f=await explorerFixture(separateRegions),commands:any[]=[];
 const host=new Proxy(f.host,{get(target,key){if(key==='command')return async(sid:string,command:any)=>{if(command.type==='reviewRegions')commands.push({command,actions:target.session(sid).actionCount});return target.command(sid,command);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:20}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),initial=commands.filter(c=>c.actions===0).map(c=>c.command.review);
  expect(initial.map(c=>c.regions.length)).toEqual([5,2]);
  for(const review of initial){const ids=review.regions.flatMap((r:any)=>r.controlIds);expect(new Set(ids).size).toBe(ids.length);expect(review.evidence).toHaveLength(review.regions.length);for(const ref of review.evidence){const d=v.decisions.find(d=>`explorer-decision:${d.id}`===ref)!;expect(d).toMatchObject({purpose:'region-review',status:'applied',observationId:review.observationId});expect(v.events.some(e=>e.type==='decision.effect'&&e.decisionId===d.id&&(e.data as any).details?.decisionIds?.length===review.regions.length)).toBe(true);}}
  expect(v.task.usage.actions).toBe(7);expect(v.task.status).toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('cancels prepared region judgments without submitting a partial partition',async()=>{
 const f=await explorerFixture(separateRegions),p=fakeProviders(f.url),original=p.jev.decide;let count=0,began!:()=>void,finish!:(value:any)=>void;const waiting=new Promise<void>(r=>began=r);
 p.jev.decide=async(r,s)=>{if(r.purpose!=='region-review')return original(r,s);if(++count===3)return new Promise(resolve=>{finish=resolve;began();});return {model:'mock',value:'include',confidence:1};};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await waiting;await plugin.pause(t.id);finish({model:'mock',value:'include',confidence:1});await plugin.waitForIdle();const v=plugin.view(t.id),ds=v.decisions.filter(d=>d.purpose==='region-review');
  expect(v.task.status).toBe('paused');expect(v.task.usage.actions).toBe(0);expect(f.host.list(v.task.rounds[0].sessionId,'region-review')).toEqual([]);expect(ds).toHaveLength(3);expect(ds.every(d=>d.status==='cancelled')).toBe(true);
 }finally{await plugin.close();await f.close();}
});

it('rejudges a deferred region after committing earlier clear regions',async()=>{
 const f=await explorerFixture(separateRegions),p=fakeProviders(f.url),original=p.jev.decide;let count=0;
 p.jev.decide=async(r,s)=>r.purpose==='region-review'?{model:'mock',value:++count===2?'uncertain':'include',confidence:1}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),ds=v.decisions.filter(d=>d.purpose==='region-review'&&(d.request.state as any).material.candidate.label==='Region 1');
  expect(ds).toHaveLength(2);expect(ds[0]).toMatchObject({status:'rejected',reason:'region_batch_recapture'});expect(ds[1].status).toBe('applied');expect(ds[0].observationId).not.toBe(ds[1].observationId);expect(v.events.some(e=>e.type==='decision.effect'&&e.decisionId===ds[0].id&&(e.data as any).kind==='review')).toBe(false);expect(v.task.status).toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('discards all prepared regions when their source observation becomes stale',async()=>{
 const f=await explorerFixture(separateRegions),p=fakeProviders(f.url),original=p.jev.decide;let count=0;
 p.jev.decide=async(r,s)=>{if(r.purpose!=='region-review')return original(r,s);if(++count===5)await f.host.observe(f.host.sessions()[0].id);return {model:'mock',value:'include',confidence:1};};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),ds=v.decisions.filter(d=>d.purpose==='region-review'),records=f.host.list<any>(v.task.rounds[0].sessionId,'region-review');
  expect(ds).toHaveLength(12);expect(ds.slice(0,5).every(d=>d.status==='stale')).toBe(true);expect(ds.slice(5).every(d=>d.status==='applied')).toBe(true);expect(records.every(r=>r.observationId!==ds[0].observationId)).toBe(true);expect(v.task.status).toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('invalidates unresolved purpose evidence when document, context, structure, size, action basis or task revision changes',()=>{
 const o={instanceScope:'doc',url:'https://fixture/',context:{},boundaries:[]} as any;
 const item={control:{instanceId:'control',name:'Unclear',rect:{x:0,y:0,width:80,height:20},reviewBinding:{attributes:{role:'button'}}},reviews:[],actions:[{id:'old',observationId:'before',kind:'click',risk:'unknown',basis:{status:'unconfirmed',evidence:[]}}]} as any;
 const key=unresolvedPurposeKey(o,item,1),shifted=structuredClone(item);shifted.control.rect.x=20;shifted.control.rect.y=90;shifted.actions[0].id='fresh';shifted.actions[0].observationId='after';expect(unresolvedPurposeKey(o,shifted,1)).toBe(key);
 for(const update of [(x:any)=>x.instanceScope='fresh-doc',(x:any)=>x.url='https://fixture/other',(x:any)=>x.context={tab:{status:'known',value:'Other'}},(x:any)=>x.boundaries=[{key:'dialog'}]]){const fresh=structuredClone(o);update(fresh);expect(unresolvedPurposeKey(fresh,item,1)).not.toBe(key);}
 for(const update of [(x:any)=>x.control.name='New purpose',(x:any)=>x.control.rect.width=120,(x:any)=>x.control.reviewBinding.attributes['aria-haspopup']='menu',(x:any)=>x.actions[0].basis={status:'supported',evidence:[]},(x:any)=>x.reviews=[{id:'review',status:'revoked'}]]){const fresh=structuredClone(item);update(fresh);expect(unresolvedPurposeKey(o,fresh,1)).not.toBe(key);}
 expect(unresolvedPurposeKey(o,item,2)).not.toBe(key);
});

it.each(['position','content'] as const)('retains an unresolved purpose after a %s change without granting an operation',async(mode)=>{
 const change=mode==='position'?"document.getElementById('unclear').style.transform='translateY(40px)'":"document.getElementById('unclear').textContent='Changed purpose evidence'";
 const f=await explorerFixture(`<div role="button" tabindex="0" id="unclear" style="cursor:pointer">Unclear</div><button type="button" onclick="this.disabled=true;${change}">Shift</button>`),p=fakeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{model:'mock',value:'interaction',confidence:1}:r.purpose==='control-risk'&&(r.state as any).material.control.stableKey==='id:unclear'?{model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.01]))}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:10}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),ds=v.decisions.filter(d=>d.purpose==='control-risk'&&(d.request.state as any).material.control.stableKey==='id:unclear');
  expect(ds).toHaveLength(mode==='position'?1:2);expect(f.host.list<any>(v.task.rounds[0].sessionId,'attempt').map(a=>a.action.label)).toEqual(['Shift']);expect(v.task.status).not.toBe('completed');
  expect(v.task.plan.some(i=>i.reason==='operation_risk_unresolved'&&i.status==='unresolved')).toBe(true);expect(v.decisions.some(d=>d.actor==='llm')).toBe(false);
  if(mode==='position'){const event=v.events.find(e=>e.type==='review.unchanged');expect(event).toBeDefined();expect(event!.data).toMatchObject({sourceDecisionId:ds[0].id,sourceObservationId:ds[0].observationId,executionAuthorized:false,reason:'unchanged_unresolved_evidence'});expect(event!.observationId).not.toBe(ds[0].observationId);}
 }finally{await plugin.close();await f.close();}
});

it('batches clear classifications from one observation and preserves each decision as separate evidence',async()=>{
 const f=await explorerFixture(`${Array.from({length:6},(_,i)=>`<div id="section-${i}" tabindex="0">Section ${i}</div>`).join('')}<button type="button" onclick="this.disabled=true">Ready</button>`),p=fakeProviders(f.url),original=p.jev.decide,commands:any[]=[];
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{model:'mock',value:'container',confidence:1}:original(r,s);
 const host=new Proxy(f.host,{get(target,key){if(key==='command')return async(sid:string,command:any)=>{if(command.type==='classifyControls')commands.push(command);return target.command(sid,command);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),ds=v.decisions.filter(d=>d.purpose==='control-classification');
  expect(commands.map(c=>c.classification.classifications.length)).toEqual([5,1]);expect(ds).toHaveLength(6);expect(v.task.status).toBe('completed');expect(v.task.usage.actions).toBe(1);
  for(const cmd of commands)for(const c of cmd.classification.classifications){const d=ds.find(d=>c.evidence.includes(`explorer-decision:${d.id}`))!;expect(d.status).toBe('applied');expect(d.observationId).toBe(cmd.classification.observationId);expect((d.request.state as any).material.control.localId).toBe(c.localId);expect(v.events.some(e=>e.decisionId===d.id&&e.type==='decision.effect'&&(e.data as any).kind==='review')).toBe(true);}
  expect(new Set(ds.map(d=>d.observationId)).size).toBe(2);
 }finally{await plugin.close();await f.close();}
});

it('cancels a partially prepared classification batch without submitting any of its entries',async()=>{
 const f=await explorerFixture(Array.from({length:4},(_,i)=>`<div id="section-${i}" tabindex="0">Section ${i}</div>`).join('')),p=fakeProviders(f.url),original=p.jev.decide;
 let count=0,began!:()=>void,finish!:(value:any)=>void;const waiting=new Promise<void>(r=>began=r);
 p.jev.decide=async(r,s)=>{if(r.purpose!=='control-classification')return original(r,s);if(++count===3)return new Promise(resolve=>{finish=resolve;began();});return {model:'mock',value:'container',confidence:1};};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await waiting;await plugin.pause(t.id);finish({model:'mock',value:'container',confidence:1});await plugin.waitForIdle();const v=plugin.view(t.id),ds=v.decisions.filter(d=>d.purpose==='control-classification');
  expect(v.task.status).toBe('paused');expect(v.task.usage.actions).toBe(0);expect(f.host.list(v.task.rounds[0].sessionId,'control-classification')).toEqual([]);expect(ds).toHaveLength(3);expect(ds.every(d=>d.status==='cancelled')).toBe(true);
 }finally{await plugin.close();await f.close();}
});

it('revisits an uncertain batch member using the new observation without applying its earlier answer',async()=>{
 const f=await explorerFixture('<div id="clear" tabindex="0">Clear</div><div id="uncertain" tabindex="0">Ambiguous</div><button type="button" onclick="this.disabled=true">Ready</button>'),p=fakeProviders(f.url),original=p.jev.decide;let uncertainCalls=0;
 p.jev.decide=async(r,s)=>{if(r.purpose!=='control-classification')return original(r,s);return {model:'mock',value:(r.state as any).material.control.name==='Ambiguous'&&++uncertainCalls===1?'uncertain':'container',confidence:1};};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),ds=v.decisions.filter(d=>d.purpose==='control-classification'&&(d.request.state as any).material.control.name==='Ambiguous');
  expect(ds).toHaveLength(2);expect(ds[0]).toMatchObject({status:'rejected',reason:'classification_batch_recapture'});expect(ds[1].status).toBe('applied');expect(ds[0].observationId).not.toBe(ds[1].observationId);
  expect(v.events.some(e=>e.decisionId===ds[0].id&&e.type==='decision.effect'&&(e.data as any).kind==='review-deferred')).toBe(true);expect(v.events.some(e=>e.decisionId===ds[0].id&&e.type==='decision.effect'&&(e.data as any).kind==='review')).toBe(false);expect(v.decisions.some(d=>d.actor==='llm')).toBe(false);expect(v.task.status).toBe('completed');expect(v.task.usage.actions).toBe(1);
 }finally{await plugin.close();await f.close();}
});

it('discards a stale prepared batch and reclassifies its targets using a fresh observation',async()=>{
 const f=await explorerFixture(`${Array.from({length:5},(_,i)=>`<div id="section-${i}" tabindex="0">Section ${i}</div>`).join('')}<button type="button" onclick="this.disabled=true">Ready</button>`),p=fakeProviders(f.url),original=p.jev.decide;let count=0;
 p.jev.decide=async(r,s)=>{if(r.purpose!=='control-classification')return original(r,s);if(++count===5)await f.host.observe(f.host.sessions()[0].id);return {model:'mock',value:'container',confidence:1};};
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(t.id);await plugin.waitForIdle();const v=plugin.view(t.id),ds=v.decisions.filter(d=>d.purpose==='control-classification');
  expect(ds).toHaveLength(10);expect(ds.slice(0,5).every(d=>d.status==='stale')).toBe(true);expect(ds.slice(5).every(d=>d.status==='applied')).toBe(true);
  const records=f.host.list<any>(v.task.rounds[0].sessionId,'control-classification');expect(records).toHaveLength(5);expect(records.every(r=>r.observationId===ds[5].observationId&&r.observationId!==ds[0].observationId)).toBe(true);expect(v.task.usage.actions).toBe(1);expect(v.task.status).toBe('completed');
 }finally{await plugin.close();await f.close();}
});

it('remaps a uniquely evidenced legacy review gap and closes it with fresh classification, not an invented action',async()=>{
 const f=await explorerFixture('<div id="unclear" tabindex="0">Details</div><button type="button" onclick="this.disabled=true">Ready</button>'),p=fakeProviders(f.url),original=p.jev.decide;let clarified=false;
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{model:'mock',value:clarified?'container':'uncertain',confidence:1}:r.purpose==='control-risk'&&(r.state as any).material.control.name==='Details'?{model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.01]))}:original(r,s);
 p.llm.decide=async(r,s)=>r.purpose==='classification-clarification'?{model:'mock',value:{choice:'uncertain',reason:'Evidence is insufficient',evidenceRefs:[],interfaceOnly:null,externalWrite:null}}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:1}});plugin.start(t.id);await plugin.waitForIdle();const saved=plugin.store.task(t.id),gap=saved.plan.find(i=>i.reason==='classification_unresolved'&&i.scope.label==='Details')!;expect(gap).toBeDefined();
  gap.scope={url:f.url,label:'',role:'generic'};const originalEvidence=structuredClone(gap.evidence);plugin.store.save(saved);clarified=true;
  plugin.extendBudget(t.id,{rounds:1,actions:2,durationMs:60000,modelRequests:100});plugin.start(t.id);await plugin.waitForIdle();const view=plugin.view(t.id),current=view.task.plan.find(i=>i.id===gap.id)!;
  expect(current.scope).toMatchObject({label:'Details',stableKey:'id:unclear'});expect(current.status,JSON.stringify(view.task)).toBe('succeeded');expect(current.reviewResolvedBy).toMatchObject({sessionId:view.task.rounds[1].sessionId,classification:'container'});
  expect(current.resolvedBy).toBeUndefined();expect(current.attempts).toEqual([]);expect(current.evidence).toEqual(expect.arrayContaining(originalEvidence));expect(view.task.usage.actions).toBe(1);expect(f.host.list(view.task.rounds[1].sessionId,'attempt')).toEqual([]);
  expect(view.events.some(e=>e.type==='review.resolved'&&(e.data as any).itemId===gap.id&&(e.data as any).executed===false)).toBe(true);expect(view.task.status).toBe('completed');
  plugin.revise(t.id,{itemIds:[gap.id]},true);expect(plugin.view(t.id).task.plan.find(i=>i.id===gap.id)?.reviewResolvedBy).toBeUndefined();
 }finally{await plugin.close();await f.close();}
});

it.each(['ambiguous','missing-source','different-source-target','selected-authority'] as const)('does not guess a legacy gap target when %s',mode=>{
 const control={visible:true,localId:'one',name:'Details',label:'',role:'generic',stableKey:'id:one'};
 const gap={id:'gap',reason:'classification_unresolved',scope:{url:'http://fixture/',label:'',role:'generic'},dispatchScope:mode==='selected-authority',evidence:[{sessionId:'s',observationId:'a'},{sessionId:'s',observationId:'b'}]};const task={plan:[gap]} as any,before=structuredClone(task);
 const host={observation:(_sid:string,id:string)=>{if(mode==='missing-source'&&id==='b')throw new Error('Absent');return {url:'http://fixture/',regions:[],controls:mode==='ambiguous'?[control,{...control,localId:'two',stableKey:'id:two'}]:[{...control,stableKey:mode==='different-source-target'&&id==='b'?'id:two':'id:one'}]};}} as any;
 expect(remapStoredReviewScopes(task,host)).toEqual([]);expect(task).toEqual(before);
});

it.each(['current','revoked','interaction','ambiguous','missing-material','hidden-revoked','hidden-invalidated'] as const)('reconciles %s classification evidence without granting an action',mode=>{
 const control={visible:!mode.startsWith('hidden'),localId:'one',name:'Details',label:'',role:'generic',actionBasis:{}};
 const o={id:'now',sessionId:'s',url:'http://fixture/',regions:[],gaps:[],controls:mode==='ambiguous'?[control,{...control,localId:'two'}]:[control]} as any;
 const record={id:'r',classification:mode==='interaction'?'interaction':'container',status:mode.includes('revoked')?'revoked':mode==='hidden-invalidated'?'invalidated':'active'};
 const item={id:'gap',required:true,status:'succeeded',reason:'classification_unresolved',scope:{url:o.url,label:'Details'},reviewResolvedBy:{sessionId:'s',observationId:'before',classificationId:'old',classification:'container'}};
 const host={actions:()=>[],list:()=>[{...record,id:'old'}],controlClassificationMaterial:()=>({observationId:o.id,controls:mode==='missing-material'?[]:[{control,needsClassification:mode!=='current',classifications:[record]}]}),controlReviewMaterial:()=>({observationId:o.id,controls:[{control,needsReview:false}]})} as any;
 const changes=reviewGapChanges({plan:[item]} as any,o,host);
 if(mode==='current')expect(changes).toEqual([{itemId:'gap',proof:{sessionId:'s',observationId:'now',classificationId:'r',classification:'container'}}]);
 else if(mode==='hidden-invalidated')expect(changes).toEqual([]);
 else{expect(changes).toHaveLength(1);expect(changes[0].itemId).toBe('gap');expect(changes[0].proof).toBeUndefined();}
 expect(item.reviewResolvedBy.classificationId).toBe('old');
});

it('keeps named controls with empty explicit labels as distinct, selectable follow-up scopes',async()=>{
 const f=await explorerFixture(`${['Alpha','Beta'].map(name=>`<div role="button" tabindex="0" style="cursor:pointer" id="${name}" onclick="this.setAttribute('aria-disabled','true')">${name}</div>`).join('')}<button type="button" onclick="this.disabled=true">Ready</button>`),p=fakeProviders(f.url),original=p.jev.decide;
 let permit=false;
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{model:'mock',value:'interaction',confidence:1}:r.purpose==='control-risk'&&!permit&&['Alpha','Beta'].includes((r.state as any).material.control.name)?{model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.01]))}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:1}});plugin.start(t.id);await plugin.waitForIdle();const before=plugin.view(t.id),gaps=before.task.plan.filter(i=>i.reason==='operation_risk_unresolved');
  const risk=before.decisions.filter(d=>d.purpose==='control-risk'&&['Alpha','Beta'].includes((d.request.state as any).material.control.name));expect(risk.map(d=>(d.request.state as any).material.control.label)).toEqual(['','']);
  expect(gaps.map(i=>i.scope.label).sort()).toEqual(['Alpha','Beta']);expect(new Set(gaps.map(i=>i.scope.stableKey)).size).toBe(2);
  const selected=gaps.find(i=>i.scope.label==='Alpha')!;permit=true;plugin.revise(t.id,{itemIds:[selected.id]},true);plugin.extendBudget(t.id,{rounds:1,actions:2,durationMs:60000,modelRequests:100});plugin.start(t.id);await plugin.waitForIdle();const after=plugin.view(t.id),sid=after.task.rounds.at(-1)!.sessionId;
  expect(f.host.list<any>(sid,'attempt').map(a=>a.action.label)).toEqual(['Alpha']);
  expect(after.task.plan.find(i=>i.id===selected.id)?.status).toBe('succeeded');
  expect(after.task.plan.find(i=>i.id===gaps.find(i=>i.scope.label==='Beta')!.id)?.status).toBe('unresolved');
  expect(after.decisions.slice(before.decisions.length).filter(d=>d.purpose==='control-risk').map(d=>(d.request.state as any).material.control.name)).toEqual(['Alpha']);
 }finally{await plugin.close();await f.close();}
});

it.each(['uncertain','denied-interface','external-write'] as const)('drains distinct %s reviews before declaring no progress, refreshing only uncertainty',async(mode)=>{
 const f=await explorerFixture(`${Array.from({length:6},(_,i)=>`<div role="button" aria-label="Ambiguous" tabindex="0" style="cursor:pointer" id="ambiguous-${i}">Ambiguous</div>`).join('')}<button type="button" id="ready" onclick="this.disabled=true">Ready</button>`),p=fakeProviders(f.url),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{model:'mock',value:'interaction',confidence:1}:r.purpose==='control-risk'&&(r.state as any).material.control.label==='Ambiguous'?{model:'mock',value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,mode==='denied-interface'?.01:mode==='external-write'&&k.startsWith('external_')?.99:.5]))}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try{const t=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:1}});plugin.start(t.id);await plugin.waitForIdle();const view=plugin.view(t.id),sid=view.task.rounds[0].sessionId;
  const reviews=view.decisions.filter(d=>d.purpose==='control-risk'&&(d.request.state as any).material.control.label==='Ambiguous');
  expect(new Set(reviews.map(d=>(d.request.state as any).material.control.instanceId)).size,JSON.stringify(view.decisions.map(d=>({p:d.purpose,s:d.status,target:(d.request.state as any).material?.control?.label})))).toBe(6);
  expect(reviews).toHaveLength(mode==='uncertain'?12:6);
  expect(view.events.filter(e=>e.type==='decision.effect'&&(e.data as any).kind==='evidence-refresh')).toHaveLength(mode==='uncertain'?6:0);
  expect(f.host.list<any>(sid,'attempt').map(a=>a.action.label)).toEqual(['Ready']);
  expect(view.task.plan.some(i=>i.reason==='operation_risk_unresolved'&&i.status==='unresolved')).toBe(true);expect(view.task.status).not.toBe('completed');
  expect(new Set(view.task.plan.filter(i=>i.reason==='operation_risk_unresolved').map(i=>i.scope.stableKey)).size).toBe(6);
  expect(view.decisions.some(d=>d.actor==='llm')).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it('counts identity resolutions as progress so several pending identities do not end the round early',async()=>{
 const f=await explorerFixture(['A','B','C','D','E'].map(name=>`<button type="button" id="${name}" onclick="this.disabled=true">${name}</button>`).join('')),resolved=new Set<string>();
 const hypotheses=(sid:string)=>f.host.observation(sid).controls.filter(c=>c.tag==='button').map(c=>({id:`pending:${c.stableKey}`,localId:c.localId,status:resolved.has(`pending:${c.stableKey}`)?'resolved':'pending',candidateIds:[],provisionalIdentityId:c.identityId,revisions:[]}));
 const host=new Proxy(f.host,{get(target,key){
  if(key==='observation')return (...args:Parameters<typeof target.observation>)=>{const o=target.observation(...args);return {...o,controls:o.controls.map(c=>c.tag==='button'&&!resolved.has(`pending:${c.stableKey}`)?{...c,hypothesisId:`pending:${c.stableKey}`}:c)};};
  if(key==='list')return (sid:string,kind:string)=>kind==='hypothesis'?hypotheses(sid):target.list(sid,kind);
  if(key==='command')return async(sid:string,command:any)=>{if(command.type==='resolveIdentity'&&command.hypothesisId.startsWith('pending:')){resolved.add(command.hypothesisId);return;}return target.command(sid,command);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),fakeProviders(f.url));
 try{const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1}});plugin.start(task.id);await plugin.waitForIdle();const view=plugin.view(task.id);expect(resolved.size).toBe(5);expect(view.task.status).toBe('completed');expect(view.task.usage.actions).toBe(5);expect(view.decisions.filter(d=>d.actor==='llm')).toHaveLength(0);}
 finally{await plugin.close();await f.close();}
});

it.each(['grounded','invented-reference','uncertain','veto'] as const)('uses a bounded semantic fallback with %s evidence on a real popup control',async(mode)=>{
 const f=await explorerFixture(semanticPopupHtml),p=fakeProviders(f.url,{url:f.url,label:'Picker',kind:'click'}),original=p.jev.decide;
 p.jev.decide=async(r,s)=>{
  if(r.purpose==='control-classification')return {value:'interaction',confidence:1,model:'mock'};
  if(r.purpose==='control-risk')return {value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,mode==='veto'&&k.startsWith('external_')?.99:.5])),model:'mock'};
  return original(r,s);
 };
 p.llm.decide=async(r,s)=>r.purpose==='operation-clarification'?{model:'mock',value:mode==='invented-reference'?{...grounded,evidenceRefs:['invented']}:mode==='uncertain'?{...grounded,choice:'uncertain',interfaceOnly:null,externalWrite:null}:grounded}:original(r,s);
 const path=join(f.dir,'semantic.sqlite');let plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),p);
 try {const task=plugin.create({url:f.url,goal:'Open Picker',sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1}});plugin.start(task.id);await plugin.waitForIdle();const view=plugin.view(task.id);
  const calls=view.decisions.filter(d=>d.purpose==='operation-clarification');expect(calls).toHaveLength(mode==='veto'?0:1);
  expect(view.task.usage.actions,JSON.stringify({reason:view.task.reason,plan:view.task.plan})).toBe(mode==='grounded'?1:0);
  if(mode==='grounded'){
   expect(view.task.status).toBe('completed');expect(calls[0].status).toBe('applied');
   expect(view.decisions.find(d=>d.id===calls[0].triggeredBy)?.purpose).toBe('control-risk');
   expect(view.events.some(e=>e.decisionId===calls[0].id&&e.type==='decision.effect'&&(e.data as any).kind==='review')).toBe(true);
  } else if(mode!=='veto'){
   expect(calls[0].status).toBe('rejected');expect(view.task.plan.some(i=>i.reason==='operation_risk_unresolved')).toBe(true);
   // Simulate interruption after saving a result but before marking the review drained.
   const saved=plugin.store.task(task.id);saved.status='running';saved.rounds[0].status='running';saved.rounds[0].reviewed=[];plugin.store.save(saved);await plugin.close();
   plugin=new ExplorerPlugin(f.host,new ExplorerStore(path),p);expect(plugin.view(task.id).task.status).toBe('paused');
   plugin.start(task.id);await plugin.waitForIdle();const resumed=plugin.view(task.id);expect(resumed.task.rounds).toHaveLength(1);expect(resumed.decisions.filter(d=>d.purpose==='operation-clarification')).toHaveLength(1);expect(resumed.task.usage.actions).toBe(0);expect(resumed.task.usage.modelRequests).toBeGreaterThan(view.task.usage.modelRequests);
  }
 } finally {await plugin.close();await f.close();}
});

it('pauses an ambiguous purpose for missing LLM configuration and resumes with fresh evidence',async()=>{
 const f=await explorerFixture(semanticPopupHtml),p=fakeProviders(f.url,{url:f.url,label:'Picker',kind:'click'}),original=p.jev.decide;
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{value:'interaction',confidence:1,model:'mock'}:r.kind==='checklist'?{value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.5])),model:'mock'}:original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),{jev:p.jev});
 try {const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1,actions:1}});plugin.start(task.id);await plugin.waitForIdle();const before=plugin.view(task.id);
  expect(before.task.status).toBe('configuration_required');expect(before.task.usage.actions).toBe(0);
  plugin.router.providers.llm={name:'mock',model:'mock',decide:async()=>({model:'mock',value:grounded})};
  plugin.start(task.id);await plugin.waitForIdle();const after=plugin.view(task.id);expect(after.task.usage.actions).toBe(1);expect(after.task.usage.modelRequests).toBeGreaterThan(before.task.usage.modelRequests);
 }finally{await plugin.close();await f.close();}
});

it('cancels a pending semantic clarification on takeover and never applies its late answer',async()=>{
 const f=await explorerFixture(semanticPopupHtml),p=fakeProviders(f.url,{url:f.url,label:'Picker',kind:'click'}),original=p.jev.decide;
 let began!:()=>void,finish!:(value:any)=>void;const waiting=new Promise<void>(resolve=>began=resolve);
 p.jev.decide=async(r,s)=>r.purpose==='control-classification'?{value:'interaction',confidence:1,model:'mock'}:r.kind==='checklist'?{value:Object.fromEntries(Object.keys(r.checks!).map(k=>[k,.5])),model:'mock'}:original(r,s);
 p.llm.decide=async(r,s)=>r.purpose==='operation-clarification'?new Promise(resolve=>{finish=resolve;began();}):original(r,s);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
 try {const task=plugin.create({url:f.url,goal:'Open Picker',sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1}});plugin.start(task.id);await waiting;await plugin.pause(task.id);finish({model:'mock',value:grounded});await plugin.waitForIdle();const view=plugin.view(task.id);
  expect(view.task.status).toBe('paused');expect(view.task.usage.actions).toBe(0);const decision=view.decisions.find(d=>d.purpose==='operation-clarification')!;expect(decision.status).toBe('cancelled');expect(view.events.some(e=>e.decisionId===decision.id&&e.type==='decision.effect')).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it.each(['veto','missing-reference','missing-effect','wrong-choice'] as const)('rejects %s in structured semantic answers',mode=>{
 const request={options:{click:'Allowed',uncertain:'Unknown'},evidence:{current:{},actions:{},'effect:click':{}},requiredEvidence:{click:['current','actions','effect:click']},operation:true} as unknown as SemanticReview;
 const answer=mode==='veto'?{...grounded,externalWrite:true}:mode==='missing-reference'?{...grounded,evidenceRefs:['current']}:mode==='missing-effect'?{...grounded,interfaceOnly:null}:{...grounded,choice:'delete'};
 expect(semanticRejection(request,answer)).toBeDefined();
});

it.each(['ambiguous','independent','incompatible','uncertain'] as const)('handles %s identities without using historical success as current coverage',async(mode)=>{
 const control={localId:'current',instanceId:'current',hypothesisId:'h',tag:'button',role:'button',label:'Same',stableKey:'stable',region:'main'};
 const history={...control,localId:'old',instanceId:'old',stableKey:mode==='incompatible'?'other':'stable'};
 const hypothesis={id:'h',status:'pending',provisionalIdentityId:'fresh',candidateIds:['prior'],revisions:[]};
 const o={id:'now',sessionId:'s',instanceScope:'doc',url:'http://fixture/',controls:[control],regions:[]};
 const chosen={id:'jev',actor:'jev',answer:{value:mode==='independent'?'independent':'uncertain'},resolution:{source:mode==='independent'?'jev':'program',value:'independent'}} as Decision;
 const apply=vi.fn(async(_d:Decision,_cmd:unknown)=>{}),clarify=vi.fn(async(request:SemanticReview)=>{
  expect(request.requiredEvidence.prior).toEqual(['current','historical:prior']);
  return {value:mode==='uncertain'?'uncertain':'prior',decision:chosen};
 });
 const c={observation:o,task:{plan:[{required:true,dispatchScope:true,scope:{url:o.url},prerequisites:[]}],rounds:[{reviewed:[]}]},host:{actions:()=>[],regionReviewMaterial:()=>({enabled:false}),controlClassificationMaterial:()=>({controls:[]}),list:(_sid:string,kind:string)=>kind==='hypothesis'?[hypothesis]:[{id:'prior',occurrences:[{observationId:'before',localId:'old'}]}],observation:()=>({controls:[history]})},choose:async()=>({value:'independent',decision:chosen}),refresh:async()=>false,clarify,apply,gap:vi.fn()} as unknown as ReviewContext;
 expect(await reviewNext(c)).toBe(true);expect(clarify).toHaveBeenCalledTimes(['ambiguous','uncertain'].includes(mode)?1:0);
 expect(apply.mock.calls[0][1]).toMatchObject({type:'resolveIdentity',identityId:mode==='ambiguous'?'prior':'fresh',guard:{observationId:'now',revision:0}});
 expect(c.task.plan[0].status).not.toBe('succeeded');
});
