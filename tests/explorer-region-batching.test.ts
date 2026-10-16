import { expect, it, vi } from 'vitest';
import { reviewNext, type ReviewContext } from '../packages/explorer-plugin/src/reviews.js';
import { explorerFixture } from './explorer-plugin-helpers.js';

function fixture(count: number) {
  const controls = Array.from({length:count},(_,i)=>({localId:`c${i}`,instanceId:`c${i}`,name:`Field ${i}`,tag:'input',role:'textbox',region:'main',visible:true,editable:true,rect:{x:0,y:0,width:10,height:10}}));
  const observation={id:'o',sessionId:'s',instanceScope:'document',url:'https://fixture.test/',context:{},controls,regions:[],boundaries:[]};
  const material:any={enabled:true,unassignedControlIds:controls.map(c=>c.localId),unassignedPageTraversal:true,candidates:controls.map((c,i)=>({id:`r${i}`,label:`Section ${i}`,basis:'heading',controlIds:[c.localId],binding:{tag:'section'}})),controls};
  const programApply=vi.fn(async(_command:any,_reason:string)=>{}),gap=vi.fn(),choose=vi.fn();
  const c={observation,task:{revision:1,coverageMode:'all',plan:[{required:true,dispatchScope:true,scope:{url:observation.url},prerequisites:[],status:'pending'}],rounds:[{reviewed:[],entryPath:[]}]},host:{session:()=>({options:{executionPolicy:'observed-ui'}}),actions:()=>[],regionReviewMaterial:()=>material,explorationReviewMaterial:()=>({groups:[]}),list:()=>[],discoveryScanMaterial:()=>({}),controlClassificationMaterial:()=>({controls:[]}),controlReviewMaterial:()=>({controls:[]})},choose,programApply,gap,hasPendingAction:()=>false} as unknown as ReviewContext;
  return {c,material,programApply,gap,choose};
}
const kept=(key:string,status='active')=>({key,label:key,status,anchors:[{id:key}],controlIds:[`control:${key}`],pageTraversal:false});

it('groups all disjoint current regions in one guarded command without models or task-scope changes',async()=>{
  const {c,programApply,choose}=fixture(31),plan=structuredClone(c.task.plan);
  expect(await reviewNext(c)).toBe(true);
  expect(programApply).toHaveBeenCalledTimes(1);expect(choose).not.toHaveBeenCalled();
  const {review}=programApply.mock.calls[0][0];
  expect(review.observationId).toBe('o');expect(review.regions).toHaveLength(31);
  expect(new Set(review.regions.flatMap((r:any)=>r.controlIds)).size).toBe(31);
  expect(review.regions.filter((r:any)=>r.pageTraversal)).toHaveLength(1);
  expect(c.task.plan).toEqual(plan);
});

it('deduplicates overlapping candidates and leaves unrelated task controls outside new grouping',async()=>{
  const {c,material,programApply}=fixture(3);
  c.task.plan[0].scope={url:c.observation.url,label:'Field 0'};
  material.candidates.unshift({...material.candidates[0],id:'overlap'});
  await reviewNext(c);const {review}=programApply.mock.calls[0][0];
  expect(review.regions).toHaveLength(1);expect(review.regions[0].controlIds).toEqual(['c0']);
});

it('uses the existing incremental contract so unchanged region decisions are not resubmitted',async()=>{
  const {c,material,programApply}=fixture(12);
  material.review={id:'previous',regions:[kept('retained')],rejectedCandidateIds:[]};material.delta={canUpdate:true};
  await reviewNext(c);const {review}=programApply.mock.calls[0][0];
  expect(review.update).toEqual({baseReviewId:'previous'});expect(review.regions).toHaveLength(12);
  expect(review.regions.some((r:any)=>r.key==='retained')).toBe(false);
});

it.each([false,true])('respects the SDK final partition limit with incremental=%s and retains uncovered controls as gaps',async incremental=>{
  const {c,material,programApply,gap}=fixture(3);
  material.review={id:'previous',regions:Array.from({length:499},(_,i)=>kept(`retained${i}`)),rejectedCandidateIds:[]};material.delta={canUpdate:incremental};
  await reviewNext(c);const {review}=programApply.mock.calls[0][0];
  expect(review.regions).toHaveLength(incremental?1:500);
  expect(gap.mock.calls.map(([reason,scope])=>[reason,scope.label])).toEqual([['region_partition_capacity','Field 1'],['region_partition_capacity','Field 2']]);
  expect(c.task.plan[0].status).toBe('pending');
});

it('counts retained invalidated regions, but lets a same-key replacement fit at capacity',async()=>{
  const {c,material,programApply,gap}=fixture(2);
  material.review={id:'previous',regions:[...Array.from({length:499},(_,i)=>kept(`retained${i}`,'invalidated')),kept('explorer:r0','invalidated')],rejectedCandidateIds:[]};material.delta={canUpdate:true};
  await reviewNext(c);const {review}=programApply.mock.calls[0][0];
  expect(review.regions).toHaveLength(1);expect(review.regions[0].key).toBe('explorer:r0');
  expect(gap).toHaveBeenCalledWith('region_partition_capacity',expect.objectContaining({label:'Field 1'}));
});

it('does not recapture or discard an existing partition when no capacity remains',async()=>{
  const {c,material,programApply,gap}=fixture(2);
  material.review={id:'previous',regions:Array.from({length:500},(_,i)=>kept(`retained${i}`)),rejectedCandidateIds:[]};material.delta={canUpdate:true};
  expect(await reviewNext(c)).toBe(false);expect(programApply).not.toHaveBeenCalled();
  expect(gap).toHaveBeenCalledTimes(2);expect(material.review.regions).toHaveLength(500);
  expect(await reviewNext(c)).toBe(false);expect(gap).toHaveBeenCalledTimes(2);
});

it('keeps rejection of stale observation material in the single guarded submission path',async()=>{
  const {c,programApply}=fixture(12);
  programApply.mockRejectedValueOnce(Object.assign(new Error('changed'),{code:'STALE_REGION_REVIEW'}));
  await expect(reviewNext(c)).rejects.toMatchObject({code:'STALE_REGION_REVIEW'});
  expect(programApply).toHaveBeenCalledTimes(1);expect(c.task.plan[0].status).toBe('pending');
});

it('validates twelve local browser regions with one SDK recapture, retaining all members and no execution evidence',async()=>{
  const f=await explorerFixture('<script>document.querySelector("h1").remove()</script>'+Array.from({length:12},(_,i)=>`<div><div><section><h2>Section ${i}</h2><input aria-label="Field ${i}"></section></div></div>`).join(''));
  try{
    const s=await f.host.createSession({url:f.url,headless:true,contextRules:[],executionPolicy:'observed-ui',regionExploration:'review',settleMs:0,observeTimeoutMs:300});
    const observation=f.host.observation(s.id),before=f.host.list(s.id,'observation').length;
    const {c,choose}=fixture(0);c.host=f.host;c.observation=observation;c.task.plan[0].scope={url:f.url};
    c.programApply=vi.fn(async(command:any)=>{await f.host.command(s.id,command);});
    expect(await reviewNext(c)).toBe(true);
    expect(c.programApply).toHaveBeenCalledTimes(1);expect(choose).not.toHaveBeenCalled();
    expect(f.host.list(s.id,'observation')).toHaveLength(before+1);
    const material=f.host.regionReviewMaterial(s.id);
    expect(material.review!.regions.filter(r=>r.status==='active')).toHaveLength(12);
    expect(material.unassignedControlIds).toEqual([]);
    expect(new Set(material.review!.regions.flatMap(r=>r.controlIds)).size).toBe(12);
    expect(f.host.list(s.id,'attempt')).toEqual([]);
  }finally{await f.close();}
});
