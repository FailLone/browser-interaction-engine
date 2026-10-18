import {canonical,hash} from '@interaction/core';
import {assessBrowserReviewBranchConditions,selectorState,type BrowserBranchConditionsAssessment} from './branch-conditions.js';
import {createOwnerDependencyCodec} from './owner-dependency-codec.js';
import {modeStructureReader} from './mode-structure.js';
import type {Control,Observation,RegionCandidate} from './types.js';
type Fragment=NonNullable<RegionCandidate['fragment']>;
/** Sampling dependency scope, never an execution/arrival independence proof.
 * All external evidence is retained; only captured positive relationships join
 * the strict guard. A missing relevant reference still declines correspondence. */
export function fragmentConditionReader(o:Observation) {
 const components=new Map((o.components||[]).filter(c=>c.basis.status==='supported').map(c=>[c.id,c]));
 const membershipCache=new Map<string,Set<string>>();
 const memberships=(id:string)=>{if(membershipCache.has(id))return membershipCache.get(id)!;const result=new Set<string>();for(const c of components.values())if(c.members.some(m=>m.localId===id)){
  let current:typeof c|undefined=c;while(current&&!result.has(current.id)){result.add(current.id);current=current.parentId?components.get(current.parentId):undefined;}}
  membershipCache.set(id,result);return result;};
 const selections=new Map((o.components||[]).flatMap(c=>c.members.filter(m=>typeof m.selected==='boolean').map(m=>[m.localId,m.selected!] as const)));
 const observed=o.controls.map(c=>({c,state:selectorState(c,selections)})).filter(row=>row.state!==undefined);
 const graph=o.ownerDependencies?.version==='browser-owner-dependencies-v3'?createOwnerDependencyCodec().decode(o.ownerDependencies):o.ownerDependencies;
 const edges=new Map<string,Set<string>>(),incomplete=new Set<string>();
 const connect=(a:string,b:string)=>{const next=edges.get(a)||new Set<string>();next.add(b);edges.set(a,next);};
 for(const ref of graph?.references||[]){if(ref.status!=='unique'){incomplete.add(ref.sourceId);continue;}for(const id of ref.targetIds){connect(ref.sourceId,id);connect(id,ref.sourceId);}}
 for(const c of o.controls)for(const ref of c.classificationBinding?.references||[]){
  if(ref.missing||ref.ambiguous||ref.target?.truncated){incomplete.add(c.instanceId);continue;}
  for(const id of [ref.targetInstanceId,...(ref.target?.nodes.map(n=>n.instanceId)||[])].filter((id):id is string=>!!id)){connect(c.instanceId,id);connect(id,c.instanceId);}
 }
 return (target:Control,f:Fragment):{modes:BrowserBranchConditionsAssessment;context:string}=>{
 const targetComponents=memberships(target.localId);
 const seeds=[...f.nodes.map(n=>n.instanceId),...target.domAncestry?.instanceIds||[],...o.controls.filter(c=>
  !!target.formOwner&&target.formOwner.instanceId===c.formOwner?.instanceId
  ||[...memberships(c.localId)].some(id=>targetComponents.has(id))).map(c=>c.instanceId)];
 const closure=new Set(seeds),pending=[...closure];
 // References on a shared component/form member are relevant too, including
 // references chained through a control outside the fragment itself.
 for(const id of pending)for(const next of edges.get(id)||[])if(!closure.has(next)){closure.add(next);pending.push(next);}
 const controls=o.controls.filter(c=>closure.has(c.instanceId)),scoped={...o,controls},fallback=modeStructureReader(scoped,'fragment');
 const modes:BrowserBranchConditionsAssessment=o.ownerDependencies&&!graph?{assessment:{status:'unavailable',reason:'owner_dependency_graph_invalid'}}:[...closure].some(id=>incomplete.has(id))?{assessment:{status:'unavailable',reason:'related_reference_incomplete'}}:assessBrowserReviewBranchConditions(target,scoped,c=>{
  const nodes=f.nodes.filter(n=>n.instanceId===c.instanceId);
  // Full fragment bytes and relative position identify an observed mode. They
  // do not turn an unkeyed business row into a portable record.
  if(nodes.length===1&&!(c.structuralItem&&!c.structuralItem.recordKey))return {policy:'selector-fragment-reference/v1',
   key:hash({owner:f.owner,path:nodes[0].path,tag:c.tag}),ownerLocalId:target.localId,ownerNodes:f.nodes.length,fragmentNodes:f.nodes.length};
  return fallback(c);
 });
 const external=observed.filter(({c})=>!controls.includes(c)).map(({c,state})=>({
  tag:c.tag,role:c.role,name:c.label||c.name,state,readiness:c.readiness,stableKey:c.stableKey,identityScope:c.identityScope,
  binding:c.identityContext,record:c.structuralItem,attributes:c.reviewBinding?.attributes,
  references:c.classificationBinding?.references,ancestry:c.reviewReuseBinding?.ancestors,
 }));
 // Selector/record instance IDs may make this evidence differ. That creates a
 // context-recheck opportunity; it does not rename the local operation.
 const context=canonical({policy:'fragment-sampling-context/v1',externalModes:external,
  ancestors:target.reviewReuseBinding?.ancestors,modeInventory:o.ownerDependencies?.inventoryComplete??null});
 return {modes,context};
 };
}
