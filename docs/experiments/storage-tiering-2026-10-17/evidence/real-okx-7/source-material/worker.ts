/** Fixed final-task/prior-observation counterfactual. No engine/store initialization or mutation. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {performance} from 'node:perf_hooks';
const cfg=JSON.parse(readFileSync(process.argv[2],'utf8'));
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const hash=(v:unknown)=>sha(JSON.stringify(v));
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
const load=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const input=load(cfg.input),task=structuredClone(input.task),sid=input.sessionId,currentId=input.currentId;
assert.equal(hash(task),cfg.taskSha256);
const forbidden:any[]=[];globalThis.fetch=async()=>{forbidden.push('network');throw Error('FORBIDDEN_NETWORK');};
const {ExplorerPlugin}=await import(pathToFileURL(join(cfg.sourceRoot,'packages/explorer-plugin/src/runtime.ts')).href);
const {BrowserEngine}=await import(pathToFileURL(join(cfg.sourceRoot,'packages/browser/src/index.ts')).href);
let db:any,storage:any;
const reads:any[]=[],hostCalls:any[]=[],events:any[]=[],rawReturns=new Map<string,unknown>();
const started=performance.now();
if(cfg.mode==='sqlite'){
 const require=createRequire(join(cfg.sourceRoot,'packages/storage-sqlite/package.json'));
 const Database=require('better-sqlite3');db=new Database(cfg.database,{readonly:true,fileMustExist:true});db.pragma('query_only = ON');
 assert(db.readonly);assert.equal(db.pragma('query_only',{simple:true}),1);
 const {SqliteStore}=await import(pathToFileURL(join(cfg.sourceRoot,'packages/storage-sqlite/src/index.ts')).href);
 const {ObservationObjectStore}=await import(pathToFileURL(join(cfg.sourceRoot,'packages/storage-sqlite/src/observation-store.ts')).href);
 // Exact production read methods, with only their existing readonly dependencies.
 // Neither SqliteStore nor BrowserEngine constructor is invoked.
 storage=Object.create(SqliteStore.prototype);storage.db=db;
 storage.observations=new ObservationObjectStore(db,()=>{forbidden.push('storage-write');throw Error('FORBIDDEN_STORAGE_WRITE');});
}else assert.equal(cfg.mode,'memory');
const loaded=cfg.mode==='memory'?load(cfg.material):undefined;
function read(method:string,args:unknown[]){
 const key=JSON.stringify([method,...args]),start=performance.now();let value:any;
 if(cfg.mode==='sqlite')value=storage[method](...args);
 else {assert(Object.hasOwn(loaded,key),`Unrecorded read ${key}`);value=loaded[key];}
 reads.push({method,args,elapsedMs:performance.now()-start,key});
 if(!rawReturns.has(key))rawReturns.set(key,value);
 return value;
}
// Invoke real inherited SDK read methods; construction, writes and execution stay forbidden.
const facade:any=Object.create(BrowserEngine.prototype);
facade.store=new Proxy({}, {get(_target,key){
 if(['require','list','listByObservation'].includes(String(key)))return (...args:unknown[])=>read(String(key),args);
 return (...args:unknown[])=>{forbidden.push({storage:String(key),args});throw Error(`FORBIDDEN_STORAGE:${String(key)}`);};
}});
const allowed:any={events:new EventEmitter(),returnToObservedSource:()=>{forbidden.push('returnToObservedSource');throw Error('FORBIDDEN_MUTATION');}};
for(const name of ['session','observation','actions','list','interactionTransition','recoverySourceMaterial']){
 const method=(BrowserEngine.prototype as any)[name];
 allowed[name]=typeof method==='function'?(...args:unknown[])=>method.apply(facade,args):undefined;
}
const host=new Proxy(allowed,{get(target,key){
 if(key in target){const value=target[key];if(typeof value!=='function')return value;return (...args:unknown[])=>{const t=performance.now();const value=target[key](...args);hostCalls.push({method:String(key),args,elapsedMs:performance.now()-t});return value;};}
 forbidden.push({host:String(key)});throw Error(`FORBIDDEN_HOST:${String(key)}`);
}});
const sink:any={event:(event:any)=>{events.push(structuredClone(event));return event;},save:()=>{forbidden.push('save');throw Error('UNEXPECTED_SAVE');}};
const plugin=new ExplorerPlugin(host,sink,{});
// Setup reads and validation are excluded from the selector clock.
const observation=host.observation(sid,currentId),actions=host.actions(sid,currentId);
const availability={observationId:currentId,actions:input.audit.data.operationFacts};
assert.equal(input.audit.observationId,currentId);
assert(input.audit.data.pendingActions.every((id:string)=>actions.some((a:any)=>a.id===id)));
const original=structuredClone(task),inputHashes={task:hash(task),observation:hash(observation),actions:hash(actions),availability:hash(availability)};
const setupMs=performance.now()-started,readOffset=reads.length,hostOffset=hostCalls.length;
const cpuBefore=process.cpuUsage(),t=performance.now();
const routeCondition=(plugin as any).routeConditionReader(observation,actions);
const readerConstructed=performance.now();
const selected=(plugin as any).scheduledRecovery(task,task.rounds.at(-1),observation,actions,availability,routeCondition);
const end=performance.now(),cpu=process.cpuUsage(cpuBefore);
const semantic={input:original,selected:selected??null,task,events};
assert.equal(JSON.stringify(task.plan),JSON.stringify(original.plan),'Selector changed original plan');
assert.equal(task.plan.length,803);assert.equal(forbidden.length,0);
const measuredReads=reads.slice(readOffset),measuredCalls=hostCalls.slice(hostOffset),material=Object.fromEntries(rawReturns);
const returnBytes=new Map([...rawReturns].map(([key,value])=>[key,bytes(value)]));
const readReport=(rr:any[])=>Object.fromEntries([...new Set(rr.map(r=>r.method))].map(method=>{
 const a=rr.filter(r=>r.method===method);return [method,{calls:a.length,uniqueKeys:new Set(a.map(r=>r.key)).size,elapsedMs:a.reduce((n,r)=>n+r.elapsedMs,0),logicalReturnedJsonBytes:a.reduce((n,r)=>n+returnBytes.get(r.key)!,0)}];
}));
const report={protocol:'run7-source-material-read-comparison-v1',mode:cfg.mode,sourceRevision:cfg.revision,
 limitation:'Final task with all terminal failure debt retained + real earlier observation; not the live pre-selection task or a reproduction of its exact selected result. Fixed counterfactual input; complete real SDK read methods, three serial fresh-process pairs; process/OS cache differences remain. Live 43.980s bracket also includes update/local ordering/persistence outside this selector.',
 inputHashes,setupMs,timingsMs:{readerConstruction:readerConstructed-t,selector:end-readerConstructed,total:end-t,cpuUser:cpu.user/1000,cpuSystem:cpu.system/1000},
 selectedSummary:selected&&{itemId:selected.itemId,routeKey:selected.routeKey,checkpointId:selected.frame.checkpointId,sourceObservationId:selected.source.id,returnToSource:selected.returnToSource,targetActionIds:selected.targetActionIds},
 events:{count:events.length,types:events.reduce((r:any,e:any)=>(r[e.type]=(r[e.type]||0)+1,r),{}),sha256:hash(events)},
 completeSemanticSha256:hash(semantic),taskBeforeSha256:hash(original),taskAfterSha256:hash(task),planUnchanged:true,
 routeRetriesBeforeSha256:hash(original.routeRetries),routeRetriesAfterSha256:hash(task.routeRetries),
 reads:readReport(measuredReads),calls:measuredCalls,rawReadCalls:measuredReads,setupReadCalls:reads.slice(0,readOffset),
 byteCounts:{inputTask:bytes(original),resultTask:bytes(task),selected:bytes(selected??null),events:bytes(events),material:bytes(material)},
 resources:process.resourceUsage(),memory:process.memoryUsage(),forbidden,constructors:{engine:0,sqliteStore:0,browser:0,plugin:1},readonly:cfg.mode==='sqlite'?{readonly:db.readonly,queryOnly:db.pragma('query_only',{simple:true}),totalChanges:db.prepare('select total_changes() AS n').get().n}:undefined};
writeFileSync(cfg.semantic,JSON.stringify(semantic));writeFileSync(cfg.output,JSON.stringify(report,null,2)+'\n');
if(cfg.mode==='sqlite')writeFileSync(cfg.material,JSON.stringify(material));
db?.close();console.log(JSON.stringify({mode:cfg.mode,timingsMs:report.timingsMs,selected:report.selectedSummary,reads:report.reads,semantic:report.completeSemanticSha256,events:report.events,materialBytes:report.byteCounts.material}));
