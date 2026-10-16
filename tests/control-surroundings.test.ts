import {expect,it,vi} from 'vitest';
import {controlSurroundingsReader,controlReviewConditions,type Control,type Observation} from '@interaction/adapter-playwright';
import {ControlReviews} from '../packages/browser/src/control-reviews.js';
import {MemoryStore} from '@interaction/storage-memory';
import {reviewNext,unresolvedPurposeKey,type ReviewContext} from '../packages/explorer-plugin/src/reviews.js';
import {explorerFixture} from './explorer-plugin-helpers.js';

function fixture(){
 const control=(id:string,tag:string,parent:string,extra:Partial<Control>={}):Control=>({localId:id,instanceId:id,tag,role:tag==='input'?'textbox':'button',name:id,label:id,region:'main',form:'document',selector:'#'+id,rect:{x:0,y:0,width:20,height:20},value:'',displayedText:'',checked:null,selected:[],visible:true,enabled:true,editable:tag==='input',expanded:null,controls:null,constraints:{type:tag,required:false,valid:true},options:[],actions:tag==='input'?['fill']:['click'],discovery:[],reviewBinding:{parentInstanceId:parent,attributes:{}},actionable:{visible:true,enabled:true,editable:tag==='input',hitTarget:true,unknown:[]},...extra});
 const target=control('target','i','suffix',{name:'Clear',actionBasis:{click:{status:'supported',evidence:[{source:'aria',rule:'declared-activation/v1',facts:{role:'button',implementation:'unverified'}}]}}});
 const input=control('input','input','box',{name:'Search',value:'example'});
 const nodes:NonNullable<Control['classificationBinding']>['nodes']=[{instanceId:'box',parentInstanceId:'page',tag:'div',attributes:{}},{instanceId:'input',parentInstanceId:'box',tag:'input',attributes:{type:'search'}},{instanceId:'suffix',parentInstanceId:'box',tag:'div',attributes:{}},{instanceId:'target',parentInstanceId:'suffix',tag:'i',attributes:{role:'button','aria-label':'Clear'}}];
 const owner=control('box','div','page',{role:'none',actions:[],classificationBinding:{nodes,text:'',truncated:false}});
 const o={id:'o',sessionId:'s',instanceScope:'doc',url:'https://fixture.test/',controls:[owner,input,target],context:{},gaps:[],regions:[],boundaries:[]} as unknown as Observation;
 return {o,owner,input,target};
}
it('publishes existing nearest structural evidence without inferring a purpose or altering actions',()=>{
 const {o,target,owner}=fixture();o.controls.unshift({...owner,localId:'outer',instanceId:'outer',classificationBinding:{nodes:[{instanceId:'outer',parentInstanceId:'doc',tag:'div',attributes:{}},...owner.classificationBinding!.nodes.map(n=>n.instanceId==='box'?{...n,parentInstanceId:'outer'}:n)],text:'',truncated:false}});
 const context=controlSurroundingsReader(o)(target)!;
 expect(context).toMatchObject({ownerInstanceId:'box',complete:true,truncated:false});expect(context.controls.map(c=>c.instanceId)).toEqual(['input','target']);
 const pending={localId:target.localId,kind:'click',risk:'unknown',basis:target.actionBasis!.click} as any;
 const material=new ControlReviews(new MemoryStore(),()=>{}).material(o,[pending]);expect(material.controls.find(c=>c.control===target)?.surroundings).toEqual(context);
 expect(target.actionBasis!.click.evidence).toHaveLength(1);expect(material.controls.find(c=>c.control===target)?.actions).toEqual([pending]);
});
it.each(['truncated','moved','cycle','oversize'] as const)('keeps %s context incomplete and unusable for a context-bound review',change=>{
 const {o,target,owner}=fixture();if(change==='truncated')owner.classificationBinding!.truncated=true;
 if(change==='moved')target.reviewBinding!.parentInstanceId='other';
 if(change==='cycle')owner.classificationBinding!.nodes[2].parentInstanceId='target';
 if(change==='oversize')owner.classificationBinding!.nodes[0].attributes.title='x'.repeat(12001);
 const context=controlSurroundingsReader(o)(target)!;expect(context.complete).toBe(false);
 expect(controlReviewConditions(target,o,'click',undefined,context.key)).toBeUndefined();
 const ledger=new ControlReviews(new MemoryStore(),()=>{});expect(()=>ledger.record(o,{observationId:o.id,source:'test',reviews:[{localId:target.localId,kind:'click',risk:'interface',reason:'test',evidence:['test'],surroundingContextKey:context.key}]})).toThrow();
});
it.each(['replace-input','change-input-purpose','move-container','truncate'] as const)('invalidates a bound approval after %s without erasing historical evidence',change=>{
 const {o,target,input,owner}=fixture(),store=new MemoryStore(),ledger=new ControlReviews(store,()=>{}),context=controlSurroundingsReader(o)(target)!;
 const [review]=ledger.record(o,{observationId:o.id,source:'test',reviews:[{localId:target.localId,kind:'click',risk:'interface',reason:'Reviewed observed context',evidence:['current-context'],surroundingContextKey:context.key}]});
 const action=ledger.apply([],o)[0];expect(action.risk).toBe('interface');
 const after=structuredClone(o);after.id='new';const aInput=after.controls.find(c=>c.instanceId===input.instanceId)!,aOwner=after.controls.find(c=>c.instanceId===owner.instanceId)!;
 if(change==='replace-input'){aInput.instanceId=aInput.localId='new-input';aOwner.classificationBinding!.nodes.find(n=>n.instanceId==='input')!.instanceId='new-input';}
 if(change==='change-input-purpose')aInput.name='Account deletion confirmation';
 if(change==='move-container')aOwner.classificationBinding!.nodes[0].parentInstanceId='other';
 if(change==='truncate')aOwner.classificationBinding!.truncated=true;
 expect(()=>ledger.validate(action,after)).toThrow();ledger.reconcile(after);expect(store.get<any>('control-review',review.id)?.status).toBe('invalidated');
 expect(store.get<any>('control-review',review.id)?.conditions.surroundingContextKey).toBe(context.key);
 expect(ledger.apply([],after)).toEqual([]);
});
it('keeps legacy reviews readable and does not bind unrelated existing approvals retroactively',()=>{
 const {o,target,owner}=fixture(),ledger=new ControlReviews(new MemoryStore(),()=>{});
 const [r]=ledger.record(o,{observationId:o.id,source:'legacy',reviews:[{localId:target.localId,kind:'click',risk:'interface',reason:'Explicit caller review',evidence:['caller']}]});
 expect(r.conditions).not.toHaveProperty('surroundingContextKey');owner.classificationBinding!.truncated=true;
 expect(()=>ledger.validate(ledger.apply([],o)[0],o)).not.toThrow();
});
it.each(['uncertain','unestablished','external','incomplete','still-uncertain'] as const)('passes context to JEV and uses LLM only for %s compatible evidence',async mode=>{
 const {o,target,owner}=fixture();if(mode==='incomplete')owner.classificationBinding!.truncated=true;
 const surroundings=controlSurroundingsReader(o)(target)!,item={control:target,surroundings,actions:[],reviews:[],needsReview:true};
 const decision={id:'d',actor:'jev'},assess=vi.fn(async(_purpose:string,_material:unknown)=>({values:{interface_click:mode==='unestablished'?false:null,external_click:mode==='external'?true:false},decision})),clarify=vi.fn(async()=>({value:mode==='still-uncertain'?'uncertain':'click',decision})),apply=vi.fn(async(_decision:unknown,_command:unknown)=>{});
 const ctx={observation:o,task:{revision:1,plan:[{required:true,dispatchScope:true,scope:{url:o.url,label:'Clear'},prerequisites:[]}],rounds:[{reviewed:[],entryPath:[]}]},host:{actions:()=>[],regionReviewMaterial:()=>({enabled:false}),controlClassificationMaterial:()=>({controls:[]}),controlReviewMaterial:()=>({controls:[item]}),list:()=>[],discoveryScanMaterial:()=>({})},assess,clarify,apply,refresh:async()=>false,gap:vi.fn(),hasPendingAction:()=>false} as unknown as ReviewContext;
 await reviewNext(ctx);expect(assess.mock.calls[0][1]).toMatchObject({surroundings});
 expect(clarify).toHaveBeenCalledTimes(['uncertain','unestablished','still-uncertain'].includes(mode)?1:0);expect(apply).toHaveBeenCalledTimes(['uncertain','unestablished'].includes(mode)?1:0);
 if(['uncertain','unestablished'].includes(mode))expect(apply.mock.calls[0][1]).toMatchObject({review:{reviews:[{surroundingContextKey:surroundings.key}]}});
 const key=unresolvedPurposeKey(o,item,1);expect(unresolvedPurposeKey(o,{...item,surroundings:{...surroundings,key:'new'}},1)).not.toBe(key);
 if(mode==='still-uncertain'){ctx.task.rounds[0].reviewed=[];await reviewNext(ctx);expect(assess.mock.calls.filter(call=>call[0]==='control-risk')).toHaveLength(1);expect(clarify).toHaveBeenCalledTimes(1);expect(apply).not.toHaveBeenCalled();}
});
it('finds real captured input relationships for an ARIA activation with no own subtree',async()=>{
 const f=await explorerFixture('<div tabindex="-1" id="box"><input type="search" aria-label="Search" value="example"><span><i role="button" tabindex="0" aria-label="Clear" style="display:inline-block;width:20px;height:20px"></i></span></div>');
 try{const session=await f.host.createSession({url:f.url,headless:true,settleMs:0,observeTimeoutMs:300});const material=f.host.controlReviewMaterial(session.id);const item=material.controls.find(i=>i.control.name==='Clear')!;
 expect(item.control.classificationBinding).toBeUndefined();expect(item.surroundings).toMatchObject({complete:true});expect(item.surroundings!.controls.some(c=>c.name==='Search'&&c.value==='example')).toBe(true);
 expect(item.actions.every(a=>a.risk!=='interface')).toBe(true);
 }finally{await f.close();}
});

it.each(['submission','dispatch'] as const)('rejects a changed live neighbor at %s before using its old context judgment',async stage=>{
 const {pageOf}=await import('./helpers.js');
 const f=await explorerFixture('<div tabindex="-1" id="box"><input id="search" type="search" aria-label="Search" value="example"><span><i id="clear" role="button" tabindex="0" aria-label="Clear" style="display:inline-block;width:20px;height:20px"></i></span></div><script>window.clicks=0;document.getElementById("clear").onclick=()=>{window.clicks++;document.getElementById("search").value=""}</script>');
 try{const session=await f.host.createSession({url:f.url,headless:true,settleMs:0,observeTimeoutMs:300,exploration:'controls'});const material=f.host.controlReviewMaterial(session.id),item=material.controls.find(i=>i.control.name==='Clear')!,key=item.surroundings!.key;
 const request={observationId:material.observationId,source:'test',reviews:[{localId:item.control.localId,kind:'click' as const,risk:'interface' as const,reason:'Explicit fixture context review',evidence:['observed-input-context'],surroundingContextKey:key}]};
 if(stage==='submission'){
  await pageOf(f.host).locator('#search').evaluate(el=>(el as HTMLInputElement).value='changed');
  await expect(f.host.reviewControls(session.id,request)).rejects.toMatchObject({code:'STALE_CONTROL_REVIEW'});
 }else{
  const records=await f.host.reviewControls(session.id,request);expect(records[0].status).toBe('active');
  const action=f.host.actions(session.id).find(a=>a.localId===item.control.localId&&a.kind==='click')!;
  expect(action.basis!.evidence.some(e=>e.rule==='reviewed-control/v1'&&e.facts.surroundingContextKey===key)).toBe(true);
  await pageOf(f.host).locator('#search').evaluate(el=>(el as HTMLInputElement).value='changed');
  await expect(f.host.execute(session.id,action.id,'context-stale')).rejects.toMatchObject({code:'STALE_OBSERVATION'});
 }
 expect(await pageOf(f.host).evaluate(()=>(window as any).clicks)).toBe(0);
 }finally{await f.close();}
});

it('executes a freshly reviewed context once and invalidates its changed post-action context',async()=>{
 const {pageOf}=await import('./helpers.js');
 const f=await explorerFixture('<div tabindex="-1"><input id="search" type="search" aria-label="Search" value="example"><span><i id="clear" role="button" tabindex="0" aria-label="Clear" style="display:inline-block;width:20px;height:20px"></i></span></div><script>window.clicks=0;document.getElementById("clear").onclick=()=>{window.clicks++;document.getElementById("search").value=""}</script>');
 try{const s=await f.host.createSession({url:f.url,headless:true,settleMs:0,observeTimeoutMs:300,exploration:'controls'}),m=f.host.controlReviewMaterial(s.id),item=m.controls.find(i=>i.control.name==='Clear')!;
 const [record]=await f.host.reviewControls(s.id,{observationId:m.observationId,source:'test',reviews:[{localId:item.control.localId,kind:'click',risk:'interface',reason:'Explicit observed context judgment',evidence:['context'],surroundingContextKey:item.surroundings!.key}]});
 const action=f.host.actions(s.id).find(a=>a.localId===item.control.localId&&a.kind==='click')!;
 const attempt=await f.host.execute(s.id,action.id,'current-context');expect(attempt.status).toBe('succeeded');expect(await pageOf(f.host).locator('#search').inputValue()).toBe('');expect(await pageOf(f.host).evaluate(()=>(window as any).clicks)).toBe(1);
 expect(f.host.list<any>(s.id,'control-review').find(r=>r.id===record.id).status).toBe('invalidated');
 }finally{await f.close();}
});
