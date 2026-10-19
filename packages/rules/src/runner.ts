import { z } from 'zod';
import type { ControlRule, DomRule, Json, RuleAssessment, RuleCheck, RuleMetadata, RulePage, RuleReport, RuleSelection } from './types.js';

const selectionSchema = z.array(z.object({
  ruleId: z.string().min(1).max(200), ruleVersion: z.string().min(1).max(100), enabled: z.boolean().optional(),
  options: z.record(z.string(), z.json()).optional(),
  targets: z.array(z.object({ captureId: z.string().min(1), nodeId: z.string().min(1).max(300) }).strict()).max(1000).optional(),
}).strict()).max(32);
const assessmentSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'unknown', 'not-applicable']), severity: z.enum(['info', 'warning', 'error']),
  code: z.string().min(1), expected: z.string(), actual: z.string(), evidence: z.array(z.string()),
  facts: z.record(z.string(), z.json()).optional(), nextSteps: z.array(z.string()).optional(),
}).strict();
const unknown = (code: string, actual: string): RuleAssessment => ({ verdict: 'unknown', severity: 'info', code, expected: 'Sufficient evidence to evaluate the selected rule', actual, evidence: [] });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export class RuleRunner {
  private readonly rules = new Map<string, ControlRule | DomRule>();
  private readonly timeoutMs: number;
  constructor(rules: (ControlRule | DomRule)[], options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) throw new Error('Rule timeout must be between 1 and 60000 ms');
    for (const rule of rules) {
      const metadata = z.object({ id: z.string().min(1).max(200), version: z.string().min(1).max(100), name: z.string(), description: z.string(), requiredCapabilities: z.array(z.string().min(1)), optionsSchema: z.record(z.string(), z.json()).optional(), targetKind: z.enum(['control', 'dom-element']).optional(), targetTags: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1).max(32).optional() }).parse(rule);
      if (metadata.targetKind === 'dom-element' && !metadata.targetTags?.length) throw new Error('DOM rules require targetTags');
      if (this.rules.has(rule.id)) throw new Error(`Duplicate rule ID: ${rule.id}`);
      this.rules.set(rule.id, { ...freeze(metadata), configure: rule.configure.bind(rule) } as ControlRule | DomRule);
    }
  }
  catalog(): RuleMetadata[] {
    return [...this.rules.values()].map(({ configure: _, ...metadata }) => structuredClone(metadata));
  }
  async run(page: RulePage, input: RuleSelection[]): Promise<RuleReport[]> {
    const selections = selectionSchema.parse(input);
    const enabled = selections.filter(s => s.enabled !== false);
    if (new Set(enabled.map(s => s.ruleId)).size !== enabled.length) throw new Error('Select each rule once per inspection');
    // Validate the entire plan before reading evidence or running any rule.
    const configured = enabled.map(selection => {
      const rule = this.rules.get(selection.ruleId);
      if (!rule || rule.version !== selection.ruleVersion) throw new Error(`Unknown rule/version: ${selection.ruleId}@${selection.ruleVersion}`);
      if (selection.targets && new Set(selection.targets.map(t => JSON.stringify(t))).size !== selection.targets.length) throw new Error('Duplicate rule targets');
      return { selection, rule, evaluate: rule.configure(structuredClone(selection.options ?? {})) };
    });
    if (!configured.length) return [];
    const source = freeze(structuredClone(page));
    const task = source.inspection, capture = source.capture, observation = source.observation, dom = source.snapshot.dom;
    const reports: RuleReport[] = [];
    for (const { selection, rule, evaluate } of configured) {
      let checks: RuleCheck[] = [];
      const unavailable = rule.requiredCapabilities.filter(kind => !capabilityCaptured(kind, source));
      if (capture.id !== task.captureId || capture.observationId !== task.observationId ||
        observation?.id !== task.observationId || observation?.documentId !== capture.documentId || source.snapshot.documentId !== capture.documentId ||
        dom?.documentId !== capture.documentId || source.snapshot.observationId !== task.observationId) {
        checks = [unknown('EVIDENCE_BINDING_MISMATCH', 'Capture, observation or document evidence is missing or does not match this inspection')];
      } else if (task.protocolVersion !== 1 || unavailable.length) {
        checks = [unknown('EVIDENCE_UNAVAILABLE', `Unsupported or unavailable required evidence: ${unavailable.join(', ')}`)];
      } else if (capture.quality.status !== 'complete' || !dom || !observation || dom.nodesTruncated || !observation.stable) {
        checks = [unknown('EVIDENCE_INCOMPLETE', 'Required evidence is incomplete, truncated or unsettled')];
      } else {
        const targets = selection.targets ?? (rule.targetKind === 'dom-element'
          ? dom.nodes.filter(n => n.nodeType === 'element' && rule.targetTags.includes(n.tag ?? '')).map(n => ({ captureId: capture.id, nodeId: n.id }))
          : observation.controls.map(c => ({ captureId: capture.id, nodeId: c.localId })));
        if (targets.length > 1000) checks = [unknown('TARGET_BUDGET_EXCEEDED', 'More than 1000 targets; select an explicit bounded set')];
        else if (!targets.length) checks = [{ verdict: 'not-applicable', severity: 'info', code: 'NO_TARGETS', expected: 'At least one selected target', actual: 'No matching targets were selected', evidence: [] }];
        else {
          const controls = new Map(observation.controls.map(c => [c.localId, c]));
          const nodes = new Map(dom.nodes.map(n => [n.id, n]));
          const abort = new AbortController();
          const completed: RuleCheck[] = [];
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            checks = await Promise.race([
              (async () => {
                for (const target of targets) {
                  if (abort.signal.aborted) break;
                  const control = controls.get(target.nodeId); const node = nodes.get(target.nodeId);
                  if (target.captureId !== capture.id || !node || (rule.targetKind === 'dom-element'
                    ? node.nodeType !== 'element' || !rule.targetTags.includes(node.tag ?? '') : !control)) {
                    completed.push(unknown('TARGET_UNAVAILABLE', `Target ${target.captureId}/${target.nodeId} is not an eligible target in this capture`)); continue;
                  }
                  const binding = { captureId: capture.id, documentId: capture.documentId, nodeId: node.id };
                  try {
                    const result = assessmentSchema.parse(await evaluate(Object.freeze({ inspection: task, capture, observation, snapshot: source.snapshot, dom, control: control!, node, signal: abort.signal })));
                    completed.push({ ...result, target: binding });
                  } catch (error) {
                    completed.push({ ...unknown('RULE_ERROR', String(error)), target: binding });
                  }
                }
                return completed;
              })(),
              new Promise<RuleCheck[]>(resolve => {
                timer = setTimeout(() => { abort.abort(); resolve([...completed, unknown('RULE_TIMEOUT', `Rule exceeded ${this.timeoutMs} ms; remaining targets are unverified`)]); }, this.timeoutMs);
              }),
            ]);
          } finally { if (timer) clearTimeout(timer); abort.abort(); }
        }
      }
      // A known failure remains a failure even when other targets are unknown.
      const verdict = checks.some(c => c.verdict === 'fail') ? 'fail' : checks.some(c => c.verdict === 'unknown') ? 'unknown' : checks.some(c => c.verdict === 'pass') ? 'pass' : 'not-applicable';
      const severity = checks.some(c => c.severity === 'error') ? 'error' : checks.some(c => c.severity === 'warning') ? 'warning' : 'info';
      reports.push({ schemaVersion: 1, inspectionId: task.id, captureId: capture.id, documentId: capture.documentId, ruleId: rule.id, ruleVersion: rule.version, selection, verdict, severity, checks });
    }
    return reports;
  }
}

export interface InspectionResult {
  ruleId: string; ruleVersion: string; status: 'pass' | 'fail' | 'inconclusive' | 'not-applicable';
  severity: 'info' | 'warning' | 'error'; message: string; nodeIds: string[]; details: Json;
}
/** One result per rule/version; preserve every control result in the delivery record. */
export function toInspectionResults(reports: RuleReport[]): InspectionResult[] {
  return reports.map(report => ({
    ruleId: report.ruleId, ruleVersion: report.ruleVersion,
    status: report.verdict === 'unknown' ? 'inconclusive' : report.verdict,
    severity: report.severity,
    message: (['fail', 'unknown', 'pass', 'not-applicable'] as const).map(v => `${v}: ${report.checks.filter(c => c.verdict === v).length}`).join(', '),
    nodeIds: [...new Set(report.checks.flatMap(c => c.target ? [c.target.nodeId] : []))],
    details: JSON.parse(JSON.stringify(report)) as Json,
  }));
}

/** Which evidence kinds a capture holds (the inspection protocol's capability names). */
function capabilityCaptured(kind: string, page: RulePage) {
  const dom = page.snapshot.dom;
  if (kind === 'web.runtime') return !!page.snapshot.runtime;
  if (!dom) return false;
  if (kind === 'web.dom') return true;
  if (kind === 'web.layout') return dom.spatialVersion === 1;
  if (kind === 'web.styles') return true;
  if (kind === 'web.environment') return !!dom.environment;
  return false;
}
