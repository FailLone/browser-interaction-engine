import { z } from 'zod';
import { hasRelevantGaps } from '../evidence-dependencies.js';
import { hash } from '../util.js';
import type { RulePlugin } from '../plugins.js';
import type { DomNodeEvidence, Json, Rect, RuleAssessment, RuleCheck, RulePage, RuleReport } from '../types.js';

const nonempty = z.string().trim().min(1);
export const rectSchema = z
  .object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() })
  .strict();
export const targetSchema = z
  .object({
    sessionId: nonempty,
    documentId: nonempty,
    observationId: nonempty,
    captureId: nonempty,
    nodeId: nonempty,
    fingerprint: nonempty,
  })
  .strict();
export type SentinelTarget = z.infer<typeof targetSchema>;
export const bindingSchema = z
  .object({
    ruleId: nonempty,
    target: targetSchema,
    applicability: z.enum(['yes', 'no', 'unknown']),
    /** A host-verified specification or investigation, never a page attribute. */
    source: nonempty,
    reason: nonempty,
    evidence: z.array(nonempty).min(1).max(32),
    data: z.unknown().optional(),
  })
  .strict();
export type SentinelBinding = z.infer<typeof bindingSchema>;
export interface SentinelOptions {
  /** Select runtime IDs from sentinelCatalog. Omit to run all the new checks. */
  rules?: readonly string[];
  /**
   * Trusted host integration: bind product meaning and supply recorded visual/temporal facts.
   * Receives a frozen capture, not a browser. Called once per capture, including swept views.
   * No binding means unknown. Explicit applicability:'no' records a known exception.
   */
  collect?: (
    page: Readonly<RulePage>,
    signal: AbortSignal,
  ) => readonly SentinelBinding[] | Promise<readonly SentinelBinding[]>;
  collectTimeoutMs?: number;
  /** Ask for pixels only on captures where the host's visual observer needs them. */
  wantsPixels?: (page: RulePage) => boolean;
}
export interface SentinelContext {
  page: RulePage;
  node: DomNodeEvidence;
  binding: SentinelBinding;
  resolve(target: SentinelTarget): DomNodeEvidence;
}
export interface SentinelDefinition {
  id: string;
  name: string;
  description: string;
  kind: 'defect' | 'review';
  /** Reachability and transient-state checks also need targets outside a stable visible screen. */
  offscreen?: boolean;
  moving?: boolean;
  evaluate(context: SentinelContext, data: unknown): RuleAssessment;
}
export function defineSentinelRule<T>(
  metadata: Omit<SentinelDefinition, 'evaluate'>,
  schema: z.ZodType<T>,
  evaluate: (context: SentinelContext, data: T) => RuleAssessment,
): SentinelDefinition {
  return { ...metadata, evaluate: (context, data) => evaluate(context, schema.parse(data)) };
}
export const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
export function assessment(
  verdict: RuleAssessment['verdict'],
  actual: string,
  facts: Record<string, Json> = {},
): RuleAssessment {
  return {
    verdict,
    severity: verdict === 'fail' ? 'warning' : 'info',
    code:
      verdict === 'pass'
        ? 'UIK_CHECK_PASSED'
        : verdict === 'fail'
          ? 'UIK_DEFECT_OBSERVED'
          : verdict === 'not-applicable'
            ? 'UIK_EXCEPTION'
            : 'UIK_EVIDENCE_REQUIRED',
    expected: '',
    actual,
    evidence: [],
    facts,
  };
}
export const unknown = (actual: string, facts?: Record<string, Json>) => assessment('unknown', actual, facts);
export const pass = (actual: string, facts?: Record<string, Json>) => assessment('pass', actual, facts);
export const fail = (actual: string, facts?: Record<string, Json>) => assessment('fail', actual, facts);
export const exempt = (actual: string, facts?: Record<string, Json>) => assessment('not-applicable', actual, facts);
export const review = (actual: string, facts?: Record<string, Json>): RuleAssessment => ({
  ...unknown(actual, facts),
  severity: 'warning',
  code: 'UIK_REVIEW_SUGGESTED',
  nextSteps: ['Review the recorded difference and the intended design; this is not a defect verdict.'],
});
export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
export const contains = (outer: Rect, inner: Rect, tolerance = 0) =>
  inner.width > 0 &&
  inner.height > 0 &&
  inner.x >= outer.x - tolerance &&
  inner.y >= outer.y - tolerance &&
  inner.x + inner.width <= outer.x + outer.width + tolerance &&
  inner.y + inner.height <= outer.y + outer.height + tolerance;

class EvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
// Per DOM capture: each id's nodes, so ancestry is a lookup rather than a scan per level.
const indexes = new WeakMap<object, Map<string, DomNodeEvidence[]>>();
function indexOf(nodes: readonly DomNodeEvidence[]) {
  let index = indexes.get(nodes);
  if (!index) {
    index = new Map();
    for (const n of nodes) index.get(n.id)?.push(n) ?? index.set(n.id, [n]);
    indexes.set(nodes, index);
  }
  return index;
}
function chain(page: RulePage, nodeId: string): DomNodeEvidence[] {
  const dom = page.snapshot.dom;
  if (!dom) throw new EvidenceError('EVIDENCE_UNAVAILABLE', 'A detailed DOM capture is required');
  const index = indexOf(dom.nodes);
  const result: DomNodeEvidence[] = [];
  const visited = new Set<string>();
  let id: string | undefined = nodeId;
  while (id) {
    const matches: DomNodeEvidence[] = index.get(id) ?? [];
    if (matches.length !== 1 || visited.has(id))
      throw new EvidenceError('UIK_TARGET_UNAVAILABLE', 'Target ancestry is missing, ambiguous or cyclic');
    const node = matches[0];
    visited.add(id);
    result.push(node);
    if (id === dom.rootId) return result;
    id = node.parentId;
  }
  throw new EvidenceError('UIK_TARGET_UNAVAILABLE', 'Target ancestry does not reach the captured document');
}
/** Bind the actual current node, independent of its text or CSS selector. Rebind after any change. */
export function bindSentinelTarget(page: RulePage, nodeId: string): SentinelTarget {
  return {
    sessionId: page.capture.sessionId,
    documentId: page.capture.documentId,
    observationId: page.observation.id,
    captureId: page.capture.id,
    nodeId,
    fingerprint: fingerprint(page, nodeId),
  };
}
// Only a frozen capture can be trusted not to change under a cached fingerprint.
const fingerprints = new WeakMap<RulePage, Map<string, string>>();
function fingerprint(page: RulePage, nodeId: string) {
  const frozen = Object.isFrozen(page);
  let cached = frozen ? fingerprints.get(page) : undefined;
  const hit = cached?.get(nodeId);
  if (hit) return hit;
  const value = hash({
    ancestors: chain(page, nodeId),
    control: page.observation.controls.filter(c => c.localId === nodeId),
    environment: page.snapshot.dom?.environment,
    focus: page.inspection.focus,
  });
  if (frozen) {
    if (!cached) fingerprints.set(page, (cached = new Map()));
    cached.set(nodeId, value);
  }
  return value;
}
function resolve(page: RulePage, target: SentinelTarget) {
  if (hash(bindSentinelTarget(page, target.nodeId)) !== hash(target))
    throw new EvidenceError('UIK_TARGET_STALE', 'The target belongs to another capture or its evidence has changed');
  const ancestors = chain(page, target.nodeId);
  if (ancestors.some(n => hasRelevantGaps(n)))
    throw new EvidenceError('EVIDENCE_INCOMPLETE', 'Target or ancestor evidence has missing or truncated fields');
  const active = page.observation.overlays?.at(-1);
  if (active && !ancestors.some(n => n.id === page.snapshot.dom?.regionRoots[active.key]))
    throw new EvidenceError('OUTSIDE_ACTIVE_SCOPE', 'The bound object is outside the active overlay');
  return ancestors[0];
}
export function rendered(page: RulePage, node: DomNodeEvidence): boolean {
  return (
    !!node.rect &&
    node.rect.width > 0 &&
    node.rect.height > 0 &&
    chain(page, node.id).every(
      n =>
        !!n.styles &&
        n.styles.display !== 'none' &&
        n.styles.visibility !== 'hidden' &&
        n.styles.visibility !== 'collapse' &&
        n.styles['content-visibility'] !== 'hidden' &&
        Number(n.styles.opacity ?? '1') > 0,
    )
  );
}
function captureError(page: RulePage): string | undefined {
  const { inspection: i, capture: c, observation: o, snapshot: s } = page;
  if (
    i.protocolVersion !== 1 ||
    i.sessionId !== c.sessionId ||
    i.captureId !== c.id ||
    i.observationId !== c.observationId ||
    o.id !== c.observationId ||
    s.observationId !== o.id ||
    o.documentId !== c.documentId ||
    s.documentId !== c.documentId ||
    s.dom?.documentId !== c.documentId ||
    s.dom?.capturedAt !== c.capturedAt
  )
    return 'EVIDENCE_BINDING_MISMATCH';
  if (i.focus.confidence !== 'observed') return 'SCOPE_UNKNOWN';
  if (
    c.quality.status !== 'complete' ||
    c.quality.missingRequired.length ||
    !o.stable ||
    s.dom.nodesTruncated ||
    !s.dom.environment ||
    s.dom.spatialVersion !== 1
  )
    return 'EVIDENCE_INCOMPLETE';
  return undefined;
}
function report(page: RulePage, id: string, checks: RuleCheck[]): RuleReport {
  return {
    schemaVersion: 1,
    inspectionId: page.inspection.id,
    captureId: page.capture.id,
    documentId: page.capture.documentId,
    ruleId: id,
    ruleVersion: '1.0.0',
    selection: { ruleId: id, ruleVersion: '1.0.0' },
    verdict: checks.some(c => c.verdict === 'fail')
      ? 'fail'
      : checks.some(c => c.verdict === 'unknown')
        ? 'unknown'
        : checks.some(c => c.verdict === 'pass')
          ? 'pass'
          : 'not-applicable',
    severity: checks.some(c => c.severity === 'warning') ? 'warning' : 'info',
    checks,
  };
}
const bindingRequired = (): RuleCheck => ({
  ...unknown('This check requires current semantic bindings and recorded evidence from the host'),
  code: 'UIK_BINDING_REQUIRED',
});
function freeze<T>(value: T): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export function makeSentinelPlugins(
  definitions: readonly SentinelDefinition[],
  options: SentinelOptions,
): RulePlugin[] {
  const ids = new Set(definitions.map(d => d.id));
  if (options.rules && (options.rules.some(id => !ids.has(id)) || new Set(options.rules).size !== options.rules.length))
    throw new Error('Select each supported Sentinel rule at most once');
  const timeoutMs = options.collectTimeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new Error('Sentinel evidence timeout must be between 1 and 120000 ms');
  // Instances share only immutable evidence, never results or cross-state judgments.
  const cache = new WeakMap<RulePage, Promise<{ page: RulePage; bindings: SentinelBinding[] }>>();
  const read = (page: RulePage) => {
    let value = cache.get(page);
    if (!value) {
      value = (async () => {
        const snapshot = freeze(structuredClone(page));
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let supplied: readonly SentinelBinding[];
        try {
          supplied = await Promise.race([
            Promise.resolve().then(() => options.collect?.(snapshot, abort.signal) ?? []),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Sentinel evidence collection timed out')), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          abort.abort();
        }
        const bindings = z.array(bindingSchema).max(500).parse(supplied);
        if (bindings.some(b => !ids.has(b.ruleId)))
          throw new Error('The evidence provider returned an unsupported Sentinel rule ID');
        const keys = bindings.map(b => `${b.ruleId}|${b.target.nodeId}`);
        if (new Set(keys).size !== keys.length) throw new Error('Ambiguous duplicate rule/target bindings');
        return { page: snapshot, bindings: freeze(structuredClone(bindings)) };
      })();
      cache.set(page, value);
    }
    return value;
  };
  return definitions
    .filter(d => !options.rules || options.rules.includes(d.id))
    .map(definition => ({
      id: definition.id,
      version: '1.0.0',
      name: definition.name,
      description: definition.description,
      effects: 'read-history',
      sweepTargets: 'dom',
      ...(options.wantsPixels ? { wantsPixels: options.wantsPixels } : {}),
      create: () => ({
        async run(input) {
          const badCapture = captureError(input);
          if (badCapture)
            return report(input, definition.id, [
              { ...unknown('A complete, current capture is required'), code: badCapture },
            ]);
          // Without a host collector nothing can be bound; skip copying the capture.
          if (!options.collect) return report(input, definition.id, [bindingRequired()]);
          let data: Awaited<ReturnType<typeof read>>;
          try {
            data = await read(input);
          } catch (error) {
            return report(input, definition.id, [
              {
                ...unknown(`Host evidence is unavailable: ${String(error)}`),
                code: 'UIK_BINDING_INVALID',
              },
            ]);
          }
          const { page } = data;
          if (hash(page.capture) !== hash(input.capture) || hash(page.inspection) !== hash(input.inspection))
            return report(input, definition.id, [
              {
                ...unknown('Capture metadata changed after collection; use a fresh capture'),
                code: 'EVIDENCE_BINDING_MISMATCH',
              },
            ]);
          const resolveCurrent = (target: SentinelTarget) => {
            // The normal crawler never mutates a capture. Direct callers must not make an
            // old cached binding appear current by editing the same RulePage object in place.
            resolve(input, target);
            return resolve(page, target);
          };
          const bindings = data.bindings.filter(b => b.ruleId === definition.id);
          if (!bindings.length) return report(page, definition.id, [bindingRequired()]);
          const checks: RuleCheck[] = bindings.map(binding => {
            let result: RuleAssessment;
            let node: DomNodeEvidence | undefined;
            try {
              node = resolveCurrent(binding.target);
              const ancestors = chain(page, node.id);
              if (binding.applicability === 'no') result = exempt(binding.reason);
              else if (binding.applicability === 'unknown') result = unknown(binding.reason);
              else if (!rendered(page, node))
                result = unknown('The bound target has no complete visible rendering in this capture');
              else if (!definition.moving && ancestors.some(n => n.paint?.motion === 'running'))
                result = unknown('The target is still moving; no stable rendering was measured');
              else {
                const env = page.snapshot.dom!.environment!;
                const viewport: Rect = env.visualViewport
                  ? { x: env.visualViewport.offsetLeft, y: env.visualViewport.offsetTop, ...env.visualViewport }
                  : { x: 0, y: 0, ...env.layoutViewport };
                if (!definition.offscreen && (!node.rect || !contains(viewport, node.rect, 1)))
                  result = { ...unknown('The target needs an on-screen capture'), code: 'OUTSIDE_VIEWPORT' };
                else result = definition.evaluate({ page, node, binding, resolve: resolveCurrent }, binding.data);
              }
            } catch (error) {
              result = {
                ...unknown(
                  error instanceof z.ZodError ? 'Required rule evidence is missing or malformed' : String(error),
                ),
                code: error instanceof EvidenceError ? error.code : 'UIK_EVIDENCE_REQUIRED',
              };
            }
            // An experience review cannot become a defect, even if an evaluator is changed later.
            if (definition.kind === 'review' && result.verdict === 'fail') result = review(result.actual, result.facts);
            return {
              ...result,
              expected: definition.description,
              evidence: [...new Set([page.capture.id, ...binding.evidence, ...result.evidence])],
              ...(node
                ? {
                    target: { captureId: page.capture.id, documentId: page.capture.documentId, nodeId: node.id },
                  }
                : {}),
              facts: {
                ...result.facts,
                kind: definition.kind,
                source: binding.source,
                applicabilityReason: binding.reason,
                binding: asJson(binding.target),
                // Non-control nodes also need distinct selectors for finding deduplication.
                selector: node?.attributes?.id
                  ? `[id=${JSON.stringify(node.attributes.id)}]`
                  : `node:${binding.target.nodeId}`,
              },
            };
          });
          return report(page, definition.id, checks);
        },
      }),
    }));
}

export const sentinelReasons: Record<string, string> = {
  UIK_BINDING_REQUIRED: '需要宿主绑定当前对象的语义与取证记录，尚未完成检查',
  UIK_BINDING_INVALID: '宿主提供的规则绑定有误、歧义或无法读取',
  UIK_TARGET_UNAVAILABLE: '目标或祖先缺失、重复或关系异常',
  UIK_TARGET_STALE: '目标绑定已经过期或快照证据已变化',
  UIK_EVIDENCE_REQUIRED: '缺少该规则要求的语义、视觉或时序证据',
  UIK_CHECK_PASSED: '已完成所声明范围的检查，证据符合预期',
  UIK_DEFECT_OBSERVED: '适用条件和违反事实均有证据支持',
  UIK_EXCEPTION: '已确认属于不适用条件或合法例外',
  UIK_REVIEW_SUGGESTED: '观察到需要设计审查的差异，尚未判定为缺陷',
};
