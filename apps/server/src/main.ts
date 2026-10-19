import { resolve } from 'node:path';
import { CrawlManager, CrawlStore, experimentSessionFactory, providersFromEnv } from '@interaction/crawler';
import { rulesPlugin } from '@interaction/rules';
import { ModelCallLog } from './model-calls.js';
import { createServer } from './server.js';

// Runs live in the data directory; models are used when configured. Plugins are offered by name
// and chosen per run; the crawler itself knows nothing about them.
const data = process.env.INTERACTION_DATA_DIR || '.data';
// Model calls are logged next to the crawl store, for the debug page; the crawl store is unchanged.
const modelCalls = new ModelCallLog(resolve(data, 'model-calls.sqlite'), {
  retentionDays: Number(process.env.MODEL_CALLS_RETENTION_DAYS ?? 30),
});
const providers = providersFromEnv();
const crawls = new CrawlManager(
  new CrawlStore(resolve(data, 'crawls.sqlite')),
  modelCalls.wrap(providers),
  {
    rules: () => rulesPlugin(),
  },
  // Experiment variants need no secrets, so they are offered by default; a login provider
  // (`authSessionFactory` from @interaction/auth, with the host's own adapter) is added by hosts that have accounts.
  { experiment: experimentSessionFactory },
);
const app = await createServer(crawls, {
  logger: true,
  modelCalls,
  models: { jev: !!providers.jev, llm: !!providers.llm },
});
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT || 4173) });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await crawls.close();
  modelCalls.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
