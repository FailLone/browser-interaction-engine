/** Run from the repository root with Node 24 --import tsx --conditions=development.
 * Uses only exclusive copies; never opens the frozen database via SQLite. */
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir,cpus,platform,release} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {deepStrictEqual} from 'node:assert';
const root=process.cwd(),out=fileURLToPath(new URL('.',import.meta.url));
const frozen=join(root,'.data/okx-storage-acceptance-20261017-v1-frozen-4/engine/engine.sqlite');
const digest=value=>createHash('sha256').update(value).digest('hex');
const bytes=path=>{try{return statSync(path).size;}catch{return 0;}};
const sqliteRequire=createRequire(join(root,'packages/storage-sqlite/package.json')),Database=sqliteRequire('better-sqlite3');
const loadInput=()=>JSON.parse(gunzipSync(readFileSync(join(out,'write-input-actions.json.gz'))));
const encodedRows=rows=>JSON.stringify(rows);
const sourceHashes=()=>Object.fromEntries(['packages/core/src/ports.ts','packages/core/src/engine.ts','packages/storage-sqlite/src/index.ts','packages/storage-memory/src/index.ts','packages/storage-retained/src/index.ts','tests/action-observation-query.test.ts'].map(p=>[p,digest(readFileSync(join(root,p)))]));
if(process.argv[2]==='--child'){
  const [trialText,mode,base,directory,resultPath]=process.argv.slice(3),trial=Number(trialText);
  if(!['unindexed','indexed'].includes(mode)||!directory.startsWith(tmpdir())||resolve(base)===resolve(frozen))throw Error('Expected owned temporary database copy');
  mkdirSync(directory,{recursive:true});copyFileSync(base,join(directory,'engine.sqlite'));
  const {SqliteStore}=await import(pathToFileURL(join(root,'packages/storage-sqlite/src/index.ts')).href);
  const opened=performance.now(),store=new SqliteStore(directory),openMs=performance.now()-opened;
  try{
    const input=loadInput(),indexSql=store.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='entities_action_observation'").get().sql;
    store.db.exec('DROP INDEX entities_action_observation');store.db.pragma('wal_checkpoint(TRUNCATE)');
    const buildStart=performance.now();store.db.exec(indexSql);const indexBuildMs=performance.now()-buildStart;
    const indexBytes=store.db.prepare("SELECT sum(pgsize) AS bytes,count(*) AS pages FROM dbstat WHERE name='entities_action_observation'").get();
    if(mode==='unindexed')store.db.exec('DROP INDEX entities_action_observation');
    // Remove the dropped index's free pages in both configurations. All setup is
    // outside timed writes. No custom PRAGMA changes the product transaction policy.
    store.compact();
    const settings=Object.fromEntries(['journal_mode','synchronous','wal_autocheckpoint','page_size','freelist_count'].map(k=>[k,store.db.pragma(k,{simple:true})]));
    const initialDatabaseBytes=bytes(join(directory,'engine.sqlite'));
    const batches=input.batches.map(b=>({...b,values:b.rows.map(r=>JSON.parse(r.json))}));
    const warm=batches[0].values.slice(0,64).map(v=>({...v,id:`action-index-bench:warm:${v.id}`}));
    store.transaction(()=>{for(const value of warm)store.put('action',value);});
    store.transaction(()=>{for(const value of batches[0].values.slice(0,64))store.put('action',value);});
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    const measurements=[];
    for(const operation of ['insert','update-unchanged'])for(const batch of batches){
      const values=operation==='insert'?batch.values.map(v=>({...v,id:`action-index-bench:new:${v.id}`})):batch.values;
      const expected=values.map(v=>({id:v.id,json:JSON.stringify(v)}));
      const cpu=process.cpuUsage(),started=performance.now();
      store.transaction(()=>{for(const value of values)store.put('action',value);});
      const elapsedMs=performance.now()-started,cpuUs=process.cpuUsage(cpu);
      const actual=values.map(v=>({id:v.id,json:store.db.prepare("SELECT json FROM entities WHERE kind='action' AND id=?").get(v.id).json}));
      deepStrictEqual(actual,expected,'Full written JSON differs from requested batch');
      const measurement={operation,batch:batch.batch,rows:values.length,inputSha256:batch.sha256,expectedSha256:digest(encodedRows(expected)),resultSha256:digest(encodedRows(actual)),elapsedMs,cpuUs,rssBytes:process.memoryUsage().rss,walBytes:bytes(join(directory,'engine.sqlite-wal')),databaseBytes:bytes(join(directory,'engine.sqlite'))};
      measurements.push(measurement);
    }
    const finalRows=store.db.prepare("SELECT id,session_id,json FROM entities WHERE kind='action' ORDER BY rowid").all();
    const finalSha256=digest(encodedRows(finalRows)),finalActionCount=finalRows.length;
    const integrity=store.db.pragma('integrity_check',{simple:true});if(integrity!=='ok')throw Error('Copy integrity check failed');
    const finalIndex=store.db.prepare("SELECT coalesce(sum(pgsize),0) AS bytes,count(*) AS pages FROM dbstat WHERE name='entities_action_observation'").get();
    const report={trial,mode,pid:process.pid,directory,openMs,indexBuildMs,indexBytes,settings,initialDatabaseBytes,measurements,finalActionCount,finalSha256,finalIndex,integrity,sourceSha256:sourceHashes(),node:process.version,sqlite:store.db.prepare('SELECT sqlite_version() AS version').get().version};
    writeFileSync(resultPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({trial,mode,pid:process.pid,indexBuildMs,finalActionCount,finalSha256,measurements:measurements.map(({operation,batch,rows,elapsedMs,resultSha256})=>({operation,batch,rows,elapsedMs,resultSha256}))},null,2));
  }finally{store.close();}
}else{
  const work=mkdtempSync(join(tmpdir(),'okx-action-index-write-')),base=join(work,'baseline.sqlite');
  copyFileSync(frozen,base); // The only access to frozen SQLite is a byte-for-byte copy.
  const db=new Database(base,{readonly:true,fileMustExist:true});let input;
  try{
    const rows=db.prepare("SELECT id,session_id,json FROM entities WHERE kind='action' AND compressed_json IS NULL ORDER BY rowid").all();
    const batchSize=512,batchCount=3,total=batchSize*batchCount;
    if(rows.length<total)throw Error('Not enough real action rows for fixed samples');
    const chosen=Array.from({length:total},(_,i)=>rows[Math.floor(i*rows.length/total)]);
    input={frozenRelative:'.data/okx-storage-acceptance-20261017-v1-frozen-4/engine/engine.sqlite',frozenSha256:digest(readFileSync(base)),totalAvailable:rows.length,sampling:'1536 evenly spaced rows across the stored action row order; 3 fixed batches of 512',batches:Array.from({length:batchCount},(_,i)=>{const selected=chosen.slice(i*batchSize,(i+1)*batchSize);return {batch:i+1,rows:selected,sha256:digest(encodedRows(selected))};})};
  }finally{db.close();}
  const raw=Buffer.from(JSON.stringify(input));writeFileSync(join(out,'write-input-actions.json.gz'),gzipSync(raw,{mtime:0,level:6}));
  writeFileSync(join(out,'write-input-manifest.json'),JSON.stringify({...input,batches:input.batches.map(b=>({batch:b.batch,rows:b.rows.length,sha256:b.sha256,sourceIds:b.rows.map(r=>r.id)})),uncompressedBytes:raw.length,uncompressedSha256:digest(raw)},null,2)+'\n');
  const startedAt=new Date().toISOString(),trials=[];
  for(let trial=1;trial<=3;trial++)for(const mode of trial%2?['unindexed','indexed']:['indexed','unindexed']){
    const name=`write-trial-${trial}-${mode}`,resultPath=join(out,name+'.json'),directory=join(work,name);
    const child=spawnSync(process.execPath,[...process.execArgv,fileURLToPath(import.meta.url),'--child',String(trial),mode,base,directory,resultPath],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
    writeFileSync(join(out,name+'.log'),(child.stdout||'')+(child.stderr||''));
    if(child.status!==0)throw Error(`${name} failed with ${child.status}; see log`);
    trials.push(JSON.parse(readFileSync(resultPath,'utf8')));
  }
  const first=trials[0];for(const trial of trials){deepStrictEqual(trial.finalSha256,first.finalSha256);deepStrictEqual(trial.finalActionCount,first.finalActionCount);deepStrictEqual(trial.sourceSha256,first.sourceSha256);for(let i=0;i<trial.measurements.length;i++)deepStrictEqual(trial.measurements[i].resultSha256,first.measurements[i].resultSha256);}
  const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
  const summary=Object.fromEntries(['insert','update-unchanged'].map(operation=>{const values=Object.fromEntries(['unindexed','indexed'].map(mode=>[mode,trials.filter(t=>t.mode===mode).map(t=>t.measurements.filter(m=>m.operation===operation).reduce((n,m)=>n+m.elapsedMs,0))]));return [operation,{rowsPerTrial:1536,totalsMs:values,medianUnindexedMs:median(values.unindexed),medianIndexedMs:median(values.indexed),medianRatio:median(values.indexed)/median(values.unindexed)}];}));
  const report={startedAt,finishedAt:new Date().toISOString(),work,node:process.version,system:{platform:platform(),release:release(),cpu:cpus()[0]?.model,cpuCount:cpus().length},sourceSha256:first.sourceSha256,sourceFrozenSha256:input.frozenSha256,inputManifest:'write-input-manifest.json',independentProcesses:trials.length,order:trials.map(t=>({trial:t.trial,mode:t.mode,pid:t.pid})),summary,indexBuildMs:trials.map(t=>t.indexBuildMs),initialIndexBytes:trials.map(t=>t.indexBytes.bytes),finalSha256:first.finalSha256,finalActionCount:first.finalActionCount,allBatchResultsEqual:true,allIntegrityChecksPassed:true,limitations:['Dedicated agent CPU window; other operating-system activity was not fully controlled.','Three alternating independent process pairs; three 512-row transactions per operation. Batch wall time includes SqliteStore.put ownership checks, serialization, SQLite writes and transaction commit.','Insert clones only the real action ID to avoid existing-row conflicts; all other real action JSON fields are preserved. Updates rewrite existing actual JSON unchanged; changing semantic fields is not measured.','Both modes start from separate copies, compact setup identically, use product-default WAL/PRAGMA settings and identical 64-row warmups. No provider/browser/network or original/frozen database opens.','Index rebuild timings are warm-cache setup measurements, not cold-start guarantees.'],trials:trials.map(t=>({trial:t.trial,mode:t.mode,json:`write-trial-${t.trial}-${t.mode}.json`,log:`write-trial-${t.trial}-${t.mode}.log`}))};
  writeFileSync(join(out,'write-comparison.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
