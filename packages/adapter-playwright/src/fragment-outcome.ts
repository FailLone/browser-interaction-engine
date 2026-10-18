import {canonical,hash} from '@interaction/core';
import {localFragmentEffect,effectControlChanges} from './fragment-local-effect.js';
import type {Observation} from './types.js';
export interface FragmentObservedEffect {policy:'fragment-observed-effect/v1'|'fragment-observed-effect/v2';key:string;material:string;observedOnly:true}
/** Captured effect, not functional success or hidden-state equality. Compare
 * changes, not whole after-pages, so unrelated static page content is preserved
 * as context without manufacturing different local results. Noise may revoke
 * sampling conservatively. Incomplete results cannot validate a context loan. */
export function browserFragmentObservedEffect(before:Observation,after:Observation,scope?:{regionId:string;localId:string}):FragmentObservedEffect|undefined {
 if(before.gaps.some(g=>g.critical)||after.gaps.some(g=>g.critical)||before.text.length>=50000||after.text.length>=50000)return;
 let start=0,end=0;while(start<before.text.length&&start<after.text.length&&before.text[start]===after.text[start])start++;
 while(end<before.text.length-start&&end<after.text.length-start&&before.text.at(-1-end)===after.text.at(-1-end))end++;
 const changes=effectControlChanges(before,after);
 const global={policy:'fragment-observed-effect/v1',navigation:before.url===after.url?null:after.url,
  text:{removed:before.text.slice(start,before.text.length-end),added:after.text.slice(start,after.text.length-end)},changes};
 const local=scope&&localFragmentEffect(before,after,scope.regionId,scope.localId);
 const policy=local?'fragment-observed-effect/v2':'fragment-observed-effect/v1';
 const material=canonical(local?{policy,comparison:local.comparison,evidence:local.evidence,global}:global);
 return {policy,key:hash(material),material,observedOnly:true};
}

/** Raw exact evidence remains persisted; only an explicit versioned projection
 * participates in conditional sampling. Older effects retain exact comparison. */
export function browserFragmentEffectComparison(material:string):string|undefined {
 let parsed;try{parsed=JSON.parse(material);}catch{return material;}
 if(parsed?.policy!=='fragment-observed-effect/v2')return material;
 if(!['fragment-local-effect/v1','fragment-local-effect/v2'].includes(parsed.comparison?.policy)||!parsed.comparison.local||!parsed.comparison.external||!parsed.evidence?.beforeId||!parsed.evidence?.afterId||!parsed.global)return;
 return canonical({policy:parsed.policy,comparison:parsed.comparison});
}
