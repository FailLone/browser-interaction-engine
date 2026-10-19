import { resolve } from 'node:path';
import { checksPlugin, CrawlManager, CrawlStore, providersFromEnv } from '@interaction/crawler';
import { rulesPlugin } from '@interaction/rules';
import { createServer } from './server.js';

// Runs live in the data directory; models are used when configured. Plugins are offered by name
// and chosen per run; the crawler itself knows nothing about them.
const crawls = new CrawlManager(new CrawlStore(resolve(process.env.INTERACTION_DATA_DIR || '.data', 'crawls.sqlite')), providersFromEnv(), {
  rules: () => rulesPlugin(),
  checks: () => checksPlugin,
});
const app = await createServer(crawls, { logger: true });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT || 4173) });
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); await crawls.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
