import {canonical} from '@interaction/core';
import {fragmentConditionReader} from './fragment-conditions.js';
import {fragmentIdBindingReader} from './fragment-id-binding.js';
import type {Control,Observation,RegionCandidate} from './types.js';
type Fragment=NonNullable<RegionCandidate['fragment']>;
const attributes=(a:Record<string,string>)=>Object.fromEntries(Object.entries(a).filter(([k])=>k!=='style'));
function subtree(o:Observation,id:string,anchor:Fragment){
 const roots=o.controls.filter(c=>c.instanceId===id),binding=roots.length===1?roots[0].classificationBinding:undefined;
 if(!binding){
  const found=(o.regionCandidates||[]).flatMap(r=>{const f=r.fragment,root=f?.nodes.find(n=>n.instanceId===id);if(!f||!root)return [];
   return [{...anchor,nodes:f.nodes.filter(n=>n.path===root.path||n.path.startsWith(root.path+'/')).map(n=>({...n,path:'.'+n.path.slice(root.path.length)}))}];});
  if(!found.length||!found.every(f=>canonical(f.nodes)===canonical(found[0].nodes)))return;
  const fragment=found[0];return {fragment,binding:{nodes:fragment.nodes.map(n=>({instanceId:n.instanceId,parentInstanceId:'',tag:n.tag,attributes:n.attributes})),text:fragment.nodes.map(n=>n.text).join(''),truncated:false},basis:'complete-host-fragment'};
 }
 if(binding.truncated||binding.nodes[0]?.instanceId!==id)return;
 const paths=new Map<string,string>(),counts=new Map<string,number>(),nodes:Fragment['nodes']=[];
 for(const n of binding.nodes){
  if(paths.has(n.instanceId))return;
  const parent=paths.get(n.parentInstanceId),key=canonical([n.parentInstanceId,n.tag]),count=(counts.get(key)||0)+1;counts.set(key,count);
  const path=n.instanceId===id?'.':parent&&`${parent}/${n.tag}[${count}]`;if(!path)return;
  paths.set(n.instanceId,path);nodes.push({instanceId:n.instanceId,path,tag:n.tag,attributes:n.attributes,text:''});
 }
 return {fragment:{...anchor,nodes},binding,basis:'complete-classification-subtree'};
}
const inventory=(o:Observation,ids:Set<string>,bind:NonNullable<ReturnType<ReturnType<typeof fragmentIdBindingReader>>>)=>o.controls.filter(c=>ids.has(c.instanceId)).map(c=>({tag:c.tag,role:c.role,name:c.label||c.name,
 visible:c.visible,enabled:c.enabled,editable:c.editable,readOnly:c.readOnly,value:c.value,displayedText:c.displayedText,attributes:c.reviewBinding&&bind.attributes(c.reviewBinding.attributes,c.instanceId),
 checked:c.checked,pressed:c.pressed,expanded:c.expanded,selected:c.selected,options:c.options,constraints:c.constraints,
 record:c.structuralItem&&{key:c.structuralItem.recordKey,template:c.structuralItem.template,slot:c.structuralItem.slot},readiness:c.readiness,
 actionable:c.actionable&&{visible:c.actionable.visible,enabled:c.actionable.enabled,editable:c.actionable.editable,hitTarget:c.actionable.hitTarget,occludedBy:c.actionable.occludedBy,outsideScrollableArea:c.actionable.outsideScrollableArea,unknown:c.actionable.unknown}
})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
export const effectControl=(c:Control)=>canonical({tag:c.tag,role:c.role,name:c.label||c.name,attributes:c.reviewBinding?.attributes,
 binding:c.identityContext&&{scope:c.identityContext.scope,binding:c.identityContext.binding},checked:c.checked,pressed:c.pressed,expanded:c.expanded,selected:c.selected,options:c.options});
export function effectControlChanges(before:Observation,after:Observation,excluded=new Set<string>()){
 const inventory=(o:Observation)=>{const counts=new Map<string,number>();for(const c of o.controls.filter(c=>c.visible&&!excluded.has(c.instanceId))){const key=effectControl(c);counts.set(key,(counts.get(key)||0)+1);}return counts;};
 const a=inventory(before),b=inventory(after);return [...new Set([...a.keys(),...b.keys()])].sort().flatMap(control=>(a.get(control)||0)===(b.get(control)||0)?[]:[{control,delta:(b.get(control)||0)-(a.get(control)||0)}]);
}
/** Exact line LCS with an evidence-work bound. Exceeding it declines the local
 * projection; it never truncates a witness or removes pending opportunities. */
function textChanges(before:string,after:string){
 const a=before.split('\n'),b=after.split('\n');if((a.length+1)*(b.length+1)>2000000)return;
 const width=b.length+1,dp=new Uint32Array((a.length+1)*width);
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i*width+j]=a[i]===b[j]?1+dp[(i+1)*width+j+1]:Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
 const removed:{start:number;end:number;text:string}[]=[],added:string[]=[];let i=0,j=0;
 while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){i++;j++;continue;}
  const start=i,addition:string[]=[];
  while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j])break;
   if(i<a.length&&(j===b.length||dp[(i+1)*width+j]>=dp[i*width+j+1]))i++;else addition.push(b[j++]);}
  if(i>start)removed.push({start,end:i,text:a.slice(start,i).join('\n')});if(addition.length)added.push(addition.join('\n'));
 }
 return {lines:a,removed,added};
}
const compact=(s:string)=>s.replace(/\s/g,'');
/** Only positively observed retirement of a separate complete UI subtree is
 * collateral. Arbitrary external changes (including text-only results) stay in
 * the comparison. The full global effect and every assignment remain stored. */
export function localFragmentEffect(before:Observation,after:Observation,regionId:string,localId:string){
 if(before.instanceScope!==after.instanceScope||before.url!==after.url)return;
 const anchor=before.regionCandidates?.find(r=>r.id===regionId)?.fragment;if(!anchor)return;
 const source=before.controls.find(c=>c.localId===localId),targets=source&&after.controls.filter(c=>c.instanceId===source.instanceId);
 const prior=subtree(before,regionId,anchor),next=subtree(after,regionId,anchor);if(!prior||!next||targets?.length!==1)return;
 const bind=fragmentIdBindingReader(after)(next.fragment);if(!bind)return;
 const modes=fragmentConditionReader(after)(targets[0],next.fragment).modes;if(!modes.conditions)return;
 const targetIds=new Set([...anchor.nodes,...prior.fragment.nodes,...next.fragment.nodes].map(n=>n.instanceId));
 const closing=new Map<string,{root:string;binding:NonNullable<Control['classificationBinding']>;ids:Set<string>}>();
 for(const c of before.controls){
  const current=after.controls.filter(t=>t.instanceId===c.instanceId);
  if(typeof c.expanded!=='boolean'||current.length!==1||current[0].expanded!==false||targetIds.has(c.instanceId))continue;
  const roots=before.controls.filter(r=>r.classificationBinding&&!r.classificationBinding.truncated
   &&r.classificationBinding.nodes.some(n=>n.instanceId===c.instanceId)&&!r.classificationBinding.nodes.some(n=>targetIds.has(n.instanceId)))
   .filter(r=>r.classificationBinding!.nodes.some(n=>before.controls.some(t=>t.instanceId===n.instanceId&&t.visible)&&!after.controls.some(t=>t.instanceId===n.instanceId&&t.visible)))
   .sort((a,b)=>a.classificationBinding!.nodes.length-b.classificationBinding!.nodes.length);
  const root=roots[0];if(!root)continue;
  const binding=root.classificationBinding!,ids=new Set(binding.nodes.map(n=>n.instanceId));
  // A closing panel cannot hide simultaneous new controls or value changes.
  const retired=before.controls.filter(t=>ids.has(t.instanceId)&&t.visible&&!after.controls.some(n=>n.instanceId===t.instanceId&&n.visible));
  if(!retired.length||after.controls.some(t=>ids.has(t.instanceId)&&t.visible&&!before.controls.some(n=>n.instanceId===t.instanceId&&n.visible)))continue;
  if(before.controls.some(t=>ids.has(t.instanceId)&&after.controls.some(n=>n.instanceId===t.instanceId&&(n.value!==t.value||canonical(n.options)!==canonical(t.options)||canonical(n.selected)!==canonical(t.selected)||n.checked!==t.checked||n.pressed!==t.pressed))))continue;
  closing.set(root.instanceId,{root:root.instanceId,binding,ids});
 }
 // Native details open/closed state is captured on its owning element rather
 // than on summary.expanded. Complete DOM fragments provide the same boundary.
 const native=new Set((before.regionCandidates||[]).flatMap(r=>r.fragment?.nodes.filter(n=>n.tag==='details'&&Object.hasOwn(n.attributes,'open')).map(n=>n.instanceId)||[]));
 for(const root of native){const a=subtree(before,root,anchor),b=subtree(after,root,anchor);if(!a||!b||b.fragment.nodes[0].tag!=='details'||Object.hasOwn(b.fragment.nodes[0].attributes,'open'))continue;
  const ids=new Set(a.fragment.nodes.map(n=>n.instanceId));if([...ids].some(id=>targetIds.has(id)))continue;
  if(!before.controls.some(c=>ids.has(c.instanceId)&&c.visible&&!after.controls.some(n=>n.instanceId===c.instanceId&&n.visible)))continue;
  if(after.controls.some(c=>ids.has(c.instanceId)&&c.visible&&!before.controls.some(n=>n.instanceId===c.instanceId&&n.visible)))continue;
  if(before.controls.some(c=>ids.has(c.instanceId)&&after.controls.some(n=>n.instanceId===c.instanceId&&(n.value!==c.value||canonical(n.options)!==canonical(c.options)||canonical(n.selected)!==canonical(c.selected)||n.checked!==c.checked||n.pressed!==c.pressed))))continue;
  closing.set(root,{root,binding:a.binding,ids});
 }
 // Collateral closure cannot conceal a changed destination, new child or
 // changed hidden content. Only captured closing/visibility attributes differ.
 const closingTree=(f:Fragment)=>f.nodes.map(n=>({path:n.path,tag:n.tag,text:n.text,
  attributes:Object.fromEntries(Object.entries(n.attributes).filter(([key])=>!['style','aria-expanded','aria-hidden','hidden','open'].includes(key)&&!(n.path==='.'&&key==='class')))}));
 for(const [root] of closing){const a=subtree(before,root,anchor),b=subtree(after,root,anchor);
  if(!a||!b||before.controls.some(c=>a.fragment.nodes.some(n=>n.instanceId===c.instanceId)&&after.controls.some(n=>n.instanceId===c.instanceId&&n.expanded===true&&c.expanded!==true))||canonical(closingTree(a.fragment))!==canonical(closingTree(b.fragment))||a.binding.text!==b.binding.text)closing.delete(root);
 }
 const diff=textChanges(before.text,after.text);if(!diff)return;
 const allBefore=compact(before.text),assignments:{start:number;end:number;root:string;witness:string}[]=[];
 const unassigned=diff.removed.filter(block=>{
  if(!compact(block.text))return true;
  // Adjacent captured text disambiguates a repeated label without assigning
  // every occurrence of that label to the closed panel.
  for(const zone of closing.values())for(const [start,end] of [[block.start,block.end],[Math.max(0,block.start-1),block.end],[block.start,Math.min(diff.lines.length,block.end+1)],[Math.max(0,block.start-1),Math.min(diff.lines.length,block.end+1)]]){
   const witness=compact(diff.lines.slice(start,end).join('\n'));if(!witness||!compact(zone.binding.text).includes(witness))continue;
   const at=allBefore.indexOf(witness);if(at<0||allBefore.indexOf(witness,at+1)!==-1)continue;
   assignments.push({start:block.start,end:block.end,root:zone.root,witness});return false;
  }return true;
 }).map(b=>b.text);
 const excluded=new Set([...targetIds,...[...closing.values()].flatMap(c=>[...c.ids])]);
 const refs=after.controls.filter(c=>targetIds.has(c.instanceId)).flatMap(c=>c.classificationBinding?.references||[]);
 if(refs.some(r=>r.missing||r.ambiguous||r.target?.truncated))return;
 const references=refs.map(r=>({id:bind.reference(r.id),target:r.target&&{text:r.target.text,nodes:r.target.nodes.map(n=>({tag:n.tag,attributes:bind.attributes(n.attributes,n.instanceId)}))}}));
 return {comparison:{policy:'fragment-local-effect/v2',navigation:null,
  local:{tree:next.fragment.nodes.map(({instanceId,path,tag,attributes:a,text})=>({path,tag,attributes:bind.attributes(attributes(a),instanceId),text})),text:next.binding.text,controls:inventory(after,new Set(next.fragment.nodes.map(n=>n.instanceId)),bind),relatedModes:modes.conditions.conditions,references},
  external:{text:{removed:unassigned.filter(s=>compact(s)),added:diff.added.filter(s=>compact(s))},changes:effectControlChanges(before,after,excluded)}},
  evidence:{beforeId:before.id,afterId:after.id,regionId,targetInstanceId:source!.instanceId,beforeRoot:prior.binding,afterRoot:next.binding,scopeBasis:next.basis,
   localIdBindings:bind.bindings,closing:[...closing.values()].map(({root,binding})=>({root,binding})),assignments}};
}
