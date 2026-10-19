import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { CrawlManager, CrawlStore, providersFromEnv } from '@interaction/crawler';
import { rulesPlugin } from '@interaction/rules';
import { ModelCallLog } from '../apps/server/src/model-calls.js';
import { createServer } from '../apps/server/src/server.js';

const data = process.env.INTERACTION_DATA_DIR || '.data';
// Model calls are logged next to the crawl store, for the debug page; the crawl store is unchanged.
const modelCalls = new ModelCallLog(resolve(data, 'model-calls.sqlite'), {
  retentionDays: Number(process.env.MODEL_CALLS_RETENTION_DAYS ?? 30),
});
const providers = providersFromEnv();
const crawls = new CrawlManager(new CrawlStore(resolve(data, 'crawls.sqlite')), modelCalls.wrap(providers), {
  rules: () => rulesPlugin(),
});
const api = await createServer(crawls, { modelCalls, models: { jev: !!providers.jev, llm: !!providers.llm } });
await api.listen({ host: '127.0.0.1', port: 4173 });
const fixture = await createViteServer({ root: resolve('apps/test-site') });
await fixture.listen();
const ui = await createViteServer({ root: resolve('apps/ui') });
await ui.listen();
console.log(
  '\nCrawler UI: http://127.0.0.1:5173\nTest site: http://127.0.0.1:4174\nAPI: http://127.0.0.1:4173/v1/health\n',
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await Promise.all([ui.close(), fixture.close(), api.close()]);
  await crawls.close();
  modelCalls.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
