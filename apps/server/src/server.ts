import { inspectionCapabilities, validateCaptureProfile, inspectionConsumerSchema, completeInspectionSchema, inspectionPageSchema } from '@interaction/browser';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { InteractionEngine, EngineError, artifactKindSchema, domQuerySchema, evidenceCapabilities, type EngineEvent } from '@interaction/browser';

export async function createServer(engine: InteractionEngine, options: { uiDirectory?: string; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  const streams = new Set<import('node:http').ServerResponse>();
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Request validation failed', details: error.issues } });
    if (error instanceof EngineError) return reply.code(error.code === 'NOT_FOUND' ? 404 : ['INVALID_QUERY', 'INVALID_REQUEST'].includes(error.code) ? 400 : 409).send({ error: { code: error.code, message: error.message, details: error.details } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } });
  });
  app.get('/v1/health', async () => ({ status: 'ok', version: '0.1.0', modelIndependent: true }));
  app.get('/v1/capabilities/evidence', async () => evidenceCapabilities);
  app.get('/v1/capabilities/inspection', async () => inspectionCapabilities);
  app.post('/v1/capabilities/inspection/validate', async request => validateCaptureProfile(request.body));
  app.get('/v1/sessions', async () => engine.sessions().map(s => ({ ...s, options: { ...s.options, storageState: s.options.storageState ? '[configured]' : undefined } })));
  app.post('/v1/sessions', async (request, reply) => { const s = await engine.createSession(request.body); return reply.code(201).send({ ...s, options: { ...s.options, storageState: s.options.storageState ? '[configured]' : undefined } }); });
  const sid = (request: any) => request.params.sessionId as string;
  app.get('/v1/sessions/:sessionId', async request => { const s = engine.session(sid(request)); return { ...s, options: { ...s.options, storageState: s.options.storageState ? '[configured]' : undefined } }; });
  app.post('/v1/sessions/:sessionId/commands', async request => {
    const result = await engine.command(sid(request), request.body);
    if (result && 'options' in result) return { ...result, options: { ...result.options, storageState: result.options.storageState ? '[configured]' : undefined } };
    return result;
  });
  const iid = (request: any) => request.params.inspectionId as string;
  const cid = (request: any) => request.params.captureId as string;
  app.get('/v1/sessions/:sessionId/inspections', async request => engine.listInspections(sid(request), inspectionPageSchema.parse(request.query)));
  app.get('/v1/sessions/:sessionId/inspections/:inspectionId', async request => engine.inspection(sid(request), iid(request)));
  for (const action of ['receive', 'renew', 'cancel'] as const) app.post(`/v1/sessions/:sessionId/inspections/:inspectionId/${action}`, async request => {
    const { consumerId } = inspectionConsumerSchema.parse(request.body);
    return engine[`${action}Inspection`](sid(request), iid(request), consumerId);
  });
  app.post('/v1/sessions/:sessionId/inspections/:inspectionId/complete', async request => {
    const { consumerId, results } = completeInspectionSchema.parse(request.body); return engine.completeInspection(sid(request), iid(request), consumerId, results);
  });
  app.get('/v1/sessions/:sessionId/captures/:captureId', async request => engine.captureDetails(sid(request), cid(request)));
  app.get('/v1/sessions/:sessionId/captures/:captureId/nodes', async request => engine.captureNodes(sid(request), cid(request), domQuerySchema.parse(request.query)));
  app.get('/v1/sessions/:sessionId/captures/:captureId/nodes/:nodeId/context', async request => engine.nodeContext(sid(request), cid(request), (request.params as any).nodeId));
  app.get('/v1/sessions/:sessionId/captures/:captureId/region', async request => engine.regionContext(sid(request), cid(request), z.object({ key: z.string().min(1) }).parse(request.query).key));
  app.get('/v1/sessions/:sessionId/captures/:captureId/artifacts/:kind', async (request, reply) => {
    const evidence = await engine.captureArtifact(sid(request), cid(request), artifactKindSchema.parse((request.params as any).kind));
    return reply.type(evidence.mediaType).header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox").header('Cache-Control', 'no-store').send(Buffer.from(evidence.data));
  });
  app.get('/v1/sessions/:sessionId/observation', async request => engine.observation(sid(request), (request.query as any).id));
  const oid = (request: any) => request.params.observationId as string;
  app.get('/v1/sessions/:sessionId/observations/:observationId/details', async request => engine.observationDetails(sid(request), oid(request)));
  app.get('/v1/sessions/:sessionId/observations/:observationId/dom', async request => engine.dom(sid(request), oid(request), domQuerySchema.parse(request.query)));
  app.get('/v1/sessions/:sessionId/observations/:observationId/controls/:controlId', async request => engine.controlDetails(sid(request), oid(request), (request.params as any).controlId));
  app.get('/v1/sessions/:sessionId/observations/:observationId/region', async request => {
    const key = (request.query as any).key;
    if (typeof key !== 'string' || !key) throw new EngineError('INVALID_QUERY', 'A region key is required');
    return engine.regionDetails(sid(request), oid(request), key);
  });
  app.get('/v1/sessions/:sessionId/observations/:observationId/artifacts/:kind', async (request, reply) => {
    const kind = artifactKindSchema.parse((request.params as any).kind);
    const evidence = await engine.evidenceArtifact(sid(request), oid(request), kind);
    return reply.type(evidence.mediaType).header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'no-store').send(Buffer.from(evidence.data));
  });
  app.get('/v1/sessions/:sessionId/events/:sequence/context', async request => engine.eventContext(sid(request), Number((request.params as any).sequence)));
  app.get('/v1/sessions/:sessionId/evidence-retention', async request => engine.evidenceStats(sid(request)));
  app.post('/v1/sessions/:sessionId/observations/:observationId/evidence-retention', async request => {
    const body = z.discriminatedUnion('action', [z.object({ action: z.literal('pin'), owner: z.string().min(1).max(200) }).strict(), z.object({ action: z.literal('release') }).strict()]).parse(request.body);
    return body.action === 'pin' ? engine.pinEvidence(sid(request), oid(request), body.owner) : engine.releaseEvidence(sid(request), oid(request));
  });
  app.post('/v1/sessions/:sessionId/evidence-retention/unpin', async request => { const body = z.object({ owner: z.string().min(1).max(200) }).strict().parse(request.body); return engine.unpinEvidence(sid(request), body.owner); });
  app.post('/v1/sessions/:sessionId/checkpoints/:checkpointId/release-evidence', async request => engine.releaseCheckpointEvidence(sid(request), (request.params as any).checkpointId));
  app.get('/v1/sessions/:sessionId/actions', async request => engine.actions(sid(request), (request.query as any).observationId));
  app.get('/v1/sessions/:sessionId/exploration-groups/:groupId/purpose-material', async request => engine.purposeReviewMaterial(sid(request), (request.params as any).groupId));
  app.get('/v1/sessions/:sessionId/graph', async request => engine.getGraph(sid(request)));
  app.get('/v1/sessions/:sessionId/frontier-coverage', async request => engine.frontierCoverage(sid(request)));
  app.get('/v1/sessions/:sessionId/report', async request => { const r = engine.report(sid(request)); return { ...r, session: { ...r.session, options: { ...r.session.options, storageState: undefined } } }; });
  app.get('/v1/sessions/:sessionId/compare', async request => {
    const q = request.query as Record<string, string>;
    if (!q.before || !q.after) throw new EngineError('INVALID_REQUEST', 'before and after observation IDs are required');
    return engine.compare(sid(request), q.before, q.after, q.region);
  });
  const comparisonQuery = z.object({ before: z.string().min(1), after: z.string().min(1), region: z.string().min(1).optional() }).strict();
  app.get('/v1/sessions/:sessionId/compare/details', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const q = comparisonQuery.parse(request.query); return engine.diffDetails(sid(request), q.before, q.after, q.region);
  });
  app.get('/v1/sessions/:sessionId/attempts/:attemptId/diff/details', async (request, reply) => { reply.header('Cache-Control', 'no-store'); return engine.attemptDiffDetails(sid(request), (request.params as any).attemptId); });
  app.get('/v1/sessions/:sessionId/scopes/:scopeId/diff/details', async (request, reply) => { reply.header('Cache-Control', 'no-store'); return engine.scopeDiffDetails(sid(request), (request.params as any).scopeId); });
  app.get('/v1/sessions/:sessionId/events/:sequence/diff/details', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const sequence = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse((request.params as any).sequence);
    return engine.eventDiffDetails(sid(request), sequence);
  });
  app.get('/v1/sessions/:sessionId/path', async request => { const q = request.query as Record<string, string>; if (!q.from || !q.to) throw new EngineError('INVALID_REQUEST', 'from and to state IDs are required'); return { path: engine.navigationPath(sid(request), q.from, q.to) }; });
  const collections: Record<string, string> = { observations: 'observation', states: 'state', visits: 'visit', attempts: 'attempt', frontier: 'frontier', identities: 'identity', hypotheses: 'hypothesis', scopes: 'scope', checkpoints: 'checkpoint', issues: 'issue', recoveries: 'reach', 'exploration-groups': 'exploration-group', 'purpose-reviews': 'purpose-review' };
  for (const [resource, kind] of Object.entries(collections)) app.get(`/v1/sessions/:sessionId/${resource}`, async request => {
    const query = request.query as Record<string, string>; let items = engine.list<any>(sid(request), kind);
    if (query.status) items = items.filter(i => i.status === query.status);
    const offset = Math.max(0, Number(query.offset) || 0); const limit = Math.min(1000, Math.max(1, Number(query.limit) || 200));
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
  });
  app.get('/v1/sessions/:sessionId/evidence/:observationId', async (request, reply) => {
    const o = engine.observation(sid(request), (request.params as any).observationId);
    if (!o.screenshot) throw new EngineError('NOT_FOUND', 'Screenshot is unavailable');
    const evidence = await engine.evidenceArtifact(sid(request), o.id, 'screenshot');
    if (!evidence) throw new EngineError('NOT_FOUND', 'Evidence is unavailable');
    return reply.type(evidence.mediaType).header('Cache-Control', 'no-store').send(Buffer.from(evidence.data));
  });
  app.get('/v1/sessions/:sessionId/events', async (request, reply) => {
    const sessionId = sid(request); engine.session(sessionId); const q = request.query as Record<string, string>;
    const cursor = z.coerce.number().int().min(0).parse(request.headers['last-event-id'] || q.after || 0);
    const delivery = z.enum(['reference', 'inline', 'hybrid']).parse(q.delivery || 'reference');
    const maxSnapshotBytes = z.coerce.number().int().min(1024).max(64 * 1024 ** 2).parse(q.maxSnapshotBytes || 8 * 1024 ** 2);
    if (q.format === 'json') return engine.store.events(sessionId, cursor);
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    streams.add(reply.raw);
    const subscription = engine.subscribeEvents(sessionId, async event => {
      if (reply.raw.destroyed) throw new Error('Event connection closed');
      const ready = reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
      if (!ready) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { reply.raw.off('drain', drain); reply.raw.off('close', closed); };
        const drain = () => { cleanup(); resolve(); }; const closed = () => { cleanup(); reject(new Error('Event connection closed')); };
        reply.raw.once('drain', drain); reply.raw.once('close', closed);
      });
    }, { after: cursor, delivery, maxSnapshotBytes, onGap: gap => {
      if (!reply.raw.destroyed) { reply.raw.write(`event: gap\ndata: ${JSON.stringify(gap)}\n\n`); reply.raw.end(); }
    } });
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed && !reply.raw.writableNeedDrain) reply.raw.write(': keepalive\n\n'); }, 15000);
    reply.raw.on('close', () => { subscription.close(); clearInterval(heartbeat); streams.delete(reply.raw); });
  });
  const ui = options.uiDirectory || resolve('apps/ui/dist');
  if (existsSync(ui)) { await app.register(fastifyStatic, { root: ui }); app.setNotFoundHandler((request, reply) => request.url.startsWith('/v1/') ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown API route' } }) : reply.sendFile('index.html')); }
  return app;
}
