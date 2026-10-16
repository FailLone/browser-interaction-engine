import { afterEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExplorerStore } from '../packages/explorer-plugin/src/store.js';
import type { Task } from '../packages/explorer-plugin/src/types.js';

const directories:string[]=[];
const stores:ExplorerStore[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const store of stores.splice(0))try{store.close();}catch{};for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
function file(){const dir=mkdtempSync(join(tmpdir(),'normalized-explorer-'));directories.push(dir);return join(dir,'plugin.sqlite');}
function open(path=':memory:'){const store=new ExplorerStore(path);stores.push(store);return store;}
function task():Task{return {id:'task',goal:'Explore',url:'https://example.test/',createdAt:'2026-10-17',updatedAt:'2026-10-17',revision:1,status:'paused',budget:{rounds:3,actions:300,durationMs:10000,modelRequests:100},usage:{rounds:1,actions:2,durationMs:100,modelRequests:1},sessionOptions:{},sampleExcluded:[],exhaustive:false,
  plan:['A','B'].map(label=>({id:label,title:label,scope:{label,kind:'fill',value:label},prerequisites:[],completion:'Observed',required:true,reason:'retained',status:'unresolved',attempts:[],evidence:[{sessionId:'s',observationId:`o-${label}`}]})),
  rounds:[{id:'r',number:1,sessionId:'s',startedAt:'2026-10-17',status:'paused',actions:2,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}]};}
function db(store:ExplorerStore){return (store as unknown as {db:Database.Database}).db;}

it('preserves ordered duplicate occurrences and nested edits, returning detached task values',()=>{
  const store=open(),t=task();t.plan[1].id=t.plan[0].id;store.save(t);
  expect(store.task(t.id)).toEqual(t);const version=store.updates(t.id).taskVersion;
  t.plan[1].scope.value='changed';t.plan[1].attempts.push({roundId:'r',outcome:'unknown'});store.save(t);
  expect(store.updates(t.id,0,500,version).task).toEqual(t);
  const copy=store.task(t.id);copy.plan[0].evidence=[];copy.rounds[0].actions=900;
  expect(store.task(t.id)).toEqual(t);
  t.plan.reverse();t.rounds=[];store.save(t);expect(store.task(t.id)).toEqual(t);
  t.plan.splice(1);store.save(t);expect(store.task(t.id)).toEqual(t);
});

it('writes only the changed plan row and header, and keeps the sync version for an exact no-op',()=>{
  const store=open(),t=task();vi.spyOn(Date.prototype,'toISOString').mockReturnValue('same-ms');store.save(t);
  db(store).exec(`CREATE TABLE writes(kind TEXT); CREATE TRIGGER item_update AFTER UPDATE ON task_items BEGIN INSERT INTO writes VALUES(new.kind); END;`);
  const first=store.updates(t.id);store.save(t);expect(store.updates(t.id).taskVersion).toBe(first.taskVersion);
  t.plan[1].scope.value='new';store.save(t);
  expect(db(store).prepare('SELECT kind FROM writes').all()).toEqual([{kind:'plan'}]);
  const next=store.updates(t.id,0,500,first.taskVersion);expect(next.task).toEqual(t);expect(next.taskVersion).not.toBe(first.taskVersion);
  expect(store.taskSummaries()).toEqual([{id:t.id,goal:t.goal,url:t.url,status:t.status,rounds:[{sessionId:'s'}]}]);
});

it('publishes the version, pending dispatch and complete plan atomically on write failure',()=>{
  const store=open(),t=task();store.save(t);const before=store.updates(t.id);
  db(store).exec("CREATE TRIGGER reject_item BEFORE UPDATE ON task_items WHEN new.position=1 BEGIN SELECT RAISE(ABORT,'injected'); END;");
  t.pendingDispatch={sessionId:'s',requestId:'request',actionId:'action',itemIds:['B'],observationId:'o-B'};
  t.plan[0].scope.value='first';t.plan[1].scope.value='second';
  expect(()=>store.save(t)).toThrow('injected');expect(store.task(t.id)).toEqual(before.task);expect(store.updates(t.id).taskVersion).toBe(before.taskVersion);
});

it('retains unknown recovery and dispatch evidence and both A/B sources across closing and reopening',()=>{
  const path=file(),store=open(path),t=task();
  t.pendingDispatch={sessionId:'s',requestId:'pending',actionId:'act',itemIds:['B'],observationId:'o-B'};
  t.unverifiedRecoveries=[{sessionId:'s',observationId:'o-A',attemptIds:['unknown-attempt']}];
  t.plan[0].attempts.push({roundId:'r',outcome:'unknown',evidence:{sessionId:'s',observationId:'o-A',attemptId:'unknown-attempt'}});
  store.save(t);const version=store.updates(t.id).taskVersion;store.close();const reopened=open(path);
  expect(reopened.task(t.id)).toEqual(t);expect(reopened.updates(t.id,0,500,version).task).toBeUndefined();
});

it('sees writes from a second connection without stale hash or object caches',()=>{
  const path=file(),a=open(path),b=open(path),t=task();a.save(t);const version=a.updates(t.id).taskVersion;
  const other=b.task(t.id);other.plan[0].scope.value='other writer';b.save(other);
  expect(a.updates(t.id,0,500,version).task).toEqual(other);
  other.plan[1].scope.value='next';a.save(other);expect(b.task(t.id)).toEqual(other);
});

it('rejects incomplete normalized history instead of silently returning a shorter pending plan',()=>{
  const store=open(),t=task();store.save(t);db(store).prepare("DELETE FROM task_items WHERE task_id=? AND kind='plan' AND position=0").run(t.id);
  expect(()=>store.task(t.id)).toThrow('CORRUPT_TASK');expect(()=>store.tasks()).toThrow('CORRUPT_TASK');
});

it('refuses corrupted item bytes even when a stale digest would suppress a subsequent identical save',()=>{
  const store=open(),t=task();store.save(t);
  db(store).prepare("UPDATE task_items SET json=json_set(json,'$.status','succeeded','$.attempts',json('[]')) WHERE kind='plan' AND position=1").run();
  expect(()=>store.task(t.id)).toThrow('CORRUPT_TASK');store.save(t);
  expect(()=>store.task(t.id)).toThrow('CORRUPT_TASK');
});

it('rolls back restart pausing together with decision invalidation and its event if any write fails',()=>{
  const path=file(),store=open(path),t=task();t.status='running';t.rounds[0].status='running';store.save(t);
  store.decision({id:'d',taskId:t.id,revision:1,actor:'jev',purpose:'next-action',provider:'fake',model:'fake',request:{id:'req',purpose:'next-action',kind:'choice',instructions:'Choose',state:{},options:{}},input:{},status:'requested',startedAt:'2026-10-17'});
  db(store).exec("CREATE TRIGGER reject_restart BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT,'restart injected'); END;");store.close();
  expect(()=>new ExplorerStore(path)).toThrow('restart injected');const raw=new DatabaseSync(path);
  try{expect(JSON.parse((raw.prepare('SELECT json FROM tasks').get() as {json:string}).json).status).toBe('running');raw.exec('DROP TRIGGER reject_restart');}finally{raw.close();}
  const reopened=open(path);expect(reopened.task(t.id).status).toBe('paused');expect(reopened.decisions(t.id)[0].status).toBe('stale');expect(reopened.events(t.id).map(e=>e.type)).toEqual(['decision.stale']);
});

function legacy(path:string,values:Task[]){const raw=new DatabaseSync(path);raw.exec('CREATE TABLE explorer_meta(version INTEGER NOT NULL); INSERT INTO explorer_meta VALUES(1); CREATE TABLE tasks(id TEXT PRIMARY KEY,json TEXT NOT NULL);');for(const t of values)raw.prepare('INSERT INTO tasks VALUES(?,?)').run(t.id,JSON.stringify(t));return raw;}

it('atomically migrates a legacy task while preserving pending work, source references and budgets',()=>{
  const path=file(),t=task();t.plan[0].status='succeeded';t.plan[1].attempts.push({roundId:'r',outcome:'unknown'});t.unverifiedRecoveries=[{sessionId:'s',attemptIds:['u']}];legacy(path,[t]).close();
  const store=open(path);expect(store.task(t.id)).toEqual(t);expect(db(store).prepare('SELECT version FROM explorer_meta').get()).toEqual({version:2});
  expect(JSON.parse((db(store).prepare('SELECT json FROM tasks').get() as {json:string}).json)).not.toHaveProperty('plan');
});

it('rolls back all legacy migration changes if one legacy task is malformed',()=>{
  const path=file(),raw=legacy(path,[task()]);raw.prepare('INSERT INTO tasks VALUES(?,?)').run('bad',JSON.stringify({id:'bad',rounds:[]}));raw.close();
  expect(()=>new ExplorerStore(path)).toThrow('CORRUPT_TASK');const check=new DatabaseSync(path);
  try{expect(check.prepare('SELECT version FROM explorer_meta').get()).toEqual({version:1});expect(check.prepare('PRAGMA table_info(tasks)').all()).toHaveLength(2);expect(JSON.parse((check.prepare("SELECT json FROM tasks WHERE id='task'").get() as {json:string}).json)).toEqual(task());}finally{check.close();}
});
