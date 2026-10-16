import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { taskDigest as digest, packTaskValue, unpackTaskValue, packTaskRecords, unpackTaskRecords, parseTaskValue, TASK_BLOCK_ITEMS, TASK_BLOCK_BYTES, type PackedTaskValue } from './task-codec.js';
import type { Decision, ExplorerEvent, Task } from './types.js';
import { ExplorerError } from './types.js';
import { settleInterruptedClock } from './task-lifecycle.js';

type TaskRow = { id:string; json:string; version:string; plan_count:number; round_count:number; header_data:Buffer|null; header_hash:string|null; header_size:number|null; header_proof:string };
type StoredItem = Task['plan'][number]|Task['rounds'][number];
type ChunkRow = PackedTaskValue & { id:number };
type ChunkEntry = [hash:string,value:StoredItem];
type PreparedItem = {kind:ItemKind;position:number;json:string;content_hash:string;occurrence_id:string;value:StoredItem};
type ItemKind = 'plan'|'rounds';
type ItemRow = { kind:ItemKind; position:number; json:string; content_hash:string; occurrence_id:string; chunk_id:number|null; chunk_slot:number|null; status:string|null; required:number|null; session_id:string|null };
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
const newVersion = () => randomBytes(32).toString('hex');

export class ExplorerStore {
  private db: Database.Database;
  private statements=new Map<string,Database.Statement>();
  private statementBytes=0;
  private statement(sql:string) {
    const cached=this.statements.get(sql);
    if(cached){this.statements.delete(sql);this.statements.set(sql,cached);return cached;}
    const value=this.db.prepare(sql),limit=256*1024;
    // Query arity varies with selected occurrences/statuses. Bound both handles
    // and retained SQL; large one-off queries must not pin a large statement.
    if(sql.length>limit)return value;
    while(this.statements.size>=128||this.statementBytes+sql.length>limit){const oldest=this.statements.keys().next().value!;this.statements.delete(oldest);this.statementBytes-=oldest.length;}
    this.statements.set(sql,value);this.statementBytes+=sql.length;return value;
  }
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
      if (version !== 1 && version !== 2 && version !== 3 && version !== 4) throw new ExplorerError('STORE_VERSION');
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
        for(const row of this.db.prepare('SELECT * FROM tasks').all() as TaskRow[])this.validateLegacy(row);
      }
      if(version<4) {
        // Validate the old representation before changing its physical layout.
        const old=this.db.prepare('SELECT * FROM tasks').all() as TaskRow[];
        for(const row of old)this.validateLegacy(row);
        this.db.exec(`ALTER TABLE tasks ADD COLUMN header_data BLOB;
          ALTER TABLE tasks ADD COLUMN header_hash TEXT;
          ALTER TABLE tasks ADD COLUMN header_size INTEGER;
          ALTER TABLE tasks ADD COLUMN header_proof TEXT;
          CREATE TABLE task_chunks(id INTEGER PRIMARY KEY,content_hash TEXT NOT NULL UNIQUE,raw_size INTEGER NOT NULL,data BLOB NOT NULL);
          ALTER TABLE task_items ADD COLUMN chunk_id INTEGER REFERENCES task_chunks(id);
          ALTER TABLE task_items ADD COLUMN chunk_slot INTEGER;
          ALTER TABLE task_items ADD COLUMN status TEXT;
          ALTER TABLE task_items ADD COLUMN required INTEGER;
          ALTER TABLE task_items ADD COLUMN session_id TEXT;
          UPDATE task_items SET status=json_extract(json,'$.status'),required=json_extract(json,'$.required'),session_id=json_extract(json,'$.sessionId');
          DROP INDEX task_active_items; DROP INDEX task_round_session;
          CREATE INDEX task_active_items ON task_items(task_id,position) WHERE kind='plan' AND status IN ('pending','unresolved','blocked');
          CREATE INDEX task_round_session ON task_items(session_id,task_id) WHERE kind='rounds';
          CREATE INDEX task_chunk_refs ON task_items(chunk_id) WHERE chunk_id IS NOT NULL;
          CREATE INDEX task_cold_items ON task_items(task_id,kind,position) WHERE chunk_id IS NULL AND (kind='rounds' OR status IN ('succeeded','excluded','superseded'));
          UPDATE explorer_meta SET version=4;`);
        for(const row of old){this.writeHeader(row.id,row.json,row.version,row.plan_count,row.round_count);this.packCold(row.id,row.round_count,true);}
      }
      // Existing databases pay one index build. Subsequent restarts inspect
      // unsettled records without parsing every historical model request.
      this.db.exec(`CREATE INDEX IF NOT EXISTS decision_unsettled_task ON decisions(task_id) WHERE json_extract(json,'$.status') IN ('requested','returned');
        CREATE INDEX IF NOT EXISTS task_running_round ON task_items(task_id,position) WHERE kind='rounds' AND status='running';`);
    }).immediate();
    // Older packed headers project only identity/status, so any packed header
    // can hide an interrupted clock. Decode those headers, never their plan or
    // historical rounds; new runtime work still reads only changed occurrences.
    const runningRounds=new Set((this.db.prepare("SELECT DISTINCT task_id FROM task_items INDEXED BY task_running_round WHERE kind='rounds' AND status='running'").all() as {task_id:string}[]).map(row=>row.task_id));
    const pendingDecisions=new Set((this.db.prepare("SELECT DISTINCT task_id FROM decisions INDEXED BY decision_unsettled_task WHERE json_extract(json,'$.status') IN ('requested','returned') AND EXISTS(SELECT 1 FROM tasks WHERE id=decisions.task_id)").all() as {task_id:string}[]).map(row=>row.task_id));
    const candidates=new Set([...(this.db.prepare(`SELECT id FROM tasks WHERE header_data IS NOT NULL
      OR json_extract(json,'$.status')='running' OR json_type(json,'$.activeSince') IS NOT NULL OR json_type(json,'$.pauseRequestedAt') IS NOT NULL`).all() as {id:string}[]).map(row=>row.id),...runningRounds,...pendingDecisions]);
    for (const id of candidates) {
      this.db.transaction(() => {
      const state = this.taskHeader(id), task = state.header;
      if(task.status!=='running'&&task.activeSince===undefined&&task.pauseRequestedAt===undefined&&!runningRounds.has(id)&&!pendingDecisions.has(id))return;
      const roundRows=runningRounds.has(id)?this.statement("SELECT * FROM task_items INDEXED BY task_running_round WHERE task_id=? AND kind='rounds' AND status='running' ORDER BY position").all(id) as ItemRow[]:[];
      const pending=pendingDecisions.has(id)?(this.statement("SELECT json FROM decisions INDEXED BY decision_unsettled_task WHERE task_id=? AND json_extract(json,'$.status') IN ('requested','returned') ORDER BY rowid").all(id) as {json:string}[]).map(row=>JSON.parse(row.json) as Decision):[];
      const prior={status:task.status,reason:task.reason,revision:task.revision,activeSince:task.activeSince,pauseRequestedAt:task.pauseRequestedAt};
      const lastEvent=this.statement('SELECT sequence,json FROM events WHERE task_id=? ORDER BY sequence DESC LIMIT 1').get(id) as {sequence:number;json:string}|undefined;
      const activity=[...(lastEvent?[{source:`event:${lastEvent.sequence}`,at:Date.parse((JSON.parse(lastEvent.json) as ExplorerEvent).at)}]:[]),
        ...pending.map(d=>({source:`decision:${d.id}`,at:Date.parse(d.startedAt)+(typeof d.elapsedMs==='number'&&d.elapsedMs>=0?d.elapsedMs:0)}))];
      const duration=settleInterruptedClock(task,Date.now(),activity,task.status==='running'||roundRows.length>0||task.pauseRequestedAt!==undefined);
      if(task.status==='running'){task.status='paused';task.reason='process_restarted';}task.revision++;
      const cache=new Map<number,ChunkEntry[]>(),rounds=roundRows.map(row=>{
        if(row.position>=state.roundCount)throw new ExplorerError('CORRUPT_TASK');
        const value=this.readItem(row,cache,true) as Task['rounds'][number];value.status='paused';return {occurrenceId:row.occurrence_id,value};
      });
      this.applyTaskDelta(id,state.version,{header:task,...(rounds.length?{rounds:{update:rounds}}:{})});
      for (const d of pending) {
        d.status = 'stale'; d.reason = 'process_restarted'; this.decision(d);
        this.event({taskId:task.id,actor:d.actor,type:'decision.stale',sessionId:d.sessionId,observationId:d.observationId,decisionId:d.id,data:{reason:d.reason}});
      }
      this.event({taskId:task.id,actor:'program',type:'task.recovered',data:{reason:'process_restarted',prior,duration,pausedRoundIds:rounds.map(round=>round.value.id),staleDecisionIds:pending.map(d=>d.id),unknownOutcomesRetained:true,executionAuthorized:false}});
      }).immediate();
    }
    } catch (error) { this.db.close(); throw error; }
  }
  private validateLegacy(row:TaskRow) {
    const header=parseTaskValue<TaskHeader>(row.json),counts={plan:0,rounds:0};
    for(const item of this.db.prepare('SELECT kind,position,json,content_hash,occurrence_id FROM task_items WHERE task_id=? ORDER BY kind,position').all(row.id) as ItemRow[]) {
      if(!(item.kind in counts)||item.position!==counts[item.kind]++||digest(item.json)!==item.content_hash||!/^[a-f0-9]{32}$/.test(item.occurrence_id))throw new ExplorerError('CORRUPT_TASK');
      parseTaskValue(item.json);
    }
    if(!header||typeof header!=='object'||Array.isArray(header)||header.id!==row.id||'plan' in header||'rounds' in header||counts.plan!==row.plan_count||counts.rounds!==row.round_count)throw new ExplorerError('CORRUPT_TASK');
  }
  private headerEncoding(json:string,header?:TaskHeader) {
    if(Buffer.byteLength(json)<4096)return {json,data:null,content_hash:null,raw_size:null};
    const value=header??parseTaskValue<TaskHeader>(json),packed=packTaskValue(json);
    return {json:JSON.stringify({id:value.id,goal:value.goal,url:value.url,status:value.status}),...packed};
  }
  private writeHeader(id:string,json:string,version:string,planCount:number,roundCount:number,encoded=this.headerEncoding(json)) {
    this.statement(`INSERT INTO tasks(id,json,version,plan_count,round_count,header_data,header_hash,header_size,header_proof) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET json=excluded.json,version=excluded.version,plan_count=excluded.plan_count,round_count=excluded.round_count,header_data=excluded.header_data,header_hash=excluded.header_hash,header_size=excluded.header_size,header_proof=excluded.header_proof`).run(id,encoded.json,version,planCount,roundCount,encoded.data,encoded.content_hash,encoded.raw_size,digest(encoded.json+':'+(encoded.content_hash??'')));
  }
  private validateHeaderProjection(row:TaskRow) {
    if(digest(row.json+':'+(row.header_hash??''))!==row.header_proof||(row.header_data!==null&&digest(row.header_data)!==row.header_hash))throw new ExplorerError('CORRUPT_TASK');
  }
  private headerJson(row:TaskRow) {
    this.validateHeaderProjection(row);
    if(row.header_data===null){if(row.header_hash!==null||row.header_size!==null)throw new ExplorerError('CORRUPT_TASK');return row.json;}
    if(row.header_hash===null||row.header_size===null)throw new ExplorerError('CORRUPT_TASK');
    return unpackTaskValue({data:row.header_data,content_hash:row.header_hash,raw_size:row.header_size});
  }
  private itemProjection(value:StoredItem) {
    return {status:value.status??null,required:'required' in value?Number(value.required):null,sessionId:'sessionId' in value?value.sessionId:null};
  }
  private writeItem(id:string,kind:ItemKind,position:number,json:string,hash:string,occurrenceId:string,value:StoredItem,chunkId:number|null=null,chunkSlot:number|null=null) {
    const {status,required,sessionId}=this.itemProjection(value);
    this.statement(`INSERT INTO task_items(task_id,kind,position,json,content_hash,occurrence_id,chunk_id,chunk_slot,status,required,session_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id,kind,position) DO UPDATE SET json=excluded.json,content_hash=excluded.content_hash,occurrence_id=excluded.occurrence_id,chunk_id=excluded.chunk_id,chunk_slot=excluded.chunk_slot,status=excluded.status,required=excluded.required,session_id=excluded.session_id`).run(id,kind,position,json,hash,occurrenceId,chunkId,chunkSlot,status,required,sessionId);
  }
  private chunk(id:number,cache:Map<number,ChunkEntry[]>):ChunkEntry[] {
    let entries=cache.get(id);if(entries)return entries;
    const row=this.statement('SELECT * FROM task_chunks WHERE id=?').get(id) as ChunkRow|undefined;
    if(!row)throw new ExplorerError('CORRUPT_TASK');
    entries=this.decodeChunk(row);cache.set(id,entries);return entries;
  }
  private decodeChunk(row:ChunkRow):ChunkEntry[] {
    const entries=unpackTaskRecords<ChunkEntry[]>(row);
    if(!Array.isArray(entries)||entries.length<1||entries.length>TASK_BLOCK_ITEMS)throw new ExplorerError('CORRUPT_TASK');
    return entries;
  }
  private readItem(item:ItemRow,cache:Map<number,ChunkEntry[]>,copy=false):StoredItem {
    if(!/^[a-f0-9]{32}$/.test(item.occurrence_id)||!Number.isSafeInteger(item.position)||item.position<0)throw new ExplorerError('CORRUPT_TASK');
    let value:StoredItem;
    if(item.chunk_id===null){
      if(item.chunk_slot!==null||digest(item.json)!==item.content_hash)throw new ExplorerError('CORRUPT_TASK');
      value=parseTaskValue<StoredItem>(item.json);
    } else {
      if(item.json!==''||!Number.isSafeInteger(item.chunk_slot)||item.chunk_slot!<0)throw new ExplorerError('CORRUPT_TASK');
      const entry=this.chunk(item.chunk_id,cache)[item.chunk_slot!];
      if(!Array.isArray(entry)||entry.length!==2||entry[0]!==item.content_hash)throw new ExplorerError('CORRUPT_TASK');
      value=copy?structuredClone(entry[1]):entry[1];
    }
    if(!value||typeof value!=='object'||Array.isArray(value))throw new ExplorerError('CORRUPT_TASK');
    const projection=this.itemProjection(value);
    if(item.status!==projection.status||item.required!==projection.required||item.session_id!==projection.sessionId)throw new ExplorerError('CORRUPT_TASK');
    return value;
  }
  /** Only settled plan entries and non-current, non-running rounds are cold.
   * Unknown/future plan states remain hot; classification grants no authority. */
  private packCold(id:string,roundCount:number,force=false) {
    const rows=this.statement(`SELECT * FROM task_items INDEXED BY task_cold_items WHERE task_id=? AND chunk_id IS NULL AND (kind='rounds' OR status IN ('succeeded','excluded','superseded')) AND
      ((kind='plan' AND status IN ('succeeded','excluded','superseded')) OR (kind='rounds' AND position<? AND status<>'running')) ORDER BY kind,position`).all(id,roundCount-1) as ItemRow[];
    if(!force&&rows.length<64)return;
    this.packRows(id,rows.map(row=>({...row,value:this.readItem(row,new Map())})));
  }
  private packRows(id:string,rows:PreparedItem[]) {
    let entries:ChunkEntry[]=[],members:PreparedItem[]=[],bytes=2;
    const flush=()=>{
      if(!entries.length)return;
      const packed=packTaskRecords(entries);
      const inserted=this.statement('INSERT INTO task_chunks(content_hash,raw_size,data) VALUES(?,?,?) ON CONFLICT(content_hash) DO NOTHING').run(packed.content_hash,packed.raw_size,packed.data);
      const chunk=this.statement('SELECT * FROM task_chunks WHERE content_hash=?').get(packed.content_hash) as ChunkRow;
      // Reused persisted bytes must be validated before adding references.
      if(!inserted.changes&&(chunk.raw_size!==packed.raw_size||JSON.stringify(unpackTaskRecords(chunk))!==JSON.stringify(entries)))throw new ExplorerError('CORRUPT_TASK');
      members.forEach((row,slot)=>this.writeItem(id,row.kind,row.position,'',row.content_hash,row.occurrence_id,row.value,chunk.id,slot));
      entries=[];members=[];bytes=2;
    };
    for(const row of rows){
      const size=Buffer.byteLength(row.json)+70;
      if(entries.length&&(entries.length===TASK_BLOCK_ITEMS||bytes+size>TASK_BLOCK_BYTES||members[0].kind!==row.kind))flush();
      entries.push([row.content_hash,row.value]);members.push(row);bytes+=size;
    }
    flush();
  }
  private isCold(kind:ItemKind,value:StoredItem,position:number,roundCount:number) {
    return kind==='plan'?['succeeded','excluded','superseded'].includes(value.status):position<roundCount-1&&value.status!=='running';
  }
  private warmCurrentRound(id:string,roundCount:number) {
    const row=this.statement("SELECT * FROM task_items WHERE task_id=? AND kind='rounds' AND position=? AND chunk_id IS NOT NULL").get(id,roundCount-1) as ItemRow|undefined;
    if(row){const value=this.readItem(row,new Map()),json=JSON.stringify(value);this.writeItem(id,'rounds',row.position,json,digest(json),row.occurrence_id,value);}
  }
  private collectChunks() {
    const chunks=this.statement('SELECT id,content_hash,raw_size,length(data) AS storedBytes FROM task_chunks WHERE NOT EXISTS(SELECT 1 FROM task_items WHERE chunk_id=task_chunks.id)').all() as {id:number;content_hash:string;raw_size:number;storedBytes:number}[];
    this.statement('DELETE FROM task_chunks WHERE NOT EXISTS(SELECT 1 FROM task_items WHERE chunk_id=task_chunks.id)').run();
    return chunks;
  }
  save(task: Task, expectedVersion?:string):string {
    task.updatedAt=new Date().toISOString();const {plan,rounds,...header}=task;
    if(!Array.isArray(plan)||!Array.isArray(rounds))throw new ExplorerError('CORRUPT_TASK');
    const groups=([['plan',plan],['rounds',rounds]] as const).map(([kind,items])=>({kind,items:items.map(value=>{const json=JSON.stringify(value);return {value:parseTaskValue<StoredItem>(json),json,hash:digest(json)};})}));
    const json=JSON.stringify(header),encoded=this.headerEncoding(json,header);
    return this.db.transaction(()=>{
      const before=this.statement('SELECT * FROM tasks WHERE id=?').get(task.id) as TaskRow|undefined;
      if(expectedVersion!==undefined&&before?.version!==expectedVersion)throw new ExplorerError('STALE_TASK_VERSION');
      if(before)this.validateHeaderProjection(before);
      const hashes=new Map((this.statement('SELECT kind,position,content_hash FROM task_items WHERE task_id=?').all(task.id) as {kind:string;position:number;content_hash:string}[]).map(r=>[`${r.kind}:${r.position}`,r.content_hash]));
      const changed=!before||(before.header_data===null?before.json!==json:before.header_hash!==encoded.content_hash)||before.plan_count!==plan.length||before.round_count!==rounds.length||groups.some(g=>g.items.some((item,position)=>hashes.get(`${g.kind}:${position}`)!==item.hash));
      if(!changed)return before!.version;
      const version=newVersion();this.writeHeader(task.id,json,version,plan.length,rounds.length,encoded);
      const cold:PreparedItem[]=[];
      for(const {kind,items} of groups){
        items.forEach((item,position)=>{
          if(hashes.get(`${kind}:${position}`)===item.hash)return;
          const occurrence=newTaskOccurrenceId();
          if(this.isCold(kind,item.value,position,rounds.length))cold.push({kind,position,json:item.json,content_hash:item.hash,occurrence_id:occurrence,value:item.value});
          else this.writeItem(task.id,kind,position,item.json,item.hash,occurrence,item.value);
        });
        this.statement('DELETE FROM task_items WHERE task_id=? AND kind=? AND position>=?').run(task.id,kind,items.length);
      }
      // New histories go directly into blocks; do not allocate full-size SQLite
      // pages merely to free them again in the same initial save transaction.
      if(cold.length>=64)this.packRows(task.id,cold);else for(const item of cold)this.writeItem(task.id,item.kind,item.position,item.json,item.content_hash,item.occurrence_id,item.value);
      this.warmCurrentRound(task.id,rounds.length);this.packCold(task.id,rounds.length);return version;
    }).immediate();
  }
  private assemble(row:TaskRow) {
    const header=this.header(row),items=this.statement('SELECT kind,position,json,content_hash,occurrence_id,chunk_id,chunk_slot,status,required,session_id FROM task_items WHERE task_id=? ORDER BY kind,position').raw(true).all(row.id) as [ItemKind,number,string,string,string,number|null,number|null,string|null,number|null,string|null][];
    const chunks=new Map<number,ChunkEntry[]>();
    // Fetch each compressed block once; joining block bytes onto every occurrence
    // would amplify both SQLite transfer and JS memory by the block's fanout.
    for(const chunk of this.statement('SELECT * FROM task_chunks WHERE id IN (SELECT chunk_id FROM task_items WHERE task_id=? AND chunk_id IS NOT NULL)').all(row.id) as ChunkRow[])chunks.set(chunk.id,this.decodeChunk(chunk));
    const plan:Task['plan']=[],rounds:Task['rounds']=[],planRefs:string[]=[],roundRefs:string[]=[],slots=new Set<string>();
    for(const [kind,position,json,content_hash,occurrence_id,chunk_id,chunk_slot,status,required,session_id] of items){
      const item:ItemRow={kind,position,json,content_hash,occurrence_id,chunk_id,chunk_slot,status,required,session_id};
      if(item.kind!=='plan'&&item.kind!=='rounds')throw new ExplorerError('CORRUPT_TASK');
      const target=item.kind==='plan'?plan:rounds,refs=item.kind==='plan'?planRefs:roundRefs;
      if(item.position!==target.length)throw new ExplorerError('CORRUPT_TASK');
      const slot=item.chunk_id===null?undefined:`${item.chunk_id}:${item.chunk_slot}`;
      // A shared block slot can occur after cross-task deduplication and reorder;
      // never leak shared mutable object identity between independent occurrences.
      const value=this.readItem(item,chunks,slot!==undefined&&slots.has(slot));
      if(slot!==undefined)slots.add(slot);
      (target as StoredItem[]).push(value);refs.push(item.occurrence_id);
    }
    if(plan.length!==row.plan_count||rounds.length!==row.round_count)throw new ExplorerError('CORRUPT_TASK');
    return {task:{...header,plan,rounds},version:row.version,plan:planRefs,rounds:roundRefs};
  }
  /** Explicit maintenance verifies all referenced data before repacking, reports
   * exactly which unreferenced blocks were removed, then optionally shrinks pages.
   * Logical task versions and occurrence handles are unchanged. */
  compactTaskStorage(options:{reclaim?:boolean}={}) {
    if(this.db.inTransaction)throw new ExplorerError('STORAGE_BUSY');
    const checkpoint=()=>{const result=this.db.pragma('wal_checkpoint(TRUNCATE)') as {busy:number;log:number;checkpointed:number}[];if(result.some(row=>row.busy!==0))throw new ExplorerError('STORAGE_BUSY');};
    if(options.reclaim)checkpoint();
    const result=this.db.transaction(()=>{
      const before=this.storageLayout(),rows=this.statement('SELECT * FROM tasks ORDER BY rowid').all() as TaskRow[];
      for(const row of rows){
        const state=this.assemble(row);
        // Repack fragmented blocks too, retaining every live occurrence and value.
        for(const [kind,values,refs] of [['plan',state.task.plan,state.plan],['rounds',state.task.rounds,state.rounds]] as const)values.forEach((value,position)=>{
          const json=JSON.stringify(value);this.writeItem(row.id,kind,position,json,digest(json),refs[position],value);
        });
        this.packCold(row.id,row.round_count,true);
      }
      const removed=this.collectChunks();
      if((this.db.pragma('foreign_key_check') as unknown[]).length)throw new ExplorerError('CORRUPT_TASK');
      for(const row of rows)this.assemble(row);
      return {before,after:this.storageLayout(),removed};
    }).immediate();
    if(options.reclaim){checkpoint();this.db.exec('VACUUM');checkpoint();}
    return {...result,reclaimed:!!options.reclaim,pageCount:(this.db.pragma('page_count',{simple:true}) as number),freePages:(this.db.pragma('freelist_count',{simple:true}) as number)};
  }
  private storageLayout() {
    return this.statement(`SELECT (SELECT COUNT(*) FROM task_items) AS occurrences,(SELECT COUNT(*) FROM task_chunks) AS chunks,
      (SELECT COUNT(*) FROM task_items WHERE chunk_id IS NULL) AS hotItems,(SELECT COUNT(*) FROM task_items WHERE chunk_id IS NOT NULL) AS archivedItems,
      (SELECT COALESCE(SUM(length(data)),0) FROM task_chunks) AS compressedBytes`).get() as {occurrences:number;chunks:number;hotItems:number;archivedItems:number;compressedBytes:number};
  }
  private row(id:string):TaskRow {
    const row=this.statement('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow|undefined;
    if(!row)throw new ExplorerError('NOT_FOUND');return row;
  }
  private header(row:TaskRow):TaskHeader {
    const header=parseTaskValue<TaskHeader>(this.headerJson(row));
    if(!header||typeof header!=='object'||Array.isArray(header)||header.id!==row.id || 'plan' in header || 'rounds' in header || (row.header_data!==null&&row.json!==JSON.stringify({id:header.id,goal:header.goal,url:header.url,status:header.status})))throw new ExplorerError('CORRUPT_TASK');
    return header;
  }
  taskHeader(id:string) {
    const row=this.row(id);return {header:this.header(row),version:row.version,planCount:row.plan_count,roundCount:row.round_count};
  }
  /** Initial full audit plus independent occurrence handles for an editing client. */
  taskState(id:string) {
    return this.db.transaction(()=>{
      return this.assemble(this.row(id));
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
    return this.db.transaction(()=>{
    const clauses=["task_items.kind='rounds'",'task_items.session_id=?'],params=[sessionId];
    if(query.status!==undefined){clauses.push("json_extract(tasks.json,'$.status')=?");params.push(query.status);}
    if(query.excludeTaskId!==undefined){clauses.push('tasks.id<>?');params.push(query.excludeTaskId);}
    const row=this.statement(`SELECT tasks.id,task_items.* FROM task_items JOIN tasks ON tasks.id=task_items.task_id WHERE ${clauses.join(' AND ')} ORDER BY tasks.rowid LIMIT 1`).get(...params) as (ItemRow&{id:string})|undefined;
    if(row){const owner=this.row(row.id);this.validateHeaderProjection(owner);if(row.position>=owner.round_count)throw new ExplorerError('CORRUPT_TASK');this.readItem(row,new Map());}return row?.id;
    })();
  }
  /** A bounded snapshot read validates returned records, not unrelated history. */
  taskItems<K extends ItemKind>(id:string,kind:K,query:TaskItemQuery={}) {
    return this.db.transaction(()=>{
      const row=this.row(id);
      if(query.expectedVersion!==undefined&&query.expectedVersion!==row.version)throw new ExplorerError('STALE_TASK_VERSION');
      const limit=query.limit??100,after=query.afterPosition??-1;
      if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(after)||after< -1)throw new ExplorerError('INVALID_TASK_DELTA');
      const clauses=['task_id=?','kind=?','position>?'],params:(string|number)[]=[id,kind,after];
      if(query.statuses){clauses.push(query.statuses.length?`status IN (${query.statuses.map(()=>'?').join(',')})`:'0');params.push(...query.statuses);}
      const activeOnly=kind==='plan'&&!!query.statuses?.length&&query.statuses.every(status=>['pending','unresolved','blocked'].includes(status));
      if(activeOnly)clauses.push("kind='plan'","status IN ('pending','unresolved','blocked')");
      if(query.required!==undefined){clauses.push('required=?');params.push(Number(query.required));}
      if(query.occurrenceIds){clauses.push(query.occurrenceIds.length?`occurrence_id IN (${query.occurrenceIds.map(()=>'?').join(',')})`:'0');params.push(...query.occurrenceIds);}
      const chunks=new Map<number,ChunkEntry[]>(),slots=new Set<string>();
      const items=(this.statement(`SELECT * FROM task_items${activeOnly?' INDEXED BY task_active_items':''} WHERE ${clauses.join(' AND ')} ORDER BY position LIMIT ?`).all(...params,limit) as ItemRow[]).map(item=>{
        const count=kind==='plan'?row.plan_count:row.round_count;
        if(item.position>=count)throw new ExplorerError('CORRUPT_TASK');
        const slot=item.chunk_id===null?undefined:`${item.chunk_id}:${item.chunk_slot}`,value=this.readItem(item,chunks,slot!==undefined&&slots.has(slot)) as Task[K][number];
        if(slot!==undefined)slots.add(slot);return {occurrenceId:item.occurrence_id,position:item.position,value};
      });
      return {version:row.version,items,planCount:row.plan_count,roundCount:row.round_count};
    })();
  }
  /** Compare-and-swap applies only explicitly named changes. Header (including
   * dispatch/unknown/budgets), affected items and sync version commit together. */
  applyTaskDelta(id:string,expectedVersion:string,delta:TaskDelta) {
    if(delta.header.id!==id || 'plan' in delta.header || 'rounds' in delta.header)throw new ExplorerError('INVALID_TASK_DELTA');
    const updatedAt=new Date().toISOString(),header={...delta.header,updatedAt},json=JSON.stringify(header),encoded=this.headerEncoding(json,header);
    // Serialize only named records, before acquiring SQLite's write lock.
    const prepared=([['plan',delta.plan],['rounds',delta.rounds]] as const).map(([kind,change])=>({kind,change,
      update:(change?.update??[]).map(item=>{const json=JSON.stringify(item.value);return {...item,value:parseTaskValue<typeof item.value>(json),json,hash:digest(json)};}),
      append:(change?.append??[]).map(item=>{const json=JSON.stringify(item.value);return {...item,value:parseTaskValue<typeof item.value>(json),json,hash:digest(json)};})}));
    return this.db.transaction(()=>{
      const before=this.row(id);if(before.version!==expectedVersion)throw new ExplorerError('STALE_TASK_VERSION');this.validateHeaderProjection(before);
      let changed=(before.header_data===null?before.json!==json:before.header_hash!==encoded.content_hash),planCount=before.plan_count,roundCount=before.round_count;
      for(const {kind,change,update,append} of prepared){
        if(!change)continue;
        const remove=change.remove??[],claimed=[...update.map(i=>i.occurrenceId),...append.map(i=>i.occurrenceId),...remove];
        if(new Set(claimed).size!==claimed.length || claimed.some(key=>!/^[a-f0-9]{32}$/.test(key)))throw new ExplorerError('INVALID_TASK_DELTA');
        const count=kind==='plan'?planCount:roundCount;
        const lookup=this.statement('SELECT position,content_hash FROM task_items WHERE task_id=? AND kind=? AND occurrence_id=?');
        for(const item of update){
          const old=lookup.get(id,kind,item.occurrenceId) as {position:number;content_hash:string}|undefined;
          if(!old)throw new ExplorerError('TASK_OCCURRENCE_NOT_FOUND');
          if(old.content_hash!==item.hash){this.writeItem(id,kind,old.position,item.json,item.hash,item.occurrenceId,item.value);changed=true;}
        }
        for(const key of remove){
          if(!this.db.prepare('DELETE FROM task_items WHERE task_id=? AND kind=? AND occurrence_id=?').run(id,kind,key).changes)throw new ExplorerError('TASK_OCCURRENCE_NOT_FOUND');changed=true;
        }
        for(const [offset,item] of append.entries()){
          if(lookup.get(id,kind,item.occurrenceId))throw new ExplorerError('INVALID_TASK_DELTA');
          this.writeItem(id,kind,count+offset,item.json,item.hash,item.occurrenceId,item.value);changed=true;
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
      if(changed){this.writeHeader(id,json,version,planCount,roundCount,encoded);if(delta.rounds?.order||delta.rounds?.remove?.length)this.warmCurrentRound(id,roundCount);if(delta.plan||delta.rounds)this.packCold(id,roundCount);}
      return {version,updatedAt,planCount,roundCount};
    }).immediate();
  }
  tasks(): Task[] { return this.db.transaction(() => (this.db.prepare('SELECT * FROM tasks ORDER BY rowid').all() as TaskRow[]).map(r=>this.assemble(r).task))(); }
  taskSummaries(): {id:string;goal:string;url:string;status:Task['status'];rounds:{sessionId:string}[]}[] {
    return (this.db.prepare(`SELECT json_object('id',id,'goal',json_extract(json,'$.goal'),'url',json_extract(json,'$.url'),'status',json_extract(json,'$.status'),
      'rounds',json((SELECT json_group_array(json_object('sessionId',session_id)) FROM
        (SELECT session_id FROM task_items WHERE task_id=tasks.id AND kind='rounds' ORDER BY position)))) AS summary FROM tasks ORDER BY rowid`).all() as {summary:string}[]).map(r=>JSON.parse(r.summary));
  }
  task(id: string): Task { return this.db.transaction(() => {const r=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow|undefined;if(!r)throw new ExplorerError('NOT_FOUND');return this.assemble(r).task;})(); }
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
