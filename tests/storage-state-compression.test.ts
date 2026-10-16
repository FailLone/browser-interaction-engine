import { expect,it } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gzipSync,gunzipSync } from 'node:zlib';
import { SqliteStore,decodeStoredEntity,type StoredEntityRow } from '@interaction/storage-sqlite';
import { encodeObservationJson,entityDigest } from '../packages/storage-sqlite/src/entity-codec.js';

const state=(id='state',sessionId='session')=>({id,sessionId,canonical:'{"number":"000.1200","unicode":"价格 € 🧭"}\r\n'.repeat(1400),grouping:{canonical:'projection\n'.repeat(300),observationCount:1},observationIds:['o'],nested:{z:'000.10',a:[null,true,1.25,'1e+4']}});
type State=ReturnType<typeof state>;
const raw=(store:SqliteStore,id='state')=>store.db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE id=?').get(id) as StoredEntityRow;
function withStore(fn:(store:SqliteStore,directory:string)=>void){const directory=mkdtempSync(join(tmpdir(),'state-compression-')),store=new SqliteStore(directory);try{fn(store,directory);}finally{if(store.db.open)store.close();rmSync(directory,{recursive:true,force:true});}}

it('stores a complete large state in one gzip3 row, keeps exact serialization, and returns detached mutable values',()=>withStore(store=>{
  const value=state(),json=JSON.stringify(value);store.put('state',value);const row=raw(store);
  expect(JSON.parse(row.json)).toMatchObject({id:value.id,sessionId:value.sessionId,$interactionStorage:{format:'state',version:1,codec:'gzip',bytes:Buffer.byteLength(json),sha256:entityDigest(Buffer.from(json))}});
  expect(gunzipSync(row.compressed_json!).toString()).toBe(json);
  expect(Buffer.from(row.compressed_json!)).toEqual(gzipSync(Buffer.from(json),{level:3}));
  expect(decodeStoredEntity(row)).toEqual(value);expect(store.decodeStoredEntity(row)).toEqual(value);
  expect(store.db.prepare('SELECT count(*) AS n FROM observation_objects').get()).toEqual({n:0});
  expect(store.db.prepare('SELECT count(*) AS n FROM observation_packs').get()).toEqual({n:0});
  const read=store.require<State>('state',value.id);read.observationIds.push('not persisted');read.grouping.observationCount=99;
  expect(JSON.stringify(store.require('state',value.id))).toBe(json);expect(store.list('state','session')).toEqual([value]);
}));

it('keeps small states plain and preserves high-entropy values and unrelated kinds',()=>withStore(store=>{
  const small={id:'small',sessionId:'session',value:'unchanged'},noise={id:'noise',sessionId:'session',value:randomBytes(48_000).toString('latin1')};
  // Exercise actual high-entropy content without asserting a random size ratio.
  noise.value=Array.from(randomBytes(90_000),byte=>String.fromCharCode(32+byte%95)).join('');
  store.put('state',small);expect(raw(store,'small').compressed_json).toBeNull();
  store.put('custom',{...state(),id:'custom'});expect(raw(store,'custom').compressed_json).toBeNull();
  store.put('state',noise);expect(store.require('state','noise')).toEqual(noise);
  // Small reserved markers are encoded too, avoiding ambiguity with manifests.
  const reserved={id:'reserved',sessionId:'session',$interactionStorage:{format:'state',meaning:'business data'}};
  store.put('state',reserved);expect(raw(store,'reserved').compressed_json).not.toBeNull();expect(store.require('state','reserved')).toEqual(reserved);
  const custom={id:'marker',$interactionStorage:{format:'state',meaning:'ordinary custom data'}};store.put('custom',custom);expect(store.require('custom','marker')).toEqual(custom);
}));

it('keeps mutable same-owner overwrites and plain/compressed transitions atomic without changing row order or owner',()=>withStore(store=>{
  const first=state();store.put('state',first);store.put('state',{id:'second',sessionId:'session'});
  const next={...first,observationIds:['o','later'],grouping:{...first.grouping,observationCount:2}};store.put('state',next);
  expect(store.require('state',first.id)).toEqual(next);expect(store.list<{id:string}>('state').map(value=>value.id)).toEqual(['state','second']);
  expect(()=>store.put('state',{...first,sessionId:'other'})).toThrow('ID already belongs');expect(()=>store.put('identity',first)).toThrow('ID already belongs');
  store.put('state',{id:first.id,sessionId:first.sessionId,value:'small now'});expect(raw(store).compressed_json).toBeNull();
  store.put('state',next);expect(store.require('state',first.id)).toEqual(next);expect(raw(store).compressed_json).not.toBeNull();
  const before=raw(store);store.db.exec("CREATE TRIGGER fail_state BEFORE UPDATE ON entities WHEN NEW.kind='state' BEGIN SELECT RAISE(ABORT,'reject state update'); END;");
  expect(()=>store.put('state',{...next,observationIds:['rejected']})).toThrow('reject state update');expect(raw(store)).toEqual(before);expect(store.require('state',first.id)).toEqual(next);
}));

it.each(['1','2','3'] as const)('reads schema%s plain states and all historical observation codecs without a startup rewrite',version=>withStore((store,directory)=>{
  const value=state(),legacyObservation={...state('old-observation'),controls:[]},gzipObservation={...legacyObservation,id:'gzip-observation'},sharedObservation={...legacyObservation,id:'shared-observation',controls:[{name:'control facts '.repeat(300)}]};
  store.db.prepare('INSERT INTO entities(kind,id,session_id,json) VALUES(?,?,?,?)').run('state',value.id,value.sessionId,JSON.stringify(value));
  store.db.prepare('INSERT INTO entities(kind,id,session_id,json) VALUES(?,?,?,?)').run('observation',legacyObservation.id,legacyObservation.sessionId,JSON.stringify(legacyObservation));
  const expectedObservations:unknown[]=[legacyObservation];
  if(version!=='1'){const gzip=encodeObservationJson(JSON.stringify(gzipObservation));store.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?)').run('observation',gzipObservation.id,gzipObservation.sessionId,gzip.json,gzip.compressed_json);expectedObservations.push(gzipObservation);}
  if(version==='3'){store.put('observation',sharedObservation);expectedObservations.push(sharedObservation);}else store.db.exec('DROP TABLE observation_objects;DROP TABLE observation_packs;');
  if(version==='1')store.db.exec('ALTER TABLE entities DROP COLUMN compressed_json');
  store.db.prepare("UPDATE metadata SET value=? WHERE key='schemaVersion'").run(version);
  const before=store.db.prepare(`SELECT kind,id,session_id,json,${version==='1'?'NULL AS compressed_json':'compressed_json'} FROM entities ORDER BY rowid`).all();store.close();
  const reopened=new SqliteStore(directory);try{
    expect(reopened.db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get()).toEqual({value:'4'});
    expect(reopened.db.prepare('SELECT * FROM entities ORDER BY rowid').all()).toEqual(before);
    expect(reopened.require('state',value.id)).toEqual(value);expect(reopened.list('observation')).toEqual(expectedObservations);
    reopened.put('state',{...value,observationIds:['new']});expect(raw(reopened).compressed_json).not.toBeNull();
  }finally{reopened.close();}
}));

it.each(['kind','id','session','version','codec','hash','size','blob','missing-blob','body-id','body-session'] as const)('explicitly rejects compressed state %s corruption',mode=>withStore(store=>{
  store.put('state',state());const row=raw(store),manifest=JSON.parse(row.json);let blob=row.compressed_json;
  if(mode==='kind')manifest.$interactionStorage.format='observation';
  if(mode==='id')manifest.id='wrong';if(mode==='session')manifest.sessionId='wrong';
  if(mode==='version')manifest.$interactionStorage.version=99;if(mode==='codec')manifest.$interactionStorage.codec='zstd';
  if(mode==='hash')manifest.$interactionStorage.sha256='0'.repeat(64);if(mode==='size')manifest.$interactionStorage.bytes--;
  if(mode==='blob')blob=Buffer.from('damaged');if(mode==='missing-blob')blob=null;
  if(mode==='body-id'||mode==='body-session'){const value=state();if(mode==='body-id')value.id='wrong';else value.sessionId='wrong';const body=Buffer.from(JSON.stringify(value));blob=gzipSync(body);manifest.$interactionStorage.bytes=body.length;manifest.$interactionStorage.sha256=entityDigest(body);}
  store.db.prepare('UPDATE entities SET json=?,compressed_json=? WHERE id=?').run(JSON.stringify(manifest),blob,'state');
  expect(()=>store.require('state','state')).toThrow('Stored entity content or compression manifest is corrupt');expect(()=>store.list('state')).toThrow('Stored entity content or compression manifest is corrupt');
}));

it('requires full SQL owner context for state envelopes and rejects transplanting a valid BLOB or row across owners',()=>withStore(store=>{
  store.put('state',state());const row=raw(store);
  for(const key of ['kind','id','session_id'] as const){const incomplete={...row};delete incomplete[key];expect(()=>decodeStoredEntity(incomplete)).toThrow('corrupt');expect(()=>decodeStoredEntity({...row,[key]:'wrong'})).toThrow('corrupt');}
  store.put('state',state('other','other-session'));const other=raw(store,'other');
  store.db.prepare('UPDATE entities SET compressed_json=? WHERE id=?').run(other.compressed_json,'state');expect(()=>store.require('state','state')).toThrow('corrupt');
}));

it('restores prior state after wrapped, nested and raw SQL rollbacks and never serves speculative reads',()=>withStore(store=>{
  const original=state(),next={...original,observationIds:['speculative']};store.put('state',original);
  for(const transact of [<T>(fn:()=>T)=>store.transaction(fn),<T>(fn:()=>T)=>store.db.transaction(fn)()]){
    expect(()=>transact(()=>{store.put('state',next);expect(store.require('state','state')).toEqual(next);throw Error('rollback');})).toThrow('rollback');
    expect(store.require('state','state')).toEqual(original);
  }
  store.transaction(()=>{store.put('state',next);expect(()=>store.transaction(()=>{store.put('state',{...next,observationIds:['nested']});expect(store.list('state')).toEqual([{...next,observationIds:['nested']}]);throw Error('nested');})).toThrow('nested');expect(store.require('state','state')).toEqual(next);});
  expect(store.require('state','state')).toEqual(next);
}));

it('honors raw SQL and another connection changes while preserving an active SQLite read snapshot',()=>withStore((store,directory)=>{
  const original=state(),next={...original,observationIds:['external']};store.put('state',original);expect(store.require('state','state')).toEqual(original);
  const other=new SqliteStore(directory);try{
    store.db.transaction(()=>{expect(store.require('state','state')).toEqual(original);other.put('state',next);expect(store.require('state','state')).toEqual(original);})();
    expect(store.require('state','state')).toEqual(next);
    other.db.prepare('UPDATE entities SET compressed_json=NULL,json=? WHERE id=?').run(JSON.stringify(original),'state');expect(store.list('state')).toEqual([original]);
    other.put('state',next);expect(store.require('state','state')).toEqual(next);other.db.prepare('DELETE FROM entities WHERE id=?').run('state');expect(store.get('state','state')).toBeUndefined();
  }finally{other.close();}
}));

it('does not turn its own state compression into an external-write invalidation or hide raw writes',()=>withStore(store=>{
  const before=store.entityChanges('attempt','session');store.put('state',state());store.put('attempt',{id:'a',sessionId:'session'});
  const after=store.entityChanges('attempt','session',before.token);expect(after).toMatchObject({reset:false,ids:['a']});
  store.db.prepare('DELETE FROM entities WHERE id=?').run('a');store.put('state',{...state(),observationIds:['later']});expect(store.entityChanges('attempt','session',after.token).reset).toBe(true);
}));

it('migrates plain states in resumable session-scoped batches and leaves original values intact across reopen',()=>withStore((store,directory)=>{
  const values=[state('a1','a'),state('b1','b'),state('a2','a'),{id:'tiny',sessionId:'a'}];
  for(const value of values)store.db.prepare('INSERT INTO entities(kind,id,session_id,json) VALUES(?,?,?,?)').run('state',value.id,value.sessionId,JSON.stringify(value));
  const first=store.compressStates({sessionId:'a',limit:1});expect(first).toMatchObject({scanned:1,compressed:1,done:false});expect(first.logicalBytesAfter).toBe(first.logicalBytesBefore);expect(first.storageBytesAfter).toBeLessThan(first.storageBytesBefore/5);
  const second=store.compressStates({sessionId:'a',limit:1,cursor:first.cursor});expect(second).toMatchObject({scanned:1,compressed:1,done:false});
  const third=store.compressStates({sessionId:'a',limit:1,cursor:second.cursor});expect(third).toMatchObject({scanned:1,compressed:0,done:true});expect(raw(store,'b1').compressed_json).toBeNull();
  expect(store.compressStates({sessionId:'a',cursor:third.cursor})).toMatchObject({scanned:0,compressed:0,done:true});expect(store.list('state')).toEqual(values);
  expect(()=>store.compressStates({limit:0})).toThrow('Use a nonnegative cursor');expect(()=>store.compressStates({cursor:-1})).toThrow('Use a nonnegative cursor');
  store.close();const reopened=new SqliteStore(directory);try{expect(reopened.list('state')).toEqual(values);}finally{reopened.close();}
}));

it('rolls back the entire state migration on corrupt data or a later write failure',()=>withStore(store=>{
  for(const value of [state('first'),state('last')])store.db.prepare('INSERT INTO entities(kind,id,session_id,json) VALUES(?,?,?,?)').run('state',value.id,value.sessionId,JSON.stringify(value));
  const before=raw(store,'first');store.db.prepare('UPDATE entities SET json=? WHERE id=?').run('{broken','last');
  expect(()=>store.compressStates()).toThrow('corrupt');expect(raw(store,'first')).toEqual(before);
  store.db.prepare('UPDATE entities SET json=? WHERE id=?').run(JSON.stringify(state('last')),'last');
  store.db.exec("CREATE TRIGGER fail_last BEFORE UPDATE ON entities WHEN NEW.id='last' BEGIN SELECT RAISE(ABORT,'migration write rejected'); END;");
  expect(()=>store.compressStates()).toThrow('migration write rejected');expect(raw(store,'first')).toEqual(before);expect(raw(store,'last').compressed_json).toBeNull();
}));
