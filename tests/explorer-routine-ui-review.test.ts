import {expect,it,vi} from 'vitest';
import {reviewNext,type ReviewContext} from '../packages/explorer-plugin/src/reviews.js';

function context(mode:'ordinary'|'unsupported'|'probe-required'|'regions'|'identity'|'discovery'|'boundary'|'classification'|'legacy'='ordinary'){
 const target={localId:'target',instanceId:'target',name:'Clear',tag:'i',role:'button',region:'main',visible:true,editable:false,rect:{x:0,y:0,width:20,height:20},reviewBinding:{parentInstanceId:'suffix',attributes:{role:'button'}},actionBasis:mode==='unsupported'||mode==='probe-required'||mode==='classification'?{}:{click:{status:'supported',evidence:[{source:'aria',rule:'declared-activation/v1',facts:{implementation:'unverified'}}]}},...(mode==='identity'?{hypothesisId:'hypothesis'}:{})};
 const o={id:'o',sessionId:'s',instanceScope:'doc',url:'https://fixture.test/',context:{},controls:[target],regions:[],boundaries:mode==='boundary'?[{key:'modal',name:'Modal'}]:[],overlays:[]};
 const action={id:'action',sessionId:'s',observationId:'o',localId:'target',label:'Clear',kind:'click',risk:'unknown',basis:{status:'supported',evidence:[]}};
 const ordinary=mode==='ordinary',actions=ordinary?[action]:[];
 const item={control:target,actions,reviews:[],needsReview:['unsupported','probe-required','legacy'].includes(mode)};
 const classification={control:target,actions,classifications:mode==='probe-required'?[{status:'active',classification:'probe_required'}]:[],needsClassification:mode==='classification'};
 const decision={id:'decision',actor:'jev'},choose=vi.fn(async(_purpose:string,..._args:unknown[])=>({value:'interaction',decision})),assess=vi.fn(async()=>({values:{interface_click:false,external_click:false},decision})),clarify=vi.fn(async()=>({value:'uncertain',decision})),apply=vi.fn(async()=>{}),programApply=vi.fn(async(_command:unknown,_reason:string)=>{}),gap=vi.fn();
 const regions={enabled:mode==='regions',unassignedControlIds:['target'],unassignedPageTraversal:true,candidates:[{id:'main-candidate',basis:'semantic',label:'Main',controlIds:['target'],binding:{tag:'main'}}],controls:[target]};
 const classifications={controls:[classification]},operations={controls:[item]};
 const host={session:()=>({options:{executionPolicy:mode==='legacy'?'default':'observed-ui'}}),actions:()=>actions,regionReviewMaterial:()=>regions,explorationReviewMaterial:()=>({groups:[]}),controlClassificationMaterial:()=>classifications,controlReviewMaterial:()=>operations,controlInterpretationSnapshot:()=>({classifications,operations}),list:(_sid:string,kind:string)=>mode==='identity'&&kind==='hypothesis'?[{id:'hypothesis',status:'pending',provisionalIdentityId:'new-independent',revisions:[]}]:[],discoveryScanMaterial:()=>mode==='discovery'?{discovery:{topologyKey:'tree',signal:{omitted:1},structural:{omittedLocations:0},targets:[{id:'bounded-target'}]}}:{}};
 const c={observation:o,task:{revision:1,coverageMode:'all',plan:[{required:true,dispatchScope:true,scope:{url:o.url},prerequisites:[],status:'pending'}],rounds:[{reviewed:[],entryPath:[]}]},host,choose,assess,clarify,apply,programApply,refresh:vi.fn(async()=>false),probe:vi.fn(async()=>{}),gap,hasPendingAction:()=>ordinary} as unknown as ReviewContext;
 return {c,choose,assess,clarify,apply,programApply,gap,host,item};
}
it('yields to supported ordinary SDK work without asking a model to certify its purpose or outcome',async()=>{
 const {c,choose,assess,clarify,apply,programApply}=context();expect(await reviewNext(c)).toBe(false);
 expect(choose).not.toHaveBeenCalled();expect(assess).not.toHaveBeenCalled();expect(clarify).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();expect(programApply).not.toHaveBeenCalled();expect(c.task.plan[0].status).toBe('pending');
});
it('partitions captured regions deterministically without changing scope or inventing a model decision',async()=>{
 const {c,choose,programApply}=context('regions');expect(await reviewNext(c)).toBe(true);expect(choose).not.toHaveBeenCalled();
 expect(programApply).toHaveBeenCalledWith({type:'reviewRegions',review:{observationId:'o',source:'explorer-program',evidence:['observation:o'],regions:[{key:'explorer:main-candidate',label:'Main',candidateIds:['main-candidate'],controlIds:['target'],pageTraversal:true}],rejectedCandidateIds:[]}},'observed_region_partition');
 expect(c.task.plan[0].scope).toEqual({url:'https://fixture.test/'});
});
it('keeps a current ambiguous occurrence independent without inheriting historical success or model identity approval',async()=>{
 const {c,choose,programApply}=context('identity');expect(await reviewNext(c)).toBe(true);expect(choose).not.toHaveBeenCalled();
 expect(programApply).toHaveBeenCalledWith(expect.objectContaining({type:'resolveIdentity',identityId:'new-independent',guard:{observationId:'o',revision:0}}),'independent_current_occurrence');expect(c.task.plan[0].status).toBe('pending');
});
it.each(['unsupported','probe-required','boundary'] as const)('preserves %s as a real capability/basis gap instead of requesting a model permit',async mode=>{
 const {c,choose,assess,clarify,apply,programApply,gap}=context(mode);expect(await reviewNext(c)).toBe(false);expect(gap).toHaveBeenCalled();
 expect(choose).not.toHaveBeenCalled();expect(assess).not.toHaveBeenCalled();expect(clarify).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();expect(programApply).not.toHaveBeenCalled();expect(c.probe).not.toHaveBeenCalled();
 if(mode==='probe-required')expect(gap).toHaveBeenCalledWith('missing_capability:bounded_observation',expect.objectContaining({label:'Clear'}));
 if(mode==='unsupported')expect(gap).toHaveBeenCalledWith('operation_basis_unconfirmed',expect.objectContaining({label:'Clear'}));
});
it('supplements a retained SDK discovery target once without model selection',async()=>{
 const {c,choose,programApply}=context('discovery');expect(await reviewNext(c)).toBe(true);expect(choose).not.toHaveBeenCalled();
 expect(programApply).toHaveBeenCalledWith({type:'supplementDiscovery',scan:{observationId:'o',targetId:'bounded-target',source:'explorer-program',evidence:['observation:o'],budget:{elements:1000}}},'bounded_discovery_target');
 expect(await reviewNext(c)).toBe(false);expect(programApply).toHaveBeenCalledTimes(1);
});
it('still asks for classification of an actual weak candidate but never converts that classification into operation permission',async()=>{
 const {c,choose,assess,apply}=context('classification');expect(await reviewNext(c)).toBe(true);expect(choose).toHaveBeenCalledTimes(1);expect(choose.mock.calls[0][0]).toBe('control-classification');expect(assess).not.toHaveBeenCalled();
 expect(apply).toHaveBeenCalledWith(expect.any(Array),expect.objectContaining({type:'classifyControls'}));expect(c.task.plan[0].status).toBe('pending');
});
it('does not silently migrate a legacy session into observed-ui execution semantics',async()=>{
 const {c,assess,programApply}=context('legacy');await reviewNext(c);expect(assess).toHaveBeenCalled();expect(programApply).not.toHaveBeenCalled();
});
it('reports a missing program-review integration instead of falling back to model approvals',async()=>{
 const {c,choose,assess,gap}=context('regions');delete c.programApply;expect(await reviewNext(c)).toBe(false);expect(gap).toHaveBeenCalledWith('missing_capability:program_review',{url:'https://fixture.test/'});expect(choose).not.toHaveBeenCalled();expect(assess).not.toHaveBeenCalled();
});

it.each(['jev','llm','uncertain','unoffered','submission'] as const)('uses %s only to describe a genuinely missing captured operation, retaining unknown effects',async mode=>{
 const {c,item,assess,apply}=context('unsupported');
 item.control.actionBasis={click:{status:'tentative',evidence:[{source:'dom-signal',rule:'click-handler/v1',facts:{implementation:'unverified',...(mode==='submission'?{submitsForm:true}:{})}}]}} as any;
 (item.control as any).classificationBinding={nodes:[{instanceId:'target',parentInstanceId:'suffix',tag:'i',attributes:{onclick:'observed-handler'}}],text:'',truncated:false};
 const decision={id:'operation-decision',actor:'jev'} as any;
 c.choose=vi.fn(async(purpose,instructions,state,options)=>{
  expect(purpose).toBe('control-operation');expect(instructions).toContain('not whether its implementation is interface-only');expect(Object.keys(options)).toEqual(['click','uncertain']);expect((state as any).offeredOperations.click.status).toBe('tentative');
  return {value:mode==='jev'?'click':mode==='unoffered'?'fill':'uncertain',decision};
 });
 c.clarify=vi.fn(async request=>{expect(request).toMatchObject({purpose:'operation-description',operation:false,requiredEvidence:{click:['current','offeredOperations']}});expect(request.instructions).toContain('not a pure-UI risk certificate');return {value:mode==='llm'?'click':'uncertain',decision};});
 await reviewNext(c);expect(assess).not.toHaveBeenCalled();
 if(mode==='jev'||mode==='llm'){
  expect(apply).toHaveBeenCalledWith(expect.any(Array),expect.objectContaining({type:'reviewControls',review:{observationId:'o',source:'explorer-plugin',reviews:[expect.objectContaining({localId:'target',kind:'click',risk:'unknown',replayable:false,reason:'Describe a captured operation on the current instance; effects remain unassessed'})]}}));
 }else expect(apply).not.toHaveBeenCalled();
 if(mode==='submission')expect(c.choose).not.toHaveBeenCalled();
 if(mode==='uncertain'){await reviewNext(c);expect(c.choose).toHaveBeenCalledTimes(1);expect(c.clarify).toHaveBeenCalledTimes(1);}
 expect(c.task.plan[0].status).toBe('pending');
});
it('rejects a stale operation description through the existing guarded apply path',async()=>{
 const {c,item}=context('unsupported');item.control.actionBasis={click:{status:'tentative',evidence:[{source:'dom-signal',rule:'click-handler/v1',facts:{implementation:'unverified'}}]}} as any;
 c.choose=vi.fn(async()=>({value:'click',decision:{id:'old',revision:1} as any}));c.apply=vi.fn(async()=>{throw Object.assign(new Error('observation changed'),{code:'STALE_DECISION'});});
 await expect(reviewNext(c)).rejects.toMatchObject({code:'STALE_DECISION'});expect(c.task.plan[0].status).toBe('pending');
});

it('uses a model only to describe a captured tentative operation and executes it with effects still unassessed',async()=>{
 const {explorerFixture,fakeProviders}=await import('./explorer-plugin-helpers.js');
 const {ExplorerPlugin,ExplorerStore}=await import('@interaction/explorer-plugin');
 const f=await explorerFixture('<div id="custom" tabindex="0" style="cursor:pointer" onclick="this.setAttribute(\'aria-disabled\',\'true\')">Open details</div>'),providers=fakeProviders(f.url),original=providers.jev.decide;
 providers.jev.decide=async(request,signal)=>request.purpose==='control-classification'?{model:'test',value:'interaction',confidence:1}:request.purpose==='control-operation'?{model:'test',value:'click',confidence:1}:original(request,signal);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers);
 try{
  const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1,actions:2}});
  plugin.revise(task.id,{items:[{title:'Current custom control',scope:{url:f.url,label:'Open details',kind:'click'},prerequisites:[],completion:'Dispatch the current captured operation and retain the subsequent observation',required:true,reason:'test scope'}]});
  plugin.start(task.id);await plugin.waitForIdle();const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
  expect(attempts).toHaveLength(1);expect(attempts[0]).toMatchObject({status:'succeeded',effectsAssessment:'not-assessed',executionProfile:'observed-ui-exploration',action:{kind:'click',risk:'unknown',replayable:false}});
  expect(f.host.list<any>(sid,'control-review')).toEqual(expect.arrayContaining([expect.objectContaining({kind:'click',risk:'unknown',replayable:false})]));
  expect(view.decisions.some(d=>d.purpose==='control-operation')).toBe(true);expect(view.decisions.some(d=>['control-risk','probe-risk','list-purpose','purpose-description','operation-clarification'].includes(d.purpose))).toBe(false);
 }finally{await plugin.close();await f.close();}
});

it('uses SDK bounded observation availability without model risk certification and never counts it as execution coverage',async()=>{
 const {c,choose,assess,apply}=context('probe-required');
 c.host.probeAvailability=vi.fn((_sid,_observationId,_localId,kind)=>({kind,executable:kind==='focus',blockers:kind==='focus'?[]:[{code:'ACTION_BLOCKED',reason:'not_available',evidence:[]}]} as any));
 c.programProbe=vi.fn(async()=>{});
 expect(await reviewNext(c)).toBe(true);expect(c.programProbe).toHaveBeenCalledWith('target','focus','sdk_bounded_observation');
 expect(choose).not.toHaveBeenCalled();expect(assess).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();expect(c.task.plan[0].status).toBe('pending');
 expect(await reviewNext(c)).toBe(false);expect(c.programProbe).toHaveBeenCalledTimes(1);
});
it('retains bounded observation blockers rather than using models to override unknown results or identity',async()=>{
 const {c,assess,gap}=context('probe-required');
 c.host.probeAvailability=vi.fn((_sid,_observationId,_localId,kind)=>({kind,executable:false,blockers:[{code:'ACTION_BLOCKED',reason:'frontier_unknown',evidence:['attempt']}]} as any));
 c.programProbe=vi.fn(async()=>{});expect(await reviewNext(c)).toBe(false);
 expect(c.programProbe).not.toHaveBeenCalled();expect(assess).not.toHaveBeenCalled();expect(gap).toHaveBeenCalledWith('probe_blocked:frontier_unknown',expect.any(Object));
});
it.each(['observed-ui','interface-only'] as const)('generates content for a supported constrained field without risk certification under %s',async executionPolicy=>{
 const {c,item,choose,assess}=context('ordinary');c.hasPendingAction=()=>false;
 c.host.session=(()=>({options:{executionPolicy}})) as any;
 const action=c.host.actions('s')[0];Object.assign(action,{kind:'fill',risk:'interface',value:'example',excluded:true,exclusionReason:'input_sample_required'});
 Object.assign(item.control,{constraints:{type:'text',pattern:'[A-Z]{3}'},actionBasis:{fill:action.basis}});
 c.generate=vi.fn(async(purpose,_instructions,state)=>{expect(purpose).toBe('input-samples');expect((state as any).constraints.pattern).toBe('[A-Z]{3}');return {value:{samples:['ABC']},decision:{id:'input',actor:'llm'} as any};}) as any;
 expect(await reviewNext(c)).toBe(true);expect(choose).not.toHaveBeenCalled();expect(assess).not.toHaveBeenCalled();
 expect(c.apply).toHaveBeenCalledWith(expect.objectContaining({id:'input'}),expect.objectContaining({type:'reviewControls',review:{observationId:'o',source:'explorer-input-samples',reviews:[expect.objectContaining({kind:'fill',risk:'interface',replayable:false,samples:['ABC']})]}}));
 await reviewNext(c);expect(c.generate).toHaveBeenCalledTimes(1);expect(c.task.plan[0].status).toBe('pending');
});
it.each(['ABC','invalid'])('validates generated sample %s for a pattern-constrained native field at actual dispatch',async sample=>{
 const {explorerFixture,fakeProviders}=await import('./explorer-plugin-helpers.js');
 const {ExplorerPlugin,ExplorerStore}=await import('@interaction/explorer-plugin');
 const f=await explorerFixture('<input aria-label="Code" pattern="[A-Z]{3}">'),providers=fakeProviders(f.url),original=providers.llm.decide;
 providers.llm.decide=async(request,signal)=>request.purpose==='input-samples'?{model:'test',value:{samples:[sample]},confidence:1}:original(request,signal);
 const plugin=new ExplorerPlugin(f.host,new ExplorerStore(':memory:'),providers);
 try{
  const task=plugin.create({url:f.url,sessionOptions:{settleMs:0,observeTimeoutMs:300},budget:{rounds:1,actions:1}});
  plugin.revise(task.id,{items:[{title:'Current field',scope:{url:f.url,label:'Code',kind:'fill'},prerequisites:[],completion:'Explore the supported fill',required:true,reason:'test scope'}]});
  plugin.start(task.id);await plugin.waitForIdle();const view=plugin.view(task.id),sid=view.task.rounds[0].sessionId,attempts=f.host.list<any>(sid,'attempt');
  if(sample==='ABC'){
   expect(attempts).toHaveLength(1);expect(attempts[0]).toMatchObject({status:'succeeded',action:{kind:'fill',value:'ABC',risk:'interface',replayable:false}});
   expect(f.host.observation(sid).controls.find(c=>c.name==='Code')?.value).toBe('ABC');
  }else{
   expect(attempts.some(a=>a.status==='succeeded')).toBe(false);expect(f.host.observation(sid).controls.find(c=>c.name==='Code')?.value).toBe('');
   expect(view.task.plan.some(i=>i.status==='unresolved')).toBe(true);
  }
  expect(view.decisions.filter(d=>d.purpose==='input-samples')).toHaveLength(1);expect(view.decisions.some(d=>['control-risk','probe-risk','control-operation'].includes(d.purpose))).toBe(false);
 }finally{await plugin.close();await f.close();}
});
