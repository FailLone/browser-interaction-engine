import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { InteractionEngine, EngineError, type EngineEvent } from '@interaction/browser';

export async function createServer(engine: InteractionEngine, options: { uiDirectory?: string; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  const streams = new Set<import('node:http').ServerResponse>();
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Request validation failed', details: error.issues } });
    if (error instanceof EngineError) return reply.code(error.code === 'NOT_FOUND' ? 404 : 409).send({ error: { code: error.code, message: error.message, details: error.details } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } });
  });
  app.get('/v1/health', async () => ({ status: 'ok', version: '0.1.0', modelIndependent: true }));
  app.get('/v1/sessions', async () => engine.sessions().map(s => ({ ...s, options: { ...s.options, storageState: s.options.storageState ? '[configured]' : undefined } })));
  app.post('/v1/sessions', async (request, reply) => { const s = await engine.createSession(request.body); return reply.code(201).send({ ...s, options: { ...s.options, storageState: s.options.storageState ? '[configured]' : undefined } }); });
  const sid = (request: any) => request.params.sessionId as string;
  app.get('/v1/sessions/:sessionId', async request => { const s = engine.session(sid(request)); return { ...s, options: { ...s.options, storageState: s.options.storageState ? '[configured]' : undefined } }; });
  app.post('/v1/sessions/:sessionId/commands', async request => {
    const result = await engine.command(sid(request), request.body);
    if (result && 'options' in result) return { ...result, options: { ...result.options, storageState: result.options.storageState ? '[configured]' : undefined } };
    return result;
  });
  app.get('/v1/sessions/:sessionId/observation', async request => engine.observation(sid(request), (request.query as any).id));
  app.get('/v1/sessions/:sessionId/actions', async request => engine.actions(sid(request), (request.query as any).observationId));
  app.get('/v1/sessions/:sessionId/graph', async request => engine.getGraph(sid(request)));
  app.get('/v1/sessions/:sessionId/report', async request => { const r = engine.report(sid(request)); return { ...r, session: { ...r.session, options: { ...r.session.options, storageState: undefined } } }; });
  app.get('/v1/sessions/:sessionId/compare', async request => {
    const q = request.query as Record<string, string>;
    if (!q.before || !q.after) throw new EngineError('INVALID_REQUEST', 'before and after observation IDs are required');
    return engine.compare(sid(request), q.before, q.after, q.region);
  });
  app.get('/v1/sessions/:sessionId/path', async request => { const q = request.query as Record<string, string>; if (!q.from || !q.to) throw new EngineError('INVALID_REQUEST', 'from and to state IDs are required'); return { path: engine.navigationPath(sid(request), q.from, q.to) }; });
  const collections: Record<string, string> = { observations: 'observation', states: 'state', visits: 'visit', attempts: 'attempt', frontier: 'frontier', identities: 'identity', hypotheses: 'hypothesis', scopes: 'scope', checkpoints: 'checkpoint', issues: 'issue', recoveries: 'reach' };
  for (const [resource, kind] of Object.entries(collections)) app.get(`/v1/sessions/:sessionId/${resource}`, async request => {
    const query = request.query as Record<string, string>; let items = engine.list<any>(sid(request), kind);
    if (query.status) items = items.filter(i => i.status === query.status);
    const offset = Math.max(0, Number(query.offset) || 0); const limit = Math.min(1000, Math.max(1, Number(query.limit) || 200));
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
  });
  app.get('/v1/sessions/:sessionId/evidence/:observationId', async (request, reply) => {
    const o = engine.observation(sid(request), (request.params as any).observationId);
    if (!o.screenshot) throw new EngineError('NOT_FOUND', 'Screenshot is unavailable');
    const evidence = await engine.store.evidence.get(o.screenshot);
    if (!evidence) throw new EngineError('NOT_FOUND', 'Evidence is unavailable');
    return reply.type(evidence.mediaType).header('Cache-Control', 'private, max-age=31536000, immutable').send(Buffer.from(evidence.data));
  });
  app.get('/v1/sessions/:sessionId/events', async (request, reply) => {
    const sessionId = sid(request); engine.session(sessionId); const q = request.query as Record<string, string>;
    let cursor = Math.max(0, Number(request.headers['last-event-id'] || q.after) || 0);
    if (q.format === 'json') return engine.store.events(sessionId, cursor);
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    streams.add(reply.raw);
    const send = (event: EngineEvent) => { if (event.sessionId === sessionId && event.sequence > cursor) { cursor = event.sequence; reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`); } };
    // No await between backfill and subscribe: a committed event cannot fall into a gap.
    let batch: EngineEvent[];
    do { batch = engine.store.events(sessionId, cursor); batch.forEach(send); } while (batch.length === 1000);
    const onEvent = (event: EngineEvent) => send(event); engine.events.on('event', onEvent);
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
    reply.raw.on('close', () => { clearInterval(heartbeat); engine.events.off('event', onEvent); streams.delete(reply.raw); });
  });
  const ui = options.uiDirectory || resolve('apps/ui/dist');
  if (existsSync(ui)) { await app.register(fastifyStatic, { root: ui }); app.setNotFoundHandler((request, reply) => request.url.startsWith('/v1/') ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown API route' } }) : reply.sendFile('index.html')); }
  return app;
}
