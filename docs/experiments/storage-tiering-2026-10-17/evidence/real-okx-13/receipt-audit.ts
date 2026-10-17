// Prepared only. Invoke once with --execute after root closes the run and creates
// its exclusive audit copy. No browser, frozen database connection or replay.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { BrowserEngine, type Observation } from '@interaction/browser';
import { PlaywrightAdapter } from '@interaction/adapter-playwright';
import { SqliteStore } from '@interaction/storage-sqlite';
import type { ActionAttempt, OperationReceiptCondition } from '@interaction/core';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../../../..');
const runId: string = JSON.parse(readFileSync(join(here, 'closed-evidence.json'), 'utf8')).runId;
const frozen = join(root, '.data/okx-storage-acceptance-20261017-v6');
const run = join(frozen, 'runs', runId), output = join(here, 'receipt-audit.json');
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
function requireFact(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
requireFact(process.argv.slice(2).length === 1 && process.argv[2] === '--execute', 'Explicit --execute required; preparation does not open a database');
requireFact(!existsSync(output), 'Single-use audit: prior output must not be overwritten');

// Closure/copy metadata are produced only by the separate settled-window step.
const closurePath = join(here, 'closed-evidence.json'), copyPath = join(here, 'audit-copy.json');
const closure = read(closurePath), copy = read(copyPath);
const activePath = join(frozen, 'active-run.json'), active = read(activePath);
const summaryPath = join(run, 'summary.json'), coveragePath = join(run, 'coverage-review.json');
const summary = read(summaryPath), coverage = read(coveragePath);
const metricsPath = join(run, 'metrics.jsonl');
const metrics = readFileSync(metricsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
requireFact(closure.runId === runId && closure.source === frozen && closure.runDirectory === run, 'Unexpected closed window');
requireFact(closure.run12FrozenBytesUnchanged === true && closure.noDatabaseOpened === true, 'Missing frozen-source closure evidence');
requireFact(active.runId === runId && active.state === 'finished' && active.finishedAt, 'Run is not formally finished');
requireFact(summary.runId === runId && summary.finishedAt && !summary.diagnosticFailure, 'Missing settled summary');
requireFact(active.taskId === closure.taskId && summary.taskId === closure.taskId, 'Closed task binding mismatch');
requireFact(summary.providerSettlement?.settled === true && !summary.providerSettlement.remainingPendingRequestIds?.length, 'Provider settlement incomplete');
requireFact(sha(summaryPath) === closure.summarySha256, 'Closed summary changed');
const source = join(frozen, 'engine/engine.sqlite'), directory = resolve(copy.engineDirectory);
const owned = dirname(directory), markerPath = join(owned, 'ownership.json'), database = join(directory, 'engine.sqlite');
requireFact(dirname(owned) === realpathSync(tmpdir()) && basename(owned).startsWith('bie-run13-receipt-audit-'), 'Copy is outside the exclusive temporary namespace');
requireFact(directory === join(owned, 'engine') && realpathSync(owned) === owned && realpathSync(directory) === directory, 'Copy path is redirected');
requireFact(copy.source === source && copy.runDirectory === run && copy.databaseOpened === false, 'Copy binding mismatch');
requireFact(equal(read(markerPath), copy), 'Copy ownership mismatch');
requireFact(!lstatSync(database).isSymbolicLink() && lstatSync(database).nlink === 1, 'Copy must be a regular independent file');
requireFact(lstatSync(database).isFile() && lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(), 'Invalid database file');
requireFact(lstatSync(database).ino !== lstatSync(source).ino || lstatSync(database).dev !== lstatSync(source).dev, 'Frozen database cannot be the audit copy');
for (const path of [source, database]) for (const suffix of ['-wal', '-shm']) requireFact(!existsSync(path + suffix), 'Unexpected database sidecar before audit');
requireFact(copy.sha256 === closure.sourceDatabase.sha256 && sha(source) === copy.sha256 && sha(database) === copy.sha256, 'Closed source/copy hash mismatch');
requireFact(lstatSync(database).size === copy.bytes, 'Copy size mismatch');
const ids: string[] = coverage.newlySucceededExplorationAttemptIds;
requireFact(Array.isArray(ids) && ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'Invalid new receipt selection');
requireFact(ids.length === summary.newSuccessfulExplorationAttempts, 'Summary/coverage success count mismatch');
const start = Date.parse(active.startedAt), finish = Date.parse(summary.finishedAt);
requireFact(Number.isFinite(start) && Number.isFinite(finish) && start <= finish, 'Missing window time bounds');

const codePaths = ['packages/core/src/engine.ts', 'packages/core/src/coverage-reconciliation.ts', 'packages/browser/src/index.ts',
  'packages/browser/src/document-coverage.ts', 'packages/adapter-playwright/src/owner-dependency-codec.ts',
  'packages/storage-sqlite/src/index.ts'];
const inputs = [closurePath, copyPath, markerPath, activePath, summaryPath, coveragePath, metricsPath, fileURLToPath(import.meta.url),
  ...codePaths.map(path => join(root, path))];
const hashesBefore = Object.fromEntries(inputs.map(path => [path, sha(path)]));
const report: Record<string, any> = {
  format: 'settled-new-receipt-audit-v1', createdAt: new Date().toISOString(), runId, taskId: closure.taskId,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  moduleResolution: Object.fromEntries(['@interaction/browser', '@interaction/core', '@interaction/storage-sqlite'].map(name => [name, import.meta.resolve(name)])),
  sourceRevision: closure.sourceCodeRevision, runDirectory: run, engineDirectory: directory,
  inputHashesBefore: hashesBefore, databaseBeforeOpen: { bytes: copy.bytes, sha256: copy.sha256 },
  selection: { source: 'coverage-review.newlySucceededExplorationAttemptIds', attemptIds: ids },
  retainedDiagnostics: { reference: '../real-okx-11/receipt-audit.json', sha256: 'd9ee7835cccc5ace2141ec786eb70d4bfaa12e39148bb1e3423bfd1517c2aee5',
    scope: 'Prior wire/graph collector diagnostics are cited, not rerun or asserted for this window.' },
  boundaries: ['Only new exported successful exploration receipts are queried; unknown debt remains in the settled exports.',
    'Document condition coverage is not strict/target/source arrival or cross-session semantic novelty.',
    'Boundary transition proves only the recorded exit; it grants no checkpoint/operation arrival.',
    'passed is audit-process validation, not exploration completion or a performance result.'],
  receipts: [], batches: [], passed: false,
};
let store: SqliteStore | undefined, engine: BrowserEngine | undefined, phase = 'constructor', closed = false;
let driverCalls = 0, beforeQuery: number | undefined, beforeEngine: number | undefined;
const writes: Record<string, Record<string, number>> = {}, sqlChanges: Record<string, number> = {};
const originalDriver = PlaywrightAdapter.prototype.createDriver;
PlaywrightAdapter.prototype.createDriver = () => { driverCalls++; throw Error('Offline audit forbids driver creation'); };
function watchWrites(target: object, layer: string) {
  for (const method of ['put', 'event', 'recordRequest'] as const) {
    const original = (target as any)[method];
    if (typeof original !== 'function') continue;
    (target as any)[method] = (...args: unknown[]) => {
      const counts = writes[phase] ??= {}, key = `${layer}.${method}`; counts[key] = (counts[key] ?? 0) + 1;
      if (phase === 'query') throw Error(`Receipt query attempted write: ${key}`);
      return original.apply(target, args);
    };
  }
}
try {
  store = new SqliteStore(directory);
  const total = () => (store!.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  sqlChanges.sqliteConstructor = total(); watchWrites(store, 'backing');
  const originals = ids.map(id => store!.require<ActionAttempt>('attempt', id));
  for (const attempt of originals) {
    const exploration = attempt.purpose !== 'recovery' && (attempt.purpose === 'exploration'
      || attempt.executionProfile === 'interface-exploration' || attempt.executionProfile === 'observed-ui-exploration');
    requireFact(attempt.status === 'succeeded' && exploration, 'Exported receipt is not a successful exploration');
    requireFact(Date.parse(attempt.startedAt) >= start && Date.parse(attempt.finishedAt ?? '') <= finish && attempt.afterId, 'Receipt is outside the settled window or lacks its after observation');
  }
  beforeEngine = total();
  engine = new BrowserEngine({ persistence: store });
  sqlChanges.engineConstructor = total() - beforeEngine;
  report.constructorReceiptChanges = originals.filter(attempt => !equal(attempt, engine!.store.require('attempt', attempt.id))).map(attempt => attempt.id);
  requireFact(report.constructorReceiptChanges.length === 0, 'Constructor changed selected receipt evidence');
  watchWrites(engine.store, 'host'); phase = 'query';
  // Defense in depth: raw SQL writes are forbidden as well as public mutations.
  store.db.pragma('query_only = ON');
  beforeQuery = total();
  const results = new Map<string, OperationReceiptCondition>();
  const sessions = [...new Set(originals.map(attempt => attempt.sessionId))];
  for (const sessionId of sessions) {
    const attemptIds = originals.filter(attempt => attempt.sessionId === sessionId).map(attempt => attempt.id);
    const response = engine.operationReceiptConditions(sessionId, { attemptIds });
    report.batches.push({ sessionId, attemptIds });
    requireFact(response.sessionId === sessionId && equal(response.results.map(result => result.source.attemptId), attemptIds), 'SDK batch response order/binding mismatch');
    for (const result of response.results) results.set(result.source.attemptId, result);
  }
  const observations = new Map<string, Observation>();
  const observation = (sessionId: string, id: string) => {
    const key = `${sessionId}:${id}`; if (!observations.has(key)) observations.set(key, engine!.observation(sessionId, id)); return observations.get(key)!;
  };
  const snapshot = (o: Observation) => ({ id: o.id, capturedAt: o.capturedAt, url: o.url,
    boundaryKeys: (o.boundaries ?? []).map(boundary => boundary.key) });
  for (const attempt of originals) {
    const receiptCondition = results.get(attempt.id)!;
    requireFact(receiptCondition && [receiptCondition.identityAuthorized, receiptCondition.replayAuthorized,
      receiptCondition.currentExecution, receiptCondition.arrivalVerified].every(value => value === false), 'Receipt granted an unexpected authority');
    const before = observation(attempt.sessionId, attempt.beforeId), after = observation(attempt.sessionId, attempt.afterId!);
    const row: Record<string, unknown> = { attemptId: attempt.id, sessionId: attempt.sessionId, originalStatus: attempt.status,
      purpose: attempt.purpose, executionProfile: attempt.executionProfile, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt,
      beforeId: attempt.beforeId, afterId: attempt.afterId, before: snapshot(before), after: snapshot(after),
      action: { id: attempt.action.id, kind: attempt.action.kind, label: attempt.action.label, value: attempt.action.value,
        localId: attempt.action.localId, controlId: attempt.action.controlId, boundary: attempt.action.boundary }, receiptCondition };
    if (attempt.action.boundary?.intent === 'exit') {
      const transition = engine.interactionTransition(attempt.sessionId, attempt.beforeId, attempt.afterId!);
      row.boundaryExitTransition = { verified: transition.verified, documentChanged: transition.documentChanged,
        exited: transition.exited, entered: transition.entered, navigated: transition.navigated,
        beforeBoundaryKeys: snapshot(before).boundaryKeys, afterBoundaryKeys: snapshot(after).boundaryKeys };
    }
    report.receipts.push(row);
  }
  // This single audit also reads the failed recovery's bounded retained facts.
  // No verifier, checkpoint recovery or browser method is invoked after closure.
  report.recoveryEvidence = [];
  const projectedObservation = (o: Observation) => ({ id: o.id, sessionId: o.sessionId, capturedAt: o.capturedAt,
    url: o.url, stable: o.stable, gaps: o.gaps, context: o.context, instanceScope: o.instanceScope,
    canonicalSha256: createHash('sha256').update(o.canonical).digest('hex'),
    controlCount: o.controls.length, boundaryKeys: (o.boundaries ?? []).map(boundary => boundary.key),
    dialogControls: o.controls.filter(c => c.role === 'dialog' || ['Close', 'Go to OKX Wallet'].includes(c.name ?? '')).map(c => ({
      localId: c.localId, role: c.role, name: c.name, visible: c.visible, enabled: c.enabled, identityId: c.identityId,
    })) });
  for (const row of metrics.filter(row => row.type === 'recovery.returned')) {
    const result = row.data.result;
    const selected = metrics.find(row => row.type === 'plugin.event' && row.data.type === 'recovery.selected' && row.data.data.checkpointId === result.checkpointId);
    requireFact(selected && result.sessionId === selected.data.sessionId, 'Recovery selection binding mismatch');
    const checkpoint = engine.store.require<import('@interaction/core').Checkpoint>('checkpoint', result.checkpointId);
    requireFact(checkpoint.sessionId === result.sessionId && checkpoint.observationId === selected.data.data.sourceObservationId, 'Checkpoint/source mismatch');
    const attempts = result.attemptIds.map((id: string) => engine!.store.require<ActionAttempt>('attempt', id));
    requireFact(attempts.every((a: ActionAttempt) => a.sessionId === result.sessionId && a.purpose === 'recovery' && Date.parse(a.startedAt) >= start && Date.parse(a.finishedAt ?? '') <= finish), 'Recovery attempts outside this window');
    const observationIds = [...new Set<string>([checkpoint.observationId, selected.data.data.currentObservationId, result.observationId,
      ...attempts.flatMap((a: ActionAttempt) => [a.beforeId, a.afterId]).filter(Boolean)])];
    report.recoveryEvidence.push({ resultId: result.id, status: result.status, reason: result.reason, checks: result.checks,
      selected: selected.data.data, checkpoint: { id: checkpoint.id, observationId: checkpoint.observationId, context: checkpoint.context,
        predicates: checkpoint.predicates, acceptable: checkpoint.acceptable, path: checkpoint.path },
      observations: observationIds.map(id => projectedObservation(observation(result.sessionId, id))),
      attempts: attempts.map((a: ActionAttempt) => ({ id: a.id, status: a.status, purpose: a.purpose, beforeId: a.beforeId,
        afterId: a.afterId, startedAt: a.startedAt, finishedAt: a.finishedAt, kind: a.action.kind, label: a.action.label })),
      conclusion: 'Recorded facts only. Neither action success nor matching pixels establishes checkpoint arrival.' });
  }
  sqlChanges.query = total() - beforeQuery;
  requireFact(sqlChanges.query === 0 && !Object.values(writes.query ?? {}).some(Boolean) && driverCalls === 0, 'Read-only query contract violated');
  report.statistics = { selected: ids.length, actualSuccess: [...results.values()].filter(result => result.actualSuccess).length,
    conditionVerified: [...results.values()].filter(result => result.conditionVerified).length,
    byStatus: Object.fromEntries([...new Set([...results.values()].map(result => result.status))].map(status => [status, [...results.values()].filter(result => result.status === status).length])) };
} catch (error) {
  report.error = String(error); process.exitCode = 1;
} finally {
  if (store) {
    try {
      const total = (store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      if (beforeQuery !== undefined) sqlChanges.query = total - beforeQuery;
      else if (beforeEngine !== undefined) sqlChanges.engineConstructor = total - beforeEngine;
    } catch (error) { report.sqlAccountingError = String(error); process.exitCode = 1; }
  }
  phase = 'close';
  try { if (engine) await engine.close(); else store?.close(); closed = true; }
  catch (error) { report.closeError = String(error); process.exitCode = 1; try { store?.close(); closed = true; } catch { /* Preserve failed-close evidence. */ } }
  PlaywrightAdapter.prototype.createDriver = originalDriver;
  report.closed = closed; report.writeCalls = writes; report.sqlChanges = sqlChanges; report.driverCalls = driverCalls;
  report.finishedAt = new Date().toISOString();
  try {
    report.inputHashesAfter = Object.fromEntries(inputs.map(path => [path, sha(path)]));
    report.inputsUnchanged = equal(hashesBefore, report.inputHashesAfter);
    report.sourceUnchanged = sha(source) === copy.sha256;
    report.databaseAfterClose = { bytes: lstatSync(database).size, sha256: sha(database),
      sidecars: ['-wal', '-shm'].filter(suffix => existsSync(database + suffix)) };
    report.copyPhysicalBytesChanged = report.databaseAfterClose.sha256 !== copy.sha256 || report.databaseAfterClose.bytes !== copy.bytes || report.databaseAfterClose.sidecars.length > 0;
    requireFact(report.inputsUnchanged && report.sourceUnchanged, 'Audit inputs or frozen source changed');
    requireFact(closed && equal(read(markerPath), copy) && realpathSync(owned) === owned, 'Cleanup ownership or close verification failed');
    rmSync(owned, { recursive: true }); report.temporaryCopyRemoved = !existsSync(owned);
    report.passed = !report.error && !report.closeError && !report.sqlAccountingError && !report.copyPhysicalBytesChanged && report.temporaryCopyRemoved;
    if (!report.passed) process.exitCode = 1;
  } catch (error) { report.finalizationError = String(error); process.exitCode = 1; }
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ output, passed: report.passed, statistics: report.statistics, closed: report.closed,
  temporaryCopyRemoved: report.temporaryCopyRemoved, error: report.error ?? report.finalizationError }, null, 2));
