// Store-only read experiment. Each fixture is an owned disposable DB copy.
import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const cfg=JSON.parse(readFileSync(process.argv[2],'utf8'));
const {ExplorerStore}=await import(pathToFileURL(`${cfg.sourceRoot}/packages/explorer-plugin/src/store.ts`).href);
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const jsonHash=(value:unknown)=>hash(JSON.stringify(value));
const files=(db:string)=>Object.fromEntries(['','-wal','-shm'].map(s=>[s||'db',existsSync(db+s)?statSync(db+s).size:0]));
const stats=(samples:number[])=>({samples,median:[...samples].sort((a,b)=>a-b)[Math.floor(samples.length/2)],min:Math.min(...samples),max:Math.max(...samples)});
const result:any={revision:cfg.revision,pid:process.pid,scenarios:{},limits:['Only store APIs on disposable copies; no engine/browser/provider.','First read means first API read per new store. The history fixture runs after run7 in this process, and OS page caches are not flushed.','Time excludes JSON equality, byte/hash accounting, event export and semantic serialization.','Memory includes retained correctness snapshots, GC behavior and earlier scenario work; not a production heap estimate.','Layout and writes are unchanged; this is a read-only experiment.']};
for(const fixture of cfg.fixtures){
 const timings:Record<string,number[]>={},memory:any[]=[];
 const timed=<T>(name:string,fn:()=>T):T=>{const start=performance.now();try{return fn()}finally{(timings[name]??=[]).push(performance.now()-start)}};
 const fileHashBefore=hash(readFileSync(fixture.database)),filesBefore=files(fixture.database);
 const store=timed('startup',()=>new ExplorerStore(fixture.database)),db=(store as any).db;
 const first=timed('firstFullRead',()=>store.taskState(fixture.taskId));memory.push({phase:'firstFullRead',...process.memoryUsage(),maxRSSKiB:process.resourceUsage().maxRSS});
 const {plan,rounds,...header}=first.task,active=new Set(['pending','unresolved','blocked']);
 const expectedItems=plan.map((value:any,position:number)=>({value,position,occurrenceId:first.plan[position]})).filter((item:any)=>active.has(item.value.status)).slice(0,1000);
 const cursor=(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE task_id=?').get(fixture.taskId) as {n:number}).n;
 for(let i=0;i<7;i++)assert.deepStrictEqual(timed('warmFullRead',()=>store.taskState(fixture.taskId)),first);
 for(let i=0;i<7;i++)assert.deepStrictEqual(timed('warmTaskRead',()=>store.task(fixture.taskId)),first.task);
 for(let i=0;i<7;i++)assert.deepStrictEqual(timed('activeRead',()=>store.taskItems(fixture.taskId,'plan',{statuses:[...active],limit:1000})).items,expectedItems);
 for(let i=0;i<7;i++)assert.deepStrictEqual(timed('headerRead',()=>store.taskHeader(fixture.taskId)).header,header);
 for(let i=0;i<7;i++){const value=timed('idleUpdates',()=>store.updates(fixture.taskId,cursor,500,first.version));assert.equal(value.task,undefined);assert.deepStrictEqual(value.events,[]);assert.deepStrictEqual(value.decisions,[]);assert.equal(value.taskVersion,first.version);}
 memory.push({phase:'readPhasesFinished',...process.memoryUsage(),maxRSSKiB:process.resourceUsage().maxRSS});
 // Untimed mechanism count; all correctness material remains freshly allocated.
 const mechanism={hotByteRows:0,hotByteBytes:0,hotTextRows:0,hotTextUtf8Bytes:0,coldReferenceRows:0,coldReferenceBuffers:0};
 const read=(store as any).readItem.bind(store);(store as any).readItem=(row:any,...args:any[])=>{if(row.chunk_id!==null){mechanism.coldReferenceRows++;if(Buffer.isBuffer(row.json))mechanism.coldReferenceBuffers++;}else if(Buffer.isBuffer(row.json)){mechanism.hotByteRows++;mechanism.hotByteBytes+=row.json.length;}else{mechanism.hotTextRows++;mechanism.hotTextUtf8Bytes+=Buffer.byteLength(row.json);}return read(row,...args);};
 assert.deepStrictEqual(store.taskState(fixture.taskId),first);(store as any).readItem=read;
 const events:any[]=[];let after=0;for(;;){const page=store.events(fixture.taskId,after,1000);events.push(...page);if(page.length<1000)break;after=page.at(-1)!.sequence;}
 const decisions=store.decisions(fixture.taskId),semantic={state:first,events,decisions};
 const rowCounts=db.prepare('SELECT kind,status,count(*) AS n,sum(chunk_id IS NOT NULL) AS packed,sum(length(CAST(json AS BLOB))) AS jsonBytes FROM task_items WHERE task_id=? GROUP BY kind,status').all(fixture.taskId);
 const changes=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n;assert.equal(changes,0);
 assert.deepStrictEqual(store.taskState(fixture.taskId),first);assert.deepStrictEqual(store.decisions(fixture.taskId),decisions);
 const filesOpen=files(fixture.database),metrics={timingsMs:Object.fromEntries(Object.entries(timings).map(([name,samples])=>[name,stats(samples)])),mechanism,memory,rowCounts,counts:{plan:plan.length,rounds:rounds.length,events:events.length,decisions:decisions.length},bytes:{task:Buffer.byteLength(JSON.stringify(first.task)),header:Buffer.byteLength(JSON.stringify(header))},taskSha256:jsonHash(first.task),stateSha256:jsonHash(first),eventsSha256:jsonHash(events),decisionsSha256:jsonHash(decisions),totalChanges:changes,filesBefore,filesOpen};
 store.close();const fileHashAfter=hash(readFileSync(fixture.database));assert.equal(fileHashAfter,fileHashBefore);assert.equal(fileHashAfter,fixture.seedSha256);
 const serialized=JSON.stringify(semantic);writeFileSync(fixture.semantic,serialized);result.scenarios[fixture.name]={...metrics,filesClosed:files(fixture.database),fileHashBefore,fileHashAfter,semanticBytes:Buffer.byteLength(serialized),semanticSha256:hash(serialized),semantic:fixture.semantic};
}
result.resources={...process.memoryUsage(),maxRSSKiB:process.resourceUsage().maxRSS};writeFileSync(cfg.output,JSON.stringify(result,null,2)+'\n');
