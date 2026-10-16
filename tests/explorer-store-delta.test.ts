import { afterEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExplorerStore, newTaskOccurrenceId, type TaskHeader } from '../packages/explorer-plugin/src/store.js';
import type { Task } from '../packages/explorer-plugin/src/types.js';

const directories:string[]=[],stores:ExplorerStore[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const store of stores.splice(0))try{store.close();}catch{}for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
function file(){const dir=mkdtempSync(join(tmpdir(),'delta-explorer-'));directories.push(dir);return join(dir,'plugin.sqlite');}
function open(path=':memory:'){const store=new ExplorerStore(path);stores.push(store);return store;}
function db(store:ExplorerStore){return (store as unknown as {db:Database.Database}).db;}
function header(t:Task):TaskHeader {const {plan,rounds,...header}=t;return header;}
function fixture():Task{return {id:'task',goal:'Explore',url:'https://example.test/',createdAt:'2026-10-17',updatedAt:'2026-10-17',revision:1,status:'paused',budget:{rounds:3,actions:300,durationMs:10000,modelRequests:100},usage:{rounds:1,actions:2,durationMs:100,modelRequests:1},sessionOptions:{},sampleExcluded:[],exhaustive:false,
  plan:['A','B','C'].map(label=>({id:'shared-business-id',title:label,scope:{label,kind:'fill',value:label},prerequisites:[],completion:'Observed',required:true,reason:'retained',status:'unresolved',attempts:[],evidence:[{sessionId:'s',observationId:`o-${label}`}]})),
  rounds:[{id:'r',number:1,sessionId:'s',startedAt:'2026-10-17',status:'paused',actions:2,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}]};}

it('serializes only explicit updates and preserves distinct occurrences with equal business ids',()=>{
  const store=open();store.save(fixture());const state=store.taskState('task');
  expect(new Set(state.plan).size).toBe(3);expect(state.plan).not.toContain('shared-business-id');
  db(store).exec('CREATE TABLE writes(kind TEXT); CREATE TRIGGER log_update AFTER UPDATE ON task_items BEGIN INSERT INTO writes VALUES(new.kind); END;');
  const untouched=state.task.plan[0] as typeof state.task.plan[number]&{toJSON?:()=>never};untouched.toJSON=()=>{throw Error('Unchanged row was serialized');};
  state.task.plan[1].attempts.push({roundId:'r',outcome:'unknown'});state.task.usage.actions++;
  state.task.pendingDispatch={sessionId:'s',requestId:'req',actionId:'action',observationId:'o-B',itemIds:['shared-business-id']};
  const commit=store.applyTaskDelta('task',state.version,{header:header(state.task),plan:{update:[{occurrenceId:state.plan[1],value:state.task.plan[1]}]}});
  expect(commit.version).not.toBe(state.version);expect(store.taskOrder('task').plan).toEqual(state.plan);
  expect(db(store).prepare('SELECT * FROM writes').all()).toEqual([{kind:'plan'}]);
  const result=store.task('task');expect(result.plan[0].attempts).toEqual([]);expect(result.plan[1].attempts[0].outcome).toBe('unknown');expect(result.pendingDispatch?.requestId).toBe('req');expect(result.usage.actions).toBe(3);
});

it('preserves occurrence identity through cyclic reorder, deletion and insertion atomically',()=>{
  const store=open();store.save(fixture());const state=store.taskState('task'),added=newTaskOccurrenceId(),value={...state.task.plan[1],title:'D'};
  const commit=store.applyTaskDelta('task',state.version,{header:header(state.task),plan:{remove:[state.plan[1]],append:[{occurrenceId:added,value}],order:[state.plan[2],added,state.plan[0]]}});
  expect(commit.planCount).toBe(3);expect(store.taskOrder('task').plan).toEqual([state.plan[2],added,state.plan[0]]);expect(store.task('task').plan.map(i=>i.title)).toEqual(['C','D','A']);
  const next=store.applyTaskDelta('task',commit.version,{header:header(state.task),plan:{order:[state.plan[0],state.plan[2],added]}});
  expect(store.taskOrder('task',next.version).plan).toEqual([state.plan[0],state.plan[2],added]);
});

it('rejects stale reads and writes across connections without overwriting budgets or unknown',()=>{
  const path=file(),a=open(path),b=open(path);a.save(fixture());const x=a.taskState('task'),y=b.taskState('task');
  x.task.usage.actions=99;x.task.unverifiedRecoveries=[{sessionId:'s',attemptIds:['unknown']}];
  a.applyTaskDelta('task',x.version,{header:header(x.task)});
  expect(()=>b.applyTaskDelta('task',y.version,{header:header(y.task),plan:{remove:[y.plan[0]]}})).toThrow('STALE_TASK_VERSION');
  expect(()=>b.save(y.task,y.version)).toThrow('STALE_TASK_VERSION');
  expect(()=>b.taskItems('task','plan',{expectedVersion:y.version})).toThrow('STALE_TASK_VERSION');
  expect(()=>b.taskOrder('task',y.version)).toThrow('STALE_TASK_VERSION');
  expect(b.task('task').usage.actions).toBe(99);expect(b.task('task').unverifiedRecoveries?.[0].attemptIds).toEqual(['unknown']);expect(b.task('task').plan).toHaveLength(3);
});

it('rolls back pending dispatch, usage, all changed rows and version if a later row write fails',()=>{
  const store=open();store.save(fixture());const state=store.taskState('task');
  db(store).exec("CREATE TRIGGER reject_round BEFORE UPDATE ON task_items WHEN new.kind='rounds' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  state.task.usage.actions=900;state.task.pendingDispatch={sessionId:'s',requestId:'req',actionId:'action',observationId:'o',itemIds:[]};state.task.plan[0].status='succeeded';state.task.rounds[0].actions=900;
  const before=store.task('task');
  expect(()=>store.applyTaskDelta('task',state.version,{header:header(state.task),plan:{update:[{occurrenceId:state.plan[0],value:state.task.plan[0]}]},rounds:{update:[{occurrenceId:state.rounds[0],value:state.task.rounds[0]}]}})).toThrow('injected');
  expect(store.task('task')).toEqual(before);expect(store.taskHeader('task').version).toBe(state.version);
});

it('rejects invalid or missing handles and incomplete order without partial changes',()=>{
  const store=open();store.save(fixture());const state=store.taskState('task');
  for(const plan of [
    {remove:[state.plan[0],state.plan[0]]},
    {update:[{occurrenceId:newTaskOccurrenceId(),value:state.task.plan[0]}]},
    {append:[{occurrenceId:state.plan[0],value:state.task.plan[0]}]},
    {remove:[state.plan[0]],order:[state.plan[1]]},
    {order:[state.plan[0],state.plan[0],state.plan[2]]},
  ]){expect(()=>store.applyTaskDelta('task',state.version,{header:header(state.task),plan})).toThrow();expect(store.taskState('task')).toEqual(state);}
});

it('rolls back item changes when publishing the header/version fails last',()=>{
  const store=open();store.save(fixture());const state=store.taskState('task'),before=store.task('task');
  db(store).exec("CREATE TRIGGER reject_header BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'header injected'); END;");
  state.task.plan[0].attempts.push({roundId:'r',outcome:'unknown'});state.task.usage.actions++;
  expect(()=>store.applyTaskDelta('task',state.version,{header:header(state.task),plan:{update:[{occurrenceId:state.plan[0],value:state.task.plan[0]}]}})).toThrow('header injected');
  expect(store.task('task')).toEqual(before);expect(store.taskHeader('task').version).toBe(state.version);
});

it('reads an indexed active page or selected occurrence without decoding unrelated history',()=>{
  const store=open(),task=fixture();task.plan[0].status='succeeded';task.plan[1].status='pending';task.plan[2].required=false;store.save(task);const state=store.taskState('task');
  const active=store.taskItems('task','plan',{expectedVersion:state.version,statuses:['pending','unresolved'],required:true,limit:1});
  expect(active.items.map(i=>i.value.title)).toEqual(['B']);expect(active.items[0].position).toBe(1);
  expect(store.taskItems('task','plan',{occurrenceIds:[state.plan[2]],limit:1}).items[0].value.title).toBe('C');
  expect(store.taskItems('task','plan',{afterPosition:1,limit:1}).items[0].value.title).toBe('C');
  expect(store.taskItems('task','plan',{statuses:['pending','succeeded']}).items.map(i=>i.value.title)).toEqual(['A','B']);
  const future={...state.task.plan[2],status:'future-state'} as unknown as Task['plan'][number];
  store.applyTaskDelta('task',state.version,{header:header(state.task),plan:{update:[{occurrenceId:state.plan[2],value:future}]}});
  expect(store.taskItems('task','plan',{statuses:['pending','future-state']}).items.map(i=>i.value.title)).toEqual(['B','C']);
  // Partial reads are not a full-history integrity or completion proof.
  db(store).prepare("UPDATE task_items SET content_hash='corrupt' WHERE kind='plan' AND position=0").run();
  expect(store.taskItems('task','plan',{statuses:['pending']}).items).toHaveLength(1);
  expect(()=>store.taskItems('task','plan',{occurrenceIds:[state.plan[0]]})).toThrow('CORRUPT_TASK');expect(()=>store.task('task')).toThrow('CORRUPT_TASK');
});

it('keeps idle versions stable and refreshes occurrence handles after a full-save fallback',()=>{
  vi.spyOn(Date.prototype,'toISOString').mockReturnValue('fixed');const store=open();store.save(fixture());const state=store.taskState('task');
  const noChange=store.applyTaskDelta('task',state.version,{header:header(state.task),plan:{update:[{occurrenceId:state.plan[0],value:state.task.plan[0]}]}});expect(noChange.version).toBe(state.version);
  state.task.plan[0].reason='changed';const version=store.save(state.task,state.version),order=store.taskOrder('task',version);
  expect(order.plan[0]).not.toBe(state.plan[0]);expect(order.plan.slice(1)).toEqual(state.plan.slice(1));
  expect(()=>store.applyTaskDelta('task',version,{header:header(state.task),plan:{update:[{occurrenceId:state.plan[0],value:state.task.plan[0]}]}})).toThrow('TASK_OCCURRENCE_NOT_FOUND');
});

it('refuses corrupt occurrence metadata and corrupt selected session evidence in partial reads',()=>{
  const store=open();store.save(fixture());const state=store.taskState('task');
  db(store).prepare("UPDATE task_items SET occurrence_id='bad' WHERE kind='plan' AND position=1").run();
  expect(()=>store.taskItems('task','plan',{statuses:['unresolved']})).toThrow('CORRUPT_TASK');
  db(store).prepare("UPDATE task_items SET occurrence_id=?,position=30 WHERE kind='plan' AND position=1").run(state.plan[1]);
  expect(()=>store.taskItems('task','plan',{occurrenceIds:[state.plan[1]]})).toThrow('CORRUPT_TASK');
  db(store).prepare("UPDATE task_items SET content_hash='bad' WHERE kind='rounds'").run();
  expect(()=>store.taskIdForSession('s')).toThrow('CORRUPT_TASK');
});

it('pauses restart through header and last-round updates while retaining unknown and independent A/B',()=>{
  const path=file(),store=open(path),task=fixture();task.status='running';task.rounds[0].status='running';task.pendingDispatch={sessionId:'s',requestId:'unknown',actionId:'action',observationId:'o-B',itemIds:['shared-business-id']};task.plan[1].attempts=[{roundId:'r',outcome:'unknown'}];store.save(task);const order=store.taskOrder('task');store.close();
  vi.spyOn(ExplorerStore.prototype,'task').mockImplementation(()=>{throw Error('Restart decoded complete task');});
  const reopened=open(path);expect(reopened.taskHeader('task').header.status).toBe('paused');expect(reopened.taskHeader('task').header.pendingDispatch?.requestId).toBe('unknown');expect(reopened.taskOrder('task').plan).toEqual(order.plan);
  expect(reopened.taskItems('task','plan',{occurrenceIds:[order.plan[1]]}).items[0].value.attempts[0].outcome).toBe('unknown');expect(reopened.taskItems('task','rounds').items[0].value.status).toBe('paused');
});

it('uses indexed session ownership preserving the first created task for duplicate sessions',()=>{
  const store=open(),first=fixture(),second=fixture();second.id='second';store.save(first);store.save(second);
  expect(store.taskIdForSession('s')).toBe(first.id);expect(store.taskIdForSession('missing')).toBeUndefined();
  expect(store.taskIdForSession('s',{excludeTaskId:first.id})).toBe(second.id);
  second.status='completed';store.save(second);expect(store.taskIdForSession('s',{status:'completed'})).toBe(second.id);
  first.status='completed';store.save(first);expect(store.taskIdForSession('s',{status:'completed'})).toBe(first.id);
  expect(store.taskIdForSession('s',{status:'completed',excludeTaskId:first.id})).toBe(second.id);
  first.rounds=[];store.save(first);expect(store.taskIdForSession('s')).toBe(second.id);
});

function legacyV2(path:string,task:Task){const raw=new DatabaseSync(path);raw.exec(`CREATE TABLE explorer_meta(version INTEGER NOT NULL);INSERT INTO explorer_meta VALUES(2);
CREATE TABLE tasks(id TEXT PRIMARY KEY,json TEXT NOT NULL,version TEXT NOT NULL,plan_count INTEGER NOT NULL,round_count INTEGER NOT NULL);
CREATE TABLE task_items(task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,position INTEGER NOT NULL,json TEXT NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(task_id,kind,position));`);
raw.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(task.id,JSON.stringify(header(task)),'a'.repeat(64),task.plan.length,task.rounds.length);
for(const [kind,items] of [['plan',task.plan],['rounds',task.rounds]] as const)items.forEach((item,i)=>{const json=JSON.stringify(item);raw.prepare('INSERT INTO task_items VALUES(?,?,?,?,?)').run(task.id,kind,i,json,createHash('sha256').update(json).digest('hex'));});return raw;}

it('migrates v2 atomically without changing bytes, unknown evidence or synchronization version',()=>{
  const path=file(),task=fixture();task.plan[1].attempts=[{roundId:'r',outcome:'unknown'}];const old=legacyV2(path,task);const before=old.prepare('SELECT kind,position,json,content_hash FROM task_items ORDER BY kind,position').all();old.close();
  const store=open(path);expect(store.task('task')).toEqual(task);expect(store.taskHeader('task').version).toBe('a'.repeat(64));expect(db(store).prepare('SELECT kind,position,json,content_hash FROM task_items ORDER BY kind,position').all()).toEqual(before);expect(new Set(store.taskOrder('task').plan).size).toBe(3);
});

it('rolls back the entire v2 upgrade when retained history is incomplete',()=>{
  const path=file(),old=legacyV2(path,fixture());old.exec("DELETE FROM task_items WHERE kind='plan' AND position=1");old.close();expect(()=>new ExplorerStore(path)).toThrow('CORRUPT_TASK');
  const check=new DatabaseSync(path);try{expect(check.prepare('SELECT version FROM explorer_meta').get()).toEqual({version:2});expect(check.prepare('PRAGMA table_info(task_items)').all()).toHaveLength(5);}finally{check.close();}
});
