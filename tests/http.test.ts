import { it, expect } from 'vitest';
import { fixtureServer, testEngine } from './helpers.js';
import { createServer } from '../apps/server/src/server.js';
import { InteractionClient } from '@interaction/client';
it('serves the same session over HTTP, streams durable cursors and rejects invalid commands', async () => {
  const fixture = await fixtureServer(); const t = await testEngine(fixture.url); const app = await createServer(t.engine); await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as any).port; const client = new InteractionClient(`http://127.0.0.1:${port}`);
  try {
    expect((await client.observation(t.sessionId)).id).toBe(t.engine.observation(t.sessionId).id);
    const invalid = await app.inject({ method: 'POST', url: `/v1/sessions/${t.sessionId}/commands`, payload: { type: 'execute' } }); expect(invalid.statusCode).toBe(400);
    const observation = await client.observe(t.sessionId); const image = await app.inject(`/v1/sessions/${t.sessionId}/evidence/${observation.id}`); expect(image.headers['content-type']).toBe('image/png');
    const controller = new AbortController(); const stream = client.events(t.sessionId, 0, controller.signal); const first = await stream.next(); expect(first.value?.sequence).toBeGreaterThan(0); await stream.return(undefined); controller.abort();
    const cursor = first.value!.sequence; const events = await client.request<any[]>(`/sessions/${t.sessionId}/events?format=json&after=${cursor}`); expect(events.every(e => e.sequence > cursor)).toBe(true);
    const actions = await client.actions(t.sessionId); const action = actions.find(a => a.label === 'Order type')!;
    expect(action.basis).toMatchObject({ status: 'supported', evidence: [{ source: 'html', rule: 'native-button/v1' }] });
    const result = await client.execute(t.sessionId, action.id, 'shared'); expect(result.status).toBe('succeeded'); expect(t.engine.session(t.sessionId).actionCount).toBe(1);
    const live = await fetch(`${client.baseUrl}/v1/sessions/${t.sessionId}/events`);
    await app.close(); expect(app.server.listening).toBe(false); await live.body?.cancel();
  } finally { await app.close(); await t.close(); await fixture.server.close(); }
});
