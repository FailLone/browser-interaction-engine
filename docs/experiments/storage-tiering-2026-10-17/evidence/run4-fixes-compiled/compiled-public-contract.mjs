
import assert from 'node:assert/strict';
import ts from 'typescript';
import { writeFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { RetainedPersistence } from '@interaction/storage-retained';
const root=realpathSync(process.cwd()), file=resolve('.data/run4-public-consumer.mts');
const source=`
import type { BrowserEngine } from '@interaction/browser';
import type { ObservedSourceReturnResult, Persistence } from '@interaction/core';
import type { RetainedPersistence } from '@interaction/storage-retained';
declare const engine: BrowserEngine, store: Persistence, retained: RetainedPersistence;
type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Result = Awaited<ReturnType<BrowserEngine['returnToObservedSource']>>;
type IsTyped = Assert<NotAny<Result>>;
type ExactPublicResult = Assert<Equal<Result, ObservedSourceReturnResult>>;
type Status = Assert<Equal<Result['status'], 'SOURCE_REACHED'|'PRECONDITIONS_CHANGED'|'UNREACHABLE'|'UNVERIFIED'>>;
type FalseFlags = Assert<Equal<Result['checkpointVerified']|Result['currentExecution']|Result['executionAuthorized']|Result['sourceStateRestored'],false>>;
const promise: Promise<ObservedSourceReturnResult> = engine.returnToObservedSource('s',{observationId:'source',currentObservationId:'current'});
declare const result: Result;
const scope: 'observed-ui'|undefined=result.verificationScope;
const unresolved: string[]=result.diagnostics.unassessedEffectAttemptIds;
// @ts-expect-error Source arrival cannot become strict checkpoint success.
const strict: 'REACHED_VERIFIED'=result.status;
// @ts-expect-error Source arrival cannot authorize execution.
const authorized: true=result.executionAuthorized;
// @ts-expect-error The source observation is required.
engine.returnToObservedSource('s',{});
type OptionalScopedRead=Assert<Equal<{} extends Pick<Persistence,'listByObservation'>?true:false,true>>;
type ScopedTyped=Assert<NotAny<ReturnType<NonNullable<Persistence['listByObservation']>>>>;
const row: {id:string;observationId:string}[]|undefined=store.listByObservation?.<{id:string;observationId:string}>('action','s','o');
const wrapped: {id:string}[]|undefined=retained.listByObservation?.<{id:string}>('action','s','o');
declare const required: Omit<Persistence,'listByObservation'>;
const legacy: Persistence=required;
// @ts-expect-error The optional legacy hook cannot be called without a guard.
store.listByObservation('action','s','o');
// @ts-expect-error Generic scoped rows remain typed.
row?.[0].inventedPermission;
`;
writeFileSync(file,source);
const options={module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,strict:true,skipLibCheck:true,noEmit:true,types:['node'],customConditions:[]};
const program=ts.createProgram([file],options),diagnostics=ts.getPreEmitDiagnostics(program);
if(diagnostics.length)throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:ts.sys.getCurrentDirectory,getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));
const declarations=program.getSourceFiles().map(f=>realpathSync(f.fileName)).filter(p=>p.includes('/packages/')&&!p.includes('/node_modules/'));
assert.ok(declarations.some(p=>p.endsWith('/core/dist/ports.d.ts')));
for(const p of declarations)assert.ok(p.startsWith(root+sep)&&p.includes('/dist/'),`Nonpublished workspace declaration: ${p}`);
const modules=[];
for(const name of ['core','browser','adapter-playwright','storage-memory','storage-retained','storage-sqlite','explorer-plugin','client','rules']){
 const path=realpathSync(fileURLToPath(import.meta.resolve('@interaction/'+name)));
 assert.ok(path.startsWith(root+sep)&&path.includes('/dist/'),`Workspace import escaped archive: ${path}`);
 modules.push({name:'@interaction/'+name,path});
}
const seed=store=>{
 store.put('observation',{id:'now',sessionId:'fixture-session'});
 store.put('observation',{id:'old',sessionId:'fixture-session'});
 for(const row of [{id:'old-action',sessionId:'fixture-session',observationId:'old'},{id:'a',sessionId:'fixture-session',observationId:'now',value:{n:1}},{id:'b',sessionId:'other',observationId:'now'},{id:'c',sessionId:'fixture-session',observationId:'now'}])store.put('action',row);
};
const backing=new MemoryStore();let scopedCalls=[];
const scoped=backing.listByObservation.bind(backing);
backing.listByObservation=function(...args){assert.equal(this,backing);scopedCalls.push(args);return scoped(...args);};
const engine=new BrowserEngine({persistence:backing,retention:{sweepIntervalMs:0}});
let legacyReads=0,optimized;
try{
 seed(backing);assert.equal(typeof engine.returnToObservedSource,'function');
 assert.equal(typeof engine.store.listByObservation,'function');
 optimized=engine.actions('fixture-session','now');assert.deepEqual(optimized.map(x=>x.id),['a','c']);
 assert.deepEqual(scopedCalls,[['action','fixture-session','now']]);
 optimized[0].value.n=99;assert.equal(engine.actions('fixture-session','now')[0].value.n,1);
 optimized=engine.actions('fixture-session','now');
}finally{await engine.close();}
const old=new MemoryStore(),list=old.list.bind(old);
old.listByObservation=undefined;
old.list=function(...args){if(args[0]==='action')legacyReads++;return list(...args);};
const fallback=new BrowserEngine({persistence:old,retention:{sweepIntervalMs:0}});
try{
 seed(old);assert.equal(fallback.store.listByObservation,undefined);
 assert.deepEqual(fallback.actions('fixture-session','now'),optimized);
 assert.equal(legacyReads,1);
}finally{await fallback.close();}
const raw=new MemoryStore(),wrapper=new RetainedPersistence(raw,{sweepIntervalMs:0});
try{seed(raw);assert.deepEqual(wrapper.listByObservation('action','fixture-session','now'),optimized);}finally{wrapper.close();}
const report={publishedNarrowSourceResult:'passed',optionalPersistenceMethod:'passed',retainedBoundForwarding:'passed',browserEngineForwarding:'passed',legacyFullListFallback:'passed',copyIsolation:'passed',driverStarts:0,sourceReturnDispatches:0,modules,declarations};
writeFileSync('.data/run4-contract-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
