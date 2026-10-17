import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const path=readFileSync('/tmp/bie-task-read-cost-path','utf8'),cfg=JSON.parse(readFileSync(`${path}/setup.json`));
const req=createRequire(`${cfg.root}/packages/explorer-plugin/package.json`),Database=req('better-sqlite3');
const {ExplorerStore}=await import(pathToFileURL(`${cfg.root}/packages/explorer-plugin/src/store.ts`));
const result={scope:cfg.scope,fixtures:{}};
for(const [name,fixture] of Object.entries(cfg.fixtures)){
 const db=new Database(fixture.database,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
 const store=Object.create(ExplorerStore.prototype);store.db=db;store.statements=new Map();store.statementBytes=0;
 const rowstats=db.prepare('SELECT kind,count(*) AS records,sum(chunk_id IS NOT NULL) AS packed,sum(length(CAST(json AS BLOB))) AS plainBytes FROM task_items WHERE task_id=? GROUP BY kind').all(fixture.id);
 let started=performance.now();const first=store.taskState(fixture.id);const firstMs=performance.now()-started;
 const metrics={parseCalls:0,parseMs:0,parseBytes:0,hashCalls:0,hashMs:0,hashBytes:0,sqlCalls:0,sqlMs:0,headerMs:0,readItemCalls:0,readItemMs:0,decodeChunkCalls:0,decodeChunkMs:0};
 const parse=JSON.parse,createHash=crypto.createHash,statement=store.statement.bind(store);
 JSON.parse=(s,...args)=>{const t=performance.now();try{return parse(s,...args)}finally{metrics.parseCalls++;metrics.parseMs+=performance.now()-t;metrics.parseBytes+=Buffer.byteLength(s)}};
 crypto.createHash=(...args)=>{const t=performance.now();const hash=createHash(...args);metrics.hashCalls++;metrics.hashMs+=performance.now()-t;return new Proxy(hash,{get(target,key){if(key==='update')return (value,...opts)=>{const start=performance.now();try{target.update(value,...opts);return proxy;}finally{metrics.hashMs+=performance.now()-start;metrics.hashBytes+=Buffer.byteLength(value)}};if(key==='digest')return (...params)=>{const start=performance.now();try{return target.digest(...params)}finally{metrics.hashMs+=performance.now()-start}};return Reflect.get(target,key,target)}});var proxy;};
 // Preserve Hash chain identity while counting only primitive operation time.
 crypto.createHash=(...args)=>{let t=performance.now();const target=createHash(...args);metrics.hashCalls++;metrics.hashMs+=performance.now()-t;let proxy;proxy=new Proxy(target,{get(o,k){if(k==='update')return (v,...a)=>{const st=performance.now();try{o.update(v,...a);return proxy}finally{metrics.hashMs+=performance.now()-st;metrics.hashBytes+=Buffer.byteLength(v)}};if(k==='digest')return (...a)=>{const st=performance.now();try{return o.digest(...a)}finally{metrics.hashMs+=performance.now()-st}};return Reflect.get(o,k,o)}});return proxy;};
 syncBuiltinESMExports();
 for(const method of ['header','readItem','decodeChunk']){const original=store[method].bind(store);store[method]=(...args)=>{const t=performance.now();try{return original(...args)}finally{metrics[method+'Ms']+=performance.now()-t;if(method!=='header')metrics[method+'Calls']++}}}
 store.statement=(sql)=>{const stmt=statement(sql);let proxy;proxy=new Proxy(stmt,{get(target,key){if(key==='raw')return (...args)=>{target.raw(...args);return proxy};if(['get','all'].includes(key))return (...args)=>{const t=performance.now();try{return target[key](...args)}finally{metrics.sqlCalls++;metrics.sqlMs+=performance.now()-t}};return Reflect.get(target,key,target)}});return proxy;};
 let warm,warmMs;
 try{started=performance.now();warm=store.taskState(fixture.id);warmMs=performance.now()-started;}finally{JSON.parse=parse;crypto.createHash=createHash;syncBuiltinESMExports();}
 assert.deepEqual(warm,first);
 const plain=db.prepare('SELECT json,content_hash FROM task_items WHERE task_id=? AND chunk_id IS NULL').all(fixture.id);
 const hashes={};for(const mode of ['createHash','hash']){const samples=[];for(let i=0;i<3;i++){const st=performance.now();const values=plain.map(r=>mode==='hash'?crypto.hash('sha256',r.json):createHash('sha256').update(r.json).digest('hex'));samples.push(performance.now()-st);assert.deepEqual(values,plain.map(r=>r.content_hash))}hashes[mode]=samples;}
 result.fixtures[name]={rowstats,firstMs,instrumentedWarmMs:warmMs,metrics,isolatedPlainHashMs:hashes,taskBytes:Buffer.byteLength(JSON.stringify(first.task)),taskSha256:crypto.hash('sha256',JSON.stringify(first.task)),totalChanges:db.prepare('SELECT total_changes() AS n').get().n};db.close();
}
writeFileSync(`${path}/probe.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
