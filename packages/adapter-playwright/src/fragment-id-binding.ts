import {canonical} from '@interaction/core';
import type {Observation,RegionCandidate} from './types.js';
type Fragment=NonNullable<RegionCandidate['fragment']>;
type Node=Fragment['nodes'][number];
export const fragmentIdReferences=new Set(['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','aria-details','aria-errormessage','headers','list','form']);
const record=(n:Pick<Node,'tag'|'attributes'>)=>['li','tr'].includes(n.tag)||['listitem','row','option','treeitem'].includes(n.attributes.role)
 ||Object.keys(n.attributes).some(k=>['data-row-key','data-item-key','data-record-key'].includes(k));

/** Exploration sampling only. IDs name captured local nodes, never execution
 * targets or business records. Keep opaque/external ID bindings literal. */
export function fragmentIdBindingReader(o:Observation){
 const ids=new Map<string,Set<string>>(),nodeIds=new Map<string,Set<string>>(),references:{source:string;id:string;target?:string;invalid?:boolean}[]=[],records=new Set<string>();
 const add=(n:{instanceId:string;tag:string;attributes:Record<string,string>},complete=true)=>{
  const id=n.attributes.id,seen=nodeIds.get(n.instanceId)||new Set<string>();if(id||complete)seen.add(id||'');nodeIds.set(n.instanceId,seen);
  if(id){const nodes=ids.get(id)||new Set<string>();nodes.add(n.instanceId);ids.set(id,nodes);}
  for(const [key,value] of Object.entries(n.attributes))if(fragmentIdReferences.has(key))
   for(const id of value.split(/\s+/).filter(Boolean))references.push({source:n.instanceId,id});
  if(record(n))records.add(n.instanceId);
 };
 for(const r of o.regionCandidates||[])for(const n of r.fragment?.nodes||[])add(n);
 for(const c of o.controls){
  if(c.structuralItem)records.add(c.instanceId);
  // Review attributes are a semantic subset; omitted ID is not captured absence.
  if(c.reviewBinding)add({instanceId:c.instanceId,tag:c.tag,attributes:c.reviewBinding.attributes},false);
  for(const n of c.classificationBinding?.nodes||[])add(n);
  for(const r of c.classificationBinding?.references||[]){references.push({source:c.instanceId,id:r.id,target:r.targetInstanceId,invalid:!!(r.missing||r.ambiguous||r.target?.truncated)});for(const n of r.target?.nodes||[])add(n);}
 }
 return (f:Fragment)=>{
  const paths=new Map(f.nodes.map(n=>[n.path,n])),instances=new Set(f.nodes.map(n=>n.instanceId));
  if(paths.size!==f.nodes.length||instances.size!==f.nodes.length||f.nodes[0]?.path!=='.'
   ||f.nodes.some(n=>n.path!=='.'&&!paths.has(n.path.slice(0,n.path.lastIndexOf('/')))))return;
  // A position alone must not rename symmetric ID-only targets. Require a
  // unique captured non-ID node description, retaining all other attributes.
  const semantic=(n:Node)=>canonical({tag:n.tag,text:n.text,attributes:Object.fromEntries(Object.entries(n.attributes).filter(([key])=>key!=='id'&&!fragmentIdReferences.has(key)))});
  const keys=f.nodes.map(semantic),counts=new Map<string,number>();for(const key of keys)counts.set(key,(counts.get(key)||0)+1);
  const local=new Map<string,{policy:'fragment-relative-id/v1';path:string}>();
  for(const n of f.nodes){
   const id=n.attributes.id;if(!id||ids.get(id)?.size!==1||!ids.get(id)!.has(n.instanceId)||nodeIds.get(n.instanceId)?.size!==1||counts.get(semantic(n))!==1)continue;
   // A row's opaque ID may be its only business discriminator. Also preserve
   // inbound external references and incomplete/contradictory captured edges.
   if(f.nodes.some(parent=>records.has(parent.instanceId)&&(n.path===parent.path||n.path.startsWith(parent.path+'/')))
    ||references.some(r=>r.id===id&&(!instances.has(r.source)||r.invalid||r.target&&r.target!==n.instanceId)))continue;
   local.set(id,{policy:'fragment-relative-id/v1',path:n.path});
  }
  const reference=(id:string)=>local.get(id)||id;
  const attributes=(a:Record<string,string>,instanceId?:string)=>Object.fromEntries(Object.entries(a).map(([key,value])=>{
   if(key==='id'&&local.has(value)&&(!instanceId||f.nodes.some(n=>n.instanceId===instanceId&&n.attributes.id===value)))return [key,reference(value)];
   if(fragmentIdReferences.has(key)){
    const tokens=value.split(/\s+/).filter(Boolean);
    if(tokens.some(id=>local.has(id)))return [key,{policy:'fragment-idrefs/v1',targets:tokens.map(reference)}];
   }
   return [key,value];
  }));
  return {attributes,reference,bindings:[...local].map(([id,target])=>({id,...target})),nodes:f.nodes.map(n=>({...n,attributes:attributes(n.attributes,n.instanceId)}))};
 };
}
