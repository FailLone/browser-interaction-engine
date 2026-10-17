import { afterEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ExplorerStore, newTaskOccurrenceId, type TaskHeader } from '../packages/explorer-plugin/src/store.js';
import { taskDigest } from '../packages/explorer-plugin/src/task-codec.js';
import type { Task } from '../packages/explorer-plugin/src/types.js';

const stores:ExplorerStore[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const store of stores.splice(0))store.close();});
function open(){const store=new ExplorerStore(':memory:');stores.push(store);return store;}
function raw(store:ExplorerStore){return (store as unknown as {db:Database.Database}).db;}
function header(task:Task):TaskHeader {const {plan,rounds,...value}=task;return value;}
function fixture(cold=0):Task {return {
  id:'task',goal:'Retain full task audit',url:'https://fixture.invalid',createdAt:'2026-10-17',updatedAt:'2026-10-17',revision:1,status:'paused',
  budget:{rounds:10,actions:1000,durationMs:100000,modelRequests:100},usage:{rounds:1,actions:1,durationMs:0,modelRequests:0},sessionOptions:{},sampleExcluded:[],exhaustive:false,
  plan:Array.from({length:cold+2},(_,i)=>({id:'same-business-id',title:`Occurrence ${i}`,scope:{label:`Target ${i}`,kind:'click'},prerequisites:[],completion:'Observe result',required:true,status:i<cold?'succeeded':'unresolved',reason:'original judgement',attempts:[],evidence:[]})),
  rounds:[{id:'current',number:1,sessionId:'session',startedAt:'2026-10-17',status:'paused',actions:1,stack:[],entryPath:[],reentries:[],tried:Array.from({length:1500},(_,i)=>`operation-${i}-retained-context-and-input`),reviewed:[],noProgress:0}],
  unverifiedRecoveries:[{sessionId:'session',attemptIds:['unknown-attempt']}],
  pendingDispatch:{sessionId:'session',requestId:'pending',actionId:'unknown-action',itemIds:['same-business-id'],observationId:'source'},
};}
function packed(store:ExplorerStore){return (raw(store).prepare('SELECT COUNT(*) AS n FROM task_items WHERE chunk_id IS NOT NULL').get() as {n:number}).n;}
function coldReads(store:ExplorerStore){
  return vi.spyOn(store as unknown as {statement:(sql:string)=>Database.Statement},'statement');
}
const transfersColdJson=(sql:string)=>sql.startsWith('SELECT * FROM task_items INDEXED BY task_cold_items');

it('does not decode an unchanged named current round during an active CAS write',()=>{
  const store=open(),task=fixture(34);store.save(task);const before=store.taskState(task.id),roundJson=JSON.stringify(before.task.rounds[0]);
  const parse=vi.spyOn(JSON,'parse'),queries=coldReads(store),changed={...before.task.plan.at(-1)!,reason:'new unresolved evidence'};
  const result=store.applyTaskDelta(task.id,before.version,{header:{...header(before.task),usage:{...task.usage,actions:2}},plan:{update:[{occurrenceId:before.plan.at(-1)!,value:changed}]},rounds:{update:[{occurrenceId:before.rounds[0],value:before.task.rounds[0]}]}});
  expect(parse.mock.calls.filter(([json])=>json===roundJson)).toHaveLength(0);
  expect(queries.mock.calls.some(([sql])=>transfersColdJson(sql))).toBe(false);
  const after=store.taskState(task.id);expect(after.version).toBe(result.version);expect(after.plan).toEqual(before.plan);expect(after.rounds).toEqual(before.rounds);expect(after.task.rounds).toEqual(before.task.rounds);
  expect(after.task.plan).toEqual([...before.task.plan.slice(0,-1),changed]);expect(after.task.pendingDispatch).toEqual(before.task.pendingDispatch);expect(after.task.unverifiedRecoveries).toEqual(before.task.unverifiedRecoveries);
});

it('full compatibility saves serialize each item once but only decode changed records',()=>{
  const store=open(),task=fixture();store.save(task);const before=store.taskState(task.id),itemJson=new Set([...before.task.plan,...before.task.rounds].map(value=>JSON.stringify(value)));
  let serializations=0;const original=structuredClone(before.task.rounds[0]);Object.assign(before.task.rounds[0],{toJSON:()=>{serializations++;return original;}});
  const parse=vi.spyOn(JSON,'parse');store.save(before.task,before.version);
  expect(serializations).toBe(1);expect(parse.mock.calls.filter(([json])=>itemJson.has(json))).toHaveLength(0);
  const after=store.taskState(task.id);expect(after.plan).toEqual(before.plan);expect(after.rounds).toEqual(before.rounds);expect(after.task.rounds).toEqual([original]);
});

it('derives projections and packed values from one canonical serialization of changed inputs',()=>{
  const store=open(),task=fixture(63);store.save(task);const before=store.taskState(task.id),original=before.task.plan[63];let calls=0;
  const supplied=Object.assign({...original},{toJSON:()=>({...original,status:'succeeded',reason:`canonical-${++calls}`})});
  store.applyTaskDelta(task.id,before.version,{header:header(before.task),plan:{update:[{occurrenceId:before.plan[63],value:supplied}]}});
  expect(calls).toBe(1);expect(packed(store)).toBe(64);expect(store.taskItems(task.id,'plan',{occurrenceIds:[before.plan[63]]}).items[0].value).toEqual({...original,status:'succeeded',reason:'canonical-1'});
  expect(store.taskOrder(task.id).plan).toEqual(before.plan);
});

it('still packs older plain cold rows at the original threshold on a current-round write',()=>{
  const store=open(),task=fixture(63);store.save(task);const before=store.taskState(task.id),queries=coldReads(store);
  const first=store.applyTaskDelta(task.id,before.version,{header:{...header(before.task),revision:2},rounds:{update:[{occurrenceId:before.rounds[0],value:before.task.rounds[0]}]}});
  expect(packed(store)).toBe(0);expect(queries.mock.calls.some(([sql])=>transfersColdJson(sql))).toBe(false);
  // Model an older schema-4 writer that left eligible rows in their plain layout.
  // Keep each value/hash/projection/occurrence consistent; no business data is removed.
  const value={...before.task.plan[63],status:'succeeded'},json=JSON.stringify(value);
  raw(store).prepare("UPDATE task_items SET json=?,content_hash=?,status='succeeded' WHERE task_id=? AND occurrence_id=?").run(json,taskDigest(json),task.id,before.plan[63]);
  queries.mockClear();store.applyTaskDelta(task.id,first.version,{header:{...header(before.task),revision:3},rounds:{update:[{occurrenceId:before.rounds[0],value:before.task.rounds[0]}]}});
  expect(packed(store)).toBe(64);expect(queries.mock.calls.some(([sql])=>transfersColdJson(sql))).toBe(true);expect(store.taskOrder(task.id).plan).toEqual(before.plan);
  expect(store.task(task.id).plan[63]).toEqual(value);expect(store.task(task.id).unverifiedRecoveries).toEqual(task.unverifiedRecoveries);
});

it('counts the former current round when append makes it cold and preserves the new current round',()=>{
  const store=open(),task=fixture(63);store.save(task);const before=store.taskState(task.id),next={...before.task.rounds[0],id:'next',sessionId:'next-session',number:2,tried:[]};
  store.applyTaskDelta(task.id,before.version,{header:header(before.task),rounds:{append:[{occurrenceId:newTaskOccurrenceId(),value:next}]}});
  expect(packed(store)).toBe(64);const state=store.taskState(task.id);expect(state.task.rounds).toEqual([...before.task.rounds,next]);expect(state.rounds[0]).toBe(before.rounds[0]);
  expect(raw(store).prepare("SELECT chunk_id FROM task_items WHERE kind='rounds' AND position=1").get()).toEqual({chunk_id:null});
});

it('explicit maintenance still packs below the threshold without changing audit, values or occurrence handles',()=>{
  const store=open(),task=fixture(3);store.save(task);store.event({taskId:task.id,actor:'program',type:'audit.original',data:{unknown:'must stay unknown'}});
  const before=store.taskState(task.id),events=store.events(task.id);expect(packed(store)).toBe(0);store.compactTaskStorage();
  expect(packed(store)).toBe(3);expect(store.taskState(task.id)).toEqual(before);expect(store.events(task.id)).toEqual(events);
});

it('keeps CAS and rollback atomic when later canonical data cannot be stored',()=>{
  const store=open(),task=fixture();store.save(task);const before=store.taskState(task.id),bad=Object.assign({...before.task.plan[1]},{toJSON:()=>null});
  expect(()=>store.applyTaskDelta(task.id,'stale',{header:header(before.task),plan:{remove:[before.plan[0]]}})).toThrow('STALE_TASK_VERSION');
  expect(()=>store.applyTaskDelta(task.id,before.version,{header:header(before.task),plan:{update:[{occurrenceId:before.plan[0],value:{...before.task.plan[0],reason:'must roll back'}},{occurrenceId:before.plan[1],value:bad}]}})).toThrow();
  expect(store.taskState(task.id)).toEqual(before);expect(raw(store).pragma('foreign_key_check')).toEqual([]);
});
