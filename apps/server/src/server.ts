import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CrawlManager } from '@interaction/crawler';
import { registerCrawlRoutes } from './crawl-routes.js';

/** HTTP API for crawl runs, plus the built UI when present. */
export async function createServer(crawls: CrawlManager, options: { uiDirectory?: string; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Request validation failed', details: error.issues } });
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } });
  });
  app.get('/v1/health', async () => ({ status: 'ok', version: '0.1.0' }));
  registerCrawlRoutes(app, crawls);
  const ui = options.uiDirectory || resolve('apps/ui/dist');
  if (existsSync(ui)) {
    await app.register(fastifyStatic, { root: ui });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/v1/')
        ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown API route' } })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
