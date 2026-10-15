import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, auditBrowserCompletion, type ExplorationGroup, type Observation } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';

async function fixture(html: string) {
  const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  const session = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as any).port}`, headless: true, settleMs: 40, observeTimeoutMs: 600 });
  return { engine, sid: session.id, close: async () => { await engine.close(); await new Promise<void>(r => site.close(() => r())); } };
}

it('includes an observed control with no frontier action in the unified completion assessment', async () => {
  const t = await fixture('<div tabindex="0">Focusable prose</div>');
  try {
    await t.engine.explore(t.sid); await t.engine.waitForIdle();
    const before = t.engine.getFrontier(t.sid), report = t.engine.report(t.sid), audit = report.completionAudit;
    expect(report.explorationAudit.status).toBe('complete');
    expect(audit).toMatchObject({ status: 'unverified', exhaustive: false });
    expect(audit.unconfirmedControls.map(c => c.label)).toContain('Focusable prose');
    const unknown = audit.unconfirmedControls.find(c => c.label === 'Focusable prose')!;
    expect(audit.scopes[0].unconfirmedControlIds).toContain(unknown.id);
    expect(unknown.observationIds).toContain(t.engine.observation(t.sid).id);
    expect(audit.gaps.some(g => g.code === 'EVENT_LISTENER_COVERAGE' && g.current && !g.diagnostic)).toBe(true);
    expect(t.engine.getFrontier(t.sid)).toEqual(before);
    audit.recordedActions.counts.succeeded = 999;
    expect(t.engine.report(t.sid).completionAudit.recordedActions.counts.succeeded).toBe(0);
  } finally { await t.close(); }
});

it('keeps read-only displays separate and never uses an empty action ledger as exhaustive discovery proof', async () => {
  const t = await fixture('<input aria-label="Quote" readonly value="10">');
  try {
    await t.engine.explore(t.sid); await t.engine.waitForIdle();
    const report = t.engine.report(t.sid), audit = report.completionAudit;
    expect(audit.controls.readOnly).toBe(1); expect(audit.unconfirmedControls).toHaveLength(0);
    expect(audit.exhaustive).toBe(false);
    const empty = auditBrowserCompletion({ ...report.explorationAudit, status: 'complete' }, report.controlCoverage, []);
    expect(empty.status).toBe('unverified'); expect(empty.scopes).toEqual([]);
  } finally { await t.close(); }
});

it('reflects a supported external judgment without counting the judgment as execution', async () => {
  const t = await fixture('<div id="custom" style="cursor:pointer">Open details</div>');
  try {
    const o = t.engine.observation(t.sid), c = o.controls.find(c => c.name === 'Open details')!;
    expect(t.engine.report(t.sid).completionAudit.unconfirmedControls.map(c => c.label)).toContain(c.name);
    await t.engine.reviewControls(t.sid, { observationId: o.id, source: 'fixture-upper-layer', reviews: [{ localId: c.localId, kind: 'click', risk: 'interface', reason: 'Inspect this UI action', evidence: ['Exact fixture target'] }] });
    const report = t.engine.report(t.sid);
    expect(report.completionAudit.unconfirmedControls.map(c => c.label)).not.toContain(c.name);
    expect(report.completionAudit.controls).toMatchObject({ covered: 0, incomplete: 1 });
    expect(report.completionAudit.recordedActions.counts.succeeded).toBe(0);
    expect(report.completionAudit.exhaustive).toBe(false);
  } finally { await t.close(); }
});

it('deduplicates a recurring gap only within its URL and declared context, retaining historical critical evidence', async () => {
  const t = await fixture('<div tabindex="0">Unknown</div>');
  try {
    const report = t.engine.report(t.sid), original = t.engine.observation(t.sid);
    const make = (id: string, url: string, mode: string, critical: boolean): Observation => ({ ...structuredClone(original), id, url,
      instanceScope: `document-${id}`, context: { mode: { value: mode, status: 'known', source: 'test' } },
      gaps: [{ code: 'CUSTOM_CAPABILITY', message: 'Not inspected', critical }] });
    const a = make('a', original.url, 'A', true), repeated = make('a2', original.url, 'A', false);
    const b = make('b', `${original.url}/destination`, 'A', false), changedContext = make('c', original.url, 'B', false);
    repeated.gaps.push({ code: 'INTERACTION_STABLE', message: 'Current interaction settled' });
    repeated.evidence = { schemaVersion: 1, status: 'captured', artifacts: {}, gaps: [{ code: 'CUSTOM_CAPABILITY', reference: 'detail', message: 'Detailed evidence unavailable' }] };
    const result = auditBrowserCompletion({ ...report.explorationAudit, status: 'complete' }, report.controlCoverage, [a, repeated, b, changedContext], repeated.id);
    expect(result.scopes).toHaveLength(3);
    const recurring = result.gaps.find(g => g.observationIds.includes('a'))!;
    expect(recurring.observationIds).toEqual(['a', 'a2']); expect(recurring.criticalObservationIds).toEqual(['a']); expect(recurring.current).toBe(true);
    expect(result.gaps.find(g => g.observationIds.includes('b'))?.current).toBe(false);
    expect(result.gaps.find(g => g.code === 'INTERACTION_STABLE')?.diagnostic).toBe(true);
    expect(result.gaps.find(g => g.origin === 'evidence' && g.code === 'CUSTOM_CAPABILITY')).toMatchObject({ reference: 'detail', observationIds: ['a2'] });
    expect(result.status).toBe('unverified'); expect(result.exhaustive).toBe(false);
    expect(result.scopes.find(s => s.observationIds.includes('a'))?.instanceScopes).toEqual(['document-a', 'document-a2']);
  } finally { await t.close(); }
});

it('keeps action blockers, outstanding decisions and budgets visible in the unified report', async () => {
  const t = await fixture('<select aria-label="Currency"><option>A</option><option>B</option><option>C</option></select>');
  try {
    await t.engine.explore(t.sid); await t.engine.waitForIdle();
    const report = t.engine.report(t.sid);
    expect(report.completionAudit.status).toBe('awaiting_decision');
    expect(report.completionAudit.recordedActions.pendingGroupIds.length).toBeGreaterThan(0);
    const stopped = auditBrowserCompletion({ ...report.explorationAudit, status: 'blocked', stopReasons: ['BUDGET_EXHAUSTED'] }, report.controlCoverage, t.engine.list(t.sid, 'observation'));
    expect(stopped.status).toBe('blocked'); expect(stopped.recordedActions.stopReasons).toEqual(['BUDGET_EXHAUSTED']);
  } finally { await t.close(); }
});

it('retains exact destination skip provenance without erasing its discovery limits or authorizing another context', async () => {
  const t = await fixture('<a href="/destination">B</a><div tabindex="0">Unknown</div>');
  try {
    await t.engine.execute(t.sid, t.engine.actions(t.sid).find(a => a.label === 'B')!.id, 'to-destination');
    const group = t.engine.explorationReviewMaterial(t.sid).groups.find(g => g.kind === 'page')!;
    await t.engine.decideExplorationGroup(t.sid, group.id, group.revision, { mode: 'skip', source: 'fixture-upper-layer', evidence: ['Only inspect the entry page'] });
    const report = t.engine.report(t.sid), scope = report.completionAudit.scopes.find(s => s.url.endsWith('/destination'))!;
    expect(scope.pageDecisions).toHaveLength(1);
    expect(scope.pageDecisions[0].decisions.at(-1)?.decision).toEqual({ mode: 'skip', source: 'fixture-upper-layer', evidence: ['Only inspect the entry page'] });
    expect(scope.unconfirmedControlIds.length).toBeGreaterThan(0); expect(scope.gapIds.length).toBeGreaterThan(0);
    scope.pageDecisions[0].decisions.length = 0;
    expect(t.engine.report(t.sid).completionAudit.scopes.find(s => s.url.endsWith('/destination'))!.pageDecisions[0].decisions).toHaveLength(1);
    const o = { ...t.engine.observation(t.sid), context: { mode: { value: 'different', status: 'known' as const, source: 'test' } } };
    expect(auditBrowserCompletion(report.explorationAudit, report.controlCoverage, [o], o.id, t.engine.list<ExplorationGroup>(t.sid, 'exploration-group')).scopes[0].pageDecisions).toEqual([]);
  } finally { await t.close(); }
});
