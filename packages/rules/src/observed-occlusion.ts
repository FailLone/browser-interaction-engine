import { z } from 'zod';
import { canonical, type Control, type DomEvidence, type DomNodeEvidence, type Json, type Observation } from '@interaction/adapter-playwright';
import type { Inspection } from '@interaction/browser';
import type { CaptureReader, RuleAssessment, RuleCheck, RuleReport } from './types.js';
import { RuleRunner } from './runner.js';
import { sampledOcclusionRule } from './sampled-occlusion.js';

export const observedOcclusionOptionsSchema = z.object({
  /** Explicit host requirements for named controls. Provider proposals are not
   * accepted here and do not automatically become effective requirements. */
  requirements: z.array(z.object({
    identityId: z.string().min(1), kind: z.literal('sampled-pointer-at-observed-position'),
    reason: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1),
  }).strict()).max(1000).default([]),
  maxTracked: z.number().int().min(1).max(1000).default(500),
}).strict().refine(o => new Set(o.requirements.map(r => r.identityId)).size === o.requirements.length, 'Each identity may have one requirement');
export type ObservedOcclusionOptions = z.input<typeof observedOcclusionOptionsSchema>;
type Lifecycle = 'suspected' | 'confirmed' | 'resolved' | 'unverified';
type ScrollPosition = { nodeId: string; left: number; top: number; width: number; height: number; scrollWidth: number; scrollHeight: number; overflowX: string; overflowY: string };
interface Sample {
  captureId: string; observationId: string; instanceId: string; binding: string; geometry: string;
  reachable: boolean; blocked: boolean; scroll: ScrollPosition[];
  hits: NonNullable<NonNullable<DomNodeEvidence['layout']>['hitSamples']>;
}
interface Track {
  id: string; key: string; identityId: string; lifecycle: Lifecycle; revision: number;
  firstCaptureId: string; evidence: string[]; confirmedAt?: string; sample?: Sample;
}
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const shape = (s: Sample) => canonical(s.scroll.map(({ left: _, top: __, ...c }) => c));
const binding = (c: Control) => canonical([c.stableKey, c.identityContext, c.tag, c.role, c.name, c.region, c.reviewAttributes,
  c.value, c.checked, c.selected, c.enabled, c.visible, c.expanded]);

function sample(inspection: Inspection, o: Observation, dom: DomEvidence, control: Control): Sample {
  const nodes = new Map(dom.nodes.map(n => [n.id, n])); const node = nodes.get(control.localId);
  if (!node?.layout || !node.rect || node.gaps.length || !dom.environment || dom.spatialVersion !== 1) throw new Error('TARGET_EVIDENCE_MISSING');
  const hits = node.layout.hitSamples;
  if (hits?.length !== 5 || hits.some(h => !h.topNodeId || !nodes.has(h.topNodeId))) throw new Error('HIT_GRID_INCOMPLETE');
  const active = o.overlays?.at(-1);
  if (active && !active.controlIds.includes(control.localId)) throw new Error('OUTSIDE_ACTIVE_SCOPE');
  const root = active ? dom.regionRoots[active.key] : dom.rootId;
  let ancestor = node; const seen = new Set<string>();
  while (ancestor.id !== root) {
    if (seen.has(ancestor.id) || !ancestor.parentId || !nodes.has(ancestor.parentId)) throw new Error('ANCESTOR_CHAIN_INCOMPLETE');
    seen.add(ancestor.id); ancestor = nodes.get(ancestor.parentId)!;
    if (ancestor.gaps.length) throw new Error('ANCESTOR_EVIDENCE_INCOMPLETE');
  }
  seen.add(ancestor.id);
  // An offscreen/clipped target is not proof that an obstruction disappeared.
  const r = node.rect, env = dom.environment;
  let left = 0, top = 0, right = env.layoutViewport.width, bottom = env.layoutViewport.height;
  for (const id of node.layout.clipAncestorIds) {
    if (id === env.scrollingElement?.nodeId) continue;
    const p = nodes.get(id);
    if (!p?.rect || !p.styles || !p.layout || p.gaps.length) throw new Error('CLIP_EVIDENCE_MISSING');
    if (['auto', 'scroll', 'hidden', 'clip'].includes(p.styles['overflow-x'])) { left = Math.max(left, p.rect.x + p.layout.client.left); right = Math.min(right, p.rect.x + p.layout.client.left + p.layout.client.width); }
    if (['auto', 'scroll', 'hidden', 'clip'].includes(p.styles['overflow-y'])) { top = Math.max(top, p.rect.y + p.layout.client.top); bottom = Math.min(bottom, p.rect.y + p.layout.client.top + p.layout.client.height); }
    if (p.styles['clip-path'] !== 'none' || /paint/.test(p.styles.contain)) throw new Error('COMPLEX_CLIP_UNVERIFIED');
  }
  if (r.width <= 0 || r.height <= 0 || r.x < left || r.y < top || r.x + r.width > right || r.y + r.height > bottom) throw new Error('TARGET_NOT_FULLY_IN_VIEW');
  const scroll = node.layout.scrollAncestorIds.filter(id => seen.has(id)).map(id => {
    const n = nodes.get(id);
    if (!n?.layout || !n.styles || n.gaps.length) throw new Error('SCROLL_EVIDENCE_MISSING');
    const root = env.scrollingElement?.nodeId === id ? env.scrollingElement : undefined;
    return { nodeId: id, left: root?.scrollLeft ?? n.layout.scroll.left, top: root?.scrollTop ?? n.layout.scroll.top,
      width: root?.clientWidth ?? n.layout.client.width, height: root?.clientHeight ?? n.layout.client.height,
      scrollWidth: root?.scrollWidth ?? n.layout.scroll.width, scrollHeight: root?.scrollHeight ?? n.layout.scroll.height,
      overflowX: n.styles['overflow-x'], overflowY: n.styles['overflow-y'] };
  });
  return { captureId: inspection.captureId, observationId: o.id, instanceId: control.instanceId, binding: binding(control),
    geometry: canonical([node.parentId, r.width, r.height, node.styles?.position, node.styles?.transform,
      env.layoutViewport, env.devicePixelRatio, env.visualViewport && [env.visualViewport.width, env.visualViewport.height, env.visualViewport.scale, env.visualViewport.offsetLeft, env.visualViewport.offsetTop]]),
    reachable: hits.some(h => h.withinSubtree), blocked: hits.every(h => !h.withinSubtree), scroll, hits };
}

export const observedOcclusionRule = {
  id: 'observed-occlusion', version: '1.0.0', name: 'Occlusion across exploration observations', effects: 'read-history' as const,
  description: 'Follow logical controls in ordered historical captures. Never scroll, observe the live page, or wait for exploration. Repeated obstruction alone does not establish an error.',
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(observedOcclusionOptionsSchema)),
};

/** One ordered consumer per session. State is bounded; reports retain immutable revisions. */
export class ObservedOcclusionTracker {
  private readonly options: z.output<typeof observedOcclusionOptionsSchema>;
  private tracks = new Map<string, Track>();
  private last?: { sessionId: string; sequence: number; inspectionId: string; report: RuleReport };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(options: ObservedOcclusionOptions = {}) { this.options = observedOcclusionOptionsSchema.parse(options); }
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
    const [screened] = await new RuleRunner([sampledOcclusionRule]).run({ captureDetails: async () => source }, inspection,
      [{ ruleId: sampledOcclusionRule.id, ruleVersion: sampledOcclusionRule.version }]);
    const o = source.details?.observation, dom = source.details?.snapshot?.dom;
    // Work on a copy: a capacity or evidence failure cannot partly commit revisions.
    const tracks = structuredClone(this.tracks); const checks: RuleCheck[] = []; const visited = new Set<string>();
    const scenario = o && canonical([o.documentId, o.url, o.context, inspection.focus.scopeId, inspection.focus.regionKey]);
    const revise = (track: Track, result: RuleAssessment, current?: Sample, target?: RuleCheck['target'], moved: string[] = []) => {
      const prior = track.sample;
      track.revision++;
      track.evidence = [...new Set([...track.evidence, inspection.captureId])].slice(-32);
      if (current) track.sample = current;
      checks.push({ ...result, target, evidence: [...new Set([track.firstCaptureId, ...(track.confirmedAt ? [track.confirmedAt] : []), ...track.evidence, ...result.evidence])],
        facts: { ...result.facts, issueId: track.id, identityId: track.identityId, lifecycle: track.lifecycle, revision: track.revision,
          firstCaptureId: track.firstCaptureId, ...(track.confirmedAt ? { confirmedAt: track.confirmedAt } : {}),
          changedScrollContainers: moved, attribution: 'observed_during_interval', coverage: 'five-pointer-samples; fully-in-view; not-whole-control',
          ...(prior && current ? { comparison: json({ beforeCaptureId: prior.captureId, beforeObservationId: prior.observationId,
            sameInstance: prior.instanceId === current.instanceId, scrollChanges: moved.map(nodeId => ({ nodeId,
              before: prior.scroll.find(c => c.nodeId === nodeId), after: current.scroll.find(c => c.nodeId === nodeId) })) }) } : {}),
          ...(current ? { sample: json(current) } : {}) } });
    };
    for (const check of screened.checks) {
      const control = o?.controls.find(c => c.localId === check.target?.nodeId);
      if (!control || !dom || !o) { checks.push(check); continue; }
      const key = canonical([scenario, control.identityId]);
      const track = tracks.get(key);
      if (track) visited.add(key);
      const result = (verdict: RuleAssessment['verdict'], severity: RuleAssessment['severity'], code: string, actual: string): RuleAssessment => ({
        verdict, severity, code, actual, expected: 'A comparable five-point pointer sample of the same logical control', evidence: [inspection.captureId],
      });
      let current: Sample | undefined; let reason = check.code;
      if (!control.identityId || control.hypothesisId || o.controls.filter(c => c.identityId === control.identityId).length !== 1) reason = 'IDENTITY_UNCERTAIN';
      else if (check.verdict === 'pass' || check.code === 'SAMPLE_INTERCEPTED') {
        try { current = sample(inspection, o, dom, control); } catch (error) { reason = String(error); }
      }
      if (!current) {
        if (track && track.lifecycle !== 'resolved') {
          track.lifecycle = 'unverified'; track.sample = undefined;
          revise(track, result('unknown', 'warning', 'OCCLUSION_RECHECK_UNAVAILABLE', reason), undefined, check.target);
        } else checks.push({ ...check, ...(reason !== check.code ? { verdict: 'unknown' as const, code: 'OCCLUSION_RECHECK_UNAVAILABLE', actual: reason } : {}) });
        continue;
      }
      if (!track) {
        if (current.reachable) { checks.push({ ...result('pass', 'info', 'OBSERVED_POINT_REACHABLE', 'At least one captured point reaches the target'), target: check.target }); continue; }
        if (tracks.size >= this.options.maxTracked) throw new Error('TRACKER_CAPACITY_EXCEEDED');
        const created: Track = { id: crypto.randomUUID(), key, identityId: control.identityId!, lifecycle: 'suspected', revision: 0,
          firstCaptureId: inspection.captureId, evidence: [], sample: current };
        tracks.set(key, created); visited.add(key);
        revise(created, result('unknown', 'warning', 'OCCLUSION_SUSPECTED', 'Five points are blocked; later comparable evidence is needed'), current, check.target);
        continue;
      }
      const prior = track.sample;
      const comparable = prior && prior.instanceId === current.instanceId && prior.binding === current.binding && prior.geometry === current.geometry && shape(prior) === shape(current);
      if (!comparable) {
        track.lifecycle = 'unverified';
        revise(track, result('unknown', 'warning', 'OCCLUSION_BASELINE_CHANGED', prior?.instanceId !== current.instanceId && prior ? 'Logical identity matched, but its DOM instance was rebuilt; no scroll recovery is inferred' : 'Comparable target, geometry or prior evidence is missing; establish a new baseline'), current, check.target);
        continue;
      }
      const moved = current.scroll.filter((c, i) => Math.abs(c.left - prior.scroll[i].left) > .5 || Math.abs(c.top - prior.scroll[i].top) > .5).map(c => c.nodeId);
      const requirement = this.options.requirements.find(r => r.identityId === control.identityId);
      if (current.reachable) {
        track.lifecycle = 'resolved';
        revise(track, result('pass', 'info', moved.length ? 'OCCLUSION_RECOVERED_AFTER_SCROLL' : 'OCCLUSION_NO_LONGER_OBSERVED',
          moved.length ? 'The same target has a reachable sample after an ancestor scroll position changed; causality is not established' : 'The same target now has a reachable sample; the original obstruction remains historical evidence'), current, check.target, moved);
      } else if (requirement && prior.blocked && moved.length) {
        track.lifecycle = 'confirmed'; track.confirmedAt = inspection.captureId;
        revise(track, { ...result('fail', 'error', 'OBSERVED_POINTER_REQUIREMENT_FAILED', 'All five points remain blocked after a relevant scroll. The declared requirement at this observed position failed; permanent unreachability is not established'),
          expected: requirement.reason, evidence: [inspection.captureId, ...requirement.evidence] }, current, check.target, moved);
      } else {
        // A confirmed failure is retained while the same sampled failure persists.
        const confirmed = track.lifecycle === 'confirmed'; track.lifecycle = confirmed ? 'confirmed' : 'suspected';
        revise(track, result(confirmed ? 'fail' : 'unknown', confirmed ? 'error' : 'warning', 'OCCLUSION_STILL_OBSERVED',
          'The obstruction remains at sampled points. Repetition or a scroll endpoint alone is not proof of permanent blockage'), current, check.target, moved);
      }
    }
    for (const track of tracks.values()) if (!visited.has(track.key) && track.lifecycle !== 'resolved') {
      track.lifecycle = 'unverified'; track.sample = undefined;
      revise(track, { verdict: 'unknown', severity: 'warning', code: 'OCCLUSION_TARGET_UNOBSERVED', expected: 'Comparable evidence in the original scope and business context',
        actual: 'The original target or inspection context is absent or unavailable; its issue is not resolved', evidence: [inspection.captureId] });
    }
    const report: RuleReport = { schemaVersion: 1, inspectionId: inspection.id, captureId: inspection.captureId, documentId: source.capture.documentId,
      ruleId: observedOcclusionRule.id, ruleVersion: observedOcclusionRule.version,
      selection: { ruleId: observedOcclusionRule.id, ruleVersion: observedOcclusionRule.version, options: json(this.options) as Record<string, Json> }, checks,
      verdict: checks.some(c => c.verdict === 'fail') ? 'fail' : checks.some(c => c.verdict === 'unknown') ? 'unknown' : checks.some(c => c.verdict === 'pass') ? 'pass' : 'not-applicable',
      severity: checks.some(c => c.severity === 'error') ? 'error' : checks.some(c => c.severity === 'warning') ? 'warning' : 'info' };
    this.tracks = tracks; this.last = { sessionId: inspection.sessionId, sequence: inspection.sequence, inspectionId: inspection.id, report: structuredClone(report) };
    return report;
  }
}
