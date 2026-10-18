import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { SqliteStore, decodeStoredEntity, type StoredEntityRow } from '@interaction/storage-sqlite';
import { encodeObservationJson, entityDigest, sharedObservationLayout } from '../packages/storage-sqlite/src/entity-codec.js';

const directory = () => mkdtempSync(join(tmpdir(), 'observation-sharing-'));
const observation = (id:string, sessionId='s') => ({ id, sessionId, capturedAt:'2026-10-17T00:00:00Z', url:'https://example.test/',
  controls:Array.from({length:100},(_,i)=>({localId:`c${i}`,identityId:`identity-${i}`,name:i<2?'Amount':`Market ${i}`,occurrence:i<2?['A','B'][i]:`${i}`,value:i===0?'001.00':i===1?1:1000+i,attributes:{role:'textbox',placeholder:'价格 € 中文',description:'immutable capture '.repeat(10)}})),
  regions:[{key:'header',label:'Header',role:'banner'},{key:'main',label:'Main',role:'main'}],
  dom:{tag:'main',children:Array.from({length:100},(_,i)=>({tag:'div',id:`dom-${i}`,attributes:{'data-key':`${i}`},children:[{text:`Subtree ${i}`,content:'Exact DOM words '.repeat(30)}]}))},
  context:{business:{$interactionStorage:{format:'observation'},parts:[1,'1',null,true]},escape:'"\\\n😀\ud800',number:1e-7}
});
const row = (store:SqliteStore,id:string) => store.db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE id=?').get(id) as StoredEntityRow;
const ids = (store:SqliteStore,id:string) => sharedObservationLayout(row(store,id))!.layout.filter((piece):piece is number=>typeof piece==='number');
const withStore = (fn:(store:SqliteStore,directory:string)=>void) => { const path=directory(),store=new SqliteStore(path);try{fn(store,path);}finally{if(store.db.open)store.close();rmSync(path,{recursive:true,force:true});} };

it('shares complete controls, regions and DOM subtrees; one changed control adds exactly one object',()=>withStore(store=>{
  const first=observation('first'),second=structuredClone(first);second.id='second';second.capturedAt='2026-10-17T00:00:01Z';second.controls[0].value='999.000';
  store.put('observation',first);const before=store.observationStorageStats(),old=new Set(ids(store,'first'));
  store.put('observation',second);const after=store.observationStorageStats(),fresh=ids(store,'second');
  expect(after.objects-before.objects).toBe(1);expect(fresh.filter(id=>!old.has(id))).toHaveLength(1);
  expect(after.packs).toBeLessThan(after.objects/10);expect(after.referencedObjects).toBe(after.objects);
  expect(store.require('observation','first')).toEqual(first);expect(store.require('observation','second')).toEqual(second);
  expect(JSON.stringify(store.require('observation','second'))).toBe(JSON.stringify(second));
  expect(()=>decodeStoredEntity(row(store,'first'))).toThrow(expect.objectContaining({code:'CORRUPT_ENTITY'}));
  expect(store.decodeStoredEntity(row(store,'first'))).toEqual(first);
}));

it('preserves repeated occurrence identity, member/key order, strings versus numbers and read isolation across restart',()=>withStore((store,path)=>{
  const first=observation('first'),second=structuredClone(first);second.id='second';second.controls.reverse();second.regions.reverse();
  first.controls.push(structuredClone(first.controls[0]));store.put('observation',first);store.put('observation',second);
  const read=store.require<typeof first>('observation','first');read.controls[0].attributes.description='mutated';expect(read.controls.at(-1)!.attributes.description).toBe(first.controls[0].attributes.description);
  store.close();const reopened=new SqliteStore(path);try{expect(reopened.list('observation','s')).toEqual([first,second]);expect(JSON.stringify(reopened.get('observation','first'))).toBe(JSON.stringify(first));}finally{reopened.close();}
}));

it('reads plain and old gzip observations alongside shared observations without migrating on open',()=>withStore((store,path)=>{
  const plain=observation('plain'),gzip=observation('gzip'),shared=observation('shared'),packed=encodeObservationJson(JSON.stringify(gzip));
  const insert=store.db.prepare('INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES(?,?,?,?,?)');insert.run('observation','plain','s',JSON.stringify(plain),null);insert.run('observation','gzip','s',packed.json,packed.compressed_json);store.put('observation',shared);
  expect(decodeStoredEntity(row(store,'gzip'))).toEqual(gzip);store.close();const reopened=new SqliteStore(path);try{expect(reopened.list('observation')).toEqual([plain,gzip,shared]);expect(row(reopened,'plain').compressed_json).toBeNull();expect(JSON.parse(row(reopened,'gzip').json).$interactionStorage.version).toBe(1);}finally{reopened.close();}
}));

it('rolls back objects, packs and manifests on nested failure and on failed entity insertion',()=>withStore(store=>{
  const empty=store.observationStorageStats();
  expect(()=>store.transaction(()=>{store.put('observation',observation('one'));store.transaction(()=>{store.put('observation',observation('two'));throw Error('rollback');});})).toThrow('rollback');expect(store.observationStorageStats()).toEqual(empty);
  store.db.exec("CREATE TRIGGER reject_observation BEFORE INSERT ON entities WHEN NEW.kind='observation' BEGIN SELECT RAISE(ABORT,'reject manifest'); END;");
  expect(()=>store.put('observation',observation('fail'))).toThrow('reject manifest');expect(store.observationStorageStats()).toEqual(empty);
  store.db.exec('DROP TRIGGER reject_observation');store.put('observation',observation('after'));expect(store.require('observation','after')).toEqual(observation('after'));
}));

it.each(['pack','object-hash','missing-object','missing-pack','offset','codec','layout','layout-length','root-owner','root-session'] as const)('fails explicitly on %s corruption on reads, reuse and GC, without partially collecting',mode=>withStore(store=>{
  store.put('observation',observation('live'));store.put('observation',observation('dead','other'));store.db.prepare('DELETE FROM entities WHERE id=?').run('dead');
  const target=ids(store,'live')[0],object=store.db.prepare('SELECT * FROM observation_objects WHERE id=?').get(target) as {pack_id:number};
  if(mode==='pack')store.db.prepare('UPDATE observation_packs SET data=? WHERE id=?').run(Buffer.from('broken'),object.pack_id);
  if(mode==='object-hash')store.db.prepare('UPDATE observation_objects SET sha256=? WHERE id=?').run(Buffer.alloc(32),target);
  if(mode==='missing-object')store.db.prepare('DELETE FROM observation_objects WHERE id=?').run(target);
  if(mode==='missing-pack'){store.db.pragma('foreign_keys=OFF');store.db.prepare('DELETE FROM observation_packs WHERE id=?').run(object.pack_id);store.db.pragma('foreign_keys=ON');}
  if(mode==='offset')store.db.prepare('UPDATE observation_objects SET byte_offset=99999999 WHERE id=?').run(target);
  if(mode==='codec'){store.db.pragma('ignore_check_constraints=ON');store.db.prepare("UPDATE observation_packs SET codec='future' WHERE id=?").run(object.pack_id);}
  if(['layout','layout-length','root-owner','root-session'].includes(mode)) {
    const stored=row(store,'live'),manifest=JSON.parse(stored.json);let blob=stored.compressed_json;
    if(mode==='layout')blob=Buffer.from('corrupt layout');if(mode==='layout-length')manifest.$interactionStorage.layoutBytes--;if(mode==='root-owner')manifest.id='wrong';if(mode==='root-session')manifest.$interactionStorage.sessionId='other';
    store.db.prepare('UPDATE entities SET json=?,compressed_json=? WHERE id=?').run(JSON.stringify(manifest),blob,'live');
  }
  const counts=()=>store.db.prepare('SELECT (SELECT count(*) FROM observation_objects) AS objects,(SELECT count(*) FROM observation_packs) AS packs').get(),before=counts();
  expect(()=>store.get('observation','live')).toThrow(expect.objectContaining({code:'CORRUPT_ENTITY'}));expect(()=>store.list('observation')).toThrow(expect.objectContaining({code:'CORRUPT_ENTITY'}));expect(()=>store.put('observation',observation('live'))).toThrow(expect.objectContaining({code:'CORRUPT_ENTITY'}));
  expect(()=>store.garbageCollectObservations({repack:true})).toThrow(expect.objectContaining({code:'CORRUPT_ENTITY'}));expect(counts()).toEqual(before);
}));

it('rejects a valid same-content object reference from another session',()=>withStore(store=>{
  store.put('observation',observation('a','a'));store.put('observation',observation('b','b'));
  const stored=row(store,'a'),shared=sharedObservationLayout(stored)!,other=ids(store,'b');let index=0;
  shared.layout=shared.layout.map(piece=>typeof piece==='number'?other[index++]:piece);
  const data=Buffer.from(JSON.stringify(shared.layout));shared.manifest.$interactionStorage.layoutBytes=data.length;shared.manifest.$interactionStorage.layoutSha256=entityDigest(data);
  store.db.prepare('UPDATE entities SET json=?,compressed_json=? WHERE id=?').run(JSON.stringify(shared.manifest),gzipSync(data),'a');
  expect(()=>store.get('observation','a')).toThrow(expect.objectContaining({code:'CORRUPT_ENTITY'}));expect(store.require('observation','b')).toEqual(observation('b','b'));
}));

it('collects by actual roots and optionally repacks mixed packs without changing surviving references',()=>withStore(store=>{
  const a=observation('a'),b=observation('b');b.controls=b.controls.slice(1);store.put('observation',a);store.put('observation',b);store.put('observation',observation('other','other'));
  const survivor=ids(store,'b');store.db.prepare('DELETE FROM entities WHERE id=?').run('a');
  const first=store.garbageCollectObservations({sessionId:'s'});expect(first.deletedObjects).toBe(1);expect(first.after.fragmentedBytes).toBeGreaterThan(0);expect(store.get('observation','b')).toEqual(b);expect(ids(store,'b')).toEqual(survivor);
  const second=store.garbageCollectObservations({sessionId:'s',repack:true});expect(second.repackedPacks).toBeGreaterThan(0);expect(second.after.fragmentedBytes).toBe(0);expect(ids(store,'b')).toEqual(survivor);expect(store.get('observation','b')).toEqual(b);expect(store.get('observation','other')).toEqual(observation('other','other'));
  store.db.prepare('DELETE FROM entities WHERE session_id=?').run('s');expect(store.garbageCollectObservations({sessionId:'s',repack:true}).after).toMatchObject({objects:0,packs:0});
  store.put('observation',a);expect(Math.min(...ids(store,'a'))).toBeGreaterThan(Math.max(...survivor));expect(store.get('observation','a')).toEqual(a);
}));

it('rolls back collection/repacking on interruption and serializes writers from another connection',()=>withStore((store,path)=>{
  store.put('observation',observation('a'));const b=observation('b');b.controls=b.controls.slice(1);store.put('observation',b);store.db.prepare('DELETE FROM entities WHERE id=?').run('a');const before=store.observationStorageStats();
  expect(()=>store.transaction(()=>{store.garbageCollectObservations({repack:true});throw Error('interrupted');})).toThrow('interrupted');expect(store.observationStorageStats()).toEqual(before);expect(store.get('observation','b')).toEqual(b);
  const other=new SqliteStore(path);other.db.pragma('busy_timeout=1');try{
    store.db.transaction(()=>{store.garbageCollectObservations({repack:true});expect(()=>other.put('observation',observation('concurrent'))).toThrow('database is locked');}).immediate();
    other.put('observation',observation('concurrent'));store.garbageCollectObservations({repack:true});expect(store.get('observation','concurrent')).toEqual(observation('concurrent'));
    other.db.prepare('UPDATE observation_packs SET data=? WHERE id=(SELECT min(id) FROM observation_packs)').run(Buffer.from('external damage'));expect(()=>store.get('observation','b')).toThrow(expect.objectContaining({code:'CORRUPT_ENTITY'}));
  }finally{other.close();}
}));

it('keeps shared observation writes incremental in the entity-change feed',()=>withStore(store=>{
  const initial=store.entityChanges('observation','s');store.put('observation',observation('a'));const first=store.entityChanges('observation','s',initial.token);
  expect(first).toMatchObject({reset:false,ids:['a']});store.put('observation',observation('b'));expect(store.entityChanges('observation','s',first.token)).toMatchObject({reset:false,ids:['b']});
}));

it('falls back for novelty and admits a changed stable regime on its next frame',()=>withStore(store=>{
  const first=observation('first');store.put('observation',first);
  const changed={...observation('changed'),controls:first.controls.map(control=>({...control,name:`new ${control.name}`,attributes:{...control.attributes,description:'new dynamic observations '.repeat(15)}}))};
  store.put('observation',changed);expect(JSON.parse(row(store,'changed').json).$interactionStorage).toMatchObject({version:1,codec:'gzip'});
  const stable={...changed,id:'stable'};store.put('observation',stable);expect(JSON.parse(row(store,'stable').json).$interactionStorage).toMatchObject({version:2,codec:'structural'});
  const before=store.observationStorageStats();store.put('observation',{...stable,id:'stable-again'});expect(store.observationStorageStats().objects).toBe(before.objects);
  expect(store.list('observation')).toEqual([first,changed,stable,{...stable,id:'stable-again'}]);
}));

it('invalidates verified caches after raw transactions, unknown writes followed by known writes, and schema changes',()=>withStore(store=>{
  const first=observation('first');store.put('observation',first);expect(store.observationCacheStats().decodedEntries).toBeGreaterThan(0);
  store.db.exec('BEGIN IMMEDIATE');store.put('observation',observation('rolled-back'));expect(store.get('observation','rolled-back')).toEqual(observation('rolled-back'));store.db.exec('ROLLBACK');
  expect(store.get('observation','rolled-back')).toBeUndefined();store.put('observation',observation('committed'));expect(store.get('observation','committed')).toEqual(observation('committed'));
  store.db.exec('CREATE TABLE unknown_schema_change(value TEXT)');expect(store.get('observation','first')).toEqual(first);
  store.db.exec('BEGIN IMMEDIATE');store.db.prepare('UPDATE observation_packs SET data=?').run(Buffer.from('bad'));expect(()=>store.get('observation','first')).toThrow(expect.objectContaining({code:'CORRUPT_ENTITY'}));store.db.exec('ROLLBACK');expect(store.get('observation','first')).toEqual(first);
  store.db.prepare('UPDATE observation_packs SET data=?').run(Buffer.from('bad'));store.event('s','known-write',{});expect(()=>store.get('observation','first')).toThrow(expect.objectContaining({code:'CORRUPT_ENTITY'}));
}));

it('bounds content/address/admission caches independently of observation history',()=>withStore(store=>{
  for(let frame=0;frame<8;frame++) {
    const value={...observation(`frame-${frame}`,`session-${frame}`),controls:Array.from({length:300},(_,i)=>({localId:`${frame}-${i}`,name:`control ${i}`,value:`${frame}`,detail:'bounded bytes '.repeat(350)}))};
    store.put('observation',value);expect(store.get('observation',value.id)).toEqual(value);
    const cache=store.observationCacheStats();expect(cache.fragmentEntries).toBeLessThanOrEqual(2048);expect(cache.fragmentBytes).toBeLessThanOrEqual(8*1024*1024);expect(cache.addressEntries).toBeLessThanOrEqual(4096);expect(cache.decodedEntries).toBeLessThanOrEqual(4096);expect(cache.decodedBytes).toBeLessThanOrEqual(8*1024*1024);expect(cache.admissionSessions).toBeLessThanOrEqual(4);expect(cache.admissionObjectHashes).toBeLessThanOrEqual(4*4096);
  }
  expect(store.get('observation','frame-0')).toBeDefined();store.garbageCollectObservations();expect(store.observationCacheStats()).toMatchObject({fragmentEntries:0,addressEntries:0,decodedEntries:0,admissionSessions:0});
}));


it.each(['write','collect'] as const)('recovers the complete pre-transaction object graph after process death during %s',mode=>withStore((store,path)=>{
  const first=observation('first'),survivor=observation('survivor');survivor.controls=survivor.controls.slice(1);
  store.put('observation',first);store.put('observation',survivor);store.db.prepare('DELETE FROM entities WHERE id=?').run('first');const before=store.observationStorageStats();store.close();
  const input=join(path,'input.json');writeFileSync(input,JSON.stringify(observation('uncommitted')));
  const child=spawnSync(process.execPath,['--import','tsx','--conditions=development',join(import.meta.dirname,'storage-observation-sharing.crash-child.ts'),path,mode,input],{cwd:join(import.meta.dirname,'..'),encoding:'utf8',timeout:15000});
  expect(child.signal,child.stderr).toBe('SIGKILL');const recovered=new SqliteStore(path);
  try{expect(recovered.observationStorageStats()).toEqual(before);expect(recovered.get('observation','uncommitted')).toBeUndefined();expect(recovered.get('observation','survivor')).toEqual(survivor);recovered.garbageCollectObservations({repack:true});expect(recovered.get('observation','survivor')).toEqual(survivor);}finally{recovered.close();}
}));

it('backs off repeated churn and probes a new stable regime without remaining in gzip forever',()=>withStore(store=>{
  store.put('observation',observation('seed'));
  const dynamic=(frame:number)=>({...observation(`dynamic-${frame}`),controls:observation('source').controls.map(control=>({...control,name:`${frame}:${control.name}`,attributes:{...control.attributes,description:`Frame ${frame} dynamic facts `.repeat(20)}}))});
  for(let frame=0;frame<12;frame++){store.transaction(()=>store.put('observation',dynamic(frame)));expect(JSON.parse(row(store,`dynamic-${frame}`).json).$interactionStorage).toMatchObject({version:1,codec:'gzip'});}
  const base=dynamic(99),before=store.observationStorageStats();let firstShared=-1;
  for(let frame=0;frame<10;frame++){
    const value={...base,id:`stable-${frame}`};store.transaction(()=>store.put('observation',value));expect(store.get('observation',value.id)).toEqual(value);
    if(JSON.parse(row(store,value.id).json).$interactionStorage.version===2&&firstShared===-1)firstShared=frame;
  }
  expect(firstShared).toBeGreaterThanOrEqual(0);expect(firstShared).toBeLessThan(10);expect(store.observationStorageStats().objects-before.objects).toBe(base.controls.length);
  expect(store.observationCacheStats().backoffSessions).toBe(0);
}));

it('reuses bounded validated JSON with detached values and exact legacy number semantics',()=>withStore(store=>{
 const value=observation('legacy'),json=JSON.stringify({...value,signedZero:'REPLACE'}).replace('"signedZero":"REPLACE"','"signedZero":-0'),packed=encodeObservationJson(json);
 store.db.prepare('INSERT INTO entities(kind,id,session_id,json,compressed_json) VALUES(?,?,?,?,?)').run('observation',value.id,'s',packed.json,packed.compressed_json);
 const first=store.require<any>('observation',value.id);expect(Object.is(first.signedZero,-0)).toBe(true);first.controls[0].name='mutated';
 const second=store.require<any>('observation',value.id);expect(Object.is(second.signedZero,-0)).toBe(true);expect(second.controls[0].name).toBe(value.controls[0].name);
 const stats=()=>store.observationCacheStats();expect(stats().reconstructedEntries).toBe(1);
 for(let i=0;i<9;i++){store.put('observation',observation(`bounded-${i}`));store.require('observation',`bounded-${i}`);}
 expect(stats().reconstructedEntries).toBeLessThanOrEqual(4);expect(stats().reconstructedBytes).toBeLessThanOrEqual(16*1024*1024);
}));

it.each(['local','external','temp-shadow'] as const)('does not let warm reconstructed JSON hide %s shared-pack corruption',mode=>withStore((store,path)=>{
 store.put('observation',observation('live'));store.require('observation','live');expect(store.observationCacheStats().reconstructedEntries).toBe(1);
 if(mode==='temp-shadow')store.db.exec("CREATE TEMP TABLE observation_packs AS SELECT id,session_id,sha256,bytes,codec,CAST('corrupt' AS BLOB) AS data FROM main.observation_packs");
 else if(mode==='local')store.db.prepare('UPDATE observation_packs SET data=?').run(Buffer.from('corrupt'));
 else{const other=new SqliteStore(path);try{store.require('observation','live');other.db.prepare('UPDATE observation_packs SET data=?').run(Buffer.from('corrupt'));}finally{other.close();}}
 expect(()=>store.require('observation','live')).toThrow(expect.objectContaining({code:'CORRUPT_ENTITY'}));
}));

it('does not retain reconstructed bytes read from a rolled-back raw transaction',()=>withStore(store=>{
 const original=observation('live');store.put('observation',original);store.require('observation','live');
 const changed=structuredClone(original);changed.controls[0].name='temporary';const packed=encodeObservationJson(JSON.stringify(changed));
 store.db.exec('BEGIN');try{
  store.db.prepare('UPDATE entities SET json=?,compressed_json=? WHERE id=?').run(packed.json,packed.compressed_json,'live');
  expect(store.require<typeof changed>('observation','live').controls[0].name).toBe('temporary');
 }finally{store.db.exec('ROLLBACK');}
 expect(store.require('observation','live')).toEqual(original);
}));
