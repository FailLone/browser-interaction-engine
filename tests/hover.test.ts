import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import type { ActionCandidate, EngineHooks } from '@interaction/browser';
import { act, pageOf, testEngine } from './helpers.js';

function hoverReview(names: string[]): EngineHooks {
  return { actions: (actions, { observation: o, session }) => [...actions, ...o.controls.filter(c => c.visible && names.includes(c.name)).map(c => ({
    id: '', sessionId: session.id, observationId: o.id, stateId: o.stateId, controlId: c.identityId, localId: c.localId,
    kind: 'hover', label: c.name, risk: 'interface', replayable: false, excluded: false, sampleValidity: 'known', source: 'fixture-reviewer',
    preconditions: { context: o.context, visible: c.visible, enabled: c.enabled, identityResolved: !c.hypothesisId },
    basis: { status: 'supported', evidence: [{ source: 'fixture-reviewer', rule: 'hover-purpose/v1', facts: { purpose: 'Reveal informational content without activation' } }] },
  } satisfies ActionCandidate))] };
}

async function fixture(html: string, names: string[], hooks?: EngineHooks) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { exploration: 'controls', contextRules: [], interfaceActions: [{ name: 'Open', kind: 'click' }] }, hooks || hoverReview(names));
  return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it('executes a reviewed hover without clicking, retains the tooltip and stable trigger identity, and counts that operation', async () => {
  const t = await fixture(`<style>[role=tooltip]{visibility:hidden;position:absolute;top:35px;left:0}#hint:hover [role=tooltip]{visibility:visible}</style>
    <div id="hint" tabindex="0" style="position:relative;width:120px;height:30px;cursor:pointer" onclick="window.clicks++">Information<span role="tooltip">Explanation after hover</span></div>
    <script>window.clicks=0</script>`, ['Information']);
  try {
    const before = t.engine.observation(t.sessionId); const trigger = before.controls.find(c => c.stableKey === 'id:hint')!;
    expect(trigger.actionBasis?.hover).toBeUndefined();
    const hover = t.engine.actions(t.sessionId).find(a => a.kind === 'hover');
    expect(hover).toMatchObject({ label: 'Information', basis: { status: 'supported' }, replayable: false });
    expect((await act(t.engine, t.sessionId, 'Information', 'hover')).status).toBe('succeeded');
    const after = t.engine.observation(t.sessionId);
    expect(after.text).toContain('Explanation after hover'); expect(await pageOf(t.engine).evaluate(() => (window as any).clicks)).toBe(0);
    expect(after.controls.find(c => c.instanceId === trigger.instanceId)).toMatchObject({ name: 'Information', identityId: trigger.identityId });
    expect(after.boundaries).toEqual([]);
    expect(t.engine.controlCoverage(t.sessionId).items.find(i => i.controlIds.includes(trigger.identityId!))?.operations).toContainEqual(expect.objectContaining({ kind: 'hover', succeeded: true }));
    expect(t.engine.observation(t.sessionId, before.id)).toEqual(before);
  } finally { await t.close(); }
});

it('does not infer hover capability or schedule pointer hints without a sourced action judgment', async () => {
  const t = await fixture('<div tabindex="0" style="cursor:pointer">Unreviewed hint</div>', [], {});
  try {
    expect(t.engine.actions(t.sessionId)).toEqual([]);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    expect(t.engine.controlCoverage(t.sessionId).counts).toMatchObject({ actionable: 0, unconfirmed: 1 });
  } finally { await t.close(); }
});

it('blocks occluded, unreachable and replaced hover targets while allowing an ordinary below-fold target', async () => {
  const t = await fixture(`<style>body{height:1800px}#covered{position:absolute;top:20px;left:20px;width:100px;height:30px}#mask{position:absolute;top:15px;left:15px;width:120px;height:50px;z-index:10;background:black}</style>
    <button id="covered" type="button">Covered</button><div id="mask"></div>
    <button style="position:absolute;left:-3000px;top:-3000px">Unreachable</button>
    <button id="below" style="position:absolute;top:1500px" onmouseenter="window.entered=true">Below fold</button>`, ['Covered', 'Unreachable', 'Below fold']);
  try {
    await expect(act(t.engine, t.sessionId, 'Covered', 'hover')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    await expect(act(t.engine, t.sessionId, 'Unreachable', 'hover')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    expect((await act(t.engine, t.sessionId, 'Below fold', 'hover')).status).toBe('succeeded');
    expect(await pageOf(t.engine).evaluate(() => (window as any).entered)).toBe(true);
    const old = t.engine.actions(t.sessionId).find(a => a.kind === 'hover' && a.label === 'Below fold')!;
    await pageOf(t.engine).locator('#below').evaluate(el => el.replaceWith(el.cloneNode(true)));
    await expect(t.engine.execute(t.sessionId, old.id, 'replaced-hover')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
  } finally { await t.close(); }
});

it('does not treat hovering a close control as an exit or permit hovering its external toggle through a boundary', async () => {
  const t = await fixture(`<button popovertarget="panel" type="button">Open</button>
    <div id="panel" popover><button popovertarget="panel" popovertargetaction="hide" type="button">Close</button></div>`, ['Open', 'Close']);
  try {
    await act(t.engine, t.sessionId, 'Open');
    const openHover = t.engine.actions(t.sessionId).find(a => a.kind === 'hover' && a.label === 'Open')!;
    expect(openHover.preconditions.blockers?.some(b => b.code === 'outside_active_boundary')).toBe(true);
    await expect(t.engine.execute(t.sessionId, openHover.id, 'outside-hover')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    const closeHover = t.engine.actions(t.sessionId).find(a => a.kind === 'hover' && a.label === 'Close')!;
    expect(closeHover.boundary?.intent).toBe('interact');
    expect((await t.engine.execute(t.sessionId, closeHover.id, 'hover-close')).status).toBe('succeeded');
    expect(t.engine.observation(t.sessionId).boundaries).toHaveLength(1);
    await act(t.engine, t.sessionId, 'Close');
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
  } finally { await t.close(); }
});
