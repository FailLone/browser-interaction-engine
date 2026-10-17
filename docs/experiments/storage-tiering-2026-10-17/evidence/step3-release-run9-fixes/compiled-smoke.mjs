import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { BrowserAdapter, PlaywrightAdapter, createOwnerDependencyCodec } from '@interaction/adapter-playwright';
import { BrowserEngine } from '@interaction/browser';
import { ExplorerPlugin, ExplorerStore } from '@interaction/explorer-plugin';
import { collectOwnerDependencies } from '../packages/adapter-playwright/dist/owner-dependencies.js';

// Only inspect emitted modules; instantiate no host, store, adapter, or driver.
const modules = ['@interaction/adapter-playwright', '@interaction/browser', '@interaction/explorer-plugin'];
const resolved = Object.fromEntries(modules.map(name => [name, import.meta.resolve(name)]));
for (const path of Object.values(resolved)) assert.ok(path.startsWith('file://' + process.cwd() + '/packages/') && path.endsWith('/dist/index.js'), path);
for (const api of [BrowserAdapter, PlaywrightAdapter, BrowserEngine, ExplorerPlugin, ExplorerStore, createOwnerDependencyCodec, collectOwnerDependencies]) assert.equal(typeof api, 'function');
assert.equal(typeof BrowserAdapter.prototype.readDOM, 'function');
assert.equal(typeof BrowserEngine.prototype.continueExploration, 'function');
assert.equal(typeof ExplorerPlugin.prototype.start, 'function');
assert.equal(typeof ExplorerPlugin.prototype.close, 'function');

const file = resolve('.data/producer-types-consumer.mts');
const source = `
import { createOwnerDependencyCodec } from '@interaction/adapter-playwright';
import type { Control, OwnerDependencySnapshot } from '@interaction/adapter-playwright';
import { collectOwnerDependencies } from '../packages/adapter-playwright/dist/owner-dependencies.js';
declare const controls: Control[];
declare const elements: Element[];
declare const instance: (element: Element) => string;
declare const orderedPriorityIds: readonly string[];
const result = collectOwnerDependencies(controls, elements, instance, 'document', undefined, createOwnerDependencyCodec, orderedPriorityIds);
const snapshot: OwnerDependencySnapshot = result;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type Assert<T extends true> = T;
type SnapshotIsTyped = Assert<NotAny<typeof result>>;
// @ts-expect-error Evidence priority consists of local IDs, never arbitrary objects.
collectOwnerDependencies(controls, elements, instance, 'document', undefined, createOwnerDependencyCodec, [{localId: 'target'}]);
`;
const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
  strict: true, skipLibCheck: true, noEmit: true, types: ['node'], customConditions: [] };
const compiler = ts.createCompilerHost(options), readSource = compiler.getSourceFile.bind(compiler);
compiler.getSourceFile = (name, version, ...rest) => name === file ? ts.createSourceFile(name, source, version, true) : readSource(name, version, ...rest);
const program = ts.createProgram([file], options, compiler), diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: ts.sys.getCurrentDirectory, getCanonicalFileName: value => value, getNewLine: () => '\n',
}));
const report = { node: process.version, resolved, compiledPublicInterfaces: 'passed', emittedCollectorSeventhArgument: 'passed',
  typeConsumerUsesPublishedDeclarations: true, instantiatedHosts: 0, instantiatedStores: 0, browserDriverCalls: 0,
  retainedReceiptsRead: 0, startedServices: 0, openedPersistentTaskDatabases: 0,
  scope: 'Compiled release interfaces only. Source behavior is covered separately; no live recovery, receipt batch, or performance conclusion.' };
writeFileSync(process.env.BIE_RELEASE_RESULT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
