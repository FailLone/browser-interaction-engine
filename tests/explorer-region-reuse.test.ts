import {expect,it,vi} from 'vitest';
import {MemoryStore} from '@interaction/storage-memory';
import {RegionReviews} from '../packages/browser/src/region-reviews.js';
import {RegionReuse} from '../packages/browser/src/region-reuse.js';
import {reviewNext,type ReviewContext} from '../packages/explorer-plugin/src/reviews.js';

function scene(document='doc',count=2):any {
  const controls=Array.from({length:count},(_,i)=>({localId:`${document}:c${i}`,instanceId:`${document}:c${i}`,name:`Field ${i}`,label:'',tag:'input',role:'textbox',region:'main',visible:true,editable:true,actions:['fill'],rect:{x:0,y:0,width:10,height:10}}));
  return {id:`${document}:observation`,sessionId:'session',instanceScope:document,url:'https://fixture.test/',context:{},gaps:[],stable:true,controls,regions:[],boundaries:[],regionCandidates:controls.map((c:any,i:number)=>({id:`${document}:r${i}`,label:`Section ${i}`,basis:'heading',controlIds:[c.localId],binding:{tag:'section',control:c.localId},reuseBinding:{version:'region-structure-reuse/v2',anchor:`section-${i}`,members:[{name:c.name}]}}))};
}
function fixture(count=2){
  const store=new MemoryStore(),emit=vi.fn(),regions=new RegionReviews(store,emit);let o=scene('first',count),decisions=0;
  const session:any={id:o.sessionId,options:{executionPolicy:'interface-only',regionExploration:'review'}};
  const actions=()=>o.controls.map((c:any)=>({id:`action:${c.localId}`,sessionId:o.sessionId,observationId:o.id,localId:c.localId,kind:'fill',label:c.name,preconditions:{visible:true}}));
  const host:any={session:()=>session,actions,regionReviewMaterial:()=>regions.material(o,actions(),session),explorationReviewMaterial:()=>({groups:[]}),list:()=>[],discoveryScanMaterial:()=>({}),controlClassificationMaterial:()=>({controls:[]}),controlReviewMaterial:()=>({controls:[]})};
  const task:any={id:'task',goal:'Explore fields',revision:1,coverageMode:'all',sessionOptions:{executionPolicy:'interface-only'},usage:{actions:0,modelRequests:0},plan:[{id:'scope',required:true,dispatchScope:true,scope:{url:o.url},prerequisites:[],status:'pending'}],rounds:[{sessionId:o.sessionId,reviewed:[],entryPath:[]}]};
  const choose=vi.fn(async()=>({value:'include',decision:{id:`decision-${++decisions}`,actor:'jev'}}));
  const apply=vi.fn(async(_decision:any,command:any)=>{regions.record(o,actions(),session,command.review);});
  const programApply=vi.fn(async(command:any)=>{regions.acceptReuse(o,actions(),session,command.review);});
  const c={host,task,observation:o,choose,apply,programApply,gap:vi.fn(),hasPendingAction:()=>false} as unknown as ReviewContext;
  store.put('observation',o);
  return {c,store,regions,emit,session,choose,apply,programApply,actions,move(document='next'){o=scene(document,count);store.put('observation',o);c.observation=o;regions.reconcile(o);return o;}};
}

it('registers only fresh include evidence and reuses both verified regions in one command without mode, plan, budget or coverage changes',async()=>{
  const f=fixture(),before=structuredClone(f.c.task);
  await reviewNext(f.c);expect(f.choose).toHaveBeenCalledTimes(2);
  const source=f.store.list<any>('region-review','session')[0];expect(source.regions.every((r:any)=>r.reuse&&r.reuseConditions)).toBe(true);
  expect(source.evidence).toEqual(['explorer-decision:decision-1','explorer-decision:decision-2']);
  f.move();expect(f.c.host.regionReviewMaterial('session').reuseCandidates).toHaveLength(2);
  await reviewNext(f.c);expect(f.choose).toHaveBeenCalledTimes(2);expect(f.programApply).toHaveBeenCalledTimes(1);
  const [command,reason,details]=f.programApply.mock.calls[0] as any;
  expect(command).toMatchObject({type:'reuseRegionReviews',review:{observationId:'next:observation',baseReviewId:source.id,regions:expect.arrayContaining([expect.objectContaining({reviewId:source.id})])}});
  expect(command.review.regions).toHaveLength(2);expect(reason).toBe('region_reused');expect(details).toMatchObject({executionAuthorized:false,coverageGranted:false,currentExecution:false});
  expect(f.c.task.plan).toEqual(before.plan);expect(f.c.task.usage).toEqual(before.usage);expect(f.session.options.executionPolicy).toBe('interface-only');
  expect(f.store.list('attempt','session')).toEqual([]);expect(f.store.list('exploration-group','session')).toEqual([]);
  expect(f.regions.current('session')!.regions.every(r=>r.reusedFrom?.reviewId===source.id)).toBe(true);
});

it('does not retrofit old no-opt-in region reviews into authority',async()=>{
  const f=fixture(),o=f.c.observation;
  f.regions.record(o,f.actions(),f.session,{observationId:o.id,source:'old-caller',evidence:['historical grouping'],regions:o.regionCandidates!.map(c=>({key:c.id,label:c.label,candidateIds:[c.id]}))});
  f.move();expect(f.c.host.regionReviewMaterial('session').reuseCandidates).toEqual([]);
  await reviewNext(f.c);expect(f.choose).toHaveBeenCalledTimes(2);expect(f.programApply).not.toHaveBeenCalled();
});

it.each(['goal','scope','rules','excluded'] as const)('does not reuse a prior task business scope after %s changes',async change=>{
  const f=fixture();await reviewNext(f.c);f.move();
  if(change==='goal')f.c.task.goal='Different task';
  if(change==='scope')f.c.task.plan[0].scope={url:f.c.observation.url,label:'Field 0'};
  if(change==='rules')f.c.task.sessionOptions.exclude=[{name:'Other'}];
  if(change==='excluded')f.c.task.plan.push({...f.c.task.plan[0],id:'excluded',required:false,status:'excluded',scope:{label:'Unrelated'}});
  await reviewNext(f.c);expect(f.programApply).not.toHaveBeenCalled();expect(f.choose.mock.calls.length).toBeGreaterThan(2);
});

it('keeps reusable scope stable across incidental revision and non-authority plan growth',async()=>{
  const f=fixture();await reviewNext(f.c);f.move();f.c.task.revision++;
  f.c.task.plan.push({...f.c.task.plan[0],id:'child',dispatchScope:false,status:'unresolved',reason:'operation_basis_unconfirmed'});
  await reviewNext(f.c);expect(f.programApply).toHaveBeenCalledTimes(1);expect(f.choose).toHaveBeenCalledTimes(2);
});

it.each(['critical','context','boundary','incomplete','ambiguous'] as const)('does not register reusable authority with %s evidence',async change=>{
  const f=fixture(),o=f.c.observation;
  if(change==='critical')o.gaps.push({code:'missing',critical:true,message:'missing'});
  if(change==='context')o.context={account:{status:'unknown',value:null,source:'fixture'}};
  if(change==='boundary')o.boundaries=[{key:'active',name:'Modal',region:'dialog',evidence:[]}];
  if(change==='incomplete')o.regionCandidates!.forEach(c=>delete c.reuseBinding);
  if(change==='ambiguous')o.regionCandidates![1].reuseBinding=o.regionCandidates![0].reuseBinding;
  f.c.apply=vi.fn(async()=>{});await reviewNext(f.c);
  const command=vi.mocked(f.c.apply).mock.calls[0][1] as any;
  expect(command.review.regions.every((r:any)=>!r.reuse)).toBe(true);expect(f.programApply).not.toHaveBeenCalled();
});

it('keeps capacity debt instead of requesting or reusing a 501st region',async()=>{
  const f=fixture();await reviewNext(f.c);f.move();const m=f.c.host.regionReviewMaterial('session');
  m.delta!.canUpdate=true;m.review!.regions=Array.from({length:500},(_,i)=>({key:`kept-${i}`,label:'Kept',anchors:[],status:'invalidated',controlIds:[],pageTraversal:false}));
  f.c.host.regionReviewMaterial=()=>m;expect(await reviewNext(f.c)).toBe(false);
  expect(f.programApply).not.toHaveBeenCalled();expect(f.choose).toHaveBeenCalledTimes(2);expect(f.c.gap).toHaveBeenCalledTimes(2);expect(m.review!.regions).toHaveLength(500);
  expect(await reviewNext(f.c)).toBe(false);expect(f.c.gap).toHaveBeenCalledTimes(2);
});

it('rechecks SDK authority and propagates stale rejection without fabricating a model or success',async()=>{
  const f=fixture();await reviewNext(f.c);f.move();const records=structuredClone(f.store.list('region-review','session'));
  f.programApply.mockRejectedValueOnce(Object.assign(new Error('stale'),{code:'STALE_REGION_REVIEW'}));
  await expect(reviewNext(f.c)).rejects.toMatchObject({code:'STALE_REGION_REVIEW'});
  expect(f.store.list('region-review','session')).toEqual(records);expect(f.choose).toHaveBeenCalledTimes(2);expect(f.c.task.plan[0].status).toBe('pending');
});

it('withdraws reused descendants when original authority is revoked',async()=>{
  const f=fixture();await reviewNext(f.c);const source=f.regions.current('session')!;f.move();await reviewNext(f.c);
  f.regions.revokeReuse(f.c.observation,{reviewId:source.id,regionKey:source.regions[0].key,source:'user',reason:'withdraw'});
  expect(f.regions.current('session')!.regions.find(r=>r.key===source.regions[0].key)?.status).toBe('invalidated');
  f.move('third');expect(f.c.host.regionReviewMaterial('session').reuseCandidates!.every(r=>r.regionKey!==source.regions[0].key)).toBe(true);
});

it('does not manufacture uniqueness by discarding an ambiguous source anchor',()=>{
  const f=fixture(),o=f.c.observation;o.regionCandidates![1].reuseBinding=o.regionCandidates![0].reuseBinding;
  const reuse=new RegionReuse(f.store,()=>{});expect(reuse.conditions(o,[o.regionCandidates![0].id],[o.controls[0].localId],false)).toBeUndefined();
  expect(()=>f.regions.record(o,f.actions(),f.session,{observationId:o.id,source:'reviewer',evidence:['include'],regions:[{key:'ambiguous',label:'First',candidateIds:[o.regionCandidates![0].id],reuse:{binding:'same-url-context',businessScope:'scope'}}]})).toThrowError(expect.objectContaining({code:'INVALID_REGION_REUSE'}));
  expect(f.store.list('region-review','session')).toEqual([]);
});

it('does not reinterpret an opted-in old v1 binding as a new v2 proof',async()=>{
  const f=fixture();f.c.observation.regionCandidates!.forEach(c=>(c.reuseBinding as any).version='region-structure-reuse/v1');await reviewNext(f.c);f.move();
  expect(f.c.host.regionReviewMaterial('session').reuseCandidates).toEqual([]);await reviewNext(f.c);expect(f.choose).toHaveBeenCalledTimes(4);
});

it.each(['ambiguous','missing','critical','unknown-context'])('rejects a legacy opted-in source whose retained evidence is %s',async change=>{
  const f=fixture(1);await reviewNext(f.c);const record=f.regions.current('session')!;record.regions[0].reuseConditions!.version='region-review-reuse/v1';f.store.put('region-review',record);
  const original=structuredClone(f.c.observation);
  if(change==='ambiguous')original.regionCandidates!.push({...original.regionCandidates![0],id:'rival',controlIds:['rival-control']});
  if(change==='critical')original.gaps.push({code:'missing',critical:true,message:'missing'});
  if(change==='unknown-context')original.context={account:{status:'unknown',value:null,source:'fixture'}};
  f.move();const get=f.store.get.bind(f.store);vi.spyOn(f.store,'get').mockImplementation((kind,id)=>kind==='observation'&&id===original.id?(change==='missing'?undefined:original) as any:get(kind,id));
  expect(f.c.host.regionReviewMaterial('session').reuseCandidates).toEqual([]);expect(f.programApply).not.toHaveBeenCalled();
});

it('reads a legacy source once per mapping request and never adds historical observation reads to steady v2 material',async()=>{
  const f=fixture();await reviewNext(f.c);const record=f.regions.current('session')!;
  const get=vi.spyOn(f.store,'get');get.mockClear();
  f.c.host.regionReviewMaterial('session');expect(get.mock.calls.filter(([kind])=>kind==='observation')).toEqual([]);
  record.regions.forEach(r=>r.reuseConditions!.version='region-review-reuse/v1');f.store.put('region-review',record);
  f.move();get.mockClear();expect(f.c.host.regionReviewMaterial('session').reuseCandidates).toHaveLength(2);
  expect(get.mock.calls.filter(([kind])=>kind==='observation')).toEqual([['observation',record.observationId]]);
  await reviewNext(f.c);get.mockClear();f.c.host.regionReviewMaterial('session');
  expect(get.mock.calls.filter(([kind])=>kind==='observation')).toEqual([]);
});

it('deduplicates historical candidate keys and overlaps before filling the 500th partition slot',async()=>{
  const f=fixture();await reviewNext(f.c);f.move();const m=f.c.host.regionReviewMaterial('session'),first=m.reuseCandidates![0];
  m.delta!.canUpdate=true;m.review!.regions=Array.from({length:499},(_,i)=>({key:`kept-${i}`,label:'Kept',anchors:[],status:'invalidated',controlIds:[],pageTraversal:false}));
  m.reuseCandidates=[first,{...first,reviewId:'duplicate-source'},m.reuseCandidates![1]];f.c.host.regionReviewMaterial=()=>m;f.c.programApply=vi.fn(async()=>{});
  await reviewNext(f.c);const command=vi.mocked(f.c.programApply).mock.calls[0][0] as any;
  expect(command.review.regions).toHaveLength(1);expect(command.review.regions[0]).toMatchObject({reviewId:first.reviewId,regionKey:first.regionKey});expect(f.choose).toHaveBeenCalledTimes(2);
});

it('fails closed on an unsupported stored reuse condition version',async()=>{
  const f=fixture();await reviewNext(f.c);const record=f.regions.current('session')!;(record.regions[0].reuseConditions as any).version='future-unverified';f.store.put('region-review',record);
  f.move();expect(f.c.host.regionReviewMaterial('session').reuseCandidates!.some(r=>r.regionKey===record.regions[0].key)).toBe(false);
});
