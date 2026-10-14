import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ActionAttempt, FrontierItem, ControlIdentity } from '@interaction/browser';
import { fixtureServer, pageOf, testEngine } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const options = { contextRules: [], maxActions: 3 };

it('separates native/declared capabilities, weak hints and current actionability', async () => {
  const t = await testEngine(`${fixture.url}/action-evidence.html`, options);
  try {
    const o = t.engine.observation(t.sessionId);
    const control = (id: string) => o.controls.find(c => c.stableKey === `id:${id}`)!;
    const actions = (id: string) => t.engine.actions(t.sessionId).filter(a => a.controlId === control(id).identityId);
    for (const id of ['focus', 'pointer', 'anchor', 'expanded', 'weak-combination', 'container', 'orphan-summary', 'file', 'color', 'range']) {
      expect(control(id), id).toBeDefined(); expect(control(id).actions, id).toEqual([]); expect(actions(id), id).toEqual([]);
    }
    expect(control('focus').discovery).toContain('selector:[tabindex]');
    expect(control('focus').interactionHints).toContainEqual({ source: 'dom-signal', rule: 'tabindex/v1', facts: { attribute: 'tabindex', value: '0' } });
    expect(control('pointer').interactionHints?.[0].source).toBe('css');
    expect(actions('native')[0].basis).toMatchObject({ status: 'supported', evidence: [{ source: 'html', rule: 'native-button/v1' }] });
    expect(actions('declared')[0].basis).toMatchObject({ status: 'supported', evidence: [{ source: 'aria', facts: { role: 'button', implementation: 'unverified' } }] });
    expect(actions('summary')[0].basis?.evidence[0].rule).toBe('details-summary/v1');
    expect(actions('link')[0].basis?.evidence[0].facts.href).toBe('#destination');
    expect(actions('switch')[0].kind).toBe('check');
    expect(actions('edit-host')[0].kind).toBe('fill');
    expect(actions('child')[0].kind).toBe('click');
    for (const id of ['handler', 'property']) expect(actions(id)[0].basis?.status).toBe('tentative');
    expect(actions('readonly').map(a => a.kind)).toEqual(['fill']);
    expect(actions('readonly')[0].preconditions.blockers?.[0].code).toBe('not_editable');
    await expect(t.engine.execute(t.sessionId, actions('readonly')[0].id, 'readonly')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    expect(actions('disabled')[0]).toMatchObject({ kind: 'fill', preconditions: { enabled: false } });
    expect(o.gaps.some(g => g.code === 'EVENT_LISTENER_COVERAGE')).toBe(true);
    expect(o.controls.some(c => c.stableKey === 'id:delegate')).toBe(false); // No false claim to enumerate addEventListener.
  } finally { await t.close(); }
});

it.each(['modal', 'handler-modal'])('never automatically clicks the %s text container and preserves its identity', async mode => {
  const t = await testEngine(`${fixture.url}/action-evidence.html?mode=${mode}`, { ...options, exclude: [{ stableKey: 'id:reminder' }] });
  try {
    const o = t.engine.observation(t.sessionId);
    const dialog = o.controls.find(c => c.stableKey === 'testid:notice-window')!;
    expect(dialog.role).toBe('dialog'); expect(dialog.name).toContain('Products aren’t available');
    const dialogActions = t.engine.actions(t.sessionId).filter(a => a.controlId === dialog.identityId);
    if (mode === 'modal') expect(dialogActions).toEqual([]);
    else expect(dialogActions[0].basis?.status).toBe('tentative');
    expect(t.engine.actions(t.sessionId).some(a => a.label === "Don't show for 7 days" && a.kind === 'check')).toBe(true);
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
    expect(attempts.map(a => a.action.label)).toEqual(['Read details', 'Close', 'Parent action']);
    expect(attempts.some(a => a.action.controlId === dialog.identityId)).toBe(false);
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    const identity = t.engine.list<ControlIdentity>(t.sessionId, 'identity').find(i => i.id === dialog.identityId)!;
    expect(identity.occurrences.length).toBeGreaterThan(1);
    expect(t.engine.observation(t.sessionId, o.id).controls.find(c => c.identityId === dialog.identityId)).toEqual(dialog);
  } finally { await t.close(); }
});

it('retains tentative operations in events/frontier, skips DFS and allows an explicit non-replayable probe', async () => {
  const t = await testEngine(`${fixture.url}/action-evidence.html?mode=tentative`, options);
  try {
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.session(t.sessionId).stopReason).toBe('known_frontier_exhausted_with_gaps');
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt')).toEqual([]);
    expect(t.engine.list<FrontierItem>(t.sessionId, 'frontier')[0]).toMatchObject({ status: 'blocked', reason: 'action_basis_unconfirmed' });
    const action = t.engine.actions(t.sessionId)[0];
    expect(t.engine.store.events(t.sessionId).some(e => e.type === 'action.tentative')).toBe(true);
    const attempt = await t.engine.execute(t.sessionId, action.id, 'explicit-probe');
    expect(attempt).toMatchObject({ status: 'succeeded', purpose: 'external', action: { replayable: false, basis: { status: 'tentative' } } });
    expect(attempt.diff?.changes).toEqual([]); // Successful dispatch is not evidence of a meaningful effect.
    expect(await pageOf(t.engine).evaluate(() => (window as any).handlerCalls)).toBe(1);
    expect(t.engine.actions(t.sessionId)[0].basis?.status).toBe('tentative');
    expect(t.engine.graph(t.sessionId).transitions.every(x => !x.replayable)).toBe(true);
  } finally { await t.close(); }
});

it('revalidates operation evidence when a handler disappears before execution', async () => {
  const t = await testEngine(`${fixture.url}/action-evidence.html?mode=tentative`, options);
  try {
    const action = t.engine.actions(t.sessionId)[0];
    await pageOf(t.engine).evaluate(() => { document.getElementById('handler')!.removeAttribute('onclick'); document.getElementById('handler')!.setAttribute('tabindex', '0'); });
    await expect(t.engine.execute(t.sessionId, action.id, 'stale-handler')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    expect(t.engine.actions(t.sessionId)).toEqual([]);
    expect(t.engine.observation(t.sessionId).controls[0].identityId).toBe(action.controlId);
  } finally { await t.close(); }
});

it('accepts an external action judgment with evidence without rewriting the original observation', async () => {
  let resolved = false;
  const t = await testEngine(`${fixture.url}/action-evidence.html?mode=tentative`, { ...options, maxActions: 1 }, {
    actions: actions => actions.map(a => resolved ? { ...a, basis: { status: 'supported', evidence: [...a.basis!.evidence, { source: 'fixture-plugin', rule: 'caller-contract/v1', facts: { operation: 'increment handlerCalls' } }] } } : a),
  });
  try {
    const before = t.engine.observation(t.sessionId);
    expect(t.engine.actions(t.sessionId)[0].basis?.status).toBe('tentative');
    resolved = true;
    await t.engine.explore(t.sessionId); await t.engine.waitForIdle();
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt')).toHaveLength(1);
    expect(t.engine.list<ActionAttempt>(t.sessionId, 'attempt')[0].action.basis?.evidence.at(-1)?.source).toBe('fixture-plugin');
    expect(t.engine.observation(t.sessionId, before.id).controls[0].actionBasis?.click.status).toBe('tentative');
  } finally { await t.close(); }
});
