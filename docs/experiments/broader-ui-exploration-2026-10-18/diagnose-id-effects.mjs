import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';import {join,resolve} from 'node:path';
import {SqliteStore} from '@interaction/storage-sqlite';import {canonical} from '@interaction/core';
import {browserTraversalFragments} from '../../../packages/adapter-playwright/src/fragment-projection.ts';
import {browserFragmentObservedEffect,browserFragmentEffectComparison} from '../../../packages/adapter-playwright/src/fragment-outcome.ts';
import {effectControl} from '../../../packages/adapter-playwright/src/fragment-local-effect.ts';
const input=resolve(process.argv[2]),output=resolve(process.argv[3]);mkdirSync(output,{recursive:false});mkdirSync(join(output,'copy'));copyFileSync(join(input,'engine/engine.sqlite'),join(output,'copy/engine.sqlite'));
const store=new SqliteStore(join(output,'copy')),ledger=JSON.parse(readFileSync(join(input,'fragment-audit.json'))),pairs=[
 ['be8cfe61-5dd2-4963-8d1a-fff32b8ace5d','b20642a4-33cc-4f1f-8509-21e1c3cf809b'],
 ['2374d94f-cb88-478d-9874-63c7bcf9766c','612e084f-e4b4-4a6a-8aa7-79d1e8d43293'],
 ['1ee5755e-8033-4bb4-8d42-b3bf2edd8ed9','61c642fe-93b8-473d-8aba-97cb34f49307']];
const rows=[];
function differences(a,b,path=''){
 if(canonical(a)===canonical(b))return [];
 if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b))return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>differences(a[k],b[k],path+'/'+k));
 return [{path,before:a,after:b}];
}
try{
 for(const pair of pairs){const entries=pair.map(id=>{
  const event=ledger.events.find(e=>e.id===id);if(!event)throw Error('MISSING_ACTUAL_ORIGIN:'+id);const attempt=store.require('attempt',id),before=store.require('observation',attempt.beforeId),after=store.require('observation',attempt.afterId),actions=store.listByObservation('action',attempt.sessionId,before.id);
  const projection=browserTraversalFragments(before,actions,ledger.authority).find(f=>f.candidates.some(c=>c.actionId===attempt.action.id));if(!projection)throw Error('ORIGIN_NOT_PROJECTABLE');
  const effect=browserFragmentObservedEffect(before,after,{regionId:projection.regionId,localId:attempt.action.localId}),parsed=JSON.parse(effect.material),local=parsed.comparison?.local;
  const changed=parsed.comparison?.external.changes.map(change=>({...change,control:JSON.parse(change.control),captured:[before,after].flatMap(o=>o.controls.filter(c=>c.visible&&effectControl(c)===change.control).map(c=>({phase:o.id===before.id?'before':'after',instanceId:c.instanceId,region:o.regions.find(r=>r.key===c.region)?.label,landmark:c.landmark,tag:c.tag,name:c.name,readiness:c.readiness,liveContent:c.liveContent,href:c.reviewBinding?.attributes.href}))) }));
  return {attemptId:id,label:attempt.action.label,beforeId:before.id,afterId:after.id,url:before.url,projection:{structure:projection.structure,owner:projection.owner,candidate:projection.candidates.find(c=>c.actionId===attempt.action.id)},effect,
   summary:{localNodes:local?.tree.length,localText:local?.text,localFields:local,externalText:parsed.comparison?.external.text,externalChanges:changed,localIdBindings:parsed.evidence?.localIdBindings,readyBefore:before.controls.find(c=>c.localId===attempt.action.localId)?.readiness,readyAfter:after.controls.filter(c=>parsed.evidence?.afterRoot.nodes.some(n=>n.instanceId===c.instanceId)&&c.readiness).map(c=>({name:c.name,readiness:c.readiness}))}};
 });
 const [a,b]=entries;rows.push({origins:pair,label:a.label,mappingEqual:canonical([a.projection.structure,a.projection.owner,a.projection.candidate.path,a.projection.candidate.operation,a.projection.candidate.guard])===canonical([b.projection.structure,b.projection.owner,b.projection.candidate.path,b.projection.candidate.operation,b.projection.candidate.guard]),effectEqual:browserFragmentEffectComparison(a.effect.material)===browserFragmentEffectComparison(b.effect.material),localDifferences:differences(a.summary.localFields,b.summary.localFields),externalDifferences:differences({text:a.summary.externalText,changes:JSON.parse(a.effect.material).comparison?.external.changes},{text:b.summary.externalText,changes:JSON.parse(b.effect.material).comparison?.external.changes}),entries});
 }
 const result={input,rows,limitations:['Actual receipt-bound before/after data only; no new browser work or extra context source.','Outside the local subtree is not by itself proof of independence. Captured region/readout facts are diagnostic; no external difference is suppressed here.','Loading labels and readiness are reported independently. A successful dispatch does not prove asynchronous result completeness.','The existing full global effects and source observations remain intact.']};
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(rows.map(r=>({label:r.label,mappingEqual:r.mappingEqual,effectEqual:r.effectEqual,localDifferences:r.localDifferences,externalDifferenceCount:r.externalDifferences.length,entries:r.entries.map(e=>({id:e.attemptId,url:e.url,localNodes:e.summary.localNodes,localText:e.summary.localText,externalText:e.summary.externalText,externalChangedControls:e.summary.externalChanges?.map(c=>({delta:c.delta,control:c.control,captured:c.captured.map(({liveContent,...v})=>({...v,liveContentEvidence:liveContent?.evidence?.map(e=>e.rule)}))}))}))}))));
}finally{store.close();}
