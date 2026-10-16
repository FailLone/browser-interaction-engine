/** Real SQLite comparison, isolated temporary databases/processes only.
 * Source engine connection is readonly/fileMustExist; SQLite online backup
 * captures WAL consistently. Never constructs a writer on the source path.
 * Usage: node --import tsx --conditions=development scripts/benchmark-state-compression.ts
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { SqliteStore } from '@interaction/storage-sqlite';

const root=resolve(import.meta.dirname,'..'),hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
type State={id:string;sessionId:string;[key:string]:unknown};
const disk=(directory:string)=>{const files:Record<string,number>={};for(const name of ['engine.sqlite','engine.sqlite-wal','engine.sqlite-shm']){try{files[name]=statSync(join(directory,name)).size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;files[name]=0;}}return {files,totalBytes:Object.values(files).reduce((sum,bytes)=>sum+bytes,0)};};
const quantiles=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {p50:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],min:sorted[0],max:sorted.at(-1)};};
const sourceHashes=(directory:string)=>Object.fromEntries(readdirSync(join(directory,'packages/storage-sqlite/src')).filter(name=>name.endsWith('.ts')).sort().map(name=>{const file=`packages/storage-sqlite/src/${name}`;return [file,hash(readFileSync(join(directory,file)))];}));
const measure=<T>(fn:()=>T)=>{const cpu=process.cpuUsage(),start=performance.now(),value=fn(),wallMs=performance.now()-start,used=process.cpuUsage(cpu);return {value,wallMs,cpuMs:(used.user+used.system)/1000};};

async function worker(config:{sourceRoot:string;directory:string;stateFile:string;snapshot:string;mode:string;workload:string;repetition:number}){
  const Store=(await import(pathToFileURL(join(config.sourceRoot,'packages/storage-sqlite/src/index.ts')).href)).SqliteStore as typeof SqliteStore;
  const values=JSON.parse(readFileSync(config.stateFile,'utf8')) as State[],stateHash=hash(JSON.stringify(values));
  mkdirSync(config.directory,{recursive:true});if(config.workload==='full-engine')cpSync(config.snapshot,join(config.directory,'engine.sqlite'));
  let store=new Store(config.directory);
  const entityHashes=()=>Object.fromEntries((store.db.prepare('SELECT DISTINCT kind FROM entities ORDER BY kind').all() as {kind:string}[]).map(({kind})=>[kind,hash(JSON.stringify(store.list(kind)))]));
  let originalEntities:Record<string,string>|undefined;
  if(config.workload==='full-engine')originalEntities=entityHashes();
  const initialDisk=disk(config.directory);
  let migration:unknown,migrationMs:number|undefined,migrationCpuMs:number|undefined;
  if(config.workload==='full-engine'&&config.mode==='new'){
    const measured=measure(()=>{let cursor=0;const batches=[];for(;;){const batch=store.compressStates({cursor,limit:3});batches.push(batch);cursor=batch.cursor;if(batch.done)return batches;}});
    migration=measured.value;migrationMs=measured.wallMs;migrationCpuMs=measured.cpuMs;
    if(JSON.stringify(entityHashes())!==JSON.stringify(originalEntities))throw Error('Migration changed decoded engine entities');
  }
  const migrationDisk=disk(config.directory);
  const write=measure(()=>{for(const value of values)store.transaction(()=>store.put('state',value));});
  const activeDisk=disk(config.directory),payload=store.db.prepare("SELECT count(*) AS rows,sum(length(CAST(json AS BLOB))+coalesce(length(compressed_json),0)) AS bytes FROM entities WHERE kind='state'").get();
  if(hash(JSON.stringify(store.list('state')))!==stateHash)throw Error('State write changed content');
  const afterWrite=entityHashes();if(originalEntities&&JSON.stringify(afterWrite)!==JSON.stringify(originalEntities))throw Error('State writes changed decoded engine entities');
  const compaction=measure(()=>store.compact());store.close();const compactedDisk=disk(config.directory);
  const open=measure(()=>new Store(config.directory));store=open.value;
  global.gc?.();const memoryBeforeReads=process.memoryUsage();
  const cold=measure(()=>store.list<State>('state'));if(hash(JSON.stringify(cold.value))!==stateHash)throw Error('Cold list mismatch');cold.value=[];
  const getSamples=[] as number[],listSamples=[] as number[],listCpuSamples=[] as number[];
  let peakHeapUsed=process.memoryUsage().heapUsed,peakExternal=process.memoryUsage().external;
  for(let i=0;i<15;i++){
    const found=measure(()=>values.map(value=>store.require<State>('state',value.id)));getSamples.push(found.wallMs);if(hash(JSON.stringify(found.value))!==stateHash)throw Error('Hot get mismatch');found.value=[];
    const list=measure(()=>store.list<State>('state'));listSamples.push(list.wallMs);listCpuSamples.push(list.cpuMs);if(hash(JSON.stringify(list.value))!==stateHash)throw Error('Hot list mismatch');list.value=[];
    const memory=process.memoryUsage();peakHeapUsed=Math.max(peakHeapUsed,memory.heapUsed);peakExternal=Math.max(peakExternal,memory.external);
  }
  global.gc?.();const memoryAfterReads=process.memoryUsage();
  if(JSON.stringify(entityHashes())!==JSON.stringify(afterWrite))throw Error('Reopen changed decoded engine entities');
  const observationStats=store.observationStorageStats();store.close();const closedDisk=disk(config.directory);
  return {...config,initialDisk,migration,migrationMs,migrationCpuMs,migrationDisk,writeMs:write.wallMs,writeCpuMs:write.cpuMs,activeDisk,payload,compactionMs:compaction.wallMs,compaction:compaction.value,compactedDisk,openMs:open.wallMs,coldListMs:cold.wallMs,coldListCpuMs:cold.cpuMs,
    hotGetMs:quantiles(getSamples),hotListMs:quantiles(listSamples),hotListCpuMs:quantiles(listCpuSamples),samples:{getSamples,listSamples,listCpuSamples},memoryBeforeReads,memoryAfterReads,retainedHeapDeltaBytes:memoryAfterReads.heapUsed-memoryBeforeReads.heapUsed,retainedExternalDeltaBytes:memoryAfterReads.external-memoryBeforeReads.external,peakHeapUsed,peakExternal,peakRssBytes:process.resourceUsage().maxRSS*1024,closedDisk,verifiedEntityKinds:Object.keys(afterWrite).length,entityHashes:afterWrite,observationStats};
}

if(process.argv[2]==='--worker'){
  const result=await worker(JSON.parse(readFileSync(process.argv[3],'utf8')));console.log(JSON.stringify(result));
}else{
  const temporary=mkdtempSync(join(tmpdir(),'state-sqlite-benchmark-')),startedAt=new Date().toISOString();
  const baselineCommit=execFileSync('git',['rev-parse','6630dfa'],{cwd:root,encoding:'utf8'}).trim();
  const baselineRoot=JSON.parse(execFileSync('python3',[join(root,'docs/experiments/pending-delta-2026-10-17/evidence/prepare-baseline.py'),'--repo',root,'--revision',baselineCommit],{cwd:root,encoding:'utf8'})).sourceRoot as string;
  try{
    const Database=createRequire(join(root,'packages/storage-sqlite/package.json'))('better-sqlite3') as typeof import('better-sqlite3');
    const source=join(root,'.data/okx-storage-acceptance-20261017-v1/engine/engine.sqlite'),snapshot=join(temporary,'snapshot.sqlite'),sourceDb=new Database(source,{readonly:true,fileMustExist:true});
    try{if(!sourceDb.readonly)throw Error('Readonly source required');await sourceDb.backup(snapshot);}finally{sourceDb.close();}
    const copy=new Database(snapshot,{readonly:true,fileMustExist:true});let values:State[],snapshotMetadata:unknown;
    try{values=(copy.prepare("SELECT json,compressed_json FROM entities WHERE kind='state' ORDER BY rowid").all() as {json:string;compressed_json:Buffer|null}[]).map(row=>{if(row.compressed_json)throw Error('Expected original plain state snapshot');return JSON.parse(row.json) as State;});snapshotMetadata={schemaVersion:copy.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get(),entityKinds:copy.prepare('SELECT kind,count(*) AS rows FROM entities GROUP BY kind ORDER BY kind').all(),snapshotBytes:statSync(snapshot).size,snapshotSha256:hash(readFileSync(snapshot))};}finally{copy.close();}
    const stateFile=join(temporary,'states.json');writeFileSync(stateFile,JSON.stringify(values));
    const hashes=sourceHashes(root),baselineHashes=sourceHashes(baselineRoot),runs=[];
    const repetitions=Number(process.env.STATE_BENCH_REPETITIONS??5);
    for(let repetition=0;repetition<repetitions;repetition++)for(const workload of ['nine-states','full-engine'])for(const mode of repetition%2?['new','baseline']:['baseline','new']){
      const config={sourceRoot:mode==='new'?root:baselineRoot,directory:join(temporary,`${repetition}-${workload}-${mode}`),stateFile,snapshot,mode,workload,repetition},configuration=join(temporary,'worker.json');writeFileSync(configuration,JSON.stringify(config));
      const output=execFileSync(process.execPath,['--expose-gc','--import',join(root,'node_modules/tsx/dist/loader.mjs'),'--conditions=development',import.meta.filename,'--worker',configuration],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
      runs.push(JSON.parse(output));
    }
    const NewStore=(await import(pathToFileURL(join(root,'packages/storage-sqlite/src/index.ts')).href)).SqliteStore as typeof SqliteStore;
    const OldStore=(await import(pathToFileURL(join(baselineRoot,'packages/storage-sqlite/src/index.ts')).href)).SqliteStore as typeof SqliteStore;
    const rejectionDirectory=join(temporary,'old-binary-rejection'),fresh=new NewStore(rejectionDirectory);fresh.put('state',values[0]);fresh.close();let oldBinaryRejected=false;
    try{const old=new OldStore(rejectionDirectory);old.close();}catch(error){oldBinaryRejected=String(error).includes('Unsupported database schema 4');}if(!oldBinaryRejected)throw Error('Actual v3 binary accepted schema4');
    const summary=[];
    for(const workload of ['nine-states','full-engine'])for(const mode of ['baseline','new']){const selected=runs.filter(run=>run.workload===workload&&run.mode===mode);summary.push({workload,mode,runs:selected.length,writeMs:quantiles(selected.map(run=>run.writeMs)),coldListMs:quantiles(selected.map(run=>run.coldListMs)),hotListMs:quantiles(selected.map(run=>run.hotListMs.p50)),hotGetMs:quantiles(selected.map(run=>run.hotGetMs.p50)),migrationMs:mode==='new'&&workload==='full-engine'?quantiles(selected.map(run=>run.migrationMs)):undefined,activeBytes:quantiles(selected.map(run=>run.activeDisk.totalBytes)),compactedBytes:quantiles(selected.map(run=>run.compactedDisk.totalBytes)),peakRssBytes:quantiles(selected.map(run=>run.peakRssBytes)),retainedHeapDeltaBytes:quantiles(selected.map(run=>run.retainedHeapDeltaBytes)),retainedExternalDeltaBytes:quantiles(selected.map(run=>run.retainedExternalDeltaBytes))});}
    const sourceHashesAfter=sourceHashes(root);if(JSON.stringify(sourceHashesAfter)!==JSON.stringify(hashes))throw Error('Storage source changed during measurement');
    const result={protocol:'real-state-sqlite-v1',startedAt,finishedAt:new Date().toISOString(),node:process.version,baselineCommit,baselineHashes,baselineSourceDirtySha256:hash(JSON.stringify(baselineHashes)),baselineIsolation:'Complete git archive; workspace imports resolve within the archive. Only third-party installed dependencies are shared read-only.',sourceHashes:hashes,sourceHashesAfter,sourceDirtySha256:hash(JSON.stringify(hashes)),scriptSha256:hash(readFileSync(import.meta.filename)),snapshot:{source,connection:{readonly:true,fileMustExist:true},...snapshotMetadata as object,stateRows:values.length,stateJsonBytes:Buffer.byteLength(JSON.stringify(values)),stateSha256:hash(JSON.stringify(values))},repetitions,oldBinaryRejected,protocolNotes:{isolation:'Fresh child process and independent temporary database for every workload/mode/repetition; alternate mode order. SQLite online backup captures original committed engine contents including WAL. No evidence files copied because entity checks do not read artifacts.',write:'Nine actual state values, one SqliteStore transaction per put; full-engine new run first explicitly migrates three rows per batch, then measures nine same-value updates. Baseline full-engine preserves legacy rows. All entity kinds hash equally before/after migration, writes and reopen.',read:'Cold means first state list after reopening the Store, not a flushed OS disk cache. Fifteen hot get-all and list calls per worker, timing excludes exact-value hash comparisons.',memory:'Node --expose-gc. memoryBeforeReads and memoryAfterReads bracket state reads with forced GC; peak process RSS also includes startup, migration and whole-engine verification. State input values retained equally in both modes. RSS is not a clean cache-only cost.',storage:'Active DB+WAL+SHM immediately after writes, then explicit compact on both modes. Compacted and closed SQLite sizes include entity indexes and Observation tables; no evidence artifact bytes.',claim:'Actual SQLite microbenchmark on this one real OKX snapshot, not a browser run or end-to-end OKX speed claim.'},summary,runs};
    const target=join(root,'docs/experiments/storage-tiering-2026-10-17/evidence/state-codec-feasibility',`sqlite-${startedAt.replaceAll(':','-').replaceAll('.','-')}.json`);writeFileSync(target,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({output:target,sourceDirtySha256:result.sourceDirtySha256,oldBinaryRejected,summary}));
  }finally{rmSync(temporary,{recursive:true,force:true});rmSync(baselineRoot,{recursive:true,force:true});}
}
