import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { ActionCandidate, ActionAttempt, EngineHooks, InteractionScope } from '@interaction/browser';
import { testEngine, act, pageOf } from './helpers.js';

async function fixture(hooks: EngineHooks) {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<button id="toggle" type="button" onclick="panel.hidden=!panel.hidden">Choices</button>
      <input aria-label="Background"><button id="ineffective" type="button">No effect</button>
      <form onsubmit="event.preventDefault(); window.submits++"><button id="submit">Submit</button></form>
      <div id="panel" hidden role="listbox" style="position:absolute;top:150px;left:30px;width:250px;height:150px;background:white;z-index:10"><button role="option">Alpha</button></div>
      <script>window.submits=0</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as {port:number}).port}`, {
    exploration: 'controls', contextRules: [], interfaceActions: [{ name: 'Choices' }], replayable: [{ name: 'Choices' }],
  }, hooks);
  return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

function declaration(action: ActionCandidate, observationId: string, boundaryKey: string, localId = action.localId!, evidence = ['Observed external toggle for the floating choices panel']) {
  return { ...action, risk: 'interface' as const, replayable: true, basis: { status: 'supported' as const, evidence: [
    ...(action.basis?.evidence || []), { source: 'fixture-reviewer', rule: 'declared-boundary-exit/v1', facts: { observationId, boundaryKey, localId, evidence } },
  ] } };
}

it('accepts a sourced external toggle for the current boundary and verifies its actual exit', async () => {
  let reviewed = false;
  const t = await fixture({ actions: (actions, { observation: o }) => actions.map(a => reviewed && a.label === 'Choices' && o.boundaries?.length
    ? declaration(a, o.id, o.boundaries.at(-1)!.key) : a) });
  try {
    await act(t.engine, t.sessionId, 'Choices');
    const opened = t.engine.observation(t.sessionId);
    expect(t.engine.actions(t.sessionId).find(a => a.label === 'Choices')!.preconditions.blockers?.[0].code).toBe('outside_active_boundary');
    expect(opened.overlays![0].exitControlIds).not.toContain(opened.controls.find(c => c.name === 'Choices')!.localId);
    reviewed = true; await t.engine.observe(t.sessionId);
    const exit = t.engine.actions(t.sessionId).find(a => a.label === 'Choices')!;
    expect(exit).toMatchObject({ boundary: { intent: 'exit' }, replayable: false, preconditions: { blockers: [] } });
    expect((await t.engine.execute(t.sessionId, exit.id, 'reviewed-exit')).status).toBe('succeeded');
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
    expect(t.engine.list<InteractionScope>(t.sessionId, 'scope').find(s => s.boundaryKey === opened.boundaries![0].key)?.status).toBe('closed');
    await act(t.engine, t.sessionId, 'Background', 'fill', 'available again');
    expect(t.engine.observation(t.sessionId, opened.id)).toEqual(opened);
  } finally { await t.close(); }
});

it('uses a freshly reviewed exit during checkpoint recovery without granting historical replay', async () => {
  let reviewed = false;
  const t = await fixture({ actions: (actions, { observation: o }) => actions.map(a => reviewed && a.label === 'Choices' && o.boundaries?.length
    ? declaration(a, o.id, o.boundaries.at(-1)!.key) : a) });
  try {
    const cp = await t.engine.createCheckpoint(t.sessionId, 'before choices');
    await act(t.engine, t.sessionId, 'Choices'); reviewed = true;
    const reached = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(reached.status).toBe('REACHED_VERIFIED');
    expect(reached.attemptIds).toHaveLength(1);
    const exit = t.engine.list<import('@interaction/browser').ActionAttempt>(t.sessionId, 'attempt').find(a => a.id === reached.attemptIds[0])!;
    expect(exit).toMatchObject({ purpose: 'recovery', status: 'succeeded', action: { label: 'Choices', replayable: false, boundary: { intent: 'exit' } } });
    expect(t.engine.graph(t.sessionId).transitions.find(tr => tr.attemptId === exit.id)?.replayable).toBe(false);
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
  } finally { await t.close(); }
});

it('rejects stale, mismatched and unsourced exit declarations without permitting background work', async () => {
  let variant = 'none'; let oldObservation = '';
  const t = await fixture({ actions: (actions, { observation: o }) => actions.map(a => a.label === 'Choices' && o.boundaries?.length
    ? declaration(a, variant === 'stale' ? oldObservation : o.id, variant === 'boundary' ? 'another-boundary' : o.boundaries.at(-1)!.key,
      variant === 'target' ? 'another-target' : a.localId!, variant === 'source' ? [] : ['Toggle evidence']) : a) });
  try {
    await act(t.engine, t.sessionId, 'Choices'); oldObservation = t.engine.observation(t.sessionId).id;
    for (variant of ['stale', 'boundary', 'target', 'source']) {
      await t.engine.observe(t.sessionId);
      const exit = t.engine.actions(t.sessionId).find(a => a.label === 'Choices')!;
      expect(exit.preconditions.blockers?.some(b => b.code === 'outside_active_boundary'), variant).toBe(true);
      await expect(t.engine.execute(t.sessionId, exit.id, `invalid-${variant}`)).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    }
    expect(t.engine.session(t.sessionId).actionCount).toBe(1);
  } finally { await t.close(); }
});

it('does not accept a successful no-op click as an exit, or waive pointer interception', async () => {
  const t = await fixture({ actions: (actions, { observation: o }) => actions.map(a => ['Choices', 'No effect'].includes(a.label) && o.boundaries?.length
    ? declaration(a, o.id, o.boundaries.at(-1)!.key) : a) });
  try {
    await act(t.engine, t.sessionId, 'Choices');
    expect((await act(t.engine, t.sessionId, 'No effect')).status).toBe('succeeded');
    expect(t.engine.observation(t.sessionId).boundaries).toHaveLength(1);
    expect(t.engine.list<InteractionScope>(t.sessionId, 'scope')[0].status).toBe('open');
    await expect(act(t.engine, t.sessionId, 'Background', 'fill', 'blocked')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    await pageOf(t.engine).evaluate(() => {
      const blocker = document.createElement('div'); blocker.style.cssText = 'position:fixed;top:0;left:0;width:150px;height:50px;background:black;z-index:99'; document.body.append(blocker);
    });
    await t.engine.observe(t.sessionId);
    const exit = t.engine.actions(t.sessionId).find(a => a.label === 'Choices')!;
    expect(exit.preconditions.blockers?.some(b => b.code === 'pointer_intercepted')).toBe(true);
    await expect(t.engine.execute(t.sessionId, exit.id, 'covered-exit')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
  } finally { await t.close(); }
});

it('does not downgrade native submission risk or declare it a reviewed boundary exit', async () => {
  const t = await fixture({ actions: (actions, { observation: o }) => actions.map(a => a.label === 'Submit' && o.boundaries?.length
    ? declaration(a, o.id, o.boundaries.at(-1)!.key) : a) });
  try {
    await act(t.engine, t.sessionId, 'Choices');
    const submit = t.engine.actions(t.sessionId).find(a => a.label === 'Submit')!;
    expect(submit.risk).toBe('submission'); expect(submit.boundary).toBeUndefined();
    expect(submit.preconditions.blockers?.some(b => b.code === 'outside_active_boundary')).toBe(true);
    await expect(t.engine.execute(t.sessionId, submit.id, 'not-an-exit')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    expect(await pageOf(t.engine).evaluate(() => (window as any).submits)).toBe(0);
  } finally { await t.close(); }
});

it('uses a unique current exit instance with ambiguous historical identity, without granting replay', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<button id="open" aria-controls="dialog" aria-expanded="false" onclick="dialog.showModal();this.setAttribute('aria-expanded','true')">Open dialog</button>
      <dialog id="dialog" onclose="document.getElementById('open').setAttribute('aria-expanded','false')">
        <button type="button" onclick="dialog.close()">Close</button><button type="button" onclick="dialog.close()">Close</button>
      </dialog>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as {port:number}).port}`, { exploration: 'controls', contextRules: [] });
  try {
    const cp = await t.engine.createCheckpoint(t.sessionId, 'before dialog');
    await act(t.engine, t.sessionId, 'Open dialog');
    const exits = t.engine.actions(t.sessionId).filter(a => a.label === 'Close');
    expect(exits).toHaveLength(2);
    expect(exits.every(a => !a.preconditions.identityResolved && a.preconditions.targetResolved && !a.replayable)).toBe(true);
    const result = await t.engine.reachCheckpoint(t.sessionId, cp.id);
    expect(result.status).toBe('REACHED_VERIFIED');
    const attempts = t.engine.list<ActionAttempt>(t.sessionId, 'attempt').filter(a => a.purpose === 'recovery');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'succeeded', action: { label: 'Close', replayable: false, preconditions: { identityResolved: false, targetResolved: true } } });
    expect(t.engine.graph(t.sessionId).transitions.find(tr => tr.attemptId === attempts[0].id)?.replayable).toBe(false);
    expect(t.engine.observation(t.sessionId).boundaries).toEqual([]);
  } finally { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
