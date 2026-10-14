import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import type { ActionCandidate, EngineHooks } from '@interaction/browser';
import { act, pageOf, testEngine } from './helpers.js';

async function fixture(html: string, hooks: EngineHooks = {}) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { exploration: 'controls', contextRules: [] }, hooks);
  return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it('keeps a reviewed generic selector distinct from its changing child popup while retaining complete text', async () => {
  let reviewedInstance = '';
  const t = await fixture(`<div data-selector style="position:relative;width:160px;height:40px;cursor:pointer">
    <span data-value>Primary</span><div id="panel" style="display:none;position:absolute;top:45px;left:0;width:240px;height:180px;background:white;cursor:default">
      <input aria-label="Filter"><div id="results"><div role="listbox" style="position:absolute;top:40px"><button role="option">Choice A</button></div></div>
      <button type="button" style="position:absolute;bottom:0" onclick="panel.style.display='none'">Done</button>
    </div></div>
    <script>document.addEventListener('click', e => { if(e.target.closest('[data-selector]') && !e.target.closest('#panel')) panel.style.display='block'; });</script>`, {
    actions: (actions, { observation: o, session }) => {
      const c = o.controls.find(c => c.instanceId === reviewedInstance && c.name === 'Primary');
      if (!c) return actions;
      const reviewed: ActionCandidate = { id: '', sessionId: session.id, observationId: o.id, stateId: o.stateId,
        controlId: c.identityId, localId: c.localId, kind: 'click', label: c.name, risk: 'interface', replayable: false, excluded: false, sampleValidity: 'known',
        source: 'fixture-reviewer', basis: { status: 'supported', evidence: [{ source: 'fixture', rule: 'review/v1', facts: { purpose: 'Open current selector' } }] },
        preconditions: { context: o.context, visible: c.visible, enabled: c.enabled, identityResolved: !c.hypothesisId } };
      return [...actions, reviewed];
    },
  });
  try {
    const first = t.engine.observation(t.sessionId);
    const selector = first.controls.find(c => c.role === 'generic' && c.rect.width === 160)!;
    expect(selector.name).toBe('Primary'); expect(selector.actions).toEqual([]);
    expect(selector.displayedText).toContain('Choice A');
    reviewedInstance = selector.instanceId;
    await t.engine.observe(t.sessionId); await act(t.engine, t.sessionId, 'Primary');
    expect(t.engine.observation(t.sessionId).boundaries).toHaveLength(1);
    for (const markup of ['<div role="listbox" style="position:absolute;top:40px"><button role="option">Choice Z</button></div>', '<p>No matching choices</p>']) {
      await pageOf(t.engine).locator('#results').evaluate((el, markup) => { el.innerHTML = markup; }, markup);
      const next = await t.engine.observe(t.sessionId);
      const c = next.controls.find(c => c.instanceId === reviewedInstance)!;
      expect(c).toMatchObject({ name: 'Primary', identityId: selector.identityId, actions: [] });
      expect(next.boundaries).toHaveLength(1);
      expect(c.displayedText).toMatch(/Choice Z|No matching choices/);
      expect(next.text).toMatch(/Choice Z|No matching choices/);
      expect(t.engine.actions(t.sessionId).some(a => a.source === 'fixture-reviewer' && a.localId === c.localId)).toBe(true);
    }
    await pageOf(t.engine).locator('#results').evaluate(el => { el.innerHTML = '<div role="listbox" style="position:absolute;top:40px"><button role="option">Choice Z</button></div>'; });
    await t.engine.observe(t.sessionId); await act(t.engine, t.sessionId, 'Done');
    expect(t.engine.observation(t.sessionId).controls.find(c => c.instanceId === reviewedInstance)!.identityId).toBe(selector.identityId);
    await act(t.engine, t.sessionId, 'Primary');
    expect(t.engine.observation(t.sessionId).boundaries).toHaveLength(1);
    await pageOf(t.engine).locator('[data-value]').evaluate(el => { el.textContent = 'Secondary'; });
    const changed = await t.engine.observe(t.sessionId);
    const rebound = changed.controls.find(c => c.instanceId === reviewedInstance)!;
    expect(rebound.name).toBe('Secondary'); expect(rebound.identityId).not.toBe(selector.identityId);
    expect(t.engine.actions(t.sessionId).some(a => a.source === 'fixture-reviewer')).toBe(false);
    expect(t.engine.observation(t.sessionId, first.id)).toEqual(first);
  } finally { await t.close(); }
});

it('preserves explicit names including hidden referenced labels, and keeps ordinary positioned descriptions', async () => {
  const t = await fixture(`<span id="label" hidden>Declared choice</span>
    <button aria-labelledby="label">Fallback<div role="listbox"><span>Changing option</span></div></button>
    <button aria-label="Explicit choice"><span aria-hidden="true">Decorative text</span></button>
    <div data-card style="cursor:pointer;position:relative;width:200px;height:60px">Open <span data-description style="position:absolute;top:20px">Record A</span></div>`);
  try {
    const first = t.engine.observation(t.sessionId);
    expect(first.controls.filter(c => c.role === 'button').map(c => c.name)).toEqual(['Declared choice', 'Explicit choice']);
    const card = first.controls.find(c => c.role === 'generic')!;
    expect(card.name).toBe('Open Record A');
    await pageOf(t.engine).locator('[data-description]').evaluate(el => { el.textContent = 'Record B'; });
    const next = await t.engine.observe(t.sessionId);
    const updated = next.controls.find(c => c.instanceId === card.instanceId)!;
    expect(updated.name).toBe('Open Record B'); expect(updated.identityId).not.toBe(card.identityId);
  } finally { await t.close(); }
});

it('does not merge same-named selector instances when their child options differ', async () => {
  const t = await fixture(`<div style="cursor:pointer">Choose<div role="listbox" hidden>First options</div></div>
    <div style="cursor:pointer">Choose<div role="listbox" hidden>Second options</div></div>`);
  try {
    const controls = t.engine.observation(t.sessionId).controls.filter(c => c.visible && c.role === 'generic');
    expect(controls.map(c => c.name)).toEqual(['Choose', 'Choose']);
    expect(new Set(controls.map(c => c.instanceId)).size).toBe(2);
    expect(new Set(controls.map(c => c.identityId)).size).toBe(2);
    expect(controls.every(c => c.hypothesisId)).toBe(true);
  } finally { await t.close(); }
});
