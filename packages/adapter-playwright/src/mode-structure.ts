import { canonical, hash } from '@interaction/core';
import { formBinding } from './util.js';
import type { Control, Observation } from './types.js';

type Node = NonNullable<Control['classificationBinding']>['nodes'][number];
export interface ModeStructureReference {
  policy:'selector-structural-reference/v2'; key:string;
  ownerLocalId:string; ownerNodes:number; fragmentNodes:number;
}
const idrefs=new Set(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','aria-details','aria-errormessage','headers','list','form']);
// Instance IDs connect ONE captured tree. They never identify a portable node.
const record=(n:Pick<Node,'tag'|'attributes'>)=>['li','tr'].includes(n.tag)||['listitem','row','option','treeitem'].includes(n.attributes.role)
  ||'data-row-key' in n.attributes||'data-item-key' in n.attributes;

/** Complete retained trees can disambiguate a MODE reference even while core
 * identity is unresolved. This grants neither target identity nor execution.
 * A fresh reader is owned by one synchronous projection; no global cache or
 * additional capture/history read. Symmetric nodes never get ordinal IDs. */
export function modeStructureReader(o:Observation) {
  const instances=new Map<string,Control[]>(),anchors=new Map<string,Control[]>(),direct=new Map<string,Control[]>(),localCounts=new Map<string,number>();
  for(const c of o.controls){
    instances.set(c.instanceId,[...instances.get(c.instanceId)||[],c]);
    localCounts.set(c.localId,(localCounts.get(c.localId)||0)+1);
    if(c.reviewBinding)direct.set(c.reviewBinding.parentInstanceId,[...direct.get(c.reviewBinding.parentInstanceId)||[],c]);
  }
  const ownerKeys=new Map<Control,string|undefined>();
  const ownerAnchor=(c:Control)=>{
    if(ownerKeys.has(c))return ownerKeys.get(c);
    // contentName(owner) includes visible descendants when a menu opens. A
    // unique direct disclosure supplies its OWN captured title, never a prefix
    // guessed from that aggregate text. Complete containment is checked below.
    const titles=(direct.get(c.instanceId)||[]).filter(t=>t.tag==='button'&&typeof t.expanded==='boolean'
      &&(t.label||t.name)&&!t.hypothesisId&&t.identityScope!=='instance'&&!t.structuralItem);
    const title=!c.label&&titles.length===1?titles[0]:undefined;
    const key=c.stableKey||c.identityContext?.scope||c.identityContext?.binding
      ?canonical({tag:c.tag,role:c.role,name:c.label||(!title?c.name:undefined),key:c.stableKey,
        disclosure:title&&{tag:title.tag,role:title.role,name:title.label||title.name,key:title.stableKey},
        context:{scope:c.identityContext?.scope,binding:c.identityContext?.binding},form:formBinding(c)}):undefined;
    ownerKeys.set(c,key);return key;
  };
  for(const c of o.controls){
    const key=ownerAnchor(c);if(key)anchors.set(key,[...anchors.get(key)||[],c]);
  }
  const owners=o.controls.filter(c=>c.classificationBinding?.nodes.length);
  const containing=new Map<string,Control[]>();
  for(const owner of owners)for(const node of owner.classificationBinding!.nodes)
    if(node.instanceId!==owner.instanceId&&instances.has(node.instanceId))containing.set(node.instanceId,[...containing.get(node.instanceId)||[],owner]);
  type Model={ownerKey:string;root:Node;nodes:Map<string,Node>;children:Map<string,Node[]>;
    semantic:Map<string,string>;guard:Map<string,string>;counts:Map<string,number>;sizes:Map<string,number>;anchorCounts:Map<string,number>;
    atoms:Map<string,unknown>;destinations:Map<Node,string|undefined>;collections:Map<Node,Map<string,number>|undefined>};
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
    if(!owner.label){
      const titles=(direct.get(owner.instanceId)||[]).filter(t=>t.tag==='button'&&typeof t.expanded==='boolean'
        &&(t.label||t.name)&&!t.hypothesisId&&t.identityScope!=='instance'&&!t.structuralItem);
      if(titles.length===1){
        const title=nodes.get(titles[0].instanceId);if(!title||title.parentInstanceId!==root.instanceId)return;
        const pending=[...(children.get(title.instanceId)||[])],seen=new Set<string>();
        for(const n of pending){
          if(seen.has(n.instanceId)||record(n)||['dialog','region','menu','listbox'].includes(n.attributes.role))return;
          seen.add(n.instanceId);pending.push(...children.get(n.instanceId)||[]);
        }
      }
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
    const value:Model={ownerKey,root,nodes,children,semantic,guard,counts,sizes,anchorCounts,atoms,destinations:new Map(),collections:new Map()};models.set(owner,value);return value;
  };
  const cache=new Map<Control,ModeStructureReference|undefined>();
  return (target:Control):ModeStructureReference|undefined=>{
    if(cache.has(target))return cache.get(target);cache.set(target,undefined);
    if(o.gaps.some(g=>g.critical)||target.structuralItem&&!target.structuralItem.recordKey
      ||instances.get(target.instanceId)?.length!==1||localCounts.get(target.localId)!==1)return;
    const candidates=(containing.get(target.instanceId)||[]).map(owner=>({owner,tree:model(owner)})).filter(row=>!!row.tree)
      .sort((a,b)=>a.tree!.nodes.size-b.tree!.nodes.size);
    if(!candidates.length||candidates[1]?.tree!.nodes.size===candidates[0].tree!.nodes.size)return;
    const tree=candidates[0].tree!,owner=candidates[0].owner;
    // A narrowly defined NAVIGATION disclosure can have a portable functional
    // mode reference even when capture correctly forbids business-record
    // identity reuse. Apply the same proof on both sides, independent of scope.
    // Arbitrary virtual rows, checkboxes, presses and unkeyed records stay barred.
    const navigation=()=>{
      if(target.role!=='button'||typeof target.expanded!=='boolean'||target.checked!=null||target.pressed!=null
        ||target.selected.length||target.structuralItem||!target.label)return;
      const ancestors=owner.reviewReuseBinding?.ancestors||[];
      if(!ancestors.some(a=>(a.tag==='nav'||a.attributes.role==='navigation')&&!!a.label)
        ||ancestors.some(record))return;
      const destination=(n:Node):string|undefined=>{
        if(tree.destinations.has(n))return tree.destinations.get(n);tree.destinations.set(n,undefined);
        if(n.tag!=='a'||!n.attributes.href||n.attributes.href.startsWith('#'))return;
        const c=instances.get(n.instanceId)?.[0];
        if(!c||c.reviewBinding?.attributes.href!==n.attributes.href||!c.identityContext?.evidence.includes('link-destination/v1'))return;
        try{
          const rows:unknown=JSON.parse(c.identityContext.binding||'');
          if(!Array.isArray(rows))return;
          const links=rows.filter(row=>Array.isArray(row)&&row[0]==='link-destination');
          if(links.length!==1||typeof links[0][1]!=='string'||!['http:','https:'].includes(new URL(links[0][1]).protocol))return;
          const key=canonical(links[0]);tree.destinations.set(n,key);return key; // Captured baseURI resolution; preserve query, fragment and target.
        }catch{return;}
      };
      const rowDestination=(row:Node)=>{
        const links=(tree.children.get(row.instanceId)||[]).filter(n=>n.tag==='a');
        return links.length===1?destination(links[0]):undefined;
      };
      const collectionDestinations=(list:Node)=>{
        if(tree.collections.has(list))return tree.collections.get(list);tree.collections.set(list,undefined);
        const counts=new Map<string,number>();
        for(const row of tree.children.get(list.instanceId)||[])if(record(row)){
          const links=(tree.children.get(row.instanceId)||[]).filter(n=>n.tag==='a');
          // Missing rivals do not prove uniqueness; multi-link rivals contribute
          // EVERY destination, including one also used by the candidate row.
          if(row.tag!=='li'||!links.length)return;
          for(const link of links){const key=destination(link);if(!key)return;counts.set(key,(counts.get(key)||0)+1);}
        }
        tree.collections.set(list,counts);return counts;
      };
      const rows:string[]=[];let child=tree.nodes.get(target.instanceId)!,parent=tree.nodes.get(child.parentInstanceId);
      while(parent){
        if(record(parent)){
          const list=tree.nodes.get(parent.parentInstanceId),key=rowDestination(parent);
          if(parent.tag!=='li'||!list||!['ul','ol'].includes(list.tag)||child.tag==='a'||!key)return;
          if(collectionDestinations(list)?.get(key)!==1)return;
          rows.push(key);
        }
        child=parent;parent=tree.nodes.get(parent.parentInstanceId);
      }
      return rows.length?rows:undefined;
    };
    const navigationRecords=navigation();
    if(target.identityScope==='instance'&&!navigationRecords)return;
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
    // Capture may also establish ownership outside this subtree. Retain it as
    // a condition, never use absent ancestry to discard a competing owner.
    const ownerAncestry=owner.reviewReuseBinding?.ancestors.map(({tag,attributes,label})=>({tag,attributes,label}));
    const result:ModeStructureReference={policy:'selector-structural-reference/v2',key:hash({policy:'selector-structural-reference/v2',owner:tree.ownerKey,ownerAncestry,
      navigationRecords,ancestry,fragment:tree.guard.get(fragment.instanceId),path}),ownerLocalId:owner.localId,ownerNodes:tree.nodes.size,fragmentNodes:tree.sizes.get(fragment.instanceId)!};
    cache.set(target,result);return result;
  };
}
