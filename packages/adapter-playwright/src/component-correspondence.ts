import {localOperationMaterial} from './local-operation-receipt.js';
import {browserTargetReady} from './target-arrival.js';
import {canonical,hash,type ComponentCorrespondenceMaterial} from '@interaction/core';
import {browserTraversalFragments} from './fragment-projection.js';
import {programNavigationAllowed} from './execution-boundary.js';
import type {ActionCandidate,Observation,Session} from './types.js';

const policy='captured-component-pair/v1';
const result=(status:ComponentCorrespondenceMaterial['status'],reason:string):ComponentCorrespondenceMaterial=>({policy,status,reason,evidence:[]});
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

/** Borrow FRAGGEN's complete local tree and relative target coordinate, without
 * its propagation of explored status. Inputs use the host's captured fragments,
 * not VIPS or a hand-written approximation of the Java oracle. */
export function browserComponentCorrespondence(source:ActionCandidate,before:Observation,sourceSession:Session,
  action:ActionCandidate,current:Observation,session:Session):ComponentCorrespondenceMaterial {
  if(before.coveragePolicy!=='finite-ui-v1'||current.coveragePolicy!=='finite-ui-v1'
    ||sourceSession.options.executionPolicy!=='observed-ui'||session.options.executionPolicy!=='observed-ui'
    ||!programNavigationAllowed(sourceSession.options.executionBoundary,source,before)
    ||!programNavigationAllowed(session.options.executionBoundary,action,current))return result('unavailable','component_authority_unavailable');
  if(before.url!==current.url||before.ruleVersion!==current.ruleVersion||!equal(before.context,current.context)
    ||source.kind!==action.kind||!equal(source.value,action.value))return result('conflict','component_context_or_operation_changed');
  const project=(a:ActionCandidate,o:Observation)=>{
    const c=o.controls.find(c=>c.localId===a.localId);
    if(!c||!c.visible||c.readiness||c.formOwner||!c.enabled||c.hypothesisId||a.basis?.status!=='supported')return;
    // The captured operation may be settled while an independent field keeps
    // changing. Reuse the existing local readiness and complete dependency
    // contracts; never infer readiness from a same-name sibling or page label.
    if(!o.stable&&(!browserTargetReady(a,o)||!localOperationMaterial(o,c.localId).key))return;
    const fragments=browserTraversalFragments(o,[a],policy),matches=fragments.flatMap(f=>f.candidates.filter(x=>x.actionId===a.id).map(candidate=>({f,candidate})));
    if(matches.length!==1)return;
    const {f,candidate}=matches[0],owner=JSON.parse(f.owner),guard=JSON.parse(candidate.guard);
    // Count every captured rival, including disabled targets. Availability must
    // never manufacture target uniqueness. No first-match text/ID resolver.
    const region=o.regionCandidates?.find(r=>r.id===f.regionId)?.fragment;
    if(!region||o.controls.filter(other=>region.nodes.some(n=>n.instanceId===other.instanceId)
      &&other.tag===c.tag&&other.role===c.role&&(other.label||other.name)===(c.label||c.name)).length!==1)return;
    // A structural mode hash includes the owner's descendants. Rebind only a
    // uniquely captured selector inside this same complete fragment to its
    // relative coordinate and full business attributes. External references
    // retain the original exact guard. This allows new non-mode children while
    // retaining all selector states, records and IDREF topology.
    for(const mode of guard.modes){
      let binding;try{binding=JSON.parse(mode.binding);}catch{continue;}
      if(binding.policy!=='selector-fragment-reference/v1')continue;
      const selector=binding.selector,targets=o.controls.filter(x=>region.nodes.some(n=>n.instanceId===x.instanceId)
        &&x.tag===selector.tag&&x.role===selector.role&&(x.label||x.name)===selector.name&&x.constraints.type===selector.type);
      if(targets.length!==1)return;
      const node=region.nodes.find(n=>n.instanceId===targets[0].instanceId)!,content=owner.content.find((n:any)=>n.path===node.path);
      mode.binding=canonical({policy:'component-relative-selector/v1',selector,path:node.path,
        attributes:Object.fromEntries(Object.entries(content.attributes).filter(([k])=>k!=='class'&&k!=='style'))});
    }
    const boundary=(o.boundaries||[]).map(b=>({name:b.name,kind:o.overlays?.find(x=>x.key===b.key)?.kind}));
    if(boundary.some(b=>!b.name||!b.kind))return;
    const material=canonical({policy,url:o.url,context:o.context,owner,structure:JSON.parse(f.structure),path:candidate.path,
      guard,operation:JSON.parse(candidate.operation),boundary,basis:a.basis,risk:a.risk});
    // A bounded request is complete or unavailable; never truncate business data.
    if(Buffer.byteLength(material)>16000)return;
    return {material,owner,guard,boundary,basis:a.basis,risk:a.risk,path:candidate.path,structure:f.structure};
  };
  const a=project(source,before),b=project(action,current);
  if(!a||!b)return result('unavailable','component_complete_unique_material_required');
  // The original guard retains records, destinations, parameters, IDREF topology,
  // modes, event metadata, options and constraints. The model cannot override it.
  if(!equal(a.guard,b.guard)||!equal(a.boundary,b.boundary)||!equal(a.basis,b.basis)||a.risk!==b.risk)
    return result('conflict','component_operation_conditions_changed');
  if(a.owner.owner!==b.owner.owner)return result('conflict','component_owner_scope_changed');
  // Common local business attributes remain hard constraints. New descendants
  // are new work; they do not by themselves imply a different logical parent.
  const attrs=(n:{attributes:Record<string,unknown>})=>Object.fromEntries(Object.entries(n.attributes).filter(([k])=>k!=='class'&&k!=='style'));
  const oldNodes=new Map<string,any>(a.owner.content.map((n:any)=>[n.path,n]));
  for(const n of b.owner.content){const old=oldNodes.get(n.path);if(old&&old.tag===n.tag&&!equal(attrs(old),attrs(n)))
    return result('conflict','component_local_relationship_or_business_attributes_changed');}
  const same=a.material===b.material;
  return {policy,status:same?'same':'uncertain',reason:same?'complete_local_component_equal':'complete_local_component_changed',
    sourceMaterial:a.material,targetMaterial:b.material,
    conditionKey:hash({policy,url:current.url,context:current.context,guard:b.guard,boundary:b.boundary,basis:b.basis,risk:b.risk}),
    evidence:['complete-host-fragment','conditional-local-id-idref-binding','unique-target-within-owner','exact-operation-and-related-modes','pair-local-no-transitive-identity']};
}
