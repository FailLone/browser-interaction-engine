import { describe, expect, it, vi } from 'vitest';
import type { Observation } from '@interaction/browser';
import type { ExplorerHost, PlanItem, Task } from '@interaction/explorer-plugin';
import { reviewGapChanges, reviewGapRetractions } from '../packages/explorer-plugin/src/review-ledger.js';
import { scopeForControl } from '../packages/explorer-plugin/src/policy.js';

const sid='session',url='https://review-ledger.fixture.invalid/';
const ref=(observationId:string)=>({sessionId:sid,observationId});
const observed=(id:string,condition='A',visible=true)=>({
  id,sessionId:sid,url,context:{condition},gaps:[],regions:[],controls:[{
    localId:'shared',instanceId:'document:shared',stableKey:'id:shared',role:'generic',name:'Details',label:'Details',
    visible,enabled:true,actionBasis:{},
  }],
}) as unknown as Observation;
const oldProof={...ref('before'),classificationId:'old',classification:'container' as const};
const item=(id='gap',sources=['before'],completed=false):PlanItem=>({
  id,title:id,scope:{url,label:'Details',role:'generic'},prerequisites:[],completion:'interpreted',
  required:true,status:completed?'succeeded':'unresolved',reason:'classification_unresolved',
  evidence:sources.map(ref),attempts:[],...(completed?{reviewResolvedBy:{...oldProof}}:{}),
});
function fixture(items=[item()],current=observed('current'),sources=[observed('before')]) {
  const observations=new Map([current,...sources].map(o=>[o.id,o]));
  const revoked=new Set<string>();let classificationId='new';
  const task={plan:items,routeRetries:[{status:'unknown',attemptId:'unknown-attempt'}],pendingDispatch:{attemptId:'unknown-attempt'}} as unknown as Task;
  const correspondence=vi.fn((sessionId:string,input:{observationId:string;localId:string;source:{sessionId:string;observationId:string;localId:string}})=>{
    const source=observations.get(input.source.observationId)!,target=observations.get(input.observationId)!;
    return {targetMatched:true,reviewable:true,sourceEquivalent:source.context.condition===target.context.condition?'equivalent':'different',
      reason:'recorded_conditions',source:input.source,target:{sessionId,observationId:input.observationId,localId:input.localId},
      preflightRequired:true,identityAuthorized:false,replayAuthorized:false,executionAuthorized:false,currentExecution:false,coverageGranted:false,checkpointVerified:false};
  });
  const snapshot=vi.fn(()=>({sessionId:sid,observationId:current.id,executionAuthorized:false,actions:[],
    nonInteractive:current.controls.filter(c=>c.visible).map(c=>({...ref(current.id),localId:c.localId,classificationId,classification:'container'})),
    retainedClassifications:items.flatMap(i=>[...(i.reviewResolvedBy?[i.reviewResolvedBy]:[]),...(i.reviewSourceProofs?.bindings||[]).map(b=>b.proof)])
      .map(proof=>({source:proof,retained:!revoked.has(proof.classificationId),localId:'localId' in proof?proof.localId as string:'shared',
        reason:revoked.has(proof.classificationId)?'classification_revoked_or_replaced':'historical_classification_retained',currentApplicability:false,executionAuthorized:false})),
  }));
  const read=vi.fn((_sid:string,id:string)=>{const o=observations.get(id);if(!o)throw new Error('missing source');return o;});
  const actions=vi.fn(()=>[]);
  const forbidden=vi.fn(()=>{throw new Error('not a read');});
  const host={controlInterpretationSnapshot:snapshot,observation:read,actions,controlReviewTargetCorrespondence:correspondence,
    list:forbidden,execute:forbidden,reachCheckpoint:forbidden,pinEvidence:forbidden,command:forbidden} as unknown as ExplorerHost;
  return {task,get current(){return current;},host,correspondence,snapshot,read,actions,forbidden,revoked,
    setCurrent(next:Observation){current=next;observations.set(next.id,next);classificationId='classification-'+next.id;}};
}
function apply(task:Task,changes:ReturnType<typeof reviewGapChanges>) {
  for(const c of changes) {
    const row=task.plan.find(i=>i.id===c.itemId)!;
    if(c.sourceProofs)row.reviewSourceProofs=c.sourceProofs;
    if(c.proof){row.reviewResolvedBy=c.proof;row.status='succeeded';}
    else if(c.complete===false){delete row.reviewResolvedBy;row.status='unresolved';}
  }
}

describe('review source completion',()=>{
it('closes a current-only source and an equivalent historical source without an operation',()=>{
  const f=fixture([item('current',['current']),item('historical',['before'])]),before=structuredClone(f.task);
  expect(reviewGapChanges(f.task,f.current,f.host)).toMatchObject(['current','historical'].map(itemId=>({
    itemId,complete:true,proof:{...ref('current'),classificationId:'new',classification:'container'},
  })));
  expect(f.task).toEqual(before);expect(f.forbidden).not.toHaveBeenCalled();
});

it.each(['different','unknown'] as const)('does not settle an old A source from same-hint current B when correspondence is %s',equivalence=>{
  const f=fixture([item('old',['before']),item('current',['current'])],observed('current','B'));
  const real=f.correspondence.getMockImplementation()!;
  f.correspondence.mockImplementation((s,input)=>({...real(s,input),sourceEquivalent:input.source.observationId==='before'?equivalence:'equivalent'}));
  expect(reviewGapChanges(f.task,f.current,f.host).map(c=>c.itemId)).toEqual(['current']);
  expect(f.task.plan[0].status).toBe('unresolved');
});

it('retracts whole-item completion when one retained source has a different nonlocal condition',()=>{
  const f=fixture([item('mixed',['before','mode-b'],true)],observed('current'),[observed('before'),observed('mode-b','B')]);
  const changes=reviewGapChanges(f.task,f.current,f.host);
  expect(changes).toMatchObject([{itemId:'mixed',complete:false,reason:'legacy_review_sources_partially_verified'}]);
  expect(changes[0].sourceProofs?.bindings.map(b=>b.source.observationId)).toEqual(['before']);expect(changes[0].proof).toBeUndefined();
});

it('does not retain hidden legacy A+B completion merely because classification A is retained',()=>{
  const f=fixture([item('mixed',['before','mode-b'],true)],observed('current','A',false),[observed('before'),observed('mode-b','B')]);
  const changes=reviewGapRetractions(f.task,f.current,f.host);
  expect(changes).toMatchObject([{itemId:'mixed',complete:false,reason:'legacy_review_sources_partially_verified'}]);
  expect(changes[0].sourceProofs?.bindings.map(b=>b.source.observationId)).toEqual(['before']);expect(changes[0].proof).toBeUndefined();
  expect(f.correspondence.mock.calls.every(([,input])=>input.observationId==='before')).toBe(true);
});

it('retains scene-invalidated historical completion only after verifying all original sources',()=>{
  const f=fixture([item('old',['before'],true)],observed('current','B',false));
  const changes=reviewGapRetractions(f.task,f.current,f.host);
  expect(changes).toMatchObject([{itemId:'old',complete:true}]);expect(changes[0].proof).toBeUndefined();
  expect(changes[0].sourceProofs?.bindings).toEqual([{source:{...ref('before'),localId:'shared'},proof:{...oldProof,localId:'shared'}}]);
  expect(f.correspondence).toHaveBeenCalledTimes(1);
  expect(f.correspondence.mock.calls[0][1]).toEqual({observationId:'before',localId:'shared',source:{...ref('before'),localId:'shared'}});
});

it('does not bind retained classification on another control using the item scope',()=>{
  const f=fixture([item('old',['before'],true)],observed('current','A',false)),base=f.snapshot.getMockImplementation()!;
  f.snapshot.mockImplementation(()=>({...base(),retainedClassifications:base().retainedClassifications.map(p=>({...p,localId:'another'}))}));
  expect(reviewGapRetractions(f.task,f.current,f.host)).toMatchObject([{itemId:'old',complete:false,sourceProofs:{bindings:[]}}]);
  expect(f.correspondence).not.toHaveBeenCalled();
});

it.each(['source','current'] as const)('does not guess among same-named %s controls',where=>{
  const current=observed('current'),source=observed('before');
  const duplicated=where==='source'?source:current;
  duplicated.controls.push({...duplicated.controls[0],localId:'other',instanceId:'document:other'});
  const f=fixture([item()],current,[source]);
  expect(reviewGapChanges(f.task,current,f.host)).toEqual([]);expect(f.correspondence).not.toHaveBeenCalled();
});

it.each(['missing-source','missing-api','query-error'] as const)('keeps missing conditions unresolved for %s and preserves unknown debt',mode=>{
  const f=fixture([item('old',['before'],true)]),before=structuredClone(f.task);
  if(mode==='missing-source')f.read.mockImplementation(()=>{throw new Error('missing');});
  if(mode==='missing-api')delete f.host.controlReviewTargetCorrespondence;
  if(mode==='query-error')f.correspondence.mockImplementation(()=>{throw new Error('stale');});
  const changes=reviewGapChanges(f.task,f.current,f.host);
  expect(changes).toHaveLength(1);expect(changes[0].proof).toBeUndefined();expect(f.task).toEqual(before);
});

it.each(['wrong-reference','authority'] as const)('rejects %s even if the host reports equivalent',mode=>{
  const f=fixture(),real=f.correspondence.getMockImplementation()!;
  f.correspondence.mockImplementation((s,input)=>{
    const result=real(s,input);
    return mode==='wrong-reference'?{...result,source:{...result.source,observationId:'other'}}:{...result,executionAuthorized:true};
  });
  expect(reviewGapChanges(f.task,f.current,f.host)).toEqual([]);
});

it('stop settlement never grants a replacement proof and preserves revoked historical evidence as unresolved',()=>{
  const f=fixture([item('new',['current']),item('old',['before'],true)]),before=structuredClone(f.task);
  f.revoked.add('old');
  expect(reviewGapRetractions(f.task,f.current,f.host)).toMatchObject([{itemId:'old',complete:false,sourceProofs:{bindings:[]}}]);
  expect(f.task).toEqual(before);expect(f.forbidden).not.toHaveBeenCalled();
});

it('shares source reads and pair checks within a synchronous pass but rechecks the next call',()=>{
  const f=fixture(Array.from({length:64},(_,i)=>item(String(i))));
  expect(reviewGapChanges(f.task,f.current,f.host)).toHaveLength(64);
  expect(f.snapshot).toHaveBeenCalledTimes(1);expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.actions).toHaveBeenCalledTimes(1);expect(f.correspondence).toHaveBeenCalledTimes(1);
  const real=f.correspondence.getMockImplementation()!;
  f.correspondence.mockImplementation((s,input)=>({...real(s,input),sourceEquivalent:'unknown'}));
  expect(reviewGapChanges(f.task,f.current,f.host)).toEqual([]);
  expect(f.snapshot).toHaveBeenCalledTimes(2);expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.correspondence).toHaveBeenCalledTimes(2);expect(f.forbidden).not.toHaveBeenCalled();
});

it('batches all unique control pairs at one target while sharing source material',()=>{
  const source=observed('before'),current=observed('current');
  for(const o of [source,current])o.controls.push({...o.controls[0],localId:'other',instanceId:'document:other',name:'Summary',label:'Summary'});
  const items=Array.from({length:64},(_,i)=>{const row=item(String(i));if(i%2)row.scope.label='Summary';return row;});
  const f=fixture(items,current,[source]),single=f.correspondence.getMockImplementation()!;
  const batch=vi.fn((sessionId:string,input:{observationId:string;requests:{localId:string;source:{sessionId:string;observationId:string;localId:string}}[]})=>({
    sessionId,observationId:input.observationId,results:input.requests.map(r=>single(sessionId,{...r,observationId:input.observationId})),
  }));
  f.host.controlReviewTargetCorrespondences=batch as unknown as NonNullable<ExplorerHost['controlReviewTargetCorrespondences']>;
  expect(reviewGapChanges(f.task,current,f.host)).toHaveLength(64);
  expect(batch).toHaveBeenCalledTimes(1);expect(batch.mock.calls[0][1].requests).toHaveLength(2);
  expect(f.read).toHaveBeenCalledTimes(1);expect(f.actions).toHaveBeenCalledTimes(1);expect(f.correspondence).not.toHaveBeenCalled();
});

it('accumulates A then B separately and preserves complete source proofs over a restart',()=>{
  const a=observed('a','A'),b=observed('b','B'),f=fixture([item('mixed',['a','b'])],a,[a,b]),beforeDebt=structuredClone(f.task.routeRetries);
  const first=reviewGapChanges(f.task,f.current,f.host);
  expect(first).toMatchObject([{itemId:'mixed',complete:false}]);expect(first[0].proof).toBeUndefined();
  expect(first[0].sourceProofs?.bindings.map(x=>x.source.observationId)).toEqual(['a']);apply(f.task,first);
  expect(f.task.plan[0].status).toBe('unresolved');
  f.setCurrent(b);f.correspondence.mockClear();f.read.mockClear();
  const second=reviewGapChanges(f.task,f.current,f.host);
  expect(second).toMatchObject([{itemId:'mixed',complete:true,proof:{observationId:'b'}}]);
  expect(second[0].sourceProofs?.bindings.map(x=>[x.source.observationId,x.proof.observationId])).toEqual([['a','a'],['b','b']]);
  expect(f.correspondence.mock.calls.map(([,input])=>input.source.observationId)).toEqual(['b']);
  expect(f.read).not.toHaveBeenCalled();apply(f.task,second);
  const reopened=fixture(structuredClone(f.task.plan),observed('restart','C',false),[a,b]);
  expect(reviewGapRetractions(reopened.task,reopened.current,reopened.host)).toEqual([]);
  expect(reopened.task.plan[0].status).toBe('succeeded');expect(reopened.correspondence).not.toHaveBeenCalled();
  expect(reopened.read).not.toHaveBeenCalled();expect(f.task.routeRetries).toEqual(beforeDebt);
});

it('keeps a partial proof across restart, unknown B, and revokes only a withdrawn source proof',()=>{
  const a=observed('a','A'),b=observed('b','B'),f=fixture([item('mixed',['a','b'])],a,[a,b]);
  apply(f.task,reviewGapChanges(f.task,f.current,f.host));
  const reopened=fixture(structuredClone(f.task.plan),b,[a,b]),real=reopened.correspondence.getMockImplementation()!;
  reopened.setCurrent(b);
  reopened.correspondence.mockImplementation((s,input)=>({...real(s,input),sourceEquivalent:'unknown'}));
  expect(reviewGapChanges(reopened.task,reopened.current,reopened.host)).toEqual([]);
  expect(reopened.task.plan[0].reviewSourceProofs?.bindings.map(x=>x.source.observationId)).toEqual(['a']);
  reopened.correspondence.mockImplementation(real);
  apply(reopened.task,reviewGapChanges(reopened.task,reopened.current,reopened.host));
  reopened.setCurrent(observed('after','C',false));reopened.revoked.add('new');
  const changes=reviewGapRetractions(reopened.task,reopened.current,reopened.host);
  expect(changes).toMatchObject([{itemId:'mixed',complete:false}]);expect(changes[0].proof).toBeUndefined();
  expect(changes[0].sourceProofs?.bindings.map(x=>x.source.observationId)).toEqual(['b']);
});

it('rechecks saved cross-record bindings and rejects a changed or missing correspondence',()=>{
  const source=observed('before'),proof=observed('current'),f=fixture([item()],proof,[source]);
  apply(f.task,reviewGapChanges(f.task,f.current,f.host));
  f.setCurrent(observed('after','A',false));const real=f.correspondence.getMockImplementation()!;
  f.correspondence.mockImplementation((s,input)=>({...real(s,input),sourceEquivalent:'unknown'}));
  const changes=reviewGapRetractions(f.task,f.current,f.host);
  expect(changes).toMatchObject([{itemId:'gap',complete:false,sourceProofs:{bindings:[]}}]);
  expect(changes[0].proof).toBeUndefined();expect(f.correspondence).toHaveBeenCalled();
});

it('rechecks accumulated A/B proofs after scope narrowing without losing still-matching sources',()=>{
  const a=observed('a','A'),b=observed('b','B');
  for(const o of [a,b]){o.regions=[{key:'region',label:'Shared',role:'region'} as Observation['regions'][number]];o.controls[0].region='region';}
  b.controls[0].stableKey='id:only-b';
  const f=fixture([item('mixed',['a','b'])],a,[a,b]);
  apply(f.task,reviewGapChanges(f.task,f.current,f.host));f.setCurrent(b);
  apply(f.task,reviewGapChanges(f.task,f.current,f.host));
  const row=f.task.plan[0];expect(row.status).toBe('succeeded');
  f.setCurrent(observed('after','C',false));f.correspondence.mockClear();
  row.scope.region='Shared';
  const shared=reviewGapRetractions(f.task,f.current,f.host);
  expect(shared).toMatchObject([{itemId:'mixed',complete:true}]);expect(shared[0].proof).toBeUndefined();
  expect(shared[0].sourceProofs?.bindings.map(x=>x.source.observationId)).toEqual(['a','b']);
  expect(f.correspondence.mock.calls.map(([,input])=>[input.source.observationId,input.observationId])).toEqual([['a','a'],['b','b']]);
  apply(f.task,shared);expect(row.status).toBe('succeeded');
  const key=scopeForControl(b.controls[0],b).stableKey;expect(key).toBeDefined();row.scope.stableKey=key;
  const narrowed=reviewGapRetractions(f.task,f.current,f.host);
  expect(narrowed).toMatchObject([{itemId:'mixed',complete:false}]);expect(narrowed[0].proof).toBeUndefined();
  expect(narrowed[0].sourceProofs?.bindings.map(x=>x.source.observationId)).toEqual(['b']);
  apply(f.task,narrowed);expect(row.status).toBe('unresolved');
  expect(row.evidence.map(x=>x.observationId)).toEqual(['a','b']);expect(f.forbidden).not.toHaveBeenCalled();
});
});
