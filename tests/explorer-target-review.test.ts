import {expect,it,vi} from 'vitest';
import {reviewNext,type ReviewContext} from '../packages/explorer-plugin/src/reviews.js';

// Pure captured facts only: these tests never create an engine, browser or store.
function fixture(){
 const controls=['target','peer','other'].map(localId=>({localId,instanceId:localId,name:localId,tag:'a',role:'link',href:`https://fixture.test/${localId}`,region:'main',visible:true,editable:false,rect:{x:0,y:0,width:20,height:20},actionBasis:{click:{status:'supported',evidence:[]}},reviewBinding:{attributes:{href:`https://fixture.test/${localId}`}}}));
 const o:any={id:'o',sessionId:'s',instanceScope:'doc',url:'https://fixture.test/',context:{mode:{status:'known',value:'A'}},controls,regions:[],boundaries:[],overlays:[]};
 const actions:any[]=controls.map(control=>({id:`a-${control.localId}`,sessionId:'s',observationId:'o',localId:control.localId,label:control.name,kind:'click',risk:'unknown',basis:control.actionBasis.click}));
 const classifications:any={controls:controls.map(control=>({control,actions:actions.filter(a=>a.localId===control.localId),classifications:[],needsClassification:false}))};
 const operations:any={controls:controls.map(control=>({control,actions:actions.filter(a=>a.localId===control.localId),reviews:[],needsReview:false}))};
 const regions:any={enabled:true,unassignedControlIds:['other'],unassignedPageTraversal:true,candidates:[{id:'other-region',basis:'semantic',label:'Other region',controlIds:['other'],binding:{tag:'section'}}],controls};
 const exploration:any={groups:[]},hypotheses:any[]=[];
 const host={session:()=>({options:{executionPolicy:'observed-ui'}}),actions:()=>actions,regionReviewMaterial:vi.fn(()=>regions),explorationReviewMaterial:vi.fn(()=>exploration),controlClassificationMaterial:vi.fn(()=>classifications),controlReviewMaterial:vi.fn(()=>operations),controlInterpretationSnapshot:vi.fn(()=>({classifications,operations})),list:(_sid:string,kind:string)=>kind==='hypothesis'?hypotheses:[],discoveryScanMaterial:vi.fn(()=>({}))};
 const choose=vi.fn(async(_purpose:string,_instructions:string,_state:unknown,_options:Record<string,unknown>)=>({value:'interaction',decision:{id:'decision'} as any}));
 const c={host,observation:o,task:{id:'task',revision:1,coverageMode:'all',plan:[{id:'root',required:true,dispatchScope:true,reason:'user_requested',scope:{url:o.url},prerequisites:[],status:'pending'}],rounds:[{sessionId:'s',reviewed:[],entryPath:[]}]},priorityActionIds:['a-target'],choose,apply:vi.fn(async(_decision:unknown,_command:unknown)=>{}),programApply:vi.fn(async(_command:unknown,_reason:string)=>{}),retain:vi.fn(async(_groups:unknown)=>{}),gap:vi.fn(),hasPendingAction:vi.fn(()=>false),refresh:vi.fn(async()=>false),probe:vi.fn(async()=>{}),assess:vi.fn(),clarify:vi.fn(),generate:vi.fn()} as unknown as ReviewContext;
 const group=(id:string,memberIds:string[])=>({id,revision:1,label:id,kind:'similar-list',status:'pending',decisions:[],members:memberIds.map(localId=>({key:`key-${localId}`,actionId:`a-${localId}`,label:localId,kind:'click',risk:'unknown'}))});
 return {c,o,actions,controls,host,regions,exploration,classifications,operations,hypotheses,choose,group};
}

it('retains every current member of the selected child group before unrelated region work',async()=>{
 const f=fixture();f.exploration.groups=[f.group('unrelated',['other']),f.group('selected',['target','peer'])];
 const before=JSON.stringify({o:f.o,plan:f.c.task.plan});
 expect(await reviewNext(f.c)).toBe(true);
 expect(f.c.retain).toHaveBeenCalledExactlyOnceWith([{id:'selected',revision:1,label:'selected',memberKeys:['key-target','key-peer'],actionIds:['a-target','a-peer'],historicalMemberCount:0}]);
 expect(f.host.regionReviewMaterial).not.toHaveBeenCalled();expect(f.c.task.rounds[0].reviewed).toEqual(['group:selected:1']);
 expect(JSON.stringify({o:f.o,plan:f.c.task.plan})).toBe(before);
});

it('keeps representative sampling permission and omitted-member gaps for the full selected group',async()=>{
 const f=fixture();f.c.task.coverageMode='representative';f.exploration.groups=[f.group('selected',['target','peer'])];
 f.c.choose=vi.fn(async(purpose,_instructions,state,_options,constraints)=>{
  if(purpose==='scope-review'){expect((state as any).group.members).toHaveLength(2);expect(constraints?.allowedReductions).toEqual(['sample']);return {value:'sample',decision:{id:'sampling'} as any};}
  expect(purpose).toBe('sample-selection');return {value:'key-target',decision:{id:'selection'} as any};
 });
 expect(await reviewNext(f.c)).toBe(true);expect(f.c.retain).not.toHaveBeenCalled();
 expect(f.c.apply).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({type:'decideExplorationGroup',decision:expect.objectContaining({mode:'sample',memberKeys:['key-target']})}));
 expect(f.c.gap).toHaveBeenCalledWith('sample_unselected',expect.objectContaining({label:'peer'}),false);
 expect(f.host.regionReviewMaterial).not.toHaveBeenCalled();expect(f.c.task.plan[0].status).toBe('pending');
});

it('reviews the whole selected region candidate and leaves page traversal and unrelated regions pending',async()=>{
 const f=fixture();f.regions.unassignedControlIds=['target','peer','other'];f.regions.candidates.unshift({id:'selected-region',basis:'semantic',label:'Selected region',controlIds:['target','peer'],binding:{tag:'section'}});
 expect(await reviewNext(f.c)).toBe(true);
 expect(f.c.programApply).toHaveBeenCalledWith(expect.objectContaining({type:'reviewRegions',review:expect.objectContaining({regions:[expect.objectContaining({candidateIds:['selected-region'],controlIds:['target','peer'],pageTraversal:false})]})}),'observed_region_partition');
 const focusedKey=f.c.task.rounds[0].reviewed[0];
 f.c.priorityActionIds=[];expect(await reviewNext(f.c)).toBe(true);
 expect(f.c.task.rounds[0].reviewed).toHaveLength(2);expect(f.c.task.rounds[0].reviewed[1]).not.toBe(focusedKey);
 expect(f.c.task.plan[0].status).toBe('pending');expect(f.regions.unassignedControlIds).toEqual(['target','peer','other']);
});

it('prioritizes target classification with original nonlocal facts before unrelated region review',async()=>{
 const f=fixture();f.classifications.controls[0].needsClassification=true;
 (f.controls[0] as any).classificationBinding={truncated:false,nodes:[{attributes:{'data-mode':'A'}}]};
 expect(await reviewNext(f.c)).toBe(true);
 expect(f.choose).toHaveBeenCalledExactlyOnceWith('control-classification',expect.any(String),expect.objectContaining({observationId:'o',control:f.controls[0],actions:[f.actions[0]]}),expect.anything(),expect.anything());
 expect(f.c.apply).toHaveBeenCalledWith(expect.any(Array),expect.objectContaining({type:'classifyControls',classification:expect.objectContaining({classifications:[expect.objectContaining({localId:'target'})]})}));
 expect(f.c.programApply).not.toHaveBeenCalled();expect(f.o.context).toEqual({mode:{status:'known',value:'A'}});expect(f.o.controls).toHaveLength(3);
});

it('only yields selected navigation after fresh permission and retains unrelated control gaps',async()=>{
 const f=fixture();f.classifications.controls[2].needsClassification=true;f.operations.controls[1].needsReview=true;
 (f.controls[2] as any).hypothesisId='pending-other';f.hypotheses.push({id:'pending-other',status:'pending'});
 f.c.hasPendingAction=vi.fn((filter,fresh)=>{expect(fresh).toBe(true);expect(filter?.(f.actions[0])).toBe(true);expect(filter?.(f.actions[2])).toBe(false);return true;});
 expect(await reviewNext(f.c)).toBe(false);expect(f.c.hasPendingAction).toHaveBeenCalledTimes(1);
 expect(f.c.gap).toHaveBeenCalledWith('classification_unresolved',expect.objectContaining({label:'other'}),true,[]);
 expect(f.c.gap).toHaveBeenCalledWith('operation_basis_unconfirmed',expect.objectContaining({label:'peer'}),true,[]);
 expect(f.c.gap).toHaveBeenCalledWith('identity_unresolved',expect.objectContaining({label:'other'}),true,[]);
 expect(f.c.task.rounds[0].reviewed).toEqual([]);expect(f.c.programApply).not.toHaveBeenCalled();expect(f.choose).not.toHaveBeenCalled();
});

it('keeps the scheduling quota gate even when the selected child is permitted',async()=>{
 const f=fixture();f.c.allowLocalActionYield=false;f.c.hasPendingAction=vi.fn(()=>true);f.classifications.controls[0].needsClassification=true;
 expect(await reviewNext(f.c)).toBe(true);expect(f.c.hasPendingAction).not.toHaveBeenCalled();expect(f.choose.mock.calls[0][0]).toBe('control-classification');
});

it.each(['stale','duplicate','outside-boundary','excluded'] as const)('ignores %s priority hints without changing normal review authority',async kind=>{
 const f=fixture();f.exploration.groups=[f.group('selected',['target','peer'])];
 if(kind==='stale')f.actions[0].observationId='older';
 if(kind==='duplicate')f.actions.push({...f.actions[0]});
 if(kind==='outside-boundary'){f.o.boundaries=[{key:'modal',name:'Modal'}];f.actions[2].boundary={key:'modal'};}
 if(kind==='excluded')f.c.task.plan.push({id:'excluded',required:false,reason:'user_excluded',status:'excluded',scope:{url:f.o.url,label:'target',kind:'click'},prerequisites:[]} as any);
 expect(await reviewNext(f.c)).toBe(true);expect(f.c.retain).not.toHaveBeenCalled();
 expect(f.c.programApply).toHaveBeenCalledWith(expect.objectContaining({type:'reviewRegions'}),'observed_region_partition');
});

it('falls back to normal review without rereading unchanged full materials when target remains blocked',async()=>{
 const f=fixture();expect(await reviewNext(f.c)).toBe(true);
 expect(f.c.programApply).toHaveBeenCalledWith(expect.objectContaining({type:'reviewRegions',review:expect.objectContaining({regions:[expect.objectContaining({controlIds:['other'],pageTraversal:true})]})}),'observed_region_partition');
 expect(f.host.regionReviewMaterial).toHaveBeenCalledTimes(1);expect(f.host.explorationReviewMaterial).toHaveBeenCalledTimes(1);expect(f.host.controlClassificationMaterial).toHaveBeenCalledTimes(1);expect(f.host.controlReviewMaterial).toHaveBeenCalledTimes(1);
 expect(f.c.hasPendingAction).not.toHaveReturnedWith(true);expect(f.c.task.plan[0].status).toBe('pending');
});

it('propagates stale SDK review rejection without falling through to unrelated review or granting work',async()=>{
 const f=fixture();f.classifications.controls[0].needsClassification=true;f.c.apply=vi.fn(async()=>{throw Object.assign(new Error('capture changed'),{code:'STALE_DECISION'});});
 await expect(reviewNext(f.c)).rejects.toMatchObject({code:'STALE_DECISION'});expect(f.c.programApply).not.toHaveBeenCalled();expect(f.c.task.plan[0].status).toBe('pending');
});


it('reviews relevant finite classification before yielding a selected child that can change its source conditions',async()=>{
 const f=fixture();f.o.coveragePolicy='finite-ui-v1';f.regions.unassignedControlIds=[];f.regions.unassignedPageTraversal=false;
 f.classifications.controls[2].needsClassification=true;f.c.hasPendingAction=vi.fn(()=>true);
 expect(await reviewNext(f.c)).toBe(true);expect(f.choose).toHaveBeenCalledWith('control-classification',expect.any(String),expect.objectContaining({control:f.controls[2]}),expect.anything(),expect.anything());
 expect(f.c.hasPendingAction).not.toHaveBeenCalled();
 f.classifications.controls[2].needsClassification=false;expect(await reviewNext(f.c)).toBe(false);expect(f.c.hasPendingAction).toHaveBeenCalled();
});
