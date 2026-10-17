import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { beforeAll, expect, it, vi } from 'vitest';
import { InteractionEngine } from '@interaction/core';
import { BrowserEngine, PlaywrightAdapter, type ActionAttempt, type OperationReceiptCondition, type Observation, type BoundaryExitResult } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';

type Row = { id: string; sessionId?: string };
type Seed = { sessionId: string; attemptIds: string[]; rows: Record<string, Row[]> };
const kinds = ['session', 'observation', 'action', 'attempt', 'frontier', 'identity', 'hypothesis', 'control-review', 'scope', 'continuation', 'boundary-exit-result', 'exploration-group'];
let seed: Seed;
beforeAll(async () => {
  const retained = process.env.BIE_RECEIPT_BATCH_SEED;
  if (retained && existsSync(retained)) { seed = JSON.parse(gunzipSync(readFileSync(retained)).toString('utf8')); return; }
  // Four genuine native receipts, retained once for both pinned baseline and candidate.
  // The hidden owner makes portable sampling unavailable; document proof is exercised.
  const html = '<!doctype html><main><ul><li data-record="target"><input id="flag" type="checkbox" aria-label="Flag"><a href="/target-record">Target record</a></li><li data-record="A"><i id="mode" role="button" aria-label="Hidden mode" aria-expanded="false" hidden></i><a href="/mode-record">Mode record</a></li></ul></main>';
  const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const host = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const session = await host.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}/`, headless: true,
      exploration: 'controls', settleMs: 0, observeTimeoutMs: 100, evidence: { enabled: false } });
    const attemptIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const observation = host.observation(session.id), control = observation.controls.find(c => c.selector === '#flag')!;
      const action = host.actions(session.id).find(a => a.localId === control.localId && a.kind === 'check' && a.value === !control.checked)!;
      const attempt = await host.execute(session.id, action.id, `real-receipt-${i}`);
      expect(attempt.status).toBe('succeeded'); expect(attempt.afterId).toBeTruthy(); attemptIds.push(attempt.id);
    }
    seed = { sessionId: session.id, attemptIds, rows: Object.fromEntries(kinds.map(kind => [kind, host.store.list<Row>(kind, session.id)])) };
    if (retained) { mkdirSync(dirname(retained), { recursive: true }); writeFileSync(retained, gzipSync(JSON.stringify(seed)), { flag: 'wx' }); }
  } finally { await host.close(); await new Promise<void>(resolve => site.close(() => resolve())); }
});

function fixture<T extends BrowserEngine>(Host: new (options: ConstructorParameters<typeof BrowserEngine>[0]) => T) {
  const store = new MemoryStore(); for (const [kind, rows] of Object.entries(seed.rows)) for (const row of rows) store.put(kind, row);
  return { store, host: new Host({ persistence: store }) };
}
function count(host: BrowserEngine) {
  // RetainedPersistence binds backing reads at construction. Spying on the backing
  // store afterwards misses require/list and cannot establish traversal cost.
  const require = vi.spyOn(host.store, 'require'), list = vi.spyOn(host.store, 'list'), get = vi.spyOn(host.store, 'get');
  const snapshot = () => ({ require: require.mock.calls.length, list: list.mock.calls.length, get: get.mock.calls.length,
    requireByKind: histogram(require.mock.calls), listByKind: histogram(list.mock.calls), getByKind: histogram(get.mock.calls),
    listedRows: list.mock.results.reduce((sum, r) => sum + (r.type === 'return' && Array.isArray(r.value) ? r.value.length : 0), 0) });
  const clear = () => { require.mockClear(); list.mockClear(); get.mockClear(); };
  return { snapshot, clear };
}
function histogram(calls: readonly (readonly unknown[])[]) {
  const out: Record<string, number> = {}; for (const call of calls) out[String(call[0])] = (out[String(call[0])] || 0) + 1; return out;
}
const repeated = () => [...seed.attemptIds, seed.attemptIds[0], seed.attemptIds[2], seed.attemptIds[1], seed.attemptIds[3]];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const singles = (host: BrowserEngine, attemptIds = seed.attemptIds) => attemptIds.map(attemptId => host.operationReceiptCondition(seed.sessionId, { attemptId }));
const batch = (host: BrowserEngine, attemptIds = seed.attemptIds) => host.operationReceiptConditions(seed.sessionId, { attemptIds }).results;
const sourceManifest = () => Object.fromEntries(['packages/core/src/engine.ts', 'packages/core/src/coverage-reconciliation.ts', 'packages/browser/src/index.ts', 'tests/operation-receipt-batch.test.ts'].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
function artifact(path: string | undefined, value: unknown) {
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
}
function denied(sessionId: string, attemptId: string, reason = 'custom-policy'): OperationReceiptCondition {
  return { actualSuccess: false, conditionVerified: false, status: 'unavailable', reason, source: { sessionId, attemptId }, evidence: [],
    identityAuthorized: false, replayAuthorized: false, currentExecution: false, arrivalVerified: false };
}

it('baseline: records four distinct real receipts and eight single queries at the SDK store boundary', async () => {
  const f = fixture(BrowserEngine), reads = count(f.host);
  try {
    const distinctResults = singles(f.host), distinct = { queries: 4, calls: reads.snapshot(), results: distinctResults, resultSha256: digest(distinctResults) };
    reads.clear();
    const results = singles(f.host, repeated()), withDuplicates = { queries: 8, calls: reads.snapshot(), results, resultSha256: digest(results) };
    expect(distinctResults.every(r => r.actualSuccess && r.conditionVerified && r.status === 'document')).toBe(true);
    expect(results.slice(4)).toEqual([results[0], results[2], results[1], results[3]]);
    expect(distinct.calls.listByKind.attempt).toBeGreaterThan(0);
    expect(distinct.calls.listedRows).toBeGreaterThan(0);
    artifact(process.env.BIE_RECEIPT_BATCH_BASELINE, { distinctRealReceipts: 4, attemptIds: seed.attemptIds, distinct, withDuplicates,
      fixtureRowsSha256: digest(seed.rows), sourceSha256: sourceManifest(), timingClaim: false });
  } finally { await f.host.close(); }
});

it('preserves full single-query results while reducing ledger reads for four distinct receipts', async () => {
  const f = fixture(BrowserEngine), reads = count(f.host), writes = vi.spyOn(f.host.store, 'put'), events = vi.spyOn(f.host.store, 'event');
  const attach = vi.spyOn(PlaywrightAdapter.prototype, 'createDriver').mockImplementation(() => { throw Error('Read-only batch must not attach'); });
  try {
    const distinctResults = singles(f.host), singleDistinct = { queries: 4, calls: reads.snapshot(), results: distinctResults, resultSha256: digest(distinctResults) };
    reads.clear();
    const results = batch(f.host), batchDistinct = { queries: 4, calls: reads.snapshot(), results, resultSha256: digest(results) };
    expect(results).toEqual(distinctResults);
    expect(batchDistinct.calls.listByKind.attempt).toBeLessThan(singleDistinct.calls.listByKind.attempt);
    expect(batchDistinct.calls.listByKind.hypothesis).toBeLessThan(singleDistinct.calls.listByKind.hypothesis);
    expect(batchDistinct.calls.requireByKind.observation).toBeLessThan(singleDistinct.calls.requireByKind.observation);
    reads.clear();
    const duplicateResults = batch(f.host, repeated()), batchWithDuplicates = { queries: 8, calls: reads.snapshot(), results: duplicateResults, resultSha256: digest(duplicateResults) };
    expect(duplicateResults).toEqual([...results, results[0], results[2], results[1], results[3]]);
    // Per-item boundary/authority hooks still run for duplicates; only shared ledger scans disappear.
    expect(batchWithDuplicates.calls.listByKind.attempt).toBeLessThan(singleDistinct.calls.listByKind.attempt * 2);
    expect(batchWithDuplicates.calls.listByKind.hypothesis).toBe(batchDistinct.calls.listByKind.hypothesis);
    const referencePath = process.env.BIE_RECEIPT_BATCH_REFERENCE;
    if (referencePath) {
      const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
      expect(digest(seed.rows)).toBe(reference.fixtureRowsSha256);
      expect(singleDistinct.results).toEqual(reference.distinct.results);
      expect(batchDistinct.results).toEqual(reference.distinct.results);
      expect(batchWithDuplicates.results).toEqual(reference.withDuplicates.results);
    }
    expect(writes).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled();
    artifact(process.env.BIE_RECEIPT_BATCH_CANDIDATE, { distinctRealReceipts: 4, attemptIds: seed.attemptIds, singleDistinct, batchDistinct, batchWithDuplicates,
      fixtureRowsSha256: digest(seed.rows), sourceSha256: sourceManifest(), baselineReference: referencePath, fullResultEquality: true, timingClaim: false });
  } finally { attach.mockRestore(); await f.host.close(); }
});

it('keeps input order, duplicates, missing and foreign failures isolated, and empty batches empty', async () => {
  const f = fixture(BrowserEngine);
  try {
    const source = f.store.require<ActionAttempt>('attempt', seed.attemptIds[0]);
    f.store.put('attempt', { ...source, id: 'foreign-attempt', sessionId: 'foreign-session' });
    const ids = [seed.attemptIds[3], 'missing', seed.attemptIds[1], 'foreign-attempt', seed.attemptIds[3]];
    const response = f.host.operationReceiptConditions(seed.sessionId, { attemptIds: ids });
    expect(response.sessionId).toBe(seed.sessionId); expect(response.results).toEqual(singles(f.host, ids));
    expect(response.results.map(r => r.source.attemptId)).toEqual(ids);
    expect(response.results.map(r => r.conditionVerified)).toEqual([true, false, true, false, true]);
    const reads = count(f.host);
    expect(f.host.operationReceiptConditions('missing-session', { attemptIds: [] })).toEqual({ sessionId: 'missing-session', results: [] });
    expect(reads.snapshot()).toMatchObject({ require: 0, list: 0, get: 0 });
    expect(f.host.operationReceiptConditions('missing-session', { attemptIds: [seed.attemptIds[0]] }).results[0]).toMatchObject({ actualSuccess: false, conditionVerified: false, reason: 'evidence_unavailable' });
  } finally { await f.host.close(); }
});

it.each(['unknown', 'executing', 'dirty', 'boundary', 'pending'] as const)('re-reads %s on the next batch without changing actual successes', async change => {
  const f = fixture(BrowserEngine);
  try {
    const initial = batch(f.host);
    expect(initial.every(r => r.conditionVerified)).toBe(true);
    const source = f.store.require<ActionAttempt>('attempt', seed.attemptIds.at(-1)!);
    if (change === 'unknown' || change === 'executing') f.store.put('attempt', { ...source, id: 'new-unsettled', status: change, afterId: undefined });
    if (change === 'dirty') { const session = f.host.session(seed.sessionId); session.dirty = true; f.store.put('session', session); }
    if (change === 'boundary') f.store.put('boundary-exit-result', { id: 'debt', sessionId: seed.sessionId, reviewId: 'review', attemptId: source.id,
      beforeId: source.beforeId, afterId: source.afterId, inputPhase: 'click', closedAfterMove: false, dispatched: 'succeeded', closed: false, parentReady: false,
      preserved: false, status: 'unverified', evidence: ['Unverified exit'] } satisfies BoundaryExitResult);
    if (change === 'pending') f.store.put('hypothesis', { id: 'pending', sessionId: seed.sessionId, status: 'pending' });
    const results = batch(f.host);
    expect(results).toEqual(singles(f.host));
    // Instance-bound coverage does not depend on this logical identity ledger.
    if (change === 'pending') { expect(results).toEqual(initial); return; }
    const reason = { unknown: 'unknown_execution_outcome', executing: 'unknown_execution_outcome', dirty: 'dirty_session', boundary: 'boundary_exit_unverified' }[change];
    for (const result of results) expect(result).toMatchObject({ actualSuccess: true, conditionVerified: false, status: 'unavailable', reason });
  } finally { await f.host.close(); }
});

it('keeps custom unknown hooks per receipt, including the retained-reader availability check', async () => {
  class Custom extends BrowserEngine {
    calls = 0;
    protected override unverifiedRecoveryAttempts(sid: string) {
      const result = super.unverifiedRecoveryAttempts(sid); this.calls++;
      return this.calls === 2 ? [this.store.require<ActionAttempt>('attempt', seed.attemptIds[0])] : result;
    }
  }
  const a = fixture(Custom), b = fixture(Custom);
  try {
    const expected = singles(a.host), actual = batch(b.host);
    expect(actual).toEqual(expected); expect(b.host.calls).toBe(a.host.calls);
    expect(actual.map(r => r.conditionVerified)).toEqual([false, true, true, true]);
  } finally { await a.host.close(); await b.host.close(); }
});

it('keeps custom retained factories per receipt and does not let a first grant mask later denial', async () => {
  class Custom extends BrowserEngine {
    factories = 0;
    protected override retainedReceiptCoverageReader() {
      const reader = super.retainedReceiptCoverageReader(), deny = ++this.factories === 2;
      return Object.assign((...args: Parameters<typeof reader>) => deny ? undefined : reader(...args), { acceptsObservation: reader.acceptsObservation });
    }
  }
  const a = fixture(Custom), b = fixture(Custom);
  try {
    const expected = singles(a.host), actual = batch(b.host);
    expect(actual).toEqual(expected); expect(b.host.factories).toBe(4); expect(a.host.factories).toBe(4);
    expect(actual.map(r => r.conditionVerified)).toEqual([true, false, true, true]);
  } finally { await a.host.close(); await b.host.close(); }
});

it.each(['unknown', 'retained'] as const)('contains a throwing custom %s hook to its receipt and retries later items', async hook => {
  class Custom extends BrowserEngine {
    calls = 0;
    protected override unverifiedRecoveryAttempts(sid: string) {
      if (hook === 'unknown' && ++this.calls === 1) throw Error('one receipt unavailable');
      return super.unverifiedRecoveryAttempts(sid);
    }
    protected override retainedReceiptCoverageReader() {
      if (hook === 'retained' && ++this.calls === 1) throw Error('one receipt unavailable');
      return super.retainedReceiptCoverageReader();
    }
  }
  const a = fixture(Custom), b = fixture(Custom);
  try {
    const expected = singles(a.host), actual = batch(b.host);
    expect(actual).toEqual(expected);
    expect(actual[0]).toMatchObject({ actualSuccess: true, conditionVerified: false, reason: 'evidence_unavailable' });
    expect(actual.slice(1).every(r => r.conditionVerified)).toBe(true);
  } finally { await a.host.close(); await b.host.close(); }
});

it('honors a per-receipt denial hook and rechecks its authority in a new batch', async () => {
  class Custom extends BrowserEngine {
    revoked = false; calls = 0;
    protected override receiptConditionBlocker(attempt: ActionAttempt, before: Observation, after: Observation) {
      this.calls++;
      return this.revoked || attempt.id === seed.attemptIds[1] ? 'source_authority_unavailable' : super.receiptConditionBlocker(attempt, before, after);
    }
  }
  const f = fixture(Custom);
  try {
    expect(batch(f.host).map(r => r.conditionVerified)).toEqual([true, false, true, true]); expect(f.host.calls).toBe(4);
    f.host.revoked = true;
    for (const result of batch(f.host)) expect(result).toMatchObject({ actualSuccess: true, conditionVerified: false, reason: 'source_authority_unavailable' });
    expect(f.host.calls).toBe(8);
  } finally { await f.host.close(); }
});

it('honors a custom single-query override and contains its exceptions per input', async () => {
  class Custom extends BrowserEngine {
    calls: string[] = [];
    override operationReceiptCondition(sid: string, input: { attemptId: string }): OperationReceiptCondition {
      this.calls.push(input.attemptId);
      if (input.attemptId === seed.attemptIds[1]) throw Error('custom query unavailable');
      return denied(sid, input.attemptId);
    }
  }
  const f = fixture(Custom);
  try {
    const results = batch(f.host);
    expect(f.host.calls).toEqual(seed.attemptIds);
    expect(results.map(r => r.reason)).toEqual(['custom-policy', 'evidence_unavailable', 'custom-policy', 'custom-policy']);
    expect(results.every(r => !r.actualSuccess && !r.conditionVerified)).toBe(true);
  } finally { await f.host.close(); }
});

it.each(['core', 'browser'] as const)('honors a %s prototype single-query replacement after defaults were captured', async surface => {
  const target = surface === 'core' ? InteractionEngine.prototype : BrowserEngine.prototype;
  const replacement = vi.spyOn(target, 'operationReceiptCondition').mockImplementation((sid, input) => denied(sid, input.attemptId, 'prototype-policy'));
  const f = fixture(BrowserEngine);
  try {
    expect(batch(f.host)).toEqual(seed.attemptIds.map(id => denied(seed.sessionId, id, 'prototype-policy')));
    expect(replacement).toHaveBeenCalledTimes(4);
  } finally { replacement.mockRestore(); await f.host.close(); }
});

it('does not treat a prototype protected-hook replacement as a cacheable default', async () => {
  const target = BrowserEngine.prototype as unknown as { unverifiedRecoveryAttempts(sid: string): ActionAttempt[] }, original = target.unverifiedRecoveryAttempts;
  let calls = 0;
  const replacement = vi.spyOn(target, 'unverifiedRecoveryAttempts').mockImplementation(function(this: BrowserEngine, sid: string) {
    calls++; return calls === 2 ? [this.store.require<ActionAttempt>('attempt', seed.attemptIds[0])] : original.call(this, sid);
  });
  const f = fixture(BrowserEngine);
  try {
    const expected = singles(f.host), singleCalls = calls; calls = 0; replacement.mockClear();
    expect(batch(f.host)).toEqual(expected); expect(calls).toBe(singleCalls);
    expect(expected.map(r => r.conditionVerified)).toEqual([false, true, true, true]);
  } finally { replacement.mockRestore(); await f.host.close(); }
});
