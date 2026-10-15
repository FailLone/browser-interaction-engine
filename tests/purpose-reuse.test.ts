import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BrowserEngine, type ActionAttempt, type EngineHooks, type ExplorationGroup, type ListPurposeReviewInput, type PurposeReview, type SessionOptions } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import type { Persistence } from '@interaction/core';
import { InteractionClient } from '@interaction/client';
import { createServer as createApi } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';

const choices = '<div id="choices" role="listbox" aria-label="Currency"><button type="button">One</button><button type="button">Two</button><button type="button">Three</button></div>';
const purpose = { purpose: 'Change the displayed calculator currency', businessScope: 'This public calculator only; no transaction or account effect',
  source: 'test-reviewer', evidence: ['Inspected the list and its local selection effect'], risk: 'interface' as const, reuse: 'matching-list-members' as const };
async function fixture(body = choices, options: Partial<SessionOptions> = {}, hooks: EngineHooks = {}, persistence: Persistence = new MemoryStore()) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(body + '<script>window.calls=[];document.addEventListener("click",e=>{if(e.target.closest("[role=listbox]"))window.calls.push(e.target.textContent)})</script>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ persistence, hooks: { ...hooks, actions: (actions, ctx) => {
    const guarded = actions.map(a => a.risk === 'unknown' ? { ...a, excluded: true, exclusionReason: 'operation_requires_review' } : a);
    return hooks.actions ? hooks.actions(guarded, ctx) : guarded;
  } } });
  const session = await engine.createSession({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, headless: true, settleMs: 35, observeTimeoutMs: 600, ...options });
  let engineClosed = false;
  const closeEngine = async () => { if (!engineClosed) { await engine.close(); engineClosed = true; } };
  return { engine, sid: session.id, closeEngine, close: async () => { await closeEngine(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const groups = (t: Fixture) => t.engine.list<ExplorationGroup>(t.sid, 'exploration-group');
const attempts = (t: Fixture) => t.engine.list<ActionAttempt>(t.sid, 'attempt');
const records = (t: Fixture) => t.engine.list<PurposeReview>(t.sid, 'purpose-review');
const explore = async (t: Fixture) => { await t.engine.explore(t.sid); await t.engine.waitForIdle(); };
const input = (t: Fixture, groupId = groups(t)[0].id): ListPurposeReviewInput => {
  const material = t.engine.purposeReviewMaterial(t.sid, groupId);
  return { ...purpose, groupId, revision: material.revision, observationId: material.observationId, conditionKey: material.conditions[0].key };
};
const allowAll = async (t: Fixture) => { const g = groups(t)[0]; await t.engine.decideExplorationGroup(t.sid, g.id, g.revision, { mode: 'all', source: 'test-strategy', evidence: ['This run requests every discovered member'] }); };

it('reuses one purpose judgment while executing every list item independently after an all decision', async () => {
  const t = await fixture();
  try {
    await allowAll(t); await explore(t); expect(attempts(t)).toEqual([]);
    const before = t.engine.observation(t.sid); const material = t.engine.purposeReviewMaterial(t.sid, groups(t)[0].id);
    expect(material.conditions).toHaveLength(1); expect(material.conditions[0].members).toHaveLength(3);
    const review = await t.engine.reviewListPurpose(t.sid, input(t));
    expect(attempts(t)).toEqual([]); expect(t.engine.actions(t.sid).every(a => a.excluded)).toBe(true);
    await t.engine.observe(t.sid);
    const actions = t.engine.actions(t.sid); expect(actions.every(a => a.risk === 'interface' && !a.excluded && !a.replayable)).toBe(true);
    await explore(t);
    expect(attempts(t).map(a => a.action.label).sort()).toEqual(['One', 'Three', 'Two']);
    expect(new Set(attempts(t).map(a => a.action.localId)).size).toBe(3);
    expect(attempts(t).every(a => a.action.basis!.evidence.some(e => e.facts.reviewId === review.id))).toBe(true);
    expect(await pageOf(t.engine).evaluate(() => (window as any).calls)).toHaveLength(3);
    expect(t.engine.session(t.sid).dirty).toBe(false); expect(records(t)).toHaveLength(1);
    expect(t.engine.observation(t.sid, before.id)).toEqual(before);
  } finally { await t.close(); }
});

it('keeps purpose reuse independent of pending, sample and defer traversal decisions', async () => {
  const t = await fixture();
  try {
    await t.engine.reviewListPurpose(t.sid, input(t)); await t.engine.observe(t.sid); await explore(t);
    expect(attempts(t)).toEqual([]); expect(t.engine.session(t.sid).stopReason).toBe('LIST_DECISION_REQUIRED');
    let g = groups(t)[0]; const selected = g.members.find(m => m.label === 'Two' && m.observationId === t.engine.observation(t.sid).id)!;
    await t.engine.decideExplorationGroup(t.sid, g.id, g.revision, { mode: 'sample', memberKeys: [selected.key], source: 'strategy', evidence: ['Two is sufficient for this pass'] });
    await explore(t); expect(attempts(t).map(a => a.action.label)).toEqual(['Two']);
    g = groups(t)[0]; await t.engine.decideExplorationGroup(t.sid, g.id, g.revision, { mode: 'defer', source: 'strategy', evidence: ['Defer remaining choices'] });
    await explore(t); expect(attempts(t)).toHaveLength(1); expect(records(t)[0].status).toBe('active');
    expect(t.engine.getFrontier(t.sid).filter(f => f.status === 'deferred').every(f => f.coverage.executionStatus === 'not_attempted')).toBe(true);
  } finally { await t.close(); }
});

it('reuses for newly revealed matching members, but not changed structures, unrelated lists or submission actions', async () => {
  const t = await fixture();
  try {
    await t.engine.reviewListPurpose(t.sid, input(t)); await t.engine.observe(t.sid);
    await pageOf(t.engine).evaluate(() => {
      document.getElementById('choices')!.insertAdjacentHTML('beforeend', '<button type="button">Four</button><button type="button" aria-haspopup="dialog">Special</button><form><button>Submit</button></form>');
      document.body.insertAdjacentHTML('beforeend', '<div role="listbox" aria-label="Account"><button type="button">One</button><button type="button">Two</button></div>');
    });
    await t.engine.observe(t.sid);
    const actions = t.engine.actions(t.sid);
    expect(actions.find(a => a.label === 'Four')).toMatchObject({ source: 'conditional-purpose-review', risk: 'interface', replayable: false });
    expect(actions.find(a => a.label === 'Special')).toMatchObject({ excluded: true, risk: 'unknown' });
    expect(actions.find(a => a.label === 'Submit')).toMatchObject({ risk: 'submission' });
    const other = t.engine.observation(t.sid).controls.filter(c => c.list?.label === 'Account');
    expect(actions.filter(a => other.some(c => c.localId === a.localId)).every(a => a.excluded && a.risk === 'unknown')).toBe(true);
    expect(t.engine.store.events(t.sid).filter(e => e.type === 'purpose.review_recorded')).toHaveLength(1);
  } finally { await t.close(); }
});

it('rejects dispatch after the current node or its dispatch attributes change, without granting historical identity', async () => {
  const t = await fixture();
  try {
    await t.engine.reviewListPurpose(t.sid, input(t)); await t.engine.observe(t.sid);
    const action = t.engine.actions(t.sid).find(a => a.label === 'One')!;
    await pageOf(t.engine).evaluate(() => { const old = document.querySelector('button')!; old.replaceWith(old.cloneNode(true)); });
    await expect(t.engine.execute(t.sid, action.id, 'rebuilt-target')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(attempts(t)).toEqual([]);
    const current = t.engine.actions(t.sid).find(a => a.label === 'One')!;
    expect(current.localId).not.toBe(action.localId);
    await pageOf(t.engine).evaluate(() => document.querySelector('button')!.setAttribute('aria-haspopup', 'dialog'));
    await expect(t.engine.execute(t.sid, current.id, 'changed-purpose')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.actions(t.sid).find(a => a.label === 'One')).toMatchObject({ excluded: true, risk: 'unknown' });
    expect(attempts(t)).toEqual([]);
  } finally { await t.close(); }
});

it('invalidates reuse on business context change and does not reactivate it when the context returns', async () => {
  const t = await fixture('<span id="account">demo</span>' + choices, { contextRules: [{ key: 'account', selector: '#account', required: true }] });
  try {
    await t.engine.reviewListPurpose(t.sid, input(t)); await t.engine.observe(t.sid);
    const action = t.engine.actions(t.sid)[0];
    await pageOf(t.engine).evaluate(() => { document.getElementById('account')!.textContent = 'live'; });
    await expect(t.engine.execute(t.sid, action.id, 'changed-account')).rejects.toMatchObject({ code: 'PRECONDITIONS_CHANGED' });
    expect(records(t)[0].status).toBe('invalidated'); expect(attempts(t)).toEqual([]);
    await pageOf(t.engine).evaluate(() => { document.getElementById('account')!.textContent = 'demo'; }); await t.engine.observe(t.sid);
    expect(t.engine.actions(t.sid).every(a => a.excluded)).toBe(true);
    expect(t.engine.store.events(t.sid).filter(e => e.type === 'purpose.review_invalidated')).toHaveLength(1);
  } finally { await t.close(); }
});

it('invalidates list-owner reconstruction and document reload, and refuses unknown business context', async () => {
  for (const change of ['owner', 'reload', 'unknown'] as const) {
    let unknown = false;
    const t = await fixture(choices, {}, { context: () => ({ account: { value: 'demo', status: unknown ? 'unknown' : 'known', source: 'fixture' } }) });
    try {
      await t.engine.reviewListPurpose(t.sid, input(t)); await t.engine.observe(t.sid);
      if (change === 'owner') await pageOf(t.engine).evaluate(() => { const old = document.getElementById('choices')!; const replacement = old.cloneNode(false) as Element; replacement.append(...old.childNodes); old.replaceWith(replacement); });
      else if (change === 'reload') await pageOf(t.engine).reload(); else unknown = true;
      await t.engine.observe(t.sid); expect(records(t)[0].status).toBe('invalidated');
      expect(t.engine.actions(t.sid).every(a => a.excluded)).toBe(true);
      const g = groups(t).findLast(g => g.observationId === t.engine.observation(t.sid).id)!;
      if (change === 'unknown') expect(t.engine.purposeReviewMaterial(t.sid, g.id).conditions).toEqual([]);
    } finally { await t.close(); }
  }
});

it('retains disabled, excluded and occluded target checks after accepting a group purpose', async () => {
  const t = await fixture('<div role="listbox"><button type="button">Allowed</button><button type="button" disabled>Disabled</button><button type="button">Excluded</button><span style="position:relative"><button type="button">Occluded</button><i style="position:absolute;inset:0;z-index:2;background:black"></i></span></div>', { exclude: [{ name: 'Excluded' }] });
  try {
    await t.engine.reviewListPurpose(t.sid, input(t)); await t.engine.observe(t.sid); await allowAll(t); await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Allowed']);
    const frontier = t.engine.getFrontier(t.sid);
    expect(frontier.some(f => f.action.label === 'Disabled' && f.reason === 'disabled')).toBe(true);
    expect(frontier.some(f => f.action.label === 'Excluded' && f.reason === 'excluded_by_rule')).toBe(true);
    expect(frontier.some(f => f.action.label === 'Occluded' && f.reason === 'pointer_intercepted')).toBe(true);
  } finally { await t.close(); }
});

it('serves review material and durable records over HTTP, rejects stale input, and revokes already prepared actions', async () => {
  const t = await fixture(); const api = await createApi(t.engine); const url = await api.listen({ host: '127.0.0.1', port: 0 }); const client = new InteractionClient(url);
  try {
    const g = groups(t)[0]; const material = await client.purposeReviewMaterial(t.sid, g.id); const proposal = { ...purpose, groupId: g.id, revision: material.revision, observationId: material.observationId, conditionKey: material.conditions[0].key };
    await t.engine.observe(t.sid); await expect(client.reviewListPurpose(t.sid, proposal)).rejects.toMatchObject({ code: 'STALE_PURPOSE_REVIEW' });
    const review = await client.reviewListPurpose(t.sid, input(t)); expect((await client.purposeReviews(t.sid)).items[0].id).toBe(review.id);
    await t.engine.observe(t.sid); const action = t.engine.actions(t.sid)[0];
    await client.revokePurposeReview(t.sid, { reviewId: review.id, source: 'reviewer', reason: 'Business purpose needs renewed review' });
    await expect(t.engine.execute(t.sid, action.id, 'revoked')).rejects.toMatchObject({ code: 'PURPOSE_REVIEW_EXPIRED' });
    expect(attempts(t)).toEqual([]);
    await t.engine.observe(t.sid); expect(t.engine.actions(t.sid).every(a => a.excluded)).toBe(true);
    expect((await client.purposeReviews(t.sid, { status: 'revoked' })).total).toBe(1);
    await t.engine.stop(t.sid);
    const other = await t.engine.createSession({ url: t.engine.session(t.sid).options.url, headless: true });
    await expect(client.purposeReviewMaterial(other.id, g.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(client.revokePurposeReview(other.id, { reviewId: review.id, source: 'reviewer', reason: 'wrong session' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally { await api.close(); await t.close(); }
});

it('retains purpose records across restart but invalidates them before use in a new browser document', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'purpose-reuse-')); const t = await fixture(choices, {}, {}, new SqliteStore(directory));
  try {
    const review = await t.engine.reviewListPurpose(t.sid, input(t)); await t.closeEngine();
    const restored = new BrowserEngine({ persistence: new SqliteStore(directory) });
    try {
      expect(restored.list<PurposeReview>(t.sid, 'purpose-review')[0].id).toBe(review.id);
      await restored.observe(t.sid);
      expect(restored.list<PurposeReview>(t.sid, 'purpose-review')[0].status).toBe('invalidated');
      expect(restored.actions(t.sid).every(a => a.source !== 'conditional-purpose-review')).toBe(true);
    } finally { await restored.close(); }
  } finally { await t.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('supersedes an earlier purpose judgment so revoking its replacement cannot resurrect it', async () => {
  const t = await fixture();
  try {
    const first = await t.engine.reviewListPurpose(t.sid, input(t)); await t.engine.observe(t.sid);
    const prepared = t.engine.actions(t.sid)[0];
    const second = await t.engine.reviewListPurpose(t.sid, { ...input(t), purpose: 'Updated judgment for the same observed calculator operation' });
    expect(records(t).find(r => r.id === first.id)).toMatchObject({ status: 'superseded', replacedBy: second.id });
    await expect(t.engine.execute(t.sid, prepared.id, 'superseded-review')).rejects.toMatchObject({ code: 'PURPOSE_REVIEW_EXPIRED' });
    await t.engine.observe(t.sid);
    expect(t.engine.actions(t.sid).every(a => a.basis!.evidence.some(e => e.facts.reviewId === second.id))).toBe(true);
    await t.engine.revokePurposeReview(t.sid, { reviewId: second.id, source: 'reviewer', reason: 'Withdraw this purpose judgment' });
    await t.engine.observe(t.sid); expect(t.engine.actions(t.sid).every(a => a.excluded)).toBe(true);
    expect(records(t).some(r => r.status === 'active')).toBe(false); expect(attempts(t)).toEqual([]);
  } finally { await t.close(); }
});

it('reuses a native-select purpose across values but detects a changed associated form endpoint before dispatch', async () => {
  const t = await fixture('<form id="calculator" action="/preview"><select aria-label="Currency"><option>A</option><option>B</option><option>C</option></select></form>');
  try {
    await t.engine.reviewListPurpose(t.sid, input(t)); await t.engine.observe(t.sid); await allowAll(t); await explore(t);
    expect(attempts(t).map(a => a.action.value).sort()).toEqual(['A', 'B', 'C']);
    expect(t.engine.getFrontier(t.sid).filter(f => f.reason === 'purpose_review_replaced').every(f => f.status === 'superseded' && f.coverage.executionStatus === 'not_attempted')).toBe(true);
    expect(records(t)).toHaveLength(1);
    const a = t.engine.actions(t.sid)[0]; const count = attempts(t).length;
    await pageOf(t.engine).evaluate(() => document.getElementById('calculator')!.setAttribute('action', '/submit'));
    await expect(t.engine.execute(t.sid, a.id, 'changed-form')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(attempts(t)).toHaveLength(count);
    expect(t.engine.actions(t.sid).every(a => a.source !== 'conditional-purpose-review')).toBe(true);
  } finally { await t.close(); }
});
