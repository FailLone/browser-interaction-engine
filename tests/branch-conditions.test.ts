import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, type ActionAttempt, type Observation } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { browserBranchConditions, MAX_BRANCH_CONDITIONS } from '../packages/adapter-playwright/src/branch-conditions.js';
import { browserOperationKey, controlCase } from '../packages/adapter-playwright/src/exploration.js';
import { pageOf } from './helpers.js';

async function fixture(html: string) {
  const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  const session = await engine.createSession({ url: `http://127.0.0.1:${(site.address() as { port: number }).port}`,
    headless: true, exploration: 'controls', settleMs: 30, observeTimeoutMs: 600,
    interfaceActions: [{ stableKey: 'id:run', kind: 'click' }] });
  return { engine, sid: session.id, page: pageOf(engine), close: async () => {
    await engine.close(); await new Promise<void>(resolve => site.close(() => resolve()));
  } };
}

function actionFor(engine: BrowserEngine, sid: string, stableKey: string, kind: string) {
  const o = engine.observation(sid), c = o.controls.find(c => c.stableKey === stableKey)!;
  return engine.actions(sid).find(a => a.localId === c.localId && a.kind === kind)!;
}

it('explores the same native button from two observed form modes without transferring the first branch coverage', async () => {
  const t = await fixture(`<form id="order"><label>Mode <select id="mode"><option value="a">A</option><option value="b">B</option></select></label>
    <button id="run" type="button" onclick="document.querySelector('#result').textContent = document.querySelector('#mode').value + ' branch'">Run</button></form><output id="result"></output>`);
  try {
    const first = actionFor(t.engine, t.sid, 'id:run', 'click'), before = t.engine.observation(t.sid);
    const a = controlCase(first, before, true)!;
    const modeA=await t.engine.execute(t.sid, first.id, 'mode-a');
    expect(await t.page.locator('#result').textContent()).toBe('a branch');
    const select = actionFor(t.engine, t.sid, 'id:mode', 'select');
    await t.engine.execute(t.sid, select.id, 'switch-mode', 'b');
    const second = actionFor(t.engine, t.sid, 'id:run', 'click'), after = t.engine.observation(t.sid);
    expect(controlCase(second, after, true)!.key).not.toBe(a.key);
    expect(browserOperationKey(second, after)).not.toBe(browserOperationKey(first, before));
    expect(t.engine.operationCorrespondence(t.sid, { observationId: after.id, actionId: second.id,
      source: { sessionId: t.sid, attemptId: t.engine.list<ActionAttempt>(t.sid, 'attempt')[0].id } }).equivalent).toBe(false);
    // The legacy core queue samples encountered control operations. Its retained
    // success is evidence at A, never a claim that the current B mode executed.
    const historical=t.engine.getFrontier(t.sid).find(f=>f.action.controlId===second.controlId&&f.action.kind==='click')!;
    expect(historical.action.observationId).toBe(before.id);expect(historical.attempts).toEqual([modeA.id]);
    expect(t.engine.report(t.sid).controlCoverage.unit).toBe('encountered_control_operations');
    expect(t.engine.report(t.sid).controlCoverage.limitation).toContain('not every value/state combination');
    // Simulate a retained, separately discovered B obligation using the actual
    // captured B action. The report's reconciliation must use evidence semantics,
    // not infer coverage from the broader legacy traversal sample.
    const {coverage:_coverage,...raw}=historical;
    t.engine.store.put('frontier',{...raw,id:'observed-mode-b',key:'observed-mode-b',stateId:after.stateId,action:second,status:'pending',attempts:[],sampling:{...raw.sampling!,observationIds:[after.id]}});
    expect(t.engine.getFrontier(t.sid).find(f=>f.id==='observed-mode-b')?.coverage).toMatchObject({executionStatus:'not_attempted'});
    expect(t.engine.getFrontier(t.sid).find(f=>f.id==='observed-mode-b')?.coverage.equivalentTo).toBeUndefined();
    expect(t.engine.report(t.sid).explorationAudit.cases.find(c=>c.frontierId==='observed-mode-b')).toMatchObject({observationId:after.id,disposition:'pending',attemptIds:[]});
    const modeB=await t.engine.execute(t.sid, second.id, 'mode-b');
    expect(await t.page.locator('#result').textContent()).toBe('b branch');
    expect([modeA.beforeId,modeB.beforeId]).toEqual([before.id,after.id]);
    expect(t.engine.getFrontier(t.sid).find(f=>f.action.controlId===second.controlId&&f.action.kind==='click')!.attempts).toEqual([modeA.id,modeB.id]);
  } finally { await t.close(); }
});

it('retains passive quote ticks and unrelated form changes in facts without creating new input samples', async () => {
  const t = await fixture(`<main><form id="order"><input id="quantity" aria-label="Quantity"><label><input id="limit" type="checkbox">Limit</label></form>
    <form id="other"><label><input id="newsletter" type="checkbox">Subscribe</label></form><output id="quote">$100</output></main>`);
  try {
    const first = t.engine.observation(t.sid), a = actionFor(t.engine, t.sid, 'id:quantity', 'fill');
    const key = controlCase(a, first, true)!.key;
    await t.page.evaluate(() => {
      (document.querySelector('#quantity') as HTMLInputElement).value = '23';
      (document.querySelector('#newsletter') as HTMLInputElement).checked = true;
      document.querySelector('#quote')!.textContent = '$101 at 12:02';
    });
    const next = await t.engine.observe(t.sid), b = actionFor(t.engine, t.sid, 'id:quantity', 'fill');
    expect(next.canonical).not.toBe(first.canonical);
    expect(controlCase(b, next, true)!.key).toBe(key);
    expect(browserOperationKey(b, next)).toBe(browserOperationKey(a, first));
    await t.page.evaluate(() => { (document.querySelector('#limit') as HTMLInputElement).checked = true; });
    const changed = await t.engine.observe(t.sid);
    expect(controlCase(actionFor(t.engine, t.sid, 'id:quantity', 'fill'), changed, true)!.key).not.toBe(key);
  } finally { await t.close(); }
});

it('bounds retries with unknown selector evidence despite passive price changes without granting coverage equivalence', async () => {
  const t = await fixture('<form id="settings"><button id="mode" type="button" role="option">Mode</button><button id="run" type="button">Run</button></form><input id="quote" aria-label="Price" value="$100" readonly>');
  try {
    const before = t.engine.observation(t.sid), first = actionFor(t.engine, t.sid, 'id:run', 'click');
    expect(browserBranchConditions(first, before)).toBeUndefined();
    expect(controlCase(first, before, true)).toBeUndefined();
    const retryKey = browserOperationKey(first, before), attempt = await t.engine.execute(t.sid, first.id, 'unknown-mode');
    expect(attempt.status).toBe('succeeded');
    await t.page.evaluate(() => { (document.querySelector('#quote') as HTMLInputElement).value = '$102 at 12:04'; });
    const after = await t.engine.observe(t.sid), second = actionFor(t.engine, t.sid, 'id:run', 'click');
    expect(after.stateId).not.toBe(before.stateId);
    expect(browserBranchConditions(second, after)).toBeUndefined();
    expect(controlCase(second, after, true)).toBeUndefined();
    expect(browserOperationKey(second, after)).toBe(retryKey);
    expect(t.engine.getFrontier(t.sid).filter(f=>f.action.controlId===second.controlId&&f.action.kind==='click')).toHaveLength(1);
    expect(t.engine.operationCorrespondence(t.sid, { observationId: after.id, actionId: second.id,
      source: { sessionId: t.sid, attemptId: attempt.id } }).equivalent).toBe(false);
    const rebound = structuredClone(after); rebound.controls.find(c => c.localId === second.localId)!.identityContext = { scope: 'new-owner', evidence: ['test'] };
    expect(browserOperationKey(second, rebound)).not.toBe(retryKey);
    await t.page.evaluate(() => { document.querySelector('#mode')!.setAttribute('aria-selected', 'true'); });
    const known = await t.engine.observe(t.sid), third = actionFor(t.engine, t.sid, 'id:run', 'click');
    expect(browserBranchConditions(third, known)).toBeDefined();
    expect(browserOperationKey(third, known)).not.toBe(retryKey);
  } finally { await t.close(); }
});

it('keeps related tab modes and the target click toggle state while ignoring a select destination starting value', async () => {
  const t = await fixture(`<main><div role="tablist" aria-label="View"><button id="tab-a" role="tab" aria-selected="true">A</button><button id="tab-b" role="tab" aria-selected="false">B</button></div>
    <section role="tabpanel" aria-label="Settings"><button id="run" type="button" aria-expanded="false">Run</button><select id="choice" aria-label="Choice"><option value="x">X</option><option value="y">Y</option></select></section></main>`);
  try {
    const before = t.engine.observation(t.sid), run = actionFor(t.engine, t.sid, 'id:run', 'click'), choice = actionFor(t.engine, t.sid, 'id:choice', 'select');
    const runKey = controlCase(run, before, true)!.key, selectKey = controlCase(choice, before, true)!.key;
    await t.page.evaluate(() => { (document.querySelector('#choice') as HTMLSelectElement).value = 'y'; });
    const selected = await t.engine.observe(t.sid);
    expect(controlCase(actionFor(t.engine, t.sid, 'id:choice', 'select'), selected, true)!.key).toBe(selectKey);
    await t.page.evaluate(() => {
      (document.querySelector('#choice') as HTMLSelectElement).value = 'x';
      document.querySelector('#tab-a')!.setAttribute('aria-selected', 'false');
      document.querySelector('#tab-b')!.setAttribute('aria-selected', 'true');
    });
    const next = await t.engine.observe(t.sid), nextRun = actionFor(t.engine, t.sid, 'id:run', 'click');
    expect(controlCase(nextRun, next, true)!.key).not.toBe(runKey);
    expect(browserBranchConditions(nextRun, next)!.conditions.filter(c => c.state.selected === true)).toHaveLength(1);
    await t.page.evaluate(() => { document.querySelector('#run')!.setAttribute('aria-expanded', 'true'); });
    const expanded = await t.engine.observe(t.sid);
    expect(controlCase(actionFor(t.engine, t.sid, 'id:run', 'click'), expanded, true)!.key).not.toBe(controlCase(nextRun, next, true)!.key);
  } finally { await t.close(); }
});

it('keeps source conditions portable across a fresh document and preserves changed semantic binding', async () => {
  const t = await fixture('<form id="order"><select id="mode" aria-label="Mode"><option value="a">A</option><option value="b">B</option></select><input id="quantity" aria-label="Quantity"></form>');
  try {
    const first = t.engine.observation(t.sid), a = actionFor(t.engine, t.sid, 'id:quantity', 'fill');
    const key = controlCase(a, first, true)!.key;
    await t.page.reload(); const next = await t.engine.observe(t.sid);
    expect(next.documentId).not.toBe(first.documentId);
    const action = actionFor(t.engine, t.sid, 'id:quantity', 'fill');
    expect(controlCase(action, next, true)!.key).toBe(key);
    const changed = structuredClone(next); changed.controls.find(c => c.localId === action.localId)!.identityContext = { scope: 'different-mode-owner', evidence: ['test'] };
    expect(controlCase(action, changed, true)!.key).not.toBe(key);
    expect(browserOperationKey(action, changed)).not.toBe(browserOperationKey(action, next));
  } finally { await t.close(); }
});

it('does not let a disjoint semantic region invalidate every operation through a shared main/document ancestor', async () => {
  const t = await fixture('<main><section aria-label="Left"><button id="run" type="button">Run</button></section><section aria-label="Right"><select id="mode" aria-label="Other mode"><option value="a">A</option><option value="b">B</option></select></section></main>');
  try {
    const before = t.engine.observation(t.sid), action = actionFor(t.engine, t.sid, 'id:run', 'click');
    const key = controlCase(action, before, true)!.key;
    await t.page.evaluate(() => { (document.querySelector('#mode') as HTMLSelectElement).value = 'b'; });
    const after = await t.engine.observe(t.sid);
    expect(controlCase(actionFor(t.engine, t.sid, 'id:run', 'click'), after, true)!.key).toBe(key);
  } finally { await t.close(); }
});

it('declines partial, ambiguous, unstable and overflowing dependency evidence instead of truncating modes', async () => {
  const t = await fixture('<form id="order"><select id="mode" aria-label="Mode"><option value="a">A</option><option value="b">B</option></select><input id="quantity" aria-label="Quantity"></form>');
  try {
    const o = t.engine.observation(t.sid), action = actionFor(t.engine, t.sid, 'id:quantity', 'fill');
    const mode = o.controls.find(c => c.stableKey === 'id:mode')!;
    expect(browserBranchConditions(action, o)?.conditions).toHaveLength(1);
    const change = (mutate: (o: Observation) => void) => { const copy = structuredClone(o); mutate(copy); return browserBranchConditions(action, copy); };
    expect(change(copy => { copy.context.mode = { status: 'unknown', source: 'test', value: null }; })).toBeUndefined();
    expect(change(copy => { copy.gaps.push({ code: 'missing', message: 'Capture incomplete', critical: true }); })).toBeUndefined();
    expect(change(copy => { copy.controls.find(c => c.localId === mode.localId)!.readiness = { status: 'unstable', reason: 'changed selection' }; })).toBeUndefined();
    expect(change(copy => {
      const unknown = copy.controls.find(c => c.localId === mode.localId)!;
      unknown.tag = 'button'; unknown.role = 'tab'; unknown.selected = [];
    })).toBeUndefined();
    expect(change(copy => { copy.controls.push({ ...structuredClone(mode), localId: 'duplicate', instanceId: 'duplicate' }); })).toBeUndefined();
    expect(change(copy => {
      for (let i = 0; i < MAX_BRANCH_CONDITIONS; i++) copy.controls.push({ ...structuredClone(mode),
        localId: `mode-${i}`, instanceId: `mode-${i}`, stableKey: `id:mode-${i}`, name: `Mode ${i}`, label: `Mode ${i}` });
    })).toBeUndefined();
    // Global visual churn may be harmless; only unsettled relevant selectors
    // should invalidate a target's sampled mode conditions.
    expect(browserBranchConditions(action, { ...o, stable: false })).toBeDefined();
  } finally { await t.close(); }
});
