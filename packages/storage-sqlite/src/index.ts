import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, now, type Persistence, type EvidenceStore } from '@interaction/core';
import { FileEvidenceStore } from './evidence.js';
import { decodeStoredEntity, encodeObservationJson, type StoredEntityRow } from './entity-codec.js';
export { decodeStoredEntity, type StoredEntityRow, type ObservationManifest } from './entity-codec.js';
import { EngineError, type EngineEvent, type Session, type ActionAttempt, type FrontierItem, type InteractionScope } from '@interaction/core';

export interface ObservationCompressionResult {
  cursor:number;done:boolean;scanned:number;compressed:number;
  logicalBytesBefore:number;logicalBytesAfter:number;storageBytesBefore:number;storageBytesAfter:number;
}
export interface SqliteCompactionResult {databaseBytesBefore:number;databaseBytesAfter:number;walBytesBefore:number;walBytesAfter:number}

export class SqliteStore implements Persistence {
  readonly evidence: EvidenceStore;
  readonly db: Database.Database;
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
      if(version!=='1'&&version!=='2')throw new EngineError('SCHEMA_VERSION',`Unsupported database schema ${version}`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT PRIMARY KEY,session_id TEXT NOT NULL,json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS entities_session_kind ON entities(session_id,kind);
        CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,type TEXT NOT NULL,at TEXT NOT NULL,json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id,sequence);
        CREATE TABLE IF NOT EXISTS requests(session_id TEXT NOT NULL,request_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_id,request_id));`);
      const compressed=(this.db.pragma('table_info(entities)') as {name:string}[]).some(c=>c.name==='compressed_json');
      if(!compressed){if(version==='2')throw new EngineError('SCHEMA_VERSION','Compressed entity column is missing');this.db.exec('ALTER TABLE entities ADD COLUMN compressed_json BLOB');}
      this.db.prepare("UPDATE metadata SET value='2' WHERE key='schemaVersion'").run();
    })(); }catch(error){this.db.close();throw error;}
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  put<T extends { id: string; sessionId?: string }>(kind: string, value: T) {
    const prior = this.get(kind, value.id);
    if(kind==='observation'&&prior){if(canonical(prior)!==canonical(value))throw new EngineError('IMMUTABLE_OBSERVATION','Observations cannot be overwritten');return;}
    const json=JSON.stringify(value),row=kind==='observation'?encodeObservationJson(json):{json,compressed_json:null};
    this.db.prepare('INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,compressed_json=excluded.compressed_json').run(kind,value.id,value.sessionId??value.id,row.json,row.compressed_json);
  }
  get<T>(kind: string, id: string): T | undefined { const row=this.db.prepare('SELECT kind,json,compressed_json FROM entities WHERE kind=? AND id=?').get(kind,id) as StoredEntityRow|undefined;return row?decodeStoredEntity<T>(row):undefined; }
  require<T>(kind: string, id: string): T { const value = this.get<T>(kind, id); if (!value) throw new EngineError('NOT_FOUND', `${kind} ${id} not found`); return value; }
  list<T>(kind: string, sessionId?: string): T[] {
    const rows = (sessionId ? this.db.prepare('SELECT kind,json,compressed_json FROM entities WHERE kind=? AND session_id=? ORDER BY rowid').all(kind, sessionId) : this.db.prepare('SELECT kind,json,compressed_json FROM entities WHERE kind=? ORDER BY rowid').all(kind)) as StoredEntityRow[];
    return rows.map(r=>decodeStoredEntity<T>(r));
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
    return { sequence: Number(result.lastInsertRowid), sessionId, type, at, data };
  }
  events(sessionId: string, after = 0, limit = 1000): EngineEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(sessionId, after, limit) as any[]).map(r => ({ sequence: r.sequence, sessionId: r.session_id, type: r.type, at: r.at, data: JSON.parse(r.json) }));
  }
  request(sessionId: string, requestId: string) { return this.db.prepare('SELECT attempt_id AS attemptId,payload FROM requests WHERE session_id=? AND request_id=?').get(sessionId, requestId) as { attemptId: string; payload: string } | undefined; }
  recordRequest(sessionId: string, requestId: string, attemptId: string, payload: string) { this.db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(sessionId, requestId, attemptId, payload); }
  close() { this.db.close(); }
}
