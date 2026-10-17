import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { InteractionEngine } from '@interaction/core';
import { BrowserEngine } from '@interaction/browser';
import { ExplorerPlugin } from '@interaction/explorer-plugin';

// Inspect only emitted public modules. No engine/store/driver is instantiated.
const modules = ['@interaction/core', '@interaction/browser', '@interaction/explorer-plugin'];
const resolved = Object.fromEntries(modules.map(name => [name, import.meta.resolve(name)]));
for (const path of Object.values(resolved)) assert.ok(path.startsWith('file://' + process.cwd() + '/packages/') && path.endsWith('/dist/index.js'), path);
assert.equal(typeof InteractionEngine.prototype.checkpointRecoveryCandidates, 'function');
assert.equal(typeof BrowserEngine.prototype.checkpointRecoveryCandidates, 'function');
assert.equal(typeof ExplorerPlugin.prototype.start, 'function');

const file = resolve('.data/recovery-candidate-types-consumer.mts');
const source = `
import { InteractionEngine, type CheckpointRecoveryCandidatesInput, type CheckpointRecoveryCandidateAssessment } from '@interaction/core';
import { BrowserEngine } from '@interaction/browser';
declare const core: InteractionEngine;
declare const browser: BrowserEngine;
const request: CheckpointRecoveryCandidatesInput = { observationId: 'captured-current', checkpointIds: ['checkpoint'] };
const coreRows: CheckpointRecoveryCandidateAssessment[] = core.checkpointRecoveryCandidates('session', request);
const browserRows: CheckpointRecoveryCandidateAssessment[] = browser.checkpointRecoveryCandidates('session', request);
type NotAny<T> = 0 extends (1 & T) ? false : true;
type Assert<T extends true> = T;
type ResultIsTyped = Assert<NotAny<ReturnType<InteractionEngine['checkpointRecoveryCandidates']>>>;
type ResultItemIsTyped = Assert<NotAny<ReturnType<InteractionEngine['checkpointRecoveryCandidates']>[number]>>;
const status: 'tryable' | 'no_known_path' | 'unknown' = coreRows[0].status;
const checkpointVerified: false = browserRows[0].checkpointVerified;
const executionAuthorized: false = browserRows[0].executionAuthorized;
const currentExecution: false = browserRows[0].currentExecution;
const coverageGranted: false = browserRows[0].coverageGranted;
const revalidate: true = browserRows[0].dispatchRevalidationRequired;
// @ts-expect-error The query requires a captured observation ID, not an execution cursor alias.
core.checkpointRecoveryCandidates('session', { currentObservationId: 'wrong', checkpointIds: [] });
// @ts-expect-error Candidate assessment never grants execution permission.
const authorized: true = coreRows[0].executionAuthorized;
`;
const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
  strict: true, skipLibCheck: true, noEmit: true, types: ['node'], customConditions: [] };
const compiler = ts.createCompilerHost(options), readSource = compiler.getSourceFile.bind(compiler);
compiler.getSourceFile = (name, version, ...rest) => name === file ? ts.createSourceFile(name, source, version, true) : readSource(name, version, ...rest);
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, compiler));
if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: ts.sys.getCurrentDirectory, getCanonicalFileName: value => value, getNewLine: () => '\n',
}));
const report = { node: process.version, resolved, compiledCheckpointRecoveryCandidates: 'passed', publishedInputOutputTypes: 'passed',
  authorityFlagsTypedFalse: true, typeConsumerUsesPublishedDeclarations: true, instantiatedHosts: 0, instantiatedStores: 0,
  invokedRecoveryCandidates: 0, browserDriverCalls: 0, retainedReceiptsRead: 0, startedServices: 0, openedPersistentTaskDatabases: 0,
  scope: 'Published API availability only; no behavior, recovery, coverage or performance conclusion.' };
writeFileSync(process.env.BIE_RELEASE_RESULT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
