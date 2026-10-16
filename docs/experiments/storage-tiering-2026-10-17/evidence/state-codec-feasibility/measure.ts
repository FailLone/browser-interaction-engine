/** Read-only codec feasibility probe; never constructs SqliteStore, changes its
 * source, writes SQLite, opens a browser or accesses any other task database.
 * Writes only aggregate measurements and hashes, never state JSON values.
 * Run with Node 24: node --experimental-strip-types path/to/measure.ts
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync, zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';

const root=resolve(import.meta.dirname,'../../../../..');
const databasePath=join(root,'.data/okx-storage-acceptance-20261017-v1/engine/engine.sqlite');
const Database=createRequire(join(root,'packages/storage-sqlite/package.json'))('better-sqlite3') as typeof import('better-sqlite3');
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const startedAt=new Date().toISOString();
const files=readdirSync(join(root,'packages/storage-sqlite/src')).filter(name=>name.endsWith('.ts')).sort().map(name=>`packages/storage-sqlite/src/${name}`);
const sourceHashes=Object.fromEntries(files.map(file=>[file,digest(readFileSync(join(root,file)))]));
type Raw={kind:string;id:string;session_id:string;json:string;compressed_json:Buffer|null};
const database=new Database(databasePath,{readonly:true,fileMustExist:true});
let snapshot:{at:string;schemaVersion:unknown;rows:Raw[];entityPayloadBytes:number};
try{
  if(!database.readonly)throw Error('Read-only connection required');
  snapshot=database.transaction(()=>({at:new Date().toISOString(),schemaVersion:database.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get(),
    rows:database.prepare("SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind='state' ORDER BY rowid").all() as Raw[],
    entityPayloadBytes:(database.prepare('SELECT sum(length(CAST(json AS BLOB))+coalesce(length(compressed_json),0)) AS bytes FROM entities').get() as {bytes:number}).bytes}))();
}finally{database.close();}
const rows=snapshot.rows.map(row=>{
  if(row.compressed_json!==null)throw Error('This probe requires the original plain-state dataset');
  const value=JSON.parse(row.json),bytes=Buffer.from(row.json);
  if(value.id!==row.id||(value.sessionId??value.id)!==row.session_id||JSON.stringify(value)!==row.json)throw Error('Source identity/serialization mismatch');
  return {...row,value,bytes,sha256:digest(bytes)};
});
if(!rows.length)throw Error('No state rows');
type Algorithm={name:string;codec:'plain'|'gzip'|'zstd';level?:number;compress?:(bytes:Buffer)=>Buffer;decompress?:(bytes:Buffer,max:number)=>Buffer};
const algorithms:Algorithm[]=[{name:'plain',codec:'plain'},...[1,3,6].map(level=>({name:`gzip-${level}`,codec:'gzip' as const,level,compress:(bytes:Buffer)=>gzipSync(bytes,{level}),decompress:(bytes:Buffer,max:number)=>gunzipSync(bytes,{maxOutputLength:max})})),
  ...[1,3].map(level=>({name:`zstd-${level}`,codec:'zstd' as const,level,compress:(bytes:Buffer)=>zstdCompressSync(bytes,{params:{[constants.ZSTD_c_compressionLevel]:level}}),decompress:(bytes:Buffer,max:number)=>zstdDecompressSync(bytes,{maxOutputLength:max})}))];
// Prototype only: proposed self-contained envelope, not an exported product API.
function encode(row:typeof rows[number],algorithm:Algorithm):Raw{
  const json=JSON.stringify(row.value);
  if(algorithm.codec==='plain')return {kind:row.kind,id:row.id,session_id:row.session_id,json,compressed_json:null};
  const bytes=Buffer.from(json),compressed=algorithm.compress!(bytes);
  return {kind:row.kind,id:row.id,session_id:row.session_id,json:JSON.stringify({$interactionStorage:{format:'entity',version:1,kind:row.kind,codec:algorithm.codec,bytes:bytes.length,sha256:digest(bytes)},id:row.id,sessionId:row.session_id}),compressed_json:compressed};
}
function decode(row:Raw,algorithm:Algorithm):unknown{
  const envelope=JSON.parse(row.json);
  if(algorithm.codec==='plain')return envelope;
  const h=envelope?.$interactionStorage;
  if(!h||h.format!=='entity'||h.version!==1||h.kind!=='state'||h.kind!==row.kind||h.codec!==algorithm.codec||!Number.isSafeInteger(h.bytes)||h.bytes<=0||!(/^[a-f0-9]{64}$/).test(h.sha256)||envelope.id!==row.id||envelope.sessionId!==row.session_id||row.compressed_json===null)throw Error('Invalid proposed state manifest');
  const bytes=algorithm.decompress!(row.compressed_json,h.bytes);
  if(bytes.length!==h.bytes||digest(bytes)!==h.sha256)throw Error('Content integrity failed');
  const value=JSON.parse(bytes.toString('utf8'));
  if(value?.id!==row.id||(value?.sessionId??value?.id)!==row.session_id)throw Error('Content owner mismatch');
  return value;
}
const quantiles=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {count:values.length,min:sorted[0],p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1)};};
const encoded=new Map<string,Raw[]>(),stats=new Map(algorithms.map(algorithm=>[algorithm.name,{encodeBatchWallMs:[] as number[],decodeBatchWallMs:[] as number[],encodeBatchCpuMs:[] as number[],decodeBatchCpuMs:[] as number[],encodeRowWallMs:[] as number[],decodeRowWallMs:[] as number[],verifiedRows:0,rejectedCorruptionCases:[] as string[]}]));
for(const algorithm of algorithms){
  const values=rows.map(row=>encode(row,algorithm));encoded.set(algorithm.name,values);
  for(let i=0;i<rows.length;i++){
    if(JSON.stringify(decode(values[i],algorithm))!==rows[i].json)throw Error('Exact state roundtrip mismatch');
    stats.get(algorithm.name)!.verifiedRows++;
  }
  if(algorithm.codec==='plain')continue;
  const good=values[0],changeManifest=(change:(value:any)=>void)=>{const value=JSON.parse(good.json);change(value);return {...good,json:JSON.stringify(value)};};
  const damaged=Buffer.from(good.compressed_json!);damaged[Math.floor(damaged.length/2)]^=0xff;
  const cases:Record<string,Raw>={wrongKind:{...good,kind:'identity'},wrongId:{...good,id:'wrong'},wrongSession:{...good,session_id:'wrong'},missingBlob:{...good,compressed_json:null},truncatedBlob:{...good,compressed_json:good.compressed_json!.subarray(0,12)},damagedBlob:{...good,compressed_json:damaged},wrongHash:changeManifest(m=>{m.$interactionStorage.sha256='0'.repeat(64);}),wrongSize:changeManifest(m=>{m.$interactionStorage.bytes--;})};
  for(const [name,value] of Object.entries(cases)){let failed=false;try{decode(value,algorithm);}catch{failed=true;}if(!failed)throw Error(`Prototype accepted ${algorithm.name}:${name}`);stats.get(algorithm.name)!.rejectedCorruptionCases.push(name);}
}
const repetitions=21,warmups=3;
let sink=0;
for(let round=-warmups;round<repetitions;round++){
  const offset=(round+warmups)%algorithms.length,order=[...algorithms.slice(offset),...algorithms.slice(0,offset)];if(round%2)order.reverse();
  for(const algorithm of order){
    const measurement=stats.get(algorithm.name)!,record=round>=0;
    for(const phase of round%2?['decode','encode']:['encode','decode']){
      const cpu=process.cpuUsage(),start=performance.now(),individual:number[]=[];
      for(let index=0;index<rows.length;index++){
        const began=performance.now();
        if(phase==='encode'){const value=encode(rows[index],algorithm);sink+=value.json.length+(value.compressed_json?.length??0);}
        else {const value=decode(encoded.get(algorithm.name)![index],algorithm) as {id:string};sink+=value.id.length;}
        individual.push(performance.now()-began);
      }
      const wallMs=performance.now()-start,used=process.cpuUsage(cpu),cpuMs=(used.user+used.system)/1000;
      if(record){if(phase==='encode'){measurement.encodeBatchWallMs.push(wallMs);measurement.encodeBatchCpuMs.push(cpuMs);measurement.encodeRowWallMs.push(...individual);}else{measurement.decodeBatchWallMs.push(wallMs);measurement.decodeBatchCpuMs.push(cpuMs);measurement.decodeRowWallMs.push(...individual);}}
    }
  }
}
const logicalBytes=rows.reduce((sum,row)=>sum+row.bytes.length,0);
const results=algorithms.map(algorithm=>{
  const values=encoded.get(algorithm.name)!,measurement=stats.get(algorithm.name)!;
  const manifestBytes=values.reduce((sum,row)=>sum+Buffer.byteLength(row.json),0),compressedBytes=values.reduce((sum,row)=>sum+(row.compressed_json?.length??0),0),payloadBytes=manifestBytes+compressedBytes;
  return {algorithm:algorithm.name,codec:algorithm.codec,level:algorithm.level,manifestBytes,compressedBytes,payloadBytes,savedBytes:logicalBytes-payloadBytes,statePayloadReductionFraction:1-payloadBytes/logicalBytes,allEntitiesPayloadReductionFraction:(logicalBytes-payloadBytes)/snapshot.entityPayloadBytes,
    exactRoundtripRows:measurement.verifiedRows,rejectedCorruptionCases:measurement.rejectedCorruptionCases,
    timing:{encodeBatchWallMs:quantiles(measurement.encodeBatchWallMs),decodeBatchWallMs:quantiles(measurement.decodeBatchWallMs),encodeBatchCpuMs:quantiles(measurement.encodeBatchCpuMs),decodeBatchCpuMs:quantiles(measurement.decodeBatchCpuMs),encodeRowWallMs:quantiles(measurement.encodeRowWallMs),decodeRowWallMs:quantiles(measurement.decodeRowWallMs)},
    rowBytes:values.map((value,index)=>({ordinal:index+1,logicalBytes:rows[index].bytes.length,manifestBytes:Buffer.byteLength(value.json),compressedBytes:value.compressed_json?.length??0})),samples:measurement};
});
const result={protocol:'readonly-real-state-codec-feasibility-v1',startedAt,finishedAt:new Date().toISOString(),source:{headCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),storageSourceDirtySha256:digest(JSON.stringify(sourceHashes)),sourceHashes,measurementScriptSha256:digest(readFileSync(import.meta.filename)),coreEngineSha256:digest(readFileSync(join(root,'packages/core/src/engine.ts')))},
  environment:{node:process.version,zlib:process.versions.zlib,zstd:process.versions.zstd,platform:platform(),arch:arch(),cpu:cpus()[0]?.model},
  scope:{databasePath,connection:{readonly:true,fileMustExist:true},snapshotAt:snapshot.at,schemaVersion:snapshot.schemaVersion,rows:rows.length,logicalBytes,allEntitiesPayloadBytes:snapshot.entityPayloadBytes,rowSha256:rows.map(row=>row.sha256),snapshotReleasedBeforeMeasurements:true},
  protocolNotes:{repetitions,warmups,order:'Rotate codec order each round and reverse every second round; alternate encode/decode order. No explicit GC. All data read once into memory before any codec timings.',encode:'JSON.stringify original parsed state, UTF-8 encode, compression, SHA-256, envelope serialization; plain baseline JSON.stringify only. Omits SQLite write time.',decode:'Envelope parse/validation, bounded decompression, SHA-256, UTF-8 conversion, JSON.parse, SQL kind/id/session ownership validation; plain baseline JSON.parse. Omits SQLite read time.',caveat:'Small single-process codec microbenchmark on one nine-row OKX snapshot, not an isolated whole-application benchmark or real-run speed comparison. Concurrent work and garbage collection may influence timings. Payload savings exclude SQLite indexes/pages/WAL and evidence; no original database was changed.',candidateEnvelope:'Prototype format=entity version=1 kind=state codec=gzip|zstd bytes sha256, plus id and sessionId. Entire state remains inside one row. Product implementation/schema migration not changed.'},results,sink};
const target=join(import.meta.dirname,`measurement-${startedAt.replaceAll(':','-').replaceAll('.','-')}.json`);writeFileSync(target,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({output:target,rows:rows.length,logicalBytes,results:results.map(({algorithm,payloadBytes,statePayloadReductionFraction,timing})=>({algorithm,payloadBytes,statePayloadReductionFraction,encodeBatchMs:timing.encodeBatchWallMs.p50,decodeBatchMs:timing.decodeBatchWallMs.p50,encodeRowMs:timing.encodeRowWallMs.p50,decodeRowMs:timing.decodeRowWallMs.p50}))}));
