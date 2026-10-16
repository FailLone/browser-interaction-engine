import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import { InteractionEngine, type ActionAttempt, type ActionCandidate, type Persistence } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { RetainedPersistence } from '@interaction/storage-retained';
import { SqliteStore } from '@interaction/storage-sqlite';
import { CounterAdapter, type CounterObservation } from '../examples/counter-adapter.js';

type Row = { id:string;sessionId:string;observationId?:string;value?:{count:number} };
const Database=createRequire(new URL('../packages/storage-sqlite/package.json',import.meta.url))('better-sqlite3') as typeof BetterSqlite3;
function sqliteFixture() {
  const directory=mkdtempSync(join(tmpdir(),'action-observation-query-')),store=new SqliteStore(directory);
  return {directory,store,close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
for(const kind of ['memory','sqlite'] as const)describe(`${kind} observation-scoped reads`,()=>{
  it('matches complete filtering, order and isolation across updates and rollback',()=>{
    const f=kind==='sqlite'?sqliteFixture():undefined,store=f?.store??new MemoryStore();
    try{
      for(const row of [
        {id:'a',sessionId:'s',observationId:'old'},
        {id:'b',sessionId:'s',observationId:'now',value:{count:2}},
        {id:'c',sessionId:'other',observationId:'now'},
        {id:'d',sessionId:'s',observationId:'now'},
        {id:'e',sessionId:'s'},
      ])store.put('action',row);
      store.put('attempt',{id:'attempt',sessionId:'s',observationId:'now'});
      const expected=()=>store.list<Row>('action','s').filter(row=>row.observationId==='now');
      expect(store.listByObservation<Row>('action','s','now')).toEqual(expected());
      const read=store.listByObservation<Row>('action','s','now');read[0].value!.count=9;
      expect(store.listByObservation<Row>('action','s','now')[0].value!.count).toBe(2);
      store.put('action',{id:'a',sessionId:'s',observationId:'now'});
      expect(store.listByObservation<Row>('action','s','now').map(row=>row.id)).toEqual(['a','b','d']);
      expect(()=>store.transaction(()=>{store.put('action',{id:'b',sessionId:'s',observationId:'elsewhere'});throw Error('rollback');})).toThrow('rollback');
      expect(store.listByObservation<Row>('action','s','now')).toEqual(expected());
      expect(store.listByObservation<Row>('attempt','s','now')).toEqual([{id:'attempt',sessionId:'s',observationId:'now'}]);
    }finally{if(f)f.close();else store.close();}
  });
});

it('forwards optional scoped reads through retention and leaves third-party fallback available',()=>{
  const backing=new MemoryStore(),scoped=vi.spyOn(backing,'listByObservation'),retained=new RetainedPersistence(backing);
  try{
    backing.put('action',{id:'a',sessionId:'s',observationId:'o'});
    expect(retained.listByObservation?.('action','s','o')).toEqual([{id:'a',sessionId:'s',observationId:'o'}]);
    expect(scoped).toHaveBeenCalledWith('action','s','o');
    const legacy:Persistence=new MemoryStore();legacy.listByObservation=undefined;
    const wrapper=new RetainedPersistence(legacy);
    try{expect(wrapper.listByObservation).toBeUndefined();}finally{wrapper.close();}
  }finally{retained.close();}
});

it('uses the SQLite index to decode only matching plain action rows',()=>{
  const f=sqliteFixture();
  try{
    f.store.transaction(()=>{for(let i=0;i<1000;i++)f.store.put('action',{id:`a${i}`,sessionId:'s',observationId:i<3?'now':`history-${i}`});});
    const prepare=f.store.db.prepare.bind(f.store.db);let returnedRows=0,query='';
    vi.spyOn(f.store.db,'prepare').mockImplementation((sql:string)=>{
      const statement=prepare(sql);
      if(sql.includes('INDEXED BY entities_action_observation')){
        query=sql;const all=statement.all.bind(statement);
        vi.spyOn(statement,'all').mockImplementation((...params:unknown[])=>{const rows=all(...params);returnedRows+=rows.length;return rows;});
      }
      return statement;
    });
    expect(f.store.listByObservation<Row>('action','s','now').map(row=>row.id)).toEqual(['a0','a1','a2']);
    expect(returnedRows).toBe(3);
    const plan=prepare(`EXPLAIN QUERY PLAN ${query}`).all('s','now','s') as {detail:string}[];
    expect(plan.filter(row=>row.detail.includes('SEARCH entities USING INDEX entities_action_observation'))).toHaveLength(2);
    expect(plan.some(row=>row.detail.startsWith('SCAN entities'))).toBe(false);
  }finally{f.close();}
});

it('reads external updates and deletes immediately without a cached projection',()=>{
  const f=sqliteFixture(),other=new SqliteStore(f.directory);
  try{
    f.store.put('action',{id:'a',sessionId:'s',observationId:'old'});
    expect(f.store.listByObservation('action','s','now')).toEqual([]);
    other.put('action',{id:'a',sessionId:'s',observationId:'now'});
    expect(f.store.listByObservation<Row>('action','s','now').map(row=>row.id)).toEqual(['a']);
    other.db.prepare("UPDATE entities SET json=? WHERE id='a'").run(JSON.stringify({id:'a',sessionId:'s',observationId:'new'}));
    expect(f.store.listByObservation('action','s','now')).toEqual([]);
    expect(f.store.listByObservation<Row>('action','s','new').map(row=>row.id)).toEqual(['a']);
    other.db.prepare("DELETE FROM entities WHERE id='a'").run();
    expect(f.store.listByObservation('action','s','new')).toEqual([]);
  }finally{other.close();f.close();}
});

it('decodes ambiguous duplicate/escaped keys and missing projections before filtering',()=>{
  const f=sqliteFixture();
  try{
    const insert=f.store.db.prepare("INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES('action',?,'s',?,NULL)");
    insert.run('duplicate','{"id":"duplicate","sessionId":"s","observationId":"old","observationId":"now"}');
    insert.run('escaped',String.raw`{"id":"escaped","sessionId":"s","\u006fbservationId":"now"}`);
    insert.run('nested','{"id":"nested","sessionId":"s","value":{"observationId":"now"}}');
    insert.run('unicode-value',String.raw`{"id":"unicode-value","sessionId":"s","observationId":"now","value":"\u4e2d"}`);
    const expected=f.store.list<Row>('action','s').filter(row=>row.observationId==='now');
    expect(f.store.listByObservation<Row>('action','s','now')).toEqual(expected);
    expect(expected.map(row=>row.id)).toEqual(['duplicate','escaped','unicode-value']);
  }finally{f.close();}
});

it.each([
  ['invalid JSON','{',null],
  ['unsupported compressed action','{"id":"bad","observationId":"other","$interactionStorage":{"format":"action","version":99}}',Buffer.from('future')],
] as const)('does not hide %s in another observation',(_reason,json,compressed)=>{
  const f=sqliteFixture();
  try{
    f.store.put('action',{id:'good',sessionId:'s',observationId:'now'});
    f.store.db.prepare("INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES('action','bad','s',?,?)").run(json,compressed);
    expect(()=>f.store.listByObservation('action','s','now')).toThrow('Stored entity content or compression manifest is corrupt');
    expect(()=>f.store.list('action','s')).toThrow('Stored entity content or compression manifest is corrupt');
  }finally{f.close();}
});

it('adds the legacy index without rewriting payloads or silently skipping corrupt rows',()=>{
  const directory=mkdtempSync(join(tmpdir(),'action-query-legacy-')),old=new Database(join(directory,'engine.sqlite'));
  old.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO metadata VALUES('schemaVersion','1');CREATE TABLE entities(kind TEXT NOT NULL,id TEXT PRIMARY KEY,session_id TEXT NOT NULL,json TEXT NOT NULL);");
  old.prepare('INSERT INTO entities VALUES(?,?,?,?)').run('action','a','s','{"id":"a","sessionId":"s","observationId":"now"}');
  old.prepare('INSERT INTO entities VALUES(?,?,?,?)').run('action','broken','s','{');old.close();
  const store=new SqliteStore(directory);
  try{
    expect(store.db.prepare("SELECT json FROM entities WHERE id='broken'").get()).toEqual({json:'{'});
    expect(()=>store.listByObservation('action','s','now')).toThrow('Stored entity content or compression manifest is corrupt');
    store.db.prepare("DELETE FROM entities WHERE id='broken'").run();
    expect(store.listByObservation('action','s','now')).toEqual([{id:'a',sessionId:'s',observationId:'now'}]);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

class FactEngine extends InteractionEngine<CounterObservation> {
  currentFacts(sessionId:string,observationId?:string){return this.captureCurrentFacts(sessionId,observationId);}
  fullAudit(sessionId:string,observationId?:string){return this.captureAudit(sessionId,observationId);}
}

it('keeps current facts identical with indexed and third-party reads, while full audit reads every action',async()=>{
  const backing=new MemoryStore(),engine=new FactEngine({adapter:new CounterAdapter(),persistence:backing});
  try{
    const session=await engine.createSession({}),first=engine.observation(session.id),firstActions=engine.actions(session.id);
    await engine.execute(session.id,firstActions[0].id,'advance');
    const current=engine.observation(session.id),all=engine.store.list<ActionCandidate>('action',session.id),reads=vi.spyOn(engine.store,'list');
    expect(engine.actions(session.id,first.id)).toEqual(firstActions);
    const indexed=engine.currentFacts(session.id,current.id);
    expect(reads.mock.calls.filter(([kind])=>kind==='action')).toHaveLength(0);
    const scoped=engine.store.listByObservation;engine.store.listByObservation=undefined;
    expect(engine.currentFacts(session.id,current.id)).toEqual(indexed);
    expect(engine.actions(session.id,first.id)).toEqual(firstActions);
    engine.store.listByObservation=scoped;reads.mockClear();
    const audit=engine.fullAudit(session.id,current.id);
    expect(audit.material.allActions).toEqual(all);expect(audit.material.allActions.length).toBeGreaterThan(indexed.snapshot.actions.length);
    expect(reads.mock.calls.filter(([kind])=>kind==='action')).toHaveLength(1);
    const {frontier:_frontier,explorationAudit:_audit,...currentFromAudit}=audit.snapshot;
    expect(currentFromAudit).toEqual(indexed.snapshot);
    expect(()=>engine.currentFacts(session.id,first.id)).toThrow('Audit requires the current observation');
    const attempt=engine.list<ActionAttempt>(session.id,'attempt')[0];engine.store.put('attempt',{...attempt,status:'unknown'});
    const unknown=engine.currentFacts(session.id,current.id).snapshot;
    expect(unknown.unknownAttempts.map(a=>a.id)).toEqual([attempt.id]);
    expect(unknown.availability.actions.every(a=>!a.executable)).toBe(true);
    const action=engine.actions(session.id)[0];engine.store.put('action',{...action,excluded:true,exclusionReason:'test_revocation'});
    expect(engine.actions(session.id)[0].excluded).toBe(true);
    expect(engine.currentFacts(session.id).snapshot.actions[0].exclusionReason).toBe('test_revocation');
  }finally{await engine.close();}
});
