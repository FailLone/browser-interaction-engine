import { afterEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ExplorerStore } from '../packages/explorer-plugin/src/store.js';
import { TaskWriter } from '../packages/explorer-plugin/src/task-writer.js';
import type { PlanItem, Round, Task } from '../packages/explorer-plugin/src/types.js';

const stores:ExplorerStore[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const store of stores.splice(0))store.close();});
const item=(title:string):PlanItem=>({id:'shared-business-id',title,scope:{label:title,kind:'click'},prerequisites:[],completion:'Observed action',status:'unresolved',required:true,dispatchScope:false,reason:'retained',evidence:[],attempts:[]});
const round=(number:number):Round=>({id:`r${number}`,number,sessionId:`s${number}`,startedAt:'2026-10-17',status:'paused',actions:number,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0});
function fixture(){
  const task:Task={id:'task',goal:'Explore',url:'https://example.test/',createdAt:'2026-10-17',updatedAt:'2026-10-17',revision:1,status:'paused',budget:{rounds:10,actions:100,durationMs:60000,modelRequests:10},usage:{rounds:2,actions:3,durationMs:100,modelRequests:0},sessionOptions:{},plan:[item('A'),item('B')],rounds:[round(1),round(2)],sampleExcluded:[],exhaustive:false};
  const store=new ExplorerStore(':memory:');stores.push(store);store.save(task);
  const state=store.taskState(task.id),writer=new TaskWriter(store,state);
  return {store,state,writer,task:state.task,db:(store as unknown as {db:Database.Database}).db};
}

it('commits explicitly dirty nested entries, current round and header without serializing unchanged history',()=>{
  const {store,state,writer,task}=fixture(),apply=vi.spyOn(store,'applyTaskDelta'),save=vi.spyOn(store,'save');
  expect(writer.task).toBe(task);expect(new Set(state.plan).size).toBe(2);
  Object.assign(task.plan[0],{toJSON(){throw Error('Unchanged plan serialized');}});
  Object.assign(task.rounds[0],{toJSON(){throw Error('Historical round serialized');}});
  task.plan[1].attempts.push({roundId:'r2',outcome:'unknown'});writer.planChanged(task.plan[1]);
  task.rounds[1].tried.push('actual-attempt');task.usage.actions++;
  task.pendingDispatch={sessionId:'s2',requestId:'unknown-request',actionId:'a',itemIds:['shared-business-id'],observationId:'o'};
  writer.flush();
  expect(save).not.toHaveBeenCalled();expect(apply).toHaveBeenCalledTimes(1);
  const delta=apply.mock.calls[0][2];expect(delta.plan?.update?.map(x=>x.occurrenceId)).toEqual([state.plan[1]]);
  expect(delta.rounds?.update?.map(x=>x.occurrenceId)).toEqual([state.rounds[1]]);
  const persisted=store.task('task');expect(persisted.plan[0].attempts).toEqual([]);expect(persisted.plan[1].attempts).toEqual([{roundId:'r2',outcome:'unknown'}]);
  expect(persisted.pendingDispatch?.requestId).toBe('unknown-request');expect(persisted.usage.actions).toBe(4);expect(persisted.rounds[1].tried).toEqual(['actual-attempt']);
  writer.flush();expect(apply.mock.calls[1][2].plan).toBeUndefined();
});

it('keeps equal business IDs as separate appended occurrences and flushes the former current round',()=>{
  const {store,writer,task}=fixture(),apply=vi.spyOn(store,'applyTaskDelta'),first=item('C'),second=item('D'),next=round(3);
  const oldCurrent=task.rounds.at(-1)!;oldCurrent.status='finished';
  writer.appendPlan(first);writer.appendPlan(second);writer.appendRound(next);
  expect(Object.isFrozen(task.plan)).toBe(true);expect(Object.isFrozen(task.rounds)).toBe(true);
  writer.flush();
  const after=store.taskState(task.id);expect(after.task.plan.map(i=>i.title)).toEqual(['A','B','C','D']);expect(new Set(after.plan).size).toBe(4);
  expect(after.task.rounds.map(r=>r.status)).toEqual(['paused','finished','paused']);
  expect(apply.mock.calls[0][2].rounds?.update?.map(x=>x.value.id)).toEqual(['r2']);
  first.evidence.push({sessionId:'s3',observationId:'new-observation'});writer.planChanged(first);writer.flush();
  expect(apply.mock.calls[1][2].plan?.append).toEqual([]);
  expect(apply.mock.calls[1][2].plan?.update?.[0].occurrenceId).toBe(after.plan[2]);
  expect(store.task(task.id).plan[2].evidence).toHaveLength(1);
});

it('refreshes occurrence handles after an explicit full rewrite and returns to delta updates',()=>{
  const {store,state,writer,task}=fixture(),save=vi.spyOn(store,'save'),apply=vi.spyOn(store,'applyTaskDelta');
  writer.prepareRewrite();const oldA=task.plan[0];oldA.reason='migrated';
  task.plan=[task.plan[1],item('New'),oldA];task.rounds=[task.rounds[1]];writer.flush();
  expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][1]).toBe(state.version);expect(apply).not.toHaveBeenCalled();
  const order=store.taskOrder(task.id);expect(Object.isFrozen(task.plan)).toBe(true);expect(store.task(task.id).plan.map(i=>i.title)).toEqual(['B','New','A']);
  oldA.attempts.push({roundId:'r2',outcome:'unknown'});writer.planChanged(oldA);writer.flush();
  expect(save).toHaveBeenCalledTimes(1);expect(apply.mock.calls[0][2].plan?.update?.[0].occurrenceId).toBe(order.plan[2]);
  expect(store.task(task.id).plan[2].attempts[0].outcome).toBe('unknown');
});

it.each([false,true])('never overwrites concurrent unknown/budget changes through a stale writer (rewrite=%s)',rewrite=>{
  const {store,writer,task}=fixture(),other=store.taskState(task.id),winner=new TaskWriter(store,other);
  other.task.usage.actions=77;other.task.unverifiedRecoveries=[{sessionId:'s1',attemptIds:['unknown']}];winner.flush();
  const save=vi.spyOn(store,'save'),apply=vi.spyOn(store,'applyTaskDelta');
  if(rewrite)writer.prepareRewrite();task.plan[0].status='succeeded';writer.planChanged(task.plan[0]);
  expect(()=>writer.flush()).toThrow('STALE_TASK_VERSION');expect(writer.conflicted).toBe(true);
  expect(save).toHaveBeenCalledTimes(rewrite?1:0);expect(apply).toHaveBeenCalledTimes(rewrite?0:1);
  writer.prepareRewrite();expect(()=>writer.flush()).toThrow('STALE_TASK_VERSION');
  expect(save).toHaveBeenCalledTimes(rewrite?1:0);expect(apply).toHaveBeenCalledTimes(rewrite?0:1);
  const persisted=store.task(task.id);expect(persisted.usage.actions).toBe(77);expect(persisted.unverifiedRecoveries?.[0].attemptIds).toEqual(['unknown']);expect(persisted.plan[0].status).toBe('unresolved');
});

it('retains dirty entries and append handles after transaction failure, then retries one atomic publication',()=>{
  const {store,state,writer,task,db}=fixture(),added=item('C');
  task.plan[1].attempts.push({roundId:'r2',outcome:'unknown'});writer.planChanged(task.plan[1]);writer.appendPlan(added);
  task.usage.actions=44;task.pendingDispatch={sessionId:'s2',requestId:'request',actionId:'a',observationId:'o',itemIds:[]};
  db.exec("CREATE TRIGGER fail_header BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'injected header failure'); END;");
  expect(()=>writer.flush()).toThrow('injected header failure');expect(writer.conflicted).toBe(false);
  expect(store.taskHeader(task.id).version).toBe(state.version);expect(store.task(task.id).plan).toHaveLength(2);expect(store.task(task.id).plan[1].attempts).toEqual([]);
  db.exec('DROP TRIGGER fail_header');writer.flush();
  const persisted=store.task(task.id);expect(persisted.plan.map(i=>i.title)).toEqual(['A','B','C']);expect(persisted.plan[1].attempts[0].outcome).toBe('unknown');expect(persisted.usage.actions).toBe(44);expect(persisted.pendingDispatch?.requestId).toBe('request');
  writer.flush();expect(store.task(task.id).plan).toHaveLength(3);
});

it('flushes explicitly changed historical rounds while leaving unrelated history unparsed',()=>{
  const {store,writer,task}=fixture();task.rounds[0].reason='verified historical accounting';writer.roundChanged(task.rounds[0]);
  writer.flush();expect(store.task(task.id).rounds[0].reason).toBe('verified historical accounting');
});

it('refuses unregistered membership changes, duplicate object occurrences and foreign dirty entries',()=>{
  const {store,writer,task}=fixture(),before=store.task(task.id);
  expect(()=>task.plan.push(item('unregistered'))).toThrow();expect(()=>task.rounds.reverse()).toThrow();
  expect(()=>writer.appendPlan(task.plan[0])).toThrow('INVALID_TASK_WRITE_SET');expect(()=>writer.appendRound(task.rounds[0])).toThrow('INVALID_TASK_WRITE_SET');
  expect(()=>writer.planChanged(item('foreign'))).toThrow('INVALID_TASK_WRITE_SET');expect(()=>writer.roundChanged(round(9))).toThrow('INVALID_TASK_WRITE_SET');
  task.plan=[...task.plan,item('unregistered replacement')];expect(()=>writer.flush()).toThrow('INVALID_TASK_WRITE_SET');
  expect(store.task(task.id)).toEqual(before);
});

it.each(['plan','rounds'] as const)('refuses duplicate object occurrences before publishing a full %s rewrite',kind=>{
  const {store,writer,task}=fixture(),before=store.taskState(task.id),save=vi.spyOn(store,'save');
  writer.prepareRewrite();
  if(kind==='plan')task.plan=[task.plan[0],task.plan[0]];else task.rounds=[task.rounds[0],task.rounds[0]];
  expect(()=>writer.flush()).toThrow('INVALID_TASK_WRITE_SET');
  expect(save).not.toHaveBeenCalled();expect(store.taskState(task.id)).toEqual(before);
});
