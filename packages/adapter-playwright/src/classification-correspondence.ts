import {classificationStructure} from './classification-structure.js';
import { hash } from '@interaction/core';
import { controlClassificationConditions } from './control-classification.js';
import type { Control, Observation } from './types.js';

const idrefs=new Set(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','aria-details','aria-errormessage','headers','list','form']);
/** Portable comparison of complete captured classification facts. It changes no
 * observation, identity or stored review key. DOM IDREF renaming is allowed only
 * through captured relationships, including explicit missing/unique targets. */
export function classificationCorrespondenceConditions(c:Control,o:Observation) {
  const exact=controlClassificationConditions(c,o),structure=classificationStructure(c,o);
  if(!exact||!structure||structure.truncated||!structure.nodes.length||!c.reviewReuseBinding||!c.visible)return;
  const nodes=structure.nodes,instances=new Map(nodes.map((n,i)=>[n.instanceId,`node:${i}`]));
  if(instances.size!==nodes.length||nodes[0].instanceId!==c.instanceId)return;
  instances.set(nodes[0].parentInstanceId,'parent');
  for(let i=1;i<nodes.length;i++)if(!instances.has(nodes[i].parentInstanceId))return;
  const ids=new Map<string,string>(),referenceFacts:unknown[]=[];
  const referenced=[...new Set(nodes.flatMap(n=>Object.entries(n.attributes).filter(([k])=>idrefs.has(k)).flatMap(([,v])=>v.trim().split(/\s+/).filter(Boolean))))];
  for(const id of referenced){
    const internal=nodes.filter(n=>n.attributes.id===id),ref=structure.references?.find(r=>r.id===id);
    if(internal.length>1||ref?.ambiguous)return;
    // Legacy complete subtrees prove internal relationships. External/missing
    // relationships require their own capture; omission is never nonexistence.
    if(internal.length===1){if(ref?.missing||ref?.targetInstanceId&&ref.targetInstanceId!==internal[0].instanceId)return;ids.set(id,instances.get(internal[0].instanceId)!);}
    else if(ref?.missing){ids.set(id,`missing:${referenceFacts.length}`);referenceFacts.push({missing:true});}
    else if(ref?.target&&!ref.target.truncated&&ref.target.nodes.length&&ref.targetInstanceId===ref.target.nodes[0].instanceId){
      const index=referenceFacts.length;ids.set(id,`external:${index}`);
      const refs=new Map(ref.target.nodes.map((n,i)=>[n.instanceId,`external:${index}:${i}`]));
      if(refs.size!==ref.target.nodes.length)return;
      refs.set(ref.target.nodes[0].parentInstanceId,'external-parent');
      if(ref.target.nodes.some(n=>!refs.has(n.parentInstanceId)))return;
      referenceFacts.push({text:ref.target.text,nodes:ref.target.nodes.map(n=>({node:refs.get(n.instanceId),parent:refs.get(n.parentInstanceId),tag:n.tag,attributes:{...n.attributes,...(n.attributes.id===id?{id:`external:${index}`}:{})}}))});
    }else return;
  }
  const attributes=(attrs:Record<string,string>)=>Object.fromEntries(Object.entries(attrs).map(([k,v])=>[k,k==='id'?(ids.get(v)||v):idrefs.has(k)?v.trim().split(/\s+/).filter(Boolean).map(id=>ids.get(id)||`unresolved:${id}`).join(' '):v]));
  const normalize=(value:unknown):unknown=>typeof value==='string'?(instances.get(value)||value):Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)])):value;
  const {instanceId:_form,...form}=c.reviewBinding?.form||{};
  const region=o.regions.find(r=>r.key===c.region);
  const target={tag:c.tag,role:c.role,name:c.name,label:c.label,readOnly:c.readOnly,constraints:exact.target.target.constraints,
    region:region&&{label:region.label,role:region.role},identityContext:c.identityContext&&{scope:c.identityContext.scope,binding:c.identityContext.binding},
    binding:attributes(c.reviewBinding!.attributes),form,formName:c.form,
    list:c.list&&{role:c.list.role,label:c.list.label},record:c.structuralItem&&{template:c.structuralItem.template,slot:c.structuralItem.slot,recordKey:c.structuralItem.recordKey},
    ancestry:c.reviewReuseBinding.ancestors.map(a=>({tag:a.tag,attributes:attributes(a.attributes),label:a.label}))};
  const portable={version:'classification-correspondence/v1',url:o.url,context:o.context,target,basis:normalize(c.actionBasis),hints:normalize(c.interactionHints),editable:c.editable,options:c.options,
    structure:{text:structure.text,nodes:nodes.map(n=>({node:instances.get(n.instanceId),parent:instances.get(n.parentInstanceId),tag:n.tag,attributes:attributes(n.attributes)})),references:referenceFacts}};
  return {identityKey:hash({url:o.url,target}),conditionKey:hash(portable),policy:'classification-correspondence/v1' as const,
    evidence:['unique-captured-target-semantics','complete-classification-subtree','captured-idref-topology','unchanged-classification-conditions']};
}
