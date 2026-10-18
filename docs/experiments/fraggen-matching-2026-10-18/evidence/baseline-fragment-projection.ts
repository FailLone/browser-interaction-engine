import {canonical,hash} from '@interaction/core';
import {browserReviewBranchConditions} from '../../../../packages/adapter-playwright/src/branch-conditions.js';
import type {ActionCandidate,Observation,RegionCandidate} from '../../../../packages/adapter-playwright/src/types.js';

export const fragmentProjectionPolicy='guarded-host-fragments/v1' as const;
export interface BrowserTraversalFragment {
  regionId:string;parentRegionId?:string;structure:string;owner:string;revision:string;
  candidates:{actionId:string;path:string;operation:string;guard:string}[];
}
/** Host segmentation replaces VIPS, not its visual classification. An exact
 * ordered tree is only a comparison index. Full local content, operation,
 * destination, record/slot, selector modes and context guard every mapping. */
export function browserTraversalFragments(o:Observation,actions:readonly ActionCandidate[],authority:string):BrowserTraversalFragment[] {
  if(o.gaps.some(g=>g.critical)||Object.values(o.context).some(v=>v.status!=='known'))return [];
  let origin:string;try{origin=new URL(o.url).origin;}catch{return [];}
  const regions=(o.regionCandidates||[]).filter((r):r is RegionCandidate&{fragment:NonNullable<RegionCandidate['fragment']>}=>r.fragment?.policy==='host-dom-fragment/v1');
  const snapshots:BrowserTraversalFragment[]=regions.map(r=>{
    const f=r.fragment,structure=canonical(f.nodes.map(n=>[n.path,n.tag]));
    const owner=canonical({policy:fragmentProjectionPolicy,origin,authority,ruleVersion:o.ruleVersion,context:o.context,owner:f.owner,
      // Hidden descendant targets matter too: a newly added menu link must
      // invalidate entry pruning before that link becomes visible.
      content:f.nodes.map(n=>({path:n.path,tag:n.tag,attributes:n.attributes,text:n.text}))});
    return {regionId:r.id,parentRegionId:f.parentId,structure,owner,revision:'',candidates:[]};
  });
  for(const action of actions){
    if(!action.localId||action.boundary?.intent==='exit'||['history','navigate','scroll'].includes(action.kind))continue;
    const matches=o.controls.filter(c=>c.localId===action.localId),c=matches[0];
    if(matches.length!==1||!c.reviewBinding||c.readiness||c.hypothesisId||c.formOwner||c.classificationBinding?.truncated
      ||c.classificationBinding?.references?.some(r=>r.missing||r.ambiguous||r.target?.truncated)
      ||c.structuralItem&&!c.structuralItem.recordKey)continue;
    const containers=regions.filter(r=>r.fragment.nodes.some(n=>n.instanceId===c.instanceId));
    const closest=containers.filter(r=>!containers.some(child=>child!==r&&r.fragment.nodes.some(n=>n.instanceId===child.id)));
    if(closest.length!==1)continue;
    const region=closest[0],f=region.fragment,nodes=f.nodes.filter(n=>n.instanceId===c.instanceId);
    if(nodes.length!==1||new Set(f.nodes.map(n=>n.path)).size!==f.nodes.length)continue;
    const references=(c.classificationBinding?.references||[]).map(r=>{
      if(!r.target)return {id:r.id,path:f.nodes.find(n=>n.instanceId===r.targetInstanceId)?.path};
      const index=new Map(r.target.nodes.map((n,i)=>[n.instanceId,i]));
      return {id:r.id,text:r.target.text,nodes:r.target.nodes.map(n=>({tag:n.tag,parent:index.get(n.parentInstanceId)??-1,attributes:n.attributes}))};
    });
    const idrefs=new Set(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','aria-details','aria-errormessage','headers','list','form']);
    const unresolved=Object.entries(c.reviewBinding.attributes).filter(([key])=>idrefs.has(key)).flatMap(([,v])=>v.split(/\s+/).filter(Boolean))
      .some(id=>f.nodes.filter(n=>n.attributes.id===id).length!==1&&!references.some(r=>r.id===id&&('nodes' in r||r.path)));
    if(unresolved||references.some(r=>!('nodes' in r)&&!r.path))continue;
    const modes=browserReviewBranchConditions(c,o);if(!modes)continue;
    const {valid:_,...constraints}=c.constraints;
    const operation=canonical({kind:action.kind,value:action.value});
    const guard=canonical({tag:c.tag,role:c.role,name:c.label||c.name,target:nodes[0].attributes,
      binding:c.identityContext&&{scope:c.identityContext.scope,binding:c.identityContext.binding},
      record:c.structuralItem&&{recordKey:c.structuralItem.recordKey,slot:c.structuralItem.slot,template:c.structuralItem.template},
      events:c.reviewBinding.runtimeEvents,references,constraints,options:c.options,readOnly:c.readOnly,modes:modes.conditions});
    snapshots.find(s=>s.regionId===region.id)!.candidates.push({actionId:action.id,path:nodes[0].path,operation,guard});
  }
  for(const f of snapshots)f.candidates.sort((a,b)=>canonical([a.path,a.operation,a.guard]).localeCompare(canonical([b.path,b.operation,b.guard])));
  for(const f of snapshots)f.revision=hash({policy:fragmentProjectionPolicy,structure:f.structure,owner:f.owner,candidates:f.candidates.map(({actionId,...c})=>c)});
  // Two indistinguishable roots in one capture cannot resolve a relative path.
  const signatures=new Map<string,number>();for(const f of snapshots)signatures.set(f.revision,(signatures.get(f.revision)||0)+1);
  return snapshots.filter(f=>f.candidates.length&&signatures.get(f.revision)===1);
}
