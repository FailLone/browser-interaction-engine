import { z } from 'zod';
import { canonical, type Control, type DomEvidence, type Json } from '@interaction/adapter-playwright';
import type { Inspection } from '@interaction/browser';
import type { CaptureReader, RuleCheck, RuleReport } from './types.js';
import { RuleRunner } from './runner.js';
import { clippedControlOptionsSchema, clippedControlRule } from './clipped-control.js';

export const observedClippingOptionsSchema = z.object({
  rule: clippedControlOptionsSchema.prefault({}),
  maxTracked: z.number().int().min(1).max(1000).default(500),
}).strict();
export type ObservedClippingOptions = z.input<typeof observedClippingOptionsSchema>;
export const observedClippingRule = {
  id: 'observed-clipping', version: '1.0.0', name: 'Clipping across exploration observations', effects: 'read-history' as const,
  description: 'Track clipping evidence for the same control and scope without performing or waiting for scrolling. Missing or changed bindings never resolve an issue.',
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(observedClippingOptionsSchema)),
};
type Sample = { instanceId: string; binding: string; captureId: string; scroll: { nodeId: string; left: number; top: number }[] };
type Track = { id: string; key: string; identityId: string; firstCaptureId: string; revision: number;
  lifecycle: 'pending' | 'suspected' | 'confirmed' | 'resolved' | 'unverified'; warning: boolean; sample?: Sample; evidence: string[] };
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
function sample(c: Control, dom: DomEvidence, captureId: string): Sample {
  const nodes = new Map(dom.nodes.map(n => [n.id, n])); const node = nodes.get(c.localId)!;
  const ids = [...new Set([...(node.layout?.scrollAncestorIds ?? []), ...(dom.environment?.scrollingElement ? [dom.environment.scrollingElement.nodeId] : [])])];
  return { instanceId: c.instanceId, captureId,
    binding: canonical([c.stableKey, c.identityContext, c.role, c.tag, c.name, c.region, c.reviewAttributes, c.value, c.checked, c.selected, c.enabled, c.visible, c.expanded, node.parentId]),
    scroll: ids.flatMap(id => { const n = nodes.get(id), root = dom.environment?.scrollingElement;
      return n?.layout ? [{ nodeId: id, left: root?.nodeId === id ? root.scrollLeft : n.layout.scroll.left, top: root?.nodeId === id ? root.scrollTop : n.layout.scroll.top }] : []; }),
  };
}

/** Feed one session's saved inspections in sequence. No browser operations exist here. */
export class ClippedControlTracker {
  private readonly options: z.output<typeof observedClippingOptionsSchema>;
  private tracks = new Map<string, Track>();
  private last?: { sessionId: string; sequence: number; inspectionId: string; report: RuleReport };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(options: ObservedClippingOptions = {}) { this.options = observedClippingOptionsSchema.parse(options); }
  run(reader: CaptureReader, inspection: Inspection): Promise<RuleReport> {
    const task = structuredClone(inspection);
    const work = this.queue.then(() => this.process(reader, task));
    this.queue = work.catch(() => {}); return work;
  }
  private async process(reader: CaptureReader, inspection: Inspection): Promise<RuleReport> {
    if (this.last) {
      if (this.last.sessionId !== inspection.sessionId) throw new Error('TRACKER_SESSION_MISMATCH');
      if (this.last.inspectionId === inspection.id) return structuredClone(this.last.report);
      if (inspection.sequence <= this.last.sequence) throw new Error('TRACKER_OUT_OF_ORDER');
    }
    const source = structuredClone(await reader.captureDetails(inspection.sessionId, inspection.captureId));
    const [screened] = await new RuleRunner([clippedControlRule]).run({ captureDetails: async () => source }, inspection,
      [{ ruleId: clippedControlRule.id, ruleVersion: clippedControlRule.version, options: json(this.options.rule) as Record<string, Json> }]);
    const o = source.details?.observation, dom = source.details?.snapshot?.dom;
    const scenario = o && canonical([o.documentId, o.url, o.context, inspection.focus.scopeId, inspection.focus.regionKey]);
    const tracks = structuredClone(this.tracks), visited = new Set<string>(), checks: RuleCheck[] = [];
    const revise = (track: Track, check: RuleCheck, current?: Sample) => {
      const prior = track.sample;
      const changes = current && prior ? current.scroll.flatMap(after => {
        const before = prior.scroll.find(s => s.nodeId === after.nodeId);
        return before && (Math.abs(before.left - after.left) > .5 || Math.abs(before.top - after.top) > .5) ? [{ nodeId: after.nodeId, before, after }] : [];
      }) : [];
      track.revision++; track.sample = current;
      track.evidence = [...new Set([...track.evidence, inspection.captureId])].slice(-32);
      checks.push({ ...check, evidence: [...new Set([track.firstCaptureId, ...track.evidence, ...check.evidence])], facts: {
        ...check.facts, identityId: track.identityId, issueId: track.id, revision: track.revision, lifecycle: track.lifecycle,
        firstCaptureId: track.firstCaptureId, attribution: 'observed_during_interval', ancestorScrollChanges: json(changes),
        ...(prior ? { previousCaptureId: prior.captureId } : {}),
      } });
    };
    const unavailable = (track: Track, code: string, actual: string, target?: RuleCheck['target']): RuleCheck => ({
      verdict: 'unknown', severity: track.warning ? 'warning' : 'info', code, actual, target,
      expected: 'Comparable clipping evidence of the same control in the original scope', evidence: [inspection.captureId],
    });
    for (const check of screened.checks) {
      const c = o?.controls.find(c => c.localId === check.target?.nodeId);
      if (!c || !o || !dom) { checks.push(check); continue; }
      const key = canonical([scenario, c.identityId]); const track = tracks.get(key);
      if (track) visited.add(key);
      const reliableIdentity = c.identityId && !c.hypothesisId && o.controls.filter(n => n.identityId === c.identityId).length === 1;
      const measurable = reliableIdentity && ['CONTROL_BOX_UNCLIPPED', 'SCROLL_CLIP_RECHECK_PENDING', 'CONTROL_CLIPPING_SUSPECTED', 'CLIPPING_REQUIREMENT_FAILED'].includes(check.code);
      if (!measurable) {
        if (track && track.lifecycle !== 'resolved') {
          track.lifecycle = 'unverified';
          revise(track, unavailable(track, 'CLIPPING_RECHECK_UNAVAILABLE', reliableIdentity ? check.actual : 'IDENTITY_UNCERTAIN', check.target));
        } else checks.push(check);
        continue;
      }
      const current = sample(c, dom, inspection.captureId);
      if (!track && check.verdict === 'pass') { checks.push(check); continue; }
      if (!track && tracks.size >= this.options.maxTracked) throw new Error('TRACKER_CAPACITY_EXCEEDED');
      const active: Track = track ?? { id: crypto.randomUUID(), key, identityId: c.identityId!, firstCaptureId: inspection.captureId,
        lifecycle: 'pending', warning: false, revision: 0, evidence: [] };
      if (!track) { tracks.set(key, active); visited.add(key); }
      const prior = active.sample;
      if (track && (!prior || prior.instanceId !== current.instanceId || prior.binding !== current.binding)) {
        active.lifecycle = 'unverified';
        revise(active, unavailable(active, 'CLIPPING_BASELINE_CHANGED', 'Instance or business binding changed, or the preceding evidence was unavailable; establish a fresh baseline', check.target), current);
        continue;
      }
      active.lifecycle = check.verdict === 'pass' ? 'resolved' : check.verdict === 'fail' ? 'confirmed' : check.severity === 'warning' ? 'suspected' : 'pending';
      active.warning ||= check.severity === 'warning' || check.severity === 'error';
      if (active.warning && active.lifecycle === 'pending') {
        active.lifecycle = 'unverified';
        revise(active, { ...check, severity: 'warning', actual: 'The target is now clipped by a scrolling viewport; full recovery of the prior warning is still unverified' }, current);
        continue;
      }
      // Repeated clipping, an action label or a scroll endpoint never adds an error.
      revise(active, check.verdict === 'pass' ? { ...check, code: 'CLIPPING_NO_LONGER_OBSERVED',
        actual: 'The same control now fits the captured clipping bounds; changes in scrolling or layout are interval evidence, not a causal proof' } : check, current);
    }
    for (const track of tracks.values()) if (!visited.has(track.key) && track.lifecycle !== 'resolved') {
      track.lifecycle = 'unverified';
      revise(track, unavailable(track, 'CLIPPING_TARGET_UNOBSERVED', 'The target, original context or usable capture is absent; its issue remains unresolved'));
    }
    const report: RuleReport = { ...screened, ruleId: observedClippingRule.id, ruleVersion: observedClippingRule.version,
      selection: { ruleId: observedClippingRule.id, ruleVersion: observedClippingRule.version, options: json(this.options) as Record<string, Json> }, checks,
      verdict: checks.some(c => c.verdict === 'fail') ? 'fail' : checks.some(c => c.verdict === 'unknown') ? 'unknown' : checks.some(c => c.verdict === 'pass') ? 'pass' : 'not-applicable',
      severity: checks.some(c => c.severity === 'error') ? 'error' : checks.some(c => c.severity === 'warning') ? 'warning' : 'info' };
    this.tracks = tracks; this.last = { sessionId: inspection.sessionId, sequence: inspection.sequence, inspectionId: inspection.id, report: structuredClone(report) };
    return report;
  }
}
