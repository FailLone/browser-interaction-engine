/** Frozen same-input task storage experiment for schema v3 baseline and v4 packed storage.
 * Disposable SQLite only. large-header models the unchanged obligations projection
 * cost rather than pretending that splitting plan/rounds makes every task O(delta).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type { Task } from '../packages/explorer-plugin/src/types.js';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];}));
const root=resolve(args['source-root']||'.'),mode='delta',count=Number(args.count||1000),iterations=Number(args.iterations||80),reads=Number(args.reads||100),large=args.header==='large',activeCount=Number(args.active||10);
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const sourceHashes=Object.fromEntries(['packages/explorer-plugin/src/store.ts','packages/explorer-plugin/src/task-codec.ts'].map(path=>{try{return [path,sha(readFileSync(join(root,path)))];}catch{return [path,null];}})),benchmarkHash=sha(readFileSync(fileURLToPath(import.meta.url)));
const {ExplorerStore}=await import(pathToFileURL(join(root,'packages/explorer-plugin/src/store.ts')).href) as typeof import('../packages/explorer-plugin/src/store.js');
const directory=mkdtempSync(join(tmpdir(),'explorer-delta-benchmark-')),filename=join(directory,'plugin.sqlite');
const fixture:Task={id:'task',goal:'Retain distinct observed branches',url:'https://fixture.invalid/',createdAt:'2026-10-17T00:00:00Z',updatedAt:'2026-10-17T00:00:00Z',revision:1,status:'paused',budget:{rounds:100,actions:10000,durationMs:100000,modelRequests:100},usage:{rounds:1,actions:0,durationMs:0,modelRequests:0},sessionOptions:{},sampleExcluded:[],exhaustive:false,
  plan:Array.from({length:count},(_,i)=>({id:`item-${i}`,title:`Branch ${i}`,scope:{url:'https://fixture.invalid/',stableKey:`record-${i}`,label:`Branch ${i}`,kind:'fill',value:'input'},prerequisites:[{label:'Menu',kind:'click'}],completion:'Observe this specific input branch',required:true,status:i>=count-activeCount?'unresolved':'succeeded',reason:'observed_in_scope',dispatchScope:false,evidence:[{sessionId:'source',observationId:`observation-${i}`}],attempts:[{roundId:'round',outcome:i>=count-activeCount?'blocked':'succeeded',evidence:{sessionId:'source',observationId:`observation-${i}`,attemptId:`attempt-${i}`}}]})),
  rounds:[{id:'round',number:1,sessionId:'source',startedAt:'2026-10-17T00:00:00Z',status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}]};
if(large)fixture.obligations={version:1,sessionId:'source',observationId:'current',conditionVersion:'fixture-condition-version',entries:fixture.plan.map((item,i)=>({itemId:item.id,groupId:item.id,state:i>=count-activeCount?'active':'resolved',reason:i>=count-activeCount?'current_target_observed':'original_ledger_resolved',conditionVersion:'fixture-condition-version',source:{sessionId:'source',observationId:`observation-${i}`,actionId:`action-${i}`}})),counts:{rows:count,active:activeCount,waiting:0,unreachable:0,aliases:0,resolved:count-activeCount,excluded:0,authority:0,unresolved:activeCount,unresolvedGroups:activeCount}};
const fixtureHash=createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),headerBytes=Buffer.byteLength(JSON.stringify((({plan,rounds,...h})=>h)(fixture)));
const size=(suffix='')=>{try{return statSync(filename+suffix).size;}catch{return 0;}};
const bytes=()=>({database:size(),wal:size('-wal'),sharedMemory:size('-shm'),total:size()+size('-wal')+size('-shm')});
function sample(fn:()=>void,n:number){const times:number[]=[],cpu=process.cpuUsage(),before=process.memoryUsage();let peakHeap=before.heapUsed,peakRss=before.rss;for(let i=0;i<n;i++){const start=performance.now();fn();times.push(performance.now()-start);const memory=process.memoryUsage();peakHeap=Math.max(peakHeap,memory.heapUsed);peakRss=Math.max(peakRss,memory.rss);}const usage=process.cpuUsage(cpu),sorted=[...times].sort((a,b)=>a-b);return {count:n,totalMs:times.reduce((a,b)=>a+b,0),medianMs:sorted[Math.floor(n/2)],p95Ms:sorted[Math.floor(n*.95)],maxMs:sorted.at(-1),cpuMs:(usage.user+usage.system)/1000,memory:{beforeHeap:before.heapUsed,beforeRss:before.rss,peakHeap,peakRss}};}
function headerOf(task:Task){const {plan,rounds,...header}=task;return header;}
const store=new ExplorerStore(filename),db=(store as unknown as {db:Database.Database}).db;
let result:unknown;
try{
  db.pragma('wal_autocheckpoint = 1000');const initialWrite=sample(()=>store.save(fixture),1);db.pragma('wal_checkpoint(TRUNCATE)');const initialBytes=bytes();let firstTask:Task|undefined;const firstFullRead=sample(()=>{firstTask=store.task(fixture.id);},1);if(!isDeepStrictEqual(firstTask,fixture))throw Error('First full read mismatch');
  const state=mode==='delta'?store.taskState(fixture.id):undefined,retained=state?.task??store.task(fixture.id);let version=state?.version,step=0;
  let activeQueryPlan:unknown;
  if(mode==='delta'){
    const prepare=db.prepare.bind(db);
    db.prepare=((sql:string)=>{
      const statement=prepare(sql);
      if(sql.includes('FROM task_items')&&sql.includes(' LIMIT ')){
        const all=statement.all.bind(statement);statement.all=(...params:unknown[])=>{activeQueryPlan={sql,plan:prepare('EXPLAIN QUERY PLAN '+sql).all(...params)};return all(...params);};
      }
      return statement;
    }) as typeof db.prepare;
    try{store.taskItems(fixture.id,'plan',{statuses:['pending','unresolved','blocked'],required:true,limit:10});}finally{db.prepare=prepare;}
  }
  const saves=sample(()=>{const position=count-activeCount+step%activeCount,item=retained.plan[position];item.reason=`retry-${step++}`;retained.usage.actions=step;retained.rounds[0].actions=step;
    if(mode==='delta'){const {plan,rounds,...header}=retained;const commit=store.applyTaskDelta(retained.id,version!,{header,plan:{update:[{occurrenceId:state!.plan[position],value:item}]},rounds:{update:[{occurrenceId:state!.rounds[0],value:rounds[0]}]}});version=commit.version;retained.updatedAt=commit.updatedAt;}
    else store.save(retained);
  },iterations);
  const afterWrites=bytes();
  const headerOnlyWrites=sample(()=>{retained.revision++;const {plan,rounds,...header}=retained;const commit=store.applyTaskDelta(retained.id,version!,{header});version=commit.version;retained.updatedAt=commit.updatedAt;},20);
  const activeReads=sample(()=>{const items=mode==='delta'?store.taskItems(fixture.id,'plan',{statuses:['pending','unresolved','blocked'],required:true,limit:10}).items.map(i=>i.value):store.task(fixture.id).plan.filter(i=>i.required&&['pending','unresolved','blocked'].includes(i.status)).slice(0,10);if(items.length!==Math.min(10,activeCount)||items[0].id!==`item-${count-activeCount}`)throw Error('Active view mismatch');},reads);
  const headerReads=sample(()=>{const header=mode==='delta'?store.taskHeader(fixture.id).header:store.task(fixture.id);if(header.usage.actions!==iterations)throw Error('Header mismatch');},reads);
  const ownerReads=sample(()=>{const id=mode==='delta'?store.taskIdForSession('source'):store.tasks().find(t=>t.rounds.some(r=>r.sessionId==='source'))?.id;if(id!==fixture.id)throw Error('Session owner mismatch');},reads);
  const fullReads=sample(()=>{if(store.task(fixture.id).plan.length!==count)throw Error('Full read mismatch');},60);
  const checkoutReads=sample(()=>{const state=store.taskState(fixture.id);if(state.task.plan.length!==count||state.plan.length!==count)throw Error('Audit checkout mismatch');},30);
  const stripTime=(t:Task)=>({...t,updatedAt:'ignored'});if(!isDeepStrictEqual(stripTime(store.task(fixture.id)),stripTime(retained)))throw Error('Exact roundtrip mismatch');
  const finalHash=createHash('sha256').update(JSON.stringify(stripTime(store.task(fixture.id)))).digest('hex');
  const statements=(store as unknown as {statements?:Map<string,unknown>}).statements;
  const coldSql=statements?[...statements.keys()].find(sql=>sql.includes('INDEXED BY task_cold_items')):undefined;
  const coldQueryPlan=coldSql?db.prepare('EXPLAIN QUERY PLAN '+coldSql).all(fixture.id,retained.rounds.length-1):null;
  store.close();const closedBytes=bytes();let reopened:InstanceType<typeof ExplorerStore>;
  const openStart=performance.now();reopened=new ExplorerStore(filename);const reopenMs=performance.now()-openStart;
  let restarted:Task|undefined;const restartFirstRead=sample(()=>{restarted=reopened.task(fixture.id);},1);if(!isDeepStrictEqual(stripTime(restarted!),stripTime(retained)))throw Error('Restart mismatch');
  const maintenanceState=reopened.taskState(fixture.id),remove=maintenanceState.plan.slice(0,Math.floor(count/2));
  reopened.applyTaskDelta(fixture.id,maintenanceState.version,{header:headerOf(maintenanceState.task),plan:{remove}});
  const beforeMaintenance=reopened.taskState(fixture.id),maintenanceBeforeBytes=bytes();let cleanup:unknown;
  const maintenance=sample(()=>{if(typeof reopened.compactTaskStorage==='function')cleanup=reopened.compactTaskStorage({reclaim:true});else{const connection=(reopened as unknown as {db:Database.Database}).db;connection.pragma('wal_checkpoint(TRUNCATE)');connection.exec('VACUUM');connection.pragma('wal_checkpoint(TRUNCATE)');cleanup={baseline:'VACUUM only; v3 has no compressed blocks'};}},1);
  if(!isDeepStrictEqual(reopened.taskState(fixture.id),beforeMaintenance))throw Error('Maintenance changed task values, version or occurrence handles');
  const maintenanceAfterBytes=bytes(),maintenanceFinalHash=sha(JSON.stringify(stripTime(reopened.task(fixture.id))));reopened.close();
  const processPeakRss=process.resourceUsage().maxRSS*1024;
  for(const [path,hash] of Object.entries(sourceHashes)){let now:string|null=null;try{now=sha(readFileSync(join(root,path)));}catch{}if(now!==hash)throw Error('Source changed during benchmark: '+path);}
  result={sourceRoot:root,sourceHashes,benchmarkHash,mode,count,activeCount,iterations,reads,header:large?'large':'small',headerBytes,fixtureHash,finalHash,node:process.version,initialWrite,firstFullRead,saves,headerOnlyWrites,activeReads,headerReads,ownerReads,fullReads,checkoutReads,reopenMs,restartFirstRead,activeQueryPlan,coldQueryPlan,initialBytes,afterWrites,closedBytes,maintenance:{timing:maintenance,beforeBytes:maintenanceBeforeBytes,afterBytes:maintenanceAfterBytes,cleanup,finalHash:maintenanceFinalHash},processPeakRss,walPolicy:{autocheckpointPages:1000,initialCheckpoint:true,finalCloseCheckpointsWal:true},scope:'Persistence microbenchmark, not end-to-end exploration. Full reads/checkout verify all records. Header serialized once in both variants; v4 additionally compresses large headers. Full-read samples include JS allocation but timing excludes memory snapshots; RSS is process-level high-water, not isolated read memory. Initial/steady/closed files precede explicit maintenance and have no VACUUM. Maintenance removes half the occurrences in both variants, verifies exact state/handles, then v4 repacks+collects+VACUUM while v3 VACUUMs only.'};
}finally{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});}
const json=JSON.stringify(result,null,2);if(args.output)writeFileSync(args.output,json+'\n');else console.log(json);
