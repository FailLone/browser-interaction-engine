import {readFileSync,writeFileSync} from 'node:fs';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';import {hash,createHash} from 'node:crypto';
const path=readFileSync('/tmp/bie-task-read-cost-path','utf8'),cfg=JSON.parse(readFileSync(`${path}/setup.json`));const Database=createRequire(`${cfg.root}/packages/explorer-plugin/package.json`)('better-sqlite3');const {ExplorerStore}=await import(pathToFileURL(`${cfg.root}/packages/explorer-plugin/src/store.ts`));
const result={scope:'Small feasibility only; in-process alternatives, no production edit, no formal performance claim.',fixtures:{}};
for(const [name,fixture] of Object.entries(cfg.fixtures)){
 const db=new Database(fixture.database,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');const expectedStore=Object.assign(Object.create(ExplorerStore.prototype),{db,statements:new Map(),statementBytes:0});const expected=expectedStore.taskState(fixture.id);const outcomes={};
 for(const mode of ['baseline','oneshot','blob','blob-oneshot']){
  const store=Object.assign(Object.create(ExplorerStore.prototype),{db,statements:new Map(),statementBytes:0});
  if(mode!=='baseline'){
   const original=store.readItem.bind(store);
   store.readItem=(item,cache,copy=false)=>{
    if(item.chunk_id!==null)return original({...item,json:Buffer.isBuffer(item.json)?item.json.toString('utf8'):item.json},cache,copy);
    if(!/^[a-f0-9]{32}$/.test(item.occurrence_id)||!Number.isSafeInteger(item.position)||item.position<0)throw Error('CORRUPT_TASK');
    const digest=mode.includes('oneshot')?hash('sha256',item.json):createHash('sha256').update(item.json).digest('hex');
    if(item.chunk_slot!==null||digest!==item.content_hash)throw Error('CORRUPT_TASK');const value=JSON.parse(Buffer.isBuffer(item.json)?item.json.toString('utf8'):item.json);
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CORRUPT_TASK');const projection=store.itemProjection(value);if(item.status!==projection.status||item.required!==projection.required||item.session_id!==projection.sessionId)throw Error('CORRUPT_TASK');return value;
   };
   if(mode.startsWith('blob')){const prepare=store.statement.bind(store);store.statement=(sql)=>prepare(sql.replace('SELECT kind,position,json,content_hash','SELECT kind,position,CAST(json AS BLOB),content_hash'));}
  }
  const samples=[];for(let i=0;i<4;i++){const start=performance.now();const value=store.taskState(fixture.id);samples.push(performance.now()-start);assert.deepStrictEqual(value,expected);}outcomes[mode]=samples;
 }
 result.fixtures[name]={outcomes,totalChanges:db.prepare('SELECT total_changes() AS n').get().n};db.close();
}
writeFileSync(`${path}/variants.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
