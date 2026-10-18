/** Offline only. The input database must be a private copy of a closed run. */
import {readFileSync,writeFileSync} from 'node:fs';
import {SqliteStore} from '@interaction/storage-sqlite';
import {browserComponentCorrespondence} from '../../../packages/adapter-playwright/src/component-correspondence.js';
import {matches,keyFor,digest} from '../../../packages/explorer-plugin/src/policy.js';
import {schedulingOperationCondition} from '../../../packages/explorer-plugin/src/plan-state.js';
const [input,copy,output]=process.argv.slice(2),store=new SqliteStore(copy);
const task=JSON.parse(readFileSync(input+'/task-final.json','utf8'));
const timeline=readFileSync(input+'/timeline.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(r=>r.type==='plugin.event').map(r=>r.data);
const rank=timeline.filter(e=>e.type==='fragment.candidates_ranked'),order=new Map<string,number>();
for(const e of timeline){const id=e.observationId||e.data?.observationId;if(id&&!order.has(id))order.set(id,e.sequence);}
const cache=new Map<string,any>(),read=(id:string)=>{
 if(!cache.has(id)){const o:any=store.require('observation',id);cache.set(id,{o,a:store.listByObservation('action',o.sessionId,id)});}
 const value=cache.get(id);cache.delete(id);cache.set(id,value);while(cache.size>4)cache.delete(cache.keys().next().value!);return value;
};
const pairs:any[]=[],seen=new Set();
for(const r of rank){const {o,a}=read(r.data.observationId),session:any=store.require('session',o.sessionId);
 for(const item of task.plan.filter((i:any)=>i.required&&i.dispatchScope===false&&i.scope.kind&&!i.attempts.length)){
  const current=a.filter((a:any)=>a.kind===item.scope.kind&&a.label===item.scope.label&&a.value===item.scope.value);
  if(!current.length||current.length>4)continue;
  for(const ref of item.evidence){
   if(ref.attemptId||!order.has(ref.observationId)||order.get(ref.observationId)!>=r.sequence)continue;
   const source=read(ref.observationId),old=source.a.filter((a:any)=>matches(item.scope,a,source.o)&&(!schedulingOperationCondition(item)||keyFor(a,source.o)===schedulingOperationCondition(item)));
   if(old.length!==1)continue;
   for(const action of current){const key=digest([old[0].id,action.id]);if(seen.has(key))continue;seen.add(key);
    const m=browserComponentCorrespondence(old[0],source.o,store.require('session',source.o.sessionId),action,o,session);
    pairs.push({sequence:r.sequence,itemId:item.id,label:item.scope.label,source:ref,sourceActionId:old[0].id,observationId:o.id,actionId:action.id,status:m.status,reason:m.reason,
      materialKey:m.sourceMaterial&&digest([m.sourceMaterial,m.targetMaterial]),sourceBytes:m.sourceMaterial?.length,targetBytes:m.targetMaterial?.length});
   }
   break;
  }
 }
}
const counts=Object.fromEntries([...new Set(pairs.map(p=>p.reason))].map(k=>[k,pairs.filter(p=>p.reason===k).length]));
const questions=[...new Set(pairs.filter(p=>p.status==='uncertain').map(p=>p.materialKey))];
writeFileSync(output,JSON.stringify({counts,uniqueQuestions:questions.length,pairs,limitations:['Retained unfinished original items only; source chronology checked. Final ledger does not reconstruct every transient scheduling status.','Candidate correspondence is not action selection, dispatch or completion. No model request was sent.']},null,2));
console.log({counts,uniqueQuestions:questions.length,pairs:pairs.length});store.close();
