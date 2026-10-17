// Disposable ExplorerStore-only experiment. Never imports or constructs an engine.
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const cfg=JSON.parse(readFileSync(process.argv[2],'utf8'));
const {ExplorerStore}=await import(pathToFileURL(`${cfg.sourceRoot}/packages/explorer-plugin/src/store.ts`).href);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const OriginalDate=Date;let clock=OriginalDate.parse('2026-10-18T00:00:00.000Z');
globalThis.Date=new Proxy(OriginalDate,{construct(target,args){return Reflect.construct(target,args.length?args:[clock]);},get(target,key,receiver){return key==='now'?()=>clock:Reflect.get(target,key,receiver);}});
const header=(task:any)=>{const {plan,rounds,...rest}=task;return rest;};
const summarize=(samples:number[])=>({samples,min:Math.min(...samples),median:[...samples].sort((a,b)=>a-b)[Math.floor(samples.length/2)],max:Math.max(...samples)});
const files=(db:string)=>Object.fromEntries(['','-wal','-shm'].map(s=>[s||'db',existsSync(db+s)?statSync(db+s).size:0]));

if(cfg.mode==='seed'){
  const source=new ExplorerStore(cfg.sourceDatabase),original=source.task(cfg.taskId);source.close();
  const task=structuredClone(original);task.id='history-fixture';
  task.plan=Array.from({length:5000},(_,i)=>({...structuredClone(original.plan[i%original.plan.length]),id:`fixture-${i}`,status:i<4990?'succeeded':'unresolved'}));
  const current=task.rounds.at(-1);
  task.rounds=[{...structuredClone(current),id:'historical-round-1',sessionId:'historical-session-1',status:'finished'},current];
  const store=new ExplorerStore(cfg.database);store.save(task);const state=store.taskState(task.id);
  store.close();writeFileSync(cfg.output,JSON.stringify({purpose:'Synthetic retained-history cost control derived from frozen run7 values; statuses/IDs/round membership explicitly changed. Not a replay or coverage experiment.',taskId:task.id,taskHash:hash(state.task),plan:state.plan,rounds:state.rounds,counts:{plan:task.plan.length,rounds:task.rounds.length},files:files(cfg.database)},null,2)+'\n');
}else{
  const metrics:Record<string,any>={},phaseChecks:unknown[]=[],memory:unknown[]=[],transactionBodies:Record<string,number[]>={};let phase='setup',measuring=false;
  const started=performance.now(),store=new ExplorerStore(cfg.database);metrics.startup={samples:[performance.now()-started]};
  const db=(store as any).db;
  const transaction=db.transaction.bind(db);
  db.transaction=(body:Function)=>transaction(function(this:unknown,...args:unknown[]){const start=performance.now();try{return body.apply(this,args);}finally{if(measuring)(transactionBodies[phase]??=[]).push(performance.now()-start);}});
  const markMemory=()=>memory.push({phase,...process.memoryUsage()});
  const timed=<T>(name:string,f:()=>T):T=>{phase=name;const start=performance.now();measuring=true;try{return f();}finally{measuring=false;(metrics[name]??={samples:[]}).samples.push(performance.now()-start);}};
  const first=timed('firstFullRead',()=>store.task(cfg.taskId)),initial=store.taskState(cfg.taskId);assert.deepStrictEqual(first,initial.task);
  let expected=structuredClone(initial.task),version=initial.version;const planRefs=[...initial.plan],roundRefs=[...initial.rounds];
  const allEvents=()=>{const out:any[]=[];let cursor=0;for(;;){const page=store.events(cfg.taskId,cursor,1000);out.push(...page);if(page.length<1000)return out;cursor=page.at(-1).sequence;}};
  const events=allEvents(),decisions=store.decisions(cfg.taskId),initialLayout=db.prepare('SELECT (SELECT COUNT(*) FROM task_chunks) AS chunks,(SELECT COUNT(*) FROM task_items WHERE chunk_id IS NOT NULL) AS packed').get();
  const invariant=()=>{const state=store.taskState(cfg.taskId);assert.deepStrictEqual(state.task,expected);assert.deepStrictEqual(state.plan,planRefs);assert.deepStrictEqual(state.rounds,roundRefs);assert.equal(state.version,version);return state;};
  const checkpoint=(name:string)=>{const state=invariant();phaseChecks.push({name,taskSha256:hash(state.task),taskBytes:bytes(state.task),planSha256:hash(state.plan),roundsSha256:hash(state.rounds)});markMemory();};
  const changeHeader=()=>{clock+=1000;expected.updatedAt=new Date().toISOString();expected.revision++;};
  const commit=(name:string,delta:any)=>{const old=version;const result=timed(name,()=>store.applyTaskDelta(cfg.taskId,version,delta));version=result.version;assert.notEqual(version,old);assert.equal(result.updatedAt,expected.updatedAt);};
  for(let i=0;i<9;i++){const value=timed('warmFullRead',()=>store.task(cfg.taskId));assert.deepStrictEqual(value,expected);}checkpoint('warmFullRead');
  const active=new Set(['pending','unresolved','blocked']),activeValues=expected.plan.map((value:any,position:number)=>({value,position,occurrenceId:planRefs[position]})).filter((r:any)=>active.has(r.value.status)).slice(0,1000);
  for(let i=0;i<9;i++){const value=timed('activeRead',()=>store.taskItems(cfg.taskId,'plan',{statuses:[...active],limit:1000}));assert.deepStrictEqual(value.items,activeValues);}checkpoint('activeRead');
  for(let i=0;i<9;i++){const value=timed('headerRead',()=>store.taskHeader(cfg.taskId));assert.deepStrictEqual(value.header,header(expected));}checkpoint('headerRead');
  for(let i=0;i<9;i++){changeHeader();commit('headerOnlyCAS',{header:header(expected)});}checkpoint('headerOnlyCAS');
  const roundIndex=expected.rounds.length-1;
  for(let i=0;i<9;i++){changeHeader();commit('unchangedRoundCAS',{header:header(expected),rounds:{update:[{occurrenceId:roundRefs[roundIndex],value:expected.rounds[roundIndex]}]}});}checkpoint('unchangedRoundCAS');
  const activeIndex=expected.plan.findIndex((value:any)=>active.has(value.status));assert(activeIndex>=0);
  for(let i=0;i<9;i++){changeHeader();expected.plan[activeIndex].reason=`active-cost-${i}`;commit('activeItemCAS',{header:header(expected),plan:{update:[{occurrenceId:planRefs[activeIndex],value:expected.plan[activeIndex]}]},rounds:{update:[{occurrenceId:roundRefs[roundIndex],value:expected.rounds[roundIndex]}]}});}checkpoint('activeItemCAS');
  for(let i=0;i<9;i++){changeHeader();expected.rounds[roundIndex].actions++;expected.rounds[roundIndex].tried.push(`cost-only-operation-${i}`);commit('changedRoundCAS',{header:header(expected),rounds:{update:[{occurrenceId:roundRefs[roundIndex],value:expected.rounds[roundIndex]}]}});}checkpoint('changedRoundCAS');
  for(let i=0;i<5;i++){changeHeader();const old=version;version=timed('unchangedItemsFullSave',()=>store.save(expected,version));assert.notEqual(version,old);}checkpoint('unchangedItemsFullSave');
  assert.throws(()=>store.applyTaskDelta(cfg.taskId,initial.version,{header:header(expected),plan:{remove:[planRefs[0]]}}),/STALE_TASK_VERSION/);invariant();

  // Untimed instrumentation verifies the mechanism without adding string-byte
  // accounting to the measured CAS loops. It uses one more real header/round CAS.
  phase='untimedMechanism';const parse=JSON.parse,statement=(store as any).statement.bind(store),count={parseCalls:0,parseBytes:0,coldJsonRows:0,coldJsonBytes:0,coldProbes:0};
  JSON.parse=((value:string,...args:any[])=>{count.parseCalls++;count.parseBytes+=Buffer.byteLength(value);return (parse as any)(value,...args);}) as typeof JSON.parse;
  (store as any).statement=(sql:string)=>{
    const prepared=statement(sql);if(!sql.includes('INDEXED BY task_cold_items'))return prepared;
    return new Proxy(prepared,{get(target,key){if(key==='get')return (...args:any[])=>{count.coldProbes++;return target.get(...args);};if(key==='all')return (...args:any[])=>{const rows=target.all(...args);for(const row of rows)if(typeof row.json==='string'){count.coldJsonRows++;count.coldJsonBytes+=Buffer.byteLength(row.json);}return rows;};return Reflect.get(target,key,target);}});
  };
  try{changeHeader();const result=store.applyTaskDelta(cfg.taskId,version,{header:header(expected),rounds:{update:[{occurrenceId:roundRefs[roundIndex],value:expected.rounds[roundIndex]}]}});version=result.version;}finally{JSON.parse=parse;(store as any).statement=statement;}
  const beforeMaintenance=files(cfg.database),beforeMaintenanceState=store.taskState(cfg.taskId);
  const maintenance=timed('maintenance',()=>store.compactTaskStorage({reclaim:true}));assert.deepStrictEqual(store.taskState(cfg.taskId),beforeMaintenanceState);checkpoint('maintenance');
  const afterMaintenance=files(cfg.database);assert.deepStrictEqual(allEvents(),events);assert.deepStrictEqual(store.decisions(cfg.taskId),decisions);assert.deepStrictEqual(db.pragma('foreign_key_check'),[]);assert.deepStrictEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);

  const final=invariant();assert.deepStrictEqual(allEvents(),events);assert.deepStrictEqual(store.decisions(cfg.taskId),decisions);
  const semantic={initial:{task:initial.task,plan:initial.plan,rounds:initial.rounds},phaseChecks,final:{task:final.task,plan:final.plan,rounds:final.rounds},events,decisions};
  const semanticJson=JSON.stringify(semantic);writeFileSync(cfg.semantic,gzipSync(semanticJson,{level:3}));
  const result:any={revision:cfg.revision,scenario:cfg.scenario,pid:process.pid,timingsMs:Object.fromEntries(Object.entries(metrics).map(([key,v])=>[key,summarize(v.samples)])),transactionBodyMs:Object.fromEntries(Object.entries(transactionBodies).map(([key,v])=>[key,summarize(v)])),mechanism:count,counts:{plan:initial.plan.length,rounds:initial.rounds.length,events:events.length,decisions:decisions.length},bytes:{initialTask:bytes(initial.task),initialHeader:bytes(header(initial.task)),initialCurrentRound:bytes(initial.task.rounds.at(-1)),finalTask:bytes(final.task),semantic:Buffer.byteLength(semanticJson)},initialLayout,maintenance,beforeMaintenance,afterMaintenance,resources:{maxRSSKiB:process.resourceUsage().maxRSS,samples:memory},semanticSha256:createHash('sha256').update(semanticJson).digest('hex'),phaseChecks,versionContract:{staleRejected:true,changedEachWrite:true,occurrencesRetained:true,maintenanceVersionUnchanged:true},limits:['Local disposable SQLite only; no browser/provider/engine.','First full read is first API read in a fresh process; OS page caches are not flushed.','Transaction body clock includes canonical decoding inside the write lock, excluding BEGIN/COMMIT.','Random CAS tokens are checked for transitions/stale rejection, not compared byte-for-byte.','maxRSS includes fixture, repeated full correctness comparisons, audit export and serialization.']};
  store.close();result['closedFiles']=files(cfg.database);writeFileSync(cfg.output,JSON.stringify(result,null,2)+'\n');
}
