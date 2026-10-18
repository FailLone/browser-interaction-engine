import {readFileSync,writeFileSync} from 'node:fs';
import {SqliteStore} from '@interaction/storage-sqlite';
import {BrowserEngine} from '@interaction/browser';
import {componentOpportunities} from '../../../packages/explorer-plugin/src/component-correspondence.js';
const [run,copy,out]=process.argv.slice(2),host=new BrowserEngine({persistence:new SqliteStore(copy)}),task=JSON.parse(readFileSync(run+'/task-final.json','utf8'));
const rows=readFileSync(run+'/timeline.jsonl','utf8').trim().split('\n').map(x=>JSON.parse(x));
const ids=[...new Set(rows.filter(x=>x.type==='plugin.event'&&x.data.type==='fragment.candidates_ranked').map(x=>x.data.data.observationId))];
const timings:Record<string,{calls:number;ms:number}>={},proofs:any[]=[];
const measured=new Proxy(host,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args:any[])=>{
 const start=performance.now();try{const result=value.apply(target,args);if(key==='explorationTargetCorrespondences')proofs.push(...result.results);return result;}finally{const t=timings[String(key)]??={calls:0,ms:0};t.calls++;t.ms+=performance.now()-start;}};}});
try{const start=performance.now(),frames=ids.map(id=>{const o=host.store.require<any>('observation',id as string),answers=componentOpportunities(measured,task,o);return {observationId:id,opportunities:answers.map(a=>({itemId:a.itemId,input:a.input,status:a.material.status,reason:a.material.reason}))};});
 const result={elapsedMs:performance.now()-start,timings,frames,proofs,paidRequests:0,limitation:'Offline retained final pending ledger, not reconstructed transient task state or actual dispatch.'};writeFileSync(out,JSON.stringify(result,null,2));console.log({elapsedMs:result.elapsedMs,timings,frames:frames.length,opportunities:frames.reduce((n,f)=>n+f.opportunities.length,0)});
}finally{await host.close();}
