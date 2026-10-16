/** Temporary databases only. No browser/service/user database is read or changed.
 * pnpm exec tsx --conditions=development tests/storage-observation-sharing.benchmark.ts
 * Baseline is the exact tracked writer, not a gzip-size estimate. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SqliteStore } from '@interaction/storage-sqlite';
const root=resolve(import.meta.dirname,'..'),temporary=mkdtempSync(join(tmpdir(),'observation-sharing-benchmark-'));
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const baselineCommit=execFileSync('git',['rev-parse','5696125'],{cwd:root,encoding:'utf8'}).trim();
const headCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const status=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'});
const sourceFiles=readdirSync(join(root,'packages/storage-sqlite/src')).filter(name=>name.endsWith('.ts')).sort().map(name=>`packages/storage-sqlite/src/${name}`);
const sourceHashes=Object.fromEntries(sourceFiles.map(path=>[path,hash(readFileSync(join(root,path)))]));
const sourceDirtySha256=hash(JSON.stringify(sourceHashes));
const baselineHashes:Record<string,string>={};
const baselineArchive=JSON.parse(execFileSync('python3',[join(root,'docs/experiments/pending-delta-2026-10-17/evidence/prepare-baseline.py'),'--repo',root,'--revision',baselineCommit],{cwd:root,encoding:'utf8'})).sourceRoot as string;
for(const name of ['index.ts','entity-codec.ts','evidence.ts','evidence-chunks.ts'])baselineHashes[name]=hash(readFileSync(join(baselineArchive,'packages/storage-sqlite/src',name)));
const Baseline=(await import(pathToFileURL(join(baselineArchive,'packages/storage-sqlite/src/index.ts')).href)).SqliteStore as typeof SqliteStore;
const captured=JSON.parse(readFileSync(join(root,'tests/fixtures/observation-sharing-captured.json'),'utf8')) as {id:string;sessionId:string;capturedAt:string;[key:string]:unknown};
const capturedFixtureSha256=hash(readFileSync(join(root,'tests/fixtures/observation-sharing-captured.json')));
const controls=Array.from({length:300},(_,i)=>({localId:`control:${i}`,identityId:`identity-${i}`,role:'textbox',name:i<2?'Amount':`Asset ${i}`,occurrence:i<2?['A','B'][i]:String(i),value:i===0?'001.00':i===1?1:String(1000+i*17),
  attributes:{'data-symbol':hash(`asset-${i}`).slice(0,20),placeholder:'价格 € 中文',class:'input-block finance amount-field',type:'text'},rect:{x:i%8*20,y:Math.floor(i/8)*20,width:80,height:20},evidence:'Immutable observed facts '.repeat(8)}));
const dom=Array.from({length:400},(_,i)=>({tag:'section',id:`node-${i}`,attributes:{'data-row':`${i}`,style:'display:block'},children:[{tag:'span',text:`Price ${i}`,attributes:{class:'market-value'},detail:'DOM subtree captured exactly '.repeat(12)}]}));
const frames=36,repetitions=3;
const observation=(frame:number)=>({id:`observation-${frame}`,sessionId:'benchmark',capturedAt:`2026-10-17T00:00:${String(frame).padStart(2,'0')}Z`,url:'https://benchmark.invalid/',controls,regions:[{key:'main',role:'main',label:'Markets'},{key:'header',role:'banner',label:'Header'}],dom:{tag:'main',children:dom},context:{quote:`${999+frame}.001`,count:300}});
let random=0xa341316c;const randomText=()=>Buffer.from(Uint8Array.from({length:140000},()=>{random^=random<<13;random^=random>>>17;random^=random<<5;return random&255;})).toString('base64');
const workloads=[
  {name:'captured-fixture-stable',values:Array.from({length:frames},(_,frame)=>({...captured,id:`observation-${frame}`,sessionId:'benchmark',capturedAt:`2026-10-17T00:00:${String(frame).padStart(2,'0')}Z`}))},
  {name:'one-control-change',values:Array.from({length:frames},(_,frame)=>({...observation(frame),controls:controls.map((control,i)=>i===0?{...control,value:`${999+frame}.0000`}:control)}))},
  {name:'reorder-and-insert',values:Array.from({length:frames},(_,frame)=>({...observation(frame),controls:[...controls.slice(frame),...controls.slice(0,frame),{...controls[0],localId:`insert-${frame}`,value:`new ${frame}`}]}))},
  {name:'all-controls-change',values:Array.from({length:frames},(_,frame)=>({...observation(frame),controls:controls.map(control=>({...control,value:hash(`${frame}:${control.localId}`).slice(0,16)}))}))},
  {name:'high-entropy-text',values:Array.from({length:frames},(_,frame)=>({...observation(frame),controls:controls.slice(0,10),dom:randomText()}))},
  {name:'non-observation-entities',values:Array.from({length:3600},(_,i)=>({id:`frontier-${i}`,sessionId:'benchmark',status:'pending',controlId:`control-${i}`,priority:i,metadata:{reason:'test fixture'}}))},
  {name:'small-observation',values:Array.from({length:frames},(_,frame)=>({id:`observation-${frame}`,sessionId:'benchmark',value:String(frame),controls:controls.slice(0,1)}))},
];
function disk(path:string){let fileBytes=0,allocatedBytes=0;const files:Record<string,number>={};for(const name of readdirSync(path)){const info=statSync(join(path,name));if(info.isFile()){files[name]=info.size;fileBytes+=info.size;allocatedBytes+=info.blocks*512;}}return{fileBytes,allocatedBytes,files};}
const runs:unknown[]=[];
try {
  for(let repetition=0;repetition<repetitions;repetition++)for(const workload of workloads)for(const mode of repetition%2?['new','baseline']:['baseline','new']) {
    const kind=workload.name==='non-observation-entities'?'frontier':'observation';
    const path=join(temporary,`${repetition}-${mode}-${workload.name}`);mkdirSync(path);const Store=mode==='new'?SqliteStore:Baseline;let store=new Store(path);
    const start=performance.now(),cpu=process.cpuUsage();for(const value of workload.values)store.put(kind,value);
    const writeMs=performance.now()-start,used=process.cpuUsage(cpu),activeDisk=disk(path);
    const verify=()=>{const start=performance.now();for(const value of workload.values){const found=store.require(kind,value.id);if(JSON.stringify(found)!==JSON.stringify(value))throw Error(`Exact reconstruction failed ${mode}/${workload.name}/${value.id}`);}return performance.now()-start;};
    const warmReadMs=verify(),listStart=performance.now(),list=store.list(kind,'benchmark');if(JSON.stringify(list)!==JSON.stringify(workload.values))throw Error('List mismatch');const listReadMs=performance.now()-listStart,stats=mode==='new'?store.observationStorageStats():undefined;store.close();const closedDisk=disk(path);
    const restart=performance.now();store=new Store(path);const openMs=performance.now()-restart,restartReadMs=verify();store.close();
    runs.push({repetition,mode,workload:workload.name,frames:workload.values.length,writeMs,writeCpuMs:(used.user+used.system)/1000,warmReadMs,listReadMs,openMs,restartReadMs,activeDisk,closedDisk,stats,verifiedReads:workload.values.length*3});rmSync(path,{recursive:true,force:true});
  }
  console.log(JSON.stringify({protocol:'observation-structure-sharing-v1',baselineCommit,baselineHashes,baselineIsolation:'Full git archive, workspace package imports resolve within archive; only installed third-party dependencies are shared read-only.',capturedFixtureSha256,headCommit,sourceDirtySha256,sourceHashes,status,node:process.version,repetitions,frames,
    measurement:'Synthetic structure-rich observations plus one real repository-fixture capture repeated with new observation IDs/timestamps, in independent temporary SQLite databases. Gzip baseline loaded from complete isolated git archive. Alternating order, exact JSON round trips on warm and reopened reads. Closed DB and active WAL sizes include object/pack tables and indexes. No live-site performance claim.',
    workloads:workloads.map(w=>({name:w.name,inputBytes:w.values.reduce((sum,value)=>sum+Buffer.byteLength(JSON.stringify(value)),0),inputSha256:hash(w.values.map(value=>JSON.stringify(value)).join('\n'))})),runs},null,2));
} finally {rmSync(temporary,{recursive:true,force:true});rmSync(baselineArchive,{recursive:true,force:true});}
