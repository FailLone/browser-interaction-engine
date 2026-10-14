import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { ActionAttempt, Observation, ReachResult } from '@interaction/browser';
import { createServer as createApi } from '../apps/server/src/server.js';
import { act, fixtureServer, pageOf, testEngine } from './helpers.js';

const names = ['Trading pair', 'Order type', 'Price', 'Amount unit', 'Amount', 'Post only', 'Other settings', 'Submit test order',
  'Rebuild inputs', 'Duplicate controls', 'Quick Market', 'Reset interface', 'Background refresh', 'Time in force', 'Done', 'Reference', 'Limit', 'Market'];
const renamed = (name: string) => `Control ${names.indexOf(name) + 1}`;
function varyFixture(source: string) {
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  for (const [i, id] of ids.entries()) source = source.replaceAll(`"${id}"`, `"node-${i}"`);
  for (const name of [...names].sort((a, b) => b.length - a.length)) source = source.replace(new RegExp('\\b' + name + '\\b', 'g'), renamed(name));
  const buttons = source.match(/      <button id="node-.*\n/g)!;
  for (const [i, line] of buttons.entries()) source = source.replace(line, `__BUTTON_${i}__\n`);
  for (const [i, line] of buttons.toReversed().entries()) source = source.replace(`__BUTTON_${i}__\n`, line);
  return source;
}

it.each([false, true])('covers the entire fixture with generic defaults, renamed/reordered=%s', async variation => {
  const fixture = await fixtureServer(variation ? varyFixture : undefined);
  // No app-specific options, callbacks, exclusions, resets, or disabled evidence.
  const t = await testEngine(fixture.url, { exploration: undefined, contextRules: [], maxActions: 1000,
    maxDurationMs: 180000, settleMs: 200, observeTimeoutMs: 2000 });
  const api = await createApi(t.engine);
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const report = t.engine.report(t.sessionId);
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    const observations = t.engine.list<Observation>(t.sessionId, 'observation');
    expect({ stop: report.session.stopReason, counts: report.controlCoverage.counts }).toMatchObject({
      stop: 'known_frontier_exhausted', counts: { actionable: 19, covered: 19, incomplete: 0, readOnly: 1 },
    });
    const expected = [...names, 'Reference'].map(n => variation ? renamed(n) : n).sort();
    expect(report.controlCoverage.items.filter(c => c.classification === 'actionable').map(c => c.label).sort()).toEqual(expected);
    // Verify actual source-node dispatches, independently of aggregate counts.
    const dispatched = new Set(attempts.filter(a => a.status === 'succeeded').map(a => {
      const o = observations.find(o => o.id === a.beforeId)!;
      const c = o.controls.find(c => c.localId === a.action.localId);
      return c ? (c.hypothesisId ? `${c.name}:${c.instanceId}` : c.stableKey || c.identityId) : undefined;
    }));
    const observed = observations.flatMap(o => o.controls).filter(c => c.visible && !c.readOnly && c.actions.some(k => c.actionBasis?.[k]?.status === 'supported'));
    expect(observed.every(c => dispatched.has(c.hypothesisId ? `${c.name}:${c.instanceId}` : c.stableKey || c.identityId)), 'every actual control instance without a stable key was dispatched').toBe(true);
    expect(t.engine.getFrontier(t.sessionId).filter(f => f.action.controlId).every(f => f.status === 'executed')).toBe(true);
    expect(t.engine.getFrontier(t.sessionId).filter(f => f.status === 'superseded').every(f => (f.action.kind === 'scroll' || f.action.boundary?.intent === 'exit') && !f.action.controlId && !f.attempts.length && f.coverage.executionStatus === 'not_attempted')).toBe(true);
    expect(attempts.every(a => a.status === 'succeeded')).toBe(true);
    expect(attempts.filter(a => a.action.risk === 'submission')).toHaveLength(1);
    expect(report.session).toMatchObject({ dirty: true, options: { exploration: 'controls', exclude: [], interfaceActions: [], reversible: [], environmentReset: 'none' } });
    expect(attempts.some(a => a.action.source === 'recovery-reset')).toBe(false);
    expect(t.engine.list<ReachResult>(t.sessionId, 'reach').every(r => r.status === 'REACHED_VERIFIED')).toBe(true);
    const duplicates = attempts.filter(a => a.action.label === (variation ? renamed('Reference') : 'Reference'));
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map(a => a.action.target?.instanceId)).size).toBe(2);
    expect(duplicates.every(a => !a.action.preconditions.identityResolved && a.action.preconditions.targetResolved && !a.action.replayable)).toBe(true);
    expect(observations.some(o => !o.stable && !o.gaps.some(g => g.critical) && o.gaps.some(g => g.code === 'INTERACTION_STABLE'))).toBe(true);
    expect(observations.every(o => o.evidence?.artifacts.details && o.screenshot)).toBe(true);
    expect((await api.inject(`/v1/sessions/${t.sessionId}/report`)).json().controlCoverage).toEqual(report.controlCoverage);
  } finally { await api.close(); await t.close(); await fixture.server.close(); }
}, 180000);

async function htmlEngine(body: string, options: Parameters<typeof testEngine>[1] = {}) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { exploration: 'controls', contextRules: [], ...options });
  return { ...t, close: async () => { await t.close(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}

it('isolates passive volatility while preserving full evidence, strict checkpoints, and live preconditions', async () => {
  const t = await htmlEngine('<input id="ticker" aria-label="Clock" readonly><input id="draft" aria-label="Draft"><button>Run</button><script>setInterval(()=>ticker.value=String(Date.now()),20)</script>', { settleMs: 100 });
  try {
    const initial = t.engine.observation(t.sessionId);
    expect(initial.stable).toBe(false);
    expect(initial.gaps.some(g => g.critical)).toBe(false);
    const cp = await t.engine.createCheckpoint(t.sessionId, 'volatile');
    expect((await t.engine.reachCheckpoint(t.sessionId, cp.id)).status).toBe('UNVERIFIED');
    await act(t.engine, t.sessionId, 'Draft', 'fill', 'abc');
    expect(t.engine.observation(t.sessionId).controls.find(c => c.name === 'Clock')!.value).not.toBe(initial.controls.find(c => c.name === 'Clock')!.value);
    const action = t.engine.actions(t.sessionId).find(a => a.label === 'Run')!;
    await pageOf(t.engine).locator('#draft').fill('changed externally');
    await expect(t.engine.execute(t.sessionId, action.id, 'stale')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
    const fresh = t.engine.actions(t.sessionId).find(a => a.label === 'Run')!;
    await pageOf(t.engine).evaluate(() => { const d = document.createElement('dialog'); d.innerHTML = '<button>Close</button>'; document.body.append(d); d.showModal(); });
    await expect(t.engine.execute(t.sessionId, fresh.id, 'new-dialog')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
  } finally { await t.close(); }
});

it('does not transfer an unresolved instance target to a replacement node', async () => {
  const t = await htmlEngine('<label>Same<input></label><label>Same<input></label>');
  try {
    const a = t.engine.actions(t.sessionId).find(a => a.kind === 'fill')!;
    expect(a).toMatchObject({ preconditions: { identityResolved: false, targetResolved: true }, target: { kind: 'instance' }, replayable: false });
    await pageOf(t.engine).evaluate(() => { const old = document.querySelector('input')!; old.replaceWith(old.cloneNode(true)); });
    await expect(t.engine.execute(t.sessionId, a.id, 'replaced')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    expect(t.engine.controlCoverage(t.sessionId).counts.covered).toBe(0);
  } finally { await t.close(); }
});

it('does not accept a volatile editable target as settled or ignore a declared read-only context', async () => {
  const t = await htmlEngine('<input id="draft" aria-label="Draft"><script>setInterval(()=>draft.value=String(Date.now()),20)</script>', { settleMs: 100 });
  try {
    expect(t.engine.observation(t.sessionId).gaps.some(g => g.code === 'UNSTABLE' && g.critical)).toBe(true);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId)).toMatchObject({ actionCount: 0, stopReason: 'OBSERVATION_INCOMPLETE' });
  } finally { await t.close(); }
  const context = await htmlEngine('<input id="state" aria-label="State" readonly value="before"><button>Run</button>', { contextRules: [{ key: 'version', selector: '#state', required: true }] });
  try {
    const action = context.engine.actions(context.sessionId).find(a => a.label === 'Run')!;
    await pageOf(context.engine).evaluate(() => { (document.querySelector('#state') as HTMLInputElement).value = 'after'; });
    await expect(context.engine.execute(context.sessionId, action.id, 'context-changed')).rejects.toMatchObject({ code: 'PRECONDITIONS_CHANGED' });
    expect(context.engine.session(context.sessionId).actionCount).toBe(0);
  } finally { await context.close(); }
});

it('keeps exclusions, disabled controls and an inadequate budget visible as incomplete coverage', async () => {
  const t = await htmlEngine('<input aria-label="Disabled" disabled><button>First</button><button>Second</button><button>Excluded</button>', { maxActions: 1, exclude: [{ name: 'Excluded' }] });
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const report = t.engine.report(t.sessionId);
    expect(report.controlCoverage.counts).toMatchObject({ actionable: 4, covered: 1, incomplete: 3 });
    expect(report.session.status).toBe('paused');
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt')).toHaveLength(1);
  } finally { await t.close(); }
});

it('continues traversal through newly exposed controls instead of treating a scroll as a control', async () => {
  const t = await htmlEngine(`<style>body {margin:0} section {height:950px}</style><section><button>Page 0</button></section>
    <script>let pages=1;window.addEventListener('scroll',()=>{if(pages<4&&scrollY+innerHeight>=document.body.scrollHeight-5){const s=document.createElement('section');s.innerHTML='<button>Page '+pages+++'</button>';document.body.append(s);}})</script>`, { maxActions: 100, maxDepth: 10 });
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const report = t.engine.report(t.sessionId);
    expect(report.session.stopReason).toBe('known_frontier_exhausted');
    expect(report.controlCoverage.counts).toMatchObject({ actionable: 4, covered: 4, incomplete: 0 });
    expect(report.controlCoverage.items.map(i => i.label).sort()).toEqual(['Page 0', 'Page 1', 'Page 2', 'Page 3']);
  } finally { await t.close(); }
});
