/** Read-only, one owned OKX acceptance engine database. Never creates SqliteStore,
 * runs migrations/checkpoints/GC, or accesses a browser/provider/task database.
 * SQLite graph is copied in a short read transaction, decoded after releasing
 * that snapshot; evidence filesystem accounting is explicitly non-atomic. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeStoredEntity, sharedObservationLayout, type StoredEntityRow } from '../../../../../packages/storage-sqlite/src/entity-codec.js';
const root=resolve(import.meta.dirname,'../../../../..'),owned=join(root,'.data/okx-storage-acceptance-20261017-v1/engine'),dbPath=join(owned,'engine.sqlite');
const Database=createRequire(join(root,'packages/storage-sqlite/package.json'))('better-sqlite3') as typeof import('better-sqlite3');
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex'),startedAt=new Date().toISOString();
const sourceFiles=readdirSync(join(root,'packages/storage-sqlite/src')).filter(name=>name.endsWith('.ts')).sort().map(name=>`packages/storage-sqlite/src/${name}`);
const sourceHashes=Object.fromEntries(sourceFiles.map(path=>[path,hash(readFileSync(join(root,path)))]));
const db=new Database(dbPath,{readonly:true,fileMustExist:true});
if(!db.readonly)throw Error('Read-only connection required');
let snapshot:any;
try {
  snapshot=db.transaction(()=>({
    capturedAt:new Date().toISOString(),schemaVersion:db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get(),
    pageCount:db.pragma('page_count',{simple:true}),pageSize:db.pragma('page_size',{simple:true}),freePages:db.pragma('freelist_count',{simple:true}),
    entityKinds:db.prepare('SELECT kind,count(*) AS count,sum(length(CAST(json AS BLOB))) AS jsonBytes,sum(coalesce(length(compressed_json),0)) AS compressedBytes,sum(length(CAST(json AS BLOB))+coalesce(length(compressed_json),0)) AS payloadBytes,max(length(CAST(json AS BLOB))+coalesce(length(compressed_json),0)) AS largestPayloadBytes FROM entities GROUP BY kind ORDER BY payloadBytes DESC').all(),
    fieldContributors:db.prepare("SELECT e.kind,j.key AS field,count(*) AS rows,sum(CASE j.type WHEN 'text' THEN length(CAST(json_quote(j.value) AS BLOB)) WHEN 'null' THEN 4 ELSE length(CAST(j.value AS BLOB)) END) AS serializedValueBytes FROM entities e,json_each(e.json) j WHERE e.kind IN ('state','identity','action') AND e.compressed_json IS NULL GROUP BY e.kind,j.key ORDER BY e.kind,serializedValueBytes DESC").all(),
    events:db.prepare('SELECT count(*) AS count,sum(length(CAST(json AS BLOB))) AS jsonBytes FROM events').get(),
    requests:db.prepare('SELECT count(*) AS count,sum(length(CAST(payload AS BLOB))) AS payloadBytes FROM requests').get(),
    observations:db.prepare("SELECT rowid AS ordinal,kind,id,session_id,json,compressed_json FROM entities WHERE kind='observation' ORDER BY rowid").all(),
    objects:db.prepare('SELECT * FROM observation_objects').all(),packs:db.prepare('SELECT * FROM observation_packs').all(),
    missingPacks:db.prepare('SELECT count(*) AS count FROM observation_objects o LEFT JOIN observation_packs p ON p.id=o.pack_id WHERE p.id IS NULL').get(),
    crossSessionPacks:db.prepare('SELECT count(*) AS count FROM observation_objects o JOIN observation_packs p ON p.id=o.pack_id WHERE p.session_id<>o.session_id').get(),
  }))();
}finally{db.close();}
const objects=new Map<number,any>(snapshot.objects.map((object:any)=>[object.id,object])),packs=new Map<number,any>(snapshot.packs.map((pack:any)=>[pack.id,pack])),decodedPacks=new Map<number,Buffer>(),verifiedObjects=new Map<number,Buffer>();
const resolveObjects=(ids:readonly number[],sessionId:string)=>new Map(ids.map(id=>{
  const object=objects.get(id);if(!object||object.session_id!==sessionId)throw Error('Missing/cross-session observation object');
  const prior=verifiedObjects.get(id);if(prior)return [id,prior];
  const pack=packs.get(object.pack_id);if(!pack||pack.session_id!==sessionId)throw Error('Missing/cross-session observation pack');
  let data=decodedPacks.get(pack.id);
  if(!data){if(!['identity','gzip'].includes(pack.codec)||!Number.isSafeInteger(pack.bytes)||pack.bytes<=0)throw Error('Invalid pack descriptor');data=pack.codec==='gzip'?gunzipSync(pack.data,{maxOutputLength:pack.bytes}):pack.data;if(data!.length!==pack.bytes||hash(data!)!==Buffer.from(pack.sha256).toString('hex'))throw Error('Pack integrity failed');decodedPacks.set(pack.id,data!);}
  if(!Number.isSafeInteger(object.byte_offset)||object.byte_offset<0||!Number.isSafeInteger(object.bytes)||object.bytes<=0||object.byte_offset+object.bytes>data!.length)throw Error('Invalid object range');
  const value=data!.subarray(object.byte_offset,object.byte_offset+object.bytes);if(hash(value)!==Buffer.from(object.sha256).toString('hex'))throw Error('Object integrity failed');verifiedObjects.set(id,value);return [id,value];
}));
const byFormat:Record<string,{count:number;logicalBytes:number;rowPayloadBytes:number}>={},frames:any[]=[],integrityErrors:any[]=[],allReferences=new Set<number>(),referenceCounts=new Map<number,number>();
const previous=new Map<string,{references:Set<number>;controls:Map<string,any>}>();
const controlMap=(controls:any[])=>{const seen=new Map<string,number>();return new Map(controls.map(control=>{const selector=typeof control.selector==='string'?control.selector:`${control.role}:${control.name}`,n=seen.get(selector)??0;seen.set(selector,n+1);return [`${selector}#${n}`,control];}));};
for(const row of snapshot.observations as (StoredEntityRow&{ordinal:number;id:string;session_id:string})[]){
  try {
    const envelope=JSON.parse(row.json),storage=envelope?.$interactionStorage,format=storage?.format==='observation'?`v${storage.version}:${storage.codec}`:'plain',layout=sharedObservationLayout(row),references=new Set<number>(layout?.layout.filter((part):part is number=>typeof part==='number')??[]);
    const observation=decodeStoredEntity<any>(row,resolveObjects),logicalBytes=Buffer.byteLength(JSON.stringify(observation)),prior=previous.get(row.session_id),controls=controlMap(observation.controls??[]);
    let common=0,exactUnchanged=0,localIdChanged=0,instanceIdChanged=0,identityIdChanged=0;const controlFieldChanges:Record<string,number>={};
    for(const [key,control] of controls){const old=prior?.controls.get(key);if(!old)continue;common++;const fields=[...new Set([...Object.keys(old),...Object.keys(control)])].filter(field=>JSON.stringify(old[field])!==JSON.stringify(control[field]));if(!fields.length)exactUnchanged++;for(const field of fields)controlFieldChanges[field]=(controlFieldChanges[field]??0)+1;localIdChanged+=Number(old.localId!==control.localId);instanceIdChanged+=Number(old.instanceId!==control.instanceId);identityIdChanged+=Number(old.identityId!==control.identityId);}
    const rowPayloadBytes=Buffer.byteLength(row.json)+(row.compressed_json?.length??0),stats=byFormat[format]??={count:0,logicalBytes:0,rowPayloadBytes:0};stats.count++;stats.logicalBytes+=logicalBytes;stats.rowPayloadBytes+=rowPayloadBytes;
    const reusedEarlier=[...references].filter(id=>allReferences.has(id)),reusedPrevious=[...references].filter(id=>prior?.references.has(id));
    const sum=(ids:Iterable<number>)=>[...ids].reduce((total,id)=>total+(objects.get(id)?.bytes??0),0);
    frames.push({ordinal:row.ordinal,id:row.id,format,controls:controls.size,regions:observation.regions?.length??0,logicalBytes,rowPayloadBytes,uniqueReferences:references.size,reusedEarlierObjects:reusedEarlier.length,reusedPreviousObjects:reusedPrevious.length,newlySeenReferencedObjects:references.size-reusedEarlier.length,referencedObjectBytes:sum(references),reusedEarlierObjectBytes:sum(reusedEarlier),reusedPreviousObjectBytes:sum(reusedPrevious),
      controlComparison:prior?{common,exactUnchanged,localIdChanged,instanceIdChanged,identityIdChanged,controlFieldChanges}:undefined});
    for(const id of references){allReferences.add(id);referenceCounts.set(id,(referenceCounts.get(id)??0)+1);}previous.set(row.session_id,{references,controls});
  }catch(error){integrityErrors.push({observationId:row.id,error:error instanceof Error?error.message:String(error)});}
}
const objectBytes=snapshot.objects.reduce((n:number,o:any)=>n+o.bytes,0),referencedObjectBytes=[...allReferences].reduce((n,id)=>n+(objects.get(id)?.bytes??0),0),packLogicalBytes=snapshot.packs.reduce((n:number,p:any)=>n+p.bytes,0),packedBytes=snapshot.packs.reduce((n:number,p:any)=>n+p.data.length,0);
const filesystem:any={capturedAt:new Date().toISOString(),files:{},totalSqliteFileBytes:0};
for(const name of ['engine.sqlite','engine.sqlite-wal','engine.sqlite-shm']){try{const s=statSync(join(owned,name));filesystem.files[name]={bytes:s.size,allocatedBytes:s.blocks*512};filesystem.totalSqliteFileBytes+=s.size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;filesystem.files[name]={bytes:0};}}
const evidencePath=join(owned,'evidence'),evidence:any={scanStartedAt:new Date().toISOString(),consistency:'Non-atomic filesystem scan; missing/unreferenced candidates may reflect any concurrent publication/deletion races. No lock or GC acquired.',manifestCount:0,manifestBytes:0,declaredLogicalBytes:0,blobFiles:0,blobBytes:0,blobAllocatedBytes:0,temporaryBlobFiles:0,temporaryBlobBytes:0,logicalBlockReferences:0,manifestVersions:{},byMediaType:{},invalidManifests:[],missingReferencedBlobs:[],racedFiles:0};
const blobReferences=new Map<string,{count:number;bytes:number}>();
for(const name of readdirSync(evidencePath).filter(name=>name.endsWith('.meta.json'))){
  try{const raw=readFileSync(join(evidencePath,name)),manifest=JSON.parse(raw.toString('utf8'));evidence.manifestCount++;evidence.manifestBytes+=raw.length;evidence.declaredLogicalBytes+=Number(manifest.bytes??0);const version=String(manifest.version??'legacy');evidence.manifestVersions[version]=(evidence.manifestVersions[version]??0)+1;const type=manifest.mediaType??'unknown',stats=evidence.byMediaType[type]??={manifests:0,logicalBytes:0};stats.manifests++;stats.logicalBytes+=Number(manifest.bytes??0);
    const blocks=manifest.version===3?manifest.blocks:manifest.version===2?[manifest]:[];
    if(!Array.isArray(blocks)){evidence.invalidManifests.push({manifest:name,reason:'blocks is not an array'});continue;}
    for(const block of blocks){if(!/^[a-f0-9]{64}\.(gz|bin)$/.test(block.blob)||!Number.isSafeInteger(block.bytes)||block.bytes<0){evidence.invalidManifests.push({manifest:name,reason:'invalid blob reference'});continue;}evidence.logicalBlockReferences++;const prior=blobReferences.get(block.blob);if(prior&&prior.bytes!==block.bytes)evidence.invalidManifests.push({manifest:name,reason:'same blob has conflicting byte lengths'});blobReferences.set(block.blob,{count:(prior?.count??0)+1,bytes:block.bytes});}
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')evidence.racedFiles++;else evidence.invalidManifests.push({manifest:name,reason:error instanceof Error?error.message:String(error)});}
}
const presentBlobs=new Set<string>();
for(const name of readdirSync(join(evidencePath,'blobs'))){try{const s=statSync(join(evidencePath,'blobs',name));if(!s.isFile())continue;if(/^[a-f0-9]{64}\.(gz|bin)$/.test(name)){presentBlobs.add(name);evidence.blobFiles++;evidence.blobBytes+=s.size;evidence.blobAllocatedBytes+=s.blocks*512;}else{evidence.temporaryBlobFiles++;evidence.temporaryBlobBytes+=s.size;}}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')evidence.racedFiles++;else throw error;}}
for(const name of blobReferences.keys())if(!presentBlobs.has(name))evidence.missingReferencedBlobs.push(name);
evidence.uniqueReferencedBlobs=blobReferences.size;evidence.uniqueReferencedLogicalBytes=[...blobReferences.values()].reduce((n,b)=>n+b.bytes,0);evidence.blobsSharedByMultipleManifests=[...blobReferences.values()].filter(b=>b.count>1).length;evidence.unreferencedCandidates=[...presentBlobs].filter(name=>!blobReferences.has(name)).length;evidence.scanFinishedAt=new Date().toISOString();
const entityPayloadBytes=snapshot.entityKinds.reduce((n:number,k:any)=>n+k.payloadBytes,0);for(const kind of snapshot.entityKinds)kind.entityPayloadFraction=kind.payloadBytes/entityPayloadBytes;
const result={protocol:'okx-owned-engine-readonly-storage-audit-v1',startedAt,finishedAt:new Date().toISOString(),source:{headCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirtySha256:hash(JSON.stringify(sourceHashes)),sourceHashes},scope:{database:dbPath,evidence:evidencePath,connection:{readonly:true,fileMustExist:true},sqliteSnapshotAt:snapshot.capturedAt,exclusions:'No other task database, provider/browser action, migration, checkpoint, GC, or runtime filesystem mutation.'},
  caveat:'Observational accounting, not a baseline comparison or speed claim. Row payload totals omit SQLite row/index/page overhead. Active WAL can contain superseded page images and is not directly additive logical data. Evidence inventory is non-atomic.',
  database:{schemaVersion:snapshot.schemaVersion,pageCount:snapshot.pageCount,pageSize:snapshot.pageSize,freePages:snapshot.freePages,entityPayloadBytes,entityKinds:snapshot.entityKinds,fieldContributors:snapshot.fieldContributors,fieldAccounting:'Top-level JSON value bytes include string escaping but exclude property names/separators; values are never written to this report.',events:snapshot.events,requests:snapshot.requests,filesystem},
  observations:{formats:byFormat,total:snapshot.observations.length,integrityVerified:frames.length,integrityErrors,frames,objects:snapshot.objects.length,objectBytes,referencedObjects:allReferences.size,referencedObjectBytes,unreferencedObjects:snapshot.objects.length-allReferences.size,objectsReferencedByMultipleObservations:[...referenceCounts.values()].filter(count=>count>1).length,packs:snapshot.packs.length,packLogicalBytes,packedBytes,fragmentedLogicalBytes:packLogicalBytes-referencedObjectBytes,verifiedObjects:verifiedObjects.size,verifiedPacks:decodedPacks.size,missingPacks:snapshot.missingPacks,crossSessionPacks:snapshot.crossSessionPacks},evidence};
const target=join(import.meta.dirname,`inspection-${startedAt.replaceAll(':','-').replaceAll('.','-')}.json`);writeFileSync(target,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({output:target,observations:result.observations.total,formats:byFormat,integrityErrors,topEntityKinds:snapshot.entityKinds.slice(0,5),sqliteFilesBytes:filesystem.totalSqliteFileBytes,evidenceBlobBytes:evidence.blobBytes}));
