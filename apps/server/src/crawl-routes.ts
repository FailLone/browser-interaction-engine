import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CrawlManager } from '@interaction/crawler';

const startSchema = z.object({
  url: z.url().refine(v => ['http:', 'https:'].includes(new URL(v).protocol), 'Only HTTP(S) URLs are supported'),
  durationMs: z.number().int().min(10_000).max(3_600_000).optional(),
  allowedPaths: z.array(z.string().min(2).max(512).refine(v => { try { new RegExp(v); return v.startsWith('^'); } catch { return false; } }, 'Use an anchored pattern')).max(20).optional(),
  followNavigation: z.boolean().optional(),
  models: z.boolean().optional(),
  resumeFrom: z.string().uuid().optional(),
  plugins: z.array(z.string().min(1).max(64)).max(10).optional(),
}).strict();

/** Sampled crawler runs: start, list, inspect events and state screenshots, stop. */
export function registerCrawlRoutes(app: FastifyInstance, crawls: CrawlManager) {
  const notFound = (reply: { code(n: number): { send(b: unknown): unknown } }) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Crawl run not found' } });
  app.get('/v1/crawls', async () => crawls.store.runs());
  app.get('/v1/crawl-plugins', async () => Object.keys(crawls.pluginFactories));
  app.post('/v1/crawls', async (request, reply) => {
    try { return reply.code(201).send(crawls.start(startSchema.parse(request.body))); }
    catch (error) { if (error instanceof z.ZodError) throw error; return reply.code(409).send({ error: { code: 'CRAWL_REJECTED', message: String((error as Error).message) } }); }
  });
  app.get('/v1/crawls/:runId', async (request, reply) => crawls.store.run((request.params as { runId: string }).runId) ?? notFound(reply));
  app.get('/v1/crawls/:runId/events', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (!crawls.store.run(runId)) return notFound(reply);
    const query = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(request.query);
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
}
