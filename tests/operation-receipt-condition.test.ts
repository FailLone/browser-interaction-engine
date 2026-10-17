import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it, vi } from 'vitest';
import { BrowserEngine, PlaywrightAdapter, hash, type ActionAttempt, type ActionCandidate, type Observation, type Session, type ControlReviewRecord, type BoundaryExitResult } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { pageOf } from './helpers.js';

type Row = { id: string; sessionId?: string };
const kinds = ['session', 'observation', 'action', 'attempt', 'frontier', 'identity', 'hypothesis', 'control-review', 'scope', 'continuation', 'boundary-exit-result', 'exploration-group'];
async function seed(mode: 'stable' | 'changed' | 'portable') {
  const html = `<!doctype html><main><ul><li data-record="target"><input id="field" aria-label="Field"
    oninput="window.actualBranch=document.querySelector('#mode-owner')?.dataset.record||'portable'"><a href="/target-record">Target record</a></li>
    ${mode === 'portable' ? '' : '<li id="mode-owner" data-record="A"><i id="mode" role="button" aria-label="Hidden mode" aria-expanded="false" hidden></i><a href="/mode-record">Mode record</a></li>'}</ul></main>`;
  const site = createServer((_req, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const host = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const session = await host.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}/`, headless: true,
      exploration: 'controls', settleMs: 0, observeTimeoutMs: 100, evidence: { enabled: false } });
    const initial = host.observation(session.id), field = initial.controls.find(c => c.selector === '#field')!;
    const [review] = await host.reviewControls(session.id, { observationId: initial.id, source: 'owned-receipt-condition-fixture', reviews: [
      { localId: field.localId, kind: 'fill', samples: ['A', 'B'], risk: 'interface', replayable: false, reason: 'Exercise local input', evidence: ['Owned local input handler'] },
    ] });
    const before = host.observation(session.id), candidate = host.actions(session.id).find(a => a.localId === field.localId && a.kind === 'fill' && a.value === 'A')!;
    if (mode === 'changed') await pageOf(host).locator('#mode-owner').evaluate(node => node.setAttribute('data-record', 'B'));
    const attempt = await host.execute(session.id, candidate.id, `receipt-${mode}`, 'B');
    const after = host.observation(session.id, attempt.afterId!);
    const actualBranch = await pageOf(host).evaluate(() => (window as unknown as { actualBranch: string }).actualBranch);
    const saved = { sid: session.id, attemptId: attempt.id, reviewId: review.id, candidate, before, after, attempt, actualBranch,
      rows: Object.fromEntries(kinds.map(kind => [kind, host.store.list<Row>(kind, session.id)])) };
    const writes = vi.spyOn(host.store, 'put'), events = vi.spyOn(host.store, 'event');
    const proof = host.operationReceiptCondition(session.id, { attemptId: attempt.id });
    expect(writes).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
    expect(attempt.status).toBe('succeeded'); expect(attempt.action.value).toBe('B'); expect(candidate.value).toBe('A');
    return { ...saved, proof };
  } finally { await host.close(); await new Promise<void>(resolve => site.close(() => resolve())); }
}
type Seed = Awaited<ReturnType<typeof seed>>;
let stable: Promise<Seed> | undefined;
const stableSeed = () => stable ??= seed('stable');
function clone(input: Seed, change?: (rows: Record<string, Row[]>) => void) {
  const rows = structuredClone(input.rows); change?.(rows);
  const store = new MemoryStore(); for (const [kind, values] of Object.entries(rows)) for (const value of values) store.put(kind, value);
  const host = new BrowserEngine({ persistence: store });
  return { host, store, query: () => host.operationReceiptCondition(input.sid, { attemptId: input.attemptId }) };
}

it('own-source checkpoint: reports the real B success without crediting retained owner A conditions', async () => {
  const s = await seed('changed');
  expect(s.actualBranch).toBe('B'); expect(s.after.ownerDependencyDispatch).toBeUndefined();
  expect(s.proof).toMatchObject({ actualSuccess: true, conditionVerified: false, status: 'unavailable', reason: 'dispatch_witness_missing',
    source: { sessionId: s.sid, attemptId: s.attemptId, beforeId: s.before.id, afterId: s.after.id, actionKey: hash(s.attempt.action) },
    identityAuthorized: false, replayAuthorized: false, currentExecution: false, arrivalVerified: false });
  const artifact = process.env.BIE_RECEIPT_CONDITION_EVIDENCE;
  if (artifact) { mkdirSync(dirname(artifact), { recursive: true }); writeFileSync(artifact, JSON.stringify({ actualBranch: s.actualBranch,
    actualAttempt: s.attempt, beforeId: s.before.id, beforeGraphKey: hash(s.before.ownerDependencies), afterWitness: s.after.ownerDependencyDispatch ?? null,
    legacyExactReceiptShortcut: s.attempt.status === 'succeeded' && !!s.attempt.afterId && s.attempt.beforeId === s.before.id,
    publicReceiptCondition: s.proof, expected: 'actualSuccess remains true; retained condition proof is unavailable' }, null, 2) + '\n', { flag: 'wx' }); }
});

it('returns a document-bound actual supplied-value sample without attaching, writing or using the original candidate value', async () => {
  const s = await stableSeed(), f = clone(s), attach = vi.spyOn(PlaywrightAdapter.prototype, 'createDriver').mockImplementation(() => { throw Error('Read-only query must not attach'); });
  try {
    const writes = vi.spyOn(f.store, 'put'), events = vi.spyOn(f.store, 'event');
    const first = f.query();
    expect(first).toMatchObject({ actualSuccess: true, conditionVerified: true, status: 'document', policy: 'browser-document-coverage-v1',
      source: { actionId: s.candidate.id, actionKey: hash(s.attempt.action) }, identityAuthorized: false, replayAuthorized: false, currentExecution: false, arrivalVerified: false });
    expect(first.source.actionKey).not.toBe(hash(s.candidate)); expect(first.conditionKey).toBeTruthy();
    f.store.put('action', { ...s.candidate, value: 'unrelated-same-ID-candidate' }); writes.mockClear();
    expect(f.query()).toEqual(first);
    expect(attach).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
  } finally { attach.mockRestore(); await f.host.close(); }
});

it('retains the existing portable policy and rechecks its review authority without requiring a document witness', async () => {
  const s = await seed('portable'), f = clone(s, rows => { delete (rows.observation.find(r => r.id === s.after.id)! as Observation).ownerDependencyDispatch; });
  try {
    expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: true, status: 'portable', reason: 'portable_operation_sample' });
    const review = f.store.require<ControlReviewRecord>('control-review', s.reviewId); review.status = 'revoked'; f.store.put('control-review', review);
    expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: false, reason: 'source_authority_unavailable' });
  } finally { await f.host.close(); }
});

it.each(['unknown', 'executing', 'dirty', 'boundary', 'revoked'] as const)('re-reads %s debt or authority on the next query while retaining actual success', async change => {
  const s = await stableSeed(), f = clone(s);
  try {
    expect(f.query().conditionVerified).toBe(true);
    if (change === 'unknown' || change === 'executing') f.store.put('attempt', { ...s.attempt, id: 'new-unsettled', status: change, afterId: undefined });
    if (change === 'dirty') { const session = f.host.session(s.sid); session.dirty = true; f.store.put('session', session); }
    if (change === 'boundary') f.store.put('boundary-exit-result', { id: 'debt', sessionId: s.sid, reviewId: 'review', attemptId: s.attemptId,
      beforeId: s.before.id, afterId: s.after.id, inputPhase: 'click', closedAfterMove: false, dispatched: 'succeeded', closed: false, parentReady: false,
      preserved: false, status: 'unverified', evidence: ['Unverified exit'] } satisfies BoundaryExitResult);
    if (change === 'revoked') { const review = f.store.require<ControlReviewRecord>('control-review', s.reviewId); review.status = 'revoked'; f.store.put('control-review', review); }
    expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: false, status: 'unavailable' });
  } finally { await f.host.close(); }
});

it.each(['legacy-graph', 'legacy-witness', 'wrong-value', 'wrong-owner', 'incomplete-after', 'unknown-receipt'] as const)('fails closed for %s rather than equating execution with conditions', async change => {
  const s = await stableSeed(), f = clone(s, rows => {
    const before = rows.observation.find(r => r.id === s.before.id)! as Observation, after = rows.observation.find(r => r.id === s.after.id)! as Observation;
    const attempt = rows.attempt.find(r => r.id === s.attemptId)! as ActionAttempt;
    if (change === 'legacy-graph') delete before.ownerDependencies;
    if (change === 'legacy-witness') delete after.ownerDependencyDispatch;
    if (change === 'wrong-value') attempt.action.value = 'A';
    if (change === 'wrong-owner') attempt.action.observationId = 'foreign';
    if (change === 'incomplete-after') after.gaps.push({ code: 'INCOMPLETE', critical: true, message: 'Unavailable result' });
    if (change === 'unknown-receipt') attempt.status = 'unknown';
  });
  try { expect(f.query()).toMatchObject({ actualSuccess: change !== 'unknown-receipt', conditionVerified: false, status: 'unavailable' }); }
  finally { await f.host.close(); }
});

it('keeps portable receipts unavailable when their target identity decision is missing or unresolved', async () => {
  const s = await seed('portable');
  for (const state of ['missing', 'pending'] as const) {
    const f = clone(s, rows => {
      const before = rows.observation.find(r => r.id === s.before.id)! as Observation;
      before.controls.find(c => c.localId === s.attempt.action.localId)!.hypothesisId = 'target-hypothesis';
      if (state === 'pending') rows.hypothesis.push({ id: 'target-hypothesis', sessionId: s.sid, status: 'pending' } as Row);
    });
    try { expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: false,
      reason: state === 'missing' ? 'source_identity_unverified' : 'identity_pending' }); }
    finally { await f.host.close(); }
  }
});

it('uses the document instance contract for retained logical ambiguity and still rereads revoked review authority', async () => {
  const s = await stableSeed(), f = clone(s, rows => {
    // These fields affect logical identity. The captured instances, raw graph,
    // actual dispatch and review conditions remain the original retained facts.
    for (const row of rows.observation) for (const c of (row as Observation).controls) c.hypothesisId = 'pending-logical-identity';
    rows.hypothesis.push({ id: 'pending-logical-identity', sessionId: s.sid, status: 'pending' } as Row);
  });
  const attach = vi.spyOn(PlaywrightAdapter.prototype, 'createDriver').mockImplementation(() => { throw Error('Read-only query must not attach'); });
  try {
    const put = vi.spyOn(f.store, 'put'), event = vi.spyOn(f.store, 'event');
    expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: true, status: 'document',
      identityAuthorized: false, arrivalVerified: false, replayAuthorized: false, currentExecution: false });
    expect(put).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled();
    const review = f.store.require<ControlReviewRecord>('control-review', s.reviewId); review.status = 'revoked'; f.store.put('control-review', review);
    expect(f.query()).toMatchObject({ actualSuccess: true, conditionVerified: false, reason: 'source_authority_unavailable' });
  } finally { attach.mockRestore(); await f.host.close(); }
});
