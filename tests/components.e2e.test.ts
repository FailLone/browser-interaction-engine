import { beforeAll, afterAll, it, expect } from 'vitest';
import { fixtureServer, testEngine, pageOf } from './helpers.js';
import { InteractionClient } from '@interaction/client';
import { createServer } from '../apps/server/src/server.js';
let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const options = { contextRules: [], exploration: 'controls' as const, evidenceRetention: { mode: 'cache' as const, ttlMs: 60000, maxBytes: 64 * 1024 ** 2, maxObservations: 100 } };

it('discovers a tentative custom selector and keeps its search, list and exit in one boundary', async () => {
  const t = await testEngine(`${fixture.url}/components.html`, options);
  try {
    const perform = async (label: string, kind = 'click', value?: string) => {
      const action = t.engine.actions(t.sessionId).find(a => a.label === label && a.kind === kind)!;
      expect(action).toBeDefined(); return t.engine.execute(t.sessionId, action.id, crypto.randomUUID(), value);
    };
    const opener = t.engine.actions(t.sessionId).find(a => a.label === 'Alpha')!;
    expect(opener.basis?.status).toBe('tentative');
    expect(await perform('Alpha')).toMatchObject({ status: 'succeeded', action: { replayable: false } });
    let observation = t.engine.observation(t.sessionId);
    expect(observation.boundaries).toHaveLength(1);
    const search = t.engine.actions(t.sessionId).find(a => a.kind === 'fill' && a.label === 'Search choices')!;
    expect(search.preconditions.blockers).toEqual([]);
    expect(search.boundary?.key).toBe(observation.boundaries![0].key);
    const outside = t.engine.actions(t.sessionId).find(a => a.label === 'Outside input')!;
    expect(outside.preconditions.blockers?.some(b => b.code === 'outside_active_boundary')).toBe(true);
    expect(await perform('Search choices', 'fill', 'bet')).toMatchObject({ status: 'succeeded' });
    const exit = t.engine.actions(t.sessionId).find(a => a.label === 'Alpha' && a.kind === 'click')!;
    expect(exit.boundary?.intent).toBe('exit');
    expect(await perform('Alpha')).toMatchObject({ status: 'succeeded' });
    observation = t.engine.observation(t.sessionId); expect(observation.boundaries).toEqual([]);
    expect(await perform('Parent action')).toMatchObject({ status: 'succeeded' });
    expect(await pageOf(t.engine).locator('#result').textContent()).toBe('parent executed');
  } finally { await t.close(); }
});

it('provides one tentative five-member group without invented values or merged identities, over SDK and HTTP', async () => {
  const t = await testEngine(`${fixture.url}/components.html`, options);
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const api = new InteractionClient(`http://127.0.0.1:${(app.server.address() as any).port}`);
  try {
    const o = t.engine.observation(t.sessionId); const group = o.components!.find(c => c.name === 'Page feedback')!;
    expect(group).toMatchObject({ kind: 'choice-group', basis: { status: 'tentative' } }); expect(group.members).toHaveLength(5);
    expect(group.members.every(m => m.value === undefined)).toBe(true);
    const controls = o.controls.filter(c => group.members.some(m => m.localId === c.localId));
    expect(new Set(controls.map(c => c.identityId)).size).toBe(5);
    const details = await api.componentDetails(t.sessionId, o.id, group.id);
    expect(details).toEqual(JSON.parse(JSON.stringify(await t.engine.componentDetails(t.sessionId, o.id, group.id))));
    expect(details.subtree.nodes.some(n => n.text === '★')).toBe(true); expect(details.ancestors.length).toBeGreaterThan(0);
    expect(details.members.every(m => m.node && m.actions.some(a => a.kind === 'click'))).toBe(true);
    expect(details.screenshotRegion.width).toBeLessThan(group.rect.width);
    expect(details.screenshotRegion.x).toBe(controls[0].rect.x);
    expect((await api.components(t.sessionId, o.id)).components).toEqual(o.components);
    const delivery = o.components!.find(c => c.name === 'Delivery')!;
    expect(delivery.members.map(m => m.value)).toEqual(['slow', 'fast']); expect(delivery.basis.status).toBe('supported');
    const input = { observationId: o.id, componentId: group.id, kind: 'rating', name: 'Feedback rating', source: 'fixture-reviewer', reason: 'Fixture specifies this scale',
      members: group.members.map((m, i) => ({ ...m, value: i + 1 })), evidence: [{ observationId: o.id, componentId: group.id }] };
    const saved = await api.describeComponent(t.sessionId, input);
    expect(saved).toMatchObject(input);
    expect((await api.componentDetails(t.sessionId, o.id, group.id)).descriptions).toEqual([saved]);
    expect(t.engine.observation(t.sessionId, o.id)).toEqual(o);
    expect(t.engine.session(t.sessionId).actionCount).toBe(0);
    await expect(api.describeComponent(t.sessionId, { ...input, members: [input.members[0], ...input.members.slice(0, 4)] })).rejects.toMatchObject({ code: 'INVALID_COMPONENT' });
    await expect(t.engine.describeComponent(t.sessionId, { ...input, evidence: [{ observationId: o.id, localId: 'invented' }] })).rejects.toMatchObject({ code: 'INVALID_COMPONENT' });
    await pageOf(t.engine).locator('.rating').evaluate(el => el.setAttribute('data-component-kind', 'other'));
    await expect(api.describeComponent(t.sessionId, input)).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    await expect(t.engine.describeComponent(t.sessionId, input)).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    const old = await api.componentDetails(t.sessionId, o.id, group.id);
    expect(old.component.kind).toBe('choice-group'); expect(old.timeline).toHaveLength(1); expect(old.descriptions).toHaveLength(1);
    await t.engine.releaseEvidence(t.sessionId, o.id);
    const unavailable = await api.componentDetails(t.sessionId, o.id, group.id);
    expect(unavailable.subtree.nodes).toEqual([]); expect(unavailable.gaps.some(g => g.code === 'COMPONENT_DOM_UNAVAILABLE')).toBe(true);
  } finally { await app.close(); await t.close(); }
});

it('records explicit hover/focus probes with before/after evidence, budgets, current-instance guards and idempotency', async () => {
  // Probes can inspect ambiguous current instances even in stateful mode, without resolving them.
  const t = await testEngine(`${fixture.url}/components.html`, { contextRules: [], exploration: 'stateful', maxActions: 6,
    replayable: [{ kind: 'hover' }], interfaceActions: [{ kind: 'hover' }], exclude: [{ kind: 'hover', name: 'Outside input' }] });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const api = new InteractionClient(`http://127.0.0.1:${(app.server.address() as any).port}`);
  try {
    const first = t.engine.observation(t.sessionId); const group = first.components!.find(c => c.name === 'Page feedback')!;
    expect(t.engine.actions(t.sessionId).some(a => ['hover', 'focus'].includes(a.kind))).toBe(false);
    await expect(api.probe(t.sessionId, first.id, first.controls.find(c => c.name === 'Outside input')!.localId, 'hover', crypto.randomUUID())).rejects.toMatchObject({ code: 'ACTION_EXCLUDED' });
    for (let i = 0; i < 5; i++) {
      const o = t.engine.observation(t.sessionId); const requestId = crypto.randomUUID();
      const attempt = await api.probe(t.sessionId, o.id, group.members[i].localId, 'hover', requestId);
      expect(attempt).toMatchObject({ status: 'succeeded', beforeId: o.id, action: { source: 'external-probe', risk: 'unknown', replayable: false, target: { kind: 'instance' } } });
      expect(await api.probe(t.sessionId, o.id, group.members[i].localId, 'hover', requestId)).toEqual(attempt);
      await expect(api.probe(t.sessionId, o.id, group.members[i].localId, 'focus', requestId)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
      const evidence = await api.componentDetails(t.sessionId, attempt.afterId!, group.id);
      expect(evidence.subtree.nodes.filter(n => n.attributes?.class?.includes('active'))).toHaveLength(i + 1);
      expect(evidence.timeline.at(-1)?.attempt?.id).toBe(attempt.id);
      expect(await pageOf(t.engine).locator('#votes').textContent()).toBe('0');
      expect(t.engine.session(t.sessionId).actionCount).toBe(i + 1);
    }
    await expect(api.probe(t.sessionId, first.id, group.members[0].localId, 'hover', crypto.randomUUID())).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    let o = t.engine.observation(t.sessionId);
    const opener = o.controls.find(c => c.name === 'Alpha' && c.visible && c.actions.includes('click') && c.tag === 'div')!;
    await expect(api.probe(t.sessionId, o.id, opener.localId, 'focus', crypto.randomUUID())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const outside = o.controls.find(c => c.name === 'Outside input')!;
    expect(await t.engine.probe(t.sessionId, o.id, outside.localId, 'focus', crypto.randomUUID())).toMatchObject({ status: 'succeeded' });
    expect(await pageOf(t.engine).locator('#outside').evaluate(el => el === document.activeElement)).toBe(true);
    o = t.engine.observation(t.sessionId);
    await expect(api.probe(t.sessionId, o.id, group.members[0].localId, 'hover', crypto.randomUUID())).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(t.engine.list(t.sessionId, 'attempt')).toHaveLength(6);
    expect(t.engine.session(t.sessionId).dirty).toBe(true);
    const old = await api.componentDetails(t.sessionId, first.id, group.id);
    expect(old.timeline).toHaveLength(1); expect(old.subtree.nodes.filter(n => n.attributes?.class?.includes('active'))).toHaveLength(0);
  } finally { await app.close(); await t.close(); }
});

it('applies popup boundaries and live target revalidation to probes', async () => {
  const t = await testEngine(`${fixture.url}/components.html`, options);
  try {
    const opener = t.engine.actions(t.sessionId).find(a => a.label === 'Alpha')!;
    await t.engine.execute(t.sessionId, opener.id, crypto.randomUUID());
    let o = t.engine.observation(t.sessionId); const outside = o.controls.find(c => c.name === 'Outside input')!;
    await expect(t.engine.probe(t.sessionId, o.id, opener.localId!, 'hover', crypto.randomUUID())).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    await expect(t.engine.probe(t.sessionId, o.id, outside.localId, 'hover', crypto.randomUUID())).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    const search = o.controls.find(c => c.name === 'Search choices' && c.visible)!;
    expect(await t.engine.probe(t.sessionId, o.id, search.localId, 'focus', crypto.randomUUID())).toMatchObject({ status: 'succeeded' });
    o = t.engine.observation(t.sessionId);
    await pageOf(t.engine).locator('.panel input').first().evaluate(el => el.replaceWith(el.cloneNode(true)));
    await expect(t.engine.probe(t.sessionId, o.id, search.localId, 'focus', crypto.randomUUID())).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(t.engine.session(t.sessionId).actionCount).toBe(2);
  } finally { await t.close(); }
});

it('keeps equivalent component state across reload without equating node identities, and includes declared values in state', async () => {
  const t = await testEngine(`${fixture.url}/components.html`, options);
  try {
    const before = t.engine.observation(t.sessionId);
    await pageOf(t.engine).reload(); const after = await t.engine.observe(t.sessionId);
    expect(after.canonical).toBe(before.canonical);
    const a = before.components!.find(c => c.name === 'Page feedback')!, b = after.components!.find(c => c.name === 'Page feedback')!;
    expect(a.id).not.toBe(b.id);
    expect((await t.engine.componentDetails(t.sessionId, after.id, b.id)).timeline).toHaveLength(1);
    await pageOf(t.engine).locator('.rating button').first().evaluate(el => el.setAttribute('data-component-value', 'verified-value'));
    const changed = await t.engine.observe(t.sessionId); expect(changed.canonical).not.toBe(after.canonical);
  } finally { await t.close(); }
});
