// Disposable-copy diagnosis. No driver, navigation or original evidence writes.
import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {SqliteStore} from '@interaction/storage-sqlite';
import {BrowserEngine} from '@interaction/browser';
const input=resolve(process.argv[2]),output=resolve(process.argv[3]);
mkdirSync(output,{recursive:false});
const task=JSON.parse(readFileSync(join(input,'task-final.json'))),sid=task.rounds.at(-1).sessionId,results=[];
let expected;
for(const cacheSize of [0,16,0,16]){
 const dir=join(output,`copy-${results.length}`);mkdirSync(dir);copyFileSync(join(input,'engine/engine.sqlite'),join(dir,'engine.sqlite'));
 const store=new SqliteStore(dir),batch=store.readObservationBatch.bind(store),reads=new Map();let hits=0,heldBytes=0,peakBytes=0;
 store.readObservationBatch=(sessionId,read)=>batch(sessionId,get=>{
  const cached=new Map();
  return read(id=>{
   if(cached.has(id)){hits++;const v=cached.get(id);cached.delete(id);cached.set(id,v);return v.value;}
   const start=performance.now(),value=get(id),ms=performance.now()-start,prior=reads.get(id)||{count:0,ms:0};prior.count++;prior.ms+=ms;reads.set(id,prior);
   if(cacheSize&&value){const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes<=16*1024*1024){cached.set(id,{value,bytes});heldBytes+=bytes;while(cached.size>cacheSize||heldBytes>16*1024*1024){const first=cached.keys().next().value;heldBytes-=cached.get(first).bytes;cached.delete(first);}peakBytes=Math.max(peakBytes,heldBytes);}}
   return value;
  });
 });
 const engine=new BrowserEngine({persistence:store,retention:{sweepIntervalMs:0}});
 try{
  const start=performance.now(),frontier=engine.getFrontier(sid),elapsedMs=performance.now()-start,json=JSON.stringify(frontier);
  if(expected&&json!==expected)throw Error('EXACT_FRONTIER_PARITY_FAILED');expected=json;
  results.push({cacheSize,elapsedMs,frontier:frontier.length,actualReads:[...reads.values()].reduce((n,r)=>n+r.count,0),uniqueReads:reads.size,decodeMs:[...reads.values()].reduce((n,r)=>n+r.ms,0),hits,peakBytes,reads:[...reads],exactParity:true});
 }finally{await engine.close();}
}
writeFileSync(join(output,'result.json'),JSON.stringify({input,results,limitations:'Offline query only. Extra bounded cache is diagnostic, not product code or a throughput claim.'},null,2));
console.log(JSON.stringify(results.map(({reads,...r})=>r)));
