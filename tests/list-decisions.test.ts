import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { BrowserEngine, type ActionAttempt, type EngineHooks, type ExplorationGroup, type SessionOptions } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { pageOf } from './helpers.js';
import { createServer as createApi } from '../apps/server/src/server.js';
import { InteractionClient } from '@interaction/client';
import { SqliteStore } from '@interaction/storage-sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Persistence } from '@interaction/core';

const decision = { source: 'test-consumer', evidence: ['Observed common list owner and independently identified options'] };
const choices = '<div role="listbox" aria-label="Choices"><button type="button" role="option">One</button><button type="button" role="option">Two</button><button type="button" role="option">Three</button></div>';
async function fixture(body: string, hooks: EngineHooks = {}, options: Partial<SessionOptions> = {}, persistence: Persistence = new MemoryStore()) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ persistence, hooks });
  const session = await engine.createSession({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, headless: true, settleMs: 40, observeTimeoutMs: 600, ...options });
  return { engine, sid: session.id, close: async () => { await engine.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const groups = (t: Awaited<ReturnType<typeof fixture>>) => t.engine.list<ExplorationGroup>(t.sid, 'exploration-group');
const attempts = (t: Awaited<ReturnType<typeof fixture>>) => t.engine.list<ActionAttempt>(t.sid, 'attempt');
const explore = async (t: Awaited<ReturnType<typeof fixture>>) => { await t.engine.explore(t.sid); await t.engine.waitForIdle(); };

it('requests a list decision once, explores other work and waits without counting deferred choices as covered', async () => {
  const t = await fixture(choices + '<button type="button">Other work</button>');
  try {
    expect(t.engine.session(t.sid).options.listExploration).toBe('review');
    const original = t.engine.observation(t.sid); const group = groups(t)[0];
    expect(group).toMatchObject({ status: 'pending', label: 'Choices' }); expect(group.members).toHaveLength(3);
    await t.engine.observe(t.sid); await t.engine.observe(t.sid); await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Other work']);
    expect(t.engine.session(t.sid)).toMatchObject({ status: 'paused', stopReason: 'LIST_DECISION_REQUIRED' });
    expect(t.engine.store.events(t.sid).filter(e => e.type === 'exploration.group_detected')).toHaveLength(1);
    const deferred = t.engine.getFrontier(t.sid).filter(f => f.status === 'deferred');
    expect(deferred).toHaveLength(3); expect(deferred.every(f => f.reason === 'awaiting_list_decision' && f.coverage.executionStatus === 'not_attempted')).toBe(true);
    expect(t.engine.controlCoverage(t.sid).counts).toMatchObject({ covered: 1, incomplete: 3 });
    expect(t.engine.observation(t.sid, original.id)).toEqual(original);
  } finally { await t.close(); }
});

it('accepts an immediate all decision but prioritizes ordinary work and keeps the original risk and permissions', async () => {
  let calls = 0;
  const t = await fixture(choices + '<button type="button">Other work</button>', { explorationGroup: () => { calls++; return { ...decision, mode: 'all' }; } });
  try {
    const before = t.engine.actions(t.sid).map(a => [a.label, a.risk, a.replayable, a.basis]);
    await explore(t);
    expect(calls).toBe(1); expect(attempts(t).map(a => a.action.label)).toEqual(['Other work', 'One', 'Two', 'Three']);
    for (const a of attempts(t)) expect(before).toContainEqual([a.action.label, a.action.risk, a.action.replayable, a.action.basis]);
    expect(t.engine.controlCoverage(t.sid).counts).toMatchObject({ covered: 4, incomplete: 0 });
  } finally { await t.close(); }
});

it('executes only explicitly sampled members, preserves remaining gaps, and can later exhaust the group', async () => {
  const t = await fixture(choices);
  try {
    let group = groups(t)[0]; const member = group.members.find(m => m.label === 'Two')!;
    await expect(t.engine.decideExplorationGroup(t.sid, group.id, group.revision, { ...decision, mode: 'sample', memberKeys: ['foreign-member'] })).rejects.toMatchObject({ code: 'INVALID_GROUP_DECISION' });
    await t.engine.command(t.sid, { type: 'decideExplorationGroup', groupId: group.id, revision: group.revision, decision: { ...decision, mode: 'sample', memberKeys: [member.key] } });
    await expect(t.engine.decideExplorationGroup(t.sid, group.id, group.revision, { ...decision, mode: 'all' })).rejects.toMatchObject({ code: 'STALE_GROUP_DECISION' });
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Two']);
    expect(t.engine.getFrontier(t.sid).filter(f => f.reason === 'list_member_not_selected')).toHaveLength(2);
    expect(t.engine.session(t.sid).stopReason).toBe('known_frontier_exhausted_with_gaps');
    group = groups(t)[0]; await t.engine.decideExplorationGroup(t.sid, group.id, group.revision, { ...decision, mode: 'all' }); await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Two', 'One', 'Three']);
  } finally { await t.close(); }
});

it('preserves deferred decisions and treats a failed or invalid hook as unanswered', async () => {
  for (const mode of ['defer', 'throw', 'invalid'] as const) {
    const t = await fixture(choices, { explorationGroup: () => {
      if (mode === 'throw') throw new Error('Consumer unavailable');
      return mode === 'defer' ? { ...decision, mode: 'defer' } : { ...decision, mode: 'sample', memberKeys: ['wrong'] };
    } });
    try {
      await explore(t); expect(attempts(t)).toEqual([]);
      expect(groups(t)[0].status).toBe(mode === 'defer' ? 'decided' : 'pending');
      expect(t.engine.getFrontier(t.sid).every(f => f.status === 'deferred')).toBe(true);
      if (mode !== 'defer') expect(t.engine.store.events(t.sid).some(e => e.type === 'hook.error')).toBe(true);
    } finally { await t.close(); }
  }
});

it('updates a growing list without repeating the request, and does not apply an old sample to a replacement business item', async () => {
  const t = await fixture(choices);
  try {
    const initial = groups(t)[0]; const selected = initial.members.find(m => m.label === 'One')!;
    await pageOf(t.engine).locator('[role=listbox]').evaluate(el => { const b = document.createElement('button'); b.type = 'button'; b.role = 'option'; b.textContent = 'Four'; el.append(b); });
    await t.engine.observe(t.sid);
    expect(groups(t)).toHaveLength(1); expect(groups(t)[0].members).toHaveLength(4);
    await expect(t.engine.decideExplorationGroup(t.sid, initial.id, initial.revision, { ...decision, mode: 'all' })).rejects.toMatchObject({ code: 'STALE_GROUP_DECISION' });
    await t.engine.decideExplorationGroup(t.sid, initial.id, groups(t)[0].revision, { ...decision, mode: 'sample', memberKeys: [selected.key] });
    await pageOf(t.engine).getByRole('option', { name: 'One', exact: true }).evaluate(el => { el.textContent = 'Replacement'; }); await t.engine.observe(t.sid);
    expect(groups(t)[0].members.some(m => m.label === 'Replacement' && m.key !== selected.key)).toBe(true);
    expect(t.engine.getFrontier(t.sid).find(f => f.action.label === 'Replacement')).toMatchObject({ status: 'deferred', reason: 'list_member_not_selected' });
    await explore(t);
    // Recovery may reopen the historical source. That new document needs a new
    // decision; the sampled business object must never transfer to Replacement.
    expect(attempts(t).filter(a => a.action.kind === 'click')).toEqual([]);
    expect(t.engine.store.events(t.sid).filter(e => e.type === 'exploration.group_detected' && (e.data as ExplorationGroup).id === initial.id)).toHaveLength(1);
  } finally { await t.close(); }
});

it('exits a popup with deferred choices before exploring its parent, and later reenters after a decision', async () => {
  const t = await fixture('<button type="button" popovertarget="panel" aria-expanded="false">Open</button><button type="button">Other work</button><div id="panel" popover>' + choices + '<button type="button" popovertarget="panel" popovertargetaction="hide">Close</button></div>');
  try {
    await explore(t); expect(attempts(t).map(a => a.action.label)).toEqual(['Open', 'Close', 'Other work']);
    expect(t.engine.observation(t.sid).boundaries).toEqual([]);
    expect(t.engine.session(t.sid).stopReason).toBe('LIST_DECISION_REQUIRED');
    const group = groups(t)[0]; await t.engine.decideExplorationGroup(t.sid, group.id, group.revision, { ...decision, mode: 'all' }); await explore(t);
    expect(attempts(t).filter(a => ['One', 'Two', 'Three'].includes(a.action.label)).map(a => a.action.label).sort()).toEqual(['One', 'Three', 'Two']);
  } finally { await t.close(); }
});

it('groups native select choices but leaves ordinary buttons and semantically different operations independent', async () => {
  const t = await fixture('<select aria-label="Currency"><option>A</option><option>B</option><option>C</option></select><button type="button">Similar A</button><button type="button">Similar B</button><div role="listbox"><input aria-label="Search"><button role="option" type="button">Only option</button></div>');
  try {
    expect(groups(t)).toHaveLength(1); expect(groups(t)[0].members.map(m => m.value)).toEqual(['B', 'C']);
    expect(t.engine.getFrontier(t.sid).filter(f => f.status === 'deferred')).toHaveLength(2);
    expect(t.engine.getFrontier(t.sid).find(f => f.action.label === 'Search')?.status).toBe('pending');
    expect(t.engine.getFrontier(t.sid).find(f => f.action.label === 'Only option')?.status).toBe('pending');
  } finally { await t.close(); }
});

it('defers list scrolling with its members, then discovers and executes virtualized choices after an all decision', async () => {
  const t = await fixture(`<div id="viewport" role="listbox" aria-label="Virtual choices" style="height:90px;overflow:auto;width:200px"><div id="filler" style="height:450px"></div></div><button type="button">Other work</button>
    <script>window.chosen=[];const listViewport=document.getElementById('viewport');const listFiller=document.getElementById('filler');function renderChoices(){const start=Math.floor(listViewport.scrollTop/90)*2;listFiller.innerHTML='<div style="height:'+listViewport.scrollTop+'px"></div>'+[start,start+1].filter(i=>i<8).map(i=>'<button type="button" role="option" style="height:35px;display:block" onclick="window.chosen.push('+i+')">Item '+i+'</button>').join('');}listViewport.addEventListener('scroll',renderChoices);renderChoices();</script>`);
  try {
    expect(groups(t)).toHaveLength(1);
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Other work']);
    expect(t.engine.getFrontier(t.sid).some(f => f.action.kind === 'scroll' && f.status === 'deferred')).toBe(true);
    await pageOf(t.engine).locator('#filler').evaluate(el => { el.replaceChildren(); }); await t.engine.observe(t.sid); await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Other work']);
    expect(t.engine.getFrontier(t.sid).some(f => f.action.kind === 'scroll' && f.status === 'deferred')).toBe(true);
    await pageOf(t.engine).evaluate(() => (window as any).renderChoices()); await t.engine.observe(t.sid);
    let group = groups(t)[0]; await t.engine.decideExplorationGroup(t.sid, group.id, group.revision, { ...decision, mode: 'all' }); await explore(t);
    expect(await pageOf(t.engine).evaluate(() => [...new Set((window as any).chosen)].sort())).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(t.engine.store.events(t.sid).filter(e => e.type === 'exploration.group_detected')).toHaveLength(1);
    expect(groups(t)[0].members).toHaveLength(8);
  } finally { await t.close(); }
});

it('keeps a popup boundary when no exit works instead of dispatching parent work around the decision', async () => {
  const t = await fixture('<div role="dialog" aria-modal="true">' + choices + '</div><button type="button">Parent work</button>');
  try {
    await explore(t);
    expect(attempts(t).every(a => a.action.kind === 'press')).toBe(true);
    expect(t.engine.session(t.sid).stopReason).toBe('ACTIVE_BOUNDARY_BLOCKED');
    expect(t.engine.observation(t.sid).boundaries).toHaveLength(1);
    expect(groups(t)[0].status).toBe('pending');
  } finally { await t.close(); }
});

it('serves durable group events and revision-checked decisions through the SDK and HTTP API', async () => {
  const t = await fixture(choices); const api = await createApi(t.engine); await api.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${(api.server.address() as { port: number }).port}`);
  try {
    const listed = await client.explorationGroups(t.sid); expect(listed.total).toBe(1); const group = listed.items[0];
    const events = await client.request<{ type: string; data: ExplorationGroup }[]>(`/sessions/${t.sid}/events?format=json&after=0`);
    expect(events.find(e => e.type === 'exploration.group_detected')?.data.id).toBe(group.id);
    await expect(client.decideExplorationGroup(t.sid, group.id, group.revision + 1, { ...decision, mode: 'all' })).rejects.toMatchObject({ code: 'STALE_GROUP_DECISION' });
    const invalid = await api.inject({ method: 'POST', url: `/v1/sessions/${t.sid}/commands`, payload: { type: 'decideExplorationGroup', groupId: group.id, revision: group.revision, decision: { mode: 'all' } } });
    expect(invalid.statusCode).toBe(400);
    await client.decideExplorationGroup(t.sid, group.id, group.revision, { ...decision, mode: 'sample', memberKeys: [group.members[0].key] });
    expect(attempts(t)).toEqual([]); // The decision itself does not start execution.
    await explore(t); expect(attempts(t)).toHaveLength(1);
    const remaining = await client.frontier(t.sid, { status: 'deferred' }); expect(remaining.total).toBe(2);
    expect(remaining.items.every(f => f.coverage.executionStatus === 'not_attempted')).toBe(true);
  } finally { await api.close(); await t.close(); }
});

it('invalidates list ownership before dispatch and asks again for a replacement list, context or document', async () => {
  const t = await fixture('<input id="context" value="A" readonly>' + choices, {}, { contextRules: [{ key: 'scope', selector: '#context' }] });
  try {
    let group = groups(t)[0]; await t.engine.decideExplorationGroup(t.sid, group.id, group.revision, { ...decision, mode: 'all' });
    const old = t.engine.actions(t.sid).find(a => a.label === 'One')!;
    await pageOf(t.engine).locator('[role=listbox]').evaluate(el => { const replacement = el.cloneNode(false); while (el.firstChild) replacement.appendChild(el.firstChild); el.replaceWith(replacement); });
    await expect(t.engine.execute(t.sid, old.id, 'old-list-owner')).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(attempts(t)).toEqual([]); expect(groups(t).filter(g => g.status === 'pending')).toHaveLength(1);
    group = groups(t).find(g => g.status === 'pending')!; await t.engine.decideExplorationGroup(t.sid, group.id, group.revision, { ...decision, mode: 'all' });
    await pageOf(t.engine).locator('#context').evaluate(el => { (el as HTMLInputElement).value = 'B'; }); await t.engine.observe(t.sid);
    expect(groups(t).filter(g => g.status === 'pending')).toHaveLength(1);
    expect(t.engine.getFrontier(t.sid).filter(f => f.contextKey === groups(t).find(g => g.status === 'pending')!.contextKey).every(f => f.status === 'deferred')).toBe(true);
    group = groups(t).find(g => g.status === 'pending')!; await t.engine.decideExplorationGroup(t.sid, group.id, group.revision, { ...decision, mode: 'all' });
    await pageOf(t.engine).reload(); await t.engine.observe(t.sid);
    expect(groups(t).filter(g => g.status === 'pending')).toHaveLength(1);
    expect(groups(t).find(g => g.status === 'pending')!.instanceScope).not.toBe(group.instanceScope);
  } finally { await t.close(); }
});

it('allows one explicit manual operation without implicitly approving the rest of the list', async () => {
  const t = await fixture(choices);
  try {
    const action = t.engine.actions(t.sid).find(a => a.label === 'One')!;
    await t.engine.execute(t.sid, action.id, 'explicit-single-choice'); await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['One']); expect(groups(t)[0].status).toBe('pending');
    expect(t.engine.getFrontier(t.sid).filter(f => f.status === 'deferred')).toHaveLength(2);
  } finally { await t.close(); }
});

it('persists decisions and event cursors across restart before attaching a browser', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'list-decisions-')); const store = new SqliteStore(directory);
  const t = await fixture(choices, {}, {}, store); let closed = false;
  try {
    const group = groups(t)[0]; await t.engine.decideExplorationGroup(t.sid, group.id, group.revision, { ...decision, mode: 'sample', memberKeys: [group.members[0].key] });
    const cursor = store.events(t.sid).at(-1)!.sequence;
    await t.close(); closed = true;
    const restored = new BrowserEngine({ persistence: new SqliteStore(directory) });
    try {
      expect(restored.list<ExplorationGroup>(t.sid, 'exploration-group')[0]).toMatchObject({ id: group.id, status: 'decided', decisions: [{ decision: { mode: 'sample' } }] });
      expect(restored.store.events(t.sid, cursor)).toEqual([]);
      expect(restored.getFrontier(t.sid).filter(f => f.status === 'deferred')).toHaveLength(2);
      // A different browser document is deliberately not started here: the
      // restored ledger is inspectable before any browser or user action.
      expect(restored.session(t.sid).actionCount).toBe(0);
    } finally { await restored.close(); }
  } finally { if (!closed) await t.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('supports an explicit whole-session all policy and does not lift disabled or excluded members through a group decision', async () => {
  const unrestricted = await fixture(choices, {}, { listExploration: 'all' });
  try { await explore(unrestricted); expect(groups(unrestricted)).toEqual([]); expect(attempts(unrestricted)).toHaveLength(3); }
  finally { await unrestricted.close(); }
  const t = await fixture('<div role="listbox"><button type="button" role="option">Allowed</button><button type="button" role="option" disabled>Disabled</button><button type="button" role="option">Excluded</button></div>',
    { explorationGroup: () => ({ ...decision, mode: 'all' }) }, { exclude: [{ name: 'Excluded' }] });
  try {
    await explore(t); expect(attempts(t).map(a => a.action.label)).toEqual(['Allowed']);
    expect(t.engine.getFrontier(t.sid).find(f => f.action.label === 'Disabled')).toMatchObject({ status: 'blocked', reason: 'disabled' });
    expect(t.engine.getFrontier(t.sid).find(f => f.action.label === 'Excluded')).toMatchObject({ status: 'blocked', reason: 'excluded_by_rule' });
  } finally { await t.close(); }
});
