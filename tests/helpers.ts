import { SqliteStore } from '@interaction/storage-sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { InteractionEngine, type EngineHooks, type SessionOptions, type ActionCandidate } from '@interaction/browser';
export async function fixtureServer() {
  const server = await createServer({ root: resolve('apps/test-site'), server: { port: 0, strictPort: false }, logLevel: 'error' }); await server.listen();
  const address = server.httpServer!.address() as { port: number }; return { server, url: `http://127.0.0.1:${address.port}` };
}
export async function testEngine(url: string, options: Partial<SessionOptions> = {}, hooks: EngineHooks = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'interaction-engine-')); const engine = new InteractionEngine({ persistence: new SqliteStore(directory), hooks });
  const session = await engine.createSession({ url, headless: true, settleMs: 60, observeTimeoutMs: 600, actionTimeoutMs: 2000, contextRules: [{ key: 'pair', selector: '#pair' }], ...options });
  return { engine, sessionId: session.id, directory, close: async () => { await engine.close(); rmSync(directory, { recursive: true, force: true }); } };
}
export async function act(engine: InteractionEngine, sessionId: string, name: string, kind: ActionCandidate['kind'] = 'click', value?: ActionCandidate['value']) {
  const actions = engine.actions(sessionId).filter(a => a.label === name && a.kind === kind && (value === undefined || kind === 'fill' || a.value === value));
  if (actions.length !== 1) throw new Error(`Expected unique ${kind} ${name}, found ${actions.length}. Actions: ${engine.actions(sessionId).map(a => `${a.kind}:${a.label}:${a.value}`).join(', ')}`);
  return engine.execute(sessionId, actions[0].id, crypto.randomUUID(), value);
}
export const pageOf = (engine: InteractionEngine) => (engine as any).driver.page as import('playwright').Page;
