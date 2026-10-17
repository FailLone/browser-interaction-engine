import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BoundedEntityChanges, canonical, id, now, type Persistence, type EvidenceStore } from '@interaction/core';
import { FileEvidenceStore } from './evidence.js';
import { decodeStoredEntity, encodeObservationJson, encodeStateJson, type StoredEntityRow } from './entity-codec.js';
export { decodeStoredEntity, type StoredEntityRow, type ObservationManifest, type SharedObservationManifest, type StateManifest, type ObservationObjectResolver } from './entity-codec.js';
import { ObservationObjectStore, observationSchema, type ObservationStorageStats, type ObservationGarbageCollectionResult } from './observation-store.js';
export type { ObservationStorageStats, ObservationGarbageCollectionResult } from './observation-store.js';
import { EngineError, type EngineEvent, type Session, type ActionAttempt, type FrontierItem, type InteractionScope, type Observation } from '@interaction/core';

export interface ObservationCompressionResult {
  cursor:number;done:boolean;scanned:number;compressed:number;
  logicalBytesBefore:number;logicalBytesAfter:number;storageBytesBefore:number;storageBytesAfter:number;
}
export type StateCompressionResult = ObservationCompressionResult;
export interface SqliteCompactionResult {databaseBytesBefore:number;databaseBytesAfter:number;walBytesBefore:number;walBytesAfter:number}

// Only unambiguous plain JSON is indexed. NULL is a fallback bucket read by
// every scoped query, so invalid JSON and future compressed encodings still go
// through the normal decoder. Duplicate/escaped keys can differ between SQLite
// JSON extraction and JSON.parse; conservatively decode those rows as well.
const actionObservationProjection=`CASE WHEN compressed_json IS NULL AND json_valid(json) THEN
  CASE WHEN json_type(json,'$.observationId')='text'
    AND json_type(json_remove(json,'$.observationId'),'$.observationId') IS NULL
    AND instr(json,'\\u')=0 AND json_type(json,'$.$interactionStorage') IS NULL
  THEN json_extract(json,'$.observationId') END END`;

export class SqliteStore implements Persistence {
  readonly evidence: EvidenceStore;
  get recordReadIsolation(): Persistence['recordReadIsolation'] { return 'detached'; }
  readonly db: Database.Database;
  private readonly observations: ObservationObjectStore;
  private readonly changes = new BoundedEntityChanges();
  private readonly changeStamp: Database.Statement;
  private readonly recordStamp: Database.Statement;
  private readonly tempSchemaStamp: Database.Statement;
  private readonly recordInstance = id();
  private recordEpoch = 0n;
  private static readonly revisionReads = {
    get: SqliteStore.prototype.get, require: SqliteStore.prototype.require,
    list: SqliteStore.prototype.list, listByObservation: SqliteStore.prototype.listByObservation,
    events: SqliteStore.prototype.events, request: SqliteStore.prototype.request,
  };
  private expectedChanges = 0;
  private dataVersion = 0;
  private schemaVersion = 0;
  private queriedInTransaction = false;
  private observationBatchDepth = 0;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    this.evidence = new FileEvidenceStore(join(directory, 'evidence'));
    this.db = new Database(join(directory, 'engine.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    try { this.db.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT OR IGNORE INTO metadata VALUES('schemaVersion','1');`);
      const version=(this.db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get() as {value:string}).value;
      if(version!=='1'&&version!=='2'&&version!=='3'&&version!=='4')throw new EngineError('SCHEMA_VERSION',`Unsupported database schema ${version}`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT PRIMARY KEY,session_id TEXT NOT NULL,json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS entities_session_kind ON entities(session_id,kind);
        CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,type TEXT NOT NULL,at TEXT NOT NULL,json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id,sequence);
        CREATE TABLE IF NOT EXISTS requests(session_id TEXT NOT NULL,request_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_id,request_id));`);
      const compressed=(this.db.pragma('table_info(entities)') as {name:string}[]).some(c=>c.name==='compressed_json');
      if(!compressed){if(version!=='1')throw new EngineError('SCHEMA_VERSION','Compressed entity column is missing');this.db.exec('ALTER TABLE entities ADD COLUMN compressed_json BLOB');}
      // One initial scan of action JSON on existing databases; no payload rewrite.
      // SQLite maintains the projection for normal/raw writes and rollbacks.
      this.db.exec(`CREATE INDEX IF NOT EXISTS entities_action_observation ON entities(session_id,${actionObservationProjection}) WHERE kind='action'`);
      if(version==='3'||version==='4') {
        const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observation_objects','observation_packs')").all();
        if(tables.length!==2)throw new EngineError('SCHEMA_VERSION','Observation structure tables are missing');
      }else this.db.exec(observationSchema);
      this.db.prepare("UPDATE metadata SET value='4' WHERE key='schemaVersion'").run();
    })(); }catch(error){this.db.close();throw error;}
    this.observations = new ObservationObjectStore(this.db, count => { this.expectedChanges += count; });
    this.changeStamp = this.db.prepare('SELECT total_changes() AS total, (SELECT data_version FROM pragma_data_version) AS dataVersion, (SELECT schema_version FROM pragma_schema_version) AS schemaVersion');
    // Actual counts include every kind, raw SQL and maintenance; the navigation
    // feed's expectedChanges deliberately absorbs normal writes and cannot be
    // used here. Keep 64-bit integers exact. TEMP DDL can shadow unqualified
    // record tables, so its schema version participates as well.
    this.recordStamp = this.db.prepare('SELECT total_changes() AS total, (SELECT data_version FROM pragma_data_version) AS dataVersion, (SELECT schema_version FROM pragma_schema_version) AS schemaVersion').safeIntegers();
    this.tempSchemaStamp = this.db.prepare('PRAGMA temp.schema_version').safeIntegers();
    const stamp = this.databaseChangeStamp();
    this.expectedChanges = stamp.total; this.dataVersion = stamp.dataVersion; this.schemaVersion = stamp.schemaVersion;
  }
  private databaseChangeStamp() { return this.changeStamp.get() as { total: number; dataVersion: number; schemaVersion: number }; }
  /** Normal SQLite DML/DDL only. Replacing SQL functions/extensions, manually
   * spoofing schema_version, or modifying open database files bypasses this
   * storage contract; callers doing so must withdraw recordRevision support. */
  recordRevision(): string | undefined {
    if (!this.db.open) return;
    if (this.db.inTransaction) { this.recordEpoch++; return; }
    const reads = SqliteStore.revisionReads;
    if (this.get !== reads.get || this.require !== reads.require || this.list !== reads.list
      || this.listByObservation !== reads.listByObservation || this.events !== reads.events || this.request !== reads.request) return;
    const stamp = this.recordStamp.get() as { total: bigint; dataVersion: bigint; schemaVersion: bigint };
    const temp = this.tempSchemaStamp.get() as { schema_version: bigint };
    return `${this.recordInstance}:${this.recordEpoch}:${stamp.total}:${stamp.dataVersion}:${stamp.schemaVersion}:${temp.schema_version}`;
  }
  readObservationBatch<T>(sessionId: string, read: (get: <O extends Observation>(id: string) => O | undefined) => T): { value: T } | undefined {
    const reads = SqliteStore.revisionReads;
    const supported = () => this.db.open && this.get === reads.get && this.require === reads.require && this.list === reads.list
      && this.listByObservation === reads.listByObservation && this.events === reads.events && this.request === reads.request;
    if (!supported()) return;
    const outerBatch = this.observationBatchDepth === 0, cacheable = !this.db.inTransaction;
    const queryOnly = this.db.pragma('query_only', { simple: true }) as number;
    let begun = false;
    try {
      return this.db.transaction(() => {
        // Pin the main database snapshot before calling user code, even if its
        // first getter comes after another connection commits. No payload scan.
        this.db.prepare('SELECT 1 FROM entities LIMIT 1').get();
        const before = this.recordStamp.get() as { total: bigint; schemaVersion: bigint };
        const tempBefore = this.tempSchemaStamp.get() as { schema_version: bigint };
        const savepoint = `observation_batch_${id().replaceAll('-', '')}`;
        this.db.exec(`SAVEPOINT ${savepoint}`);
        this.db.pragma('query_only = ON');
        if (outerBatch) { this.observations.begin(cacheable); begun = true; }
        this.observationBatchDepth++;
        let active = true;
        try {
          const get = <O extends Observation>(observationId: string): O | undefined => {
            if (!active) throw new EngineError('OBSERVATION_BATCH_EXPIRED', 'Observation batch getter has expired');
            if (!supported() || !this.db.inTransaction) throw new EngineError('OBSERVATION_BATCH_INVALIDATED', 'Observation batch read composition or transaction changed');
            const row = this.db.prepare("SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind='observation' AND session_id=? AND id=?")
              .get(sessionId, observationId) as StoredEntityRow | undefined;
            if (!row) return;
            const observation = decodeStoredEntity<O>(row, this.observations.resolve);
            if (observation.id !== observationId || observation.sessionId !== sessionId)
              throw new EngineError('CORRUPT_ENTITY', 'Observation content does not match its stored ownership');
            return observation;
          };
          const value = read(get);
          if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function')
            throw new EngineError('ASYNC_OBSERVATION_BATCH', 'Observation batch callback must be synchronous');
          if (!supported() || !this.db.inTransaction) throw new EngineError('OBSERVATION_BATCH_INVALIDATED', 'Observation batch read composition or transaction changed');
          const after = this.recordStamp.get() as { total: bigint; schemaVersion: bigint };
          const tempAfter = this.tempSchemaStamp.get() as { schema_version: bigint };
          if (before.total !== after.total || before.schemaVersion !== after.schemaVersion || tempBefore.schema_version !== tempAfter.schema_version
            || this.db.pragma('query_only', { simple: true }) !== 1)
            throw new EngineError('OBSERVATION_BATCH_WRITE', 'Observation batch callback must not write or change the connection');
          // COMMIT/ROLLBACK followed by BEGIN can leave inTransaction true, but
          // cannot preserve this batch's private savepoint and snapshot.
          this.db.exec(`RELEASE ${savepoint}`);
          return { value };
        } finally { active = false; this.observationBatchDepth--; }
      })();
    } catch (error) {
      this.changes.invalidate(); this.observations.invalidate(); this.recordEpoch++;
      throw error;
    } finally {
      if (begun) this.observations.end(cacheable);
      if (this.db.open) this.db.pragma(`query_only = ${queryOnly ? 'ON' : 'OFF'}`);
    }
  }
  transaction<T>(fn: () => T): T {
    try { return this.db.transaction(fn)(); }
    catch (error) { this.changes.invalidate(); this.observations.invalidate(); this.recordEpoch++; throw error; }
  }
  entityChanges(kind: string, sessionId: string, sinceToken?: string) {
    const stamp = this.databaseChangeStamp();
    // Known writes increment the expected count, never replace it. Untracked
    // writes (including triggers, raw deletes and other connections) cannot be
    // hidden by a subsequent normal put. No extra query is needed per write.
    if (stamp.total !== this.expectedChanges || stamp.dataVersion !== this.dataVersion || stamp.schemaVersion !== this.schemaVersion
      || this.queriedInTransaction || this.db.inTransaction) this.changes.invalidate();
    this.expectedChanges = stamp.total; this.dataVersion = stamp.dataVersion; this.schemaVersion = stamp.schemaVersion;
    // A caller using a raw SQLite transaction can roll back without our wrapper.
    // Facts read inside it must not remain cached after either commit or rollback.
    this.queriedInTransaction = this.db.inTransaction;
    const result = this.changes.changes(kind, sessionId, sinceToken);
    return this.db.inTransaction ? { ...result, cacheable: false as const } : result;
  }
  put<T extends { id: string; sessionId?: string }>(kind: string, value: T) {
    // Serialize the ownership check, immutable-observation check and all object /
    // pack writes across connections. Nested calls use the caller's transaction.
    const beforeChanges=this.expectedChanges,cacheable=!this.db.inTransaction;
    try { const persist=() => {
      if(kind==='observation')this.observations.begin(cacheable);
      const sessionId = value.sessionId ?? value.id;
      const owner = this.db.prepare('SELECT kind,session_id FROM entities WHERE id=?').get(value.id) as { kind: string; session_id: string } | undefined;
      if (owner && (owner.kind !== kind || owner.session_id !== sessionId)) throw new EngineError('ID_CONFLICT', 'ID already belongs to another entity kind or session');
      const prior = kind === 'observation' && owner ? this.get(kind, value.id) : undefined;
      if(kind==='observation'&&prior){if(canonical(prior)!==canonical(value))throw new EngineError('IMMUTABLE_OBSERVATION','Observations cannot be overwritten');return;}
      const json=JSON.stringify(value),row=kind==='observation'?this.observations.encode(json,sessionId):kind==='state'?encodeStateJson(json,value.id,sessionId):{json,compressed_json:null};
      const written = this.db.prepare('INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,compressed_json=excluded.compressed_json WHERE entities.kind=excluded.kind AND entities.session_id=excluded.session_id').run(kind,value.id,sessionId,row.json,row.compressed_json);
      this.expectedChanges += written.changes;this.observations.knownWrite(written.changes);
      if (!written.changes) throw new EngineError('ID_CONFLICT', 'ID already belongs to another entity kind or session');
      this.changes.record(kind, sessionId, value.id);
    };if(kind==='observation')this.db.transaction(persist).immediate();else persist();
    } catch(error) { this.observations.invalidate();if(this.expectedChanges!==beforeChanges)this.changes.invalidate(); throw error; } finally {if(kind==='observation')this.observations.end(cacheable);}
  }
  /** Raw SQL consumers can use this bound decoder for both old and shared rows.
   * Read the row and call this within store.transaction for one stable snapshot. */
  decodeStoredEntity<T=unknown>(row:StoredEntityRow):T {
    if (this.observationBatchDepth) return decodeStoredEntity<T>(row, this.observations.resolve);
    const cacheable=!this.db.inTransaction;
    try{return this.db.transaction(()=>{this.observations.begin(cacheable);return decodeStoredEntity<T>(row,this.observations.resolve);})();}
    finally{this.observations.end(cacheable);}
  }
  get<T>(kind: string, id: string): T | undefined {
    if(kind!=='observation') {
      const columns=kind==='state'?'kind,id,session_id,json,compressed_json':'kind,json,compressed_json';
      const row=this.db.prepare(`SELECT ${columns} FROM entities WHERE kind=? AND id=?`).get(kind,id) as StoredEntityRow|undefined;
      return row?decodeStoredEntity<T>(row):undefined;
    }
    if (this.observationBatchDepth) {
      const row = this.db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? AND id=?').get(kind, id) as StoredEntityRow | undefined;
      return row ? decodeStoredEntity<T>(row, this.observations.resolve) : undefined;
    }
    const cacheable=!this.db.inTransaction;
    try{return this.db.transaction(()=>{
      this.observations.begin(cacheable);
      const row=this.db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? AND id=?').get(kind,id) as StoredEntityRow|undefined;
      return row?decodeStoredEntity<T>(row,this.observations.resolve):undefined;
    })();}finally{this.observations.end(cacheable);}
  }
  require<T>(kind: string, id: string): T { const value = this.get<T>(kind, id); if (!value) throw new EngineError('NOT_FOUND', `${kind} ${id} not found`); return value; }
  list<T>(kind: string, sessionId?: string): T[] {
    if(kind!=='observation') {
      const columns=kind==='state'?'kind,id,session_id,json,compressed_json':'kind,json,compressed_json';
      const rows=(sessionId?this.db.prepare(`SELECT ${columns} FROM entities WHERE kind=? AND session_id=? ORDER BY rowid`).all(kind,sessionId):this.db.prepare(`SELECT ${columns} FROM entities WHERE kind=? ORDER BY rowid`).all(kind)) as StoredEntityRow[];
      return rows.map(row=>decodeStoredEntity<T>(row));
    }
    if (this.observationBatchDepth) {
      const rows = (sessionId ? this.db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? AND session_id=? ORDER BY rowid').all(kind, sessionId)
        : this.db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? ORDER BY rowid').all(kind)) as StoredEntityRow[];
      return rows.map(row => decodeStoredEntity<T>(row, this.observations.resolve));
    }
    const cacheable=!this.db.inTransaction;
    try{return this.db.transaction(()=>{
      this.observations.begin(cacheable);
      const rows = (sessionId ? this.db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? AND session_id=? ORDER BY rowid').all(kind, sessionId) : this.db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind=? ORDER BY rowid').all(kind)) as StoredEntityRow[];
      return rows.map(r=>decodeStoredEntity<T>(r,this.observations.resolve));
    })();}finally{this.observations.end(cacheable);}
  }
  listByObservation<T>(kind:string,sessionId:string,observationId:string):T[] {
    if(kind!=='action')return this.list<T&{observationId?:string}>(kind,sessionId).filter(value=>value.observationId===observationId);
    // A single statement keeps matching and fallback rows in one read snapshot.
    // Preserve list() row order, including after an action changes observation.
    const columns='rowid AS position,kind,json,compressed_json';
    const rows=this.db.prepare(`SELECT * FROM (
      SELECT ${columns} FROM entities INDEXED BY entities_action_observation WHERE kind='action' AND session_id=? AND (${actionObservationProjection})=?
      UNION ALL
      SELECT ${columns} FROM entities INDEXED BY entities_action_observation WHERE kind='action' AND session_id=? AND (${actionObservationProjection}) IS NULL
    ) ORDER BY position`).all(sessionId,observationId,sessionId) as StoredEntityRow[];
    return rows.map(row=>decodeStoredEntity<T&{observationId?:string}>(row)).filter(value=>value.observationId===observationId);
  }
  observationCacheStats() {return this.observations.cacheStats();}
  observationStorageStats(options:{sessionId?:string}={}):ObservationStorageStats {
    return this.db.transaction(()=>this.observations.stats(options.sessionId))();
  }
  /** Explicit mark/sweep over actual immutable observation manifests. Optional
   * repacking reclaims dead ranges in mixed packs, atomically retaining every
   * live object's ID/content. Does not delete observations or select retention. */
  garbageCollectObservations(options:{sessionId?:string;repack?:boolean}={}):ObservationGarbageCollectionResult {
    try {return this.db.transaction(()=>{this.observations.begin(false);return this.observations.collect(options);}).immediate();}
    catch(error){this.changes.invalidate();throw error;}finally{this.observations.invalidate();}
  }
  /** Explicit, bounded migration of old observations. Pass the returned cursor
   * to the next batch; each batch is atomic and verifies every compressed value.
   * No session, task, authorization or execution state is changed.
   */
  compressObservations(options:{sessionId?:string;cursor?:number;limit?:number}={}):ObservationCompressionResult {
    const cursor=options.cursor??0,limit=options.limit??50;
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new EngineError('INVALID_MIGRATION_OPTIONS','Use a nonnegative cursor and a limit from 1 to 1000');
    return this.transaction(()=>{
      const clause=options.sessionId===undefined?'':' AND session_id=?',params=options.sessionId===undefined?[]:[options.sessionId];
      const rows=this.db.prepare(`SELECT rowid AS cursor,id FROM entities WHERE kind='observation' AND compressed_json IS NULL AND rowid>?${clause} ORDER BY rowid LIMIT ?`).all(cursor,...params,limit) as {cursor:number;id:string}[];
      const result:ObservationCompressionResult={cursor,done:false,scanned:0,compressed:0,logicalBytesBefore:0,logicalBytesAfter:0,storageBytesBefore:0,storageBytesAfter:0};
      for(const item of rows) {
        const row=this.db.prepare("SELECT json,compressed_json FROM entities WHERE kind='observation' AND id=?").get(item.id) as StoredEntityRow;
        decodeStoredEntity(row); // Fail explicitly on malformed legacy JSON/manifest.
        const bytes=Buffer.byteLength(row.json),encoded=encodeObservationJson(row.json);
        decodeStoredEntity(encoded); // Verifies original byte length and SHA-256.
        result.scanned++;result.cursor=item.cursor;result.logicalBytesBefore+=bytes;result.logicalBytesAfter+=bytes;result.storageBytesBefore+=bytes;
        result.storageBytesAfter+=Buffer.byteLength(encoded.json)+(encoded.compressed_json?.byteLength||0);
        if(encoded.compressed_json){this.db.prepare("UPDATE entities SET json=?,compressed_json=? WHERE kind='observation' AND id=?").run(encoded.json,encoded.compressed_json,item.id);result.compressed++;}
      }
      result.done=!this.db.prepare(`SELECT 1 FROM entities WHERE kind='observation' AND compressed_json IS NULL AND rowid>?${clause} LIMIT 1`).get(result.cursor,...params);
      return result;
    });
  }
  /** Explicit, resumable compression of legacy plain states. Every batch is
   * atomic and verifies round trips; state identity and graph facts do not change.
   * Startup only upgrades schema metadata and never rewrites state payloads.
   */
  compressStates(options:{sessionId?:string;cursor?:number;limit?:number}={}):StateCompressionResult {
    const cursor=options.cursor??0,limit=options.limit??50;
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new EngineError('INVALID_MIGRATION_OPTIONS','Use a nonnegative cursor and a limit from 1 to 1000');
    return this.transaction(()=>{
      const clause=options.sessionId===undefined?'':' AND session_id=?',params=options.sessionId===undefined?[]:[options.sessionId];
      const rows=this.db.prepare(`SELECT rowid AS cursor,id FROM entities WHERE kind='state' AND compressed_json IS NULL AND rowid>?${clause} ORDER BY rowid LIMIT ?`).all(cursor,...params,limit) as {cursor:number;id:string}[];
      const result:StateCompressionResult={cursor,done:false,scanned:0,compressed:0,logicalBytesBefore:0,logicalBytesAfter:0,storageBytesBefore:0,storageBytesAfter:0};
      for(const item of rows) {
        const row=this.db.prepare("SELECT kind,id,session_id,json,compressed_json FROM entities WHERE kind='state' AND id=?").get(item.id) as StoredEntityRow&{id:string;session_id:string};
        const original=decodeStoredEntity(row),encoded=encodeStateJson(row.json,row.id,row.session_id);
        if(JSON.stringify(decodeStoredEntity({...row,...encoded}))!==JSON.stringify(original))throw new EngineError('CORRUPT_ENTITY','Stored entity content or compression manifest is corrupt');
        const bytes=Buffer.byteLength(row.json);result.scanned++;result.cursor=item.cursor;result.logicalBytesBefore+=bytes;result.logicalBytesAfter+=bytes;result.storageBytesBefore+=bytes;
        result.storageBytesAfter+=Buffer.byteLength(encoded.json)+(encoded.compressed_json?.byteLength??0);
        if(encoded.compressed_json){const written=this.db.prepare("UPDATE entities SET json=?,compressed_json=? WHERE kind='state' AND id=?").run(encoded.json,encoded.compressed_json,row.id);this.expectedChanges+=written.changes;this.observations.knownWrite(written.changes);result.compressed++;}
      }
      result.done=!this.db.prepare(`SELECT 1 FROM entities WHERE kind='state' AND compressed_json IS NULL AND rowid>?${clause} LIMIT 1`).get(result.cursor,...params);
      return result;
    });
  }
  /** Explicit maintenance for an idle database, after migration and backup.
   * Compression frees SQLite pages; VACUUM is what returns them to the filesystem.
   * Never runs automatically during startup, puts or exploration.
   */
  compact():SqliteCompactionResult {
    if(this.db.inTransaction)throw new EngineError('COMPACTION_IN_TRANSACTION','Compaction cannot run within a transaction');
    const size=(suffix:string)=>{try{return statSync(join(this.directory,`engine.sqlite${suffix}`)).size;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}};
    const result:SqliteCompactionResult={databaseBytesBefore:size(''),databaseBytesAfter:0,walBytesBefore:size('-wal'),walBytesAfter:0};
    const checkpoint=()=>{const state=this.db.pragma('wal_checkpoint(TRUNCATE)') as {busy:number}[];if(state.some(s=>s.busy))throw new EngineError('STORAGE_BUSY','Close active database readers before compaction');};
    checkpoint();this.db.exec('VACUUM');checkpoint();result.databaseBytesAfter=size('');result.walBytesAfter=size('-wal');return result;
  }
  event(sessionId: string, type: string, data: unknown): EngineEvent {
    const at = now();
    const result = this.db.prepare('INSERT INTO events(session_id,type,at,json) VALUES(?,?,?,?)').run(sessionId, type, at, JSON.stringify(data));
    this.expectedChanges += result.changes;this.observations.knownWrite(result.changes);
    return { sequence: Number(result.lastInsertRowid), sessionId, type, at, data };
  }
  events(sessionId: string, after = 0, limit = 1000): EngineEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(sessionId, after, limit) as any[]).map(r => ({ sequence: r.sequence, sessionId: r.session_id, type: r.type, at: r.at, data: JSON.parse(r.json) }));
  }
  request(sessionId: string, requestId: string) { return this.db.prepare('SELECT attempt_id AS attemptId,payload FROM requests WHERE session_id=? AND request_id=?').get(sessionId, requestId) as { attemptId: string; payload: string } | undefined; }
  recordRequest(sessionId: string, requestId: string, attemptId: string, payload: string) { const result = this.db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(sessionId, requestId, attemptId, payload); this.expectedChanges += result.changes;this.observations.knownWrite(result.changes); }
  close() { this.db.close(); }
}
