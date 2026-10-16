import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync,constants as zconst} from 'node:zlib';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,statSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';

const root='/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine';
const require=createRequire(join(root,'packages/storage-sqlite/package.json'));
const Database=require('better-sqlite3');
const base=process.argv[2],command=process.argv[3],mode=process.argv[4],trial=process.argv[5];
const levels={plain:Infinity,'gzip3-32k':32768,'gzip3-1k':1024};
if(!(mode in levels))throw Error('unknown codec');
const sha=data=>createHash('sha256').update(data).digest('hex');
const check=(condition,message)=>{if(!condition)throw Error(message);};
const size=path=>existsSync(path)?statSync(path).size:0;
const rawManifest=(json,id,sessionId)=>({$interactionStorage:{format:'identity',version:1,codec:'gzip',bytes:Buffer.byteLength(json),sha256:sha(json)},id,sessionId});
function encode(json,id,sessionId){
 if(mode==='plain')return {json,compressed_json:null};
 const data=Buffer.from(json),value=JSON.parse(json),reserved=value?.$interactionStorage?.format==='identity';
 check(value?.id===id&&value?.sessionId===sessionId,'INVALID_IDENTITY_OWNER');
 if(data.length<levels[mode]&&!reserved)return {json,compressed_json:null};
 const compressed=gzipSync(data,{level:3}),manifest=JSON.stringify(rawManifest(json,id,sessionId));
 if(Buffer.byteLength(manifest)+compressed.length>data.length*.875&&!reserved)return {json,compressed_json:null};
 return {json:manifest,compressed_json:compressed};
}
function decode(row){
 const parsed=JSON.parse(row.json);
 if(row.compressed_json==null){check(!(parsed?.$interactionStorage?.format==='identity'),'CORRUPT_IDENTITY');return parsed;}
 const h=parsed?.$interactionStorage;
 check(row.kind==='identity'&&parsed.id===row.id&&parsed.sessionId===row.session_id,'CORRUPT_IDENTITY_OWNER');
 check(h?.format==='identity'&&h.version===1&&h.codec==='gzip'&&Number.isSafeInteger(h.bytes)&&h.bytes>0&&/^[a-f0-9]{64}$/.test(h.sha256),'CORRUPT_IDENTITY_MANIFEST');
 const data=gunzipSync(row.compressed_json,{maxOutputLength:h.bytes});
 check(data.length===h.bytes&&sha(data)===h.sha256,'CORRUPT_IDENTITY_CONTENT');
 const value=JSON.parse(data.toString('utf8'));check(value?.id===row.id&&value?.sessionId===row.session_id,'CORRUPT_IDENTITY_CONTENT_OWNER');return value;
}
function open(path){const db=new Database(path);db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');return db;}
function compact(db,path){
 check(!db.inTransaction,'transaction before compact');
 const checkpoint=()=>check(db.pragma('wal_checkpoint(TRUNCATE)').every(x=>x.busy===0),'checkpoint busy');
 checkpoint();db.exec('VACUUM');checkpoint();return {databaseBytes:size(path),walBytes:size(`${path}-wal`),shmBytes:size(`${path}-shm`)};
}
function identityRows(db){return db.prepare("SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind='identity' ORDER BY rowid").all();}
function digestRows(rows){const h=createHash('sha256');for(const row of rows){const json=JSON.stringify(decode(row));h.update(row.id).update('\0').update(sha(json)).update('\n');}return h.digest('hex');}
function encodedStats(db){return db.prepare("SELECT count(*) rows,sum(compressed_json IS NOT NULL) compressedRows,sum(length(cast(json as blob))) jsonBytes,sum(coalesce(length(compressed_json),0)) compressedBytes FROM entities WHERE kind='identity'").get();}
function storage(db,path){return {...encodedStats(db),databaseBytes:size(path),walBytes:size(`${path}-wal`),shmBytes:size(`${path}-shm`),pageSize:db.pragma('page_size',{simple:true}),pageCount:db.pragma('page_count',{simple:true}),freelistPages:db.pragma('freelist_count',{simple:true})};}
function auditContent(db){
 const h=createHash('sha256'),counts={};
 for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()){
  check(/^[a-z_]+$/.test(name),'unexpected table');h.update(name).update('\0');counts[name]=0;
  for(const row of db.prepare(`SELECT * FROM ${name}${name==='entities'?" WHERE kind<>'identity'":''} ORDER BY rowid`).iterate()){
   counts[name]++;for(const [key,value] of Object.entries(row)){const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));h.update(key).update(':').update(String(bytes.length)).update(':').update(bytes);}
  }
 }
 return {sha256:h.digest('hex'),counts};
}
const originalPath=join(base,'owned-copy/engine/engine.sqlite');
if(command==='prepare'){
 const folder=join(base,'prepared',mode);mkdirSync(folder,{recursive:true});const path=join(folder,'engine.sqlite');copyFileSync(originalPath,path);
 const db=open(path),originalRows=identityRows(db),expected=digestRows(originalRows),otherBefore=auditContent(db);
 db.transaction(()=>{const stmt=db.prepare("UPDATE entities SET json=?,compressed_json=? WHERE kind='identity' AND id=? AND session_id=?");for(const row of originalRows){const encoded=encode(row.json,row.id,row.session_id);check(stmt.run(encoded.json,encoded.compressed_json,row.id,row.session_id).changes===1,'row missing');}}).immediate();
 const after=identityRows(db);check(digestRows(after)===expected,'initial identity round trip mismatch');
 check(auditContent(db).sha256===otherBefore.sha256,'other entities or audit records changed');
 const badCases=[];const compressed=after.find(row=>row.compressed_json);
 if(compressed){
  const changeManifest=patch=>{const m=JSON.parse(compressed.json);Object.assign(m.$interactionStorage,patch);return {...compressed,json:JSON.stringify(m)};};
  const wrongContent=JSON.stringify({...decode(compressed),id:'changed'}),wrongManifest=rawManifest(wrongContent,compressed.id,compressed.session_id);
  const bad=[['owner-id',{...compressed,id:'wrong-id'}],['owner-session',{...compressed,session_id:'wrong-session'}],['owner-kind',{...compressed,kind:'state'}],
   ['sha256',changeManifest({sha256:'0'.repeat(64)})],['byte-count-smaller',changeManifest({bytes:1})],['byte-count-larger',changeManifest({bytes:JSON.parse(compressed.json).$interactionStorage.bytes+1})],
   ['truncated',{...compressed,compressed_json:compressed.compressed_json.subarray(0,10)}],['missing-blob',{...compressed,compressed_json:null}],
   ['decoded-owner',{...compressed,json:JSON.stringify(wrongManifest),compressed_json:gzipSync(Buffer.from(wrongContent),{level:3})}]];
  for(const [name,row] of bad){let rejected=false;try{decode(row);}catch{rejected=true;}check(rejected,`accepted corrupt input ${name}`);badCases.push(name);}
 }
 const compacted=compact(db,path);check(db.pragma('integrity_check',{simple:true})==='ok','SQLite integrity failed');
 const result={mode,threshold:levels[mode]===Infinity?null:levels[mode],minimumSavingsFraction:.125,originalIdentityRows:originalRows.length,expectedDigest:expected,decodedDigest:digestRows(identityRows(db)),
  nonIdentityEntitiesUnchanged:true,retainedAuditContent:otherBefore,negativeDecodeChecks:badCases,compacted,storage:storage(db,path),sqliteVersion:db.prepare('select sqlite_version() v').get().v,
  pragma:{journalMode:db.pragma('journal_mode',{simple:true}),synchronous:db.pragma('synchronous',{simple:true}),walAutocheckpoint:db.pragma('wal_autocheckpoint',{simple:true})},
  versions:process.versions};
 db.close();result.databaseSHA256=sha(readFileSync(path));writeFileSync(join(folder,'prepared.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}else if(command==='trial'){
 const folder=join(base,'trials',trial);mkdirSync(folder,{recursive:true});const path=join(folder,'engine.sqlite');copyFileSync(join(base,'prepared',mode,'engine.sqlite'),path);
 const db=open(path),prepared=JSON.parse(readFileSync(join(base,'prepared',mode,'prepared.json'),'utf8'));
 const fixtures=JSON.parse(readFileSync(join(base,'fixtures.json'),'utf8'));const ids=fixtures.rows.map(x=>x.id),sessionId=fixtures.sessionId;
 const current=new Map(fixtures.rows.map(row=>[row.id,JSON.parse(row.json)]));let sink=0;
 const columns=mode==='plain'?'kind,json,compressed_json':'kind,id,session_id,json,compressed_json';
 const get=id=>{const row=db.prepare(`SELECT ${columns} FROM entities WHERE kind=? AND id=?`).get('identity',id);return decode(row);};
 const list=()=>db.prepare(`SELECT ${columns} FROM entities WHERE kind=? AND session_id=? ORDER BY rowid`).all('identity',sessionId).map(decode);
 const time=fn=>{const started=performance.now();const value=fn();return {ms:performance.now()-started,value};};
 const rss=[];const sample=phase=>rss.push({phase,rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed,maxRssKb:process.resourceUsage().maxRSS});
 const gc=()=>global.gc?.();sample('opened-with-fixtures');gc();
 let first=time(list);const firstListMs=first.ms;check(first.value.length===ids.length,'first list count');first=undefined;sample('first-list');gc();
 for(const id of ids){sink+=get(id).occurrences.length;}list();gc();
 const getSamples=[],listSamples=[];
 for(let repeat=0;repeat<5;repeat++){
  const measured=time(()=>{for(let pass=0;pass<2;pass++)for(let i=0;i<ids.length;i++){const value=get(ids[(i*397+repeat)%ids.length]);sink+=value.occurrences.length;}});
  getSamples.push({operations:ids.length*2,ms:measured.ms,msPerOperation:measured.ms/(ids.length*2)});sample(`get-${repeat}`);gc();
  const measuredList=time(()=>{for(let pass=0;pass<3;pass++){const values=list();sink+=values.length+values[0].occurrences.length;}});
  listSamples.push({operations:3,ms:measuredList.ms,msPerOperation:measuredList.ms/3});sample(`list-${repeat}`);gc();
 }
 function put(value){
  const owner=db.prepare('SELECT kind,session_id FROM entities WHERE id=?').get(value.id);
  if(owner)check(owner.kind==='identity'&&owner.session_id===value.sessionId,'ID_CONFLICT');
  const encoded=encode(JSON.stringify(value),value.id,value.sessionId);
  const written=db.prepare('INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,compressed_json=excluded.compressed_json WHERE entities.kind=excluded.kind AND entities.session_id=excluded.session_id')
    .run('identity',value.id,value.sessionId,encoded.json,encoded.compressed_json);
  check(written.changes===1,'write not applied');
 }
 const present=fixtures.rows.filter(row=>JSON.parse(row.json).status==='present').map(row=>row.id),absent=fixtures.rows.filter(row=>JSON.parse(row.json).status!=='present').map(row=>row.id);
 const writes={appendOccurrence:[],unchangedHistoricalRewrite:[],newIdentityInsert:[]};
 for(let repeat=0;repeat<3;repeat++){
  // Synthetic capture workload: append a retained reference, preserving every
  // original occurrence and byte-level field; this is not an SDK identity claim.
  const updates=present.map(id=>{const value=structuredClone(current.get(id));value.occurrences.push(structuredClone(value.occurrences.at(-1)));return value;});
  gc();const update=time(()=>db.transaction(()=>{for(const value of updates)put(value);}).immediate());
  for(const value of updates)current.set(value.id,value);writes.appendOccurrence.push({operations:updates.length,ms:update.ms,msPerOperation:update.ms/updates.length});sample(`update-${repeat}`);
  const unchanged=absent.map(id=>current.get(id));gc();const rewrite=time(()=>db.transaction(()=>{for(const value of unchanged)put(value);}).immediate());
  writes.unchangedHistoricalRewrite.push({operations:unchanged.length,ms:rewrite.ms,msPerOperation:rewrite.ms/unchanged.length});sample(`unchanged-${repeat}`);
  const fresh=present.map((id,index)=>{
   const value=structuredClone(JSON.parse(fixtures.rows.find(row=>row.id===id).json));const h=sha(`${repeat}:${index}:${id}`);
   value.id=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
   value.lastControl.identityId=value.id;value.occurrences=[structuredClone(value.occurrences.at(-1))];return value;
  });
  gc();const inserted=time(()=>db.transaction(()=>{for(const value of fresh)put(value);}).immediate());
  for(const value of fresh)current.set(value.id,value);writes.newIdentityInsert.push({operations:fresh.length,ms:inserted.ms,msPerOperation:inserted.ms/fresh.length});sample(`insert-${repeat}`);
 }
 const beforeCompact=storage(db,path),compaction=time(()=>compact(db,path));sample('compacted');
 const finalRows=identityRows(db),actualDigest=digestRows(finalRows),expectedHash=createHash('sha256');
 for(const row of finalRows){const value=current.get(row.id);check(value,'unexpected identity');expectedHash.update(row.id).update('\0').update(sha(JSON.stringify(value))).update('\n');check(JSON.stringify(decode(row))===JSON.stringify(value),'final mismatch');}
 const expectedDigest=expectedHash.digest('hex');check(expectedDigest===actualDigest,'final digest mismatch');
 for(const fixture of fixtures.rows){const original=JSON.parse(fixture.json),value=current.get(fixture.id);check(JSON.stringify(value.occurrences.slice(0,original.occurrences.length))===JSON.stringify(original.occurrences),'historical occurrence prefix lost');}
 const finalAudit=auditContent(db);check(finalAudit.sha256===prepared.retainedAuditContent.sha256,'non-identity or audit content changed in trial');
 const result={trial,mode,startedAt:new Date().toISOString(),pid:process.pid,versions:process.versions,identityRowsBefore:ids.length,preparedDigest:prepared.decodedDigest,firstListMs,retainedAuditContent:finalAudit,nonIdentityAndAuditUnchanged:true,
  getSamples,listSamples,writes,writeFixture:{present:present.length,unchangedHistorical:absent.length,rounds:3,syntheticNewRows:present.length*3,
   description:'Each present identity appends an exact existing last-occurrence reference. Historical absent rows are rewritten unchanged. New rows use deterministic synthetic UUIDs and one retained occurrence; these isolated payloads are not SDK identity conclusions.'},
  beforeCompact,compacted:compaction.value,compactionMs:compaction.ms,finalStorage:storage(db,path),finalRows:finalRows.length,finalDigest:actualDigest,expectedFinalDigest:expectedDigest,
  allOriginalOccurrencePrefixesRetained:true,rssSamples:rss,peakRssBytes:process.resourceUsage().maxRSS*1024,sink};
 check(db.pragma('integrity_check',{simple:true})==='ok','final SQLite integrity failed');db.close();result.finalDatabaseSHA256=sha(readFileSync(path));
 writeFileSync(join(folder,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}else throw Error('unknown command');
