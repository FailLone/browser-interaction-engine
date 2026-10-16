import { expect,it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore,decodeStoredEntity,type StoredEntityRow } from '@interaction/storage-sqlite';
const makeDirectory=()=>mkdtempSync(join(tmpdir(),'sqlite-observation-compression-'));
const observation=(id:string,sessionId='s')=>({id,sessionId,url:'https://example.test/',capturedAt:'2026-10-16T00:00:00Z',controls:Array.from({length:300},(_,i)=>({localId:`c-${i}`,name:'价格 € 中文',evidence:'captured immutable facts '.repeat(60)}))});
function legacy(directory:string,values:unknown[]) {
 const db=new DatabaseSync(join(directory,'engine.sqlite'));
 db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO metadata VALUES('schemaVersion','1');CREATE TABLE entities(kind TEXT NOT NULL,id TEXT PRIMARY KEY,session_id TEXT NOT NULL,json TEXT NOT NULL)");
 for(const value of values as {id:string;sessionId:string}[])db.prepare('INSERT INTO entities VALUES(?,?,?,?)').run('observation',value.id,value.sessionId,JSON.stringify(value));db.close();
}
const raw=(store:SqliteStore,id:string)=>store.db.prepare('SELECT json,compressed_json FROM entities WHERE id=?').get(id) as StoredEntityRow;

it('transparently compresses observations, preserves read isolation and immutability, and leaves other entity kinds readable as JSON',()=>{
 const directory=makeDirectory(),store=new SqliteStore(directory),value=observation('o');
 try{
  store.put('observation',value);const row=raw(store,'o');expect(row.compressed_json?.byteLength).toBeLessThan(Buffer.byteLength(JSON.stringify(value))/10);
  expect(JSON.parse(row.json)).toMatchObject({id:'o',sessionId:'s',url:value.url,$interactionStorage:{format:'observation',version:2,codec:'structural'}});
  expect(store.require('observation','o')).toEqual(value);expect(store.decodeStoredEntity(row)).toEqual(value);
  const read=store.require<typeof value>('observation','o');read.controls[0].name='changed';expect(store.require<typeof value>('observation','o').controls[0].name).toBe('价格 € 中文');
  store.put('observation',{...value,controls:[...value.controls]});expect(raw(store,'o').json).toBe(row.json);
  expect(()=>store.put('observation',{...value,url:'https://changed.test/'})).toThrow('Observations cannot be overwritten');
  const business={id:'business',$interactionStorage:{format:'observation',meaning:'ordinary application data'}};store.put('custom',business);expect(store.require('custom','business')).toEqual(business);
  store.put('capture',{...value,id:'capture'});expect(raw(store,'capture').compressed_json).toBeNull();expect(JSON.parse(raw(store,'capture').json).controls).toEqual(value.controls);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

it('upgrades only the schema on opening v1 and reads mixed legacy/compressed observations across restart in original order',()=>{
 const directory=makeDirectory(),old=observation('old'),fresh=observation('fresh');legacy(directory,[old]);let store=new SqliteStore(directory);
 try{
  expect(raw(store,'old').compressed_json).toBeNull();expect(JSON.parse(raw(store,'old').json)).toEqual(old);
  expect(store.db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get()).toEqual({value:'4'});
  store.put('observation',fresh);store.close();store=new SqliteStore(directory);
  expect(store.list('observation','s')).toEqual([old,fresh]);expect(store.list('observation','other')).toEqual([]);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

it('rolls back compressed blobs, entity manifests, requests and events as one transaction',()=>{
 const directory=makeDirectory(),store=new SqliteStore(directory);
 try{
  expect(()=>store.transaction(()=>{store.put('observation',observation('o'));store.recordRequest('s','request','attempt','{}');store.event('s','test',{});throw Error('rollback');})).toThrow('rollback');
  expect(store.get('observation','o')).toBeUndefined();expect(store.request('s','request')).toBeUndefined();expect(store.events('s')).toEqual([]);
  expect(()=>store.transaction(()=>store.compact())).toThrow('Compaction cannot run within a transaction');
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

it('migrates bounded cursor batches without changing content or unrelated sessions and reclaims physical pages only on explicit compaction',()=>{
 const directory=makeDirectory(),values=[observation('a1','a'),observation('b1','b'),observation('a2','a'),{id:'small',sessionId:'a',value:1}];legacy(directory,values);const before=statSync(join(directory,'engine.sqlite')).size;const store=new SqliteStore(directory);
 try{
  const first=store.compressObservations({sessionId:'a',limit:1});expect(first).toMatchObject({scanned:1,compressed:1,done:false});expect(first.logicalBytesAfter).toBe(first.logicalBytesBefore);expect(first.storageBytesAfter).toBeLessThan(first.storageBytesBefore/10);
  const second=store.compressObservations({sessionId:'a',limit:1,cursor:first.cursor});expect(second).toMatchObject({scanned:1,compressed:1,done:false});
  const third=store.compressObservations({sessionId:'a',limit:1,cursor:second.cursor});expect(third).toMatchObject({scanned:1,compressed:0,done:true});expect(third.storageBytesAfter).toBe(third.storageBytesBefore);
  expect(raw(store,'b1').compressed_json).toBeNull();expect(store.list('observation')).toEqual(values);
  expect(store.compressObservations({sessionId:'a',cursor:third.cursor})).toMatchObject({scanned:0,compressed:0,done:true});
  store.compressObservations({sessionId:'b'});const result=store.compact();expect(result.databaseBytesAfter).toBeLessThan(before/5);expect(result.walBytesAfter).toBe(0);expect(store.list('observation')).toEqual(values);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

it('fails and rolls back the entire migration batch when a legacy row is damaged',()=>{
 const directory=makeDirectory();legacy(directory,[observation('first'),observation('broken')]);const store=new SqliteStore(directory);
 try{
  store.db.prepare('UPDATE entities SET json=? WHERE id=?').run('{invalid','broken');
  expect(()=>store.compressObservations()).toThrow('Stored entity content or compression manifest is corrupt');expect(raw(store,'first').compressed_json).toBeNull();
  expect(()=>store.list('observation')).toThrow('Stored entity content or compression manifest is corrupt');
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

it.each(['blob','hash','length','metadata','missing-blob','unknown-codec'] as const)('reports %s corruption instead of silently returning an incomplete observation',mode=>{
 const directory=makeDirectory(),store=new SqliteStore(directory);
 try{
  store.put('observation',observation('o'));const row=raw(store,'o'),manifest=JSON.parse(row.json);let blob=row.compressed_json;
  if(mode==='blob')blob=Buffer.from('broken gzip');
  if(mode==='hash')manifest.$interactionStorage.sha256='0'.repeat(64);
  if(mode==='length')manifest.$interactionStorage.bytes--;
  if(mode==='metadata')manifest.url='https://wrong.test/';
  if(mode==='missing-blob')blob=null;
  if(mode==='unknown-codec')manifest.$interactionStorage.codec='future';
  store.db.prepare('UPDATE entities SET json=?,compressed_json=? WHERE id=?').run(JSON.stringify(manifest),blob,'o');
  expect(()=>store.require('observation','o')).toThrow('Stored entity content or compression manifest is corrupt');expect(()=>store.list('observation')).toThrow('Stored entity content or compression manifest is corrupt');expect(()=>store.put('observation',observation('o'))).toThrow('Stored entity content or compression manifest is corrupt');
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

it('rejects unknown database formats and invalid migration bounds without rewriting records',()=>{
 const directory=makeDirectory();let store=new SqliteStore(directory);
 try{
  expect(()=>store.compressObservations({cursor:-1})).toThrow('Use a nonnegative cursor');expect(()=>store.compressObservations({limit:0})).toThrow('Use a nonnegative cursor');
  store.db.prepare("UPDATE metadata SET value='99' WHERE key='schemaVersion'").run();store.close();expect(()=>new SqliteStore(directory)).toThrow('Unsupported database schema 99');
 }finally{if(store.db.open)store.close();rmSync(directory,{recursive:true,force:true});}
});
