import { it, expect } from 'vitest';
import { InteractionClient } from '@interaction/client';
import { BrowserEngine, type BrowserDiffDetails } from '@interaction/browser';
import { SqliteStore } from '@interaction/storage-sqlite';
import { act, fixtureServer, testEngine } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';

const facts = (value: unknown) => JSON.parse(JSON.stringify(value, (key, value) => key === 'checkedAt' ? undefined : value));

it('serves the same historical details to HTTP, SDK, hooks and events, including after restart', async () => {
  const fixture = await fixtureServer(); let hookDetails: BrowserDiffDetails | undefined;
  const t = await testEngine(fixture.url, {}, { check: async attempt => { hookDetails = await t.engine.attemptDiffDetails(t.sessionId, attempt.id); return []; } });
  const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new InteractionClient(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`);
  try {
    const scope = await t.engine.openScope(t.sessionId, 'menu journey', 'document');
    const attempt = await act(t.engine, t.sessionId, 'Order type');
    const snapshot = await client.attemptDiffDetails(t.sessionId, attempt.id);
    expect(facts(hookDetails)).toEqual(facts(snapshot));
    expect(snapshot.diff).toEqual(attempt.diff);
    expect(snapshot.controls[attempt.action.controlId!].after[0].control.expanded).toBe(true);
    expect(snapshot.controls[attempt.action.controlId!].before[0].actions.some(a => a.id === attempt.action.id)).toBe(true);
    await act(t.engine, t.sessionId, 'Market');
    await t.engine.closeScope(t.sessionId, scope.id);
    const flow = await client.scopeDiffDetails(t.sessionId, scope.id);
    expect(flow.source).toEqual({ kind: 'scope', id: scope.id });
    expect(flow.diff.region).toBe('document');
    expect(flow.related.scopes.some(s => s.id === scope.id)).toBe(true);
    expect(flow.related.path.verifiedAncestry).toBe(true);
    expect(flow.related.path.attemptIds).toHaveLength(2);
    expect(flow.related.attempts.map(a => a.action.label)).toEqual(['Order type', 'Market']);
    const events = t.engine.store.events(t.sessionId);
    const event = events.find(e => e.type === 'observation.diff')!;
    expect((await client.eventDiffDetails(t.sessionId, event.sequence)).diff).toEqual(attempt.diff);
    expect((await client.diffDetails(t.sessionId, attempt.beforeId, attempt.afterId!)).diff).toEqual(attempt.diff);
    expect(facts(await client.attemptDiffDetails(t.sessionId, attempt.id))).toEqual(facts(snapshot));
    expect(t.engine.store.events(t.sessionId)).toEqual(events);
    const s = t.engine.session(t.sessionId); const count = s.actionCount;
    await t.engine.stop(t.sessionId);
    // A new engine can read this completed historical evidence without opening a browser.
    const reader = new BrowserEngine({ persistence: new SqliteStore(t.directory) });
    try {
      expect(facts(await reader.attemptDiffDetails(t.sessionId, attempt.id))).toEqual(facts(snapshot));
      expect(reader.session(t.sessionId).actionCount).toBe(count);
    } finally { await reader.close(); }
  } finally { await app.close(); await t.close(); await fixture.server.close(); }
});

it('validates query arguments and rejects unavailable or cross-session diffs', async () => {
  const fixture = await fixtureServer(); const t = await testEngine(fixture.url); const app = await createServer(t.engine);
  try {
    const base = `/v1/sessions/${t.sessionId}`;
    expect((await app.inject(`${base}/compare/details?before=one`)).statusCode).toBe(400);
    expect((await app.inject(`${base}/compare/details?before=&after=two`)).statusCode).toBe(400);
    expect((await app.inject(`${base}/compare/details?before=one&before=two&after=three`)).statusCode).toBe(400);
    expect((await app.inject(`${base}/events/NaN/diff/details`)).statusCode).toBe(400);
    const attempt = await act(t.engine, t.sessionId, 'Order type');
    const foreignObservation = { ...t.engine.observation(t.sessionId), id: 'foreign-observation', sessionId: 'foreign' };
    t.engine.store.put('observation', foreignObservation);
    expect((await app.inject(`${base}/compare/details?before=${attempt.beforeId}&after=${foreignObservation.id}`)).statusCode).toBe(404);
    t.engine.store.put('attempt', { ...attempt, id: 'foreign-attempt', sessionId: 'foreign' });
    expect((await app.inject(`${base}/attempts/foreign-attempt/diff/details`)).statusCode).toBe(404);
    const foreignEvent = t.engine.store.event('foreign', 'observation.diff', attempt.diff);
    expect((await app.inject(`${base}/events/${foreignEvent.sequence}/diff/details`)).statusCode).toBe(404);
    t.engine.store.put('attempt', { ...attempt, id: 'unfinished', status: 'unknown', diff: undefined, afterId: undefined });
    const unavailable = await app.inject(`${base}/attempts/unfinished/diff/details`);
    expect(unavailable.statusCode).toBe(409); expect(unavailable.json().error.code).toBe('DIFF_UNAVAILABLE');
    const scope = await t.engine.openScope(t.sessionId, 'open', 'document');
    expect((await app.inject(`${base}/scopes/${scope.id}/diff/details`)).statusCode).toBe(409);
  } finally { await app.close(); await t.close(); await fixture.server.close(); }
});
