import {readFileSync} from 'node:fs';import {gunzipSync} from 'node:zlib';
import {expect,it} from 'vitest';
import {browserFragmentObservedEffect,browserFragmentEffectComparison,type Observation,type ActionCandidate} from '@interaction/browser';
import {decideFragmentSampling} from '../packages/explorer-plugin/src/fragment-sampling.js';
const rows=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/fraggen-effects/okx-actual-effects.json.gz',import.meta.url))).toString()).rows as {attemptId:string;before:Observation;after:Observation;action:ActionCandidate;scope:{regionId:string;localId:string}}[];
const effects=(label:string)=>rows.filter(r=>r.action.label===label).map(r=>({...r,effect:browserFragmentObservedEffect(r.before,r.after,r.scope)!}));
it('separates the two actual More outcomes from different positively observed closing menus without erasing their receipts',()=>{
 const [a,b]=effects('更多'),x=JSON.parse(a.effect.material),y=JSON.parse(b.effect.material);
 expect(x.policy).toBe('fragment-observed-effect/v2');expect(x.global).not.toEqual(y.global);
 expect(x.evidence.closing.length).toBeGreaterThan(0);expect(y.evidence.closing.length).toBeGreaterThan(0);
 expect(x.evidence.assignments.length).toBeGreaterThan(0);expect(y.evidence.assignments.length).toBeGreaterThan(0);
 expect(x.evidence.beforeId).toBe(a.before.id);expect(y.evidence.afterId).toBe(b.after.id);
 expect(browserFragmentEffectComparison(a.effect.material)).toBe(browserFragmentEffectComparison(b.effect.material));
 expect(decideFragmentSampling('third','third-context',[a,b].map(r=>({id:r.attemptId,candidateId:r.attemptId,context:r.before.id,effect:r.effect.material})))).toMatchObject({status:'context-sample',coverageGranted:false});
});
it('retains actual language destinations and extra options as a conflicting result',()=>{
 const [a,b]=effects('更改语言或货币');expect(a.effect.policy).toBe('fragment-observed-effect/v2');
 expect(browserFragmentEffectComparison(a.effect.material)).not.toBe(browserFragmentEffectComparison(b.effect.material));
 expect(decideFragmentSampling('third','third-context',[a,b].map(r=>({id:r.attemptId,candidateId:r.attemptId,context:r.before.id,effect:r.effect.material}))).status).toBe('observed-effect-conflict');
});
it('retains the actual unassigned notification mode initialization despite equal Trade subtrees',()=>{
 const [a,b]=effects('交易'),x=JSON.parse(a.effect.material),y=JSON.parse(b.effect.material);
 expect(x.comparison.local).toEqual(y.comparison.local);expect(x.comparison.external.changes).not.toEqual(y.comparison.external.changes);
 expect(browserFragmentEffectComparison(a.effect.material)).not.toBe(browserFragmentEffectComparison(b.effect.material));
});
it('does not hide an external output, changed destination, mode, or newly revealed child inside a local result',()=>{
 const [a,b]=effects('更多');
 for(const mutate of [
  (o:Observation)=>{o.text+='\nchanged external result';},
  (o:Observation)=>{o.url+='?record=other';},
  (o:Observation)=>{o.controls.find(c=>c.instanceId===b.scope.regionId)!.classificationBinding!.nodes.push({instanceId:'new-child',parentInstanceId:b.scope.regionId,tag:'a',attributes:{href:'/new-child'}});},
  (o:Observation)=>{o.controls.find(c=>c.instanceId===b.scope.regionId)!.classificationBinding!.text+='Different option';},
 ]){const after=structuredClone(b.after);mutate(after);const effect=browserFragmentObservedEffect(b.before,after,b.scope)!;expect(browserFragmentEffectComparison(effect.material)).not.toBe(browserFragmentEffectComparison(a.effect.material));}
});
it('keeps old exact effects incompatible with the scoped version and declines missing after evidence',()=>{
 const [r]=effects('更多'),after=structuredClone(r.after);after.controls.find(c=>c.instanceId===r.scope.regionId)!.classificationBinding!.truncated=true;
 const fallback=browserFragmentObservedEffect(r.before,after,r.scope)!;expect(fallback.policy).toBe('fragment-observed-effect/v1');expect(browserFragmentEffectComparison(fallback.material)).toBe(fallback.material);
 expect(browserFragmentEffectComparison('{"policy":"fragment-observed-effect/v2","comparison":{}}')).toBeUndefined();
});
