// Closed-run, copied-database diagnostic. No browser and no original DB writes.
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {SqliteStore} from '@interaction/storage-sqlite';
import {matches,schedulingKeyFor,digest} from '../../../packages/explorer-plugin/src/policy.ts';
import {boundOperationCondition} from '../../../packages/explorer-plugin/src/plan-state.ts';
import {observationActionIndex} from '../../../packages/explorer-plugin/src/observation-action-index.ts';
const input=resolve(process.argv[2]),output=resolve(process.argv[3]);
mkdirSync(output,{recursive:false});mkdirSync(join(output,'copy'));
copyFileSync(join(input,'engine/engine.sqlite'),join(output,'copy/engine.sqlite'));
const store=new SqliteStore(join(output,'copy'));
try{
 const task=JSON.parse(readFileSync(join(input,'task-final.json')));
 const observations=store.list('observation'),all=store.list('action'),results=[];
 for(const o of observations.slice(-6)){
  const actions=all.filter(a=>a.observationId===o.id),plan=task.plan;
  const measure=indexed=>{
   const start=performance.now(),index=indexed?observationActionIndex(o,actions):undefined,rows=[];
   for(const item of plan){
    if(!item.scope.kind||item.dispatchScope===true)continue;
    const condition=boundOperationCondition(item);
    const current=index?index.matching(item.scope).filter(a=>!condition||condition===index.condition(a))
     :actions.filter(a=>matches(item.scope,a,o)&&(!condition||condition===schedulingKeyFor(a,o)));
    if(current.length===1)rows.push({itemId:item.id,actionId:current[0].id,scopeKey:digest({scope:item.scope,condition})});
   }
   return {elapsedMs:performance.now()-start,rows};
  };
  const old=measure(false),indexed=measure(true);
  if(JSON.stringify(old.rows)!==JSON.stringify(indexed.rows))throw Error('LINK_PARITY_FAILED');
  results.push({observationId:o.id,actions:actions.length,plan:plan.length,links:old.rows.length,oldMs:old.elapsedMs,indexedMs:indexed.elapsedMs,exactParity:true});
 }
 const result={input,results,limitation:'Offline matching/link computation only, final retained plan against six actual captures. Single samples include JIT effects; no browser throughput or coverage claim.'};
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{store.close();}
