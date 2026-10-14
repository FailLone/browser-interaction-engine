import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '@interaction/storage-sqlite';
import { it, expect, vi } from 'vitest';
import { InteractionEngine, describeDiff, evidenceRetentionSchema, type Persistence, type ControlIdentity, type IdentityHypothesis } from '@interaction/core';
import { BrowserEngine, type Observation, type Control, type Diff } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { CounterAdapter } from '../examples/counter-adapter.js';
import { compareObservations } from '../packages/adapter-playwright/src/model.js';
import { explainBrowserDiff } from '../packages/browser/src/diff-details.js';

const control = (identityId: string, extra: Partial<Control> = {}): Control => ({ identityId, localId: `local-${identityId}`, instanceId: `doc:${identityId}`, tag: 'button', role: 'button', name: 'Order type', label: '', region: 'form', form: 'form', selector: '#order', rect: { x: 20, y: 40, width: 100, height: 30 }, value: '', displayedText: 'Limit', checked: null, selected: [], expanded: null, controls: null, visible: true, enabled: true, editable: false, constraints: { type: 'button', required: false, valid: true }, options: [], actions: ['click'], discovery: ['button'], actionable: { visible: true, enabled: true, editable: false, hitTarget: true, unknown: [] }, ...extra });
const observation = (id: string, controls: Control[], extra: Partial<Observation> = {}): Observation => ({ id, sessionId: 'session', capturedAt: id === 'before' ? '2026-10-14T10:00:00.000Z' : '2026-10-14T10:00:01.000Z', instanceScope: 'doc', documentId: 'doc', controls, regions: [{ key: 'document', role: 'document', label: 'Page', rect: { x: 0, y: 0, width: 800, height: 600 }, text: '', selector: 'body' }, { key: 'form', parentKey: 'document', role: 'form', label: 'Order form', rect: { x: 0, y: 0, width: 500, height: 500 }, text: '', selector: 'form' }], context: {}, gaps: [], stable: true, stateId: `state-${id}`, visitId: `visit-${id}`, fingerprint: id, canonical: id, ruleVersion: 'observable-v2', cause: 'inspection', url: 'https://example.test', title: 'Order', text: '', viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0, maxY: 0 }, ...extra });
function save(store: Persistence, ...observations: Observation[]) {
  for (const o of observations) {
    store.put('observation', o);
    for (const c of o.controls) {
      const identity = store.get<ControlIdentity<Control>>('identity', c.identityId!) || { id: c.identityId!, sessionId: o.sessionId, createdAt: o.capturedAt, signature: 'button', occurrences: [], status: 'present' as const, lastControl: c };
      identity.occurrences.push({ observationId: o.id, localId: c.localId, instanceId: c.instanceId, context: o.context, evidence: [o.id === 'before' ? 'first-occurrence' : 'scoped-stable-key', 'same-instance'] });
      identity.lastControl = c; store.put('identity', identity);
    }
  }
}

it('enriches a generic SDK diff without a web driver or storage implementation dependency', async () => {
  const store = new MemoryStore(), engine = new InteractionEngine({ persistence: store, adapter: new CounterAdapter() });
  try {
    const session = await engine.createSession({});
    const attempt = await engine.execute(session.id, engine.actions(session.id)[0].id, 'one');
    const beforeEvents = store.events(session.id).length;
    const details = await engine.attemptDiffDetails(session.id, attempt.id);
    expect(details.diff).toEqual(attempt.diff);
    expect(details.observations.before.count).toBe(0); expect(details.observations.after.count).toBe(1);
    expect(details.changes[0].target.kind).toBe('observation');
    expect(details.related.attempts[0].id).toBe(attempt.id);
    expect(details.controls[attempt.action.controlId!].after[0].control.name).toBe('Counter');
    const event = store.events(session.id).find(e => e.type === 'observation.diff')!;
    expect((await engine.eventDiffDetails(session.id, event.sequence)).diff).toEqual(attempt.diff);
    expect(store.events(session.id)).toHaveLength(beforeEvents);
    await expect(engine.eventDiffDetails(session.id, -1)).rejects.toThrow('positive safe integer');
    const noDiff = store.event(session.id, 'frontier.updated', { observationId: attempt.afterId });
    await expect(engine.eventDiffDetails(session.id, noDiff.sequence)).rejects.toThrow('no recorded diff');
    details.observations.after.controls[0].name = 'mutated';
    expect(engine.observation(session.id).controls[0].name).toBe('Counter');
  } finally { await engine.close(); }
});

it('explains null to false as a declaration change and returns full historical control facts', async () => {
  const store = new MemoryStore(); const before = observation('before', [control('button')]);
  const after = observation('after', [control('button', { expanded: false })]); save(store, before, after);
  const diff = compareObservations(before, after);
  const result = await explainBrowserDiff(describeDiff<Observation>(store, 'session', diff, { kind: 'comparison' }), store.evidence);
  expect(result.diff).toEqual(diff);
  expect(result.changes[0].interpretation.code).toBe('expanded_declaration_added_collapsed');
  expect(result.changes[0].interpretation.summary).toContain('不能据此认定');
  expect(result.browser.fields.expanded.nullMeaning).toContain('不等于已收起');
  expect(result.controls.button.after[0].regionPath.map(r => r.label)).toEqual(['Page', 'Order form']);
  expect(result.controls.button.before[0].control.expanded).toBeNull();
  expect(result.controls.button.after[0].identityEvidence).toContain('scoped-stable-key');
  expect(result.interval.elapsedMs).toBe(1000);
  expect(result.semantics.causality).toBe('not_established');
});

it('preserves an ambiguous appeared/disappeared pair and separates later rulings from history', () => {
  const store = new MemoryStore();
  const before = observation('before', [control('old', { instanceId: 'doc:1', name: '' })]);
  const after = observation('after', [control('new', { instanceId: 'doc:1', name: '', hypothesisId: 'hypothesis' })]);
  save(store, before, after);
  const h: IdentityHypothesis = { id: 'hypothesis', sessionId: 'session', observationId: 'after', localId: after.controls[0].localId, provisionalIdentityId: 'new', candidateIds: ['old'], evidence: ['adapter-semantic-signature'], conflicts: ['multiple-historical-controls'], status: 'resolved', revisions: [{ identityId: 'old', source: 'human', evidence: ['reviewed'], at: '2026-10-15T00:00:00.000Z' }] };
  store.put('hypothesis', h);
  // Later lastControl values must never appear as the earlier candidate's facts.
  const future = observation('future', [control('old', { name: 'FUTURE NAME', value: 'future' })], { capturedAt: '2026-10-16T00:00:00.000Z' }); save(store, future);
  const diff = compareObservations(before, after); diff.gaps.push({ code: 'IDENTITY_UNCERTAIN', message: 'new' });
  const details = describeDiff<Observation>(store, 'session', diff, { kind: 'event', sequence: 3 });
  expect(details.diff.changes.map(c => c.kind)).toEqual(['disappeared', 'appeared']);
  expect(details.controls.new.alternatives).toContainEqual({ identityId: 'old', evidence: ['hypothesis_candidate', 'same_instance'], verified: false });
  expect(details.changes.every(c => c.interpretation.certainty === 'identity_uncertain')).toBe(true);
  expect(details.controls.old.before[0].control.name).toBe('');
  expect(details.hypotheses[0].statusAtComparison).toBe('pending');
  expect(details.hypotheses[0].currentResolution.status).toBe('resolved');
  expect(details.gaps[0].hypothesisIds).toEqual(['hypothesis']);
  expect(JSON.stringify(details.observations)).not.toContain('FUTURE NAME');
});

it('keeps duplicate occurrences, capture gaps and missing references explicit', () => {
  const store = new MemoryStore();
  const before = observation('before', [control('duplicate'), control('duplicate', { localId: 'second', instanceId: 'doc:second' })]);
  const after = observation('after', [], { gaps: [{ code: 'CAPTURE_FAILED', message: 'Document unavailable', critical: true }], stable: false }); save(store, before, after);
  const diff: Diff = { beforeId: 'before', afterId: 'after', changes: [{ kind: 'disappeared', controlId: 'duplicate' }, { kind: 'changed', controlId: 'missing', field: 'value' }], gaps: [], attribution: 'observed_during_interval' };
  const details = describeDiff<Observation>(store, 'session', diff, { kind: 'comparison' });
  expect(details.controls.duplicate.before).toHaveLength(2);
  expect(details.controls.duplicate.correspondence).toBe('uncertain');
  expect(details.gaps.some(g => g.origin === 'after' && g.gap.code === 'CAPTURE_FAILED')).toBe(true);
  expect(details.gaps.some(g => g.gap.code === 'CONTROL_EVIDENCE_UNAVAILABLE')).toBe(true);
});

it('marks context reuse for revalidation and rejects cross-session observation references', () => {
  const store = new MemoryStore(); const before = observation('before', [control('button')], { context: { pair: { status: 'known', value: 'A', source: 'selector' } } });
  const after = observation('after', [control('button')], { context: { pair: { status: 'known', value: 'B', source: 'selector' } } }); save(store, before, after);
  const result = describeDiff<Observation>(store, 'session', compareObservations(before, after), { kind: 'comparison' });
  expect(result.summary.reuse).toBe('requires_revalidation');
  save(store, observation('foreign', [], { sessionId: 'other' }));
  expect(() => describeDiff(store, 'session', { ...result.diff, afterId: 'foreign' }, { kind: 'comparison' })).toThrow('does not belong');
});

it('reads stored event diffs without re-comparing after a rule change', async () => {
  const store = new MemoryStore(); const engine = new BrowserEngine({ persistence: store });
  store.put('session', { id: 'session' }); save(store, observation('before', []), observation('after', []));
  const diff: Diff = { beforeId: 'before', afterId: 'after', changes: [{ kind: 'context', before: { legacy: true }, after: {} }], gaps: [], attribution: 'observed_during_interval' };
  const event = store.event('session', 'observation.diff', diff);
  expect((await engine.eventDiffDetails('session', event.sequence)).diff).toEqual(diff);
  expect((await engine.diffDetails('session', 'before', 'after')).diff.changes).toEqual([]);
  await engine.close();
});

async function retainedObservation(engine: BrowserEngine, id: string, policy: ReturnType<typeof evidenceRetentionSchema.parse>) {
  const o = observation(id, [control('button', { expanded: id === 'after' ? false : null })], { screenshot: `${id}.png` });
  await engine.store.evidence.beginObservation({ sessionId: o.sessionId, observationId: id, policy });
  await engine.store.evidence.put(o.screenshot!, { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' });
  save(engine.store, o);
  await engine.store.evidence.endObservation(id, true);
  return o;
}

it('keeps historical diff facts when cache expires; queries do not pin or extend retention', async () => {
  let clock = 0; const engine = new BrowserEngine({ persistence: new MemoryStore(), retention: { now: () => clock, sweepIntervalMs: 0 } });
  const policy = evidenceRetentionSchema.parse({ mode: 'cache', ttlMs: 100 });
  try {
    engine.store.put('session', { id: 'session', status: 'idle', currentObservationId: 'after' });
    const before = await retainedObservation(engine, 'before', policy);
    const after = await retainedObservation(engine, 'after', policy);
    const events = engine.store.events('session');
    clock = 90; const initial = await engine.diffDetails('session', 'before', 'after');
    expect(initial.browser.screenshots.every(s => s.available)).toBe(true);
    clock = 101; const result = await engine.diffDetails('session', 'before', 'after');
    expect(result.browser.evidence.before.artifacts.screenshot.availability).toMatchObject({ status: 'expired', reason: 'ttl_elapsed', mode: 'cache' });
    expect(result.browser.evidence.before.artifacts.details.availability.status).toBe('not_captured');
    expect(result.browser.screenshots.map(s => s.available)).toEqual([false, true]);
    expect(result.diff).toEqual(initial.diff); expect(result.controls).toEqual(initial.controls);
    expect(result.observations).toEqual({ before, after });
    expect(engine.store.events('session')).toEqual(events);
    expect((await engine.evidenceStats('session')).protected).toEqual([{ observationId: 'after', owners: ['current-observation'] }]);
    // Shared evidence queries include legacy screenshot references, even without a manifest.
    expect((await engine.observationDetails('session', 'before')).availability.screenshot.status).toBe('expired');
  } finally { await engine.close(); }
});

it.each(['evicted', 'released'] as const)('reports %s evidence without losing a diff or its control identity', async status => {
  const engine = new BrowserEngine({ persistence: new MemoryStore(), retention: { sweepIntervalMs: 0 } });
  try {
    engine.store.put('session', { id: 'session', status: 'stopped' });
    const policy = evidenceRetentionSchema.parse({ mode: 'cache', maxObservations: status === 'evicted' ? 1 : 2 });
    await retainedObservation(engine, 'before', policy); await retainedObservation(engine, 'after', policy);
    if (status === 'released') await engine.releaseEvidence('session', 'before');
    const details = await engine.diffDetails('session', 'before', 'after');
    expect(details.browser.screenshots[0]).toMatchObject({ available: false, availability: { status } });
    expect(details.changes[0].interpretation.code).toBe('expanded_declaration_added_collapsed');
    expect(details.controls.button.before[0].control.expanded).toBeNull();
  } finally { await engine.close(); }
});

it.each(['cache', 'persistent'] as const)('reads diff history after restart with %s retention and reports actual durability', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'diff-retention-'));
  let engine = new BrowserEngine({ persistence: new SqliteStore(directory), retention: { sweepIntervalMs: 0 } });
  try {
    engine.store.put('session', { id: 'session', status: 'stopped' });
    const policy = evidenceRetentionSchema.parse({ mode });
    await retainedObservation(engine, 'before', policy); await retainedObservation(engine, 'after', policy);
    const initial = await engine.diffDetails('session', 'before', 'after');
    await engine.close(); engine = new BrowserEngine({ persistence: new SqliteStore(directory), retention: { sweepIntervalMs: 0 } });
    const result = await engine.diffDetails('session', 'before', 'after');
    expect(result.diff).toEqual(initial.diff); expect(result.controls).toEqual(initial.controls);
    for (const image of result.browser.screenshots) expect(image.availability).toMatchObject({ status: mode === 'cache' ? 'not_retained' : 'available', durability: mode === 'cache' ? 'process' : 'persistent' });
  } finally { await engine.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('degrades storage plugin failures per artifact and supports legacy stores without availability()', async () => {
  const store = new MemoryStore(); const before = observation('before', [control('button')], { screenshot: 'before.png' });
  const after = observation('after', [control('button', { expanded: false })], { screenshot: 'after.png' }); save(store, before, after);
  const diff = describeDiff<Observation>(store, 'session', compareObservations(before, after), { kind: 'comparison' });
  const failed = await explainBrowserDiff(diff, { put: async () => {}, get: async key => { if (key === 'before.png') throw new Error('storage offline'); return undefined; } });
  expect(failed.browser.screenshots.map(s => s.availability.status)).toEqual(['storage_failed', 'missing']);
  expect(failed.diff.changes).toHaveLength(1);
  const engine = new BrowserEngine({ persistence: store, retention: { sweepIntervalMs: 0 } });
  store.put('session', { id: 'session', status: 'stopped' });
  const get = vi.spyOn(store.evidence, 'get');
  try {
    const details = await engine.diffDetails('session', 'before', 'after');
    expect(details.browser.screenshots.every(s => !s.available)).toBe(true);
    expect(get).toHaveBeenCalledTimes(2); // one read per reference, not two legacy reads
    const evidence = await engine.observationDetails('session', 'before');
    expect(evidence.availability.screenshot.status).toBe('missing');
  } finally { await engine.close(); }
});
