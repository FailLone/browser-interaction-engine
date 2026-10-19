import { ExplorerPlugin, ExplorerStore, providersFromEnv } from '@interaction/explorer-plugin';
import { SqliteStore } from '@interaction/storage-sqlite';
import { resolve } from 'node:path';
import { InteractionEngine } from '@interaction/browser';
import { createServer } from './server.js';
import { CrawlManager, CrawlStore } from '@interaction/crawler';
const engine = new InteractionEngine({ persistence: new SqliteStore(resolve(process.env.INTERACTION_DATA_DIR || '.data')) });
const explorer = process.env.EXPLORER_ENABLED === 'true' ? new ExplorerPlugin(engine, new ExplorerStore(resolve(process.env.EXPLORER_DATABASE || '.data/plugins/explorer.sqlite')), providersFromEnv()) : undefined;
// Sampled crawler runs live next to the engine data; models are used when configured.
const crawls = new CrawlManager(new CrawlStore(resolve(process.env.INTERACTION_DATA_DIR || '.data', 'crawls.sqlite')), providersFromEnv());
const app = await createServer(engine, { logger: true, explorer, crawls });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT || 4173) });
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); await crawls.close(); await engine.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
