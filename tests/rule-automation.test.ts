import { it, expect } from 'vitest';
import { BrowserEngine } from '@interaction/browser';
import { MemoryStore } from '@interaction/storage-memory';
import { builtinRulePlugins, type RuleAutomation, type RulePlugin, type RulePluginRun } from '@interaction/rules';
import { createServer } from '../apps/server/src/server.js';
import { fixtureServer, act } from './helpers.js';

const selections = builtinRulePlugins.map(({ id, version }) => ({ id, version }));
const path = (sid: string) => `/v1/sessions/${sid}/rule-automation`;
const runs = (engine: BrowserEngine, sid: string) => engine.list<RulePluginRun>(sid, 'rule-plugin-run');
const state = (engine: BrowserEngine, sid: string) => engine.list<RuleAutomation>(sid, 'rule-automation')[0];
const caughtUp = async (engine: BrowserEngine, sid: string) => {
  await expect.poll(() => state(engine, sid)?.completedCount, { timeout: 15000 }).toBe(engine.listInspections(sid, { limit: 500 }).items.length);
  await expect.poll(() => state(engine, sid)?.status).toBe('watching');
};

it('automatically checks the original page throughout real DFS, including the settings dialog, and resumes without duplicate results', async () => {
  const fixture = await fixtureServer(undefined, { ruleDefects: true });
  const engine = new BrowserEngine({ persistence: new MemoryStore() });
  let app = await createServer(engine);
  try {
    const s = await engine.createSession({ url: fixture.url, headless: true, inspection: {}, exploration: 'controls', maxActions: 100,
      settleMs: 100, observeTimeoutMs: 1000, actionTimeoutMs: 1500, evidenceRetention: { mode: 'persistent' } });
    const configured = await app.inject({ method: 'POST', url: path(s.id), payload: { enabled: true, plugins: selections } });
    expect(configured.statusCode).toBe(200);
    await engine.explore(s.id); await engine.waitForIdle(); await caughtUp(engine, s.id);
    const saved = runs(engine, s.id);
    const findings = saved.flatMap(run => run.results.flatMap(r => r.status === 'completed' ? r.report.checks.map(c => ({ ...c, label: c.target && r.targetLabels[c.target.nodeId], inspectionId: run.inspectionId })) : []));
    expect(saved.length).toBeGreaterThan(5);
    expect(saved.every(r => r.origin === 'automatic' && r.results.every(p => p.status === 'completed'))).toBe(true);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Submit test order', code: 'TEXT_HARD_CLIP_SUSPECTED', severity: 'warning' }),
      expect.objectContaining({ label: 'Reset interface', code: 'OCCLUSION_SUSPECTED', severity: 'warning' }),
      expect.objectContaining({ label: 'Done', code: 'CONTROL_CLIPPING_SUSPECTED', severity: 'warning' }),
    ]));
    const modal = findings.find(c => c.label === 'Done' && c.code === 'CONTROL_CLIPPING_SUSPECTED')!;
    expect((await engine.inspection(s.id, modal.inspectionId)).inspection.focus.kind).toBe('overlay');
    expect(engine.session(s.id).stopReason).toBe('known_frontier_exhausted_with_gaps');
    const summary = (await app.inject(`/v1/sessions/${s.id}/rule-run-summary`)).json();
    expect(summary.items).toHaveLength(saved.length);
    expect(summary.items.some((r: { warnings: number }) => r.warnings > 0)).toBe(true);
    await app.close(); app = await createServer(engine); await app.ready();
    await expect.poll(() => state(engine, s.id)?.status).toBe('watching');
    // Wait for the replay to reach the end before taking another capture.
    await engine.observe(s.id); await caughtUp(engine, s.id);
    expect(runs(engine, s.id).slice(0, saved.length)).toEqual(saved);
    expect(new Set(runs(engine, s.id).map(r => r.inspectionId)).size).toBe(saved.length + 1);
  } finally { await app.close(); await engine.close(); await fixture.server.close(); }
}, 180000);

it('does not block exploration on a slow plugin and discards a late run after automatic checking is disabled', async () => {
  const fixture = await fixtureServer(); const engine = new BrowserEngine({ persistence: new MemoryStore() });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const base = builtinRulePlugins[2];
  const slow: RulePlugin = { ...base, create: () => { const tracker = base.create(); return { run: async (reader, task) => { entered(); await gate; return tracker.run(reader, task); } }; } };
  const app = await createServer(engine, { rulePlugins: [slow] });
  try {
    const s = await engine.createSession({ url: fixture.url, headless: true, inspection: {}, settleMs: 50 });
    const payload = { enabled: true, plugins: [{ id: slow.id, version: slow.version }] };
    expect((await app.inject({ method: 'POST', url: path(s.id), payload })).statusCode).toBe(200);
    await ready;
    await act(engine, s.id, 'Other settings');
    expect(engine.observation(s.id).controls.some(c => c.name === 'Done')).toBe(true);
    expect(runs(engine, s.id)).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: path(s.id), payload: { ...payload, enabled: false } })).statusCode).toBe(200);
    release(); await app.close();
    expect(runs(engine, s.id)).toHaveLength(0);
    expect(state(engine, s.id)).toMatchObject({ enabled: false, status: 'paused' });
  } finally { release(); await app.close(); await engine.close(); await fixture.server.close(); }
});

it('validates configuration, isolates a failed plugin and deduplicates repeated enable requests', async () => {
  const fixture = await fixtureServer(); const engine = new BrowserEngine({ persistence: new MemoryStore() });
  const broken: RulePlugin = { ...builtinRulePlugins[0], create: () => { throw new Error('factory failed'); } };
  const app = await createServer(engine, { rulePlugins: [broken, builtinRulePlugins[2]] });
  try {
    const s = await engine.createSession({ url: fixture.url, headless: true, inspection: {} });
    const configure = (plugins: typeof selections) => app.inject({ method: 'POST', url: path(s.id), payload: { enabled: true, plugins } });
    expect((await configure([])).statusCode).toBe(400);
    expect((await configure([selections[0], selections[0]])).statusCode).toBe(400);
    expect((await configure([{ id: 'missing', version: '1' }])).statusCode).toBe(400);
    expect((await configure([selections[0], selections[2]])).statusCode).toBe(200);
    await caughtUp(engine, s.id);
    expect(runs(engine, s.id)[0].results.map(r => r.status)).toEqual(['failed', 'completed']);
    expect((await configure([selections[0], selections[2]])).json().revision).toBe(1);
    expect(runs(engine, s.id)).toHaveLength(1);
    expect((await app.inject(`/v1/sessions/${s.id}/rule-run-summary`)).json().items[0].failedPlugins).toBe(1);
  } finally { await app.close(); await engine.close(); await fixture.server.close(); }
});
