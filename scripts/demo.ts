import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { CrawlManager, CrawlStore, providersFromEnv } from '@interaction/crawler';
import { rulesPlugin } from '@interaction/rules';
import { createServer } from '../apps/server/src/server.js';

const crawls = new CrawlManager(
  new CrawlStore(resolve(process.env.INTERACTION_DATA_DIR || '.data', 'crawls.sqlite')),
  providersFromEnv(),
  {
    rules: () => rulesPlugin(),
  },
);
const api = await createServer(crawls);
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
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
