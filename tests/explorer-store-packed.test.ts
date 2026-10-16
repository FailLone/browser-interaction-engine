import { afterEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExplorerStore, type TaskHeader } from '../packages/explorer-plugin/src/store.js';
import { packTaskRecords, unpackTaskRecords, packTaskValue, taskDigest } from '../packages/explorer-plugin/src/task-codec.js';
import type { Task } from '../packages/explorer-plugin/src/types.js';
const directories:string[]=[],stores:ExplorerStore[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const store of stores.splice(0))try{store.close();}catch{}for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function file(){const dir=mkdtempSync(join(tmpdir(),'packed-explorer-'));directories.push(dir);return join(dir,'task.sqlite');}
function open(path=':memory:'){const store=new ExplorerStore(path);stores.push(store);return store;}
function db(store:ExplorerStore){return (store as unknown as {db:Database.Database}).db;}
function header(task:Task):TaskHeader {const {plan,rounds,...value}=task;return value;}
function fixture(count=300):Task {return {id:'task',goal:'Preserve independent occurrences and original audit',url:'https://fixture.invalid',createdAt:'2026-10-17',updatedAt:'2026-10-17',revision:1,status:'paused',budget:{rounds:100,actions:10000,durationMs:100000,modelRequests:100},usage:{rounds:2,actions:50,durationMs:0,modelRequests:1},sessionOptions:{},sampleExcluded:[],exhaustive:false,
  plan:Array.from({length:count},(_,i)=>({id:'duplicate-business-id',title:`Branch ${i}`,scope:{label:`Branch ${i}`,kind:'fill',value:'value'},prerequisites:[{label:'Menu',kind:'click'}],completion:'Observe exact branch',required:true,status:i<count-2?'succeeded':'unresolved',reason:'original judgement retained',attempts:[{roundId:'old',outcome:i===0?'unknown':'succeeded',evidence:{sessionId:'source',observationId:`o-${i}`,attemptId:`a-${i}`}}],evidence:[{sessionId:'source',observationId:`o-${i}`}]})),
  rounds:[{id:'old',number:1,sessionId:'source',startedAt:'2026-10-17',status:'finished',actions:48,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0},{id:'current',number:2,sessionId:'current',startedAt:'2026-10-17',status:'paused',actions:2,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}],
  scopeMigrationIndex:{version:2,keys:Array.from({length:count},(_,i)=>`key-${i}-preserved-original-context`),sources:{}},unverifiedRecoveries:[{sessionId:'source',attemptIds:['a-0']}],pendingDispatch:{sessionId:'current',requestId:'request',actionId:'unknown-action',itemIds:['duplicate-business-id'],observationId:'current-observation'}};}
function layout(store:ExplorerStore){return db(store).prepare('SELECT COUNT(*) AS chunks,(SELECT COUNT(*) FROM task_items WHERE chunk_id IS NOT NULL) AS archived FROM task_chunks').get() as {chunks:number;archived:number};}

it('roundtrips dictionary values and extension keys without prototype changes or shared mutable objects',()=>{
  const item=JSON.parse('{"__proto__":{"polluted":true},"constructor":"kept","empty":[],"data":[null,false,0,-2,2.5,"repeated",{"value":"repeated"}]}');
  const values=[item,item],restored=unpackTaskRecords<typeof values>(packTaskRecords(values));
  expect(restored).toEqual(values);expect(Object.getPrototypeOf(restored[0])).toBe(Object.prototype);expect(restored[0]).not.toBe(restored[1]);restored[0].data[6].value='changed';expect(restored[1].data[6].value).toBe('repeated');
});

it('rejects invalid compressed bytes, lengths and dictionary references',()=>{
  const good=packTaskRecords([{value:'retained'}]);expect(()=>unpackTaskRecords({...good,data:Buffer.from('broken')})).toThrow('CORRUPT_TASK');expect(()=>unpackTaskRecords({...good,raw_size:good.raw_size-1})).toThrow('CORRUPT_TASK');
  for(const value of [[2,[],[],null],[1,[],[],900],[1,[['duplicate','duplicate']],[],[0,true,false]],[1,[],[],[-2,'bad']],[1,[],[],[900]]])expect(()=>unpackTaskRecords(packTaskValue(JSON.stringify(value)))).toThrow('CORRUPT_TASK');
});

it('archives settled occurrences and old rounds while keeping active/future/untested items and the current round hot',()=>{
  const store=open(),task=fixture();task.plan[1].status='untested';task.plan[2].status='future-status' as never;store.save(task);
  expect(layout(store).archived).toBe(297);expect(store.task(task.id)).toEqual(task);expect(store.taskState(task.id).task).toEqual(task);
  const hot=db(store).prepare('SELECT kind,position FROM task_items WHERE chunk_id IS NULL ORDER BY kind,position').all();expect(hot).toEqual([{kind:'plan',position:1},{kind:'plan',position:2},{kind:'plan',position:298},{kind:'plan',position:299},{kind:'rounds',position:1}]);
  const first=store.task(task.id);first.plan[0].attempts[0].outcome='succeeded';expect(store.task(task.id).plan[0].attempts[0].outcome).toBe('unknown');
  expect(new Set(store.taskOrder(task.id).plan).size).toBe(300);
  expect(store.taskItems(task.id,'plan',{statuses:['succeeded'],limit:1}).items[0].value).toEqual(task.plan[0]);expect(store.taskIdForSession('source')).toBe(task.id);
});

it('deduplicates identical archived blocks across tasks without merging occurrence identities',()=>{
  const store=open(),first=fixture(),second=structuredClone(first);second.id='second';store.save(first);const once=layout(store);store.save(second);expect(layout(store).chunks).toBe(once.chunks);expect(layout(store).archived).toBe(once.archived*2);
  const a=store.taskState(first.id),b=store.taskState(second.id);expect(a.plan).not.toEqual(b.plan);a.task.plan[0].title='changed';store.applyTaskDelta(first.id,a.version,{header:header(a.task),plan:{update:[{occurrenceId:a.plan[0],value:a.task.plan[0]}]}});expect(store.task(second.id)).toEqual(second);
});

it('updates, reorders and deletes archived occurrences atomically with CAS and keeps the new current round hot',()=>{
  const path=file(),store=open(path),other=open(path);store.save(fixture());const before=store.taskState('task');
  const changed={...before.task.plan[260],status:'unresolved' as const,reason:'reopened exact occurrence'};
  const order=[...before.plan];[order[0],order[260]]=[order[260],order[0]];
  const commit=store.applyTaskDelta('task',before.version,{header:header(before.task),plan:{update:[{occurrenceId:before.plan[260],value:changed}],order},rounds:{remove:[before.rounds[1]]}});
  expect(store.task('task').plan[0]).toEqual(changed);expect(store.taskOrder('task').plan).toEqual(order);expect(store.taskItems('task','rounds').items[0].value.id).toBe('old');expect(db(store).prepare("SELECT chunk_id FROM task_items WHERE kind='rounds'").get()).toEqual({chunk_id:null});
  expect(()=>other.applyTaskDelta('task',before.version,{header:header(before.task),plan:{remove:[before.plan[0]]}})).toThrow('STALE_TASK_VERSION');expect(other.taskHeader('task').version).toBe(commit.version);
});

it('rolls back compressed block allocation, occurrence edits and header on a failed block reference write',()=>{
  const store=open(),task=fixture(),before=layout(store);db(store).exec("CREATE TRIGGER reject_archive BEFORE INSERT ON task_items WHEN new.chunk_id IS NOT NULL AND new.position=100 BEGIN SELECT RAISE(ABORT,'archive injected'); END;");
  expect(()=>store.save(task)).toThrow('archive injected');expect(layout(store)).toEqual(before);expect(store.tasks()).toEqual([]);
});

it('detects corrupt blocks, cold reference hashes and query metadata without silently omitting retained evidence',()=>{
  for(const corrupt of ["UPDATE task_chunks SET data=X'00' WHERE id=(SELECT chunk_id FROM task_items WHERE kind='plan' AND position=0)","UPDATE task_items SET chunk_slot=999 WHERE kind='plan' AND position=0","UPDATE task_items SET content_hash='bad' WHERE kind='plan' AND position=0","UPDATE task_items SET status='excluded' WHERE kind='plan' AND position=0"]){
    const store=open();store.save(fixture());const state=store.taskOrder('task');db(store).exec(corrupt);expect(()=>store.task('task')).toThrow('CORRUPT_TASK');expect(()=>store.taskItems('task','plan',{occurrenceIds:[state.plan[0]]})).toThrow('CORRUPT_TASK');expect(()=>store.compactTaskStorage()).toThrow('CORRUPT_TASK');expect(store.taskItems('task','plan',{statuses:['unresolved']}).items).toHaveLength(2);
  }
});

it('validates a compressed header and its indexed status projection before session ownership can authorize release',()=>{
  for(const sql of ["UPDATE tasks SET json=json_set(json,'$.status','completed')","UPDATE tasks SET header_data=X'00'"]){const store=open();store.save(fixture());db(store).exec(sql);expect(()=>store.taskHeader('task')).toThrow('CORRUPT_TASK');expect(()=>store.taskIdForSession('source')).toThrow('CORRUPT_TASK');}
});

it('binds session lookup and archived round decoding to one read snapshot across compaction',()=>{
  const path=file(),a=open(path),b=open(path);a.save(fixture());const read=(a as unknown as {readItem:(...args:unknown[])=>unknown}).readItem.bind(a);let done=false;
  vi.spyOn(a as never,'readItem' as never).mockImplementation(((...args:unknown[])=>{if(!done){done=true;const task=b.taskState('task');b.applyTaskDelta('task',task.version,{header:header(task.task),rounds:{remove:[task.rounds[0]]}});b.compactTaskStorage();}return read(...args);}) as never);
  expect(a.taskIdForSession('source')).toBe('task');expect(b.taskIdForSession('source')).toBeUndefined();
});

it('reclaims only verified unreferenced blocks and keeps logical values, handles, decisions and audit events unchanged',()=>{
  const path=file(),store=open(path),task=fixture(1000);store.save(task);store.decision({id:'decision',taskId:task.id,revision:1,actor:'jev',purpose:'original-judgment',provider:'test',model:'test',request:{id:'req',purpose:'original-judgment',kind:'choice',instructions:'Preserve original judgement',state:{},options:{}},input:{},status:'applied',startedAt:'2026-10-17'});store.event({taskId:task.id,actor:'program',type:'audit.original',data:{judgement:'unknown remains unknown'}});
  const state=store.taskState(task.id),removed=state.plan.slice(50,900);store.applyTaskDelta(task.id,state.version,{header:header(state.task),plan:{remove:removed}});
  const before=store.taskState(task.id),events=store.events(task.id),decisions=store.decisions(task.id);db(store).pragma('wal_checkpoint(TRUNCATE)');const sizeBefore=statSync(path).size;
  const result=store.compactTaskStorage({reclaim:true});expect(result.removed.length).toBeGreaterThan(0);expect(result.removed.every(row=>/^[a-f0-9]{64}$/.test(row.content_hash)&&row.storedBytes>0)).toBe(true);expect(result.after.occurrences).toBe(before.plan.length+before.rounds.length);expect(store.taskState(task.id)).toEqual(before);expect(store.events(task.id)).toEqual(events);expect(store.decisions(task.id)).toEqual(decisions);expect(db(store).pragma('foreign_key_check')).toEqual([]);expect(statSync(path).size).toBeLessThan(sizeBefore);expect(result.freePages).toBe(0);
});

it('refuses physical reclamation inside a transaction or while another reader holds the WAL',()=>{
  const path=file(),a=open(path),b=open(path);a.save(fixture());expect(()=>db(a).transaction(()=>a.compactTaskStorage({reclaim:true}))()).toThrow('STORAGE_BUSY');
  db(a).pragma('busy_timeout=0');db(b).exec('BEGIN');b.taskHeader('task');const t=a.task('task');t.usage.actions++;a.save(t);const state=a.taskState('task');
  try{expect(()=>a.compactTaskStorage({reclaim:true})).toThrow('STORAGE_BUSY');expect(a.taskState('task')).toEqual(state);}finally{db(b).exec('ROLLBACK');}
});

function legacyV3(path:string,task:Task){const raw=new DatabaseSync(path);raw.exec(`CREATE TABLE explorer_meta(version INTEGER NOT NULL); INSERT INTO explorer_meta VALUES(3);
CREATE TABLE tasks(id TEXT PRIMARY KEY,json TEXT NOT NULL,version TEXT NOT NULL,plan_count INTEGER NOT NULL,round_count INTEGER NOT NULL);
CREATE TABLE task_items(task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,position INTEGER NOT NULL,json TEXT NOT NULL,content_hash TEXT NOT NULL,occurrence_id TEXT NOT NULL,PRIMARY KEY(task_id,kind,position));
CREATE UNIQUE INDEX task_item_occurrence ON task_items(task_id,kind,occurrence_id);
CREATE INDEX task_active_items ON task_items(task_id,position) WHERE kind='plan' AND json_extract(json,'$.status') IN ('pending','unresolved','blocked');
CREATE INDEX task_round_session ON task_items(json_extract(json,'$.sessionId'),task_id) WHERE kind='rounds';`);
raw.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(task.id,JSON.stringify(header(task)),'v3-version',task.plan.length,task.rounds.length);
for(const [kind,items] of [['plan',task.plan],['rounds',task.rounds]] as const)items.forEach((value,position)=>{const json=JSON.stringify(value),occurrence=createHash('md5').update(kind+position).digest('hex');raw.prepare('INSERT INTO task_items VALUES(?,?,?,?,?,?)').run(task.id,kind,position,json,taskDigest(json),occurrence);});return raw;}

it('migrates v3 atomically, preserving the exact occurrence handles, version and unknown audit',()=>{
  const path=file(),task=fixture(),raw=legacyV3(path,task),refs=raw.prepare('SELECT occurrence_id FROM task_items ORDER BY kind,position').all().map(row=>row.occurrence_id);raw.close();const store=open(path),state=store.taskState(task.id);expect(state.task).toEqual(task);expect(state.version).toBe('v3-version');expect([...state.plan,...state.rounds]).toEqual(refs);expect(layout(store).archived).toBe(299);
  store.close();const reopened=open(path);expect(reopened.taskState(task.id)).toEqual(state);
});

it('rolls back every v3 schema alteration when a retained source record is corrupted',()=>{
  const path=file(),raw=legacyV3(path,fixture());raw.exec("UPDATE task_items SET content_hash='bad' WHERE position=0 AND kind='plan'");raw.close();expect(()=>new ExplorerStore(path)).toThrow('CORRUPT_TASK');const check=new DatabaseSync(path);try{expect(check.prepare('SELECT version FROM explorer_meta').get()?.version).toBe(3);expect(check.prepare('PRAGMA table_info(tasks)').all()).toHaveLength(5);expect(check.prepare("SELECT name FROM sqlite_master WHERE name='task_chunks'").get()).toBeUndefined();}finally{check.close();}
});


it('pauses a packed running task after restart without losing unknown, pending dispatch or historical occurrences',()=>{
  const path=file(),store=open(path),task=fixture();task.status='running';task.rounds[1].status='running';store.save(task);const refs=store.taskOrder(task.id);store.close();
  const audit=vi.spyOn(ExplorerStore.prototype,'taskState').mockImplementation(()=>{throw Error('Restart performed a full audit');});
  const reopened=open(path);expect(reopened.taskHeader(task.id).header.status).toBe('paused');expect(reopened.taskItems(task.id,'rounds',{afterPosition:0}).items[0].value.status).toBe('paused');expect(reopened.taskOrder(task.id).plan).toEqual(refs.plan);const loaded=reopened.task(task.id);expect(loaded.pendingDispatch).toEqual(task.pendingDispatch);expect(loaded.unverifiedRecoveries).toEqual(task.unverifiedRecoveries);expect(loaded.plan).toEqual(task.plan);audit.mockRestore();
});

it('rolls back maintenance reference rewrites when a later task fails validation',()=>{
  const store=open(),first=fixture(),second=fixture();second.id='second';store.save(first);store.save(second);
  db(store).exec("UPDATE task_items SET content_hash='bad' WHERE task_id='second' AND kind='plan' AND position=0");
  const rows=db(store).prepare('SELECT * FROM task_items ORDER BY task_id,kind,position').all(),chunks=db(store).prepare('SELECT * FROM task_chunks ORDER BY id').all();
  expect(()=>store.compactTaskStorage()).toThrow('CORRUPT_TASK');expect(db(store).prepare('SELECT * FROM task_items ORDER BY task_id,kind,position').all()).toEqual(rows);expect(db(store).prepare('SELECT * FROM task_chunks ORDER BY id').all()).toEqual(chunks);expect(store.task(first.id)).toEqual(first);
});


it('packs the same canonical values it hashed and serializes each supplied item once',()=>{
  const store=open(),task=fixture(),original=structuredClone(task.plan[0]);let calls=0;
  Object.assign(task.plan[0],{toJSON:()=>({...original,scope:{...original.scope,value:`serialized-${++calls}`}})});
  store.save(task);expect(calls).toBe(1);expect(store.task(task.id).plan[0].scope.value).toBe('serialized-1');
  const state=store.taskState(task.id),value=Object.assign({...state.task.plan[1]},{toJSON:()=>({...state.task.plan[1],status:'unresolved',reason:`delta-${++calls}`})});
  store.applyTaskDelta(task.id,state.version,{header:header(state.task),plan:{update:[{occurrenceId:state.plan[1],value}]}});expect(calls).toBe(2);expect(store.taskItems(task.id,'plan',{statuses:['unresolved']}).items[0].value.reason).toBe('delta-2');
});

it('bounds prepared statements across varying query arities and skips oversized SQL',()=>{
  const store=open();store.save(fixture());for(let size=1;size<180;size++)store.taskItems('task','plan',{statuses:Array(size).fill('unresolved'),limit:1});
  const cache=store as unknown as {statements:Map<string,unknown>;statementBytes:number;statement:(sql:string)=>unknown};
  expect(cache.statements.size).toBeLessThanOrEqual(128);expect(cache.statementBytes).toBeLessThanOrEqual(256*1024);expect(cache.statementBytes).toBe([...cache.statements.keys()].reduce((n,sql)=>n+sql.length,0));
  const oversized="SELECT '"+'x'.repeat(256*1024)+"'";cache.statement(oversized);expect(cache.statements.has(oversized)).toBe(false);
});
