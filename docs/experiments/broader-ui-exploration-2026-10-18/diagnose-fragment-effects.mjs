// Offline source decomposition only. No sampling policy or original DB writes.
import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {SqliteStore} from '@interaction/storage-sqlite';
import {browserTraversalFragments} from '@interaction/browser';
import {canonical,hash} from '@interaction/core';
import {fragmentConditionReader} from '../../../packages/adapter-playwright/src/fragment-conditions.ts';
const input=resolve(process.argv[2]),output=resolve(process.argv[3]);
mkdirSync(output,{recursive:false});mkdirSync(join(output,'copy'));
copyFileSync(join(input,'engine/engine.sqlite'),join(output,'copy/engine.sqlite'));
const store=new SqliteStore(join(output,'copy'));
const unpack=value=>value.startsWith('deflate-raw/base64-v1:')?inflateRawSync(Buffer.from(value.slice('deflate-raw/base64-v1:'.length),'base64')).toString():value;
// Same structural style exclusion as host-dom-fragment/v1. Raw styles remain
// in afterRoot.classification; actual captured readiness stays in comparison.
const tree=f=>f.nodes.map(({path,tag,attributes,text})=>({path,tag,attributes:Object.fromEntries(Object.entries(attributes).filter(([key])=>key!=='style')),text}));
function subtree(o,rootId,anchor){
 const root=o.controls.filter(c=>c.instanceId===rootId),binding=root.length===1?root[0].classificationBinding:undefined;
 if(binding&&!binding.truncated&&binding.nodes[0]?.instanceId===rootId){
  const paths=new Map(),counts=new Map(),nodes=[];
  for(const n of binding.nodes){
   if(paths.has(n.instanceId))return;
   const parent=paths.get(n.parentInstanceId),key=canonical([n.parentInstanceId,n.tag]),count=(counts.get(key)||0)+1;counts.set(key,count);
   const path=n.instanceId===rootId?'.':parent&&`${parent}/${n.tag}[${count}]`;if(!path)return;
   paths.set(n.instanceId,path);nodes.push({instanceId:n.instanceId,path,tag:n.tag,attributes:n.attributes,text:''});
  }
  return {...anchor,nodes,capturedText:binding.text,scopeBasis:'complete-classification-subtree'};
 }
 const found=[];
 for(const r of o.regionCandidates||[]){const f=r.fragment;if(f?.policy!=='host-dom-fragment/v1')continue;
  const roots=f.nodes.filter(n=>n.instanceId===rootId);if(roots.length!==1)continue;
  const path=roots[0].path,nodes=f.nodes.filter(n=>n.path===path||n.path.startsWith(path+'/')).map(n=>({...n,path:'.'+n.path.slice(path.length)}));
  found.push({...anchor,nodes});
 }
 return found.length&&found.every(f=>canonical(f.nodes)===canonical(found[0].nodes))?found[0]:undefined;
}
const inventory=(o,ids)=>o.controls.filter(c=>ids.has(c.instanceId)).map(c=>({tag:c.tag,role:c.role,name:c.label||c.name,visible:c.visible,enabled:c.enabled,readOnly:c.readOnly,attributes:c.reviewBinding?.attributes,checked:c.checked,pressed:c.pressed,expanded:c.expanded,selected:c.selected,options:c.options,constraints:c.constraints,readiness:c.readiness,actionable:c.actionable&&{visible:c.actionable.visible,enabled:c.actionable.enabled,editable:c.actionable.editable,hitTarget:c.actionable.hitTarget,occludedBy:c.actionable.occludedBy,outsideScrollableArea:c.actionable.outsideScrollableArea,unknown:c.actionable.unknown}})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
try{
 const ledger=JSON.parse(readFileSync(join(input,'fragment-audit.json'))),fragments=new Map(ledger.fragments.map(f=>[f.id,f])),rows=[];
 for(const event of ledger.events){
  const before=store.require('observation',event.observationId),after=store.require('observation',event.afterId),actions=store.listByObservation('action',event.sessionId,before.id),action=actions.find(a=>a.id===event.actionId);
  const stored=fragments.get(event.fragmentId),candidate=stored.candidates.find(c=>c.id===event.candidateId);
  const projections=browserTraversalFragments(before,actions,ledger.authority).filter(p=>p.candidates.some(c=>c.actionId===event.actionId)&&p.structure===unpack(stored.structure)&&p.owner===unpack(stored.owner));
  if(projections.length!==1)throw Error('ACTUAL_ORIGIN_PROJECTION_NOT_UNIQUE');
  const regionId=projections[0].regionId,f=before.regionCandidates.find(r=>r.id===regionId).fragment;
  const next=subtree(after,regionId,f);
  const control=before.controls.find(c=>c.localId===action.localId),targets=after.controls.filter(c=>c.instanceId===control.instanceId);
  const afterRoot=after.controls.find(c=>c.instanceId===regionId);
  const closing=[];
  for(const c of before.controls){
   const current=after.controls.filter(t=>t.instanceId===c.instanceId);
   if(typeof c.expanded!=='boolean'||current.length!==1||current[0].expanded!==false||f.nodes.some(n=>n.instanceId===c.instanceId))continue;
   const roots=before.controls.filter(r=>r.classificationBinding&&!r.classificationBinding.truncated
    &&r.classificationBinding.nodes.some(n=>n.instanceId===c.instanceId)&&!r.classificationBinding.nodes.some(n=>n.instanceId===regionId))
    .filter(r=>r.classificationBinding.nodes.some(n=>before.controls.some(t=>t.instanceId===n.instanceId&&t.visible)&&!after.controls.some(t=>t.instanceId===n.instanceId&&t.visible)))
    .sort((a,b)=>a.classificationBinding.nodes.length-b.classificationBinding.nodes.length);
   if(roots[0])closing.push({control:c.name,root:roots[0].instanceId,text:roots[0].classificationBinding.text,nodes:roots[0].classificationBinding.nodes.length});
  }
  const full=event.effect&&JSON.parse(unpack(event.effect));
  let local;const ids=next&&new Set(next.nodes.map(n=>n.instanceId));
  const outsideRevealed=ids?after.controls.filter(c=>c.visible&&!ids.has(c.instanceId)&&!before.controls.some(p=>p.instanceId===c.instanceId&&p.visible)).map(c=>({instanceId:c.instanceId,tag:c.tag,role:c.role,name:c.label||c.name})):[];
  if(next&&targets.length===1&&before.instanceScope===after.instanceScope){
   const conditions=fragmentConditionReader(after)(targets[0],next);
   local={navigation:before.url===after.url?null:after.url,tree:tree(next),text:next.capturedText,controls:inventory(after,ids),relatedModes:conditions.modes.conditions?.conditions};
  }
  rows.push({attemptId:event.id,actionId:event.actionId,label:action.label,kind:action.kind,beforeId:before.id,afterId:after.id,sourceUrl:before.url,regionId,beforeNodes:f.nodes.length,afterNodes:next?.nodes.length,outsideRevealed,
   afterRoot:afterRoot&&{instanceId:afterRoot.instanceId,role:afterRoot.role,name:afterRoot.name,classification:afterRoot.classificationBinding},afterTargetCount:targets.length,afterDescendants:after.controls.filter(c=>c.domAncestry?.instanceIds.includes(regionId)).length,
   classKey:hash([stored.structure,stored.owner,candidate.path,candidate.operation,candidate.guard]),fullEffectKey:full&&hash(full),localKey:local&&hash(local),local,
   fullChanges:full?.changes?.map(c=>({control:JSON.parse(c.control),delta:c.delta})),fullText:full?.text,
   beforeText:before.text,afterText:after.text,closing,
   scopeStatus:local?'same_instance_complete_fragment':'complete_after_fragment_or_target_unavailable'});
 }
 const pairs=[];
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)if(rows[i].classKey===rows[j].classKey){const a=rows[i],b=rows[j];pairs.push({origins:[a.attemptId,b.attemptId],labels:[a.label,b.label],fullEqual:a.fullEffectKey===b.fullEffectKey,localAvailable:!!a.local&&!!b.local,localEqual:!!a.local&&!!b.local&&canonical(a.local)===canonical(b.local),differentLocalFields:a.local&&b.local?Object.keys(a.local).filter(k=>canonical(a.local[k])!==canonical(b.local[k])):[]});}
 const result={input,rows,pairs,limitations:['Diagnostic candidate criterion only; does not grant sampling, independence, execution or coverage.','Same-instance after-fragment completeness and related mode material are inspected; collateral whole-page effects remain recorded.','Field comparison must be evaluated with actual positive and negative cases before changing runtime policy.']};
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({rows:rows.map(({local,fullChanges,fullText,...r})=>r),pairs},null,2));
}finally{store.close();}
