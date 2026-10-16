import { hash } from '@interaction/core';
import type { Control, Observation } from './types.js';

/** Retained observation facts, never a purpose, identity or execution grant. */
export interface ControlSurroundings {
  version:'control-surroundings/v1'; key:string; ownerInstanceId:string;
  complete:boolean; truncated:boolean; reasons:string[];
  nodes:NonNullable<Control['classificationBinding']>['nodes'];
  controls:Pick<Control,'instanceId'|'tag'|'role'|'name'|'value'|'checked'|'selected'|'visible'|'enabled'|'editable'|'readOnly'|'constraints'|'reviewBinding'|'actionBasis'>[];
}

/** Index once per material pass. No cache survives an observation or review change. */
export function controlSurroundingsReader(o:Pick<Observation,'controls'|'gaps'>) {
  const instances=new Map<string,Control[]>();
  for(const control of o.controls)instances.set(control.instanceId,[...instances.get(control.instanceId)||[],control]);
  const sources=o.controls.filter(c=>c.classificationBinding?.nodes.length).map(owner=>{
    const binding=owner.classificationBinding!,ids=new Set(binding.nodes.map(n=>n.instanceId));
    const controls=[...ids].flatMap(id=>instances.get(id)||[]).filter(c=>c.instanceId!==owner.instanceId&&(c.editable||c.actions.length>0));
    return {owner,binding,ids,controls};
  });
  const candidates=new Map<string,typeof sources>();
  for(const source of sources)for(const id of source.ids)if(id!==source.owner.instanceId&&instances.has(id)&&source.controls.some(c=>c.instanceId!==id))
    candidates.set(id,[...candidates.get(id)||[],source]);
  for(const values of candidates.values())values.sort((a,b)=>a.binding.nodes.length-b.binding.nodes.length||a.owner.instanceId.localeCompare(b.owner.instanceId));
  const cache=new Map<Control,ControlSurroundings|undefined>();
  return (target:Control):ControlSurroundings|undefined=>{
    if(cache.has(target))return cache.get(target);
    // Ancestor names, selectors and visual proximity do not establish membership.
    const source=candidates.get(target.instanceId)?.[0];if(!source){cache.set(target,undefined);return;}
    const {owner,binding}=source,reasons:string[]=[];
    const index=new Map(binding.nodes.map(n=>[n.instanceId,n]));
    if(index.size!==binding.nodes.length)reasons.push('duplicate_instances');
    if(instances.get(target.instanceId)?.length!==1)reasons.push('ambiguous_target_instance');
    if(binding.truncated)reasons.push('retained_subtree_truncated');
    if(o.gaps.some(g=>g.critical))reasons.push('critical_observation_gap');
    let distance=0,ancestor=index.get(target.instanceId),seen=new Set<string>();
    while(ancestor&&ancestor.instanceId!==owner.instanceId&&!seen.has(ancestor.instanceId)){
      seen.add(ancestor.instanceId);distance++;ancestor=index.get(ancestor.parentInstanceId);
    }
    if(ancestor?.instanceId!==owner.instanceId)reasons.push('target_owner_chain_unverified');
    if(distance>3)reasons.push('owner_too_distant');
    for(const node of binding.nodes){
      let current=node;const visited=new Set<string>();
      while(current.instanceId!==owner.instanceId&&!visited.has(current.instanceId)){
        visited.add(current.instanceId);const parent=index.get(current.parentInstanceId);if(!parent)break;current=parent;
      }
      if(current.instanceId!==owner.instanceId){reasons.push('subtree_chain_unverified');break;}
    }
    const controls=(source.controls.includes(target)?source.controls:[...source.controls,target])
      .map(({instanceId,tag,role,name,value,checked,selected,visible,enabled,editable,readOnly,constraints,reviewBinding,actionBasis})=>({instanceId,tag,role,name,value,checked,selected,visible,enabled,editable,readOnly,constraints,reviewBinding,actionBasis}));
    if(controls.some(c=>c.reviewBinding&&index.get(c.instanceId)?.parentInstanceId!==c.reviewBinding.parentInstanceId))reasons.push('control_parent_disagrees');
    const oversized=binding.nodes.length>40||controls.length>12||JSON.stringify({nodes:binding.nodes,controls}).length>12000;
    if(oversized)reasons.push('context_budget_exceeded');
    const facts={version:'control-surroundings/v1' as const,ownerInstanceId:owner.instanceId,complete:reasons.length===0,truncated:binding.truncated||oversized,reasons,
      nodes:oversized?[]:binding.nodes,controls:oversized?[]:controls};
    const result={...facts,key:hash(facts)};cache.set(target,result);return result;
  };
}
