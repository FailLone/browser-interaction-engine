import { canonical, hash } from '@interaction/core';
import { formBinding } from './util.js';
import type { Control, Observation } from './types.js';

type Node = NonNullable<Control['classificationBinding']>['nodes'][number];
export interface ModeStructureReference {
  policy:'selector-structural-reference/v1'; key:string;
  ownerLocalId:string; ownerNodes:number; fragmentNodes:number;
}
const idrefs=new Set(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','aria-details','aria-errormessage','headers','list','form']);
// Instance IDs connect ONE captured tree. They never identify a portable node.
const ownerAnchor=(c:Control)=>c.stableKey||c.identityContext?.scope||c.identityContext?.binding
  ?canonical({tag:c.tag,role:c.role,name:c.name,label:c.label,key:c.stableKey,
    context:{scope:c.identityContext?.scope,binding:c.identityContext?.binding},form:formBinding(c)}) : undefined;

/** Complete retained trees can disambiguate a MODE reference even while core
 * identity is unresolved. This grants neither target identity nor execution.
 * A fresh reader is owned by one synchronous projection; no global cache or
 * additional capture/history read. Symmetric nodes never get ordinal IDs. */
export function modeStructureReader(o:Observation) {
  const instances=new Map<string,Control[]>(),anchors=new Map<string,Control[]>();
  for(const c of o.controls){
    instances.set(c.instanceId,[...instances.get(c.instanceId)||[],c]);
    const key=ownerAnchor(c);if(key)anchors.set(key,[...anchors.get(key)||[],c]);
  }
  const owners=o.controls.filter(c=>c.classificationBinding?.nodes.length);
  const containing=new Map<string,Control[]>();
  for(const owner of owners)for(const node of owner.classificationBinding!.nodes)
    if(node.instanceId!==owner.instanceId&&instances.has(node.instanceId))containing.set(node.instanceId,[...containing.get(node.instanceId)||[],owner]);
  type Model={ownerKey:string;root:Node;nodes:Map<string,Node>;children:Map<string,Node[]>;
    semantic:Map<string,string>;guard:Map<string,string>;counts:Map<string,number>;sizes:Map<string,number>;anchorCounts:Map<string,number>;
    atoms:Map<string,unknown>};
  const models=new Map<Control,Model|undefined>();
  const model=(owner:Control):Model|undefined=>{
    if(models.has(owner))return models.get(owner);models.set(owner,undefined);
    const binding=owner.classificationBinding!,ownerKey=ownerAnchor(owner);
    // Incomplete rivals still count: filtering them out would invent uniqueness.
    if(!ownerKey||anchors.get(ownerKey)?.length!==1||owner.hypothesisId||owner.identityScope==='instance'
      ||owner.structuralItem&&!owner.structuralItem.recordKey||binding.truncated||binding.nodes.length>200)return;
    const nodes=new Map(binding.nodes.map(n=>[n.instanceId,n])),root=binding.nodes[0];
    if(nodes.size!==binding.nodes.length||root.instanceId!==owner.instanceId||nodes.has(root.parentInstanceId))return;
    const children=new Map<string,Node[]>();
    for(const n of binding.nodes){
      if(n!==root&&!nodes.has(n.parentInstanceId))return;
      children.set(n.parentInstanceId,[...children.get(n.parentInstanceId)||[],n]);
      const controls=instances.get(n.instanceId)||[];
      if(controls.length>1||controls.some(c=>c.tag!==n.tag||c.reviewBinding?.parentInstanceId!==n.parentInstanceId))return;
    }
    // An IDREF is a captured edge, not a matching discriminator based on its ID.
    const ids=new Map<string,Node[]>();for(const n of binding.nodes)if(n.attributes.id)ids.set(n.attributes.id,[...ids.get(n.attributes.id)||[],n]);
    const references=new Map(binding.references?.map(ref=>[ref.id,ref]));
    for(const n of binding.nodes)for(const [attribute,value] of Object.entries(n.attributes))if(idrefs.has(attribute)){
      for(const id of value.split(/\s+/).filter(Boolean)){
        const matches=ids.get(id)||[],ref=references.get(id);
        if(matches.length!==1||ref?.ambiguous||ref?.missing||ref?.targetInstanceId&&ref.targetInstanceId!==matches[0].instanceId)return;
      }
    }
    const semantic=new Map<string,string>(),guard=new Map<string,string>(),counts=new Map<string,number>(),sizes=new Map<string,number>(),anchorCounts=new Map<string,number>(),atoms=new Map<string,unknown>();
    const visiting=new Set<string>();let invalid=false;
    const visit=(n:Node):void=>{
      if(semantic.has(n.instanceId))return;
      if(visiting.has(n.instanceId)){invalid=true;return;}visiting.add(n.instanceId);
      const control=instances.get(n.instanceId)?.[0],attributes={...n.attributes};
      // Only modes retained separately by branch-conditions may leave the tree
      // signature. Other attributes (data-mode, disabled, readonly, href, etc.) stay.
      for(const [attribute,value] of [['aria-expanded',control?.expanded],['aria-pressed',control?.pressed],['aria-checked',control?.checked]] as const){
        if(value!==null&&value!==undefined&&attribute in attributes){
          if(attributes[attribute]!==String(value)){invalid=true;return;}delete attributes[attribute];
        }
      }
      delete attributes.style;
      const portable=Object.fromEntries(Object.entries(attributes).filter(([key])=>!['id','class'].includes(key)&&!idrefs.has(key)));
      const kids=children.get(n.instanceId)||[];for(const child of kids)visit(child);if(invalid)return;
      const key=hash({tag:n.tag,attributes:portable,children:kids.map(c=>semantic.get(c.instanceId)!).sort()});
      semantic.set(n.instanceId,key);counts.set(key,(counts.get(key)||0)+1);
      guard.set(n.instanceId,hash({tag:n.tag,attributes,children:kids.map(c=>guard.get(c.instanceId)!).sort()}));
      atoms.set(n.instanceId,{tag:n.tag,attributes});sizes.set(n.instanceId,1+kids.reduce((sum,c)=>sum+sizes.get(c.instanceId)!,0));
      anchorCounts.set(n.instanceId,Number(['href','data-testid','data-test','aria-label','name'].some(key=>!!portable[key]))+kids.reduce((sum,c)=>sum+anchorCounts.get(c.instanceId)!,0));
      visiting.delete(n.instanceId);
    };
    visit(root);if(invalid||semantic.size!==nodes.size)return;
    const value={ownerKey,root,nodes,children,semantic,guard,counts,sizes,anchorCounts,atoms};models.set(owner,value);return value;
  };
  const cache=new Map<Control,ModeStructureReference|undefined>();
  return (target:Control):ModeStructureReference|undefined=>{
    if(cache.has(target))return cache.get(target);cache.set(target,undefined);
    if(o.gaps.some(g=>g.critical)||target.identityScope==='instance'||target.structuralItem&&!target.structuralItem.recordKey
      ||instances.get(target.instanceId)?.length!==1||o.controls.filter(c=>c.localId===target.localId).length!==1)return;
    const candidates=(containing.get(target.instanceId)||[]).map(owner=>({owner,tree:model(owner)})).filter(row=>!!row.tree)
      .sort((a,b)=>a.tree!.nodes.size-b.tree!.nodes.size);
    if(!candidates.length||candidates[1]?.tree!.nodes.size===candidates[0].tree!.nodes.size)return;
    const tree=candidates[0].tree!,owner=candidates[0].owner;
    let fragment=tree.nodes.get(target.instanceId)!;
    const path:string[]=[tree.semantic.get(fragment.instanceId)!];
    // Smallest uniquely anchored fragment: deleting a sibling record must not
    // rename the surviving record. A new indistinguishable rival invalidates it.
    while(fragment!==tree.root){
      const signature=tree.semantic.get(fragment.instanceId)!;
      // The target's own name must not become a new anchor when its twin leaves.
      if(tree.anchorCounts.get(fragment.instanceId)!>tree.anchorCounts.get(target.instanceId)!&&tree.counts.get(signature)===1)break;
      const parent=tree.nodes.get(fragment.parentInstanceId)!;
      if((tree.children.get(parent.instanceId)||[]).filter(c=>tree.semantic.get(c.instanceId)===signature).length!==1)return;
      fragment=parent;path.unshift(tree.semantic.get(fragment.instanceId)!);
    }
    if(fragment===tree.root)return;
    const record=(n:Node)=>['li','tr'].includes(n.tag)||['listitem','row','option','treeitem'].includes(n.attributes.role);
    const collection=(n:Node)=>['ul','ol','tbody','thead','table'].includes(n.tag)||['list','listbox','grid','tree','rowgroup'].includes(n.attributes.role);
    const ancestry:unknown[]=[];let child=fragment,ancestor=tree.nodes.get(child.parentInstanceId);
    while(ancestor){
      // Preserve outside-branch context, including sibling links naming a group.
      // Other list records do not rename this record; all their modes remain in
      // the branch projection, and indistinguishable record twins fail above.
      const siblings=(tree.children.get(ancestor.instanceId)||[]).filter(n=>n!==child&&!(collection(ancestor!)&&record(child)&&record(n)));
      ancestry.push({node:tree.atoms.get(ancestor.instanceId),siblings:siblings.map(n=>tree.guard.get(n.instanceId)!).sort()});
      child=ancestor;ancestor=tree.nodes.get(child.parentInstanceId);
    }
    const result:ModeStructureReference={policy:'selector-structural-reference/v1',key:hash({policy:'selector-structural-reference/v1',owner:tree.ownerKey,
      ancestry,fragment:tree.guard.get(fragment.instanceId),path}),ownerLocalId:owner.localId,ownerNodes:tree.nodes.size,fragmentNodes:tree.sizes.get(fragment.instanceId)!};
    cache.set(target,result);return result;
  };
}
