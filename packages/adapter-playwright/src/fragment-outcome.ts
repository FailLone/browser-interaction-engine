import {canonical,hash} from '@interaction/core';
import type {Observation} from './types.js';
export interface FragmentObservedEffect {policy:'fragment-observed-effect/v1';key:string;material:string;observedOnly:true}
/** Captured effect, not functional success or hidden-state equality. Compare
 * changes, not whole after-pages, so unrelated static page content is preserved
 * as context without manufacturing different local results. Noise may revoke
 * sampling conservatively. Incomplete results cannot validate a context loan. */
export function browserFragmentObservedEffect(before:Observation,after:Observation):FragmentObservedEffect|undefined {
 if(before.gaps.some(g=>g.critical)||after.gaps.some(g=>g.critical)||before.text.length>=50000||after.text.length>=50000)return;
 let start=0,end=0;while(start<before.text.length&&start<after.text.length&&before.text[start]===after.text[start])start++;
 while(end<before.text.length-start&&end<after.text.length-start&&before.text.at(-1-end)===after.text.at(-1-end))end++;
 const inventory=(o:Observation)=>{const counts=new Map<string,number>();for(const c of o.controls.filter(c=>c.visible)){
  const key=canonical({tag:c.tag,role:c.role,name:c.label||c.name,attributes:c.reviewBinding?.attributes,
   binding:c.identityContext&&{scope:c.identityContext.scope,binding:c.identityContext.binding},
   checked:c.checked,pressed:c.pressed,expanded:c.expanded,selected:c.selected,options:c.options});counts.set(key,(counts.get(key)||0)+1);}return counts;};
 const a=inventory(before),b=inventory(after),changes=[...new Set([...a.keys(),...b.keys()])].sort().flatMap(key=>(a.get(key)||0)===(b.get(key)||0)?[]:[{control:key,delta:(b.get(key)||0)-(a.get(key)||0)}]);
 const material=canonical({policy:'fragment-observed-effect/v1',navigation:before.url===after.url?null:after.url,
  text:{removed:before.text.slice(start,before.text.length-end),added:after.text.slice(start,after.text.length-end)},changes});
 return {policy:'fragment-observed-effect/v1',key:hash(material),material,observedOnly:true};
}
