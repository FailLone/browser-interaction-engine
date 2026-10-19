import { currentCaptureOnly, findingSnapshot, observationStatus } from './finding-history.js';
import { hasRelevantGaps } from './evidence-dependencies.js';
import { z } from 'zod';
import { canonical } from './util.js';
import { type Control, type DomEvidence, type DomNodeEvidence, type Json, type Observation } from './types.js';
import type { Inspection, RulePage, RuleAssessment, RuleCheck, RuleReport } from './types.js';
import { RuleRunner } from './runner.js';
import { sampledOcclusionRule } from './sampled-occlusion.js';

export const observedOcclusionOptionsSchema = z
  .object({
    /** Explicit host requirements for named controls. Provider proposals are not
     * accepted here and do not automatically become effective requirements. */
    requirements: z
      .array(
        z
          .object({
            identityId: z.string().min(1),
            kind: z.literal('sampled-pointer-at-observed-position'),
            reason: z.string().trim().min(1),
            evidence: z.array(z.string().trim().min(1)).min(1),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    maxTracked: z.number().int().min(1).max(1000).default(500),
  })
  .strict()
  .refine(
    o => new Set(o.requirements.map(r => r.identityId)).size === o.requirements.length,
    'Each identity may have one requirement',
  );
export type ObservedOcclusionOptions = z.input<typeof observedOcclusionOptionsSchema>;
type Lifecycle = 'suspected' | 'confirmed' | 'resolved' | 'unverified';
type ScrollPosition = {
  nodeId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
  overflowX: string;
  overflowY: string;
};
interface Sample {
  captureId: string;
  observationId: string;
  instanceId: string;
  binding: string;
  geometry: string;
  reachable: boolean;
  blocked: boolean;
  scroll: ScrollPosition[];
  hits: NonNullable<NonNullable<DomNodeEvidence['layout']>['hitSamples']>;
}
interface Track {
  id: string;
  key: string;
  identityId: string;
  lifecycle: Lifecycle;
  revision: number;
  firstCaptureId: string;
  label: string;
  lastObservedFinding?: Json;
  evidence: string[];
  confirmedAt?: string;
  sample?: Sample;
  findingSample?: Sample;
}
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const shape = (s: Sample) => canonical(s.scroll.map(({ left: _, top: __, ...c }) => c));
const binding = (c: Control) =>
  canonical([
    c.stableKey,
    c.identityContext,
    c.tag,
    c.role,
    c.name,
    c.region,
    c.reviewAttributes,
    c.value,
    c.checked,
    c.selected,
    c.enabled,
    c.visible,
    c.expanded,
  ]);
const comparableSamples = (prior: Sample | undefined, current: Sample) =>
  prior &&
  prior.instanceId === current.instanceId &&
  prior.binding === current.binding &&
  prior.geometry === current.geometry &&
  shape(prior) === shape(current);

function sample(inspection: Inspection, o: Observation, dom: DomEvidence, control: Control): Sample {
  const nodes = new Map(dom.nodes.map(n => [n.id, n]));
  const node = nodes.get(control.localId);
  if (!node?.layout || !node.rect || hasRelevantGaps(node) || !dom.environment || dom.spatialVersion !== 1)
    throw new Error('TARGET_EVIDENCE_MISSING');
  const hits = node.layout.hitSamples;
  if (hits?.length !== 5 || hits.some(h => !h.topNodeId || !nodes.has(h.topNodeId)))
    throw new Error('HIT_GRID_INCOMPLETE');
  const active = o.overlays?.at(-1);
  if (active && !active.controlIds.includes(control.localId)) throw new Error('OUTSIDE_ACTIVE_SCOPE');
  const root = active ? dom.regionRoots[active.key] : dom.rootId;
  let ancestor = node;
  const seen = new Set<string>();
  while (ancestor.id !== root) {
    if (seen.has(ancestor.id) || !ancestor.parentId || !nodes.has(ancestor.parentId))
      throw new Error('ANCESTOR_CHAIN_INCOMPLETE');
    seen.add(ancestor.id);
    ancestor = nodes.get(ancestor.parentId)!;
    if (hasRelevantGaps(ancestor)) throw new Error('ANCESTOR_EVIDENCE_INCOMPLETE');
  }
  seen.add(ancestor.id);
  // An offscreen/clipped target is not proof that an obstruction disappeared.
  const r = node.rect,
    env = dom.environment;
  let left = 0,
    top = 0,
    right = env.layoutViewport.width,
    bottom = env.layoutViewport.height;
  if (r.width > right || r.height > bottom) throw new Error('TARGET_EXCEEDS_VIEWPORT');
  for (const id of node.layout.clipAncestorIds) {
    if (id === env.scrollingElement?.nodeId) continue;
    const p = nodes.get(id);
    if (!p?.rect || !p.styles || !p.layout || hasRelevantGaps(p)) throw new Error('CLIP_EVIDENCE_MISSING');
    // Compare against each container's own capacity, not its current viewport
    // intersection: an ancestor scroll can reveal a partly offscreen container.
    if (
      (['auto', 'scroll', 'hidden', 'clip'].includes(p.styles['overflow-x']) && r.width > p.layout.client.width) ||
      (['auto', 'scroll', 'hidden', 'clip'].includes(p.styles['overflow-y']) && r.height > p.layout.client.height)
    )
      throw new Error('TARGET_EXCEEDS_CLIP_BOUNDS');
    if (['auto', 'scroll', 'hidden', 'clip'].includes(p.styles['overflow-x'])) {
      left = Math.max(left, p.rect.x + p.layout.client.left);
      right = Math.min(right, p.rect.x + p.layout.client.left + p.layout.client.width);
    }
    if (['auto', 'scroll', 'hidden', 'clip'].includes(p.styles['overflow-y'])) {
      top = Math.max(top, p.rect.y + p.layout.client.top);
      bottom = Math.min(bottom, p.rect.y + p.layout.client.top + p.layout.client.height);
    }
    if (p.styles['clip-path'] !== 'none' || /paint/.test(p.styles.contain)) throw new Error('COMPLEX_CLIP_UNVERIFIED');
  }
  if (r.width <= 0 || r.height <= 0 || r.x < left || r.y < top || r.x + r.width > right || r.y + r.height > bottom)
    throw new Error('TARGET_NOT_FULLY_IN_VIEW');
  const scroll = node.layout.scrollAncestorIds
    .filter(id => seen.has(id))
    .map(id => {
      const n = nodes.get(id);
      if (!n?.layout || !n.styles || hasRelevantGaps(n)) throw new Error('SCROLL_EVIDENCE_MISSING');
      const root = env.scrollingElement?.nodeId === id ? env.scrollingElement : undefined;
      return {
        nodeId: id,
        left: root?.scrollLeft ?? n.layout.scroll.left,
        top: root?.scrollTop ?? n.layout.scroll.top,
        width: root?.clientWidth ?? n.layout.client.width,
        height: root?.clientHeight ?? n.layout.client.height,
        scrollWidth: root?.scrollWidth ?? n.layout.scroll.width,
        scrollHeight: root?.scrollHeight ?? n.layout.scroll.height,
        overflowX: n.styles['overflow-x'],
        overflowY: n.styles['overflow-y'],
      };
    });
  return {
    captureId: inspection.captureId,
    observationId: o.id,
    instanceId: control.instanceId,
    binding: binding(control),
    geometry: canonical([
      node.parentId,
      r.width,
      r.height,
      node.styles?.position,
      node.styles?.transform,
      env.layoutViewport,
      env.devicePixelRatio,
      env.visualViewport && [
        env.visualViewport.width,
        env.visualViewport.height,
        env.visualViewport.scale,
        env.visualViewport.offsetLeft,
        env.visualViewport.offsetTop,
      ],
    ]),
    reachable: hits.some(h => h.withinSubtree),
    blocked: hits.every(h => !h.withinSubtree),
    scroll,
    hits,
  };
}

export const observedOcclusionRule = {
  id: 'observed-occlusion',
  version: '1.0.0',
  name: 'Occlusion across exploration observations',
  effects: 'read-history' as const,
  description:
    'Follow logical controls in ordered historical captures. Never scroll, observe the live page, or wait for exploration. Repeated obstruction alone does not establish an error.',
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(observedOcclusionOptionsSchema)),
};

/** One ordered consumer per session. State is bounded; reports retain immutable revisions. */
export class ObservedOcclusionTracker {
  private readonly options: z.output<typeof observedOcclusionOptionsSchema>;
  private tracks = new Map<string, Track>();
  private last?: { sessionId: string; sequence: number; inspectionId: string; report: RuleReport };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(options: ObservedOcclusionOptions = {}) {
    this.options = observedOcclusionOptionsSchema.parse(options);
  }
  run(page: RulePage): Promise<RuleReport> {
    const inspection = page.inspection;
    const task = structuredClone(inspection);
    const work = this.queue.then(() => this.process(page, task));
    this.queue = work.catch(() => {});
    return work;
  }
  private async process(page: RulePage, inspection: Inspection): Promise<RuleReport> {
    if (this.last) {
      if (this.last.sessionId !== inspection.sessionId) throw new Error('TRACKER_SESSION_MISMATCH');
      if (this.last.inspectionId === inspection.id) return structuredClone(this.last.report);
      if (inspection.sequence <= this.last.sequence) throw new Error('TRACKER_OUT_OF_ORDER');
    }
    const source = structuredClone(page);
    const [screened] = await new RuleRunner([sampledOcclusionRule]).run(source, [
      { ruleId: sampledOcclusionRule.id, ruleVersion: sampledOcclusionRule.version },
    ]);
    const o = source.observation,
      dom = source.snapshot.dom;
    // Work on a copy: a capacity or evidence failure cannot partly commit revisions.
    const tracks = structuredClone(this.tracks);
    const checks: RuleCheck[] = [];
    const visited = new Set<string>();
    const scenario =
      o && canonical([o.documentId, o.url, o.context, inspection.focus.scopeId, inspection.focus.regionKey]);
    const revise = (
      track: Track,
      result: RuleAssessment,
      current?: Sample,
      target?: RuleCheck['target'],
      moved: string[] = [],
      currentObservation?: RuleCheck,
    ) => {
      const prior = track.sample;
      if (
        current?.blocked &&
        (result.code === 'OCCLUSION_SUSPECTED' ||
          result.code === 'OBSERVED_POINTER_REQUIREMENT_FAILED' ||
          (result.code === 'OCCLUSION_STILL_OBSERVED' && result.severity === 'warning'))
      ) {
        track.lastObservedFinding = findingSnapshot(
          { ...result, target, facts: { ...result.facts, sample: json(current) } },
          inspection.captureId,
          track.label,
        );
        track.findingSample = current;
      }
      track.revision++;
      track.evidence = [...new Set([...track.evidence, inspection.captureId])].slice(-32);
      if (current) track.sample = current;
      checks.push({
        ...result,
        target,
        evidence: [
          ...new Set([
            track.firstCaptureId,
            ...(track.confirmedAt ? [track.confirmedAt] : []),
            ...track.evidence,
            ...result.evidence,
          ]),
        ],
        facts: {
          ...result.facts,
          issueId: track.id,
          identityId: track.identityId,
          lifecycle: track.lifecycle,
          revision: track.revision,
          firstCaptureId: track.firstCaptureId,
          observationStatus: observationStatus(
            !!current && track.lifecycle !== 'unverified',
            !!track.lastObservedFinding,
          ),
          ...(track.lastObservedFinding ? { lastObservedFinding: track.lastObservedFinding } : {}),
          ...(currentObservation
            ? {
                currentObservation: findingSnapshot(
                  currentObservation,
                  inspection.captureId,
                  o?.controls.find(c => c.localId === currentObservation.target?.nodeId)?.name ?? track.label,
                ),
              }
            : {}),
          ...(track.confirmedAt ? { confirmedAt: track.confirmedAt } : {}),
          changedScrollContainers: moved,
          attribution: 'observed_during_interval',
          coverage: 'five-pointer-samples; fully-in-view; not-whole-control',
          ...(prior && current
            ? {
                comparison: json({
                  beforeCaptureId: prior.captureId,
                  beforeObservationId: prior.observationId,
                  sameInstance: prior.instanceId === current.instanceId,
                  scrollChanges: moved.map(nodeId => ({
                    nodeId,
                    before: prior.scroll.find(c => c.nodeId === nodeId),
                    after: current.scroll.find(c => c.nodeId === nodeId),
                  })),
                }),
              }
            : {}),
          ...(current ? { sample: json(current) } : {}),
        },
      });
    };
    for (const check of screened.checks) {
      const control = o?.controls.find(c => c.localId === check.target?.nodeId);
      if (!control || !dom || !o) {
        checks.push(check);
        continue;
      }
      const key = canonical([scenario, control.identityId]);
      const track = tracks.get(key);
      const result = (
        verdict: RuleAssessment['verdict'],
        severity: RuleAssessment['severity'],
        code: string,
        actual: string,
      ): RuleAssessment => ({
        verdict,
        severity,
        code,
        actual,
        expected: 'A comparable five-point pointer sample of the same logical control',
        evidence: [inspection.captureId],
      });
      let current: Sample | undefined;
      let reason = check.code;
      const reliableIdentity =
        control.identityId &&
        !control.hypothesisId &&
        o.controls.filter(c => c.identityId === control.identityId).length === 1;
      if (check.verdict === 'pass' || check.code === 'SAMPLE_INTERCEPTED') {
        try {
          current = sample(inspection, o, dom, control);
        } catch (error) {
          reason = String(error);
        }
      }
      const currentCheck: RuleCheck = current
        ? {
            ...result(
              current.reachable ? 'pass' : 'unknown',
              current.reachable ? 'info' : 'warning',
              current.reachable ? 'OBSERVED_POINT_REACHABLE' : 'OCCLUSION_SUSPECTED',
              current.reachable
                ? 'At least one captured point reaches the target'
                : 'Five captured points are blocked; impact and requirements remain unverified',
            ),
            target: check.target,
            facts: { sample: json(current), coverage: 'five-pointer-samples; not-whole-control' },
          }
        : {
            ...check,
            ...(reason !== check.code
              ? {
                  verdict: 'unknown' as const,
                  code: 'OCCLUSION_RECHECK_UNAVAILABLE',
                  actual: reason,
                  // Only part of the control is on screen (scrolled to an edge, or under sticky chrome):
                  // a single intercepted center point there is not evidence of an obstruction.
                  ...(reason === 'Error: TARGET_NOT_FULLY_IN_VIEW' ? { severity: 'info' as const } : {}),
                }
              : {}),
          };
      if (['Error: TARGET_EXCEEDS_VIEWPORT', 'Error: TARGET_EXCEEDS_CLIP_BOUNDS'].includes(reason)) {
        currentCheck.code = reason.slice('Error: '.length);
        currentCheck.actual =
          'The target is larger than the captured viewport or clipping bounds; scrolling alone cannot satisfy full-view coverage';
        currentCheck.facts = {
          ...currentCheck.facts,
          observationStatus: 'unsupported',
          recheck: 'requires-viewport-or-layout-change',
          coverage: 'full-view-five-point-check-unavailable',
          sampledObservation: findingSnapshot(check, inspection.captureId, control.name),
        };
        currentCheck.nextSteps = [
          'Use a rule that supports partial-view targets, or reassess after a viewport or layout change',
        ];
      }
      if (!reliableIdentity) {
        // A capture can be assessed without claiming it is the previous component.
        if (track && !visited.has(key) && track.lifecycle !== 'resolved') {
          visited.add(key);
          track.lifecycle = 'unverified';
          track.sample = undefined;
          revise(track, result('unknown', 'warning', 'OCCLUSION_RECHECK_UNAVAILABLE', 'IDENTITY_UNCERTAIN'));
        }
        checks.push(currentCaptureOnly(currentCheck));
        continue;
      }
      if (track) visited.add(key);
      if (!current) {
        if (track && track.lifecycle !== 'resolved') {
          track.lifecycle = 'unverified';
          track.sample = undefined;
          revise(
            track,
            result('unknown', 'warning', 'OCCLUSION_RECHECK_UNAVAILABLE', reason),
            undefined,
            check.target,
            [],
            currentCheck,
          );
        } else checks.push(currentCheck);
        continue;
      }
      if (!track) {
        if (current.reachable) {
          checks.push({
            ...result('pass', 'info', 'OBSERVED_POINT_REACHABLE', 'At least one captured point reaches the target'),
            target: check.target,
          });
          continue;
        }
        // On a long crawl, make room by dropping the oldest finding; never stop checking.
        if (tracks.size >= this.options.maxTracked) tracks.delete(tracks.keys().next().value!);
        const created: Track = {
          id: crypto.randomUUID(),
          key,
          identityId: control.identityId!,
          lifecycle: 'suspected',
          revision: 0,
          firstCaptureId: inspection.captureId,
          label: control.name,
          evidence: [],
          sample: current,
        };
        tracks.set(key, created);
        visited.add(key);
        revise(created, currentCheck, current, check.target);
        continue;
      }
      const prior = track.sample;
      if (track.lifecycle === 'resolved' && current.reachable && !comparableSamples(prior, current)) {
        track.sample = current;
        checks.push({
          ...currentCheck,
          facts: { ...currentCheck.facts, observationStatus: 'current', tracking: 'current-capture-only' },
        });
        continue;
      }
      const historicalMismatch =
        current.reachable && track.lifecycle !== 'resolved' && !comparableSamples(track.findingSample, current);
      if (!comparableSamples(prior, current) || historicalMismatch) {
        const continuity = {
          status: 'baseline-changed',
          code: 'OCCLUSION_BASELINE_CHANGED',
          reason: historicalMismatch
            ? 'FINDING_BINDING_OR_GEOMETRY_CHANGED'
            : !prior
              ? 'PREVIOUS_SAMPLE_UNAVAILABLE'
              : 'INSTANCE_BINDING_OR_GEOMETRY_CHANGED',
          previousCaptureId: prior?.captureId ?? null,
        };
        track.sample = undefined;
        if (current.blocked) {
          track.lifecycle = 'suspected';
          track.label = control.name;
          revise(track, { ...currentCheck, facts: { ...currentCheck.facts, continuity } }, current, check.target);
        } else {
          track.lifecycle = 'unverified';
          revise(
            track,
            {
              ...result(
                'unknown',
                'warning',
                'OCCLUSION_BASELINE_CHANGED',
                'The historical finding cannot be compared with this observation; the current assessment is independent',
              ),
              facts: { continuity },
            },
            current,
            undefined,
            [],
            currentCheck,
          );
          checks.push({
            ...currentCheck,
            facts: {
              ...currentCheck.facts,
              observationStatus: 'current',
              continuity,
              tracking: 'current-capture-only',
            },
          });
        }
        continue;
      }
      const moved = current.scroll
        .filter(
          (c, i) => Math.abs(c.left - prior!.scroll[i].left) > 0.5 || Math.abs(c.top - prior!.scroll[i].top) > 0.5,
        )
        .map(c => c.nodeId);
      const requirement = this.options.requirements.find(r => r.identityId === control.identityId);
      if (current.reachable) {
        track.lifecycle = 'resolved';
        revise(
          track,
          result(
            'pass',
            'info',
            moved.length ? 'OCCLUSION_RECOVERED_AFTER_SCROLL' : 'OCCLUSION_NO_LONGER_OBSERVED',
            moved.length
              ? 'The same target has a reachable sample after an ancestor scroll position changed; causality is not established'
              : 'The same target now has a reachable sample; the original obstruction remains historical evidence',
          ),
          current,
          check.target,
          moved,
        );
      } else if (requirement && prior!.blocked && moved.length) {
        track.lifecycle = 'confirmed';
        track.confirmedAt = inspection.captureId;
        revise(
          track,
          {
            ...result(
              'fail',
              'error',
              'OBSERVED_POINTER_REQUIREMENT_FAILED',
              'All five points remain blocked after a relevant scroll. The declared requirement at this observed position failed; permanent unreachability is not established',
            ),
            expected: requirement.reason,
            evidence: [inspection.captureId, ...requirement.evidence],
          },
          current,
          check.target,
          moved,
        );
      } else {
        // A confirmed failure is retained while the same sampled failure persists.
        const confirmed = track.lifecycle === 'confirmed';
        track.lifecycle = confirmed ? 'confirmed' : 'suspected';
        revise(
          track,
          result(
            confirmed ? 'fail' : 'unknown',
            confirmed ? 'error' : 'warning',
            'OCCLUSION_STILL_OBSERVED',
            'The obstruction remains at sampled points. Repetition or a scroll endpoint alone is not proof of permanent blockage',
          ),
          current,
          check.target,
          moved,
        );
      }
    }
    for (const track of tracks.values())
      if (!visited.has(track.key) && track.lifecycle !== 'resolved') {
        track.lifecycle = 'unverified';
        track.sample = undefined;
        revise(track, {
          verdict: 'unknown',
          severity: 'warning',
          code: 'OCCLUSION_TARGET_UNOBSERVED',
          expected: 'Comparable evidence in the original scope and business context',
          actual: 'The original target or inspection context is absent or unavailable; its issue is not resolved',
          evidence: [inspection.captureId],
        });
      }
    const report: RuleReport = {
      schemaVersion: 1,
      inspectionId: inspection.id,
      captureId: inspection.captureId,
      documentId: source.capture.documentId,
      ruleId: observedOcclusionRule.id,
      ruleVersion: observedOcclusionRule.version,
      selection: {
        ruleId: observedOcclusionRule.id,
        ruleVersion: observedOcclusionRule.version,
        options: json(this.options) as Record<string, Json>,
      },
      checks,
      verdict: checks.some(c => c.verdict === 'fail')
        ? 'fail'
        : checks.some(c => c.verdict === 'unknown')
          ? 'unknown'
          : checks.some(c => c.verdict === 'pass')
            ? 'pass'
            : 'not-applicable',
      severity: checks.some(c => c.severity === 'error')
        ? 'error'
        : checks.some(c => c.severity === 'warning')
          ? 'warning'
          : 'info',
    };
    this.tracks = tracks;
    this.last = {
      sessionId: inspection.sessionId,
      sequence: inspection.sequence,
      inspectionId: inspection.id,
      report: structuredClone(report),
    };
    return report;
  }
}
