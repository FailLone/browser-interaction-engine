import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { BrowserEngine, hash, type EngineHooks, type ActionAttempt, type ContinueExplorationInput, type ContinuationRecord, type InterventionResponseRecord } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { pageOf } from './helpers.js';

const reason = { source: 'upper', evidence: ['Ready to validate and continue the bounded scope'] };
async function fixture(hooks: EngineHooks = {}) {
  let submissions = 0;
  const site = createServer((req, res) => {
    if (req.url === '/commit') { submissions++; res.end('ok'); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<form onsubmit="event.preventDefault();fetch(\'/commit\',{method:\'POST\'})"><button>Commit</button></form><section aria-label="Inputs"><input aria-label="Amount"><input aria-label="Search"></section>');
  });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const directory = mkdtempSync(join(tmpdir(), 'continuation-')), engine = new BrowserEngine({ persistence: new SqliteStore(directory), hooks });
  const url = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const session = await engine.createSession({ url, headless: true, regionExploration: 'review', settleMs: 20, observeTimeoutMs: 600 });
  return { engine, sid: session.id, url, directory, submissions: () => submissions, close: async () => { await engine.close(); await new Promise<void>(r => site.close(() => r())); rmSync(directory, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const input = (t: Fixture): ContinueExplorationInput => ({ ...reason, requestId: crypto.randomUUID(), observationId: t.engine.observation(t.sid).id });
const recovery = (t: Fixture): ContinueExplorationInput => ({ ...input(t), recovery: { url: t.url + '/', context: {}, boundaryKeys: [], predicates: [] } });
async function submit(t: Fixture) {
  const action = t.engine.actions(t.sid).find(a => a.label === 'Commit')!;
  const attempt = await t.engine.execute(t.sid, action.id, 'commit-once');
  expect(attempt.status).toBe('succeeded'); expect(t.submissions()).toBe(1); expect(t.engine.session(t.sid).dirty).toBe(true); return attempt;
}
async function approveAmount(t: Fixture) {
  const m = t.engine.regionReviewMaterial(t.sid);
  await t.engine.reviewRegions(t.sid, { ...reason, observationId: m.observationId, regions: [{ key: 'inputs', label: 'Inputs', candidateIds: [m.candidates.find(c => c.label === 'Inputs')!.id] }] });
  const g = t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.kind === 'reviewed-region')!;
  await t.engine.decideExplorationGroup(t.sid, g.id, g.revision, { ...reason, mode: 'sample', memberKeys: [g.members.find(m => m.label === 'Amount')!.key] });
}

it('revalidates manual page changes, preserves unanswered work, and does not count fresh observation as execution', async () => {
  const t = await fixture(); try {
    await approveAmount(t); const before = input(t);
    await pageOf(t.engine).getByLabel('Search', { exact: true }).fill('changed externally');
    const result = await t.engine.continueExploration(t.sid, before); await t.engine.waitForIdle();
    expect(result.continuation.status).toBe('started'); expect(result.continuation.afterId).not.toBe(before.observationId);
    expect(t.engine.list<ActionAttempt>(t.sid, 'attempt').map(a => a.action.label)).toEqual(['Amount']);
    expect(t.engine.interventionMaterial(t.sid).items.some(i => i.kind === 'region')).toBe(true);
    expect(t.engine.report(t.sid).completionAudit.exhaustive).toBe(false);
  } finally { await t.close(); }
});

it('rejects stale continuation and never rewrites its observation to a newer version', async () => {
  const t = await fixture(); try {
    await approveAmount(t); const request = input(t); await t.engine.observe(t.sid);
    const result = await t.engine.continueExploration(t.sid, request);
    expect(result.continuation).toMatchObject({ status: 'needs_review', started: false, error: { code: 'STALE_CONTINUATION' } });
    expect(result.continuation.beforeId).toBe(request.observationId); expect(t.engine.session(t.sid).actionCount).toBe(0);
  } finally { await t.close(); }
});

it('does not clear business state on caller assertion or a mismatched UI expectation', async () => {
  const t = await fixture(); try {
    await submit(t);
    const wrong = recovery(t); wrong.recovery!.url += 'elsewhere';
    const mismatch = await t.engine.continueExploration(t.sid, wrong);
    expect(mismatch.continuation.status).toBe('needs_review'); expect(mismatch.continuation.checks).toContainEqual({ name: 'expected-url', result: 'fail' });
    expect(mismatch.material.items.find(i => i.subject.resultId === mismatch.continuation.id)?.evidence.messages.some(m => m.includes('expected-url: fail'))).toBe(true);
    const missingVerifier = await t.engine.continueExploration(t.sid, recovery(t));
    expect(missingVerifier.continuation.status).toBe('needs_review');
    expect(missingVerifier.continuation.checks.some(c => c.name === 'external-state-verifier' && c.result === 'unknown')).toBe(true);
    expect(t.engine.session(t.sid).dirty).toBe(true); expect(t.submissions()).toBe(1); expect(t.engine.list(t.sid, 'attempt')).toHaveLength(1);
  } finally { await t.close(); }
});

it('verifies external business recovery, keeps old outcomes, and resumes only the approved sample', async () => {
  let verifiedIds: string[] = [];
  const t = await fixture({ verifyExternalRecovery: (m, ctx) => { verifiedIds = m.attemptIds; expect(ctx.observation.url).toBe(m.request.recovery!.url); return { result: 'pass', evidence: ['Application test verifier checked the restored server fixture'] }; } });
  try {
    const attempt = await submit(t); await approveAmount(t);
    const result = await t.engine.continueExploration(t.sid, recovery(t)); await t.engine.waitForIdle();
    expect(result.continuation.status).toBe('started'); expect(result.continuation.verifiedRecovery?.attemptIds).toEqual([attempt.id]); expect(verifiedIds).toEqual([attempt.id]);
    expect(t.engine.session(t.sid).dirty).toBe(false); expect(t.submissions()).toBe(1);
    expect(t.engine.list<ActionAttempt>(t.sid, 'attempt').map(a => a.action.label)).toEqual(['Commit', 'Amount']);
    expect(t.engine.store.get<ActionAttempt>('attempt', attempt.id)?.status).toBe('succeeded');
  } finally { await t.close(); }
});

for (const outcome of ['fail', 'unknown', 'error'] as const) it(`keeps a ${outcome} external verification pending without automatic execution`, async () => {
  const t = await fixture({ verifyExternalRecovery: () => { if (outcome === 'error') throw new Error('Verifier unavailable'); return { result: outcome, evidence: ['Server state not confirmed'] }; } });
  try {
    await submit(t); await approveAmount(t);
    const result = await t.engine.continueExploration(t.sid, recovery(t));
    expect(result.continuation.status).toBe('needs_review'); expect(t.engine.session(t.sid)).toMatchObject({ dirty: true, actionCount: 1 }); expect(t.submissions()).toBe(1);
  } finally { await t.close(); }
});

it('rejects a scene that changes during external verification and retains the dirty marker', async () => {
  let change: () => Promise<void>;
  const t = await fixture({ verifyExternalRecovery: async () => { await change(); return { result: 'pass', evidence: ['Server checked'] }; } });
  try {
    await submit(t); change = async () => { await pageOf(t.engine).getByLabel('Amount').fill('99'); };
    const result = await t.engine.continueExploration(t.sid, recovery(t));
    expect(result.continuation).toMatchObject({ status: 'needs_review', started: false });
    expect(result.continuation.checks.some(c => c.name === 'scene-after-verifier' && c.result === 'fail')).toBe(true);
    expect(t.engine.session(t.sid).dirty).toBe(true);
  } finally { await t.close(); }
});

it('ignores a late verifier answer and can retry with a new current request', async () => {
  let finish: (() => void) | undefined, ready = false;
  const t = await fixture({ verifyExternalRecovery: () => ready ? { result: 'pass', evidence: ['Current verification'] } : new Promise(r => { finish = () => r({ result: 'pass', evidence: ['Late answer'] }); }) });
  try {
    await submit(t); const result = await t.engine.continueExploration(t.sid, recovery(t));
    expect(result.continuation.status).toBe('needs_review'); finish!(); await new Promise(r => setTimeout(r, 20));
    expect(t.engine.session(t.sid)).toMatchObject({ dirty: true, actionCount: 1 });
    ready = true; const retried = await t.engine.continueExploration(t.sid, recovery(t)); await t.engine.waitForIdle();
    expect(retried.continuation.status).toBe('started'); expect(t.submissions()).toBe(1);
  } finally { await t.close(); }
});

it('deduplicates continuation requests and does not pause or rerun a completed request', async () => {
  const t = await fixture(); try {
    await approveAmount(t); const request = input(t);
    const [a, b] = await Promise.all([t.engine.continueExploration(t.sid, request), t.engine.continueExploration(t.sid, request)]);
    expect(a.continuation.id).toBe(b.continuation.id); await t.engine.waitForIdle();
    const before = t.engine.session(t.sid), again = await t.engine.continueExploration(t.sid, request);
    expect(again.continuation.id).toBe(a.continuation.id); expect(t.engine.session(t.sid)).toEqual(before);
    expect(t.engine.list(t.sid, 'continuation')).toHaveLength(1); expect(t.engine.list(t.sid, 'attempt')).toHaveLength(1);
    expect(() => t.engine.continueExploration(t.sid, { ...request, evidence: ['different payload'] })).toThrow(/Request ID/);
  } finally { await t.close(); }
});

it('persists interrupted answers and unknown operations across restart without replaying either', async () => {
  const t = await fixture(); let restarted: BrowserEngine | undefined;
  try {
    const attempt = await submit(t);
    // Persist the state at the execution-intent boundary; recoverStore handles
    // the same records produced by an actual process kill (see crash.test.ts).
    t.engine.store.put('attempt', { ...attempt, status: 'executing' });
    const request = recovery(t), pending: ContinuationRecord = { id: hash({ sid: t.sid, requestId: request.requestId, kind: 'continuation' }), sessionId: t.sid, requestId: request.requestId, input: request, at: new Date().toISOString(), beforeId: request.observationId, status: 'verifying', started: false, checks: [] };
    t.engine.store.put('continuation', pending); await t.engine.close();
    restarted = new BrowserEngine({ persistence: new SqliteStore(t.directory), hooks: { verifyExternalRecovery: m => ({ result: m.attemptIds.includes(attempt.id) ? 'pass' : 'unknown', evidence: ['Application fixture reset verified'] }) } });
    expect(restarted.list<ContinuationRecord>(t.sid, 'continuation')[0].status).toBe('interrupted');
    expect((await restarted.continueExploration(t.sid, request)).continuation.status).toBe('interrupted');
    expect(restarted.list<ContinuationRecord>(t.sid, 'continuation')).toHaveLength(1);
    await restarted.observe(t.sid);
    const blocked = await restarted.continueExploration(t.sid, { ...reason, observationId: restarted.observation(t.sid).id, requestId: 'restart-without-recovery' });
    expect(blocked.continuation.status).toBe('needs_review'); expect(t.submissions()).toBe(1);
    expect(restarted.interventionMaterial(t.sid).items.some(i => i.kind === 'execution' && i.blocking === 'session')).toBe(true);
    const resumed = await restarted.continueExploration(t.sid, { ...request, observationId: restarted.observation(t.sid).id, requestId: 'restart-verified' }); await restarted.waitForIdle();
    expect(resumed.continuation.status).toBe('started'); expect(t.submissions()).toBe(1);
    expect(restarted.store.get<ActionAttempt>('attempt', attempt.id)?.status).toBe('unknown');
    expect(restarted.interventionMaterial(t.sid).items.some(i => i.kind === 'execution')).toBe(false);
  } finally { await restarted?.close(); await t.close(); }
});

it('does not replay an interrupted upstream answer and accepts a newly reviewed current answer', async () => {
  const t = await fixture(); let restarted: BrowserEngine | undefined;
  try {
    const material = t.engine.interventionMaterial(t.sid), item = material.items.find(i => i.kind === 'region')!;
    const request = { requestId: 'interrupted-answer', interventionId: item.id, conditionKey: item.conditionKey, command: { type: 'observe' as const } };
    const pending: InterventionResponseRecord = { id: hash({ sid: t.sid, requestId: request.requestId, kind: 'intervention-response' }), sessionId: t.sid, requestId: request.requestId, input: request, at: new Date().toISOString(), status: 'applying' };
    t.engine.store.put('intervention-response', pending); await t.engine.close();
    restarted = new BrowserEngine({ persistence: new SqliteStore(t.directory) });
    const replay = await restarted.respondToIntervention(t.sid, request);
    expect(replay.response.status).toBe('interrupted'); expect(restarted.observation(t.sid).id).toBe(material.observationId);
    const current = replay.material.items.find(i => i.id === item.id)!;
    expect(current.evidence.recordIds).toContain(pending.id);
    const accepted = await restarted.respondToIntervention(t.sid, { ...request, requestId: 'new-current-answer', conditionKey: current.conditionKey });
    expect(accepted.response.status).toBe('applied'); expect(restarted.observation(t.sid).id).not.toBe(material.observationId);
    expect(restarted.list(t.sid, 'intervention-response')).toHaveLength(2); expect(t.submissions()).toBe(0);
  } finally { await restarted?.close(); await t.close(); }
});

it('does not pause another session when an old session asks to continue', async () => {
  const t = await fixture(); try {
    const request = input(t); await t.engine.stop(t.sid);
    const other = await t.engine.createSession({ url: t.url, headless: true, settleMs: 20, observeTimeoutMs: 600 });
    const before = t.engine.session(other.id);
    expect(() => t.engine.continueExploration(t.sid, request)).toThrow(/different session/);
    expect(t.engine.session(other.id)).toEqual(before); expect(t.engine.list(t.sid, 'continuation')).toEqual([]);
    expect(t.submissions()).toBe(0);
  } finally { await t.close(); }
});

it('does not reset a consumed action budget when continuing', async () => {
  const t = await fixture(); try {
    await submit(t); const s = t.engine.session(t.sid); s.options.maxActions = 1; t.engine.store.put('session', s);
    const result = await t.engine.continueExploration(t.sid, input(t));
    expect(result.continuation.status).toBe('needs_review'); expect(result.material.items.some(i => i.kind === 'budget')).toBe(true);
    expect(t.engine.session(t.sid).actionCount).toBe(1); expect(t.submissions()).toBe(1);
  } finally { await t.close(); }
});
