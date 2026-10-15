import { z } from 'zod';
import type { BrowserEngine, Inspection, ObservationDetails } from '@interaction/browser';
import type { Control, DomEvidence, DomNodeEvidence, Json, Observation } from '@interaction/adapter-playwright';
import type { RuleAssessment, RuleReport } from './types.js';
import { RuleRunner } from './runner.js';
import { sampledOcclusionRule } from './sampled-occlusion.js';

export const scrollRecoveryOptionsSchema = z.object({
  requiredNow: z.object({ reason: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1) }).strict().optional(),
  maxScrolls: z.number().int().min(0).max(32).default(8),
  maxDurationMs: z.number().int().min(100).max(60000).default(15000),
}).strict();
export type ScrollRecoveryOptions = z.input<typeof scrollRecoveryOptionsSchema>;
type MaybeAsync<T> = T | Promise<T>;
export interface ScrollRecoveryClient extends Pick<BrowserEngine, 'captureDetails' | 'observationDetails' | 'scrollProbe' | 'observe'> {
  observation(sessionId: string): MaybeAsync<Observation>;
  session(sessionId: string): MaybeAsync<ReturnType<BrowserEngine['session']>>;
}
interface Container { nodeId: string; left: number; top: number; maxLeft: number; maxTop: number; width: number; height: number }
interface Sample {
  observationId: string; documentId: string; nodeId: string;
  hits: NonNullable<NonNullable<DomNodeEvidence['layout']>['hitSamples']>;
  reachable: boolean; blocked: boolean; containers: Container[]; limitations: string[];
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const binding = (c: Control) => JSON.stringify([c.localId, c.instanceId, c.stableKey, c.identityContext, c.tag, c.role, c.name, c.region, c.reviewAttributes, c.value, c.checked, c.enabled, c.visible]);
const environment = (dom: DomEvidence) => JSON.stringify([dom.environment?.layoutViewport, dom.environment?.devicePixelRatio,
  dom.environment?.visualViewport && [dom.environment.visualViewport.width, dom.environment.visualViewport.height, dom.environment.visualViewport.scale, dom.environment.visualViewport.offsetLeft, dom.environment.visualViewport.offsetTop]]);

function measure(details: ObservationDetails, localId: string): Sample {
  const o = details.observation; const dom = details.snapshot?.dom;
  if (!o.stable || o.gaps.some(g => g.critical) || !dom || dom.spatialVersion !== 1 || dom.nodesTruncated || dom.documentId !== o.documentId || !dom.environment?.scrollingElement) throw new Error('RECOVERY_EVIDENCE_INCOMPLETE');
  const nodes = new Map(dom.nodes.map(n => [n.id, n])); const target = nodes.get(localId);
  if (!target?.layout || !target.rect || target.gaps.length) throw new Error('RECOVERY_TARGET_EVIDENCE_MISSING');
  const hits = target.layout.hitSamples ?? [];
  const viewport = dom.environment.layoutViewport;
  const inView = target.rect.width > 0 && target.rect.height > 0 && target.rect.x < viewport.width && target.rect.y < viewport.height && target.rect.x + target.rect.width > 0 && target.rect.y + target.rect.height > 0;
  if (inView && (hits.length !== 5 || hits.some(h => !h.topNodeId || !nodes.has(h.topNodeId)))) throw new Error('RECOVERY_HIT_GRID_INCOMPLETE');
  const active = o.overlays?.at(-1); const scopeRoot = active ? dom.regionRoots[active.key] : dom.rootId;
  if (!scopeRoot || active && !active.controlIds.includes(localId)) throw new Error('RECOVERY_SCOPE_UNAVAILABLE');
  const containers: Container[] = []; const limitations: string[] = [];
  let parentId = target.parentId; const seen = new Set<string>(); let reachedRoot = target.id === scopeRoot;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId); const node = nodes.get(parentId);
    if (!node?.styles || !node.layout || node.gaps.length) throw new Error('RECOVERY_ANCESTOR_EVIDENCE_MISSING');
    const root = node.id === dom.environment.scrollingElement.nodeId;
    const layout = node.layout; const metrics = dom.environment.scrollingElement;
    const width = root ? metrics.clientWidth : layout.client.width, height = root ? metrics.clientHeight : layout.client.height;
    const maxLeft = Math.max(0, (root ? metrics.scrollWidth : layout.scroll.width) - width);
    const maxTop = Math.max(0, (root ? metrics.scrollHeight : layout.scroll.height) - height);
    const left = root ? metrics.scrollLeft : layout.scroll.left, top = root ? metrics.scrollTop : layout.scroll.top;
    const body = root ? dom.nodes.find(n => n.tag === 'body') : undefined;
    const overflowX = root && node.styles['overflow-x'] === 'visible' ? body?.styles?.['overflow-x'] ?? 'visible' : node.styles['overflow-x'];
    const overflowY = root && node.styles['overflow-y'] === 'visible' ? body?.styles?.['overflow-y'] ?? 'visible' : node.styles['overflow-y'];
    const xAllowed = root ? !['hidden', 'clip'].includes(overflowX) : ['auto', 'scroll'].includes(overflowX);
    const yAllowed = root ? !['hidden', 'clip'].includes(overflowY) : ['auto', 'scroll'].includes(overflowY);
    if (maxLeft > 0 || maxTop > 0) {
      if (node.styles['writing-mode'] !== 'horizontal-tb' || node.styles.direction !== 'ltr') limitations.push(`unsupported-writing-mode:${node.id}`);
      else if (xAllowed && maxLeft > 0 || yAllowed && maxTop > 0) containers.push({ nodeId: node.id, left, top, maxLeft: xAllowed ? maxLeft : 0, maxTop: yAllowed ? maxTop : 0, width, height });
      // Hidden/clip and overflow-visible are not normal scroll paths. Do not
      // extrapolate their geometry to a claim that the target is unreachable.
      else if (node.styles['overflow-x'] !== 'visible' || node.styles['overflow-y'] !== 'visible') limitations.push(`non-user-scrollable-overflow:${node.id}`);
    }
    if (node.id === scopeRoot) { reachedRoot = true; break; }
    parentId = node.parentId;
  }
  if (!reachedRoot) throw new Error('RECOVERY_ANCESTOR_CHAIN_INCOMPLETE');
  return { observationId: o.id, documentId: o.documentId, nodeId: localId, hits, reachable: hits.some(h => h.withinSubtree),
    blocked: inView && hits.length === 5 && hits.every(h => !h.withinSubtree), containers, limitations };
}

/** Active, opt-in rule. Never install this in the passive RuleRunner. */
export const scrollRecoveryRule = {
  id: 'scroll-recovery', version: '1.0.0', name: 'Sampled pointer recovery by controlled scrolling',
  effects: 'controlled-scroll' as const,
  description: 'Probe both axes of captured scroll ancestors, preserve target binding, and attempt to restore original positions. Finite failed probes do not prove permanent blockage.',
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(scrollRecoveryOptionsSchema)),
  run: inspectScrollRecovery,
};

export async function inspectScrollRecovery(reader: ScrollRecoveryClient, inspection: Inspection, localId: string, input: ScrollRecoveryOptions = {}): Promise<RuleReport> {
  const options = scrollRecoveryOptionsSchema.parse(input);
  const start = Date.now(); const source = await reader.captureDetails(inspection.sessionId, inspection.captureId);
  const samples: Sample[] = []; const attempts: { requestId: string; attemptId?: string; beforeId: string; afterId?: string; phase: 'probe' | 'restore'; containerNodeId: string; left: number; top: number; status: string }[] = [];
  let restoration: { status: 'not-needed' | 'restored' | 'failed'; reason?: string } = { status: 'not-needed' };
  let recovered = false; let stopReason = ''; let scrolls = 0;
  const assessment = (verdict: RuleAssessment['verdict'], severity: RuleAssessment['severity'], code: string, actual: string): RuleAssessment => ({
    verdict, severity, code, expected: options.requiredNow?.reason ?? 'Current pointer operability has not been declared', actual,
    evidence: [inspection.captureId, ...(options.requiredNow?.evidence ?? []), ...samples.map(s => `observation:${s.observationId}`), ...attempts.map(a => a.attemptId ? `attempt:${a.attemptId}` : `request:${a.requestId}`)],
    facts: { coverage: 'five-pointer-samples; main-document-light-dom; allowed-scroll-ancestors', recovered, stopReason, restoration: json(restoration), samples: json(samples), attempts: json(attempts) },
  });
  const report = (result: RuleAssessment): RuleReport => ({
    schemaVersion: 1, inspectionId: inspection.id, captureId: inspection.captureId, documentId: source.capture.documentId,
    ruleId: scrollRecoveryRule.id, ruleVersion: scrollRecoveryRule.version,
    selection: { ruleId: scrollRecoveryRule.id, ruleVersion: scrollRecoveryRule.version, options: json(options) as Record<string, Json>, targets: [{ captureId: inspection.captureId, nodeId: localId }] },
    verdict: result.verdict, severity: result.severity,
    checks: [{ ...result, ...(source.details?.snapshot?.dom?.nodes.some(n => n.id === localId) ? { target: { captureId: inspection.captureId, documentId: source.capture.documentId, nodeId: localId } } : {}) }],
  });
  const [screening] = await new RuleRunner([sampledOcclusionRule]).run({ captureDetails: async () => source }, inspection,
    [{ ruleId: sampledOcclusionRule.id, ruleVersion: sampledOcclusionRule.version, targets: [{ captureId: inspection.captureId, nodeId: localId }] }]);
  const first = screening.checks[0];
  if (first.verdict === 'not-applicable') return report(assessment('not-applicable', 'info', first.code, first.actual));
  if (first.verdict === 'unknown' && first.code !== 'SAMPLE_INTERCEPTED') return report(assessment('unknown', 'info', first.code, first.actual));
  let current = source.details!;
  const initialControl = current.observation.controls.find(c => c.localId === localId)!;
  const originalDom = current.snapshot!.dom!;
  let initial: Sample;
  try {
    if ((await reader.observation(inspection.sessionId)).id !== inspection.observationId) throw new Error('RECOVERY_STALE_INSPECTION');
    const saved = measure(current, localId);
    const fresh = await reader.observe(inspection.sessionId);
    const details = await reader.observationDetails(inspection.sessionId, fresh.id);
    const target = details.observation.controls.find(c => c.localId === localId);
    initial = measure(details, localId);
    const shape = ({ observationId: _, ...s }: Sample) => JSON.stringify(s);
    if (!target || binding(target) !== binding(initialControl) || !details.snapshot?.dom || environment(details.snapshot.dom) !== environment(originalDom) ||
      shape(initial) !== shape(saved) || JSON.stringify(details.observation.boundaries) !== JSON.stringify(source.details!.observation.boundaries) ||
      JSON.stringify(details.observation.context) !== JSON.stringify(source.details!.observation.context)) throw new Error('RECOVERY_CHANGED_BEFORE_START');
    current = details; samples.push(saved, initial);
  } catch (error) { return report(assessment('unknown', 'info', 'RECOVERY_UNVERIFIED', String(error))); }
  if (initial.reachable) return report(assessment('pass', 'info', 'SAMPLED_POINT_REACHABLE', 'At least one of the five captured points already reaches the target; whole-control visibility is not established'));
  if (!initial.blocked) return report(assessment('unknown', 'info', 'RECOVERY_TARGET_NOT_SAMPLED', 'The target is not currently covered by the five-point grid'));
  if (!initial.containers.length) {
    if (initial.limitations.length) return report(assessment('unknown', 'warning', 'RECOVERY_PATHS_UNVERIFIED', initial.limitations.join(', ')));
    return report(assessment(options.requiredNow ? 'fail' : 'unknown', options.requiredNow ? 'error' : 'warning', 'BLOCKED_WITHOUT_SCROLL_PATH',
      'All five captured points are intercepted and no user-scrollable ancestor has a nonzero range in the current scope. This does not prove every pixel or other interaction path is blocked'));
  }
  const originalPositions = initial.containers;
  const dirty = new Set<string>();
  let mutationUnverified = false;
  const stableShape = (sample: Sample) => JSON.stringify(sample.containers.map(({ left: _, top: __, ...c }) => c));
  const verify = (next: ObservationDetails) => {
    const target = next.observation.controls.find(c => c.localId === localId);
    if (!target || binding(target) !== binding(initialControl) || next.observation.documentId !== initial.documentId) throw new Error('RECOVERY_TARGET_REPLACED_OR_REBOUND');
    const oldNode = originalDom.nodes.find(n => n.id === localId)!;
    const newNode = next.snapshot?.dom?.nodes.find(n => n.id === localId);
    if (!newNode || newNode.parentId !== oldNode.parentId || newNode.rect?.width !== oldNode.rect?.width || newNode.rect?.height !== oldNode.rect?.height) throw new Error('RECOVERY_TARGET_GEOMETRY_CHANGED');
    if (!next.snapshot?.dom || environment(next.snapshot.dom) !== environment(originalDom) ||
      JSON.stringify(next.observation.boundaries) !== JSON.stringify(source.details!.observation.boundaries) ||
      JSON.stringify(next.observation.context) !== JSON.stringify(source.details!.observation.context)) throw new Error('RECOVERY_CONTEXT_CHANGED');
    const sampled = measure(next, localId);
    if (stableShape(sampled) !== stableShape(initial)) throw new Error('RECOVERY_SCROLL_GEOMETRY_CHANGED');
    return sampled;
  };
  const scroll = async (containerNodeId: string, left: number, top: number, phase: 'probe' | 'restore') => {
    const now = measure(current, localId).containers.find(c => c.nodeId === containerNodeId);
    if (!now) throw new Error('RECOVERY_CONTAINER_MISSING');
    if (Math.abs(now.left - left) <= .5 && Math.abs(now.top - top) <= .5) return;
    // A rejected transport call may still have executed. Never certify restore
    // using the pre-action snapshot when its post-action state is unknown.
    dirty.add(containerNodeId); mutationUnverified = true;
    const intent: typeof attempts[number] = { requestId: crypto.randomUUID(), beforeId: current.observation.id, phase, containerNodeId, left, top, status: 'unknown' };
    attempts.push(intent);
    const attempt = await reader.scrollProbe(inspection.sessionId, current.observation.id, localId, {
      documentId: initial.documentId, containerNodeId, left, top, expectedLeft: now.left, expectedTop: now.top,
    }, intent.requestId);
    Object.assign(intent, { attemptId: attempt.id, beforeId: attempt.beforeId, afterId: attempt.afterId, status: attempt.status });
    if (!attempt.afterId) throw new Error('RECOVERY_AFTER_EVIDENCE_MISSING');
    const next = await reader.observationDetails(inspection.sessionId, attempt.afterId);
    current = next;
    const sampled = verify(next); samples.push(sampled); mutationUnverified = false;
    if (attempt.status !== 'succeeded') throw new Error(`RECOVERY_SCROLL_${attempt.status.toUpperCase()}`);
    if (phase === 'probe' && sampled.reachable) recovered = true;
  };
  try {
    search: for (const container of originalPositions) {
      const candidates = [
        ...(container.maxTop > 0 ? [
          [container.left, Math.max(0, container.top - container.height * .6)],
          [container.left, Math.min(container.maxTop, container.top + container.height * .6)],
          [container.left, 0], [container.left, container.maxTop],
        ] : []),
        ...(container.maxLeft > 0 ? [
          [Math.max(0, container.left - container.width * .6), container.top],
          [Math.min(container.maxLeft, container.left + container.width * .6), container.top],
          [0, container.top], [container.maxLeft, container.top],
        ] : []),
      ];
      const visited = new Set([JSON.stringify([container.left, container.top])]);
      for (const [left, top] of candidates) {
        const key = JSON.stringify([left, top]); if (visited.has(key)) continue; visited.add(key);
        if (scrolls >= options.maxScrolls || Date.now() - start >= options.maxDurationMs) { stopReason = 'probe_budget_exhausted'; break search; }
        const session = await reader.session(inspection.sessionId);
        // Reserve one restore action for every potentially changed container.
        const reserve = new Set([...dirty, container.nodeId]).size;
        if (session.options.maxActions - session.actionCount < reserve + 1) { stopReason = 'session_budget_reserved_for_restore'; break search; }
        scrolls++;
        await scroll(container.nodeId, left, top, 'probe');
        if (recovered) { stopReason = 'recovered'; break search; }
      }
    }
    stopReason ||= 'sampled_positions_exhausted';
  } catch (error) { stopReason = String(error); }
  finally {
    if (dirty.size) {
      try {
        // No fresh-state substitution on failure: stale/replaced targets must
        // not be manipulated in an attempt to restore an unrelated live page.
        if (mutationUnverified) throw new Error('RECOVERY_LAST_MUTATION_UNVERIFIED');
        verify(current);
        for (const container of originalPositions.filter(c => dirty.has(c.nodeId))) await scroll(container.nodeId, container.left, container.top, 'restore');
        const final = measure(current, localId);
        if (originalPositions.some(c => { const actual = final.containers.find(n => n.nodeId === c.nodeId); return !actual || Math.abs(actual.left - c.left) > .5 || Math.abs(actual.top - c.top) > .5; })) throw new Error('RECOVERY_RESTORE_POSITION_MISMATCH');
        restoration = { status: 'restored' };
      } catch (error) { restoration = { status: 'failed', reason: String(error) }; }
    }
  }
  if (restoration.status === 'failed') return report(assessment('unknown', 'warning', 'SCROLL_RESTORE_FAILED', 'Probe results are retained, but original scroll positions could not be verified as restored'));
  if (recovered) return report(assessment(options.requiredNow ? 'fail' : 'unknown', 'warning', 'SCROLL_RECOVERED', 'The same target became reachable at a sampled point after controlled scrolling; original positions were restored'));
  return report(assessment('unknown', 'warning', 'SCROLL_RECOVERY_UNVERIFIED', 'No sampled recovery was verified within this investigation; untested positions and other recovery paths remain unknown'));
}
