import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, now, type Persistence, type EvidenceStore } from '@interaction/core';
import { FileEvidenceStore } from './evidence.js';
import { EngineError, type EngineEvent, type Session, type ActionAttempt, type FrontierItem, type InteractionScope } from '@interaction/core';

export class SqliteStore implements Persistence {
  readonly evidence: EvidenceStore;
  readonly db: Database.Database;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    this.evidence = new FileEvidenceStore(join(directory, 'evidence'));
    this.db = new Database(join(directory, 'engine.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES('schemaVersion','1');
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT PRIMARY KEY,session_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entities_session_kind ON entities(session_id,kind);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,type TEXT NOT NULL,at TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id,sequence);
      CREATE TABLE IF NOT EXISTS requests(session_id TEXT NOT NULL,request_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_id,request_id));`);
    const version = (this.db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get() as { value: string }).value;
    if (version !== '1') throw new EngineError('SCHEMA_VERSION', `Unsupported database schema ${version}`);
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  put<T extends { id: string; sessionId?: string }>(kind: string, value: T) {
    const prior = this.get(kind, value.id);
    if (kind === 'observation' && prior && canonical(prior) !== canonical(value)) throw new EngineError('IMMUTABLE_OBSERVATION', 'Observations cannot be overwritten');
    this.db.prepare('INSERT INTO entities(kind,id,session_id,json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(kind, value.id, value.sessionId ?? value.id, JSON.stringify(value));
  }
  get<T>(kind: string, id: string): T | undefined { const row = this.db.prepare('SELECT json FROM entities WHERE kind=? AND id=?').get(kind, id) as { json: string } | undefined; return row ? JSON.parse(row.json) : undefined; }
  require<T>(kind: string, id: string): T { const value = this.get<T>(kind, id); if (!value) throw new EngineError('NOT_FOUND', `${kind} ${id} not found`); return value; }
  list<T>(kind: string, sessionId?: string): T[] {
    const rows = (sessionId ? this.db.prepare('SELECT json FROM entities WHERE kind=? AND session_id=? ORDER BY rowid').all(kind, sessionId) : this.db.prepare('SELECT json FROM entities WHERE kind=? ORDER BY rowid').all(kind)) as { json: string }[];
    return rows.map(r => JSON.parse(r.json));
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
