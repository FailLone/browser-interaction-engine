import { expect, it, vi } from 'vitest';
import { MemoryStore } from '@interaction/storage-memory';
import { controlClassificationConditions, controlClassificationKey, type Control, type Observation, type ControlClassificationRecord } from '@interaction/browser';
import { ControlClassifications, type ClassificationEvidenceRef } from '../packages/browser/src/control-classifications.js';

function evidence(store:MemoryStore,name:string,status:ControlClassificationRecord['status']='active') {
  const control={localId:`local-${name}`,instanceId:`document-${name}:control`,tag:'div',role:'generic',name,label:name,region:'document',
    constraints:{type:'div',valid:true},reviewBinding:{parentInstanceId:`document-${name}:parent`,attributes:{}},
    actionBasis:{},editable:false,options:[],classificationBinding:{text:name,truncated:false,nodes:[],references:[]}} as unknown as Control;
  const observation={id:`observation-${name}`,sessionId:'session',instanceScope:`document-${name}`,url:'https://retained.fixture.invalid/',context:{},gaps:[],controls:[control]} as unknown as Observation;
  const conditions=controlClassificationConditions(control,observation)!;
  const record={id:`classification-${name}`,sessionId:'session',observationId:observation.id,localId:control.localId,classification:'display',status,conditions,
    conditionKey:controlClassificationKey(conditions),source:'fixture',at:'2026-10-17T00:00:00Z',reason:'Captured text',evidence:['exact captured occurrence']} as ControlClassificationRecord;
  store.put('observation',observation);store.put('control-classification',record);
  const ref:ClassificationEvidenceRef={sessionId:'session',observationId:observation.id,classificationId:record.id,classification:'display'};
  return {observation,record,ref};
}

it('streams mixed retained sources once per graph and preserves ordered unique-target evidence',()=>{
  const store=new MemoryStore(),current=evidence(store,'current'),a=evidence(store,'a','invalidated'),b=evidence(store,'b'),revoked=evidence(store,'revoked','revoked');
  const ambiguous=evidence(store,'ambiguous'),ambiguousObservation={...ambiguous.observation,id:'ambiguous-copy',controls:[...ambiguous.observation.controls,{...ambiguous.observation.controls[0],localId:'rival'}]};
  store.put('observation',ambiguousObservation);
  const gap=evidence(store,'gap'),gapObservation={...gap.observation,id:'gap-copy',gaps:[{code:'INCOMPLETE',critical:true,message:'fixture'}]};store.put('observation',gapObservation);
  const sources=[b.ref,a.ref,current.ref,...Array.from({length:32},(_,i)=>i%2?a.ref:b.ref),revoked.ref,
    {...a.ref,sessionId:'wrong-session'}, {...ambiguous.ref,observationId:ambiguousObservation.id}, {...gap.ref,observationId:gapObservation.id},
    {...a.ref,classificationId:'missing'}];
  const scans=new Map<string,number>(),read=store.get.bind(store);
  const get=vi.spyOn(store,'get').mockImplementation(((kind:string,id:string)=>{
    const value=read(kind,id);
    if(kind==='observation'&&value){const o=value as Observation,controls=o.controls;Object.defineProperty(o,'controls',{get:()=>{scans.set(id,(scans.get(id)||0)+1);return controls;}});}
    return value;
  }) as typeof store.get),list=vi.spyOn(store,'list'),put=vi.spyOn(store,'put'),emit=vi.fn();
  const results=new ControlClassifications(store,emit).retainedEvidence(sources,current.observation);
  expect(results.map(r=>r.source)).toEqual(sources);
  expect(results.slice(0,35).every(r=>r.retained&&r.localId===`local-${r.source.classificationId.slice('classification-'.length)}`&&!r.currentApplicability&&!r.executionAuthorized)).toBe(true);
  expect(results.slice(35).map(r=>({retained:r.retained,localId:r.localId,reason:r.reason}))).toEqual([
    {retained:false,localId:undefined,reason:'classification_revoked_or_replaced'},
    ...Array.from({length:4},()=>({retained:false,localId:undefined,reason:'classification_evidence_unavailable'})),
  ]);
  expect(get.mock.calls.filter(([kind])=>kind==='observation').map(([,id])=>id)).toEqual([b.observation.id,a.observation.id,ambiguousObservation.id,gapObservation.id]);
  expect(get.mock.calls.filter(([kind,id])=>kind==='control-classification'&&id===b.record.id)).toHaveLength(1);
  expect([...scans]).toEqual([[b.observation.id,1],[a.observation.id,1],[ambiguousObservation.id,1]]);
  expect(list).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();expect(emit).not.toHaveBeenCalled();
});

it('validates reused ancestry before its source graph and preserves revocation checks on the next call',()=>{
  const store=new MemoryStore(),current=evidence(store,'current'),ancestor=evidence(store,'ancestor','invalidated'),reused=evidence(store,'reused');
  store.put('control-classification',{...reused.record,reuseFrom:ancestor.ref});
  const classifications=new ControlClassifications(store,vi.fn()),get=vi.spyOn(store,'get');
  const result=classifications.retainedEvidence([reused.ref,reused.ref],current.observation);
  expect(result.every(r=>r.retained&&r.localId==='local-reused')).toBe(true);
  expect(get.mock.calls.filter(([kind])=>kind==='observation').map(([,id])=>id)).toEqual([ancestor.observation.id,reused.observation.id]);
  store.put('control-classification',{...ancestor.record,status:'revoked'});get.mockClear();
  expect(classifications.retainedEvidence([reused.ref],current.observation)[0]).toMatchObject({retained:false,reason:'classification_revoked_or_replaced'});
  expect(get.mock.calls.some(([kind])=>kind==='observation')).toBe(false);
});
