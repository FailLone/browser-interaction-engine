import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import ts from 'typescript';
import { BrowserEngine, PlaywrightAdapter } from '@interaction/browser';
import { InteractionEngine } from '@interaction/core';
import { MemoryStore } from '@interaction/storage-memory';
import { ExplorerPlugin, ExplorerStore } from '@interaction/explorer-plugin';

// Consumer resolution must select emitted declarations; no development condition.
const file = resolve('.data/receipt-types-consumer.mts');
const source = `
import type { BrowserEngine } from '@interaction/browser';
import type { InteractionEngine, OperationReceiptCondition } from '@interaction/core';
declare const browser: BrowserEngine;
declare const core: InteractionEngine;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type Assert<T extends true> = T;
const batch = browser.operationReceiptConditions('session', {attemptIds: ['receipt']});
type BatchIsTyped = Assert<NotAny<typeof batch>>;
type ReceiptIsTyped = Assert<NotAny<typeof batch.results[number]>>;
const result: OperationReceiptCondition = batch.results[0];
const sessionId: string = batch.sessionId;
const identity: false = result.identityAuthorized;
const replay: false = result.replayAuthorized;
const current: false = result.currentExecution;
const arrival: false = result.arrivalVerified;
const base: OperationReceiptCondition[] = core.operationReceiptConditions('session', {attemptIds: []}).results;
// @ts-expect-error A receipt lookup must not grant identity.
const elevated: true = result.identityAuthorized;
// @ts-expect-error The public batch takes receipt IDs, not arbitrary operations.
browser.operationReceiptConditions('session', {actions: []});
// @ts-expect-error The public result has no invented permission.
batch.results[0].dispatchAuthorized;
`;
const options = {module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true, noEmit: true, types: ['node'], customConditions: []};
const compiler = ts.createCompilerHost(options), readSource = compiler.getSourceFile.bind(compiler);
compiler.getSourceFile = (name, version, ...rest) => name === file ? ts.createSourceFile(name, source, version, true) : readSource(name, version, ...rest);
const program = ts.createProgram([file], options, compiler), diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {getCurrentDirectory: ts.sys.getCurrentDirectory, getCanonicalFileName: x => x, getNewLine: () => '\n'}));
const exports = ['@interaction/browser', '@interaction/core', '@interaction/storage-memory', '@interaction/explorer-plugin'];
const resolved = Object.fromEntries(exports.map(name => [name, import.meta.resolve(name)]));
for (const path of Object.values(resolved)) assert.ok(path.startsWith('file://' + process.cwd() + '/packages/') && path.endsWith('/dist/index.js'), path);
assert.equal(typeof InteractionEngine.prototype.operationReceiptConditions, 'function');
assert.equal(typeof BrowserEngine.prototype.operationReceiptConditions, 'function');
assert.equal(typeof ExplorerPlugin, 'function');
assert.equal(typeof ExplorerStore, 'function');

const seed = JSON.parse(gunzipSync(readFileSync(process.env.BIE_RELEASE_FIXTURE)).toString('utf8'));
const reference = JSON.parse(readFileSync(process.env.BIE_RELEASE_REFERENCE, 'utf8'));
const backing = new MemoryStore();
for (const [kind, rows] of Object.entries(seed.rows)) for (const row of rows) backing.put(kind, row);
const originalDriver = PlaywrightAdapter.prototype.createDriver;
let driverCalls = 0, writes = 0, events = 0;
PlaywrightAdapter.prototype.createDriver = () => { driverCalls++; throw Error('Compiled receipt reads must not attach a browser'); };
const engine = new BrowserEngine({persistence: backing});
const put = engine.store.put.bind(engine.store), event = engine.store.event.bind(engine.store);
engine.store.put = (...args) => { writes++; return put(...args); };
engine.store.event = (...args) => { events++; return event(...args); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const single = seed.attemptIds.map(attemptId => engine.operationReceiptCondition(seed.sessionId, {attemptId}));
  const batch = engine.operationReceiptConditions(seed.sessionId, {attemptIds: seed.attemptIds});
  assert.deepEqual(batch.results, reference.distinct.results);
  assert.deepEqual(batch.results, single);
  assert.equal(batch.sessionId, seed.sessionId);
  assert.equal(batch.results.length, 4);
  for (const result of batch.results) {
    assert.equal(result.actualSuccess, true);
    assert.equal(result.conditionVerified, true);
    assert.equal(result.status, 'document');
    for (const key of ['identityAuthorized', 'replayAuthorized', 'currentExecution', 'arrivalVerified']) assert.equal(result[key], false);
  }
  assert.deepEqual(engine.operationReceiptConditions('absent-session', {attemptIds: []}), {sessionId: 'absent-session', results: []});
  const missing = engine.operationReceiptConditions(seed.sessionId, {attemptIds: ['absent-receipt']}).results[0];
  assert.equal(missing.conditionVerified, false);
  assert.equal(missing.status, 'unavailable');
  assert.equal(writes, 0); assert.equal(events, 0); assert.equal(driverCalls, 0);
  // A second read must reject newly unknown execution; only this owned in-memory fixture is changed.
  const prior = backing.require('attempt', seed.attemptIds[0]);
  backing.put('attempt', {...prior, id: 'compiled-unknown', status: 'unknown', afterId: undefined});
  const blocked = engine.operationReceiptConditions(seed.sessionId, {attemptIds: seed.attemptIds});
  for (const result of blocked.results) {
    assert.equal(result.actualSuccess, true);
    assert.equal(result.conditionVerified, false);
    assert.equal(result.reason, 'unknown_execution_outcome');
    for (const key of ['identityAuthorized', 'replayAuthorized', 'currentExecution', 'arrivalVerified']) assert.equal(result[key], false);
  }
  assert.equal(writes, 0); assert.equal(events, 0); assert.equal(driverCalls, 0);
  const report = {node: process.version, resolved, publicReceiptDeclarations: 'passed', compiledBatchAPI: 'passed',
    retainedReceiptCount: batch.results.length, fullBaselineEquality: true, resultSha256: digest(batch.results),
    fixtureRowsSha256: digest(seed.rows), falseAuthorityFlags: 'passed', missingReceiptRejected: true,
    nextCallUnknownRejected: true, queryWrites: writes, queryEvents: events, browserDriverCalls: driverCalls,
    startedServices: 0, openedPersistentTaskDatabases: 0, results: batch.results, blockedResults: blocked.results,
    scope: 'Compiled API/declaration checkpoint. Retained local receipts only; no live recovery or performance claim.'};
  writeFileSync(process.env.BIE_RELEASE_RESULT, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({...report, results: undefined, blockedResults: undefined}, null, 2));
} finally { await engine.close(); PlaywrightAdapter.prototype.createDriver = originalDriver; }
