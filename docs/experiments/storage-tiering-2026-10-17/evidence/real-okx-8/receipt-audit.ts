/** Offline only. Run after the runner has closed, against an exclusive temporary
 * engine-directory COPY. This script never starts a driver or an ExplorerStore.
 * node --import tsx --conditions=development <this-file> \
 *   --engine-dir /private/.../owned-copy/engine --run-dir /.../runs/<run-id> --output /.../new-audit.json
 * Preparing/typechecking this file does not run it. Original evidence is only read.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BrowserEngine, PlaywrightAdapter, type ActionAttempt, type Observation } from '@interaction/browser';
import { hash, type OperationReceiptCondition } from '@interaction/core';
import { SqliteStore } from '@interaction/storage-sqlite';
import type { Task } from '@interaction/explorer-plugin';

type ObjectValue = Record<string, unknown>;
type Metric = { at: string; runId: string; type: string; data: ObjectValue };
type EventRow = { sequence: number; session_id: string; type: string; at: string; json: string };
const SCRIPT = fileURLToPath(import.meta.url), ROOT = resolve(dirname(SCRIPT), '../../../../..');
const SHA = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const strings = (value: unknown) => array(value).filter((item): item is string => typeof item === 'string');
const errorText = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const isInside = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function counts<T>(rows: T[], key: (row: T) => string) {
  const result: Record<string, number> = {};
  for (const row of rows) { const name = key(row); result[name] = (result[name] || 0) + 1; }
  return result;
}
function flags(argv: string[]) {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--engine-dir', '--run-dir', '--output'].includes(key) || !value || value.startsWith('--') || out.has(key)) throw Error('INVALID_ARGUMENT');
    out.set(key, value);
  }
  if (out.size !== 3) throw Error('REQUIRES_ENGINE_DIR_RUN_DIR_OUTPUT');
  return Object.fromEntries([...out].map(([key, value]) => [key.slice(2), resolve(value)]));
}
function noLinks(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw Error('COPY_MUST_NOT_CONTAIN_SYMLINKS_OR_HARDLINKS');
  if (stat.isDirectory()) for (const entry of readdirSync(path)) noLinks(join(path, entry));
}
function fileRecord(path: string) {
  if (!existsSync(path)) return { path, exists: false as const };
  const bytes = readFileSync(path);
  return { path, exists: true as const, bytes: bytes.byteLength, sha256: SHA(bytes) };
}
const databaseFiles = (directory: string) => ['', '-wal', '-shm'].map(suffix => fileRecord(join(directory, 'engine.sqlite' + suffix)));
function analysisSource() {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim();
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages', 'scripts/okx-storage-acceptance.ts', 'pnpm-lock.yaml'], {cwd: ROOT, encoding: 'utf8'}).split('\0').filter(Boolean).sort();
  const hashes = files.filter(path => /\.(ts|tsx|json|yaml)$/.test(path)).map(path => [path, SHA(readFileSync(join(ROOT, path)))]);
  const packages = hashes.filter(([path]) => path.startsWith('packages/'));
  return { revision, node: process.version, execArgv: process.execArgv, treeSha256: SHA(JSON.stringify(hashes)),
    packageTreeSha256: SHA(JSON.stringify(packages)), script: SCRIPT, scriptSha256: SHA(readFileSync(SCRIPT)), sourceFiles: hashes,
    moduleResolution: Object.fromEntries(['@interaction/browser', '@interaction/core', '@interaction/storage-sqlite'].map(name => [name, import.meta.resolve(name)])) };
}
function classify(attempt: ActionAttempt) {
  const exploration = attempt.purpose !== 'recovery' && (attempt.purpose === 'exploration' || attempt.executionProfile === 'interface-exploration' || attempt.executionProfile === 'observed-ui-exploration');
  const reentry = !!attempt.repetitionSource, recovery = attempt.purpose === 'recovery';
  return { category: recovery ? 'recovery' : reentry ? 'reentry' : exploration ? 'exploration' : 'other', exploration, recovery, reentry,
    leafExploration: exploration && !reentry, necessaryReentryVerified: false,
    basis: recovery ? 'persisted-purpose-recovery' : reentry ? 'persisted-repetitionSource' : exploration ? 'persisted-purpose-or-execution-profile' : 'no-exploration-or-recovery-tag' };
}
function graphSummary(observation: Observation | undefined, localId: string | undefined) {
  if (!observation) return { observationAvailable: false, graphPresent: false };
  const graph = observation.ownerDependencies;
  const base = { observationAvailable: true, observationId: observation.id, documentId: observation.documentId,
    instanceScope: observation.instanceScope, browserSessionId: observation.navigation?.browserSessionId,
    url: observation.url, capturedAt: observation.capturedAt, ruleVersion: observation.ruleVersion,
    gaps: observation.gaps, criticalGaps: observation.gaps.filter(gap => gap.critical),
    graphPresent: !!graph, targetCount: observation.controls.filter(control => control.localId === localId).length };
  if (!graph) return base;
  const roots = graph.roots.filter(root => root.localId === localId), closureIds = new Set(roots.map(root => root.closureId));
  return { ...base, version: graph.version, inventoryComplete: graph.inventoryComplete, complete: graph.complete,
    reasons: graph.reasons, limits: graph.limits, retainedJsonBytes: Buffer.byteLength(JSON.stringify(graph)),
    counts: { roots: graph.roots.length, closures: graph.closures.length, nodes: graph.nodes.length, references: graph.references.length, selectors: graph.selectorIds.length },
    incompleteNodes: graph.nodes.filter(node => !node.complete).map(node => ({id: node.id, reasons: node.reasons})),
    targetRoots: roots, targetClosures: graph.closures.filter(closure => closureIds.has(closure.id)).map(closure => ({id: closure.id, complete: closure.complete, reasons: closure.reasons, nodes: closure.nodeIds.length, references: closure.referenceIds.length})),
    limitNote: 'retainedJsonBytes describes stored JSON, not the collector internal byte counter; limits/reasons remain authoritative.' };
}
function dispatchSummary(attempt: ActionAttempt, before: Observation | undefined, after: Observation | undefined) {
  const witness = after?.ownerDependencyDispatch;
  if (!witness) return { present: false, afterAvailable: !!after };
  const checks = { version: witness.version === 'browser-owner-dispatch-v1', sessionId: witness.sessionId === attempt.sessionId,
    beforeId: !!before && witness.beforeId === before.id, actionId: witness.actionId === attempt.action.id,
    actionKey: witness.actionKey === hash(attempt.action), graphKey: !!before?.ownerDependencies && witness.graphKey === hash(before.ownerDependencies),
    contextKey: !!before && witness.contextKey === hash(before.context), documentId: !!before && witness.documentId === before.documentId,
    instanceScope: !!before && witness.instanceScope === before.instanceScope,
    browserSessionId: !!before && witness.browserSessionId === before.navigation?.browserSessionId, url: !!before && witness.url === before.url };
  const dispatchAt = Date.parse(witness.capturedAt), startedAt = Date.parse(attempt.startedAt), afterAt = Date.parse(after!.capturedAt);
  const boundedTime = [dispatchAt, startedAt, afterAt].every(Number.isFinite) && startedAt <= dispatchAt && dispatchAt <= afterAt;
  return { present: true, witness, expectedActionKey: hash(attempt.action), expectedGraphKey: before?.ownerDependencies ? hash(before.ownerDependencies) : undefined,
    expectedContextKey: before ? hash(before.context) : undefined, checks, boundedTime,
    coordinatesAndHashesMatch: Object.values(checks).every(Boolean), note: 'Diagnostic correspondence only; SDK result remains the coverage decision. Missing witnesses are never reconstructed.' };
}
function planAudit(task: Task) {
  const rows = task.plan.flatMap((item, occurrence) => item.conditionCompletion ? [{occurrence, itemId: item.id, title: item.title,
    required: item.required, status: item.status, conditionCompletion: item.conditionCompletion, resolvedBy: item.resolvedBy,
    coverageResolvedBy: item.coverageResolvedBy, scope: item.scope, attemptEvidence: item.attempts.map(attempt => ({outcome: attempt.outcome, evidence: attempt.evidence}))}] : []);
  return { planRows: task.plan.length, conditionCompletionRows: rows.length, byStatus: counts(rows, row => row.conditionCompletion.status),
    byReason: counts(rows, row => row.conditionCompletion.reason), rows, rowCountsAreNotOperationCounts: true };
}

async function main() {
  const paths = flags(process.argv.slice(2)), engineDir = realpathSync(paths['engine-dir']), runDir = realpathSync(paths['run-dir']), output = paths.output;
  const temp = realpathSync(tmpdir());
  if (!isInside(engineDir, temp) || engineDir === temp || !existsSync(join(engineDir, 'engine.sqlite'))) throw Error('ENGINE_DIR_MUST_BE_EXISTING_EXCLUSIVE_TEMPORARY_COPY');
  if (isInside(engineDir, runDir) || isInside(runDir, engineDir) || isInside(output, runDir) || isInside(output, engineDir)) throw Error('INPUT_AND_OUTPUT_DIRECTORIES_MUST_BE_SEPARATE');
  if (existsSync(output) || !isAbsolute(output) || realpathSync(dirname(output)) !== dirname(output)) throw Error('OUTPUT_MUST_BE_NEW_WITH_CANONICAL_EXISTING_PARENT');
  noLinks(engineDir);
  const inputFiles = ['summary.json', 'task-before.json', 'task-after.json', 'coverage-review.json', 'metrics.jsonl'];
  for (const optional of ['plan-occurrences-before.json', 'plan-occurrences-after.json']) if (existsSync(join(runDir, optional))) inputFiles.push(optional);
  const inputHashesBefore = inputFiles.map(name => fileRecord(join(runDir, name)));
  const read = <T>(name: string) => JSON.parse(readFileSync(join(runDir, name), 'utf8')) as T;
  const summary = read<ObjectValue>('summary.json'), taskBefore = read<Task>('task-before.json'), taskAfter = read<Task>('task-after.json'), coverage = read<ObjectValue>('coverage-review.json');
  const metrics = readFileSync(join(runDir, 'metrics.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Metric);
  const ready = metrics.filter(metric => metric.type === 'run.ready'), preflight = metrics.find(metric => metric.type === 'run.preflight');
  if (ready.length !== 1 || !text(summary.finishedAt) || taskBefore.id !== taskAfter.id || summary.taskId !== taskAfter.id) throw Error('REQUIRES_SETTLED_MATCHING_RUN_EXPORTS');
  const finishedAt = Date.parse(String(summary.finishedAt));
  if (!Number.isFinite(finishedAt) || metrics.some(metric => metric.runId !== summary.runId)) throw Error('INVALID_OR_MIXED_RUN_EXPORTS');
  // The original runner's control marker is read only. Never probe its lock or DB.
  const activePath = join(dirname(dirname(runDir)), 'active-run.json');
  let activeControl: ObjectValue | undefined;
  if (existsSync(activePath)) {
    const active = JSON.parse(readFileSync(activePath, 'utf8')) as ObjectValue;
    inputHashesBefore.push(fileRecord(activePath));
    if (active.runId !== summary.runId || active.state !== 'finished' || !active.finishedAt) throw Error('RUN_CONTROL_NOT_FORMALLY_FINISHED');
    activeControl = {path: activePath, runId: active.runId, state: active.state, finishedAt: active.finishedAt};
  }
  if (metrics.some(metric => metric.type === 'close.failed') || summary.diagnosticFailure) throw Error('RUN_CLOSE_OR_DIAGNOSTIC_FAILURE_REQUIRES_MANUAL_REVIEW');
  const baselineCursors = object(object(ready[0].data.cursors).engine), finalCursors = object(object(summary.cursors).engine);
  const sessions = new Set([...taskBefore.rounds, ...taskAfter.rounds].map(round => round.sessionId));
  for (const sid of [...Object.keys(baselineCursors), ...Object.keys(finalCursors)]) sessions.add(sid);
  for (const metric of metrics) { const sid = text(metric.data.sessionId); if (sid) sessions.add(sid); }
  for (const field of ['unknownAttempts', 'unkeyedSuccessfulAttempts', 'historicalUnkeyedSuccessfulAttempts']) for (const value of array(coverage[field])) { const sid = text(object(value).sessionId); if (sid) sessions.add(sid); }
  if (!sessions.size) throw Error('NO_TASK_SESSIONS');
  const report: ObjectValue = { format: 'offline-operation-receipt-audit-v1', createdAt: new Date().toISOString(),
    runId: summary.runId, taskId: taskAfter.id, engineDir, runDir, output, runtime: analysisSource(), runSource: preflight?.data.source,
    inputHashesBefore, databaseBeforeOpen: databaseFiles(engineDir), passed: false,
    closedRunEvidence: {summaryFinishedAt: summary.finishedAt, activeControl,
      exportOnlyNote: activeControl ? undefined : 'No adjacent original control marker; caller must have confirmed closure before making the exclusive temporary copy.'},
    boundaries: ['Only an exclusive temporary engine copy is opened. The original run directory is read as exported text.',
      'SqliteStore initialization and BrowserEngine recoverStore can mutate the copy; all phases and receipt status changes are reported.',
      'Batch queries are synchronous and run once per relevant session. Query costs are offline audit costs, not production performance.',
      'Receipt condition coverage, actual execution, recovery arrival, plan completion and reentry necessity are separate claims.',
      'Document condition keys are session/document scoped and are never counted as cross-session new coverage.',
      'No claim of exhaustion; plan row counts and unique receipt IDs are not semantic operation counts.'] };
  const checks: { name: string; passed: boolean; actual?: unknown; expected?: unknown }[] = [];
  const check = (name: string, passed: boolean, actual?: unknown, expected?: unknown) => checks.push({name, passed, actual, expected});
  let store: SqliteStore | undefined, host: BrowserEngine | undefined, phase = 'constructor';
  const writes: Record<string, {put: number; event: number; recordRequest: number}> = {};
  const writesAt = () => writes[phase] ||= {put: 0, event: 0, recordRequest: 0};
  let hostPut = 0, hostEvents = 0, driverCalls = 0;
  const originalDriver = PlaywrightAdapter.prototype.createDriver;
  PlaywrightAdapter.prototype.createDriver = function() { driverCalls++; throw Error('OFFLINE_AUDIT_DRIVER_FORBIDDEN'); };
  try {
    store = new SqliteStore(engineDir);
    report.databaseAfterSqliteOpen = databaseFiles(engineDir);
    const originalPut = store.put.bind(store), originalEvent = store.event.bind(store), originalRequest = store.recordRequest.bind(store);
    store.put = ((...args: Parameters<typeof originalPut>) => { writesAt().put++; return originalPut(...args); }) as typeof store.put;
    store.event = (...args: Parameters<typeof originalEvent>) => { writesAt().event++; return originalEvent(...args); };
    store.recordRequest = (...args: Parameters<typeof originalRequest>) => { writesAt().recordRequest++; return originalRequest(...args); };
    const beforeAttempts = [...sessions].flatMap(sid => store!.list<ActionAttempt>('attempt', sid));
    const byId = new Map(beforeAttempts.map(attempt => [attempt.id, attempt]));
    const knownMetricIds = new Set(metrics.filter(metric => metric.type === 'attempt.completed').map(metric => String(metric.data.id)));
    const events = [...sessions].flatMap(sid => store!.db.prepare("SELECT sequence,session_id,type,at,json FROM events WHERE session_id=? AND type IN ('action.started','action.completed','action.unknown') ORDER BY sequence").all(sid) as EventRow[]);
    const perAttempt = new Map<string, { sequence: number; sessionId: string; type: string; at: string; status?: string }[]>();
    for (const event of events) {
      const value = object(JSON.parse(event.json)), id = text(value.id);
      if (!id) continue;
      const list = perAttempt.get(id) || []; list.push({sequence: event.sequence, sessionId: event.session_id, type: event.type, at: event.at, status: text(value.status)}); perAttempt.set(id, list);
    }
    const membership = beforeAttempts.map(attempt => {
      const cursor = Number(baselineCursors[attempt.sessionId] ?? 0), rows = perAttempt.get(attempt.id) || [];
      const start = rows.filter(row => row.type === 'action.started');
      const baseline = start.some(row => row.sequence <= cursor), afterCursor = start.some(row => row.sequence > cursor);
      const newWindow = !baseline && afterCursor && start.every(row => Date.parse(row.at) <= finishedAt);
      const status = baseline ? 'historical' : newWindow ? 'window' : 'ambiguous';
      return {attemptId: attempt.id, sessionId: attempt.sessionId, status, baselineCursor: cursor, originalStatus: attempt.status,
        startedAt: attempt.startedAt, completionMetricPresent: knownMetricIds.has(attempt.id), actionEvents: rows};
    });
    const members = new Map(membership.map(member => [member.attemptId, member]));
    const windowAttempts = beforeAttempts.filter(attempt => members.get(attempt.id)?.status === 'window');
    const historicalUnknown = beforeAttempts.filter(attempt => members.get(attempt.id)?.status === 'historical' && ['unknown', 'executing'].includes(attempt.status));
    const selected = [...windowAttempts.filter(attempt => ['succeeded', 'unknown', 'executing'].includes(attempt.status)), ...historicalUnknown];
    check('unique_attempt_ids', byId.size === beforeAttempts.length, beforeAttempts.length, byId.size);
    check('all_attempt_window_memberships_resolved', membership.every(member => member.status !== 'ambiguous'), membership.filter(member => member.status === 'ambiguous'));
    check('metric_attempt_ids_present_in_copy', [...knownMetricIds].every(id => byId.has(id)), [...knownMetricIds].filter(id => !byId.has(id)));
    const normalizedCounts = (value: unknown) => Object.fromEntries(Object.entries(object(value)).filter(([, count]) => Number(count) !== 0).sort(([a], [b]) => a.localeCompare(b)));
    check('window_status_counts_match_summary', equal(normalizedCounts(counts(windowAttempts, attempt => attempt.status)), normalizedCounts(summary.attemptCounts)), counts(windowAttempts, attempt => attempt.status), summary.attemptCounts);
    const successfulExploration = windowAttempts.filter(attempt => attempt.status === 'succeeded' && classify(attempt).exploration).map(attempt => attempt.id).sort();
    check('successful_exploration_ids_match_coverage_review', equal(successfulExploration, strings(coverage.newlySucceededExplorationAttemptIds).sort()), successfulExploration, strings(coverage.newlySucceededExplorationAttemptIds).sort());
    check('successful_exploration_count_matches_summary', successfulExploration.length === summary.newSuccessfulExplorationAttempts, successfulExploration.length, summary.newSuccessfulExplorationAttempts);
    report.windowMembership = {method: 'Retained action.started sequence compared with run.ready per-session engine cursor; missing cursor is zero for newly discovered sessions. Missing start evidence is ambiguous, never guessed from timestamps.',
      baselineCursors, finalCursors, historicalAttemptIds: membership.filter(member => member.status === 'historical').map(member => member.attemptId), windowAttemptIds: windowAttempts.map(attempt => attempt.id),
      historicalUnknownAttemptIds: historicalUnknown.map(attempt => attempt.id), membership, allWindowAttempts: windowAttempts.map(attempt => ({id: attempt.id, sessionId: attempt.sessionId, status: attempt.status, classification: classify(attempt), purpose: attempt.purpose, kind: attempt.action.kind, label: attempt.action.label, input: attempt.action.value, beforeId: attempt.beforeId, afterId: attempt.afterId})) };
    report.historicalAttemptProjection = beforeAttempts.filter(attempt => members.get(attempt.id)?.status === 'historical').map(attempt => ({
      id: attempt.id, sessionId: attempt.sessionId, status: attempt.status, purpose: attempt.purpose,
      beforeId: attempt.beforeId, afterId: attempt.afterId, repetitionSource: attempt.repetitionSource, recoverySegment: attempt.recoverySegment,
      action: {kind: attempt.action.kind, label: attempt.action.label, value: attempt.action.value,
        controlId: attempt.action.controlId, localId: attempt.action.localId, target: attempt.action.target},
    }));
    host = new BrowserEngine({persistence: store});
    report.databaseAfterHostConstructor = databaseFiles(engineDir);
    const constructorChanges = beforeAttempts.flatMap(before => {
      const after = host!.store.require<ActionAttempt>('attempt', before.id);
      return equal(before, after) ? [] : [{attemptId: before.id, sessionId: before.sessionId, beforeStatus: before.status, afterStatus: after.status, beforeReason: before.reason, afterReason: after.reason, beforeSha256: SHA(JSON.stringify(before)), afterSha256: SHA(JSON.stringify(after))}];
    });
    report.constructorReceiptChanges = constructorChanges;
    const hp = host.store.put.bind(host.store), he = host.store.event.bind(host.store);
    host.store.put = ((...args: Parameters<typeof hp>) => { hostPut++; return hp(...args); }) as typeof host.store.put;
    host.store.event = (...args: Parameters<typeof he>) => { hostEvents++; return he(...args); };
    phase = 'query';
    const totalChangesBefore = (store.db.prepare('SELECT total_changes() AS value').get() as {value: number}).value;
    const batchTimes: {sessionId: string; receipts: number; elapsedMs: number}[] = [], results: OperationReceiptCondition[] = [];
    for (const sid of sessions) {
      const attemptIds = selected.filter(attempt => attempt.sessionId === sid).map(attempt => attempt.id);
      if (!attemptIds.length) continue;
      const begin = performance.now(), response = host.operationReceiptConditions(sid, {attemptIds});
      batchTimes.push({sessionId: sid, receipts: attemptIds.length, elapsedMs: performance.now() - begin});
      check(`batch_source_order:${sid}`, response.sessionId === sid && equal(response.results.map(result => result.source.attemptId), attemptIds), response.results.map(result => result.source), {sessionId: sid, attemptIds});
      results.push(...response.results);
    }
    const totalChangesAfter = (store.db.prepare('SELECT total_changes() AS value').get() as {value: number}).value;
    const receiptRows = results.map(result => {
      const original = byId.get(result.source.attemptId)!;
      const current = host!.store.require<ActionAttempt>('attempt', original.id);
      let before: Observation | undefined, after: Observation | undefined, beforeError: string | undefined, afterError: string | undefined;
      try { before = host!.observation(original.sessionId, original.beforeId); } catch (error) { beforeError = errorText(error); }
      try { if (original.afterId) after = host!.observation(original.sessionId, original.afterId); } catch (error) { afterError = errorText(error); }
      return { attemptId: original.id, sessionId: original.sessionId, windowMembership: members.get(original.id)?.status,
        classification: classify(original), purpose: original.purpose, executionProfile: original.executionProfile,
        originalStatus: original.status, auditCopyStatus: current.status, startedAt: original.startedAt, finishedAt: original.finishedAt,
        beforeId: original.beforeId, afterId: original.afterId, requestId: original.requestId,
        action: {id: original.action.id, kind: original.action.kind, label: original.action.label, value: original.action.value, localId: original.action.localId, controlId: original.action.controlId, source: original.action.source, target: original.action.target, replayable: original.action.replayable, actionKey: hash(original.action)},
        repetitionSource: original.repetitionSource, recoverySegment: original.recoverySegment,
        receiptCondition: result,
        ...(result.status === 'unavailable' ? {diagnostic: {beforeReadError: beforeError, afterReadError: afterError, before: graphSummary(before, original.action.localId), after: graphSummary(after, original.action.localId), dispatch: dispatchSummary(original, before, after)}} : {}) };
    });
    check('false_authority_flags', results.every(result => result.identityAuthorized === false && result.replayAuthorized === false && result.currentExecution === false && result.arrivalVerified === false));
    check('query_has_no_record_or_event_writes', hostPut === 0 && hostEvents === 0 && !Object.values(writes.query || {}).some(Boolean) && totalChangesBefore === totalChangesAfter,
      {hostPut, hostEvents, backing: writes.query || {put: 0, event: 0, recordRequest: 0}, totalChangesBefore, totalChangesAfter});
    check('driver_never_created', driverCalls === 0, driverCalls, 0);
    check('unknown_receipts_never_become_success', receiptRows.filter(row => ['unknown', 'executing'].includes(row.originalStatus)).every(row => !row.receiptCondition.actualSuccess && !row.receiptCondition.conditionVerified));
    report.receipts = receiptRows;
    report.receiptStatistics = {audited: receiptRows.length, windowReceipts: receiptRows.filter(row => row.windowMembership === 'window').length,
      byClassification: counts(receiptRows, row => row.classification.category), byOriginalStatus: counts(receiptRows, row => row.originalStatus),
      byConditionStatus: counts(receiptRows, row => row.receiptCondition.status), byPolicy: counts(receiptRows, row => row.receiptCondition.policy || 'none'),
      byReason: counts(receiptRows, row => row.receiptCondition.reason), actualSuccess: results.filter(result => result.actualSuccess).length,
      conditionVerified: results.filter(result => result.conditionVerified).length, documentKeysAreNotCrossSessionNovelty: true,
      newSemanticCoverage: {status: 'not-established-by-this-audit'}, batchTimes, costScope: 'offline audit only; diagnostics and hashing costs excluded from batchTimes'};
    report.taskConditionCompletion = {before: planAudit(taskBefore), after: planAudit(taskAfter),
      linkedReceiptRows: taskAfter.plan.flatMap((item, occurrence) => {
        const id = item.conditionCompletion?.source?.attemptId;
        const receipt = id && receiptRows.find(row => row.attemptId === id);
        return receipt ? [{occurrence, itemId: item.id, completion: item.conditionCompletion, receiptSource: receipt.receiptCondition.source,
          auditConditionVerified: receipt.receiptCondition.conditionVerified, sameSourceSession: item.conditionCompletion?.source?.sessionId === receipt.sessionId}] : [];
      }), relationNote: 'Task completion may require multiple retained sources. A verified single receipt is not sufficient to conclude its plan row should be completed.'};
    report.coverageReviewProjection = {newlySucceededExplorationAttemptIds: coverage.newlySucceededExplorationAttemptIds,
      newOperationConditionCandidates: coverage.newOperationConditionCandidates, unkeyedSuccessfulAttemptIds: coverage.unkeyedSuccessfulAttemptIds,
      newlyResolvedPlanOccurrences: array(coverage.newlyResolvedPlanOccurrences).length, refreshedPlanEvidence: array(coverage.refreshedPlanEvidence).length,
      unknownAttempts: coverage.unknownAttempts, pendingDispatch: coverage.pendingDispatch, unverifiedRecoveries: coverage.unverifiedRecoveries,
      recoveries: coverage.recoveries, recoveryFailures: coverage.recoveryFailures, recoveryFollowup: coverage.recoveryFollowup,
      candidatePolicyIsNotReceiptCoveragePolicy: true, necessaryReentryRequiresFollowupReview: true};
    report.databaseAfterQueries = databaseFiles(engineDir);
  } catch (error) { report.error = errorText(error); }
  finally {
    phase = 'close';
    try { if (host) { await host.close(); store = undefined; } else store?.close(); }
    catch (error) { report.closeError = errorText(error); try { store?.close(); } catch { /* Preserve the first close error. */ } }
    PlaywrightAdapter.prototype.createDriver = originalDriver;
    report.databaseAfterClose = databaseFiles(engineDir);
    report.copyPhysicalBytesChanged = !equal(report.databaseBeforeOpen, report.databaseAfterClose);
    report.writeCounts = writes; report.hostQueryWrites = {put: hostPut, event: hostEvents}; report.driverCalls = driverCalls;
    const inputHashesAfter = inputHashesBefore.map(row => fileRecord(row.path));
    report.inputHashesAfter = inputHashesAfter;
    check('original_text_inputs_unchanged', equal(inputHashesBefore, inputHashesAfter));
    try {
      const runtimeAfter = analysisSource(), runtimeBefore = object(report.runtime);
      report.runtimeAfter = runtimeAfter;
      check('analyzed_package_code_and_script_unchanged', runtimeAfter.packageTreeSha256 === runtimeBefore.packageTreeSha256 && runtimeAfter.scriptSha256 === runtimeBefore.scriptSha256,
        {packageTreeSha256: runtimeAfter.packageTreeSha256, scriptSha256: runtimeAfter.scriptSha256},
        {packageTreeSha256: runtimeBefore.packageTreeSha256, scriptSha256: runtimeBefore.scriptSha256});
    } catch (error) { report.sourceVerificationError = errorText(error); check('analyzed_package_code_and_script_unchanged', false); }
    report.checks = checks;
    report.passed = !report.error && !report.closeError && checks.every(item => item.passed) && driverCalls === 0;
    report.finishedAt = new Date().toISOString();
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  }
  console.log(JSON.stringify({output, passed: report.passed, error: report.error, failedChecks: checks.filter(item => !item.passed), receiptStatistics: report.receiptStatistics}, null, 2));
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) await main();
