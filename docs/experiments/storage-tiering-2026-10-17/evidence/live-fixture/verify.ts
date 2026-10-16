/** Non-timing verification: every frame comes from the real fixture SDK.
 * Uses a new headless browser, an ephemeral fixture server, and testEngine's
 * owned temporary database. No existing browser/server/database is accessed. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SqliteStore, type StoredEntityRow } from '@interaction/storage-sqlite';
import type { Observation, Control } from '@interaction/browser';
import { fixtureServer, testEngine, pageOf } from '../../../../../tests/helpers.js';
import { sharedObservationLayout } from '../../../../../packages/storage-sqlite/src/entity-codec.js';
const root=resolve(import.meta.dirname,'../../../../..'),output=import.meta.dirname;
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const sourceFiles=readdirSync(join(root,'packages/storage-sqlite/src')).filter(name=>name.endsWith('.ts')).sort().map(name=>`packages/storage-sqlite/src/${name}`);
const sourceHashes=Object.fromEntries(sourceFiles.map(path=>[path,hash(readFileSync(join(root,path)))]));
const provenance={headCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirtySha256:hash(JSON.stringify(sourceHashes)),sourceHashes,
  trackedProductDiffSha256:hash(execFileSync('git',['diff','HEAD','--','packages','apps','tests'],{cwd:root})),node:process.version};
const sqliteFiles=(directory:string)=>{const files:Record<string,number>={};for(const name of ['engine.sqlite','engine.sqlite-wal','engine.sqlite-shm']){try{files[name]=statSync(join(directory,name)).size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;files[name]=0;}}return {files,totalBytes:Object.values(files).reduce((a,b)=>a+b,0)};};
const comparable=(controls:Control[])=>{const occurrences=new Map<string,number>();return new Map(controls.map(control=>{const key=`${control.selector}#${occurrences.get(control.selector)??0}`;occurrences.set(control.selector,(occurrences.get(control.selector)??0)+1);return [key,control];}));};
function differences(before:Observation|undefined,after:Observation){
  if(!before)return undefined;
  const prior=comparable(before.controls),current=comparable(after.controls),details:unknown[]=[],fieldChanges:Record<string,number>={};let common=0,unchanged=0,localIdChanged=0,instanceIdChanged=0,identityIdChanged=0;
  for(const [key,control] of current){const old=prior.get(key);if(!old)continue;common++;const fields=[...new Set([...Object.keys(old),...Object.keys(control)])].filter(field=>JSON.stringify((old as any)[field])!==JSON.stringify((control as any)[field]));
    if(fields.length===0)unchanged++;else {for(const field of fields)fieldChanges[field]=(fieldChanges[field]??0)+1;details.push({selector:key,name:control.name,fields});}
    localIdChanged+=Number(old.localId!==control.localId);instanceIdChanged+=Number(old.instanceId!==control.instanceId);identityIdChanged+=Number(old.identityId!==control.identityId);
  }
  return {commonControls:common,unchangedCompleteControls:unchanged,localIdChanged,instanceIdChanged,identityIdChanged,removedSelectors:[...prior.keys()].filter(key=>!current.has(key)),addedSelectors:[...current.keys()].filter(key=>!prior.has(key)),fieldChanges,details};
}
const fixture=await fixtureServer();let run:Awaited<ReturnType<typeof testEngine>>|undefined,closed=false;
try {
  run=await testEngine(fixture.url,{contextRules:[],settleMs:60,observeTimeoutMs:1200});
  const store=run.engine.store.backing as SqliteStore;
  const snapshots:Observation[]=[],frames:unknown[]=[];let priorIds=new Set<number>(),knownObjects=new Set<number>();
  const capture=(label:string,observation:Observation)=>{
    const json=JSON.stringify(observation),saved=store.require<Observation>('observation',observation.id);
    if(JSON.stringify(saved)!==json)throw Error(`SDK/persistence mismatch at ${label}`);
    const raw=store.db.prepare('SELECT kind,id,session_id,json,compressed_json FROM entities WHERE id=?').get(observation.id) as StoredEntityRow;
    const shared=sharedObservationLayout(raw),references=new Set(shared?.layout.filter((value):value is number=>typeof value==='number')??[]);
    const allObjects=store.db.prepare('SELECT id,bytes,hex(sha256) AS sha256 FROM observation_objects WHERE session_id=?').all(run!.sessionId) as {id:number;bytes:number;sha256:string}[];
    const byHash=new Map(allObjects.map(object=>[object.sha256.toLowerCase(),object]));
    const reuse=[...references].filter(id=>knownObjects.has(id)),fromPrior=[...references].filter(id=>priorIds.has(id));
    const controls=observation.controls.map(control=>{const sha256=hash(JSON.stringify(control)),object=byHash.get(sha256);return{selector:control.selector,name:control.name,localId:control.localId,instanceId:control.instanceId,identityId:control.identityId,sha256,objectId:object?.id,referenced:object!==undefined&&references.has(object.id)};});
    frames.push({label,observationId:observation.id,stable:observation.stable,cause:observation.cause,source:'testEngine SDK observation; independently captured DOM each frame',logicalBytes:Buffer.byteLength(json),sha256:hash(json),format:JSON.parse(raw.json).$interactionStorage??'plain',
      controlCount:observation.controls.length,regionCount:observation.regions.length,controlChanges:differences(snapshots.at(-1),observation),controls,
      uniqueReferences:references.size,reusedExistingObjects:reuse.length,reusedPreviousFrameObjects:fromPrior.length,createdObjects:allObjects.filter(object=>!knownObjects.has(object.id)).length,
      referencedObjectBytes:allObjects.filter(object=>references.has(object.id)).reduce((sum,object)=>sum+object.bytes,0),reusedObjectBytes:allObjects.filter(object=>references.has(object.id)&&knownObjects.has(object.id)).reduce((sum,object)=>sum+object.bytes,0),
      stats:store.observationStorageStats({sessionId:run!.sessionId}),sqlite:sqliteFiles(run!.directory)});
    snapshots.push(observation);priorIds=references;knownObjects=new Set(allObjects.map(object=>object.id));
  };
  capture('initial',run.engine.observation(run.sessionId));
  const plan=[{label:'stable-1'},{label:'stable-2'},{label:'amount-change',selector:'#amount',value:'1.234'},{label:'stable-after-amount'},{label:'price-change',selector:'#price',value:'123.45'},{label:'stable-after-price'},{label:'amount-change-again',selector:'#amount',value:'2.500'},{label:'stable-final-1'},{label:'stable-final-2'}];
  for(const step of plan){if(step.selector)await pageOf(run.engine).locator(step.selector).fill(step.value!);capture(step.label,await run.engine.observe(run.sessionId));}
  await store.evidence.flush?.();
  const all=store.list<Observation>('observation',run.sessionId),before=all.map(value=>JSON.stringify(value)),stats=store.observationStorageStats({sessionId:run.sessionId});
  const allEntityCount=(store.db.prepare('SELECT count(*) AS count FROM entities').get() as {count:number}).count;
  await run.engine.close();closed=true;const closedSqlite=sqliteFiles(run.directory);
  const reopened=new SqliteStore(run.directory);let restartVerified=0;
  try{const after=reopened.list<Observation>('observation',run.sessionId).map(value=>JSON.stringify(value));if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Reopened observation list differs');for(const observation of snapshots){if(JSON.stringify(reopened.require('observation',observation.id))!==JSON.stringify(observation))throw Error(`Reopened capture differs ${observation.id}`);restartVerified++;}}finally{reopened.close();}
  const sourceHashesAfter=Object.fromEntries(sourceFiles.map(path=>[path,hash(readFileSync(join(root,path)))]));
  if(JSON.stringify(sourceHashesAfter)!==JSON.stringify(sourceHashes))throw Error('Storage source changed during verification');
  writeFileSync(join(output,'observations.json'),JSON.stringify(snapshots,null,2)+'\n');
  const result={protocol:'real-sdk-observation-sharing-integrity-v1',provenance,measurement:'Integrity/sharing verification only; no timings or performance claims. Ten genuinely captured SDK observations from a fresh headless repository fixture. Only amount and price inputs changed. SQLite bytes include all SDK entities; evidence files are separate.',
    frames,capturedFrames:snapshots.length,totalStoredObservations:all.length,restartVerified,totalStoredObservationsVerified:before.length,allEntityCount,stats,closedSqlite,observationsSha256:hash(JSON.stringify(snapshots)),allStoredObservationsSha256:hash(before.join('\n')),cleanup:'Own headless browser/server closed and temporary engine directory removed after successful read-back.'};
  writeFileSync(join(output,'verification.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({output:join(output,'verification.json'),capturedFrames:snapshots.length,restartVerified,stats,closedSqlite}));
}finally{if(run){if(!closed)await run.engine.close();rmSync(run.directory,{recursive:true,force:true});}await fixture.server.close();}
