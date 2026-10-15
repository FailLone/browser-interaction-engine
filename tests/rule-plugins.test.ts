import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { SqliteStore } from '@interaction/storage-sqlite';
import { builtinRulePlugins, type RulePlugin, type RulePluginRun } from '@interaction/rules';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../apps/server/src/server.js';
import { fixtureServer, pageOf } from './helpers.js';

let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { fixture = await fixtureServer(); });
afterAll(async () => { await fixture.server.close(); });
const selections = builtinRulePlugins.map(({ id, version }) => ({ id, version }));
const url = (sid: string, iid: string) => `/v1/sessions/${sid}/inspections/${iid}/rule-runs`;
const check = (run: RulePluginRun, code: string) => run.results.flatMap(r => r.status === 'completed' ? r.report.checks : []).find(c => c.code === code);
async function setup(path: string, fn: (engine: BrowserEngine, sid: string) => Promise<void>) {
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  try {
    const session = await engine.createSession({ url: fixture.url + path, headless: true, viewport: { width: 800, height: 600 }, settleMs: 50, inspection: {}, pageExploration: 'all', evidenceRetention: { mode: 'cache' } });
    await fn(engine, session.id);
  } finally { await engine.close(); }
}

it('runs all installed plugins, persists results, deduplicates retries and uses only history up to the selected task', async () => {
  await setup('/observed-occlusion.html?mode=modal', async (engine, sid) => {
    const app = await createServer(engine);
    try {
      const first = engine.listInspections(sid).items[0];
      const count = engine.session(sid).actionCount;
      const initial = await app.inject({ method: 'POST', url: url(sid, first.id), payload: { requestId: 'first', plugins: selections } });
      expect(initial.statusCode).toBe(200); const run = initial.json<RulePluginRun>();
      expect(run.results.map(r => r.status)).toEqual(selections.map(() => 'completed'));
      const warning = check(run, 'OCCLUSION_SUSPECTED')!;
      expect(warning).toMatchObject({ severity: 'warning', verdict: 'unknown' });
      expect(engine.session(sid).actionCount).toBe(count);
      expect(await pageOf(engine).locator('#scroller').evaluate(el => el.scrollTop)).toBe(0);
      const container = engine.observation(sid).scrollContainers!.find(c => c.selector === '#scroller')!;
      const action = engine.actions(sid).find(a => a.kind === 'scroll' && ((a.localId === container.nodeId && (a.value as any).y > 0) || (a.source === 'scroll-traversal' && (a.value as any).containerNodeId === container.nodeId && (a.value as any).top > container.top)))!;
      expect(action).toBeDefined();
      await engine.execute(sid, action.id, crypto.randomUUID());
      const second = engine.listInspections(sid).items.at(-1)!;
      const before = { count: engine.session(sid).actionCount, top: await pageOf(engine).locator('#scroller').evaluate(el => el.scrollTop) };
      const next = (await app.inject({ method: 'POST', url: url(sid, second.id), payload: { requestId: 'next', plugins: selections } })).json<RulePluginRun>();
      expect(next.history.count).toBe(2);
      expect(check(next, 'OCCLUSION_RECOVERED_AFTER_SCROLL')).toMatchObject({ verdict: 'pass', facts: { lifecycle: 'resolved', issueId: warning.facts!.issueId } });
      expect(engine.session(sid).actionCount).toBe(before.count);
      expect(await pageOf(engine).locator('#scroller').evaluate(el => el.scrollTop)).toBe(before.top);
      const old = (await app.inject({ method: 'POST', url: url(sid, first.id), payload: { requestId: 'old-again', plugins: selections } })).json<RulePluginRun>();
      expect(old.history.count).toBe(1); expect(check(old, 'OCCLUSION_SUSPECTED')).toBeDefined();
      expect(check(old, 'OCCLUSION_RECOVERED_AFTER_SCROLL')).toBeUndefined();
      const read = vi.spyOn(engine, 'captureDetails');
      expect((await app.inject({ method: 'POST', url: url(sid, first.id), payload: run.request })).json()).toEqual(run);
      expect(read).not.toHaveBeenCalled(); read.mockRestore();
      expect((await app.inject({ method: 'GET', url: url(sid, second.id) })).json().items).toEqual([next]);
      expect((await app.inject({ method: 'POST', url: url(sid, second.id), payload: run.request })).statusCode).toBe(409);
    } finally { await app.close(); }
  });
});

it('rejects invalid selections and foreign tasks before reading evidence; enforces the replay bound', async () => {
  await setup('/text-truncation.html', async (engine, sid) => {
    const app = await createServer(engine); const task = engine.listInspections(sid).items[0];
    const read = vi.spyOn(engine, 'captureDetails');
    try {
      for (const plugins of [[], [selections[0], selections[0]], [{ id: 'unknown', version: '1' }], [{ ...selections[0], version: '0' }]]) {
        expect((await app.inject({ method: 'POST', url: url(sid, task.id), payload: { requestId: 'invalid', plugins } })).statusCode).toBe(400);
      }
      await engine.stop(sid);
      const other = await engine.createSession({ url: fixture.url, headless: true });
      expect((await app.inject({ method: 'GET', url: url(other.id, task.id) })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: url(other.id, task.id), payload: { requestId: 'foreign', plugins: selections } })).statusCode).toBe(404);
      const list = vi.spyOn(engine, 'listInspections').mockReturnValue({ items: [], hasMore: true, nextCursor: 500 });
      expect((await app.inject({ method: 'POST', url: url(sid, task.id), payload: { requestId: 'limit', plugins: selections } })).json().error.code).toBe('RULE_HISTORY_LIMIT');
      list.mockRestore(); expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); await app.close(); }
  });
});

it('isolates failed plugins and concurrent retries without blocking an exploration command', async () => {
  await setup('/text-truncation.html', async (engine, sid) => {
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
    const create = vi.fn(() => ({ run: async () => { entered(); await gate; throw new Error('fixture failure'); } }));
    const broken: RulePlugin = { ...builtinRulePlugins[0], id: 'broken', create };
    const app = await createServer(engine, { rulePlugins: [broken, builtinRulePlugins[2]] });
    try {
      const task = engine.listInspections(sid).items[0];
      const request = { method: 'POST' as const, url: url(sid, task.id), payload: { requestId: 'parallel', plugins: [{ id: broken.id, version: broken.version }, selections[2]] } };
      const a = app.inject(request).then(r => r.json<RulePluginRun>()); await ready;
      const b = app.inject(request).then(r => r.json<RulePluginRun>());
      await engine.observe(sid); // Must finish while the plugin is still waiting.
      release(); const [one, two] = await Promise.all([a, b]);
      expect(one).toEqual(two); expect(create).toHaveBeenCalledTimes(1);
      expect(one.results[0]).toMatchObject({ status: 'failed', error: 'fixture failure' });
      expect(check(one, 'TEXT_HARD_CLIP_SUSPECTED')).toMatchObject({ severity: 'warning' });
      expect(one.history.count).toBe(1);
    } finally { release(); await app.close(); }
  });
});

it('keeps saved runs after restart and reports missing historical evidence honestly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rule-plugins-'));
  let engine = new BrowserEngine({ persistence: new SqliteStore(directory) }); let app = await createServer(engine);
  try {
    const s = await engine.createSession({ url: `${fixture.url}/text-truncation.html?mode=ellipsis`, headless: true, inspection: {}, evidenceRetention: { mode: 'cache' } });
    const task = engine.listInspections(s.id).items[0];
    const request = { requestId: 'before-restart', plugins: selections };
    const saved = (await app.inject({ method: 'POST', url: url(s.id, task.id), payload: request })).json<RulePluginRun>();
    expect(check(saved, 'TEXT_ELISION_OBSERVED')).toMatchObject({ severity: 'info', verdict: 'unknown' });
    await app.close(); await engine.close();
    engine = new BrowserEngine({ persistence: new SqliteStore(directory) }); app = await createServer(engine);
    expect((await app.inject({ method: 'GET', url: url(s.id, task.id) })).json().items).toEqual([saved]);
    expect((await app.inject({ method: 'POST', url: url(s.id, task.id), payload: request })).json()).toEqual(saved);
    const rerun = (await app.inject({ method: 'POST', url: url(s.id, task.id), payload: { ...request, requestId: 'after-restart' } })).json<RulePluginRun>();
    expect(rerun.results).toHaveLength(selections.length);
    for (const result of rerun.results) {
      expect(result.status).toBe('completed');
      if (result.status === 'completed') expect(result.report).toMatchObject({ verdict: 'unknown' });
    }
  } finally { await app.close(); await engine.close(); rmSync(directory, { recursive: true, force: true }); }
});
