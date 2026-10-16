import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Decision, ExplorerEvent, Task } from './types.js';
import { ExplorerError } from './types.js';

type TaskRow = { id:string; json:string; version:string; plan_count:number; round_count:number };
type ItemRow = { kind:'plan'|'rounds'; position:number; json:string; content_hash:string };
const digest = (json:string) => createHash('sha256').update(json).digest('hex');
const newVersion = () => randomBytes(32).toString('hex');

export class ExplorerStore {
  private db: Database.Database;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename); this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON');
    try { this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS explorer_meta(version INTEGER NOT NULL);
      INSERT INTO explorer_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM explorer_meta);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS decision_task ON decisions(task_id);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_task ON events(task_id,sequence);`);
      const version = (this.db.prepare('SELECT version FROM explorer_meta').get() as {version:number}).version;
      if (version !== 1 && version !== 2) throw new ExplorerError('STORE_VERSION');
      this.db.exec(`CREATE TABLE IF NOT EXISTS task_items(
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('plan','rounds')), position INTEGER NOT NULL,
        json TEXT NOT NULL, content_hash TEXT NOT NULL,
        PRIMARY KEY(task_id,kind,position));`);
      if (version === 1) {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN version TEXT NOT NULL DEFAULT '';
          ALTER TABLE tasks ADD COLUMN plan_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE tasks ADD COLUMN round_count INTEGER NOT NULL DEFAULT 0;`);
        // One atomic format migration; retain every ordered item and unknown
        // marker. No scheduling, coverage or browser state is inferred here.
        const insert = this.db.prepare('INSERT INTO task_items VALUES(?,?,?,?,?)');
        const update = this.db.prepare('UPDATE tasks SET json=?,version=?,plan_count=?,round_count=? WHERE id=?');
        for (const row of this.db.prepare('SELECT id,json FROM tasks').all() as {id:string;json:string}[]) {
          const {plan,rounds,...header} = JSON.parse(row.json) as Task;
          if (header.id !== row.id || !Array.isArray(plan) || !Array.isArray(rounds)) throw new ExplorerError('CORRUPT_TASK');
          for (const [kind,items] of [['plan',plan],['rounds',rounds]] as const) items.forEach((item,position) => {
            const json = JSON.stringify(item); insert.run(row.id,kind,position,json,digest(json));
          });
          update.run(JSON.stringify(header),newVersion(),plan.length,rounds.length,row.id);
        }
        this.db.prepare('UPDATE explorer_meta SET version=2').run();
      }
    }).immediate();
    // Restart work only needs running tasks, not every retained plan/history.
    for (const {id} of this.db.prepare("SELECT id FROM tasks WHERE json_extract(json,'$.status')='running'").all() as {id:string}[]) {
      this.db.transaction(() => {
      const task = this.task(id);
      if (task.activeSince) task.usage.durationMs += Math.max(0, Date.now() - task.activeSince);
      delete task.activeSince; task.status = 'paused'; task.reason = 'process_restarted'; task.revision++;
      const round = task.rounds.at(-1); if (round?.status === 'running') round.status = 'paused';
      this.save(task);
      for (const d of this.decisions(task.id)) if (d.status === 'requested' || d.status === 'returned') {
        d.status = 'stale'; d.reason = 'process_restarted'; this.decision(d);
        this.event({taskId:task.id,actor:d.actor,type:'decision.stale',sessionId:d.sessionId,observationId:d.observationId,decisionId:d.id,data:{reason:d.reason}});
      }
      }).immediate();
    }
    } catch (error) { this.db.close(); throw error; }
  }
  save(task: Task) {
    task.updatedAt = new Date().toISOString();
    const {plan,rounds,...header} = task;
    if (!Array.isArray(plan) || !Array.isArray(rounds)) throw new ExplorerError('CORRUPT_TASK');
    // The public API permits in-place mutation, so inspect every item. Only
    // changed rows are written; no object-identity cache can miss a nested edit.
    const groups = ([['plan',plan],['rounds',rounds]] as const).map(([kind,items]) => ({kind,items:items.map(item => {
      const json=JSON.stringify(item); return {json,hash:digest(json)};
    })}));
    const json=JSON.stringify(header);
    this.db.transaction(() => {
      const before=this.db.prepare('SELECT json,version,plan_count,round_count FROM tasks WHERE id=?').get(task.id) as TaskRow|undefined;
      const hashes=new Map((this.db.prepare('SELECT kind,position,content_hash FROM task_items WHERE task_id=?').all(task.id) as {kind:string;position:number;content_hash:string}[]).map(r=>[`${r.kind}:${r.position}`,r.content_hash]));
      const changed=!before || before.json!==json || before.plan_count!==plan.length || before.round_count!==rounds.length || groups.some(g=>g.items.some((item,position)=>hashes.get(`${g.kind}:${position}`)!==item.hash));
      if (!changed) return;
      this.db.prepare('INSERT INTO tasks(id,json,version,plan_count,round_count) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,version=excluded.version,plan_count=excluded.plan_count,round_count=excluded.round_count').run(task.id,json,newVersion(),plan.length,rounds.length);
      const write=this.db.prepare('INSERT INTO task_items VALUES(?,?,?,?,?) ON CONFLICT(task_id,kind,position) DO UPDATE SET json=excluded.json,content_hash=excluded.content_hash');
      for(const {kind,items} of groups) {
        items.forEach((item,position)=>{if(hashes.get(`${kind}:${position}`)!==item.hash)write.run(task.id,kind,position,item.json,item.hash);});
        this.db.prepare('DELETE FROM task_items WHERE task_id=? AND kind=? AND position>=?').run(task.id,kind,items.length);
      }
    }).immediate();
  }
  private assemble(row:TaskRow):Task {
    const header=JSON.parse(row.json) as Task;
    const items=this.db.prepare('SELECT kind,position,json,content_hash FROM task_items WHERE task_id=? ORDER BY kind,position').all(row.id) as ItemRow[];
    const plan:Task['plan']=[],rounds:Task['rounds']=[];
    for(const item of items) {
      const target=item.kind==='plan'?plan:rounds;
      if(item.position!==target.length || digest(item.json)!==item.content_hash)throw new ExplorerError('CORRUPT_TASK');
      target.push(JSON.parse(item.json));
    }
    if(header.id!==row.id || plan.length!==row.plan_count || rounds.length!==row.round_count)throw new ExplorerError('CORRUPT_TASK');
    return {...header,plan,rounds};
  }
  tasks(): Task[] { return this.db.transaction(() => (this.db.prepare('SELECT * FROM tasks ORDER BY rowid').all() as TaskRow[]).map(r=>this.assemble(r)))(); }
  taskSummaries(): {id:string;goal:string;url:string;status:Task['status'];rounds:{sessionId:string}[]}[] {
    return (this.db.prepare(`SELECT json_object('id',id,'goal',json_extract(json,'$.goal'),'url',json_extract(json,'$.url'),'status',json_extract(json,'$.status'),
      'rounds',json((SELECT json_group_array(json_object('sessionId',session_id)) FROM
        (SELECT json_extract(json,'$.sessionId') AS session_id FROM task_items WHERE task_id=tasks.id AND kind='rounds' ORDER BY position)))) AS summary FROM tasks ORDER BY rowid`).all() as {summary:string}[]).map(r=>JSON.parse(r.summary));
  }
  task(id: string): Task { return this.db.transaction(() => {const r=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow|undefined;if(!r)throw new ExplorerError('NOT_FOUND');return this.assemble(r);})(); }
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
  /** Event order, not decision insertion order, also captures changes to existing decisions.
   * A synchronous read transaction binds the task, event page and decision records together. */
  updates(id: string, after = 0, limit = 500, knownTaskVersion?:string) {
    return this.db.transaction(() => {
      const row=this.db.prepare('SELECT version FROM tasks WHERE id=?').get(id) as {version:string}|undefined;if(!row)throw new ExplorerError('NOT_FOUND');
      // Published atomically with header and item rows. Idle polling neither
      // loads the plan nor hashes/decodes the complete retained history.
      const taskVersion=row.version;
      const task:Task|undefined=knownTaskVersion===taskVersion?undefined:this.task(id);
      const events=this.events(id,after,limit),cursor=events.at(-1)?.sequence??after;
      const ids=[...new Set(events.flatMap(e=>e.decisionId?[e.decisionId]:[]))];
      const decisions:Decision[]=ids.length?(this.db.prepare(`SELECT json FROM decisions WHERE task_id=? AND id IN (${ids.map(()=>'?').join(',')}) ORDER BY rowid`).all(id,...ids) as {json:string}[]).map(r=>JSON.parse(r.json)):[];
      const hasMore=!!this.db.prepare('SELECT 1 FROM events WHERE task_id=? AND sequence>? LIMIT 1').get(id,cursor);
      return {task,taskVersion,decisions,events,cursor,hasMore};
    })();
  }
  close() { this.db.close(); }
}
