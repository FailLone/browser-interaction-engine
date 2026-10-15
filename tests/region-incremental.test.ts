import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, type EngineHooks, type RegionReviewInput, type RegionReviewMaterial, type RegionReviewRecord } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { createServer as apiServer } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';

const reason = { source: 'incremental-test', evidence: ['Observed independent areas'] };
const html = '<div id="amount"><h2>Amount</h2><input aria-label="First"><input aria-label="Second"></div><div id="chart"><h2>Chart</h2><input aria-label="Day"><input aria-label="Week"></div>';
async function fixture(hooks: EngineHooks = {}) {
  const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const engine = new BrowserEngine({ persistence: new MemoryStore(), hooks });
  const session = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as any).port}`, headless: true, contextRules: [], regionExploration: 'review', settleMs: 30, observeTimeoutMs: 600 });
  return { engine, sid: session.id, close: async () => { await engine.close(); await new Promise<void>(r => site.close(() => r())); } };
}
const partition = (m: RegionReviewMaterial): RegionReviewInput => ({ observationId: m.observationId, ...reason,
  regions: ['Amount', 'Chart'].map(label => ({ key: label, label, candidateIds: [m.candidates.find(c => c.label === label && c.basis === 'heading')!.id] })) });
const patch = (m: RegionReviewMaterial, labels = ['Chart']): RegionReviewInput => ({ ...partition(m), update: { baseReviewId: m.review!.id }, regions: partition(m).regions.filter(r => labels.includes(r.key)) });
const group = (t: Awaited<ReturnType<typeof fixture>>, label: string) => t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.kind === 'reviewed-region' && g.label === label)!;
const grow = async (t: Awaited<ReturnType<typeof fixture>>) => { await pageOf(t.engine).locator('#chart').evaluate(el => el.insertAdjacentHTML('beforeend', '<input aria-label="Month">')); await t.engine.observe(t.sid); };

it.each(['all', 'sample', 'defer'] as const)('preserves the untouched %s decision and gates an enlarged region until a new decision', async mode => {
  const t = await fixture(); try {
    const first = await t.engine.reviewRegions(t.sid, partition(t.engine.regionReviewMaterial(t.sid)));
    const amount = group(t, 'Amount'), chart = group(t, 'Chart');
    await t.engine.decideExplorationGroups(t.sid, [amount, chart].map(g => ({ groupId: g.id, revision: g.revision,
      decision: g.id === amount.id && mode === 'sample' ? { ...reason, mode, memberKeys: [g.members[0].key] } : { ...reason, mode: g.id === amount.id && mode === 'defer' ? 'defer' : 'all' } })));
    const savedAmount = group(t, 'Amount');
    const oldObservation = t.engine.observation(t.sid);
    await grow(t);
    const m = t.engine.regionReviewMaterial(t.sid), month = m.controls.find(c => c.label === 'Month')!.localId;
    expect(m.delta).toMatchObject({ canUpdate: true, baseReviewId: first.id, unchangedRegionKeys: ['Amount'], changedRegions: [{ key: 'Chart', baselineAvailable: true, addedControlIds: [month], removedControlIds: [], changedControlIds: [] }] });
    expect(m.unassignedControlIds).toHaveLength(3);
    const result = await t.engine.reviewRegions(t.sid, patch(m));
    expect(result.baseReviewId).toBe(first.id);
    expect(result.regions.find(r => r.key === 'Amount')?.reviewId).toBe(first.id);
    expect(result.regions.find(r => r.key === 'Chart')?.reviewId).toBe(result.id);
    const kept = group(t, 'Amount'), revised = group(t, 'Chart');
    expect({ id: kept.id, revision: kept.revision, decisions: kept.decisions, collection: kept.collection }).toEqual({ id: savedAmount.id, revision: savedAmount.revision, decisions: savedAmount.decisions, collection: savedAmount.collection });
    expect(revised.id).not.toBe(chart.id); expect(revised.decisions).toEqual([]);
    expect(t.engine.observation(t.sid, oldObservation.id)).toEqual(oldObservation);
    await t.engine.explore(t.sid); await t.engine.waitForIdle();
    expect(t.engine.session(t.sid).actionCount).toBe(mode === 'all' ? 2 : mode === 'sample' ? 1 : 0);
    expect(t.engine.list<any>(t.sid, 'attempt').every(a => ['First', 'Second'].includes(a.action.label))).toBe(true);
    const latest = group(t, 'Chart');
    await t.engine.decideExplorationGroups(t.sid, [{ groupId: latest.id, revision: latest.revision, decision: { ...reason, mode: 'sample', memberKeys: [latest.members.find(m => m.label === 'Month')!.key] } }]);
    await t.engine.explore(t.sid); await t.engine.waitForIdle();
    expect(t.engine.list<any>(t.sid, 'attempt').at(-1).action.label).toBe('Month');
    expect(t.engine.regionReviewMaterial(t.sid).review?.regions.every(r => r.status === 'active')).toBe(true);
  } finally { await t.close(); }
});

it('reports member changes and missing anchors from the original per-region evidence across multiple patches', async () => {
  const t = await fixture(); try {
    const original = await t.engine.reviewRegions(t.sid, partition(t.engine.regionReviewMaterial(t.sid)));
    await grow(t); await t.engine.reviewRegions(t.sid, patch(t.engine.regionReviewMaterial(t.sid)));
    const before = t.engine.regionReviewMaterial(t.sid), first = before.controls.find(c => c.label === 'First')!.localId, second = before.controls.find(c => c.label === 'Second')!.localId;
    await pageOf(t.engine).locator('#amount').evaluate(el => { el.querySelector('input')!.setAttribute('aria-label', 'Renamed'); el.querySelectorAll('input')[1].remove(); });
    await t.engine.observe(t.sid);
    const changed = t.engine.regionReviewMaterial(t.sid);
    expect(changed.delta).toMatchObject({ unchangedRegionKeys: ['Chart'], changedRegions: [{ key: 'Amount', baselineAvailable: true, removedControlIds: [second], changedControlIds: [first] }] });
    const stored = changed.review!.regions.find(r => r.key === 'Amount')!;
    expect(stored.reviewId).toBe(original.id);
    expect(t.engine.list<any>(t.sid, 'exploration-group').find(g => g.label === 'Amount').status).toBe('invalidated');
    await pageOf(t.engine).locator('#amount').evaluate(el => el.replaceWith(el.cloneNode(true))); await t.engine.observe(t.sid);
    expect(t.engine.regionReviewMaterial(t.sid).delta?.changedRegions[0].missingCandidateIds).toEqual(stored.anchors.map(a => a.id));
  } finally { await t.close(); }
});

it('rejects stale bases, overlaps and conflicting rejection/removal atomically, and permits explicit removal', async () => {
  const t = await fixture(); try {
    await t.engine.reviewRegions(t.sid, partition(t.engine.regionReviewMaterial(t.sid)));
    await grow(t); const m = t.engine.regionReviewMaterial(t.sid), before = t.engine.list(t.sid, 'region-review');
    const amount = partition(m).regions[0];
    for (const input of [
      { ...patch(m), update: { baseReviewId: 'stale' } },
      { ...patch(m), regions: [{ ...amount, key: 'overlap' }] },
      { ...patch(m), rejectedCandidateIds: amount.candidateIds },
      { ...patch(m), update: { baseReviewId: m.review!.id, removeRegionKeys: ['Chart'] } },
      { ...patch(m), update: { baseReviewId: m.review!.id, removeRegionKeys: ['missing'] } },
    ]) { await expect(t.engine.reviewRegions(t.sid, input)).rejects.toBeDefined(); expect(t.engine.list(t.sid, 'region-review')).toEqual(before); }
    const next = await t.engine.reviewRegions(t.sid, patch(m));
    const fresh = t.engine.regionReviewMaterial(t.sid);
    await expect(t.engine.reviewRegions(t.sid, { ...patch(fresh), update: { baseReviewId: m.review!.id } })).rejects.toMatchObject({ code: 'STALE_REGION_REVIEW' });
    expect(t.engine.regionReviewMaterial(t.sid).review!.id).toBe(next.id);
    const chartId = group(t, 'Chart').id;
    await t.engine.reviewRegions(t.sid, { observationId: fresh.observationId, ...reason, regions: [], update: { baseReviewId: next.id, removeRegionKeys: ['Amount'] } });
    expect(t.engine.regionReviewMaterial(t.sid).unassignedControlIds).toHaveLength(2);
    expect(group(t, 'Chart').id).toBe(chartId);
  } finally { await t.close(); }
});

it.each(['url', 'context', 'reload'] as const)('requires a fresh full partition after %s changes', async change => {
  let value = 'before'; const t = await fixture({ context: () => ({ business: { status: 'known', value, source: 'fixture' } }) }); try {
    await t.engine.reviewRegions(t.sid, partition(t.engine.regionReviewMaterial(t.sid)));
    if (change === 'url') await pageOf(t.engine).evaluate(() => history.pushState({}, '', '#changed'));
    else if (change === 'reload') await pageOf(t.engine).reload(); else value = 'after';
    await t.engine.observe(t.sid);
    const m = t.engine.regionReviewMaterial(t.sid);
    expect(m.delta?.canUpdate).toBe(false);
    await expect(t.engine.reviewRegions(t.sid, patch(m))).rejects.toMatchObject({ code: 'STALE_REGION_REVIEW' });
    expect((await t.engine.reviewRegions(t.sid, partition(m))).status).toBe('active');
  } finally { await t.close(); }
});

it('keeps unmentioned invalid regions invalid, never revives their decisions, and supports old records without per-region provenance', async () => {
  const t = await fixture(); try {
    const original = await t.engine.reviewRegions(t.sid, partition(t.engine.regionReviewMaterial(t.sid)));
    original.regions.forEach(r => delete r.reviewId); t.engine.store.put('region-review', original);
    const amount = group(t, 'Amount'); await t.engine.decideExplorationGroups(t.sid, [{ groupId: amount.id, revision: amount.revision, decision: { ...reason, mode: 'all' } }]);
    await pageOf(t.engine).evaluate(() => document.querySelectorAll('h2').forEach(el => el.textContent += ' changed')); await t.engine.observe(t.sid);
    await pageOf(t.engine).evaluate(() => document.querySelectorAll('h2').forEach(el => el.textContent = el.textContent!.replace(' changed', ''))); await t.engine.observe(t.sid);
    const m = t.engine.regionReviewMaterial(t.sid); expect(m.review?.status).toBe('invalidated');
    await t.engine.reviewRegions(t.sid, patch(m));
    const current = t.engine.regionReviewMaterial(t.sid);
    expect(current.review?.regions.find(r => r.key === 'Amount')).toMatchObject({ status: 'invalidated', reviewId: original.id });
    expect(current.unassignedControlIds).toHaveLength(2); expect(group(t, 'Chart').decisions).toEqual([]);
    expect(t.engine.list<any>(t.sid, 'exploration-group').find(g => g.id === amount.id).status).toBe('invalidated');
  } finally { await t.close(); }
});

it('delivers deltas through hooks/events and supports partial commands over HTTP with live validation', async () => {
  const calls: RegionReviewMaterial[] = [];
  const t = await fixture({ regionReview: m => { calls.push(m); return undefined; } });
  const server = await apiServer(t.engine); await server.listen({ host: '127.0.0.1', port: 0 });
  const api = new InteractionClient(`http://127.0.0.1:${(server.server.address() as any).port}`);
  try {
    await api.reviewRegions(t.sid, partition(await api.regionReviewMaterial(t.sid)));
    await grow(t); const m = await api.regionReviewMaterial(t.sid);
    expect(calls.at(-1)?.delta).toEqual(m.delta);
    expect(t.engine.store.events(t.sid).filter(e => e.type === 'region.review_requested').at(-1)?.data).toMatchObject({ delta: m.delta });
    const count = calls.length; await t.engine.observe(t.sid); expect(calls).toHaveLength(count);
    await expect(api.reviewRegions(t.sid, patch(m))).rejects.toMatchObject({ code: 'STALE_REGION_REVIEW' });
    const fresh = await api.regionReviewMaterial(t.sid);
    await pageOf(t.engine).locator('#amount h2').evaluate(el => el.textContent = 'Changed');
    await expect(api.reviewRegions(t.sid, patch(fresh))).rejects.toMatchObject({ code: 'STALE_REGION_REVIEW' });
    const latest = await api.regionReviewMaterial(t.sid);
    const updated = await api.reviewRegions(t.sid, { observationId: latest.observationId, ...reason, update: { baseReviewId: latest.review!.id }, regions: [{ key: 'Chart', label: 'Chart', candidateIds: [latest.candidates.find(c => c.label === 'Chart')!.id] }] });
    expect(updated.regions.find(r => r.key === 'Amount')?.status).toBe('invalidated');
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  } finally { await server.close(); await t.close(); }
});

it('applies incremental hook results without resetting other exploration decisions', async () => {
  const t = await fixture({ regionReview: m => m.review ? patch(m) : partition(m) }); try {
    const amount = group(t, 'Amount');
    await t.engine.decideExplorationGroups(t.sid, [{ groupId: amount.id, revision: amount.revision, decision: { ...reason, mode: 'defer' } }]);
    await grow(t);
    expect(group(t, 'Amount').id).toBe(amount.id); expect(group(t, 'Amount').decisions.at(-1)?.decision.mode).toBe('defer');
    expect(group(t, 'Chart').decisions).toEqual([]);
    expect(t.engine.list<RegionReviewRecord>(t.sid, 'region-review').at(-1)?.baseReviewId).toBeDefined();
  } finally { await t.close(); }
});

it('snapshots queued partial input and still resets every region on an explicit full replacement', async () => {
  const t = await fixture(); try {
    await t.engine.reviewRegions(t.sid, partition(t.engine.regionReviewMaterial(t.sid)));
    const amount = group(t, 'Amount');
    const input = structuredClone(patch(t.engine.regionReviewMaterial(t.sid)));
    const pending = t.engine.reviewRegions(t.sid, input);
    input.update!.baseReviewId = 'mutated'; input.regions[0].label = 'mutated'; input.evidence[0] = 'mutated';
    const result = await pending;
    expect(result.regions.find(r => r.key === 'Chart')?.label).toBe('Chart'); expect(result.evidence).not.toContain('mutated');
    expect(group(t, 'Amount').id).toBe(amount.id);
    const chart = group(t, 'Chart');
    await t.engine.reviewRegions(t.sid, partition(t.engine.regionReviewMaterial(t.sid)));
    expect(group(t, 'Amount').id).not.toBe(amount.id); expect(group(t, 'Chart').id).not.toBe(chart.id);
    expect(t.engine.session(t.sid).actionCount).toBe(0);
  } finally { await t.close(); }
});
