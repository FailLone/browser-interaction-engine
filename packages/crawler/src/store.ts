import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CrawlEvent } from './crawler.js';

export interface CrawlRun {
  id: string; url: string; status: 'running' | 'finished' | 'failed' | 'interrupted';
  options: Record<string, unknown>; summary?: Record<string, unknown>; error?: string;
  createdAt: string; updatedAt: string;
}

/**
 * What a resumed run needs to skip already-tested work: per action class execution counts,
 * failed classes, and settled judgements (weak controls, list splits, input kinds, flat mode
 * groups). Abstract states are kept so a resumed run does not report them as new.
 */
export interface CrawlLedger {
  classCounts: [string, number][]; failedClasses: string[];
  confirmed: string[]; asked: string[]; splitLists: string[]; askedLists: string[];
  inputKinds: [string, { kind: string; source: string }][]; flatModeGroups: string[]; resolvedFills: string[];
  states: string[];
}

/** Crawl runs, their event log, state screenshots and resumable ledger in one SQLite file. */
export class CrawlStore {
  private readonly db: Database.Database;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crawl_runs(id TEXT PRIMARY KEY, url TEXT NOT NULL, status TEXT NOT NULL, options TEXT NOT NULL,
        summary TEXT, error TEXT, ledger TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS crawl_events(run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(run_id, seq));
      CREATE TABLE IF NOT EXISTS crawl_screenshots(run_id TEXT NOT NULL, state TEXT NOT NULL, png BLOB NOT NULL, PRIMARY KEY(run_id, state));`);
  }

  createRun(id: string, url: string, options: Record<string, unknown>): CrawlRun {
    const at = new Date().toISOString();
    this.db.prepare('INSERT INTO crawl_runs(id,url,status,options,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, url, 'running', JSON.stringify(options), at, at);
    return this.run(id)!;
  }

  run(id: string): CrawlRun | undefined {
    const row = this.db.prepare('SELECT * FROM crawl_runs WHERE id=?').get(id) as Record<string, string> | undefined;
    return row && this.decode(row);
  }

  runs(): CrawlRun[] {
    return (this.db.prepare('SELECT * FROM crawl_runs ORDER BY created_at DESC').all() as Record<string, string>[]).map(row => this.decode(row));
  }

  private decode(row: Record<string, string>): CrawlRun {
    return { id: row.id, url: row.url, status: row.status as CrawlRun['status'], options: JSON.parse(row.options),
      ...(row.summary ? { summary: JSON.parse(row.summary) } : {}), ...(row.error ? { error: row.error } : {}), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  finish(id: string, status: CrawlRun['status'], summary?: unknown, error?: string) {
    this.db.prepare('UPDATE crawl_runs SET status=?, summary=?, error=?, updated_at=? WHERE id=?')
      .run(status, summary === undefined ? null : JSON.stringify(summary), error ?? null, new Date().toISOString(), id);
  }

  /** Runs left 'running' by a process that exited without finishing. */
  markInterrupted() {
    this.db.prepare("UPDATE crawl_runs SET status='interrupted', updated_at=? WHERE status='running'").run(new Date().toISOString());
  }

  appendEvent(id: string, event: CrawlEvent) {
    const next = (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM crawl_events WHERE run_id=?').get(id) as { n: number }).n;
    this.db.prepare('INSERT INTO crawl_events(run_id,seq,type,at,data) VALUES(?,?,?,?,?)').run(id, next, event.type, event.at, JSON.stringify(event));
  }

  events(id: string, after = 0, limit = 1000): (CrawlEvent & { seq: number })[] {
    return (this.db.prepare('SELECT seq,data FROM crawl_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit) as { seq: number; data: string }[])
      .map(row => ({ ...JSON.parse(row.data), seq: row.seq }));
  }

  saveScreenshot(id: string, state: string, png: Buffer) {
    this.db.prepare('INSERT OR REPLACE INTO crawl_screenshots(run_id,state,png) VALUES(?,?,?)').run(id, state, png);
  }

  screenshot(id: string, state: string): Buffer | undefined {
    return (this.db.prepare('SELECT png FROM crawl_screenshots WHERE run_id=? AND state=?').get(id, state) as { png: Buffer } | undefined)?.png;
  }

  saveLedger(id: string, ledger: CrawlLedger) {
    this.db.prepare('UPDATE crawl_runs SET ledger=?, updated_at=? WHERE id=?').run(JSON.stringify(ledger), new Date().toISOString(), id);
  }

  ledger(id: string): CrawlLedger | undefined {
    const row = this.db.prepare('SELECT ledger FROM crawl_runs WHERE id=?').get(id) as { ledger: string | null } | undefined;
    return row?.ledger ? JSON.parse(row.ledger) : undefined;
  }

  close() { this.db.close(); }
}
