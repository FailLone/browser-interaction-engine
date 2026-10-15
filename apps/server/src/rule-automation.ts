import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EngineError, type EngineEvent, type InteractionEngine } from '@interaction/browser';
import type { RuleAutomation, RulePlugin, RulePluginRun, RulePluginSelection, RuleRunSummary } from '@interaction/rules';
import { checkRuleFrame, createRuleStates, ruleId } from './rule-execution.js';

const kind = 'rule-automation';
const schema = z.object({ enabled: z.boolean(), plugins: z.array(z.object({ id: z.string().min(1).max(100), version: z.string().min(1).max(100) }).strict()).max(20) }).strict()
  .refine(r => (!r.enabled || r.plugins.length > 0) && new Set(r.plugins.map(p => p.id)).size === r.plugins.length, 'Select distinct installed plugins');
type Worker = { state: RuleAutomation; trackers: ReturnType<typeof createRuleStates>; sequence: number; count: number; firstSequence: number; pending?: Promise<void>; wake: boolean };

/** Independent, ordered consumer. Capture notifications never await plugin execution. */
export function registerRuleAutomation(app: FastifyInstance, engine: InteractionEngine, registry: Map<string, RulePlugin>) {
  const workers = new Map<string, Worker>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  const key = (sid: string) => `rule-automation:${sid}`;
  const read = (sid: string) => engine.store.get<RuleAutomation>(kind, key(sid));
  function plugins(selections: RulePluginSelection[]) {
    return selections.map(s => {
      const p = registry.get(s.id);
      if (!p || p.version !== s.version) throw new EngineError('INVALID_REQUEST', `规则未安装或版本不匹配：${s.id}@${s.version}`);
      return p;
    });
  }
  const current = (w: Worker) => !closing && workers.get(w.state.sessionId) === w;
  function save(w: Worker, status: RuleAutomation['status'], error?: string) {
    w.state = { ...w.state, status, error, updatedAt: new Date().toISOString() };
    engine.store.put(kind, w.state);
  }
  function notify(sid: string, type: string, data: unknown) {
    // The durable event is committed before notifying subscribers.
    engine.events.emit('event', engine.store.event(sid, type, data));
  }
  async function drain(w: Worker) {
    await yieldTurn();
    if (!current(w)) return;
    save(w, 'checking');
    do {
      w.wake = false;
      const page = engine.listInspections(w.state.sessionId, { after: w.sequence, limit: 50 });
      for (const task of page.items) {
        if (!current(w)) return;
        const startedAt = new Date().toISOString();
        const results = await checkRuleFrame(engine, w.trackers, task);
        if (!current(w)) return;
        w.sequence = task.sequence; w.count++; w.firstSequence ||= task.sequence;
        const id = ruleId('auto-rule-run', [w.state.sessionId, w.state.revision, task.id]);
        // Rebuild tracker history after restart without overwriting earlier evidence/results.
        if (!engine.store.get<RulePluginRun>('rule-plugin-run', id)) {
          const run: RulePluginRun = { schemaVersion: 1, id, sessionId: w.state.sessionId, inspectionId: task.id, captureId: task.captureId,
            origin: 'automatic', automationRevision: w.state.revision,
            request: { requestId: id, plugins: w.state.plugins }, startedAt, completedAt: new Date().toISOString(),
            history: { count: w.count, firstSequence: w.firstSequence, lastSequence: w.sequence }, results };
          engine.store.transaction(() => {
            engine.store.put('rule-plugin-run', run);
            w.state = { ...w.state, lastSequence: w.sequence, completedCount: w.count };
            save(w, 'checking');
          });
          notify(w.state.sessionId, 'rule-run.completed', { inspectionId: task.id, runId: id });
        }
        await yieldTurn();
      }
      w.wake ||= page.hasMore;
    } while (current(w) && w.wake);
    if (current(w)) { save(w, 'watching'); notify(w.state.sessionId, 'rule-automation.updated', w.state); }
  }
  function wake(w: Worker) {
    if (!current(w) || w.state.status === 'failed') return;
    w.wake = true;
    if (w.pending) return;
    const task = drain(w).catch(e => {
      if (current(w)) { save(w, 'failed', e instanceof Error ? e.message : String(e)); notify(w.state.sessionId, 'rule-automation.updated', w.state); }
    }).finally(() => { pending.delete(task); w.pending = undefined; if (w.wake && current(w)) wake(w); });
    w.pending = task; pending.add(task);
  }
  function start(state: RuleAutomation) {
    const w: Worker = { state, trackers: createRuleStates(plugins(state.plugins)), sequence: 0, count: 0, firstSequence: 0, wake: false };
    workers.set(state.sessionId, w); wake(w);
  }
  const listener = (event: EngineEvent) => {
    if (event.type !== 'inspection.ready') return;
    const w = workers.get(event.sessionId); if (w) wake(w);
  };
  engine.events.on('event', listener);
  app.addHook('onReady', async () => {
    for (const state of engine.store.list<RuleAutomation>(kind)) {
      if (!state.enabled || state.status === 'failed') continue;
      try { start(state); } catch (e) { engine.store.put(kind, { ...state, status: 'failed', error: String(e), updatedAt: new Date().toISOString() }); }
    }
  });
  app.addHook('preClose', async () => { closing = true; engine.events.off('event', listener); workers.clear(); await Promise.allSettled([...pending]); });
  const path = '/v1/sessions/:sessionId/rule-automation';
  app.get<{ Params: { sessionId: string } }>(path, async req => { engine.session(req.params.sessionId); return { automation: read(req.params.sessionId) ?? null }; });
  app.post<{ Params: { sessionId: string } }>(path, async req => {
    const sid = req.params.sessionId;
    const session = engine.session(sid); const input = schema.parse(req.body); plugins(input.plugins);
    if (input.enabled && !session.options.inspection) throw new EngineError('INVALID_REQUEST', '此会话未开启 UI 检查任务，请创建开启检查的新会话。');
    const previous = read(sid);
    if (previous && previous.status !== 'failed' && previous.enabled === input.enabled && JSON.stringify(previous.plugins) === JSON.stringify(input.plugins)) return previous;
    workers.delete(sid);
    const state: RuleAutomation = { ...input, id: key(sid), sessionId: sid, revision: (previous?.revision ?? 0) + 1,
      completedCount: 0, lastSequence: 0, updatedAt: new Date().toISOString(), status: input.enabled ? 'watching' : 'paused' };
    engine.store.put(kind, state); if (state.enabled) start(state);
    notify(sid, 'rule-automation.updated', state);
    return state;
  });
  app.get<{ Params: { sessionId: string } }>('/v1/sessions/:sessionId/rule-run-summary', async req => {
    const latest = new Map<string, RulePluginRun>();
    for (const run of engine.list<RulePluginRun>(req.params.sessionId, 'rule-plugin-run')) latest.set(run.inspectionId, run);
    const items: RuleRunSummary[] = [...latest.values()].sort((a, b) => b.history.lastSequence - a.history.lastSequence).slice(0, 500).map(run => {
      const checks = run.results.flatMap(r => r.status === 'completed' ? r.report.checks : []);
      return { inspectionId: run.inspectionId, sequence: run.history.lastSequence, runId: run.id, origin: run.origin,
        errors: checks.filter(c => c.severity === 'error').length, warnings: checks.filter(c => c.severity === 'warning').length,
        unknown: checks.filter(c => c.verdict === 'unknown').length, failedPlugins: run.results.filter(r => r.status === 'failed').length };
    });
    return { items, hasMore: latest.size > items.length };
  });
}
