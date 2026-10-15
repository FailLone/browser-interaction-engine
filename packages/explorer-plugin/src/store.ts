import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision, ExplorerEvent, Task } from './types.js';
import { ExplorerError } from './types.js';

export class ExplorerStore {
  private db: Database.Database;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename); this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS explorer_meta(version INTEGER NOT NULL);
      INSERT INTO explorer_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM explorer_meta);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS decision_task ON decisions(task_id);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_task ON events(task_id,sequence);`);
    if ((this.db.prepare('SELECT version FROM explorer_meta').get() as {version:number}).version !== 1) throw new ExplorerError('STORE_VERSION');
    for (const task of this.tasks()) if (task.status === 'running') {
      if (task.activeSince) task.usage.durationMs += Math.max(0, Date.now() - task.activeSince);
      delete task.activeSince; task.status = 'paused'; task.reason = 'process_restarted'; task.revision++;
      const round = task.rounds.at(-1); if (round?.status === 'running') round.status = 'paused';
      this.save(task);
      for (const d of this.decisions(task.id)) if (d.status === 'requested' || d.status === 'returned') { d.status = 'stale'; d.reason = 'process_restarted'; this.decision(d); }
    }
  }
  save(task: Task) { task.updatedAt = new Date().toISOString(); this.db.prepare('INSERT INTO tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(task.id, JSON.stringify(task)); }
  tasks(): Task[] { return (this.db.prepare('SELECT json FROM tasks ORDER BY rowid').all() as {json:string}[]).map(r => JSON.parse(r.json)); }
  task(id: string): Task { const r = this.db.prepare('SELECT json FROM tasks WHERE id=?').get(id) as {json:string} | undefined; if (!r) throw new ExplorerError('NOT_FOUND'); return JSON.parse(r.json); }
  decision(value: Decision) { this.db.prepare('INSERT INTO decisions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id, value.taskId, JSON.stringify(value)); }
  /** Updates keep their rowid, so a review pass can read only decisions it inserted. */
  decisionCursor(id: string): number { return (this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS cursor FROM decisions WHERE task_id=?').get(id) as {cursor:number}).cursor; }
  decisions(id: string, after = 0): Decision[] { return (this.db.prepare('SELECT json FROM decisions WHERE task_id=? AND rowid>? ORDER BY rowid').all(id, after) as {json:string}[]).map(r => JSON.parse(r.json)); }
  event(event: Omit<ExplorerEvent, 'sequence' | 'at'>) {
    const at = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(task_id,json) VALUES(?,?)').run(event.taskId, JSON.stringify({...event, at}));
    return {...event, at, sequence: Number(result.lastInsertRowid)};
  }
  events(id: string, after = 0, limit = 500): ExplorerEvent[] {
    return (this.db.prepare('SELECT sequence,json FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, after, Math.min(1000,limit)) as {sequence:number;json:string}[]).map(r => ({...JSON.parse(r.json), sequence:r.sequence}));
  }
  close() { this.db.close(); }
}
