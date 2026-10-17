import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';
import {InteractionEngine} from '@interaction/core';
import {BrowserEngine} from '@interaction/browser';
import {ExplorerPlugin} from '@interaction/explorer-plugin';
import {MemoryStore} from '@interaction/storage-memory';
import {SqliteStore} from '@interaction/storage-sqlite';
import {RetainedPersistence} from '@interaction/storage-retained';

// Availability/type checks only: no engine, store, driver or service is created.
const modules=['@interaction/core','@interaction/browser','@interaction/explorer-plugin','@interaction/storage-memory','@interaction/storage-sqlite','@interaction/storage-retained'];
const resolved=Object.fromEntries(modules.map(name=>[name,import.meta.resolve(name)]));
for(const path of Object.values(resolved))assert.ok(path.startsWith('file://'+process.cwd()+'/packages/')&&path.endsWith('/dist/index.js'),path);
for(const method of ['recoverySelectionView','recoveryAnchorMaterial','recoveryReviewMaterial','checkpointRecoveryCandidates'])assert.equal(typeof BrowserEngine.prototype[method],'function',method);
assert.equal(typeof InteractionEngine.prototype.checkpointRecoveryCandidates,'function');
assert.equal(typeof ExplorerPlugin.prototype.start,'function');
for(const constructor of [MemoryStore,SqliteStore,RetainedPersistence])assert.equal(typeof constructor.prototype.recordRevision,'function');

const file=resolve('.data/selection-types-consumer.mts');
const source=`
import type {BrowserEngine, RecoverySelectionView} from '@interaction/browser';
import type {Persistence, CheckpointRecoveryCandidateAssessment} from '@interaction/core';
import type {ExplorerHost} from '@interaction/explorer-plugin';
declare const engine:BrowserEngine;
declare const host:ExplorerHost;
declare const persistence:Persistence;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type Assert<T extends true> = T;
const revision:string|undefined=persistence.recordRevision?.();
const view=engine.recoverySelectionView('session',{observationId:'current'});
type ViewIsTyped=Assert<NotAny<NonNullable<typeof view>>>;
type SourceIsTyped=Assert<NotAny<ReturnType<NonNullable<typeof view>['source']>>>;
type ReviewIsTyped=Assert<NotAny<ReturnType<NonNullable<NonNullable<typeof view>['reviewMaterial']>>>>;
if(view){
 const current:string=view.current.observation.id;
 const source:string=view.source('historical').source.id;
 view.assertCurrent();view.close();
 // @ts-expect-error A recorded fact view is not execution permission.
 const permission:true=view.executionAuthorized;
 // @ts-expect-error Lightweight anchors do not include complete control graphs.
 view.anchor?.('historical').source.controls;
}
const historical=engine.recoveryReviewMaterial('session',{observationId:'historical'});
type HistoricalReviewIsTyped=Assert<NotAny<typeof historical>>;
const pluginView=host.recoverySelectionView?.('session',{observationId:'current'});
const pluginReview=host.recoveryReviewMaterial?.('session',{observationId:'historical'});
type PluginViewIsTyped=Assert<NotAny<NonNullable<typeof pluginView>>>;
type PluginReviewIsTyped=Assert<NotAny<NonNullable<typeof pluginReview>>>;
const candidates:CheckpointRecoveryCandidateAssessment[]=engine.checkpointRecoveryCandidates('session',{observationId:'current',checkpointIds:['checkpoint']});
const status:'tryable'|'no_known_path'|'unknown'=candidates[0].status;
const verified:false=candidates[0].checkpointVerified;
const execution:false=candidates[0].executionAuthorized;
const currentExecution:false=candidates[0].currentExecution;
const coverage:false=candidates[0].coverageGranted;
const revalidate:true=candidates[0].dispatchRevalidationRequired;
// @ts-expect-error Explicit captured source IDs remain required.
engine.recoveryReviewMaterial('session',{});
// @ts-expect-error A positive candidate cannot grant execution.
const permission:true=candidates[0].executionAuthorized;
`;
const options={module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,
 strict:true,skipLibCheck:true,noEmit:true,types:['node'],customConditions:[]};
const compiler=ts.createCompilerHost(options),readSource=compiler.getSourceFile.bind(compiler);
compiler.getSourceFile=(name,version,...rest)=>name===file?ts.createSourceFile(name,source,version,true):readSource(name,version,...rest);
const diagnostics=ts.getPreEmitDiagnostics(ts.createProgram([file],options,compiler));
if(diagnostics.length)throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:ts.sys.getCurrentDirectory,getCanonicalFileName:value=>value,getNewLine:()=>'\n'}));
const report={node:process.version,resolved,compiledPublicImports:'passed',publishedSelectionTypes:'passed',
 instantiatedHosts:0,instantiatedStores:0,browserDriverCalls:0,startedServices:0,openedPersistentTaskDatabases:0,
 scope:'Compiled availability and declaration consumption only; behavior, performance and real arrival have separate evidence.'};
writeFileSync(process.env.BIE_RELEASE_RESULT,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report,null,2));
