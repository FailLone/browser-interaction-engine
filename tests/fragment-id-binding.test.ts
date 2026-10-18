import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {expect,it} from 'vitest';
import type {ActionAttempt,ActionCandidate,Observation} from '@interaction/browser';
import {browserTraversalFragments} from '../packages/adapter-playwright/src/fragment-projection.js';
import {fragmentIdBindingReader} from '../packages/adapter-playwright/src/fragment-id-binding.js';
import {browserFragmentObservedEffect,browserFragmentEffectComparison} from '../packages/adapter-playwright/src/fragment-outcome.js';
import {decideFragmentSampling} from '../packages/explorer-plugin/src/fragment-sampling.js';
const rows=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/fraggen-id-binding/okx-actual-id-pairs.json.gz',import.meta.url))).toString()).rows as {attempt:ActionAttempt;before:Observation;after:Observation;actions:ActionCandidate[]}[];
const project=(r:typeof rows[number])=>{
 const f=browserTraversalFragments(r.before,r.actions,'authority').find(f=>f.candidates.some(c=>c.actionId===r.attempt.action.id))!;
 return {f,c:f?.candidates.find(c=>c.actionId===r.attempt.action.id)!};
};
it.each(['USDT','Crypto'])('binds the actual cross-page %s pair without changing any source or execution identity',label=>{
 const [a,b]=rows.filter(r=>r.attempt.action.label===label),saved=JSON.stringify([a,b]),x=project(a),y=project(b);
 expect(x.f.structure).toBe(y.f.structure);expect(x.f.owner).toBe(y.f.owner);
 expect(x.c.path).toBe(y.c.path);expect(x.c.operation).toBe(y.c.operation);expect(x.c.guard).toBe(y.c.guard);
 expect(x.c.context).not.toBe(y.c.context);
 const effect=(r:typeof a,f:typeof x.f)=>browserFragmentObservedEffect(r.before,r.after,{regionId:f.regionId,localId:r.attempt.action.localId!})!.material;
 const source=effect(a,x.f),target=effect(b,y.f);
 // The first genuine different context still requires execution. The second
 // outcome currently conflicts; mapping alone cannot grant conditional reuse.
 expect(decideFragmentSampling('target',y.c.context!,[{id:a.attempt.id,candidateId:'source',context:x.c.context!,effect:source}]).status).toBe('context-recheck-required');
 expect(browserFragmentEffectComparison(source)).not.toBe(browserFragmentEffectComparison(target));
 expect(decideFragmentSampling('later','third',[{id:a.attempt.id,candidateId:'source',context:x.c.context!,effect:source},{id:b.attempt.id,candidateId:'target',context:y.c.context!,effect:target}]).status).toBe('observed-effect-conflict');
 expect(JSON.stringify([a,b])).toBe(saved);
});

function local(){
 const r=structuredClone(rows[0]),p=project(r),f=r.before.regionCandidates!.find(f=>f.id===p.f.regionId)!.fragment!;
 return {r,f,read:()=>fragmentIdBindingReader(r.before)(f)!};
}
it('retains ID presence and local reference topology, with typed bindings rather than sentinel strings',()=>{
 const {r,f,read}=local(),node=f.nodes[1],other=f.nodes[2];
 node.attributes['aria-controls']=other.attributes.id;
 const a=read().attributes(node.attributes,node.instanceId);
 expect(a.id).toEqual({policy:'fragment-relative-id/v1',path:node.path});
 expect(a['aria-controls']).toEqual({policy:'fragment-idrefs/v1',targets:[{policy:'fragment-relative-id/v1',path:other.path}]});
 node.attributes['aria-controls']=node.attributes.id;
 expect(read().attributes(node.attributes,node.instanceId)).not.toEqual(a);
 const without={...node.attributes};delete without.id;
 expect(read().attributes(without,node.instanceId)).not.toHaveProperty('id');
 expect(r.before.controls.find(c=>c.instanceId===node.instanceId)!.identityScope).toBe('instance');
});
it.each(['record','duplicate-id','external-reference','ambiguous-reference','missing-reference','inconsistent-capture','symmetric-nodes'])('retains the literal ID when %s defeats a local binding',kind=>{
 const {r,f,read}=local(),node=f.nodes[1],id=node.attributes.id;
 if(kind==='record')r.before.controls.find(c=>c.instanceId===node.instanceId)!.structuralItem={ownerInstanceId:f.nodes[0].instanceId,rowInstanceId:node.instanceId,recordKey:'business-record',template:'row',slot:'target'};
 if(kind==='duplicate-id')f.nodes[2].attributes.id=id;
 if(kind==='inconsistent-capture')r.before.controls.find(c=>c.instanceId===node.instanceId)!.reviewBinding!.attributes.id='contradictory-id';
 if(kind==='symmetric-nodes'){f.nodes[2].attributes={...node.attributes,id:f.nodes[2].attributes.id};f.nodes[2].text=node.text;}
 if(kind==='external-reference')r.before.controls.find(c=>!f.nodes.some(n=>n.instanceId===c.instanceId)&&c.reviewBinding)!.reviewBinding!.attributes['aria-controls']=id;
 if(kind==='ambiguous-reference'||kind==='missing-reference'){
  const c=r.before.controls.find(c=>c.instanceId===node.instanceId)!;
  c.classificationBinding={nodes:[],text:'',truncated:false,references:[{id,...kind==='ambiguous-reference'?{ambiguous:true as const}:{missing:true as const}}]};
 }
 expect(read().attributes(node.attributes,node.instanceId).id).toBe(id);
});
it('keeps destinations, parameters, record attributes, selected modes and unknown IDREFs exact',()=>{
 const {f,read}=local(),node=f.nodes[1];
 Object.assign(node.attributes,{href:'/quote?record=A#account',value:'A','data-record':'A','aria-controls':'outside-unknown'});
 const a=read().attributes(node.attributes,node.instanceId);
 for(const key of ['href','value','data-record','aria-selected','aria-controls']){
  const changed={...node.attributes,[key]:'different'};
  expect(read().attributes(changed,node.instanceId)).not.toEqual(a);
 }
});
it.each(['duplicate-path','duplicate-instance','disconnected'])('declines %s local trees',kind=>{
 const {r,f}=local();if(kind==='duplicate-path')f.nodes[2].path=f.nodes[1].path;
 if(kind==='duplicate-instance')f.nodes[2].instanceId=f.nodes[1].instanceId;
 if(kind==='disconnected')f.nodes[2].path='./missing[1]/div[1]';
 expect(fragmentIdBindingReader(r.before)(f)).toBeUndefined();
});
