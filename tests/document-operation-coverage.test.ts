import {createServer} from 'node:http';
import {beforeAll,expect,it,vi} from 'vitest';
import {BrowserEngine,PlaywrightAdapter,controlReviewConditions,controlReviewKey,type ActionAttempt,type ActionCandidate,type BoundaryExitResult,type ControlReviewRecord,type FrontierItem,type Observation,type Session} from '@interaction/browser';
import {MemoryStore} from '@interaction/storage-memory';
import {ExplorerPlugin,ExplorerStore,type PlanItem,type Task} from '@interaction/explorer-plugin';
import {browserBranchConditions} from '../packages/adapter-playwright/src/branch-conditions.js';
import {operationSourceCompletion} from '../packages/explorer-plugin/src/operation-source-completion.js';
import {completedOperations} from '../packages/explorer-plugin/src/completion-evidence.js';
import {keyFor,scopeFor} from '../packages/explorer-plugin/src/policy.js';
import {pageOf} from './helpers.js';

type Row={id:string;sessionId?:string};
type Seed={sid:string;targetId:string;actionId:string;attemptId:string;reviewId:string;rows:Record<string,Row[]>};
let seed:Seed;
const kinds=['session','observation','action','attempt','frontier','identity','hypothesis','control-review','scope','continuation','boundary-exit-result','exploration-group'];
// One real, owned local receipt. Unique native record links make the retained
// selector instance-only without creating an unresolved identity hypothesis.
beforeAll(async()=>{
 const html=`<!doctype html><main><ul><li data-record="target"><input id="flag" type="checkbox" aria-label="Flag"><a href="/target-record">Target record</a></li><li data-record="mode"><i id="mode" role="button" aria-label="Hidden mode" aria-expanded="false" hidden></i><a href="/mode-record">Mode record</a></li></ul><div data-owner="input"><input id="nonlocal" aria-label="Nonlocal input" value="A"></div></main>`;
 const site=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
 await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));
 const host=new BrowserEngine({persistence:new MemoryStore()});
 try{
  const s=await host.createSession({url:`http://127.0.0.1:${(site.address() as {port:number}).port}/`,headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100,evidence:{enabled:false}});
  const initial=host.observation(s.id),flag=initial.controls.find(c=>c.selector==='#flag')!;
  const [review]=await host.reviewControls(s.id,{observationId:initial.id,source:'local-fixture-review',reviews:[{localId:flag.localId,kind:'check',samples:[true],risk:'interface',replayable:false,reason:'Select this local fixture checkbox',evidence:['Native checkbox in an owned fixture']}]});
  const target=host.observation(s.id),targetAction=host.actions(s.id).find(a=>a.localId===flag.localId&&a.kind==='check'&&a.value===true)!;
  await host.observe(s.id);
  const source=host.actions(s.id).find(a=>a.localId===flag.localId&&a.kind==='check'&&a.value===true)!;
  const attempt=await host.execute(s.id,source.id,'document-coverage-local-seed');
  expect(attempt.status).toBe('succeeded');expect(await pageOf(host).locator('#flag').isChecked()).toBe(true);
  const before=host.observation(s.id,attempt.beforeId),mode=target.controls.find(c=>c.selector==='#mode')!;
  expect(target.id).not.toBe(before.id);expect(mode.identityScope).toBe('instance');expect(mode.hypothesisId).toBeUndefined();expect(mode.visible).toBe(false);
  expect(target.controls.find(c=>c.localId===flag.localId)?.identityScope).toBe('instance');
  expect(host.list(s.id,'hypothesis')).toEqual([]);
  for(const o of [target,before]){
   expect(o.ownerDependencies?.inventoryComplete).toBe(true);
   for(const localId of [flag.localId,...o.ownerDependencies!.selectorIds])expect(o.ownerDependencies!.roots.find(r=>r.localId===localId)?.complete).toBe(true);
   expect(browserBranchConditions(targetAction,o)).toBeUndefined();
  }
  seed={sid:s.id,targetId:target.id,actionId:targetAction.id,attemptId:attempt.id,reviewId:review.id,rows:Object.fromEntries(kinds.map(kind=>[kind,host.store.list<Row>(kind,s.id)]))};
 }finally{await host.close();await new Promise<void>(resolve=>site.close(()=>resolve()));}
});

type Draft={rows:Seed['rows'];session:Session;target:Observation;action:ActionCandidate;attempt:ActionAttempt;before:Observation;after:Observation;review:ControlReviewRecord};
function fixture(change?:(d:Draft)=>void){
 const rows=structuredClone(seed.rows),get=<T extends Row>(kind:string,id:string)=>rows[kind].find(row=>row.id===id)! as T;
 const attempt=get<ActionAttempt>('attempt',seed.attemptId),d:Draft={rows,session:get<Session>('session',seed.sid),target:get<Observation>('observation',seed.targetId),action:get<ActionCandidate>('action',seed.actionId),attempt,before:get<Observation>('observation',attempt.beforeId),after:get<Observation>('observation',attempt.afterId!),review:get<ControlReviewRecord>('control-review',seed.reviewId)};
 change?.(d);const store=new MemoryStore();for(const [kind,records] of Object.entries(rows))for(const row of records)store.put(kind,row);
 const host=new BrowserEngine({persistence:store}),request={observationId:d.target.id,actionId:d.action.id,source:{sessionId:seed.sid,attemptId:d.attempt.id}};
 return {...d,store,host,request,query:()=>host.operationCorrespondence(seed.sid,request),close:()=>host.close()};
}
function pending(d:Draft,id:string,patch:Partial<FrontierItem>={}):FrontierItem {
 return {id,sessionId:seed.sid,key:id,stateId:d.target.stateId,contextKey:'fixture',action:structuredClone(d.action),status:'pending',attempts:[],depth:0,...patch};
}
function ownerNode(o:Observation,selector:string){const c=o.controls.find(c=>c.selector===selector)!,graph=o.ownerDependencies!,root=graph.roots.find(r=>r.localId===c.localId)!;return graph.nodes.find(n=>n.id===root.ownerId)!;}

it('seed checkpoint: proves a real success against the earlier same-document instance-only source without replay or writes',async()=>{
 const f=fixture(),create=vi.spyOn(PlaywrightAdapter.prototype,'createDriver').mockImplementation(()=>{throw Error('Read query must not attach a browser');});
 try{
  const put=vi.spyOn(f.host.store,'put'),event=vi.spyOn(f.host.store,'event'),before=structuredClone({observations:f.host.list(seed.sid,'observation'),attempts:f.host.list(seed.sid,'attempt'),identities:f.host.list(seed.sid,'identity')});
  expect(f.query()).toMatchObject({equivalent:true,reason:'equivalent_retained_operation_sample',policy:'browser-document-coverage-v1',identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  expect(f.host.operationCorrespondences(seed.sid,{observationId:f.target.id,requests:[{actionId:f.action.id,source:f.request.source}]}).results[0]).toEqual(f.query());
  expect(put).not.toHaveBeenCalled();expect(event).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
  expect({observations:f.host.list(seed.sid,'observation'),attempts:f.host.list(seed.sid,'attempt'),identities:f.host.list(seed.sid,'identity')}).toEqual(before);
  const session=f.host.session(seed.sid);session.currentObservationId=f.target.id;f.store.put('session',session);
  expect(f.host.repetitionAssessment(seed.sid,f.request).repeatable).toBe(false);
  expect(f.host.explorationTargetCorrespondences(seed.sid,{observationId:f.target.id,requests:[{actionId:f.action.id,source:{sessionId:seed.sid,observationId:f.before.id,actionId:f.attempt.action.id}}]}).results[0].equivalent).toBe(false);
  expect(f.host.session(seed.sid).actionCount).toBe(1);
 }finally{create.mockRestore();await f.close();}
});

it('shares receipt coverage with frontier while retaining attempts, unknown work, and same-ID input variants',async()=>{
 const f=fixture(d=>{d.rows.frontier=[pending(d,'eligible'),pending(d,'already-attempted',{attempts:[d.attempt.id]}),pending(d,'unknown',{status:'unknown'}),pending(d,'different-input',{action:{...structuredClone(d.action),value:false}})];});
 try{
  const before=structuredClone(f.host.list(seed.sid,'frontier')),frontier=f.host.getFrontier(seed.sid);
  expect(frontier.find(item=>item.id==='eligible')?.coverage.equivalentTo).toMatchObject({attemptId:f.attempt.id,policy:'browser-document-coverage-v1'});
  for(const id of ['already-attempted','unknown','different-input'])expect(frontier.find(item=>item.id===id)?.coverage.equivalentTo).toBeUndefined();
  expect(f.host.list(seed.sid,'frontier')).toEqual(before);
 }finally{await f.close();}
});

it('consumes the public proof in the actual plugin outcome gate and removes one repeated untested obligation',async()=>{
 const f=fixture(),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'));
 try{
  const task=plugin.create({url:f.target.url,coverageMode:'all'}),item:PlanItem={id:'retained-flag',title:'Flag',scope:scopeFor(f.action,f.target),prerequisites:[],completion:'Execute all retained sources',status:'unresolved',required:true,dispatchScope:false,reason:'operation_not_executed',operationConditionKey:keyFor(f.action,f.target),operationConditionPolicy:'browser-operation-key-v2',evidence:[{sessionId:seed.sid,observationId:f.target.id},{sessionId:seed.sid,observationId:f.before.id}],attempts:[]};
  task.plan=[item];task.rounds=[{id:'round',number:1,sessionId:seed.sid,startedAt:f.attempt.startedAt,status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}];
  expect(completedOperations(f.host,task,f.target,[f.action]).size).toBe(0);
  const correspondence=vi.spyOn(f.host,'operationCorrespondences');
  (plugin as unknown as {recordOutcome(task:Task,attempt:ActionAttempt,ids:string[]):void}).recordOutcome(task,f.attempt,[item.id]);
  expect(item.status).toBe('succeeded');expect(item.resolvedBy?.attemptId).toBe(f.attempt.id);expect(operationSourceCompletion(f.host,f.attempt)(item)).toBe(true);
  expect(completedOperations(f.host,task,f.target,[f.action]).has(f.action)).toBe(true);
  expect(correspondence.mock.results.some(result=>result.type==='return'&&result.value.results.some((proof:{policy?:string})=>proof.policy==='browser-document-coverage-v1'))).toBe(true);
  expect(item.evidence).toEqual(expect.arrayContaining([{sessionId:seed.sid,observationId:f.target.id},{sessionId:seed.sid,observationId:f.before.id}]));expect(f.host.list(seed.sid,'attempt')).toHaveLength(1);
 }finally{await plugin.close();await f.close();}
});

it.each(['parent-record','sibling-href','nonlocal-input','hidden-mode','replacement-target','new-document','new-browser','missing-graph','pending-hypothesis'] as const)('declines changed or absent retained conditions: %s',async change=>{
 const f=fixture(d=>{
  const graph=d.target.ownerDependencies!,mode=d.target.controls.find(c=>c.selector==='#mode')!;
  if(change==='parent-record')ownerNode(d.target,'#mode').attributes['data-record']='other-record';
  if(change==='sibling-href'){const link=graph.nodes.find(n=>n.attributes.href==='/mode-record')!;link.attributes.href='/other-record';link.resolved!.href=new URL('/other-record',d.target.url).href;}
  if(change==='nonlocal-input'){d.target.controls.find(c=>c.selector==='#nonlocal')!.value='B';graph.nodes.find(n=>n.attributes.id==='nonlocal')!.live!.value='B';}
  if(change==='hidden-mode'){mode.expanded=true;graph.nodes.find(n=>n.id===mode.instanceId)!.attributes['aria-expanded']='true';}
  if(change==='replacement-target'){const c=d.target.controls.find(c=>c.localId===d.action.localId)!;c.instanceId='replacement-instance';}
  if(change==='new-document'){d.target.documentId='new-document';d.target.instanceScope='new-browser:new-document';graph.documentId='new-document';}
  if(change==='new-browser')d.target.navigation!.browserSessionId='new-browser';if(change==='missing-graph')delete d.target.ownerDependencies;
  if(change==='pending-hypothesis')d.rows.hypothesis.push({id:'pending',sessionId:seed.sid,observationId:d.target.id,localId:mode.localId,provisionalIdentityId:mode.identityId!,candidateIds:[],evidence:[],conflicts:['unresolved'],status:'pending',revisions:[]} as Row);
 });try{expect(f.query().equivalent).toBe(false);}finally{await f.close();}
});

it('does not reuse a review for owner B merely because its unchanged target conditions were approved under owner A',async()=>{
 const f=fixture(d=>{
  // The actual source and queried target agree on B. Only the original review
  // source retains A, outside its legacy target-only conditions/attributes.
  for(const o of [d.target,d.before])ownerNode(o,'#flag').attributes['data-record']='B';
 });try{
  expect(f.target.controls.find(c=>c.selector==='#flag')?.reviewAttributes).toEqual(f.before.controls.find(c=>c.selector==='#flag')?.reviewAttributes);
  for(const o of [f.target,f.before])expect(controlReviewKey(controlReviewConditions(o.controls.find(c=>c.selector==='#flag')!,o,'check')!)).toBe(f.review.conditionKey);
  expect(ownerNode(f.host.observation(seed.sid,f.review.observationId),'#flag').attributes['data-record']).not.toBe('B');
  expect(ownerNode(f.target,'#flag').attributes['data-record']).toBe('B');expect(ownerNode(f.before,'#flag').attributes['data-record']).toBe('B');
  expect(f.query().equivalent).toBe(false);
 }finally{await f.close();}
});

it.each(['unknown','executing','dirty','boundary-debt','review-revoked'] as const)('rechecks new %s on the next public query instead of retaining authority',async change=>{
 const f=fixture();try{
  expect(f.query().equivalent).toBe(true);
  if(change==='unknown'||change==='executing')f.store.put('attempt',{...structuredClone(f.attempt),id:'later-unsettled',status:change,afterId:undefined});
  if(change==='dirty'){const s=f.host.session(seed.sid);s.dirty=true;f.store.put('session',s);}
  if(change==='boundary-debt'){const result:BoundaryExitResult={id:'boundary-debt',sessionId:seed.sid,reviewId:'exit-review',attemptId:f.attempt.id,beforeId:f.before.id,afterId:f.after.id,inputPhase:'click',closedAfterMove:false,dispatched:'succeeded',closed:false,parentReady:false,preserved:false,status:'unverified',evidence:['Retained unverified boundary result']};f.store.put('boundary-exit-result',result);}
  if(change==='review-revoked'){f.review.status='revoked';f.store.put('control-review',f.review);}
  expect(f.query().equivalent).toBe(false);
 }finally{await f.close();}
});

it('re-reads a changed same-ID target value on the next query',async()=>{
 const f=fixture();try{expect(f.query().equivalent).toBe(true);f.store.put('action',{...f.action,value:false});expect(f.query().equivalent).toBe(false);}finally{await f.close();}
});

it('does not require the successful after observation to retain the target or its dependency graph',async()=>{
 const f=fixture(d=>{d.after.controls=d.after.controls.filter(c=>c.localId!==d.action.localId);delete d.after.ownerDependencies;});
 try{expect(f.query().equivalent).toBe(true);}finally{await f.close();}
});

it.each(['missing','incomplete','new-document'] as const)('rejects a %s after receipt boundary',async change=>{
 const f=fixture(d=>{
  if(change==='missing')d.rows.observation=d.rows.observation.filter(o=>o.id!==d.after.id);
  if(change==='incomplete')d.after.gaps.push({code:'RESULT_INCOMPLETE',critical:true,message:'Post-action result unavailable'});
  if(change==='new-document')d.after.documentId='different-document';
 });try{expect(f.query().equivalent).toBe(false);}finally{await f.close();}
});

it('retains an unknown receipt over a persistence reopen with no browser attachment',async()=>{
 const f=fixture(d=>{d.attempt.status='executing';delete d.attempt.afterId;}),create=vi.spyOn(PlaywrightAdapter.prototype,'createDriver').mockImplementation(()=>{throw Error('Unknown read must not attach');});
 try{expect(f.host.list<ActionAttempt>(seed.sid,'attempt')[0].status).toBe('unknown');expect(f.query().equivalent).toBe(false);expect(create).not.toHaveBeenCalled();expect(f.host.list(seed.sid,'attempt')).toHaveLength(1);}finally{create.mockRestore();await f.close();}
});
