import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { type ActionAttempt, type EngineHooks, type ExplorationGroup, type SessionOptions } from '@interaction/browser';
import { createServer as createApi } from '../apps/server/src/server.js';
import { InteractionClient } from '@interaction/client';
import { act, pageOf, testEngine } from './helpers.js';

async function fixture(pages: Record<string, string>, hooks: EngineHooks = {}, options: Partial<SessionOptions> = {}) {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(pages[req.url!] || '<h1>Empty destination</h1>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}/a`, { exploration: 'controls', contextRules: [], maxActions: 30, ...options }, hooks);
  return { ...t, close: async () => { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const reason = { source: 'test-goal', evidence: ['Only the explicitly selected page is in scope'] };
const explore = async (t: Awaited<ReturnType<typeof fixture>>) => { await t.engine.explore(t.sessionId); await t.engine.waitForIdle(); };
const attempts = (t: Awaited<ReturnType<typeof fixture>>) => t.engine.list<ActionAttempt>(t.sessionId, 'attempt');
const groups = (t: Awaited<ReturnType<typeof fixture>>) => t.engine.list<ExplorationGroup>(t.sessionId, 'exploration-group');

it('defaults to entry-page work before known navigation, then returns without spending the budget on the destination', async () => {
  const t = await fixture({ '/a': '<a href="/b">Early link</a><input aria-label="A work">', '/b': '<input aria-label="B work"><a href="/c">Go deeper</a>' });
  try {
    expect(t.engine.session(t.sessionId).options.pageExploration).toBe('review');
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['A work', 'Early link', 'Return to observed page']);
    expect(t.engine.observation(t.sessionId).url).toContain('/a');
    expect(t.engine.session(t.sessionId).stopReason).toBe('PAGE_DECISION_REQUIRED');
    const page = groups(t).find(g => g.kind === 'page')!;
    expect(page).toMatchObject({ status: 'pending', binding: 'context' });
    expect(t.engine.getFrontier(t.sessionId).find(f => f.action.label === 'B work')).toMatchObject({ status: 'deferred', coverage: { executionStatus: 'not_attempted' } });
    expect(t.engine.report(t.sessionId).pageExploration?.lastReturn?.status).toBe('returned');
    expect(t.engine.list(t.sessionId, 'reach')).toEqual([]);
  } finally { await t.close(); }
});

it('catches an unannounced button navigation and resumes the remaining entry-page controls', async () => {
  const t = await fixture({ '/a': '<button type="button" onclick="location.href=\'/b\'">Surprise</button><input aria-label="Remaining A">', '/b': '<input aria-label="Never run B">' }, {}, { interfaceActions: [{ name: 'Surprise' }] });
  try {
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Surprise', 'Return to observed page', 'Remaining A']);
    expect(t.engine.session(t.sessionId).stopReason).toBe('PAGE_DECISION_REQUIRED');
  } finally { await t.close(); }
});

it('uses the existing decision hook for a destination without implicitly permitting the next destination', async () => {
  const t = await fixture({ '/a': '<a href="/b">To B</a>', '/b': '<a href="/c">To C</a><input aria-label="B work">', '/c': '<input aria-label="C work">' }, {
    explorationDecision: g => g.kind === 'page' && (g.conditions as { url: string }).url.endsWith('/b') ? { ...reason, mode: 'all' } : undefined,
  });
  try {
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['To B', 'B work', 'To C', 'Return to observed page']);
    expect(groups(t).filter(g => g.kind === 'page').map(g => [g.status, g.decisions.at(-1)?.decision.mode])).toEqual([['decided', 'all'], ['pending', undefined]]);
    expect(t.engine.observation(t.sessionId).url).toContain('/b');
  } finally { await t.close(); }
});

it('decides a pending page asynchronously through SDK/HTTP after returning to A, and only executes its selected sample', async () => {
  const t = await fixture({ '/a': '<a href="/b">To B</a>', '/b': '<input aria-label="Selected B"><input aria-label="Omitted B">' });
  const api = await createApi(t.engine); await api.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${(api.server.address() as { port: number }).port}`);
  try {
    await explore(t); let g = groups(t).find(g => g.kind === 'page')!;
    const count = attempts(t).length;
    await client.decideExplorationGroup(t.sessionId, g.id, g.revision, { ...reason, mode: 'defer' });
    expect(attempts(t)).toHaveLength(count); await explore(t);
    expect(t.engine.session(t.sessionId).stopReason).toBe('PAGE_EXPLORATION_DEFERRED');
    g = groups(t).find(x => x.id === g.id)!;
    await expect(client.decideExplorationGroup(t.sessionId, g.id, g.revision - 1, { ...reason, mode: 'all' })).rejects.toThrow();
    await client.decideExplorationGroup(t.sessionId, g.id, g.revision, { ...reason, mode: 'sample', memberKeys: [g.members.find(m => m.label === 'Selected B')!.key] });
    await explore(t);
    expect(attempts(t).filter(a => a.action.kind === 'fill').map(a => a.action.label)).toEqual(['Selected B']);
    expect(t.engine.getFrontier(t.sessionId).find(f => f.action.label === 'Omitted B')).toMatchObject({ status: 'deferred', coverage: { executionStatus: 'not_attempted' } });
  } finally { await api.close(); await t.close(); }
});

it('can skip a static destination with no actions and retains the page-level request', async () => {
  const t = await fixture({ '/a': '<a href="/b">To B</a>', '/b': '<h1>Static B</h1>' });
  try {
    await explore(t); const g = groups(t).find(g => g.kind === 'page')!;
    expect(g.members).toHaveLength(0); expect(t.engine.session(t.sessionId).stopReason).toBe('PAGE_DECISION_REQUIRED');
    await t.engine.decideExplorationGroup(t.sessionId, g.id, g.revision, { ...reason, mode: 'skip' }); await explore(t);
    expect(t.engine.session(t.sessionId)).toMatchObject({ status: 'finished', stopReason: 'known_frontier_exhausted_with_gaps' });
    expect(attempts(t).map(a => a.action.label)).toEqual(['To B', 'Return to observed page']);
  } finally { await t.close(); }
});

it('closes a current destination boundary before returning and never operates its unapproved content', async () => {
  const t = await fixture({ '/a': '<a href="/b">To B</a>', '/b': '<dialog open><input aria-label="B dialog work"><button onclick="this.closest(\'dialog\').close()">Close</button></dialog>' });
  try {
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['To B', 'Close', 'Return to observed page']);
    expect(t.engine.observation(t.sessionId).url).toContain('/a');
  } finally { await t.close(); }
});

it('pauses with a return blocker when navigation replaced the source history entry', async () => {
  const t = await fixture({ '/a': '<button type="button" onclick="location.replace(\'/b\')">Replace</button>', '/b': '<input aria-label="B work">' }, {}, { interfaceActions: [{ name: 'Replace' }] });
  try {
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Replace']);
    expect(t.engine.session(t.sessionId).stopReason).toBe('PAGE_RETURN_BLOCKED');
    expect(t.engine.report(t.sessionId).pageExploration?.lastReturn?.status).toBe('blocked');
    expect(t.engine.observation(t.sessionId).url).toContain('/b');
  } finally { await t.close(); }
});

it.each([false, true])('uses another observed source-page history entry only in the same declared context (changed=%s)', async changed => {
  let context = 'one';
  const t = await fixture({ '/a': `<button type="button" onclick="history.replaceState({},'', '/b');document.body.innerHTML='<h1>B</h1>'">Replace route</button><input aria-label="Remaining A">
    <script>const original=document.body.innerHTML;addEventListener('popstate',()=>{document.body.innerHTML=original})</script>` }, {
    context: () => ({ workspace: { value: context, status: 'known', source: 'fixture' } }),
  }, { interfaceActions: [{ name: 'Replace route' }] });
  try {
    const initial = t.engine.observation(t.sessionId);
    await pageOf(t.engine).evaluate(() => history.pushState({}, '', location.href));
    if (changed) context = 'two';
    const source = await t.engine.observe(t.sessionId);
    expect(source.navigation!.entries[source.navigation!.currentIndex].id).not.toBe(initial.navigation!.entries[initial.navigation!.currentIndex].id);
    await explore(t);
    if (changed) {
      expect(t.engine.session(t.sessionId).stopReason).toBe('PAGE_RETURN_BLOCKED');
      expect(attempts(t).map(a => a.action.label)).toEqual(['Replace route']);
    } else {
      expect(attempts(t).map(a => a.action.label)).toEqual(['Replace route', 'Return to observed page', 'Remaining A']);
      expect(t.engine.observation(t.sessionId).url).toBe(initial.url);
      const returned = t.engine.store.events(t.sessionId).find(e => e.type === 'exploration.page_returned');
      expect(returned?.data).toMatchObject({ navigationTargetId: initial.id, stateRestored: false });
      const returnSource = t.engine.observation(t.sessionId, (returned!.data as { targetId: string }).targetId);
      expect(returnSource.url).toBe(source.url);
      expect(returnSource.navigation!.entries[returnSource.navigation!.currentIndex].id).toBe(source.navigation!.entries[source.navigation!.currentIndex].id);
    }
  } finally { await t.close(); }
});

it('explicit all retains cross-page exploration, while explicit single actions do not start a traversal', async () => {
  const t = await fixture({ '/a': '<a href="/b">To B</a>', '/b': '<input aria-label="B work">' }, {}, { pageExploration: 'all' });
  try {
    await act(t.engine, t.sessionId, 'To B'); expect(attempts(t)).toHaveLength(1);
    await explore(t); expect(attempts(t).map(a => a.action.label)).toEqual(['To B', 'B work']);
    expect(groups(t)).toEqual([]);
  } finally { await t.close(); }
});

it('invalidates context-bound page decisions on business-context changes while ordinary scopes remain document-bound', async () => {
  let version = 'one';
  const t = await fixture({ '/a': '<a href="/b">To B</a>', '/b': '<input aria-label="B work">' }, {
    context: () => ({ goal: { value: version, status: 'known', source: 'test' } }),
    explorationDecision: g => ({ ...reason, mode: 'all' }),
  }, { decisionScopes: ['input-space'] });
  try {
    await act(t.engine, t.sessionId, 'To B'); const page = groups(t).find(g => g.kind === 'page')!;
    const input = groups(t).find(g => g.kind === 'input-space')!;
    await pageOf(t.engine).reload(); await t.engine.observe(t.sessionId);
    expect(groups(t).find(g => g.id === page.id)?.status).toBe('decided');
    expect(groups(t).find(g => g.id === input.id)?.status).toBe('invalidated');
    version = 'two'; await t.engine.observe(t.sessionId);
    expect(groups(t).find(g => g.id === page.id)?.status).toBe('invalidated');
    expect(groups(t).filter(g => g.kind === 'page')).toHaveLength(2);
  } finally { await t.close(); }
});

it.each(['/a?panel=b', '/a#b'])('gates same-document URL changes to %s and verifies native return', async destination => {
  const t = await fixture({ '/a': `<main id="view"><button type="button" onclick="history.pushState({},'', '${destination}');render()">Route</button><input aria-label="Remaining A"></main>
    <script>const original=view.innerHTML; function render(){view.innerHTML=location.search||location.hash?'<input aria-label="B work">':original} addEventListener('popstate',render)</script>` }, {}, { interfaceActions: [{ name: 'Route' }] });
  try {
    const initial = t.engine.observation(t.sessionId);
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Route', 'Return to observed page', 'Remaining A']);
    expect(t.engine.observation(t.sessionId)).toMatchObject({ url: initial.url, instanceScope: initial.instanceScope });
    expect(groups(t).find(g => g.kind === 'page')?.conditions).toEqual({ url: new URL(destination, initial.url).href });
  } finally { await t.close(); }
});

it.each(['dirty', 'excluded'])('keeps an unapproved page untouched when %s blocks the return', async restriction => {
  const t = await fixture({ '/a': '<a href="/b">To B</a>', '/b': '<input aria-label="B work"><button>Change business state</button>' }, {}, restriction === 'excluded' ? { exclude: [{ kind: 'history' }] } : {});
  try {
    await act(t.engine, t.sessionId, 'To B');
    if (restriction === 'dirty') await act(t.engine, t.sessionId, 'Change business state');
    const count = attempts(t).length; await explore(t);
    expect(t.engine.session(t.sessionId).stopReason).toBe('PAGE_RETURN_BLOCKED');
    expect(attempts(t)).toHaveLength(count);
    expect(t.engine.observation(t.sessionId).url).toContain('/b');
  } finally { await t.close(); }
});

it('preserves the previous traversal policy for persisted legacy sessions with no page option', async () => {
  const t = await fixture({ '/a': '<a href="/b">To B</a>', '/b': '<input aria-label="B work">' });
  try {
    const session = t.engine.session(t.sessionId); delete session.options.pageExploration; t.engine.store.put('session', session);
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['To B', 'B work']);
    expect(groups(t)).toEqual([]);
  } finally { await t.close(); }
});

it('uses the actual initial redirect destination as the entry page', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/a' }); res.end(); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<input aria-label="Landing work">'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const t = await testEngine(`http://127.0.0.1:${(server.address() as { port: number }).port}/start`, { exploration: 'controls', contextRules: [] });
  try {
    expect(t.engine.report(t.sessionId).pageExploration?.rootUrl).toMatch(/\/a$/);
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['Landing work']);
    expect(groups(t)).toEqual([]);
  } finally { await t.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('returns from a sampled page when its selected work exceeds the depth budget', async () => {
  const t = await fixture({ '/a': '<a href="/b">To B</a>', '/b': '<input aria-label="Selected B">' }, {
    explorationDecision: g => g.kind === 'page' ? { ...reason, mode: 'sample', memberKeys: [g.members.find(m => m.label === 'Selected B')!.key] } : undefined,
  }, { maxDepth: 1 });
  try {
    await explore(t);
    expect(attempts(t).map(a => a.action.label)).toEqual(['To B', 'Return to observed page']);
    expect(t.engine.observation(t.sessionId).url).toMatch(/\/a$/);
    expect(t.engine.getFrontier(t.sessionId).find(f => f.action.label === 'Selected B')).toMatchObject({ status: 'blocked', reason: 'depth_budget', coverage: { executionStatus: 'not_attempted' } });
  } finally { await t.close(); }
});

it('keeps page batch decisions finite and includes the pending next destination after return', async () => {
  const t = await fixture({ '/a': '<a href="/b">To B</a>', '/b': '<a href="/c">To C</a><input aria-label="B work">', '/c': '<h1>Static C</h1>' });
  try {
    await explore(t); const material = t.engine.explorationReviewMaterial(t.sessionId);
    expect(material.groups.filter(g => g.kind === 'page')).toHaveLength(1);
    const before = attempts(t).length;
    await t.engine.decideExplorationGroups(t.sessionId, material.groups.map(g => ({ groupId: g.id, revision: g.revision, decision: { ...reason, mode: 'all' } })));
    expect(attempts(t)).toHaveLength(before);
    await explore(t); const later = t.engine.explorationReviewMaterial(t.sessionId);
    const c = later.groups.find(g => (g.conditions as { url?: string })?.url?.endsWith('/c'))!;
    expect(c).toMatchObject({ status: 'pending', kind: 'page', members: [] });
    expect(t.engine.observation(t.sessionId).url).toContain('/b'); expect(t.engine.session(t.sessionId).stopReason).toBe('PAGE_DECISION_REQUIRED');
  } finally { await t.close(); }
});
