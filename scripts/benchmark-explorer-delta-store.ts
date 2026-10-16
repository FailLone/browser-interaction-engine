/** Same fixture/cadence for full-save baseline and explicit delta persistence.
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
const root=resolve(args['source-root']||'.'),mode=args.mode||'delta',count=Number(args.count||1000),iterations=Number(args.iterations||80),reads=Number(args.reads||100),large=args.header==='large';
const sourceHash=createHash('sha256').update(readFileSync(join(root,'packages/explorer-plugin/src/store.ts'))).digest('hex'),benchmarkHash=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const {ExplorerStore}=await import(pathToFileURL(join(root,'packages/explorer-plugin/src/store.ts')).href) as typeof import('../packages/explorer-plugin/src/store.js');
const directory=mkdtempSync(join(tmpdir(),'explorer-delta-benchmark-')),filename=join(directory,'plugin.sqlite');
const fixture:Task={id:'task',goal:'Retain distinct observed branches',url:'https://fixture.invalid/',createdAt:'2026-10-17T00:00:00Z',updatedAt:'2026-10-17T00:00:00Z',revision:1,status:'paused',budget:{rounds:100,actions:10000,durationMs:100000,modelRequests:100},usage:{rounds:1,actions:0,durationMs:0,modelRequests:0},sessionOptions:{},sampleExcluded:[],exhaustive:false,
  plan:Array.from({length:count},(_,i)=>({id:`item-${i}`,title:`Branch ${i}`,scope:{url:'https://fixture.invalid/',stableKey:`record-${i}`,label:`Branch ${i}`,kind:'fill',value:'input'},prerequisites:[{label:'Menu',kind:'click'}],completion:'Observe this specific input branch',required:true,status:i>=count-10?'unresolved':'succeeded',reason:'observed_in_scope',dispatchScope:false,evidence:[{sessionId:'source',observationId:`observation-${i}`}],attempts:[{roundId:'round',outcome:i>=count-10?'blocked':'succeeded',evidence:{sessionId:'source',observationId:`observation-${i}`,attemptId:`attempt-${i}`}}]})),
  rounds:[{id:'round',number:1,sessionId:'source',startedAt:'2026-10-17T00:00:00Z',status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}]};
if(large)fixture.obligations={version:1,sessionId:'source',observationId:'current',conditionVersion:'fixture-condition-version',entries:fixture.plan.map((item,i)=>({itemId:item.id,groupId:item.id,state:i>=count-10?'active':'resolved',reason:i>=count-10?'current_target_observed':'original_ledger_resolved',conditionVersion:'fixture-condition-version',source:{sessionId:'source',observationId:`observation-${i}`,actionId:`action-${i}`}})),counts:{rows:count,active:10,waiting:0,unreachable:0,aliases:0,resolved:count-10,excluded:0,authority:0,unresolved:10,unresolvedGroups:10}};
const fixtureHash=createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),headerBytes=Buffer.byteLength(JSON.stringify((({plan,rounds,...h})=>h)(fixture)));
const size=(suffix='')=>{try{return statSync(filename+suffix).size;}catch{return 0;}};
const bytes=()=>({database:size(),wal:size('-wal'),sharedMemory:size('-shm'),total:size()+size('-wal')+size('-shm')});
function sample(fn:()=>void,n:number){const times:number[]=[],cpu=process.cpuUsage();for(let i=0;i<n;i++){const start=performance.now();fn();times.push(performance.now()-start);}const usage=process.cpuUsage(cpu),sorted=[...times].sort((a,b)=>a-b);return {count:n,totalMs:times.reduce((a,b)=>a+b,0),medianMs:sorted[Math.floor(n/2)],p95Ms:sorted[Math.floor(n*.95)],maxMs:sorted.at(-1),cpuMs:(usage.user+usage.system)/1000};}
const store=new ExplorerStore(filename),db=(store as unknown as {db:Database.Database}).db;
let result:unknown;
try{
  db.pragma('wal_autocheckpoint = 1000');store.save(fixture);db.pragma('wal_checkpoint(TRUNCATE)');const initialBytes=bytes();
  const state=mode==='delta'?store.taskState(fixture.id):undefined,retained=state?.task??store.task(fixture.id);let version=state?.version,step=0;
  let activeQueryPlan:unknown;
  if(mode==='delta'){
    const prepare=db.prepare.bind(db);
    db.prepare=((sql:string)=>{
      const statement=prepare(sql);
      if(sql.startsWith('SELECT kind,position,json,content_hash,occurrence_id FROM task_items')&&sql.includes(' LIMIT ')){
        const all=statement.all.bind(statement);statement.all=(...params:unknown[])=>{activeQueryPlan={sql,plan:prepare('EXPLAIN QUERY PLAN '+sql).all(...params)};return all(...params);};
      }
      return statement;
    }) as typeof db.prepare;
    try{store.taskItems(fixture.id,'plan',{statuses:['pending','unresolved','blocked'],required:true,limit:10});}finally{db.prepare=prepare;}
  }
  const saves=sample(()=>{const position=count-10+step%10,item=retained.plan[position];item.reason=`retry-${step++}`;retained.usage.actions=step;retained.rounds[0].actions=step;
    if(mode==='delta'){const {plan,rounds,...header}=retained;const commit=store.applyTaskDelta(retained.id,version!,{header,plan:{update:[{occurrenceId:state!.plan[position],value:item}]},rounds:{update:[{occurrenceId:state!.rounds[0],value:rounds[0]}]}});version=commit.version;retained.updatedAt=commit.updatedAt;}
    else store.save(retained);
  },iterations);
  const afterWrites=bytes();
  const activeReads=sample(()=>{const items=mode==='delta'?store.taskItems(fixture.id,'plan',{statuses:['pending','unresolved','blocked'],required:true,limit:10}).items.map(i=>i.value):store.task(fixture.id).plan.filter(i=>i.required&&['pending','unresolved','blocked'].includes(i.status)).slice(0,10);if(items.length!==10||items[0].id!==`item-${count-10}`)throw Error('Active view mismatch');},reads);
  const headerReads=sample(()=>{const header=mode==='delta'?store.taskHeader(fixture.id).header:store.task(fixture.id);if(header.usage.actions!==iterations)throw Error('Header mismatch');},reads);
  const ownerReads=sample(()=>{const id=mode==='delta'?store.taskIdForSession('source'):store.tasks().find(t=>t.rounds.some(r=>r.sessionId==='source'))?.id;if(id!==fixture.id)throw Error('Session owner mismatch');},reads);
  const fullReads=sample(()=>{if(store.task(fixture.id).plan.length!==count)throw Error('Full read mismatch');},20);
  const stripTime=(t:Task)=>({...t,updatedAt:'ignored'});if(!isDeepStrictEqual(stripTime(store.task(fixture.id)),stripTime(retained)))throw Error('Exact roundtrip mismatch');
  const finalHash=createHash('sha256').update(JSON.stringify(stripTime(store.task(fixture.id)))).digest('hex');
  store.close();const closedBytes=bytes(),reopened=new ExplorerStore(filename);if(!isDeepStrictEqual(stripTime(reopened.task(fixture.id)),stripTime(retained)))throw Error('Restart mismatch');reopened.close();
  result={sourceRoot:root,sourceHash,benchmarkHash,mode,count,iterations,reads,header:large?'large':'small',headerBytes,fixtureHash,finalHash,node:process.version,saves,activeReads,headerReads,ownerReads,fullReads,activeQueryPlan,initialBytes,afterWrites,closedBytes,walPolicy:{autocheckpointPages:1000,initialCheckpoint:true,finalCloseCheckpointsWal:true},scope:'persistence microbenchmark, not end-to-end exploration; header still serialized in full; active query is not a full-history integrity audit; no VACUUM'};
}finally{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});}
const json=JSON.stringify(result,null,2);if(args.output)writeFileSync(args.output,json+'\n');else console.log(json);
