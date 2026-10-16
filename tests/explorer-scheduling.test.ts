import { expect, it, vi } from 'vitest';
import type { ActionCandidate } from '@interaction/browser';
import { ExplorerPlugin, ExplorerStore, type Decision } from '@interaction/explorer-plugin';
import { reviewNext, unresolvedPurposeKey, type ReviewContext } from '../packages/explorer-plugin/src/reviews.js';
import { reviewGapChanges } from '../packages/explorer-plugin/src/review-ledger.js';
import { explorerFixture, fakeProviders } from './explorer-plugin-helpers.js';

function context() {
  const unknown={localId:'unknown',instanceId:'unknown-instance',name:'Unknown',tag:'div',role:'button',region:'main',visible:true,rect:{x:0,y:0,width:10,height:10},classificationBinding:{truncated:false}};
  const ready={...unknown,localId:'ready',instanceId:'ready-instance',name:'Ready',tag:'button'};
  const o={id:'o',sessionId:'s',instanceScope:'document',url:'https://example.test/',controls:[unknown,ready],regions:[],boundaries:[],overlays:[]};
  const action={id:'ready-action',sessionId:'s',observationId:'o',localId:'ready',label:'Ready',kind:'click',risk:'interface',basis:{status:'supported',evidence:[]}};
  const classification={control:unknown,needsClassification:true,classifications:[],actions:[]};
  const interpretations={classifications:{controls:[classification]},operations:{controls:[]}};
  const decision={id:'decision',actor:'jev'} as Decision;
  const host={actions:vi.fn(()=>[action]),regionReviewMaterial:vi.fn(()=>({enabled:false})),explorationReviewMaterial:vi.fn(()=>({groups:[]})),
    controlClassificationMaterial:vi.fn(()=>interpretations.classifications),controlReviewMaterial:vi.fn(()=>interpretations.operations),
    controlInterpretationSnapshot:vi.fn(()=>interpretations),list:vi.fn(()=>[]),discoveryScanMaterial:vi.fn(()=>({}))};
  const task={revision:1,plan:[{id:'root',required:true,dispatchScope:true,status:'pending',scope:{url:o.url},prerequisites:[],reason:'user_goal'}],rounds:[{reviewed:[],entryPath:[{label:'Open',kind:'click'}]}]};
  const c={host,task,observation:o,choose:vi.fn(async()=>({value:'interaction',decision})),apply:vi.fn(async()=>{}),retain:vi.fn(async()=>{}),gap:vi.fn(),
    hasPendingAction:vi.fn((filter?:(a:ActionCandidate)=>boolean)=>!filter||filter(action as unknown as ActionCandidate)),refresh:vi.fn(async()=>false)} as unknown as ReviewContext;
  return {c,host,o,task,action,unknown,interpretations};
}

it('retains unresolved obligations and their entry path before yielding to an independently executable action',async()=>{
  const {c,host,o,unknown}=context();
  expect(await reviewNext(c)).toBe(false);
  expect(c.hasPendingAction).toHaveBeenCalledWith(expect.any(Function),true);
  expect(c.gap).toHaveBeenCalledWith('classification_unresolved',expect.objectContaining({url:o.url,label:'Unknown'}),true,c.task.rounds[0].entryPath);
  expect(host.controlInterpretationSnapshot).toHaveBeenCalledWith('s','o');
  expect(c.choose).not.toHaveBeenCalled();expect(c.apply).not.toHaveBeenCalled();expect(host.regionReviewMaterial).not.toHaveBeenCalled();
  expect(c.task.rounds[0].reviewed).toEqual([]);
  c.hasPendingAction=()=>false;
  expect(await reviewNext(c)).toBe(true);
  expect(c.choose).toHaveBeenCalledWith('control-classification',expect.any(String),expect.objectContaining({control:unknown}),expect.any(Object),expect.any(Object));
  expect(c.apply).toHaveBeenCalledWith(expect.any(Array),expect.objectContaining({type:'classifyControls'}));
});

it.each(['exit','dismiss','history','link'] as const)('does not skip unresolved controls for a ready %s',async(kind)=>{
  const {c,host,o,action}=context();
  if(kind==='exit')Object.assign(action,{boundary:{key:'modal',intent:'exit'}});
  if(kind==='dismiss'||kind==='history')action.kind=kind;
  if(kind==='link'){
    action.basis.evidence.push({source:'html',rule:'hyperlink/v1',facts:{href:'https://example.test/other'}} as never);
    Object.assign(o.controls[1],{tag:'a',reviewBinding:{attributes:{}}});
  }
  expect(await reviewNext(c)).toBe(true);
  expect(c.choose).toHaveBeenCalledWith('control-classification',expect.any(String),expect.any(Object),expect.any(Object),expect.any(Object));
  expect(host.controlInterpretationSnapshot).not.toHaveBeenCalled();
});

it('preserves active boundary priority even if the pending callback offers background work',async()=>{
  const {c,o,action}=context();
  Object.assign(o,{boundaries:[{key:'modal'}],overlays:[{key:'modal',controlIds:['unknown']} ]});
  expect(action.localId).toBe('ready');
  expect(await reviewNext(c)).toBe(true);
  expect(c.hasPendingAction).not.toHaveBeenCalled();
  expect(c.choose).toHaveBeenCalled();
});

it('retains every observed group member before unrelated model classification, without granting execution',async()=>{
  const {c,host}=context();c.hasPendingAction=()=>false;
  host.explorationReviewMaterial.mockReturnValue({groups:[{id:'g',revision:2,label:'Controls',status:'pending',decisions:[],members:[{key:'member',actionId:'ready-action'},{key:'historical',actionId:'old'}]}]} as never);
  expect(await reviewNext(c)).toBe(true);
  expect(c.retain).toHaveBeenCalledWith([{id:'g',revision:2,label:'Controls',memberKeys:['member'],actionIds:['ready-action'],historicalMemberCount:1}]);
  expect(c.choose).not.toHaveBeenCalled();expect(c.apply).not.toHaveBeenCalled();
  expect(c.task.rounds[0].reviewed).toEqual(['group:g:2']);
});

it('does not replace representative sampling with an early all-members decision',async()=>{
  const {c,host}=context();c.hasPendingAction=()=>false;c.task.coverageMode='representative';
  host.explorationReviewMaterial.mockReturnValue({groups:[{id:'g',revision:2,label:'Controls',status:'pending',decisions:[],members:[{key:'member',actionId:'ready-action'}]}]} as never);
  expect(await reviewNext(c)).toBe(true);
  expect(c.retain).not.toHaveBeenCalled();
  expect(c.choose).toHaveBeenCalledWith('control-classification',expect.any(String),expect.any(Object),expect.any(Object),expect.any(Object));
});

it('does not persist out-of-scope obligations or repeatedly write existing unresolved evidence',async()=>{
  const {c,task,o,unknown}=context();
  task.plan.push({id:'old',required:true,dispatchScope:false,status:'unresolved',scope:{url:o.url,label:'Unknown',role:'button'},prerequisites:[],reason:'classification_unresolved'} as never);
  expect(await reviewNext(c)).toBe(false);expect(c.gap).not.toHaveBeenCalled();
  task.plan.splice(1);Object.assign(task.plan[0].scope,{label:'Ready'});
  expect(await reviewNext(c)).toBe(false);expect(c.gap).not.toHaveBeenCalled();
  expect(unknown.name).toBe('Unknown');
});

it('propagates stale availability before retaining or applying any review',async()=>{
  const {c}=context();c.hasPendingAction=()=>{throw Object.assign(new Error('stale'),{code:'STALE_OBSERVATION'});};
  await expect(reviewNext(c)).rejects.toMatchObject({code:'STALE_OBSERVATION'});
  expect(c.gap).not.toHaveBeenCalled();expect(c.choose).not.toHaveBeenCalled();expect(c.apply).not.toHaveBeenCalled();
});

it('settles a deferred identity review only through a unique host noninteractive proof, without identity or execution grants',()=>{
  const {c,host,o,unknown}=context();
  Object.assign(o,{gaps:[]});
  c.task.plan.push({id:'identity-gap',required:true,dispatchScope:false,status:'unresolved',reason:'identity_unresolved',scope:{url:o.url,label:'Unknown',role:'button'}} as never);
  const proof={localId:unknown.localId,sessionId:'s',observationId:'o',classificationId:'display-review',classification:'display'};
  host.controlInterpretationSnapshot.mockReturnValue({actions:[],nonInteractive:[proof],retainedClassifications:[]} as never);
  expect(reviewGapChanges(c.task,c.observation,c.host)).toEqual([{itemId:'identity-gap',proof:{sessionId:'s',observationId:'o',classificationId:'display-review',classification:'display'}}]);
  expect(c.task.plan.at(-1)?.status).toBe('unresolved');expect(c.apply).not.toHaveBeenCalled();
  o.controls.push({...unknown,localId:'other-occurrence',instanceId:'other-instance'});
  expect(reviewGapChanges(c.task,c.observation,c.host)).toEqual([]);
});

it('executes ready work before model review and retains a newly hidden unknown control as unfinished',async()=>{
  const f=await explorerFixture('<style>details:not([open]) #unknown{display:none}</style><details open><summary>Ready</summary><div id="unknown" tabindex="0">Unknown</div></details>');
  const p=fakeProviders(f.url),sequence:string[]=[],original=p.jev.decide;
  p.jev.decide=async(r,s)=>{sequence.push(r.purpose);return original(r,s);};
  const host=new Proxy(f.host,{get(target,key){if(key==='execute')return async(...args:Parameters<typeof target.execute>)=>{const result=await target.execute(...args);sequence.push(`execute:${result.action.label}`);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),p);
  try {
    const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:1}});plugin.start(task.id);await plugin.waitForIdle();
    const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
    expect(attempts.map(a=>[a.action.label,a.status])).toEqual([['Ready','succeeded']]);
    const executed=sequence.indexOf('execute:Ready'),classified=sequence.indexOf('control-classification');
    expect(executed).toBeGreaterThan(-1);expect(classified===-1||executed<classified).toBe(true);
    expect(f.host.observation(sid).controls.find(c=>c.name==='Unknown')?.visible).not.toBe(true);
    const gaps=view.task.plan.filter(i=>i.required&&i.scope.label==='Unknown'&&i.status!=='succeeded');
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.some(i=>i.evidence.some(e=>e.observationId===attempts[0].beforeId))).toBe(true);
    expect(gaps.every(i=>!i.resolvedBy)).toBe(true);expect(view.task.status).not.toBe('completed');
  } finally {await plugin.close();await f.close();}
});

it('finishes later noninteractive review without converting the deferred obligation into an executed action',async()=>{
  const f=await explorerFixture('<details><summary>Ready</summary><p>Details content</p></details><div id="unreviewed" tabindex="0">Unknown</div>');
  const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
  try {
    const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:4}});plugin.start(task.id);await plugin.waitForIdle();
    const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
    expect(attempts.map(a=>a.action.label)).toEqual(['Ready']);
    const deferred=view.task.plan.filter(i=>i.scope.label==='Unknown'&&['classification_unresolved','operation_basis_unconfirmed'].includes(i.reason));
    expect(deferred.length,JSON.stringify(view.task.plan.map(i=>({scope:i.scope,reason:i.reason,status:i.status,review:i.reviewResolvedBy})))).toBeGreaterThan(0);
    expect(deferred.every(i=>i.status==='succeeded'&&i.reviewResolvedBy?.classification==='display'&&!i.resolvedBy?.attemptId)).toBe(true);
    expect(view.task.usage.actions).toBe(1);
  } finally {await plugin.close();await f.close();}
});

function purposeMaterial() {
  const o={id:'o',instanceScope:'doc',url:'https://example.test/',context:{tab:{status:'known',value:'main'}},boundaries:[]} as any;
  const item={control:{localId:'control',instanceId:'same-instance',identityId:'same-identity',name:'Unknown',role:'button',region:'main',
    visible:true,enabled:true,editable:false,readOnly:false,rect:{x:12,y:900,width:100,height:30},
    actionable:{visible:true,enabled:true,editable:false,hitTarget:null,unknown:['event-handler-completeness','business-preconditions','off-viewport-hit-target'],outsideScrollableArea:false},
    formOwner:{instanceId:'form-a'},reviewBinding:{parentInstanceId:'parent-a',attributes:{role:'button'}},
    actionBasis:{click:{status:'unconfirmed',evidence:[]}},interactionHints:[{source:'dom-structure',rule:'observed-popup',facts:{owner:'panel-a'}}],
    classificationBinding:{nodes:[{instanceId:'node-a',parentInstanceId:'parent-a',tag:'span',attributes:{}}],text:'Unknown',truncated:false}},
    reviews:[],actions:[{id:'action-a',observationId:'o',stateId:'state-a',kind:'click',risk:'unknown',basis:{status:'unconfirmed',evidence:[]}}]} as any;
  return {o,item};
}

it('reuses only an unresolved-purpose key across viewport translation and hit-test sampling changes',()=>{
  const {o,item}=purposeMaterial(),before=structuredClone(item),key=unresolvedPurposeKey(o,item,1),scrolled=structuredClone(item);
  scrolled.control.rect.x=30;scrolled.control.rect.y=300;
  scrolled.control.actionable.hitTarget=true;scrolled.control.actionable.clickPoint={x:50,y:15};
  scrolled.control.actionable.unknown=['event-handler-completeness','business-preconditions'];
  scrolled.actions[0].id='action-b';scrolled.actions[0].observationId='next';scrolled.actions[0].stateId='state-b';
  expect(unresolvedPurposeKey({...o,id:'next'} as any,scrolled,1)).toBe(key);
  expect(item).toEqual(before);
  expect(scrolled.control.actionable.hitTarget).toBe(true);expect(scrolled.actions[0].basis.status).toBe('unconfirmed');
});

it.each([
  ['enabled',(c:any)=>{c.enabled=false;}],['actionable enabled',(c:any)=>{c.actionable.enabled=false;}],
  ['readOnly',(c:any)=>{c.readOnly=true;}],['editable',(c:any)=>{c.actionable.editable=true;}],
  ['visibility',(c:any)=>{c.actionable.visible=false;}],['scroll reachability',(c:any)=>{c.actionable.outsideScrollableArea=true;}],
  ['obstruction owner',(c:any)=>{c.actionable.occludedBy='#other-dialog';}],['nongeometric uncertainty',(c:any)=>{c.actionable.unknown.push('new-business-state');}],
  ['identity',(c:any)=>{c.identityId='other-identity';}],['instance',(c:any)=>{c.instanceId='other-instance';}],
  ['owner',(c:any)=>{c.formOwner.instanceId='form-b';}],['parent',(c:any)=>{c.reviewBinding.parentInstanceId='parent-b';}],
  ['binding',(c:any)=>{c.reviewBinding.attributes.onclick='newEffect()';}],['basis',(c:any)=>{c.actionBasis.click.status='supported';}],
  ['hints',(c:any)=>{c.interactionHints[0].facts.owner='panel-b';}],['structure',(c:any)=>{c.classificationBinding.nodes[0].tag='button';}],
  ['purpose text',(c:any)=>{c.name='Submit';}],['size',(c:any)=>{c.rect.width=200;}],
] as const)('invalidates unresolved-purpose reuse on %s changes',(_name,change)=>{
  const {o,item}=purposeMaterial(),key=unresolvedPurposeKey(o,item,1),changed=structuredClone(item);change(changed.control);
  expect(unresolvedPurposeKey(o,changed,1)).not.toBe(key);
});

it('keeps context, boundary, review and candidate evidence in the unresolved-purpose key',()=>{
  const {o,item}=purposeMaterial(),key=unresolvedPurposeKey(o,item,1);
  for(const mutate of [(x:any)=>{x.context.tab.value='other';},(x:any)=>{x.boundaries=[{key:'modal'}];},(x:any)=>{x.instanceScope='new-document';}]){
    const changed=structuredClone(o);mutate(changed);expect(unresolvedPurposeKey(changed,item,1)).not.toBe(key);
  }
  for(const mutate of [(x:any)=>{x.reviews=[{id:'review',status:'revoked'}];},(x:any)=>{x.actions[0].basis.evidence=[{source:'html',rule:'new-basis',facts:{}}];},(x:any)=>{x.actions[0].risk='submission';}]){
    const changed=structuredClone(item);mutate(changed);expect(unresolvedPurposeKey(o,changed,1)).not.toBe(key);
  }
  expect(unresolvedPurposeKey(o,item,2)).not.toBe(key);
});

it('restores a hidden native operation that was blocked only by host region review when ready work ran',async()=>{
  const f=await explorerFixture('<style>#outer:not([open]) #inner{display:none}</style><details id="outer" open><summary>Ready</summary><details id="inner"><summary>Second</summary><p>Content</p></details></details>');
  let initialDocument:string|undefined;const blockedObservations=new Set<string>();
  // Exercise the public host contract for a delayed region review. This policy
  // withholds an operation; it never grants one beyond the real browser host.
  const withRegionBlock=(sid:string,availability:any)=>{
    const o=f.host.observation(sid);initialDocument??=o.instanceScope;
    if(o.instanceScope!==initialDocument)return availability;
    const ids=new Set(f.host.actions(sid).filter(a=>a.label==='Second').map(a=>a.id));
    if(ids.size)blockedObservations.add(o.id);
    return {...availability,actions:availability.actions.map((a:any)=>ids.has(a.actionId)?{...a,executable:false,blockers:[...a.blockers,{code:'REGION_REVIEW_REQUIRED',reason:'The current host region still needs review',evidence:['test:delayed-region-review']}]}:a)};
  };
  const host=new Proxy(f.host,{get(target,key){
    if(key==='actionAvailability')return (...args:Parameters<typeof target.actionAvailability>)=>withRegionBlock(args[0],target.actionAvailability(...args));
    if(key==='explorationSnapshot')return (...args:Parameters<typeof target.explorationSnapshot>)=>{const snapshot=target.explorationSnapshot(...args);return {...snapshot,availability:withRegionBlock(args[0],snapshot.availability)};};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const plugin=new ExplorerPlugin(host,new ExplorerStore(':memory:'),fakeProviders(f.url));
  try {
    const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});plugin.start(task.id);await plugin.waitForIdle();
    const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt'),clicks=attempts.filter(a=>a.action.kind==='click');
    expect(clicks.map(a=>[a.action.label,a.status])).toEqual([['Ready','succeeded'],['Second','succeeded']]);
    expect(blockedObservations.has(clicks[0].beforeId)).toBe(true);
    expect(f.host.observation(sid,clicks[0].afterId).controls.find(c=>c.name==='Second')?.visible).not.toBe(true);
    expect(f.host.observation(sid,clicks[1].beforeId).instanceScope).not.toBe(initialDocument);
    expect(view.events.some(e=>e.type==='recovery.result'&&['REACHED_VERIFIED','REACHED_ACCEPTABLE'].includes((e.data as any).status))).toBe(true);
    const second=view.task.plan.filter(i=>i.scope.label==='Second'&&i.scope.kind==='click');
    expect(second.length).toBeGreaterThan(0);expect(second.every(i=>i.status==='succeeded'&&i.resolvedBy?.attemptId===clicks[1].id)).toBe(true);
    expect(view.task.status).toBe('completed');expect(view.task.usage.actions).toBe(attempts.length);
  } finally {await plugin.close();await f.close();}
});

it('closes a tentative candidate through later noninteractive review without inventing a click or leaving a concrete obligation',async()=>{
  const f=await explorerFixture('<details><summary>Ready</summary><p>Content</p></details><div id="information" tabindex="0" onclick="void 0">Information</div>');
  const p=fakeProviders(f.url),plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),p);
  try {
    const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:4}});plugin.start(task.id);await plugin.waitForIdle();
    const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
    expect(attempts.map(a=>[a.action.label,a.status])).toEqual([['Ready','succeeded']]);
    const initialCandidate=f.host.actions(sid,attempts[0].beforeId).find(a=>a.label==='Information'&&a.kind==='click');
    expect(initialCandidate?.basis?.status).toBe('tentative');
    const classification=view.decisions.find(d=>d.purpose==='control-classification'&&(d.request.state as any).material.control.stableKey==='id:information');
    expect(classification).toBeDefined();expect(classification!.observationId).not.toBe(attempts[0].beforeId);
    const gaps=view.task.plan.filter(i=>i.required&&i.scope.stableKey==='id:information');
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every(i=>!i.scope.kind&&i.status==='succeeded'&&i.reviewResolvedBy?.classification==='display'&&!i.resolvedBy&&i.attempts.length===0)).toBe(true);
    expect(gaps.some(i=>i.evidence.some(e=>e.observationId===attempts[0].beforeId))).toBe(true);
    expect(view.events.some(e=>e.type==='review.resolved'&&gaps.some(i=>i.id===(e.data as any).itemId)&&(e.data as any).executed===false)).toBe(true);
    expect(view.task.status).toBe('completed');expect(view.task.usage.actions).toBe(1);
  } finally {await plugin.close();await f.close();}
});

it('restores a still-visible enabled operation made physically unreachable by an earlier local action',async()=>{
  const f=await explorerFixture('<style>body:has(#first[open]) #target{transform:translateX(-3000px)}</style><details id="first"><summary>First</summary><p>First content</p></details><details id="target"><summary>Second</summary><p>Second content</p></details>');
  const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),fakeProviders(f.url));
  try {
    const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:100},budget:{rounds:1,actions:8}});plugin.start(task.id);await plugin.waitForIdle();
    const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt'),clicks=attempts.filter(a=>a.action.kind==='click');
    expect(clicks.map(a=>[a.action.label,a.status])).toEqual([['First','succeeded'],['Second','succeeded']]);
    const blocked=f.host.observation(sid,clicks[0].afterId).controls.find(c=>c.name==='Second')!;
    expect(blocked).toMatchObject({visible:true,enabled:true,actionable:{outsideScrollableArea:true}});
    expect(f.host.actions(sid,clicks[0].afterId).find(a=>a.label==='Second')?.preconditions.blockers?.some(b=>b.code==='outside_scrollable_area')).toBe(true);
    expect(view.events.some(e=>e.type==='recovery.result'&&['REACHED_VERIFIED','REACHED_ACCEPTABLE'].includes((e.data as any).status))).toBe(true);
    expect(view.task.plan.filter(i=>i.required&&i.scope.label==='Second'&&i.scope.kind==='click').every(i=>i.status==='succeeded'&&i.resolvedBy?.attemptId===clicks[1].id)).toBe(true);
    expect(view.task.status).toBe('completed');expect(view.task.usage.actions).toBe(attempts.length);expect(attempts.length).toBeGreaterThan(2);
  } finally {await plugin.close();await f.close();}
});
