import {afterEach,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fragmentFixture,emptyLegacy} from './fragment-storage-helpers.js';
import {TaskWriter} from '../packages/explorer-plugin/src/task-writer.js';
import {FragmentSession} from '../packages/explorer-plugin/src/fragment-session.js';
import {FragmentStore} from '../packages/explorer-plugin/src/fragment-store.js';
import {encodeFragmentMaterial} from '../packages/explorer-plugin/src/fragment-material.js';
import {emptyFragmentAccess,fragmentAccessCounters,mapFragmentCandidates,recordFragmentAccess,transferFragmentAccess} from '../packages/explorer-plugin/src/fragment-traversal-core.js';
const fixtures:ReturnType<typeof fragmentFixture>[]=[],dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const f of fixtures.splice(0))f.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(path=':memory:',legacy=undefined as Parameters<typeof fragmentFixture>[1]){const f=fragmentFixture(path,legacy);fixtures.push(f);return f;}
const source={sessionId:'s',observationId:'o',regionId:'nav'};
const projection={structure:'<nav><a/></nav>',owner:JSON.stringify({content:'complete content',context:{variant:'A'}}),revision:'r',candidates:[{path:'./a[1]',operation:'click',guard:JSON.stringify({binding:'a',modes:Array.from({length:80},(_,i)=>({id:i,expanded:false,recordKey:'original'}))})}]};
const register=(s:FragmentSession,index:number)=>s.register(`https://example.test/${index}`,projection,source);
function event(id:string,record:ReturnType<typeof register>){return {id,fragmentId:record.fragment.id,candidateId:record.candidates[0].id,sessionId:'s',observationId:'o',afterId:'after',actionId:'action'};}

it('shares exact material and class membership beyond the old durable limits, with one origin and no graph rewrite on ordinary flush',()=>{
 const {store,writer,session,task}=fixture(),db=store.fragmentRecords.db;
 const records=Array.from({length:300},(_,i)=>{const record=register(session,i);session.put('states',{id:`state-${i}`,url:`https://example.test/${i}`,context:'context',candidateIds:[record.candidates[0].id],source});if(i%30===29)writer.flush();return record;});
 expect(store.fragmentRecords.stats(task.id)).toMatchObject({fragments:300,candidates:300,classes:1,edges:0,states:300});
 expect(session.peers(records[0].fragment.id)).toBe(299);expect(session.counts(records[299].candidates[0].id)).toEqual({direct:false,duplicate:0,equivalent:0});
 session.put('events',event('actual',records[0]));const delta=session.delta()!;
 expect(delta.candidates).toEqual([]);expect(delta.materials).toEqual([]);expect(delta.events).toHaveLength(1);expect(JSON.stringify(delta).length).toBeLessThan(1500);writer.flush();
 for(const index of [0,1,299])expect(session.counts(records[index].candidates[0].id)).toEqual({direct:index===0,duplicate:index===0?1:0,equivalent:1});
 expect(session.put('events',event('actual',records[0]))).toBe(false);expect(session.delta()).toBeUndefined();
 expect(session.raw(records[299].candidates[0].guard)).toBe(projection.candidates[0].guard);
 expect(db.prepare("SELECT count(*) n FROM fg_objects WHERE kind='atom'").get()).toEqual({n:1});
 expect(JSON.stringify(store.taskHeader(task.id).header.fragmentTraversal).length).toBeLessThan(256);
 const apply=vi.spyOn(store.fragmentRecords,'apply');task.usage.actions++;writer.flush();expect(apply).not.toHaveBeenCalled();
 expect(store.fragmentRecords.cacheStats().bytes).toBeLessThanOrEqual(store.fragmentRecords.cacheStats().limit);
 const cold=new TaskWriter(store,store.taskState(task.id)).fragments();expect(cold.counts(records[299].candidates[0].id)).toEqual(session.counts(records[299].candidates[0].id));expect(store.fragmentRecords.stats(task.id).events).toBe(1);
});

it('rolls back fragments, origins, unknown and budget together, retains dirty work, and rejects a stale owner',()=>{
 const {store,writer,session,task}=fixture(),db=store.fragmentRecords.db,record=register(session,0),version=store.taskHeader(task.id).version;
 session.put('events',event('receipt',record));task.pendingDispatch={sessionId:'s',requestId:'unknown',actionId:'a',observationId:'o',itemIds:[]};task.usage.actions=7;
 db.exec("CREATE TRIGGER reject_fragment_header BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'atomic failure'); END;");
 expect(()=>writer.flush()).toThrow('atomic failure');expect(store.fragmentRecords.stats(task.id).events).toBe(0);expect(store.fragmentRecords.root(task.id)).toBeUndefined();expect(store.taskHeader(task.id).version).toBe(version);expect(store.task(task.id).pendingDispatch).toBeUndefined();
 db.exec('DROP TRIGGER reject_fragment_header');writer.flush();expect(store.fragmentRecords.stats(task.id).events).toBe(1);expect(store.task(task.id).pendingDispatch?.requestId).toBe('unknown');
 const stale=new TaskWriter(store,store.taskState(task.id)),loser=stale.fragments();register(loser,1);task.usage.actions=8;writer.flush();
 expect(()=>stale.flush()).toThrow('STALE_TASK_VERSION');expect(stale.conflicted).toBe(true);expect(store.fragmentRecords.stats(task.id).fragments).toBe(1);expect(store.task(task.id).usage.actions).toBe(8);
});

it.each([false,true])('migrates original IDs and incomplete directed duplicate/equivalent graphs, cycles and single-edge revocations (encoded=%s)',encoded=>{
 const legacy=emptyLegacy();legacy.epoch=17;legacy.authority='authority';
 for(const id of ['A','B','C'])legacy.fragments.push({id,structure:'tree',owner:encoded?encodeFragmentMaterial('owner'):'owner',revision:'r',url:'https://example.test/'+id,source,candidates:[{id:id+'-candidate',path:'a',operation:'click',guard:encoded?encodeFragmentMaterial('guard'):'guard',access:emptyFragmentAccess()}]});
 const [a,b,c]=legacy.fragments;
 legacy.mappings=[...mapFragmentCandidates(a,b),{...mapFragmentCandidates(b,c)[0],kind:'duplicate'},...mapFragmentCandidates(c,a)];
 legacy.events=[{id:'actual-A',candidateId:a.candidates[0].id,fragmentId:a.id,...source,afterId:'after',actionId:'a'},{id:'actual-B',candidateId:b.candidates[0].id,fragmentId:b.id,...source,afterId:'after',actionId:'b'}];
 const {store,writer,session}=fixture(':memory:',legacy),exported=store.exportFragments('task')!;
 expect(exported.fragments.map(f=>f.id)).toEqual(['A','B','C']);expect(exported.fragments.map(f=>f.owner)).toEqual(legacy.fragments.map(f=>f.owner));expect(exported.mappings).toEqual(legacy.mappings);expect(exported.events).toEqual(legacy.events);expect(exported.epoch).toBe(17);expect(store.fragmentRecords.stats('task').classes).toBe(0);
 const oracle=()=>{for(const f of legacy.fragments)f.candidates[0].access=emptyFragmentAccess();const candidates=new Map(legacy.fragments.map(f=>[f.candidates[0].id,f.candidates[0]]));for(const e of legacy.events){const c=candidates.get(e.candidateId)!;c.access=recordFragmentAccess(c.access,e.id);}for(let i=0;i<10;i++)for(const edge of legacy.mappings)if(!edge.revoked&&!legacy.revokedCandidates[edge.sourceCandidateId]&&!legacy.revokedCandidates[edge.targetCandidateId]){const a=candidates.get(edge.sourceCandidateId)!,b=candidates.get(edge.targetCandidateId)!;b.access=transferFragmentAccess(a.access,b.access,edge.kind);}for(const c of candidates.values())expect(session.counts(c.id)).toEqual(fragmentAccessCounters(c.access));};
 oracle();const edge=session.get('edges','legacy:0')!;edge.revoked={reason:'single-edge mismatch'};session.put('edges',edge);legacy.mappings[0].revoked=edge.revoked;writer.flush();oracle();
 session.put('revocations',{id:b.candidates[0].id,reason:'candidate mismatch'});legacy.revokedCandidates[b.candidates[0].id]='candidate mismatch';writer.flush();oracle();
 expect(session.counts(b.candidates[0].id).direct).toBe(true);expect(store.exportFragments('task')!.mappings).toEqual(legacy.mappings);
});

it('rejects corrupted cached material, forged membership and missing references without granting sampled',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fragment-store-'));dirs.push(dir);const path=join(dir,'explorer.sqlite'),{store,session,writer}=fixture(path),record=register(session,0);session.put('events',event('actual',record));writer.flush();expect(session.counts(record.candidates[0].id).direct).toBe(true);
 const outside=new DatabaseSync(path);try{const row=outside.prepare('SELECT pack_id FROM fg_objects WHERE id=?').get(record.candidates[0].guard) as {pack_id:number};outside.prepare('UPDATE fg_packs SET data=? WHERE id=?').run(Buffer.from('invalid'),row.pack_id);
 expect(()=>session.counts(record.candidates[0].id)).toThrow();expect(()=>store.fragmentRecords.verify('task')).toThrow();}finally{outside.close();}
});

it('retains changed guards and ambiguous candidates without equivalence, and transfers late membership only from live origins',()=>{
 const {session,writer}=fixture(),a=register(session,0);session.put('events',event('actual',a));writer.flush();const b=register(session,1);expect(session.counts(b.candidates[0].id).equivalent).toBe(1);
 const different=session.register('https://example.test/changed',{...projection,candidates:[{...projection.candidates[0],guard:projection.candidates[0].guard.replace('original','changed')}]},source);expect(session.counts(different.candidates[0].id).equivalent).toBe(0);
 const ambiguous=session.register('https://example.test/ambiguous',{...projection,candidates:[projection.candidates[0],projection.candidates[0]]},source);expect(ambiguous.candidates.every(c=>!c.classId&&session.counts(c.id).equivalent===0)).toBe(true);
 session.put('revocations',{id:a.candidates[0].id,reason:'revoked origin mapping'});const c=register(session,2);expect(session.counts(c.candidates[0].id).equivalent).toBe(0);expect(session.counts(a.candidates[0].id).direct).toBe(true);writer.flush();
});

it('evicts hot material without deleting durable work, validates packed index fields, and collects only unreferenced objects',()=>{
 const {store,writer,session}=fixture(),records=Array.from({length:24},(_,i)=>session.register('https://example.test/cache/'+i,{...projection,candidates:[{...projection.candidates[0],guard:JSON.stringify({mode:'unique-'+i,content:(i+'-').repeat(2000)})}]},source));
 session.put('events',event('actual',records[0]));session.material('guard',JSON.stringify({unused:'discardable'.repeat(300)}));writer.flush();
 const db=store.fragmentRecords.db;store.fragmentRecords=new FragmentStore(db,4096);
 const cold=new TaskWriter(store,store.taskState('task')).fragments();for(const record of records)cold.counts(record.candidates[0].id);
 expect(store.fragmentRecords.cacheStats().bytes).toBeLessThanOrEqual(4096);expect(cold.counts(records[0].candidates[0].id).direct).toBe(true);
 const before=store.fragmentRecords.stats('task'),maintenance=store.fragmentRecords.compact();expect(maintenance.removedObjects.length).toBeGreaterThan(0);expect(store.fragmentRecords.stats('task')).toEqual(before);expect(cold.counts(records[0].candidates[0].id).direct).toBe(true);
 // The material itself is valid, but a tampered SQL projection must not use
 // another guard's class while the packed immutable candidate says otherwise.
 db.prepare('UPDATE fg_candidates SET guard_id=? WHERE id=?').run(records[1].candidates[0].guard,records[0].candidates[0].id);
 expect(()=>cold.counts(records[0].candidates[0].id)).toThrow('CORRUPT_FRAGMENT_STORAGE');
});

it('reads ordinary task headers without unpacking graph history and rejects forged class membership atomically',()=>{
 const {store,writer,session,task}=fixture(),a=register(session,0);writer.flush();
 const material=vi.spyOn(store.fragmentRecords,'material').mockImplementation(()=>{throw Error('unexpected material load');});
 expect(store.taskHeader(task.id).header.fragmentTraversal).toEqual(session.root);expect(store.task(task.id).id).toBe(task.id);material.mockRestore();
 const changed=session.register('https://example.test/forged',{...projection,candidates:[{...projection.candidates[0],guard:'different complete guard'}]},source),delta=session.delta()!;
 delta.candidates[0].classId=a.candidates[0].classId;const {plan,rounds,...header}=task;
 expect(()=>store.applyTaskDelta(task.id,store.taskHeader(task.id).version,{header,fragments:delta})).toThrow('CORRUPT_FRAGMENT_STORAGE');
 expect(store.fragmentRecords.get(task.id,'fragments',changed.fragment.id)).toBeUndefined();expect(store.fragmentRecords.stats(task.id).fragments).toBe(1);
});
