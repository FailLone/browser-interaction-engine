import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Decision, ExplorerEvent, Task } from './types.js';
import { ExplorerError } from './types.js';

type TaskRow = { id:string; json:string; version:string; plan_count:number; round_count:number };
type ItemKind = 'plan'|'rounds';
type ItemRow = { kind:ItemKind; position:number; json:string; content_hash:string; occurrence_id:string };
export type TaskHeader = Omit<Task,'plan'|'rounds'>;
export type TaskItemDelta<T> = {
  update?: {occurrenceId:string;value:T}[];
  append?: {occurrenceId:string;value:T}[];
  remove?: string[];
  /** Exact final order, including appended occurrences and excluding removed ones. */
  order?: string[];
};
export interface TaskDelta { header:TaskHeader; plan?:TaskItemDelta<Task['plan'][number]>; rounds?:TaskItemDelta<Task['rounds'][number]> }
export interface TaskItemQuery { expectedVersion?:string; statuses?:string[]; required?:boolean; occurrenceIds?:string[]; afterPosition?:number; limit?:number }
/** Persistence occurrence only. Never a business/control identity or coverage key. */
export const newTaskOccurrenceId = () => randomBytes(16).toString('hex');
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
      if (version !== 1 && version !== 2 && version !== 3) throw new ExplorerError('STORE_VERSION');
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
      if(version<3) {
        this.db.exec(`ALTER TABLE task_items ADD COLUMN occurrence_id TEXT NOT NULL DEFAULT '';
          UPDATE task_items SET occurrence_id=lower(hex(randomblob(16)));
          CREATE UNIQUE INDEX task_item_occurrence ON task_items(task_id,kind,occurrence_id);
          CREATE INDEX task_active_items ON task_items(task_id,position) WHERE kind='plan' AND json_extract(json,'$.status') IN ('pending','unresolved','blocked');
          CREATE INDEX task_round_session ON task_items(json_extract(json,'$.sessionId'),task_id) WHERE kind='rounds';
          UPDATE explorer_meta SET version=3;`);
        // Validate a v2 source before committing its one-way schema upgrade.
        for(const row of this.db.prepare('SELECT * FROM tasks').all() as TaskRow[])this.assemble(row);
      }
    }).immediate();
    // Restart work only needs running tasks, not every retained plan/history.
    for (const {id} of this.db.prepare("SELECT id FROM tasks WHERE json_extract(json,'$.status')='running'").all() as {id:string}[]) {
      this.db.transaction(() => {
      const state = this.taskHeader(id), task = state.header;
      if (task.activeSince) task.usage.durationMs += Math.max(0, Date.now() - task.activeSince);
      delete task.activeSince; task.status = 'paused'; task.reason = 'process_restarted'; task.revision++;
      const round = state.roundCount ? this.taskItems(id,'rounds',{expectedVersion:state.version,afterPosition:state.roundCount-2,limit:1}).items[0] : undefined;
      if(state.roundCount && !round)throw new ExplorerError('CORRUPT_TASK');
      if(round?.value.status === 'running')round.value.status='paused';
      this.applyTaskDelta(id,state.version,{header:task,...(round?{rounds:{update:[{occurrenceId:round.occurrenceId,value:round.value}]}}:{})});
      for (const d of this.decisions(task.id)) if (d.status === 'requested' || d.status === 'returned') {
        d.status = 'stale'; d.reason = 'process_restarted'; this.decision(d);
        this.event({taskId:task.id,actor:d.actor,type:'decision.stale',sessionId:d.sessionId,observationId:d.observationId,decisionId:d.id,data:{reason:d.reason}});
      }
      }).immediate();
    }
    } catch (error) { this.db.close(); throw error; }
  }
  save(task: Task, expectedVersion?:string):string {
    task.updatedAt = new Date().toISOString();
    const {plan,rounds,...header} = task;
    if (!Array.isArray(plan) || !Array.isArray(rounds)) throw new ExplorerError('CORRUPT_TASK');
    // The public API permits in-place mutation, so inspect every item. Only
    // changed rows are written; no object-identity cache can miss a nested edit.
    const groups = ([['plan',plan],['rounds',rounds]] as const).map(([kind,items]) => ({kind,items:items.map(item => {
      const json=JSON.stringify(item); return {json,hash:digest(json)};
    })}));
    const json=JSON.stringify(header);
    return this.db.transaction(() => {
      const before=this.db.prepare('SELECT json,version,plan_count,round_count FROM tasks WHERE id=?').get(task.id) as TaskRow|undefined;
      if(expectedVersion!==undefined && before?.version!==expectedVersion)throw new ExplorerError('STALE_TASK_VERSION');
      const hashes=new Map((this.db.prepare('SELECT kind,position,content_hash FROM task_items WHERE task_id=?').all(task.id) as {kind:string;position:number;content_hash:string}[]).map(r=>[`${r.kind}:${r.position}`,r.content_hash]));
      const changed=!before || before.json!==json || before.plan_count!==plan.length || before.round_count!==rounds.length || groups.some(g=>g.items.some((item,position)=>hashes.get(`${g.kind}:${position}`)!==item.hash));
      if (!changed) return before!.version;
      const version=newVersion();
      this.db.prepare('INSERT INTO tasks(id,json,version,plan_count,round_count) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,version=excluded.version,plan_count=excluded.plan_count,round_count=excluded.round_count').run(task.id,json,version,plan.length,rounds.length);
      // Compatibility saves carry no occurrence proof. A changed positional row
      // gets a new handle; delta clients must refresh after a full-save fallback.
      const write=this.db.prepare('INSERT INTO task_items(task_id,kind,position,json,content_hash,occurrence_id) VALUES(?,?,?,?,?,?) ON CONFLICT(task_id,kind,position) DO UPDATE SET json=excluded.json,content_hash=excluded.content_hash,occurrence_id=excluded.occurrence_id');
      for(const {kind,items} of groups) {
        items.forEach((item,position)=>{if(hashes.get(`${kind}:${position}`)!==item.hash)write.run(task.id,kind,position,item.json,item.hash,newTaskOccurrenceId());});
        this.db.prepare('DELETE FROM task_items WHERE task_id=? AND kind=? AND position>=?').run(task.id,kind,items.length);
      }
      return version;
    }).immediate();
  }
  private assemble(row:TaskRow):Task {
    const header=JSON.parse(row.json) as Task;
    const items=this.db.prepare('SELECT kind,position,json,content_hash,occurrence_id FROM task_items WHERE task_id=? ORDER BY kind,position').all(row.id) as ItemRow[];
    const plan:Task['plan']=[],rounds:Task['rounds']=[];
    for(const item of items) {
      const target=item.kind==='plan'?plan:rounds;
      if(item.position!==target.length || digest(item.json)!==item.content_hash || !/^[a-f0-9]{32}$/.test(item.occurrence_id))throw new ExplorerError('CORRUPT_TASK');
      target.push(JSON.parse(item.json));
    }
    if(header.id!==row.id || plan.length!==row.plan_count || rounds.length!==row.round_count)throw new ExplorerError('CORRUPT_TASK');
    return {...header,plan,rounds};
  }
  private row(id:string):TaskRow {
    const row=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow|undefined;
    if(!row)throw new ExplorerError('NOT_FOUND');return row;
  }
  private header(row:TaskRow):TaskHeader {
    const header=JSON.parse(row.json) as TaskHeader;
    if(header.id!==row.id || 'plan' in header || 'rounds' in header)throw new ExplorerError('CORRUPT_TASK');
    return header;
  }
  taskHeader(id:string) {
    const row=this.row(id);return {header:this.header(row),version:row.version,planCount:row.plan_count,roundCount:row.round_count};
  }
  /** Initial full audit plus independent occurrence handles for an editing client. */
  taskState(id:string) {
    return this.db.transaction(()=>{
      const row=this.row(id),task=this.assemble(row);
      return {task,...this.taskOrder(id,row.version)};
    })();
  }
  /** Refresh handles after a compatibility full save without decoding history. */
  taskOrder(id:string,expectedVersion?:string) {
    return this.db.transaction(()=>{
      const row=this.row(id);
      if(expectedVersion!==undefined && row.version!==expectedVersion)throw new ExplorerError('STALE_TASK_VERSION');
      const refs=this.db.prepare('SELECT kind,position,occurrence_id FROM task_items WHERE task_id=? ORDER BY kind,position').all(id) as Pick<ItemRow,'kind'|'position'|'occurrence_id'>[];
      const plan:string[]=[],rounds:string[]=[];
      for(const ref of refs){const target=ref.kind==='plan'?plan:rounds;if(ref.position!==target.length || !/^[a-f0-9]{32}$/.test(ref.occurrence_id))throw new ExplorerError('CORRUPT_TASK');target.push(ref.occurrence_id);}
      if(plan.length!==row.plan_count || rounds.length!==row.round_count)throw new ExplorerError('CORRUPT_TASK');
      return {version:row.version,plan,rounds};
    })();
  }
  /** Session ownership lookup preserves the legacy first-created-task result. */
  taskIdForSession(sessionId:string,query:{status?:Task['status'];excludeTaskId?:string}={}):string|undefined {
    const clauses=["task_items.kind='rounds'","json_extract(task_items.json,'$.sessionId')=?"],params=[sessionId];
    if(query.status!==undefined){clauses.push("json_extract(tasks.json,'$.status')=?");params.push(query.status);}
    if(query.excludeTaskId!==undefined){clauses.push('tasks.id<>?');params.push(query.excludeTaskId);}
    const row=this.db.prepare(`SELECT tasks.id,task_items.json,task_items.content_hash FROM task_items JOIN tasks ON tasks.id=task_items.task_id WHERE ${clauses.join(' AND ')} ORDER BY tasks.rowid LIMIT 1`).get(...params) as {id:string;json:string;content_hash:string}|undefined;
    if(row && digest(row.json)!==row.content_hash)throw new ExplorerError('CORRUPT_TASK');return row?.id;
  }
  /** A bounded snapshot read. This validates the returned records, not unrelated
   * historical rows; use task()/taskState() before declaring a full-history audit. */
  taskItems<K extends ItemKind>(id:string,kind:K,query:TaskItemQuery={}) {
    return this.db.transaction(()=>{
      const row=this.row(id);
      if(query.expectedVersion!==undefined && query.expectedVersion!==row.version)throw new ExplorerError('STALE_TASK_VERSION');
      const limit=query.limit??100,after=query.afterPosition??-1;
      if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(after)||after< -1)throw new ExplorerError('INVALID_TASK_DELTA');
      const clauses=['task_id=?','kind=?','position>?'],params:(string|number)[]=[id,kind,after];
      if(query.statuses){clauses.push(query.statuses.length?`json_extract(json,'$.status') IN (${query.statuses.map(()=>'?').join(',')})`:'0');params.push(...query.statuses);}
      // Repeat the literal partial-index predicate only when it cannot exclude
      // any requested status. Other/unknown/mixed statuses keep the general path.
      const activeOnly=kind==='plan' && !!query.statuses?.length && query.statuses.every(status=>['pending','unresolved','blocked'].includes(status));
      if(activeOnly)clauses.push("kind='plan'","json_extract(json,'$.status') IN ('pending','unresolved','blocked')");
      if(query.required!==undefined){clauses.push("json_extract(json,'$.required')=?");params.push(Number(query.required));}
      if(query.occurrenceIds){clauses.push(query.occurrenceIds.length?`occurrence_id IN (${query.occurrenceIds.map(()=>'?').join(',')})`:'0');params.push(...query.occurrenceIds);}
      const items=(this.db.prepare(`SELECT kind,position,json,content_hash,occurrence_id FROM task_items${activeOnly?' INDEXED BY task_active_items':''} WHERE ${clauses.join(' AND ')} ORDER BY position LIMIT ?`).all(...params,limit) as ItemRow[]).map(item=>{
        const count=kind==='plan'?row.plan_count:row.round_count;
        if(digest(item.json)!==item.content_hash || !/^[a-f0-9]{32}$/.test(item.occurrence_id) || !Number.isSafeInteger(item.position) || item.position<0 || item.position>=count)throw new ExplorerError('CORRUPT_TASK');
        return {occurrenceId:item.occurrence_id,position:item.position,value:JSON.parse(item.json) as Task[K][number]};
      });
      return {version:row.version,items,planCount:row.plan_count,roundCount:row.round_count};
    })();
  }
  /** Compare-and-swap applies only explicitly named changes. Header (including
   * dispatch/unknown/budgets), affected items and sync version commit together. */
  applyTaskDelta(id:string,expectedVersion:string,delta:TaskDelta) {
    if(delta.header.id!==id || 'plan' in delta.header || 'rounds' in delta.header)throw new ExplorerError('INVALID_TASK_DELTA');
    const updatedAt=new Date().toISOString(),json=JSON.stringify({...delta.header,updatedAt});
    // Serialize only named records, before acquiring SQLite's write lock.
    const prepared=([['plan',delta.plan],['rounds',delta.rounds]] as const).map(([kind,change])=>({kind,change,
      update:(change?.update??[]).map(item=>{const json=JSON.stringify(item.value);return {...item,json,hash:digest(json)};}),
      append:(change?.append??[]).map(item=>{const json=JSON.stringify(item.value);return {...item,json,hash:digest(json)};})}));
    return this.db.transaction(()=>{
      const before=this.row(id);if(before.version!==expectedVersion)throw new ExplorerError('STALE_TASK_VERSION');
      let changed=before.json!==json,planCount=before.plan_count,roundCount=before.round_count;
      for(const {kind,change,update,append} of prepared){
        if(!change)continue;
        const remove=change.remove??[],claimed=[...update.map(i=>i.occurrenceId),...append.map(i=>i.occurrenceId),...remove];
        if(new Set(claimed).size!==claimed.length || claimed.some(key=>!/^[a-f0-9]{32}$/.test(key)))throw new ExplorerError('INVALID_TASK_DELTA');
        const count=kind==='plan'?planCount:roundCount;
        const lookup=this.db.prepare('SELECT content_hash FROM task_items WHERE task_id=? AND kind=? AND occurrence_id=?');
        for(const item of update){
          const old=lookup.get(id,kind,item.occurrenceId) as {content_hash:string}|undefined;
          if(!old)throw new ExplorerError('TASK_OCCURRENCE_NOT_FOUND');
          if(old.content_hash!==item.hash){this.db.prepare('UPDATE task_items SET json=?,content_hash=? WHERE task_id=? AND kind=? AND occurrence_id=?').run(item.json,item.hash,id,kind,item.occurrenceId);changed=true;}
        }
        for(const key of remove){
          if(!this.db.prepare('DELETE FROM task_items WHERE task_id=? AND kind=? AND occurrence_id=?').run(id,kind,key).changes)throw new ExplorerError('TASK_OCCURRENCE_NOT_FOUND');changed=true;
        }
        for(const [offset,item] of append.entries()){
          if(lookup.get(id,kind,item.occurrenceId))throw new ExplorerError('INVALID_TASK_DELTA');
          this.db.prepare('INSERT INTO task_items(task_id,kind,position,json,content_hash,occurrence_id) VALUES(?,?,?,?,?,?)').run(id,kind,count+offset,item.json,item.hash,item.occurrenceId);changed=true;
        }
        const nextCount=count-remove.length+append.length;
        if(remove.length || change.order){
          const refs=this.db.prepare('SELECT position,occurrence_id FROM task_items WHERE task_id=? AND kind=? ORDER BY position').all(id,kind) as Pick<ItemRow,'position'|'occurrence_id'>[];
          const order=change.order??refs.map(r=>r.occurrence_id),existing=new Set(refs.map(r=>r.occurrence_id));
          if(refs.length!==nextCount || order.length!==nextCount || new Set(order).size!==order.length || order.some(key=>!existing.has(key)))throw new ExplorerError('INVALID_TASK_DELTA');
          if(order.some((key,position)=>refs[position].position!==position || refs[position].occurrence_id!==key)){
            // Vacate positive ordinals before assigning a possibly cyclic permutation.
            this.db.prepare('UPDATE task_items SET position=-position-1 WHERE task_id=? AND kind=?').run(id,kind);
            const move=this.db.prepare('UPDATE task_items SET position=? WHERE task_id=? AND kind=? AND occurrence_id=?');
            order.forEach((key,position)=>move.run(position,id,kind,key));changed=true;
          }
        }
        if(kind==='plan')planCount=nextCount;else roundCount=nextCount;
      }
      const version=changed?newVersion():before.version;
      if(changed)this.db.prepare('UPDATE tasks SET json=?,version=?,plan_count=?,round_count=? WHERE id=?').run(json,version,planCount,roundCount,id);
      return {version,updatedAt,planCount,roundCount};
    }).immediate();
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
