import { createHash } from 'node:crypto';
import type { Inspection, InteractionEngine } from '@interaction/browser';
import type { CaptureReader, RulePlugin, RulePluginInfo, RulePluginResult } from '@interaction/rules';

export const pluginInfo = (p: RulePlugin): RulePluginInfo => ({ id: p.id, version: p.version, name: p.name, description: p.description, effects: p.effects });
export const ruleId = (prefix: string, parts: unknown[]) => `${prefix}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
export function createRuleStates(plugins: readonly RulePlugin[]) {
  return plugins.map(plugin => {
    try { return { plugin, tracker: plugin.create(), result: undefined as RulePluginResult | undefined }; }
    catch (e) { return { plugin, tracker: undefined, result: { plugin: pluginInfo(plugin), status: 'failed', error: String(e) } as RulePluginResult }; }
  });
}

/** A session-owned tracker consumes immutable captures in order, without a live page. */
export async function checkRuleFrame(engine: InteractionEngine, states: ReturnType<typeof createRuleStates>, task: Inspection): Promise<RulePluginResult[]> {
  const sessionId = task.sessionId;
  let source: ReturnType<CaptureReader['captureDetails']> | undefined;
  const reader: CaptureReader = { captureDetails: async (sid, cid) => {
    if (sid !== sessionId || cid !== task.captureId) throw new Error('PLUGIN_CAPTURE_OUT_OF_SCOPE');
    source ??= engine.captureDetails(sid, cid);
    return structuredClone(await source);
  } };
  for (const state of states) {
    if (!state.tracker || state.result?.status === 'failed') continue;
    try {
      const report = structuredClone(await state.tracker.run(reader, structuredClone(task)));
      if (report.inspectionId !== task.id || report.captureId !== task.captureId || report.ruleId !== state.plugin.id || report.ruleVersion !== state.plugin.version) throw new Error('PLUGIN_REPORT_BINDING_MISMATCH');
      for (const check of report.checks) {
        const facts = check.facts;
        if (facts?.issueId && facts.firstCaptureId && facts.identityId) facts.issueId = ruleId('rule-issue', [sessionId, state.plugin.id, state.plugin.version, facts.firstCaptureId, facts.identityId]);
      }
      const controls = engine.observation(sessionId, task.observationId).controls;
      const targetLabels = Object.fromEntries(report.checks.flatMap(check => {
        const target = check.target;
        const control = target?.captureId === task.captureId ? controls.find(c => c.localId === target.nodeId) : undefined;
        const label = control ? control.name || control.role || control.tag : check.facts?.label;
        return target?.captureId === task.captureId && typeof label === 'string' ? [[target.nodeId, label]] : [];
      }));
      state.result = { plugin: pluginInfo(state.plugin), status: 'completed', report, targetLabels };
    } catch (e) { state.result = { plugin: pluginInfo(state.plugin), status: 'failed', error: e instanceof Error ? e.message : String(e) }; }
  }
  return states.map(s => s.result ?? { plugin: pluginInfo(s.plugin), status: 'failed', error: 'PLUGIN_NO_RESULT' });
}
