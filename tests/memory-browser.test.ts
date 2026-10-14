import { it, expect } from 'vitest';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { createServer } from '../apps/server/src/server.js';
import { fixtureServer } from './helpers.js';
import type { InteractionScope } from '@interaction/core';

it('preserves legacy browser scope data when composing the new SDK', async () => {
  const store = new MemoryStore();
  store.put('scope', { id: 'legacy-scope', sessionId: 'legacy', status: 'closed', overlayKeys: ['menu:order-menu'], attemptIds: ['original-attempt'] } as unknown as InteractionScope);
  const engine = new BrowserEngine({ persistence: store });
  try {
    const scope = store.require<InteractionScope>('scope', 'legacy-scope');
    expect(scope.anchors).toEqual(['menu:order-menu']); expect(scope.attemptIds).toEqual(['original-attempt']);
  } finally { await engine.close(); }
});

it('uses browser execution and HTTP evidence queries with the memory plugin', async () => {
  const fixture = await fixtureServer(); const store = new MemoryStore();
  const engine = new BrowserEngine({ persistence: store }); const app = await createServer(engine);
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/sessions', payload: { url: fixture.url, headless: true } });
    expect(response.statusCode).toBe(201); const session = response.json();
    const actions = engine.actions(session.id); const action = actions.find(a => a.label === 'Order type')!;
    const result = await engine.execute(session.id, action.id, 'memory-execute'); expect(result.status).toBe('succeeded');
    const observation = engine.observation(session.id); const evidence = await store.evidence.get(observation.screenshot!);
    expect(evidence?.data.length).toBeGreaterThan(1000);
    const image = await app.inject(`/v1/sessions/${session.id}/evidence/${observation.id}`);
    expect(image.statusCode).toBe(200); expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload).toEqual(Buffer.from(evidence!.data));
  } finally { await app.close(); await engine.close(); await fixture.server.close(); }
});
