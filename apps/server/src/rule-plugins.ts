import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EngineError, type InteractionEngine } from '@interaction/browser';
import { builtinRulePlugins, type RulePlugin, type RulePluginRun, type RulePluginRunRequest } from '@interaction/rules';

import { createRuleStates, checkRuleFrame, pluginInfo as info } from './rule-execution.js';
import { registerRuleAutomation } from './rule-automation.js';

const kind = 'rule-plugin-run';
const maxHistory = 500;
const requestSchema = z.object({
  requestId: z.string().min(1).max(200),
  plugins: z.array(z.object({ id: z.string().min(1).max(100), version: z.string().min(1).max(100) }).strict()).min(1).max(20),
}).strict().refine(r => new Set(r.plugins.map(p => p.id)).size === r.plugins.length, 'Select each plugin only once');

/** Installed rule host; never joins the engine command queue or gets a live page. */
export function registerRulePlugins(app: FastifyInstance, engine: InteractionEngine, installed: readonly RulePlugin[] = builtinRulePlugins) {
  const registry = new Map<string, RulePlugin>();
  for (const plugin of installed) {
    if (!plugin.id || !plugin.version || plugin.effects !== 'read-history' || registry.has(plugin.id)) throw new Error(`Invalid or duplicate rule plugin: ${plugin.id}`);
    registry.set(plugin.id, plugin);
  }
  registerRuleAutomation(app, engine, registry);
  const inflight = new Map<string, { signature: string; promise: Promise<RulePluginRun> }>();
  const path = '/v1/sessions/:sessionId/inspections/:inspectionId/rule-runs';
  app.get('/v1/rule-plugins', async () => ({ plugins: [...registry.values()].map(info), maxHistory }));
  app.get<{ Params: { sessionId: string; inspectionId: string } }>(path, async request => {
    const { sessionId, inspectionId } = request.params;
    await engine.inspection(sessionId, inspectionId);
    return { items: engine.list<RulePluginRun>(sessionId, kind).filter(r => r.inspectionId === inspectionId).reverse() };
  });
  app.post<{ Params: { sessionId: string; inspectionId: string } }>(path, async request => {
    const input = requestSchema.parse(request.body);
    const { sessionId, inspectionId } = request.params;
    const { inspection } = await engine.inspection(sessionId, inspectionId);
    const id = `rule-run:${createHash('sha256').update(JSON.stringify([sessionId, input.requestId])).digest('hex')}`;
    const signature = JSON.stringify([inspectionId, input.plugins]);
    const existing = engine.store.get<RulePluginRun>(kind, id);
    const pending = inflight.get(id);
    if (existing || pending) {
      const previous = existing ? JSON.stringify([existing.inspectionId, existing.request.plugins]) : pending!.signature;
      if (previous !== signature) throw new EngineError('REQUEST_CONFLICT', '该请求已用于另一组规则或检查任务。');
      return existing ?? pending!.promise;
    }
    const plugins = input.plugins.map(selection => {
      const plugin = registry.get(selection.id);
      if (!plugin || plugin.version !== selection.version) throw new EngineError('INVALID_REQUEST', `规则未安装或版本不匹配：${selection.id}@${selection.version}`);
      return plugin;
    });
    const history = engine.listInspections(sessionId, { limit: maxHistory }).items.filter(i => i.sequence <= inspection.sequence);
    if (history.at(-1)?.id !== inspection.id) throw new EngineError('RULE_HISTORY_LIMIT', `本次检查超过 ${maxHistory} 条历史任务的重放上限，请使用较短的会话。`);
    const promise = execute(input);
    inflight.set(id, { signature, promise });
    try { return await promise; } finally { inflight.delete(id); }

    async function execute(input: RulePluginRunRequest): Promise<RulePluginRun> {
      const startedAt = new Date().toISOString();
      const states = createRuleStates(plugins);
      for (const task of history) await checkRuleFrame(engine, states, task);
      const run: RulePluginRun = { schemaVersion: 1, origin: 'manual', id, sessionId, inspectionId, captureId: inspection.captureId, request: input,
        startedAt, completedAt: new Date().toISOString(), history: { count: history.length, firstSequence: history[0].sequence, lastSequence: inspection.sequence },
        results: states.map(s => s.result ?? { plugin: info(s.plugin), status: 'failed', error: 'PLUGIN_NO_RESULT' }) };
      engine.store.put(kind, run);
      return run;
    }
  });
}
