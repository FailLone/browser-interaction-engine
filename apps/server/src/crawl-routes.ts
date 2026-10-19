import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CrawlManager } from '@interaction/crawler';
import { DebugView } from './debug-view.js';
import type { ModelCallLog } from './model-calls.js';

const sessionRequest = z
  .object({ provider: z.string().min(1).max(64), options: z.record(z.string(), z.unknown()).optional() })
  .strict();

const startSchema = z
  .object({
    url: z.url().refine(v => ['http:', 'https:'].includes(new URL(v).protocol), 'Only HTTP(S) URLs are supported'),
    durationMs: z.number().int().min(10_000).max(3_600_000).optional(),
    viewport: z
      .union([
        z.enum(['desktop', 'desktop-edge', 'mobile']),
        z
          .object({
            width: z.number().int().min(240).max(3840),
            height: z.number().int().min(240).max(2160),
            mobile: z.boolean().optional(),
          })
          .strict(),
      ])
      .optional(),
    allowedPaths: z
      .array(
        z
          .string()
          .min(2)
          .max(512)
          .refine(v => {
            try {
              new RegExp(v);
              return v.startsWith('^');
            } catch {
              return false;
            }
          }, 'Use an anchored pattern'),
      )
      .max(20)
      .optional(),
    followNavigation: z.boolean().optional(),
    models: z.boolean().optional(),
    resumeFrom: z.string().uuid().optional(),
    plugins: z.array(z.string().min(1).max(64)).max(10).optional(),
    session: z.union([sessionRequest, z.array(sessionRequest).min(1).max(5)]).optional(),
  })
  .strict();

/** Sampled crawler runs: start, list, inspect events and state screenshots, stop. */
export function registerCrawlRoutes(
  app: FastifyInstance,
  crawls: CrawlManager,
  modelCalls?: ModelCallLog,
  models: { jev: boolean; llm: boolean } = { jev: false, llm: false },
) {
  const notFound = (reply: { code(n: number): { send(b: unknown): unknown } }) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Crawl run not found' } });
  app.get('/v1/crawls', async () => crawls.store.runs());
  app.get('/v1/crawl-plugins', async () => Object.keys(crawls.pluginFactories));
  /** Which model providers this server was started with; runs asking for models get none otherwise. */
  app.get('/v1/crawl-models', async () => models);
  app.get('/v1/crawl-sessions', async () => Object.keys(crawls.sessionFactories));
  app.post('/v1/crawls', async (request, reply) => {
    try {
      const input = startSchema.parse(request.body);
      return reply.code(201).send(modelCalls ? modelCalls.track(() => crawls.start(input)) : crawls.start(input));
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      return reply.code(409).send({ error: { code: 'CRAWL_REJECTED', message: String((error as Error).message) } });
    }
  });
  app.get(
    '/v1/crawls/:runId',
    async (request, reply) => crawls.store.run((request.params as { runId: string }).runId) ?? notFound(reply),
  );
  app.get('/v1/crawls/:runId/events', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (!crawls.store.run(runId)) return notFound(reply);
    const query = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(5000).default(1000),
      })
      .parse(request.query);
    return crawls.store.events(runId, query.after, query.limit);
  });
  app.get('/v1/crawls/:runId/screenshot', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const { state } = z.object({ state: z.string().min(1) }).parse(request.query);
    const png = crawls.store.screenshot(runId, state);
    if (!png) return notFound(reply);
    return reply.type('image/png').header('Cache-Control', 'no-store').send(png);
  });
  app.post('/v1/crawls/:runId/stop', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (!crawls.store.run(runId)) return notFound(reply);
    return { stopped: await crawls.stop(runId), run: crawls.store.run(runId) };
  });

  registerDebugRoutes(app, crawls, modelCalls);
}

const page = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

/**
 * What the debug page reads: slim events, then on demand one full event, a screenshot, and
 * model calls (list first, request and answer only when opened).
 */
function registerDebugRoutes(app: FastifyInstance, crawls: CrawlManager, modelCalls?: ModelCallLog) {
  const view = new DebugView(crawls.store);
  const run = (request: { params: unknown }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    const { runId } = request.params as { runId: string };
    if (crawls.store.run(runId)) return runId;
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Crawl run not found' } });
  };
  app.get('/v1/crawls/:runId/debug/events', async (request, reply) => {
    const runId = run(request, reply);
    if (!runId) return reply;
    const query = page.parse(request.query);
    return view.events(runId, query.after, query.limit);
  });
  app.get('/v1/crawls/:runId/debug/events/:seq', async (request, reply) => {
    const runId = run(request, reply);
    if (!runId) return reply;
    const seq = z.coerce
      .number()
      .int()
      .min(1)
      .parse((request.params as { seq: string }).seq);
    const [event] = crawls.store.events(runId, seq - 1, 1);
    if (event?.seq !== seq) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Event not found' } });
    return event;
  });
  app.get('/v1/crawls/:runId/debug/screenshot/:state', async (request, reply) => {
    const runId = run(request, reply);
    if (!runId) return reply;
    const key = view.stateKey(runId, (request.params as { state: string }).state);
    const png = key && crawls.store.screenshot(runId, key);
    if (!png) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Screenshot not found' } });
    return reply.type('image/png').header('Cache-Control', 'private, max-age=86400').send(png);
  });
  app.get('/v1/crawls/:runId/debug/model-calls', async (request, reply) => {
    const runId = run(request, reply);
    if (!runId) return reply;
    return { recorded: !!modelCalls, calls: modelCalls?.calls(runId) ?? [] };
  });
  app.get('/v1/crawls/:runId/debug/model-calls/:callId', async (request, reply) => {
    const runId = run(request, reply);
    if (!runId) return reply;
    const id = z.coerce
      .number()
      .int()
      .min(1)
      .parse((request.params as { callId: string }).callId);
    return (
      modelCalls?.call(runId, id) ??
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Model call not found' } })
    );
  });
}
