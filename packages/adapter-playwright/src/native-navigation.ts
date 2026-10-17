import { canonical, hash, type CorrespondenceHint } from '@interaction/core';
import { classificationCorrespondenceConditions } from './classification-correspondence.js';
import { formBinding } from './util.js';
import type { Control, Observation } from './types.js';

type Tree = NonNullable<Control['classificationBinding']>;
type Node = Tree['nodes'][number];
const idrefs=new Set(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','aria-details','aria-errormessage','headers','list','form']);
const row=(n:Pick<Node,'tag'|'attributes'>)=>n.tag==='li'||['listitem','row','option','treeitem'].includes(n.attributes.role)||'data-row-key' in n.attributes||'data-item-key' in n.attributes;
const semanticOwner=(n:Pick<Node,'tag'|'attributes'>)=>['nav','ul','ol'].includes(n.tag)||['navigation','menu','menubar','list'].includes(n.attributes.role);
const anchor=(c:Control)=>c.stableKey||c.identityContext?.scope||c.identityContext?.binding||c.label
  ?canonical({tag:c.tag,role:c.role,name:c.label||c.name,key:c.stableKey,scope:c.identityContext?.scope,binding:c.identityContext?.binding,form:formBinding(c)}):undefined;

/** Captured baseURI resolution is authoritative; re-resolving against the page
 * URL would silently change links in documents with a <base> element. */
function destination(c:Control,n:Node):string|undefined {
  if(c.tag!=='a'||c.role!=='link'||n.tag!=='a'||!n.attributes.href||n.attributes.href.startsWith('#')
    ||c.reviewBinding?.attributes.href!==n.attributes.href||!c.identityContext?.evidence.includes('link-destination/v1'))return;
  const basis=c.actionBasis?.click;
  if(basis?.status!=='supported'||!basis.evidence.some(e=>e.source==='html'&&e.rule==='hyperlink/v1'&&e.facts.href===n.attributes.href))return;
  try{
    const rows:unknown=JSON.parse(c.identityContext.binding||'');if(!Array.isArray(rows))return;
    const links=rows.filter(r=>Array.isArray(r)&&r[0]==='link-destination');
    if(links.length!==1||links[0].length!==3||typeof links[0][1]!=='string'||links[0][2]!== (n.attributes.target||'')
      ||!['http:','https:'].includes(new URL(links[0][1]).protocol))return;
    return links[0][1];
  }catch{return;}
}

/** A query-local reader, never a control identity or replay grant. The whole
 * bounded owner projection is retained deliberately: incomplete rivals and
 * changes outside the target row cannot manufacture an equivalent operation. */
export function nativeNavigationOperationReader(o:Observation) {
  const instances=new Map<string,Control[]>(),locals=new Map<string,number>(),anchors=new Map<string,number>();
  for(const c of o.controls){instances.set(c.instanceId,[...instances.get(c.instanceId)||[],c]);locals.set(c.localId,(locals.get(c.localId)||0)+1);
    const key=anchor(c);if(key)anchors.set(key,(anchors.get(key)||0)+1);}
  const models=new Map<Control,{key:string;nodes:Map<string,Node>;destinations:Map<string,string>}|undefined>();
  const model=(owner:Control)=>{
    if(models.has(owner))return models.get(owner);models.set(owner,undefined);
    const tree=owner.classificationBinding,key=anchor(owner);
    if(!tree||!key||anchors.get(key)!==1||owner.hypothesisId||owner.identityScope==='instance'||owner.structuralItem
      ||!owner.reviewReuseBinding||tree.truncated||!tree.nodes.length||tree.nodes.length>200)return;
    const nodes=new Map(tree.nodes.map(n=>[n.instanceId,n])),root=tree.nodes[0];
    if(nodes.size!==tree.nodes.length||root.instanceId!==owner.instanceId||nodes.has(root.parentInstanceId))return;
    // Validate connectivity and cycles independently of serialized node order.
    for(const n of nodes.values()){
      const seen=new Set<string>();let current:Node|undefined=n;
      while(current&&current!==root){if(seen.has(current.instanceId))return;seen.add(current.instanceId);current=nodes.get(current.parentInstanceId);}
      if(current!==root)return;
      const controls=instances.get(n.instanceId)||[];
      if(controls.length>1||controls.some(c=>c.tag!==n.tag||c.reviewBinding?.parentInstanceId!==n.parentInstanceId
        ||Object.entries(c.reviewBinding.attributes).some(([k,v])=>n.attributes[k]!==v)))return;
    }
    // Reuse the classification projection's IDREF normalization, but require
    // positive, complete relationships here. Missing is not a semantic owner.
    const references=tree.references||[],refIds=new Set(references.map(r=>r.id));
    if(refIds.size!==references.length)return;
    const allNodes=[...nodes.values()];
    for(const ref of references){
      if(ref.missing||ref.ambiguous)return;
      if(ref.target){
        const extra=ref.target;if(extra.truncated||!extra.nodes.length||extra.nodes.length>200||extra.nodes[0].instanceId!==ref.targetInstanceId)return;
        const external=new Map(extra.nodes.map(n=>[n.instanceId,n]));if(external.size!==extra.nodes.length)return;
        for(const n of extra.nodes){const seen=new Set<string>();let current:Node|undefined=n;
          while(current&&current!==extra.nodes[0]){if(seen.has(current.instanceId))return;seen.add(current.instanceId);current=external.get(current.parentInstanceId);}
          if(current!==extra.nodes[0])return;}
        allNodes.push(...extra.nodes);
      }
    }
    if(allNodes.length>400)return;
    const byId=new Map<string,Node[]>();for(const n of allNodes)if(n.attributes.id)byId.set(n.attributes.id,[...byId.get(n.attributes.id)||[],n]);
    const checked=[...allNodes,...owner.reviewReuseBinding.ancestors];
    for(const n of checked)for(const [attribute,value] of Object.entries(n.attributes))if(idrefs.has(attribute))for(const id of value.split(/\s+/).filter(Boolean)){
      const matches=byId.get(id)||[],ref=references.find(r=>r.id===id);
      if(matches.length!==1||ref?.targetInstanceId&&ref.targetInstanceId!==matches[0].instanceId)return;
      // An external relationship must have an explicit captured lookup result.
      if(!nodes.has(matches[0].instanceId)&&!ref)return;
    }
    const destinations=new Map<string,string>();
    for(const n of nodes.values())if(n.tag==='a'&&'href' in n.attributes){const c=instances.get(n.instanceId)?.[0],value=c&&destination(c,n);if(!value)return;destinations.set(n.instanceId,value);}
    const projection=classificationCorrespondenceConditions(owner,o);if(!projection)return;
    const result={key:hash({owner:key,conditions:projection.conditionKey}),nodes,destinations};models.set(owner,result);return result;
  };
  return (target:Control):CorrespondenceHint|undefined=>{
    if(target.tag!=='a'||target.role!=='link'||target.hypothesisId||target.readiness||locals.get(target.localId)!==1||instances.get(target.instanceId)?.length!==1
      ||o.gaps.some(g=>g.critical)||Object.values(o.context).some(v=>v.status!=='known'))return;
    const candidates=o.controls.filter(c=>c!==target&&c.classificationBinding?.nodes.some(n=>n.instanceId===target.instanceId))
      .map(owner=>({owner,tree:model(owner)})).filter((r):r is {owner:Control;tree:NonNullable<ReturnType<typeof model>>}=>!!r.tree)
      .sort((a,b)=>a.tree.nodes.size-b.tree.nodes.size);
    if(!candidates.length||candidates[1]?.tree.nodes.size===candidates[0].tree.nodes.size)return;
    const {owner,tree}=candidates[0],node=tree.nodes.get(target.instanceId)!,value=tree.destinations.get(target.instanceId);
    if(!value||[...tree.destinations.values()].filter(v=>v===value).length!==1)return;
    const parent=tree.nodes.get(node.parentInstanceId),list=parent&&tree.nodes.get(parent.parentInstanceId);
    if(!parent||parent.tag!=='li'||!list||!['ul','ol'].includes(list.tag))return;
    const chain:Node[]=[];let n:Node|undefined=list;while(n){chain.push(n);n=tree.nodes.get(n.parentInstanceId);}
    // Business/virtual records outside the native navigation row remain barred.
    if(chain.some(row)||owner.reviewReuseBinding!.ancestors.some(row))return;
    const named=[...chain,...owner.reviewReuseBinding!.ancestors].some(n=>semanticOwner(n)&&(!!n.attributes['aria-label']?.trim()
      ||(n.attributes['aria-labelledby']||'').split(/\s+/).filter(Boolean).some(id=>{
        const ref=owner.classificationBinding!.references?.find(r=>r.id===id),internal=[...tree.nodes.values()].find(node=>node.attributes.id===id);
        return !!(ref?.target?.text.trim()||internal&&instances.get(internal.instanceId)?.[0]?.name.trim());
      })));
    if(!named)return;
    return {key:`browser-native-navigation:v1:${hash({owner:tree.key,destination:value,tag:target.tag,role:target.role,name:target.name,label:target.label,
      attributes:target.reviewBinding?.attributes,context:target.identityContext&&{scope:target.identityContext.scope,binding:target.identityContext.binding}})}`,
      policy:'browser-native-navigation-v1',requiresUniqueTarget:true,
      evidence:['complete-semantic-navigation-owner','complete-classification-subtree','captured-idref-topology','unique-native-navigation-destination','operation-reference-not-control-identity'],
      invalidatedBy:['changed-owner-or-subtree','changed-or-missing-idref','nonunique-navigation-destination','changed-navigation-attributes','changed-operation-conditions','changed-declared-context']};
  };
}

export function nativeNavigationOperationReference(c:Control,o:Pick<Observation,'url'>):CorrespondenceHint|undefined {
  // The public legacy hint also accepts URL-only observations. Such callers
  // cannot supply this stronger proof and retain their original behavior.
  if(c.tag!=='a'||c.role!=='link'||c.hypothesisId||c.readiness||c.actionBasis?.click?.status!=='supported')return;
  const full=o as Partial<Observation>;
  return Array.isArray(full.controls)&&Array.isArray(full.regions)&&Array.isArray(full.gaps)&&full.context
    ?nativeNavigationOperationReader(full as Observation)(c):undefined;
}
