import type Database from 'better-sqlite3';
import { gzipSync, gunzipSync } from 'node:zlib';
import { corruptEntity, decodeStoredEntity, encodeObservationJson, encodeSharedObservation, sharedObservationLayout, type StoredEntityRow } from './entity-codec.js';
import { observationDigest, observationStructure, type StructuralObject } from './observation-structure.js';

/** Packs amortize compression across many small independently addressed objects.
 * Object IDs never get reused, including after a collection. Session + SHA-256
 * is the content address; the integer is only a compact manifest dictionary key.
 */
export const observationSchema = `
  CREATE TABLE observation_packs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,sha256 BLOB NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes>0),codec TEXT NOT NULL CHECK(codec IN ('identity','gzip')),data BLOB NOT NULL);
  CREATE INDEX observation_packs_session ON observation_packs(session_id);
  CREATE TABLE observation_objects(
    id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,sha256 BLOB NOT NULL,
    pack_id INTEGER NOT NULL REFERENCES observation_packs(id) ON DELETE RESTRICT,
    byte_offset INTEGER NOT NULL CHECK(byte_offset>=0),bytes INTEGER NOT NULL CHECK(bytes>0),
    UNIQUE(session_id,sha256));
  CREATE INDEX observation_objects_pack ON observation_objects(pack_id);`;
interface ObjectRow { id:number;session_id:string;sha256:Buffer;pack_id:number;byte_offset:number;bytes:number }
interface PackRow { id:number;session_id:string;sha256:Buffer;bytes:number;codec:string;data:Buffer }
export interface ObservationStorageStats {
  observations:number;sharedObservations:number;manifestBytes:number;
  objects:number;referencedObjects:number;orphanObjects:number;objectBytes:number;referencedObjectBytes:number;
  packs:number;packedBytes:number;packLogicalBytes:number;fragmentedBytes:number;
}
export interface ObservationGarbageCollectionResult {
  before:ObservationStorageStats;after:ObservationStorageStats;deletedObjects:number;deletedPacks:number;repackedPacks:number;
}
const equalHash=(data:Uint8Array,expected:Uint8Array)=>expected?.length===32&&observationDigest(data).equals(expected);
const positive=(value:number)=>Number.isSafeInteger(value)&&value>0;

export class ObservationObjectStore {
  private addressQueries=new Map<number,Database.Statement>();
  private priorShapes=new Map<string,Set<string>>();
  private backoff=new Map<string,{failures:number;skip:number}>();
  private readonly insertObject:Database.Statement;
  private readonly insertPack:Database.Statement;
  private readonly loadObjects:Database.Statement;
  private readonly loadPacks:Database.Statement;
  private stamp?:{total:number;dataVersion:number;schemaVersion:number;tempSchemaVersion:number};
  private readonly changeStamp:Database.Statement;
  private readonly tempStamp:Database.Statement;
  private fragments=new Map<string,{object:StructuralObject;key:string}>();
  private fragmentBytes=0;
  private addresses=new Map<string,number>();
  private decoded=new Map<string,Buffer>();
  private decodedBytes=0;
  private reconstructed=new Map<string,{manifest:string;compressed:Buffer;json:string;bytes:number}>();
  private reconstructedBytes=0;
  // Content caches are bounded independently of retained history. Raw fragments
  // have an 8 MiB / 2048-entry budget (including string + Buffer estimates), and
  // verified decoded objects have an 8 MiB / 4096-entry budget. No cache crosses
  // an unknown SQLite change, an external transaction, or a rollback.
  // Cache misses batch unique objects and packs into two SQL queries.
  constructor(private readonly db:Database.Database,private readonly changed:(count:number)=>void) {
    this.changeStamp=db.prepare('SELECT total_changes() AS total,(SELECT data_version FROM pragma_data_version) AS dataVersion,(SELECT schema_version FROM pragma_schema_version) AS schemaVersion');
    this.tempStamp=db.prepare('PRAGMA temp.schema_version');
    this.insertObject=db.prepare('INSERT INTO observation_objects(session_id,sha256,pack_id,byte_offset,bytes) VALUES(?,?,?,?,?)');
    this.insertPack=db.prepare('INSERT INTO observation_packs(session_id,sha256,bytes,codec,data) VALUES(?,?,?,?,?)');
    this.loadObjects=db.prepare('SELECT * FROM observation_objects WHERE session_id=? AND id IN (SELECT value FROM json_each(?))');
    this.loadPacks=db.prepare('SELECT * FROM observation_packs WHERE session_id=? AND id IN (SELECT value FROM json_each(?))');
  }
  cacheStats() {return {reconstructedEntries:this.reconstructed.size,reconstructedBytes:this.reconstructedBytes,fragmentEntries:this.fragments.size,fragmentBytes:this.fragmentBytes,addressEntries:this.addresses.size,decodedEntries:this.decoded.size,decodedBytes:this.decodedBytes,admissionSessions:this.priorShapes.size,backoffSessions:this.backoff.size,admissionObjectHashes:[...this.priorShapes.values()].reduce((sum,shape)=>sum+shape.size,0)};}
  private clearContent() {this.reconstructed.clear();this.reconstructedBytes=0;this.fragments.clear();this.addresses.clear();this.decoded.clear();this.fragmentBytes=0;this.decodedBytes=0;}
  invalidate() {this.clearContent();this.priorShapes.clear();this.backoff.clear();this.stamp=undefined;}
  begin(cacheable:boolean) {
    const stamp={...(this.changeStamp.get() as NonNullable<ObservationObjectStore['stamp']>),tempSchemaVersion:(this.tempStamp.get() as {schema_version:number}).schema_version};
    if(!this.stamp||this.stamp.total!==stamp.total||this.stamp.dataVersion!==stamp.dataVersion||this.stamp.schemaVersion!==stamp.schemaVersion||this.stamp.tempSchemaVersion!==stamp.tempSchemaVersion)this.invalidate();
    else if(!cacheable)this.clearContent();
    this.stamp=stamp;
  }
  // Admission hints contain hashes only and cannot authorize object reuse. They
  // may outlive an external transaction; verified addresses/bytes never do.
  end(cacheable:boolean) {if(!cacheable)this.clearContent();}
  knownWrite(count:number) {if(this.stamp)this.stamp.total+=count;}
  private written(count:number) {this.changed(count);this.knownWrite(count);}
  /** Cache verified serialized bytes, never mutable objects. Every read still
   * returns a detached JSON parse. The row is reread in the same DB snapshot;
   * normal ownership, digest, raw-write, transaction and TEMP-DDL fences remain.
   * Four entries / 16 MiB include text, copied compressed bytes and key cost. */
  decode<T>(row:StoredEntityRow):T {
    if(row.kind!=='observation'||!row.id||!row.session_id||row.compressed_json==null)return decodeStoredEntity<T>(row,this.resolve);
    const key=JSON.stringify([row.session_id,row.id]),cached=this.reconstructed.get(key);
    if(cached&&cached.manifest===row.json&&cached.compressed.equals(row.compressed_json)){
      this.reconstructed.delete(key);this.reconstructed.set(key,cached);return JSON.parse(cached.json) as T;
    }
    let json:string|undefined;
    const value=decodeStoredEntity<T>(row,this.resolve,text=>{json=text;});
    if(json!==undefined){
      const bytes=(json.length+row.json.length+key.length)*2+row.compressed_json.byteLength+128;
      if(cached){this.reconstructed.delete(key);this.reconstructedBytes-=cached.bytes;}
      if(bytes<=16*1024*1024){this.reconstructed.set(key,{manifest:row.json,compressed:Buffer.from(row.compressed_json),json,bytes});this.reconstructedBytes+=bytes;}
      while(this.reconstructed.size>4||this.reconstructedBytes>16*1024*1024){const first=this.reconstructed.keys().next().value!;this.reconstructedBytes-=this.reconstructed.get(first)!.bytes;this.reconstructed.delete(first);}
    }
    return value;
  }
  private materialize=(value:string|Buffer):StructuralObject=>{
    const cacheKey=typeof value==='string'?`j:${value}`:`b:${value.toString('latin1')}`;
    const cached=this.fragments.get(cacheKey);
    if(cached){this.fragments.delete(cached.key);this.fragments.set(cached.key,cached);return cached.object;}
    const data=typeof value==='string'?Buffer.from(value):value,sha256=observationDigest(data),object={data,sha256,key:sha256.toString('hex')};
    const cost=cacheKey.length*2+data.length+128;
    if(cost<=8*1024*1024){const detachedKey=typeof value==='string'?`j:${data.toString('utf8')}`:`b:${data.toString('latin1')}`;this.fragments.set(detachedKey,{object,key:detachedKey});this.fragmentBytes+=cost;}
    while(this.fragments.size>2048||this.fragmentBytes>8*1024*1024){const key=this.fragments.keys().next().value!,entry=this.fragments.get(key)!;this.fragments.delete(key);this.fragmentBytes-=key.length*2+entry.object.data.length+128;}
    return object;
  };
  private rememberAddress(sessionId:string,object:StructuralObject,id:number){
    const key=`${sessionId}:${object.key}`;if(key.length>1024)return;this.addresses.delete(key);this.addresses.set(key,id);
    if(this.addresses.size>4096)this.addresses.delete(this.addresses.keys().next().value!);
  }
  private rememberDecoded(sessionId:string,id:number,data:Buffer){
    const key=`${sessionId}:${id}`;if(key.length>1024)return;const prior=this.decoded.get(key);if(prior){this.decodedBytes-=prior.length;this.decoded.delete(key);}
    if(data.length>8*1024*1024)return;
    // Copy the slice: retaining a small live object must not retain a whole pack.
    this.decoded.set(key,Buffer.from(data));this.decodedBytes+=data.length;
    while(this.decoded.size>4096||this.decodedBytes>8*1024*1024){const first=this.decoded.keys().next().value!;this.decodedBytes-=this.decoded.get(first)!.length;this.decoded.delete(first);}
  }
  private pack(sessionId:string,data:Buffer) {
    const compressed=data.length>=1024?gzipSync(data,{level:6}):data,codec=compressed.length<data.length?'gzip':'identity';
    const result=this.insertPack.run(sessionId,observationDigest(data),data.length,codec,codec==='gzip'?compressed:data);
    this.written(result.changes);return Number(result.lastInsertRowid);
  }
  encode(json:string,sessionId:string):StoredEntityRow {
    if(Buffer.byteLength(json)<1024)return encodeObservationJson(json);
    const backoff=this.backoff.get(sessionId);
    if(backoff&&backoff.skip>0){backoff.skip--;return encodeObservationJson(json);}
    const structure=observationStructure(json,this.materialize);
    if(structure.objects.length===0)return encodeObservationJson(json);
    const ids=new Map<StructuralObject,number>(),pending:StructuralObject[]=[],existing:number[]=[],unknown:StructuralObject[]=[];
    for(const object of structure.objects) {
      const cached=this.addresses.get(`${sessionId}:${object.key}`);
      if(cached!==undefined){ids.set(object,cached);this.rememberAddress(sessionId,object,cached);}else unknown.push(object);
    }
    for(let offset=0;offset<unknown.length;offset+=256) {
      const batch=unknown.slice(offset,offset+256);let statement=this.addressQueries.get(batch.length);
      if(!statement){statement=this.db.prepare(`SELECT id,sha256,bytes FROM observation_objects WHERE session_id=? AND sha256 IN (${batch.map(()=>'?').join(',')})`);this.addressQueries.set(batch.length,statement);if(this.addressQueries.size>16)this.addressQueries.delete(this.addressQueries.keys().next().value!);}
      const found=new Map((statement.all(sessionId,...batch.map(object=>object.sha256)) as {id:number;sha256:Buffer;bytes:number}[]).map(row=>[row.sha256.toString('hex'),row]));
      for(const object of batch){const row=found.get(object.key);if(row){if(row.bytes!==object.data.length)throw corruptEntity();ids.set(object,row.id);existing.push(row.id);}else pending.push(object);}
    }
    const pendingBytes=pending.reduce((sum,object)=>sum+object.data.length,0),totalBytes=structure.objects.reduce((sum,object)=>sum+object.data.length,0),prior=this.priorShapes.get(sessionId);
    const stableNewBytes=pending.reduce((sum,object)=>sum+(prior?.has(object.key)?object.data.length:0),0);
    if(structure.objects.length<=4096&&sessionId.length<=1024){this.priorShapes.delete(sessionId);this.priorShapes.set(sessionId,new Set(structure.objects.map(object=>object.key)));if(this.priorShapes.size>4)this.priorShapes.delete(this.priorShapes.keys().next().value!);}
    // Whole-value gzip remains cheaper for mostly novel content. A bounded prior
    // shape hint admits a new stable regime on its second frame, so fallback
    // cannot permanently prevent a changed page from joining the shared store.
    // The hint only chooses encoding; no identity or captured fact depends on it.
    if(pendingBytes>4096&&(pending.length>32||pendingBytes>32768)&&pendingBytes>totalBytes*.25&&stableNewBytes<pendingBytes*.75
      &&this.db.prepare('SELECT 1 FROM observation_objects WHERE session_id=? LIMIT 1').get(sessionId)){
      // After two mostly novel frames, skip at most four analyses. Probes retain
      // the prior shape, so a new stable regime is admitted on its second probe.
      if(sessionId.length<=1024){const failures=Math.min(2,(backoff?.failures??0)+1);this.backoff.delete(sessionId);this.backoff.set(sessionId,{failures,skip:failures>=2?4:0});if(this.backoff.size>4)this.backoff.delete(this.backoff.keys().next().value!);}
      return encodeObservationJson(json);
    }
    this.backoff.delete(sessionId);
    // Reuse must not bless a damaged pre-existing object/pack. The same batched
    // verification used by reads catches raw writes and other-connection damage.
    if(existing.length)this.resolve(existing,sessionId);
    for(const object of structure.objects){const id=ids.get(object);if(id!==undefined)this.rememberAddress(sessionId,object,id);}
    let batch:StructuralObject[]=[],bytes=0;
    const flush=()=>{
      if(!batch.length)return;
      const pack=this.pack(sessionId,Buffer.concat(batch.map(object=>object.data),bytes));let offset=0;
      for(const object of batch) {
        const result=this.insertObject.run(sessionId,object.sha256,pack,offset,object.data.length);
        this.written(result.changes);const id=Number(result.lastInsertRowid);ids.set(object,id);this.rememberAddress(sessionId,object,id);this.rememberDecoded(sessionId,id,object.data);offset+=object.data.length;
      }
      batch=[];bytes=0;
    };
    for(const object of pending) {if(bytes+object.data.length>65536)flush();batch.push(object);bytes+=object.data.length;}flush();
    return encodeSharedObservation(json,sessionId,structure.pieces.map(piece=>typeof piece==='string'?piece:ids.get(piece)!),structure.metadata);
  }
  resolve=(ids:readonly number[],sessionId:string):ReadonlyMap<number,Uint8Array>=>{
    const unique=[...new Set(ids)],result=new Map<number,Uint8Array>(),missing:number[]=[];
    if(unique.some(id=>!positive(id)))throw corruptEntity();
    for(const id of unique){const key=`${sessionId}:${id}`,cached=this.decoded.get(key);if(cached){this.decoded.delete(key);this.decoded.set(key,cached);result.set(id,cached);}else missing.push(id);}
    if(!missing.length)return result;
    const objects=this.loadObjects.all(sessionId,JSON.stringify(missing)) as ObjectRow[];
    if(objects.length!==missing.length)throw corruptEntity();
    const packs=this.loadPacks.all(sessionId,JSON.stringify([...new Set(objects.map(object=>object.pack_id))])) as PackRow[];
    const unpacked=new Map<number,Buffer>();
    for(const pack of packs)unpacked.set(pack.id,this.unpack(pack));
    for(const object of objects) {
      const data=unpacked.get(object.pack_id);
      if(!data||!positive(object.bytes)||!Number.isSafeInteger(object.byte_offset)||object.byte_offset<0||object.byte_offset+object.bytes>data.length)throw corruptEntity();
      const bytes=data.subarray(object.byte_offset,object.byte_offset+object.bytes);
      if(!equalHash(bytes,object.sha256))throw corruptEntity();result.set(object.id,bytes);this.rememberDecoded(sessionId,object.id,bytes);
    }
    return result;
  };
  private unpack(pack:PackRow) {
    try {
      if(!positive(pack.bytes)||!['identity','gzip'].includes(pack.codec))throw corruptEntity();
      const data=pack.codec==='gzip'?gunzipSync(pack.data,{maxOutputLength:pack.bytes}):pack.data;
      if(data.length!==pack.bytes||!equalHash(data,pack.sha256))throw corruptEntity();return data;
    }catch{throw corruptEntity();}
  }
  private roots(sessionId?:string,verify=false) {
    const rows=(sessionId===undefined?this.db.prepare("SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind='observation'").all():this.db.prepare("SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind='observation' AND session_id=?").all(sessionId)) as StoredEntityRow[];
    const marked=new Set<number>();let shared=0;
    for(const row of rows) {
      const sharedLayout=sharedObservationLayout(row);
      if(sharedLayout){shared++;for(const part of sharedLayout.layout)if(typeof part==='number')marked.add(part);}
      if(verify)decodeStoredEntity(row,this.resolve);
    }
    return {rows,marked,shared};
  }
  private allObjects(sessionId?:string):ObjectRow[] {return (sessionId===undefined?this.db.prepare('SELECT * FROM observation_objects').all():this.db.prepare('SELECT * FROM observation_objects WHERE session_id=?').all(sessionId)) as ObjectRow[];}
  private allPacks(sessionId?:string):PackRow[] {return (sessionId===undefined?this.db.prepare('SELECT * FROM observation_packs').all():this.db.prepare('SELECT * FROM observation_packs WHERE session_id=?').all(sessionId)) as PackRow[];}
  private statistics(roots:ReturnType<ObservationObjectStore['roots']>,sessionId?:string):ObservationStorageStats {
    const objects=this.allObjects(sessionId),packs=this.allPacks(sessionId),referenced=objects.filter(object=>roots.marked.has(object.id));
    if(referenced.length!==roots.marked.size)throw corruptEntity();
    const referencedObjectBytes=referenced.reduce((sum,object)=>sum+object.bytes,0),packLogicalBytes=packs.reduce((sum,pack)=>sum+pack.bytes,0);
    return {observations:roots.rows.length,sharedObservations:roots.shared,manifestBytes:roots.rows.reduce((sum,row)=>sum+Buffer.byteLength(row.json)+(row.compressed_json?.byteLength??0),0),
      objects:objects.length,referencedObjects:referenced.length,orphanObjects:objects.length-referenced.length,objectBytes:objects.reduce((sum,object)=>sum+object.bytes,0),referencedObjectBytes,
      packs:packs.length,packedBytes:packs.reduce((sum,pack)=>sum+pack.data.length,0),packLogicalBytes,fragmentedBytes:packLogicalBytes-referencedObjectBytes};
  }
  stats(sessionId?:string):ObservationStorageStats {return this.statistics(this.roots(sessionId),sessionId);}
  /** Caller holds an IMMEDIATE transaction. Every root is fully reconstructed
   * before the first deletion; rollback restores the complete old graph. */
  collect(options:{sessionId?:string;repack?:boolean}={}):ObservationGarbageCollectionResult {
    const roots=this.roots(options.sessionId,true),before=this.statistics(roots,options.sessionId);
    const result=this.db.prepare(`DELETE FROM observation_objects WHERE id NOT IN (SELECT value FROM json_each(?))${options.sessionId===undefined?'':' AND session_id=?'}`).run(JSON.stringify([...roots.marked]),...(options.sessionId===undefined?[]:[options.sessionId]));
    this.written(result.changes);let repackedPacks=0;
    if(options.repack) {
      const byPack=new Map<number,ObjectRow[]>();
      for(const object of this.allObjects(options.sessionId)){const members=byPack.get(object.pack_id)??[];members.push(object);byPack.set(object.pack_id,members);}
      for(const pack of this.allPacks(options.sessionId)) {
        const objects=byPack.get(pack.id);if(!objects?.length||objects.reduce((sum,object)=>sum+object.bytes,0)===pack.bytes)continue;
        const source=this.unpack(pack),data=Buffer.concat(objects.map(object=>source.subarray(object.byte_offset,object.byte_offset+object.bytes)));
        const newPack=this.pack(pack.session_id,data);let offset=0;
        for(const object of objects){const moved=this.db.prepare('UPDATE observation_objects SET pack_id=?,byte_offset=? WHERE id=?').run(newPack,offset,object.id);this.written(moved.changes);offset+=object.bytes;}
        repackedPacks++;
      }
    }
    const removed=this.db.prepare(`DELETE FROM observation_packs WHERE NOT EXISTS (SELECT 1 FROM observation_objects WHERE pack_id=observation_packs.id)${options.sessionId===undefined?'':' AND session_id=?'}`).run(...(options.sessionId===undefined?[]:[options.sessionId]));
    this.written(removed.changes);
    return {before,after:this.statistics(roots,options.sessionId),deletedObjects:result.changes,deletedPacks:removed.changes,repackedPacks};
  }
}
