/** Caller-side measurement only. Does not wrap persistence or change SDK fences. */
import {appendFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
export function artifactSizes(dir:string){
 const buckets:Record<string,number>={engineDB:0,engineWAL:0,engineSHM:0,explorerDB:0,explorerWAL:0,explorerSHM:0,evidence:0,exportsAndLogs:0,auditCopies:0};
 const walk=(path:string)=>{for(const e of readdirSync(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())walk(p);else if(e.isFile()){const name=relative(dir,p),size=statSync(p).size;const key=name.startsWith('audit-copy/')?'auditCopies':name.startsWith('engine/evidence/')?'evidence':({'engine/engine.sqlite':'engineDB','engine/engine.sqlite-wal':'engineWAL','engine/engine.sqlite-shm':'engineSHM','explorer.sqlite':'explorerDB','explorer.sqlite-wal':'explorerWAL','explorer.sqlite-shm':'explorerSHM'} as Record<string,string>)[name]||'exportsAndLogs';buckets[key]+=size;}}};walk(dir);return buckets;
}
export function costSampler(dir:string,counts:()=>unknown){
 const sample=(phase:string)=>{const start=performance.now();const row={at:Date.now(),phase,pid:process.pid,memory:process.memoryUsage(),resource:process.resourceUsage(),counts:counts(),bytes:artifactSizes(dir),samplingMs:performance.now()-start};appendFileSync(join(dir,'cost-samples.jsonl'),JSON.stringify(row)+'\n');};
 return sample;
}
/** Calls are inclusive. Each span is retained so consumers can compute interval
 * unions instead of incorrectly adding nested/overlapping measurements. */
export function measuredConsumer<T extends object>(raw:T,record:(data:unknown)=>void):T{
 const methods=new Map<PropertyKey,{method:Function;wrapper:Function}>();
 return new Proxy(raw,{get(target,key){const method=Reflect.get(target,key,target);if(typeof method!=='function')return method;const saved=methods.get(key);if(saved?.method===method)return saved.wrapper;
 const wrapper=(...args:unknown[])=>{const start=performance.now(),at=Date.now();const end=(failed:boolean)=>record({method:String(key),at,elapsedMs:performance.now()-start,failed});let result:unknown;try{result=Reflect.apply(method,target,args);}catch(e){end(true);throw e;}if(result instanceof Promise)return result.then(v=>{end(false);return v;},e=>{end(true);throw e;});end(false);return result;};methods.set(key,{method,wrapper});return wrapper;}});
}
