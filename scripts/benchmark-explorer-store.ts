/** Same-input storage benchmark. All databases are disposable, outside the repo.
 * --source-root may select an immutable baseline checkout; no live task is read.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Task } from '../packages/explorer-plugin/src/types.js';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];}));
const root=resolve(args['source-root']||'.');
const {ExplorerStore}=await import(pathToFileURL(join(root,'packages/explorer-plugin/src/store.ts')).href) as typeof import('../packages/explorer-plugin/src/store.js');
const count=Number(args.count||1000),iterations=Number(args.iterations||40),polls=Number(args.polls||500);
const autocheckpoint=Number(args.autocheckpoint??1000);
const directory=mkdtempSync(join(tmpdir(),'explorer-store-benchmark-')),filename=join(directory,'plugin.sqlite');
const fixture:Task={id:'task',goal:'Retain all distinct observed branches',url:'https://fixture.invalid/',createdAt:'2026-10-17T00:00:00Z',updatedAt:'2026-10-17T00:00:00Z',revision:1,status:'paused',budget:{rounds:100,actions:10000,durationMs:100000,modelRequests:100},usage:{rounds:1,actions:0,durationMs:0,modelRequests:0},sessionOptions:{},sampleExcluded:[],exhaustive:false,
  plan:Array.from({length:count},(_,i)=>({id:`item-${i}`,title:`Branch ${i}`,scope:{url:'https://fixture.invalid/',stableKey:`record-${i}`,label:`Branch ${i}`,kind:'fill',value:'input'},prerequisites:[{label:'Menu',kind:'click'}],completion:'Observe this specific input branch',required:true,status:'unresolved',reason:'observed_in_scope',dispatchScope:false,evidence:[{sessionId:'source',observationId:`observation-${i}`}],attempts:[{roundId:'round',outcome:'blocked',evidence:{sessionId:'source',observationId:`observation-${i}`,attemptId:`attempt-${i}`}}]})),
  rounds:[{id:'round',number:1,sessionId:'source',startedAt:'2026-10-17T00:00:00Z',status:'paused',actions:0,stack:[],entryPath:[],reentries:[],tried:[],reviewed:[],noProgress:0}]};
const fixtureHash=createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
const size=(suffix='')=>{try{return statSync(filename+suffix).size;}catch{return 0;}};
const bytes=()=>({database:size(),wal:size('-wal'),sharedMemory:size('-shm'),total:size()+size('-wal')+size('-shm')});
function sample(fn:()=>void,n:number){const times:number[]=[];const cpu=process.cpuUsage();for(let i=0;i<n;i++){const start=performance.now();fn();times.push(performance.now()-start);}const usage=process.cpuUsage(cpu);const sorted=[...times].sort((a,b)=>a-b);return {count:n,totalMs:times.reduce((a,b)=>a+b,0),medianMs:sorted[Math.floor(n/2)],maxMs:sorted.at(-1),cpuMs:(usage.user+usage.system)/1000};}
const store=new ExplorerStore(filename),db=(store as unknown as {db:Database.Database}).db;
let result:unknown;
try{
  db.pragma(`wal_autocheckpoint = ${autocheckpoint}`);store.save(fixture);db.pragma('wal_checkpoint(TRUNCATE)');const initialBytes=bytes();
  const retained=store.task(fixture.id);let step=0;
  const saves=sample(()=>{const item=retained.plan[(step*37)%count];item.reason=`retry-${step++}`;retained.usage.actions=step;store.save(retained);},iterations);
  const afterWrites=bytes();const version=store.updates(fixture.id).taskVersion;
  const idle=sample(()=>{if(store.updates(fixture.id,0,500,version).task!==undefined)throw Error('Idle poll returned unchanged task');},polls);
  const reads=sample(()=>{if(store.task(fixture.id).plan.length!==count)throw Error('Lost plan rows');},30);
  const stripTime=(t:Task)=>({...t,updatedAt:'ignored'});
  if(JSON.stringify(stripTime(store.task(fixture.id)))!==JSON.stringify(stripTime(retained))) {
    // Normalized reconstruction may change object key order, not field content.
    const {isDeepStrictEqual}=await import('node:util');if(!isDeepStrictEqual(stripTime(store.task(fixture.id)),stripTime(retained)))throw Error('Roundtrip mismatch');
  }
  store.close();const closedBytes=bytes();
  const reopened=new ExplorerStore(filename);const coldStart=performance.now();const restored=reopened.task(fixture.id);const coldReadMs=performance.now()-coldStart;reopened.close();
  if(restored.plan.length!==count||restored.usage.actions!==iterations)throw Error('Restart mismatch');
  result={sourceRoot:root,fixtureHash,count,iterations,polls,node:process.version,saves,idle,reads,coldReadMs,initialBytes,afterWrites,closedBytes,walPolicy:{autocheckpointPages:autocheckpoint,initialCheckpoint:true,finalCloseCheckpointsWal:true},scope:'task persistence microbenchmark, not browser end-to-end performance; no VACUUM'};
}finally{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});}
const json=JSON.stringify(result,null,2);if(args.output)writeFileSync(args.output,json+'\n');else console.log(json);
