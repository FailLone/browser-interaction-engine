import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { BrowserEngine, type Observation } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
const [variant,directory,output]=process.argv.slice(2);assert.ok(['eager','bounded'].includes(variant));
class EagerEngine extends BrowserEngine { protected override supportsCoverageObservationBatch(){return false;} }
const store=new SqliteStore(directory),engine=new (variant==='eager'?EagerEngine:BrowserEngine)({persistence:store,retention:{sweepIntervalMs:0}});
// No driver/session is created. Altering adapter methods here would withdraw
// the built-in composition certificate and measure the fallback by mistake.
const batch=engine.store.readObservationBatch.bind(engine.store),reads=new Map<string,number>();let batches=0;
engine.store.readObservationBatch=(sid,fn)=>batch(sid,get=>{
  batches++;
  return fn(<O extends Observation>(id:string)=>{reads.set(id,(reads.get(id)||0)+1);return get<O>(id);});
});
const changes=()=>Number((store.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n);
const before=changes(),began=performance.now();
try{
  const frontier=engine.getFrontier('412937f3-c4f5-4799-b86c-74adf480f329'),elapsedMs=performance.now()-began;
  const memory=process.memoryUsage(),maxRssKiB=process.resourceUsage().maxRSS;
  assert.equal(changes(),before);assert.equal(batches,variant==='bounded'?1:0);
  const json=JSON.stringify(frontier),result={variant,elapsedMs,batches,frontierItems:frontier.length,
    equivalentItems:frontier.filter(f=>f.coverage.equivalentTo).length,frontierBytes:Buffer.byteLength(json),frontierSha256:createHash('sha256').update(json).digest('hex'),
    requestedObservationReads:[...reads.values()].reduce((a,b)=>a+b,0),distinctRequestedObservations:reads.size,readsById:Object.fromEntries(reads),
    maxRssKiB,memory,queryDatabaseChanges:changes()-before,browserStarted:false,taskDatabaseOpened:false,
    limitation:'One complete frontier query on a fresh copied database; counts cover batch getters, not authority readers or eager list decoding. RSS includes constructor work. Not an end-to-end recovery benchmark.'};
  writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...result,readsById:undefined}));
}finally{await engine.close();}
