import { expect, it, vi } from 'vitest';
import { InteractionEngine } from '@interaction/core';
import { PlaywrightAdapter, browserControlCorrespondence, browserOperationCorrespondenceHint } from '@interaction/adapter-playwright';
import { MemoryStore } from '@interaction/storage-memory';
import { explorerFixture } from './explorer-plugin-helpers.js';

function fixture() {
  const store=new MemoryStore(),host=new InteractionEngine<any,any>({adapter:new PlaywrightAdapter(),persistence:store});
  const control=(id:string,name:string)=>({localId:id,instanceId:id,identityId:`identity-${id}`,tag:'a',role:'link',name,label:'',region:'records',form:'',visible:true,enabled:true,editable:false,
    constraints:{type:'a',required:false,valid:true},options:[],actions:['click'],
    structuralItem:{ownerInstanceId:`owner-${id}`,rowInstanceId:id,template:'["A",["SPAN","SPAN"]]',slot:'',recordKey:'["href","/records/one"]'},
    identityContext:{scope:'["ancestor-id","records"]',binding:'[["link-destination","https://example.test/records/one",""]]',evidence:['semantic-ancestor-scope/v1','link-destination/v1']},
    reviewBinding:{attributes:{href:'/records/one'}},actionBasis:{click:{status:'supported',evidence:[{source:'html',rule:'hyperlink/v1',facts:{tag:'a',href:'/records/one'}}]}}});
  const observation=(id:string,sid:string,name:string)=>({id,sessionId:sid,instanceScope:`document-${sid}`,url:'https://example.test/',context:{tenant:{status:'known',value:'one'}},gaps:[],regions:[{key:'records',label:'Records',role:'region'}],controls:[control(id,name)]});
  const before=observation('before','old','Asset one $12.30'),after=observation('after','old','Asset one $12.30'),current=observation('current','new','Asset one $12.80');
  const action=(id:string,o:any)=>({id,sessionId:o.sessionId,observationId:o.id,controlId:o.controls[0].identityId,localId:o.controls[0].localId,kind:'click',risk:'interface',basis:structuredClone(o.controls[0].actionBasis.click),preconditions:{context:structuredClone(o.context)}});
  const source=action('source',before),target=action('target',current),attempt={id:'attempt',sessionId:'old',status:'succeeded',beforeId:before.id,afterId:after.id,action:source};
  let version=0;
  const save=()=>{version++;before.id=`before-${version}`;after.id=`after-${version}`;current.id=`current-${version}`;source.observationId=before.id;target.observationId=current.id;attempt.beforeId=before.id;attempt.afterId=after.id;for(const o of [before,after,current])store.put('observation',o);store.put('action',target);store.put('attempt',attempt);};
  for(const id of ['old','new'])store.put('session',{id,options:{exploration:'controls'},actionCount:0});save();
  const query=()=>host.operationCorrespondence('new',{observationId:current.id,actionId:target.id,source:{sessionId:'old',attemptId:attempt.id}});
  return {store,host,before,after,current,source,target,attempt,save,query};
}

it('proves a unique native record click despite changed display text without changing legacy keys or execution evidence',()=>{
  const f=fixture(),oldKey=browserControlCorrespondence(f.before.controls[0] as any),newKey=browserControlCorrespondence(f.current.controls[0] as any);
  expect(oldKey?.key).not.toBe(newKey?.key);
  expect(browserOperationCorrespondenceHint(f.before.controls[0] as any,'click',f.before)?.key).toBe(browserOperationCorrespondenceHint(f.current.controls[0] as any,'click',f.current)?.key);
  const writes=vi.spyOn(f.store,'put'),events=vi.spyOn(f.store,'event'),result=f.query();
  expect(result).toMatchObject({equivalent:true,policy:'browser-native-record-link-operation-v1',identityAuthorized:false,replayAuthorized:false,currentExecution:false});
  expect(result.evidence).toContain('display-name-not-operation-identity');expect(writes).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled();
  expect(f.host.list('new','attempt')).toEqual([]);expect(f.host.session('new').actionCount).toBe(0);f.store.close();
});

it.each(['destination','target','download','role','tag','template','slot','owner','binding','explicit-label','context','region','constraints','duplicate-source','duplicate-target','non-click','basis-withdrawn','unknown','incomplete'] as const)('rejects changed or ambiguous native operation evidence: %s',change=>{
  const f=fixture(),c:any=f.current.controls[0];expect(f.query().equivalent).toBe(true);
  if(change==='destination'){c.name=f.before.controls[0].name;c.reviewBinding.attributes.href='/records/two';c.structuralItem.recordKey='["href","/records/two"]';c.actionBasis.click.evidence[0].facts.href='/records/two';f.target.basis=structuredClone(c.actionBasis.click);}
  if(change==='target')c.reviewBinding.attributes.target='_blank';
  if(change==='download')c.reviewBinding.attributes.download='report.csv';
  if(change==='role')c.role='button';if(change==='tag')c.tag='button';
  if(change==='template')c.structuralItem.template='different';if(change==='slot')c.structuralItem.slot='other';
  if(change==='owner')c.identityContext.scope='["ancestor-id","other-records"]';if(change==='binding')c.identityContext.binding='other';
  if(change==='explicit-label')c.label='Different explicit meaning';
  if(change==='context'){f.current.context.tenant.value='two';f.target.preconditions.context=structuredClone(f.current.context);}
  if(change==='region')f.current.regions[0].label='Other section';if(change==='constraints')c.constraints.required=true;
  if(change==='duplicate-source')f.before.controls.push({...structuredClone(f.before.controls[0]),localId:'other-source',instanceId:'other-source',name:'Another quote'});
  if(change==='duplicate-target')f.current.controls.push({...structuredClone(c),localId:'other-target',instanceId:'other-target',name:'Another quote'});
  if(change==='non-click'){f.source.kind='hover';f.target.kind='hover';}
  if(change==='basis-withdrawn')f.target.basis.status='tentative';
  if(change==='unknown')f.attempt.status='unknown';if(change==='incomplete')(f.after.gaps as any[]).push({code:'incomplete',critical:true});
  f.save();expect(f.query().equivalent).toBe(false);f.store.close();
});

it('does not use same-instance continuity to bypass an ambiguous native record reference',()=>{
  const f=fixture();f.current.sessionId='old';f.current.instanceScope=f.before.instanceScope;f.current.controls[0].instanceId=f.before.controls[0].instanceId;f.target.sessionId='old';
  f.current.controls.push({...structuredClone(f.current.controls[0]),localId:'duplicate',instanceId:'duplicate',name:'Other price'});f.save();
  expect(f.host.operationCorrespondence('old',{observationId:f.current.id,actionId:f.target.id,source:{sessionId:'old',attemptId:f.attempt.id}})).toMatchObject({equivalent:false,reason:'target_correspondence_ambiguous'});f.store.close();
});

it('retains strict label semantics for non-record links and ordinary buttons',()=>{
  for(const kind of ['link','button']) {
    const f=fixture();for(const o of [f.before,f.current]){const c:any=o.controls[0];delete c.structuralItem;if(kind==='button'){c.tag='button';c.role='button';}}
    f.save();expect(f.query().equivalent).toBe(false);f.store.close();
  }
});

it('uses captured browser record/destination evidence across fresh sessions with changing quote text',async()=>{
  let quote='12.30';const f=await explorerFixture(()=>`<section id="records" aria-label="Records"><a href="/records/one"><span>Asset one</span><span>$${quote}</span></a><a href="/records/two"><span>Asset two</span><span>$9.00</span></a><a href="/records/three"><span>Asset three</span><span>$8.00</span></a></section>`);
  try {
    const options={url:f.url,headless:true,exploration:'controls',settleMs:0,observeTimeoutMs:100,interfaceActions:[{kind:'click'}]};
    const s=await f.host.createSession(options),o=f.host.observation(s.id),c=o.controls.find(c=>c.reviewBinding?.attributes.href==='/records/one')!;
    expect(c.structuralItem?.recordKey).toBe('["href","/records/one"]');
    const a=f.host.actions(s.id).find(a=>a.localId===c.localId)!;const executed=await f.host.execute(s.id,a.id,'source-click');expect(executed.status).toBe('succeeded');await f.host.stop(s.id);
    quote='12.80';const next=await f.host.createSession(options),fresh=f.host.observation(next.id),target=fresh.controls.find(c=>c.reviewBinding?.attributes.href==='/records/one')!;
    expect(target.name).not.toBe(c.name);const nextAction=f.host.actions(next.id).find(a=>a.localId===target.localId)!;
    const proof=f.host.operationCorrespondence(next.id,{observationId:fresh.id,actionId:nextAction.id,source:{sessionId:s.id,attemptId:executed.id}});
    expect(proof).toMatchObject({equivalent:true,currentExecution:false,identityAuthorized:false,replayAuthorized:false});expect(f.host.list(next.id,'attempt')).toEqual([]);
  } finally {await f.close();}
});
