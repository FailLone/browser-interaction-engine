import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, type ActionAttempt, type EngineHooks, type ExplorationGroup, type SessionOptions } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { InteractionClient } from '@interaction/client';
import { createServer as createApi } from '../apps/server/src/server.js';
import { pageOf } from './helpers.js';

const reason = { source: 'goal-based-orchestrator', evidence: ['Current test objective explicitly selects this scope'] };
async function fixture(body: string, hooks: EngineHooks = {}, options: Partial<SessionOptions> = {}) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ persistence: new MemoryStore(), hooks });
  const session = await engine.createSession({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, headless: true, settleMs: 40, observeTimeoutMs: 600, ...options });
  return { engine, sid: session.id, close: async () => { await engine.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const groups = (t: Awaited<ReturnType<typeof fixture>>) => t.engine.list<ExplorationGroup>(t.sid, 'exploration-group');
const attempts = (t: Awaited<ReturnType<typeof fixture>>) => t.engine.list<ActionAttempt>(t.sid, 'attempt');
const explore = async (t: Awaited<ReturnType<typeof fixture>>) => { await t.engine.explore(t.sid); await t.engine.waitForIdle(); };

it('keeps new browser producers opt-in and permits custom scopes over arbitrary current actions', async () => {
  const body = '<title>   </title><section aria-label="Work"><button type="button">Primary</button><button type="button">Secondary</button></section>';
  const normal = await fixture(body);
  try { expect(groups(normal)).toEqual([]); expect(normal.engine.session(normal.sid).options.decisionScopes).toEqual([]); }
  finally { await normal.close(); }
  const t = await fixture(body, { explorationScopes: actions => [{ key: 'secondary-work', kind: 'custom-goal', label: 'Secondary work',
    conditions: { goal: 'primary-only' }, actionIds: actions.filter(a => a.label === 'Secondary').map(a => a.id), traversalActionIds: [],
    evidence: [{ source: 'test-plan', rule: 'explicit-goal/v1', facts: { purpose: 'Review optional work separately' } }] }] });
  try {
    await explore(t); expect(attempts(t).map(a => a.action.label)).toEqual(['Primary']);
    expect(t.engine.session(t.sid).stopReason).toBe('EXPLORATION_DECISION_REQUIRED');
    expect(groups(t)[0]).toMatchObject({ kind: 'custom-goal', status: 'pending' });
  } finally { await t.close(); }
});

it('selects regions by external goals, continuing permitted work while another region is deferred or skipped', async () => {
  const t = await fixture('<section aria-label="Primary"><button type="button">Main action</button></section><section aria-label="Optional"><button type="button">Optional action</button></section>',
    { explorationDecision: g => ({ ...reason, mode: g.label === 'Primary' ? 'all' : 'defer' }) }, { decisionScopes: ['region'] });
  try {
    await explore(t); expect(attempts(t).map(a => a.action.label)).toEqual(['Main action']);
    expect(t.engine.session(t.sid).stopReason).toBe('EXPLORATION_DEFERRED');
    const g = groups(t).find(g => g.label === 'Optional')!;
    await t.engine.decideExplorationGroup(t.sid, g.id, g.revision, { ...reason, mode: 'skip' }); await explore(t);
    expect(t.engine.session(t.sid).stopReason).toBe('known_frontier_exhausted_with_gaps');
    expect(t.engine.getFrontier(t.sid).find(f => f.action.label === 'Optional action')).toMatchObject({ status: 'skipped', coverage: { executionStatus: 'not_attempted' } });
    expect(t.engine.controlCoverage(t.sid).counts).toMatchObject({ covered: 1, incomplete: 1 });
  } finally { await t.close(); }
});

it('gates a single branch entry without preapproving the newly revealed child region, and always retains its exit', async () => {
  const t = await fixture('<button type="button" popovertarget="panel" aria-expanded="false">Open</button><button type="button">Parent work</button><div id="panel" popover><section aria-label="Child"><button type="button">Child work</button><button type="button" popovertarget="panel" popovertargetaction="hide">Close</button></section></div>',
    { explorationDecision: g => g.kind === 'branch' || g.kind === 'region' && g.label !== 'Child' ? { ...reason, mode: 'all' } : { ...reason, mode: 'skip' } },
    { decisionScopes: ['region', 'branch'] });
  try {
    await explore(t);
    const labels = attempts(t).map(a => a.action.label);
    expect(labels).toContain('Open'); expect(labels).toContain('Close'); expect(labels).toContain('Parent work'); expect(labels).not.toContain('Child work');
    expect(t.engine.observation(t.sid).boundaries).toEqual([]);
    const child = groups(t).find(g => g.kind === 'region' && g.label === 'Child')!;
    expect(child.decisions[0].decision.mode).toBe('skip'); expect(child.members.map(m => m.label)).toEqual(['Child work']);
    expect(groups(t).filter(g => g.kind === 'branch').map(g => g.label)).toEqual(['Open']);
  } finally { await t.close(); }
});

it('samples an input space without enumerating its remaining values or conflating scope and execution coverage', async () => {
  const t = await fixture('<input aria-label="Query"><button type="button">Other work</button>', {
    samples: c => c.label === 'Query' ? ['small', 'large'] : undefined,
    explorationDecision: g => ({ ...reason, mode: 'sample', memberKeys: [g.members.find(m => m.value === 'small')!.key] }),
  }, { decisionScopes: ['input-space'] });
  try {
    await explore(t);
    expect(attempts(t).map(a => [a.action.kind, a.action.value])).toEqual([['click', undefined], ['fill', 'small']]);
    expect(groups(t)).toHaveLength(1);
    expect(t.engine.getFrontier(t.sid).find(f => f.action.value === 'large')).toMatchObject({ status: 'deferred', reason: 'exploration_member_not_selected', coverage: { executionStatus: 'not_attempted' } });
    expect(t.engine.session(t.sid).stopReason).toBe('known_frontier_exhausted_with_gaps');
  } finally { await t.close(); }
});

it('checks rebuilt region ownership before dispatch, invalidates its old decision, and never reuses it after document reload', async () => {
  const t = await fixture('<section id="owner" aria-label="Work"><button id="action" type="button">Work</button></section>', {}, { decisionScopes: ['region'] });
  try {
    const old = groups(t)[0]; await t.engine.decideExplorationGroup(t.sid, old.id, old.revision, { ...reason, mode: 'all' });
    const action = t.engine.actions(t.sid).find(a => a.label === 'Work')!;
    await pageOf(t.engine).locator('#owner').evaluate(el => { const replacement = el.cloneNode(false); while (el.firstChild) replacement.appendChild(el.firstChild); el.replaceWith(replacement); });
    await expect(t.engine.execute(t.sid, action.id, 'old-region')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(attempts(t)).toEqual([]); expect(groups(t).find(g => g.id === old.id)?.status).toBe('invalidated');
    let next = groups(t).find(g => g.status === 'pending')!;
    await t.engine.decideExplorationGroup(t.sid, next.id, next.revision, { ...reason, mode: 'all' });
    await pageOf(t.engine).reload(); await t.engine.observe(t.sid);
    expect(groups(t).find(g => g.id === next.id)?.status).toBe('invalidated');
    expect(groups(t).filter(g => g.status === 'pending')).toHaveLength(1);
    await explore(t); expect(attempts(t)).toEqual([]);
  } finally { await t.close(); }
});

it('invalidates input constraints and branch target changes while preserving ordinary safety blockers', async () => {
  const t = await fixture('<input id="value" aria-label="Value" maxlength="8"><a id="link" href="#one">Link</a><button disabled type="button">Disabled</button>',
    { samples: () => ['abc'] }, { decisionScopes: ['input-space', 'branch', 'region'] });
  try {
    const original = groups(t);
    for (const g of original) await t.engine.decideExplorationGroup(t.sid, g.id, g.revision, { ...reason, mode: 'all' });
    await pageOf(t.engine).evaluate(() => { document.querySelector('#value')!.setAttribute('maxlength', '4'); document.querySelector('#link')!.setAttribute('href', '#two'); });
    await t.engine.observe(t.sid);
    for (const kind of ['input-space', 'branch']) {
      expect(groups(t).find(g => g.id === original.find(g => g.kind === kind)!.id)?.status).toBe('invalidated');
      expect(groups(t).some(g => g.kind === kind && g.status === 'pending')).toBe(true);
    }
    expect(t.engine.getFrontier(t.sid).find(f => f.action.label === 'Disabled')).toMatchObject({ status: 'blocked', reason: 'disabled' });
    await explore(t); expect(attempts(t)).toEqual([]);
  } finally { await t.close(); }
});

it('combines list and generic scope decisions and exposes skip through the SDK/HTTP protocol', async () => {
  const t = await fixture('<select aria-label="Currency"><option>A</option><option>B</option><option>C</option></select>', {}, { decisionScopes: ['input-space'] });
  const api = await createApi(t.engine); await api.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${(api.server.address() as { port: number }).port}`);
  try {
    const listed = (await client.explorationGroups(t.sid)).items; expect(listed.map(g => g.kind).sort()).toEqual(['input-space', 'similar-list']);
    const list = listed.find(g => g.kind === 'similar-list')!, input = listed.find(g => g.kind === 'input-space')!;
    await client.decideExplorationGroup(t.sid, list.id, list.revision, { ...reason, mode: 'all' });
    await explore(t); expect(attempts(t)).toEqual([]);
    await client.decideExplorationGroup(t.sid, input.id, input.revision, { ...reason, mode: 'skip' }); await explore(t);
    const skipped = await client.frontier(t.sid, { status: 'skipped' }); expect(skipped.total).toBe(2);
    expect(skipped.items.every(f => f.coverage.executionStatus === 'not_attempted')).toBe(true);
    const report = t.engine.report(t.sid); expect(report.explorationGroups.find(g => g.id === input.id)?.mode).toBe('skip');
    const current = (await client.explorationGroups(t.sid)).items.find(g => g.id === input.id)!;
    await client.decideExplorationGroup(t.sid, current.id, current.revision, { ...reason, mode: 'sample', memberKeys: [current.members.find(m => m.value === 'B')!.key] });
    await explore(t); expect(attempts(t).map(a => a.action.value)).toEqual(['B']);
  } finally { await api.close(); await t.close(); }
});

it('keeps identically named regions distinct using observed owner instances', async () => {
  const t = await fixture('<section aria-label="Same"><button type="button">First</button></section><section aria-label="Same"><button type="button">Second</button></section>', {}, { decisionScopes: ['region'] });
  try {
    const initial = groups(t); expect(initial).toHaveLength(2);
    expect(initial.map(g => g.members.map(m => m.label))).toEqual([['First'], ['Second']]);
    await t.engine.decideExplorationGroup(t.sid, initial[0].id, initial[0].revision, { ...reason, mode: 'all' });
    await explore(t); expect(attempts(t).map(a => a.action.label)).toEqual(['First']);
    expect(t.engine.session(t.sid).stopReason).toBe('EXPLORATION_DECISION_REQUIRED');
  } finally { await t.close(); }
});

it('binds a detected popup scope to its owner even without an inner semantic region', async () => {
  const t = await fixture('<button type="button" popovertarget="panel" aria-expanded="false">Open</button><div id="panel" popover aria-label="Popup work"><button type="button">Inside</button><button type="button" popovertarget="panel" popovertargetaction="hide">Close</button></div>', {}, { decisionScopes: ['region'] });
  try {
    await t.engine.execute(t.sid, t.engine.actions(t.sid).find(a => a.label === 'Open')!.id, 'open');
    const popup = groups(t).find(g => g.label === 'Popup work')!; expect(popup).toBeDefined();
    await t.engine.decideExplorationGroup(t.sid, popup.id, popup.revision, { ...reason, mode: 'all' });
    const inside = t.engine.actions(t.sid).find(a => a.label === 'Inside')!;
    await pageOf(t.engine).locator('#panel').evaluate(el => { const next = el.cloneNode(false) as HTMLElement; while (el.firstChild) next.appendChild(el.firstChild); el.replaceWith(next); next.showPopover(); });
    await expect(t.engine.execute(t.sid, inside.id, 'old-popup')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(groups(t).find(g => g.id === popup.id)?.status).toBe('invalidated');
    expect(groups(t).some(g => g.label === 'Popup work' && g.status === 'pending')).toBe(true);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Open']);
  } finally { await t.close(); }
});

it('rejects a previously approved target moved into a different identically named region', async () => {
  const t = await fixture('<section id="first" aria-label="Same"><button id="work" type="button">Work</button></section><section id="second" aria-label="Same"><button type="button">Other</button></section>', {}, { decisionScopes: ['region'] });
  try {
    const allowed = groups(t).find(g => g.members.some(m => m.label === 'Work'))!;
    await t.engine.decideExplorationGroup(t.sid, allowed.id, allowed.revision, { ...reason, mode: 'all' });
    const action = t.engine.actions(t.sid).find(a => a.label === 'Work')!;
    await pageOf(t.engine).evaluate(() => document.querySelector('#second')!.appendChild(document.querySelector('#work')!));
    await expect(t.engine.execute(t.sid, action.id, 'moved-target')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(attempts(t)).toEqual([]);
    expect(t.engine.getFrontier(t.sid).find(f => f.action.label === 'Work' && f.action.observationId === t.engine.observation(t.sid).id)?.status).toBe('deferred');
    await explore(t); expect(attempts(t).filter(a => a.action.label === 'Work')).toEqual([]);
  } finally { await t.close(); }
});

it('organizes scopes by exact observed region and boundary owners, with stable collections across captures', async () => {
  const t = await fixture('<section aria-label="Same"><a href="/first">First</a></section><section aria-label="Same"><a href="/second">Second</a></section>', {}, { decisionScopes: ['region', 'branch'] });
  try {
    const initial = t.engine.explorationReviewMaterial(t.sid);
    expect(initial.collections).toHaveLength(2); expect(initial.collections.map(c => c.label)).toEqual(['Same', 'Same']);
    expect(initial.collections.every(c => c.groupIds.length === 2)).toBe(true);
    expect(initial.overlaps).toHaveLength(2);
    await t.engine.observe(t.sid); const next = t.engine.explorationReviewMaterial(t.sid);
    expect(next.collections).toEqual(initial.collections); expect(next.groups.map(g => g.revision)).toEqual(initial.groups.map(g => g.revision));
    const selection = new Set(initial.collections[0].groupIds);
    await t.engine.decideExplorationGroups(t.sid, initial.groups.filter(g => selection.has(g.id)).map(g => ({ groupId: g.id, revision: g.revision, decision: { ...reason, mode: 'all' } })));
    const frontier = t.engine.getFrontier(t.sid);
    expect(frontier.find(f => f.action.label === 'First')?.status).toBe('pending');
    expect(frontier.find(f => f.action.label === 'Second')?.reason).toBe('awaiting_exploration_decision');
    expect(attempts(t)).toEqual([]);
  } finally { await t.close(); }
});

it('queries unified material and atomically applies mixed sample decisions through SDK/HTTP', async () => {
  const t = await fixture('<select aria-label="Choice"><option>A</option><option>B</option><option>C</option></select>', {}, { decisionScopes: ['input-space'] });
  const api = await createApi(t.engine); await api.listen({ host: '127.0.0.1', port: 0 });
  const address = `http://127.0.0.1:${(api.server.address() as { port: number }).port}`;
  const client = new InteractionClient(address);
  try {
    const material = await client.explorationReviewMaterial(t.sid); const input = material.groups.find(g => g.kind === 'input-space')!;
    expect(material.collections).toHaveLength(1); expect(material.collections[0].groupIds).toHaveLength(2);
    expect((await fetch(`${address}/v1/sessions/${t.sid}/exploration-review`)).headers.get('cache-control')).toBe('no-store');
    const batch = material.groups.map(g => ({ groupId: g.id, revision: g.revision, decision: g.id === input.id ? { ...reason, mode: 'sample' as const, memberKeys: [g.members.find(m => m.value === 'B')!.key] } : { ...reason, mode: 'all' as const } }));
    await expect(client.decideExplorationGroups(t.sid, [batch[0], { ...batch[1], revision: 999 }])).rejects.toMatchObject({ code: 'STALE_GROUP_DECISION' });
    expect((await client.explorationReviewMaterial(t.sid)).groups.every(g => g.status === 'pending')).toBe(true);
    const malformed = await fetch(`${address}/v1/sessions/${t.sid}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'decideExplorationGroups', resolutions: [] }) });
    expect(malformed.status).toBe(400);
    expect(await client.decideExplorationGroups(t.sid, batch)).toHaveLength(2); expect(attempts(t)).toEqual([]);
    await explore(t); expect(attempts(t).map(a => a.action.value)).toEqual(['B']);
    expect(t.engine.getFrontier(t.sid).filter(f => f.action.value !== 'B').every(f => f.coverage.executionStatus === 'not_attempted')).toBe(true);
  } finally { await api.close(); await t.close(); }
});
