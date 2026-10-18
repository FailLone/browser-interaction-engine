import { expect, it, vi } from 'vitest';
import { InteractionEngine } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { PlaywrightAdapter, browserOperationCorrespondenceHint, browserTargetConditions } from '@interaction/adapter-playwright';
import { browserPortableBranchConditions } from '../packages/adapter-playwright/src/branch-conditions.js';
import { nativeNavigationOperationReader } from '../packages/adapter-playwright/src/native-navigation.js';
import { createBrowserOperationCorrespondenceHintReader } from '../packages/adapter-playwright/src/exploration.js';
import { navigationModeFixture, setModeExpanded } from './fixtures/mode-structure.js';
import type { ActionCandidate, Control } from '../packages/adapter-playwright/src/types.js';

function document(documentId:string, externalLabel=false) {
  const f=navigationModeFixture({documentId,instanceBound:true});
  const target=f.observation.controls.find(c=>c.localId==='link-a')!;
  for(const c of f.observation.controls.filter(c=>c.tag==='a')){
    c.name=c.localId==='link-a'?'Convert':'Spot';c.label='';c.identityScope='instance';
    c.stableKey=`record-instance:${documentId}:${c.localId}`;
    c.structuralItem={ownerInstanceId:f.nodes.list.instanceId,rowInstanceId:c.reviewBinding!.parentInstanceId,template:'li>a',slot:'a',recordKey:JSON.stringify(['record-instance',`${documentId}:${c.localId}`,c.reviewBinding!.attributes.href])};
    c.actions=['click'];c.actionBasis={click:{status:'supported',evidence:[{source:'html',rule:'hyperlink/v1',facts:{tag:'a',href:c.reviewBinding!.attributes.href}}]}};
  }
  if(externalLabel){
    // No nav element is needed: a named native list plus a captured external
    // IDREF supplies the semantic owner. Mode proof remains independent.
    f.owner.reviewReuseBinding!.ancestors=[{tag:'header',selector:'header',attributes:{},label:''}];
    f.nodes.list.attributes['aria-labelledby']='trading-group';
    f.owner.classificationBinding!.references=[{id:'trading-group',targetInstanceId:`${documentId}:heading`,target:{truncated:false,text:'Trading',nodes:[{instanceId:`${documentId}:heading`,parentInstanceId:`${documentId}:header`,tag:'h2',attributes:{id:'trading-group'}}]}}];
    const modes=new Set(Object.values(f.modes).map(c=>c.instanceId));
    f.owner.classificationBinding!.nodes=f.owner.classificationBinding!.nodes.filter(n=>!modes.has(n.instanceId));
    f.observation.controls=f.observation.controls.filter(c=>!modes.has(c.instanceId));
  }
  return {...f,target};
}
function fixture(externalLabel=false) {
  const before=document('before-document',externalLabel),current=document('current-document',externalLabel);
  before.observation.sessionId='old';current.observation.sessionId='new';
  const action=(id:string,f:ReturnType<typeof document>):ActionCandidate=>({id,sessionId:f.observation.sessionId,observationId:f.observation.id,stateId:f.observation.stateId,
    controlId:f.target.identityId,localId:f.target.localId,kind:'click',label:'Convert',risk:'interface',replayable:false,excluded:false,sampleValidity:'known',
    target:{kind:'instance',instanceScope:f.observation.instanceScope,instanceId:f.target.instanceId,evidence:['current instance only']},basis:structuredClone(f.target.actionBasis!.click),
    preconditions:{context:structuredClone(f.observation.context),identityResolved:true,targetResolved:true}} as ActionCandidate);
  const source=action('old-action',before),target=action('new-action',current),after=structuredClone(before.observation);after.id='after';
  const attempt={id:'old-attempt',sessionId:'old',status:'succeeded',beforeId:before.observation.id,afterId:after.id,action:source};
  const store=new MemoryStore(),adapter=new PlaywrightAdapter();adapter.createDriver=vi.fn(()=>{throw new Error('driver forbidden');});
  const host=new InteractionEngine<any,any>({adapter,persistence:store});
  let revision=0;
  const save=()=>{
    revision++;before.observation.id=`before-${revision}`;current.observation.id=`current-${revision}`;after.id=`after-${revision}`;
    source.observationId=before.observation.id;target.observationId=current.observation.id;attempt.beforeId=before.observation.id;attempt.afterId=after.id;
    for(const f of [before,current]){store.put('observation',f.observation);const session=store.require<any>('session',f.observation.sessionId);session.currentObservationId=f.observation.id;store.put('session',session);}
    store.put('observation',after);for(const a of [source,target])store.put('action',a);store.put('attempt',attempt);
  };
  for(const sid of ['old','new'])store.put('session',{id:sid,options:{exploration:'controls'},currentObservationId:sid==='old'?before.observation.id:current.observation.id,actionCount:0});save();
  const query=()=>host.explorationTargetCorrespondences('new',{observationId:current.observation.id,requests:[{actionId:target.id,source:{sessionId:'old',observationId:before.observation.id,actionId:source.id}}]});
  const operation=()=>host.operationCorrespondence('new',{observationId:current.observation.id,actionId:target.id,source:{sessionId:'old',attemptId:attempt.id}});
  return {before,current,source,target,after,attempt,adapter,store,host,save,query,operation};
}

it('proves only the native navigation operation across rebuilt li instances, including portable target conditions and all modes',()=>{
  const f=fixture(),original=structuredClone([f.before.observation,f.current.observation,f.source,f.target]);
  const beforeHint=browserOperationCorrespondenceHint(f.before.target,'click',f.before.observation),currentHint=browserOperationCorrespondenceHint(f.current.target,'click',f.current.observation);
  expect(beforeHint).toMatchObject({policy:'browser-native-navigation-v2',requiresUniqueTarget:true});expect(currentHint?.key).toBe(beforeHint?.key);
  expect(browserPortableBranchConditions(f.source,f.before.observation)?.policy).toBe('browser-branch-conditions-v4');
  expect(browserTargetConditions(f.source,f.before.observation)).toEqual(browserTargetConditions(f.target,f.current.observation));
  const put=vi.spyOn(f.store,'put'),event=vi.spyOn(f.store,'event');
  expect(f.query().results[0]).toMatchObject({equivalent:true,identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  expect(f.operation()).toMatchObject({equivalent:true,policy:'browser-native-navigation-operation-v2',identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  expect([f.before.observation,f.current.observation,f.source,f.target]).toEqual(original);expect(f.target.replayable).toBe(false);expect(f.target.target?.kind).toBe('instance');
  expect(put).not.toHaveBeenCalled();expect(event).not.toHaveBeenCalled();expect(f.adapter.createDriver).not.toHaveBeenCalled();f.store.close();
});

it('supports a named ul with complete external IDREF evidence without requiring a nav tag',()=>{
  const f=fixture(true);expect(f.query().results[0]).toMatchObject({equivalent:true});f.store.close();
});

it('keeps native destination correspondence across hover presentation and outside-landmark document metadata, without changing raw identities',()=>{
  const f=fixture();
  for(const x of [f.before,f.current]){x.observation.coveragePolicy='finite-ui-v1';x.owner.reviewReuseBinding!.ancestors.push({tag:'body',selector:'body',attributes:{'data-overlay-depth':'0'},label:''});}
  const c=f.current.target,n=f.current.nodes['link-a'];
  n.attributes.class=c.reviewBinding!.attributes.class='hover-highlight';n.attributes.style=c.reviewBinding!.attributes.style='color: red';
  f.current.owner.reviewReuseBinding!.ancestors.at(-1)!.attributes={'data-overlay-depth':'1'};
  f.save();const raw=structuredClone([f.before.observation,f.current.observation]);
  expect(f.query().results[0],JSON.stringify({result:f.query().results[0],before:browserOperationCorrespondenceHint(f.before.target,'click',f.before.observation),after:browserOperationCorrespondenceHint(f.current.target,'click',f.current.observation)})).toMatchObject({equivalent:true,identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  expect(f.operation()).toMatchObject({equivalent:true,policy:'browser-native-navigation-operation-v2'});
  expect(f.before.target.stableKey).not.toBe(f.current.target.stableKey);
  expect([f.before.observation,f.current.observation]).toEqual(raw);
  // Business/mode data on the navigation target remains exact.
  n.attributes['data-mode']=c.reviewBinding!.attributes['data-mode']='changed';f.save();
  expect(f.query().results[0].equivalent).toBe(false);f.store.close();
});

it.each((['destination','target','download','owner','owner-attributes','target-attributes','subtree-attributes','truncated','missing-idref','ambiguous-idref','nested-unresolved-idref','empty-owner-label','duplicate-destination','unobserved-rival','duplicate-owner','broken-parent','hypothesis','non-native','unknown','aria','readiness','context'] as const).flatMap(change=>[false,true].map(finite=>[finite,change] as const)))('refuses incomplete, changed or ambiguous navigation facts (finite=%s): %s',(finite,change)=>{
  const f=fixture(true),c=f.current.target,owner=f.current.owner,node=f.current.nodes['link-a'];if(finite){f.before.observation.coveragePolicy=f.current.observation.coveragePolicy='finite-ui-v1';f.save();}expect(f.operation().equivalent).toBe(true);
  if(change==='destination'){node.attributes.href=c.reviewBinding!.attributes.href='/different';c.identityContext!.binding=JSON.stringify([['link-destination','https://navigation.fixture.invalid/different','']]);c.actionBasis!.click.evidence[0].facts.href='/different';f.target.basis=structuredClone(c.actionBasis!.click);}
  if(change==='target'){node.attributes.target=c.reviewBinding!.attributes.target='_blank';c.identityContext!.binding=JSON.stringify([['link-destination','https://navigation.fixture.invalid/trade/a','_blank']]);}
  if(change==='download')node.attributes.download='report.csv';
  if(change==='owner')owner.identityContext!.scope='different-navigation';
  if(change==='owner-attributes'){owner.classificationBinding!.nodes[0].attributes['data-mode']='different';}
  if(change==='target-attributes'){node.attributes.onclick=c.reviewBinding!.attributes.onclick='otherAction()';}
  if(change==='subtree-attributes')f.current.nodes['row-a'].attributes['data-product']='different';
  if(change==='truncated')owner.classificationBinding!.truncated=true;
  if(change==='missing-idref')owner.classificationBinding!.references=[];
  if(change==='ambiguous-idref')owner.classificationBinding!.references![0].ambiguous=true;
  if(change==='nested-unresolved-idref')owner.classificationBinding!.references![0].target!.nodes[0].attributes['aria-describedby']='uncaptured';
  if(change==='empty-owner-label')owner.classificationBinding!.references![0].target!.text='';
  if(change==='duplicate-destination'||change==='unobserved-rival'){
    const rival=f.current.observation.controls.find(c=>c.localId==='link-b')!,rivalNode=f.current.nodes['link-b'];
    if(change==='duplicate-destination'){rivalNode.attributes.href=rival.reviewBinding!.attributes.href=node.attributes.href;rival.identityContext!.binding=c.identityContext!.binding;rival.actionBasis!.click=structuredClone(c.actionBasis!.click);}
    else f.current.observation.controls=f.current.observation.controls.filter(c=>c!==rival);
  }
  if(change==='duplicate-owner'){const rival=structuredClone(owner);rival.localId='owner-twin';rival.instanceId='owner-twin';delete rival.classificationBinding;f.current.observation.controls.push(rival);}
  if(change==='broken-parent')node.parentInstanceId='missing-parent';
  if(change==='hypothesis')c.hypothesisId='pending';
  if(change==='non-native'){c.actionBasis!.click.status='tentative';f.target.basis=structuredClone(c.actionBasis!.click);}
  if(change==='unknown')f.attempt.status='unknown';
  if(change==='aria')node.attributes['aria-expanded']=c.reviewBinding!.attributes['aria-expanded']='true';
  if(change==='readiness')c.readiness={status:'unstable',reason:'changing target'};
  if(change==='context')f.current.observation.context={account:{status:'known',value:'changed',source:'test'}};
  f.save();expect(f.operation().equivalent).toBe(false);if(change!=='unknown')expect(f.query().results[0].equivalent).toBe(false);f.store.close();
});

it('retains nonlocal A/B mode dependencies and refuses missing or changed modes',()=>{
  const f=fixture();expect(f.query().results[0].equivalent).toBe(true);
  setModeExpanded(f.current,'a',true);f.save();expect(f.query().results[0]).toMatchObject({equivalent:false});
  setModeExpanded(f.current,'a',false);f.current.observation.controls=f.current.observation.controls.filter(c=>c!==f.current.modes.a);f.save();expect(f.query().results[0].equivalent).toBe(false);
  // B surviving does not inherit A's reference or erase the missing mode.
  expect(f.current.observation.controls).toContain(f.current.modes.b);f.store.close();
});

it('keeps a hidden mode outside the navigation owner in the complete operation conditions',()=>{
  const f=fixture();
  for(const d of [f.before,f.current]){
    const mode:Control={...structuredClone(d.target),localId:'outside-mode',instanceId:`${d.observation.documentId}:outside-mode`,identityId:'outside-mode',
      tag:'input',role:'checkbox',name:'Independent form mode',label:'Independent form mode',stableKey:'id:outside-mode',checked:false,visible:false,
      identityContext:{scope:'other-form',binding:'mode',evidence:['captured-owner']},identityScope:undefined,structuralItem:undefined,
      reviewBinding:{parentInstanceId:`${d.observation.documentId}:other-form`,attributes:{type:'checkbox'}},actionBasis:{},actions:['check']};
    d.observation.controls.push(mode);
  }
  f.save();expect(f.query().results[0].equivalent).toBe(true);
  f.current.observation.controls.find(c=>c.localId==='outside-mode')!.checked=true;f.save();
  expect(browserOperationCorrespondenceHint(f.before.target,'click',f.before.observation)?.key).toBe(browserOperationCorrespondenceHint(f.current.target,'click',f.current.observation)?.key);
  expect(f.query().results[0]).toMatchObject({equivalent:false,reason:'operation_conditions_changed'});f.store.close();
});

it('does not migrate arbitrary instance controls or accept a URL-only legacy caller as complete structure',()=>{
  const f=fixture();expect(browserOperationCorrespondenceHint(f.before.target,'click',{url:f.before.observation.url})).toBeUndefined();
  expect(browserOperationCorrespondenceHint(f.before.target,'hover',f.before.observation)).toBeUndefined();
  const reader=nativeNavigationOperationReader(f.before.observation);expect(reader(f.before.modes.a)).toBeUndefined();
  const input={...structuredClone(f.before.target),tag:'input',role:'textbox',actions:['fill']} as Control;expect(reader(input)).toBeUndefined();f.store.close();
});

it('shares owner projection only inside one explicit synchronous query and re-reads facts for the next query',()=>{
  const f=document('query-document',true),tree=f.owner.classificationBinding!,text=tree.text;let reads=0;
  Object.defineProperty(tree,'text',{configurable:true,enumerable:true,get(){reads++;return text;}});
  const read=createBrowserOperationCorrespondenceHintReader(f.observation),first=read(f.target,'click');expect(first).toBeDefined();
  const afterFirst=reads;expect(afterFirst).toBeGreaterThan(0);
  expect(read(f.observation.controls.find(c=>c.localId==='link-b')!,'click')).toBeDefined();expect(reads).toBe(afterFirst);
  // Mutation starts a new query; no cached reader is reused across that boundary.
  Object.defineProperty(tree,'text',{configurable:true,enumerable:true,value:`${text} changed`});
  expect(createBrowserOperationCorrespondenceHintReader(f.observation)(f.target,'click')?.key).not.toBe(first!.key);
  expect(browserOperationCorrespondenceHint(f.target,'click',f.observation)?.key).not.toBe(first!.key);
  const adapter=new PlaywrightAdapter(),override=vi.fn(()=>undefined);adapter.operationCorrespondenceHint=override;
  const custom=adapter.createOperationCorrespondenceHintReader(f.observation);custom(f.target,'click');custom(f.target,'click');expect(override).toHaveBeenCalledTimes(2);
});

it('creates the SDK query-local factory once per observation and never reuses it in another query',()=>{
  const f=fixture(),factory=vi.spyOn(f.adapter,'createOperationCorrespondenceHintReader');
  expect(f.query().results[0].equivalent).toBe(true);expect(factory).toHaveBeenCalledTimes(2);
  expect(f.query().results[0].equivalent).toBe(true);expect(factory).toHaveBeenCalledTimes(4);
  const override=vi.fn(()=>undefined);f.adapter.operationCorrespondenceHint=override;
  expect(f.query().results[0].equivalent).toBe(false);expect(override).toHaveBeenCalled();f.store.close();
});
