import { currentCaptureOnly, findingSnapshot, observationStatus } from './finding-history.js';
import { canonical } from './util.js';
import { type Control, type DomEvidence, type Json } from './types.js';
import type { Inspection, RulePage, ControlRule, RuleCheck, RuleReport, RuleSelection } from './types.js';
import { RuleRunner } from './runner.js';

/** Internal shared lifecycle for passive geometry rules, not a live-page API. */
export interface ObservedControlOptions {
  rule: ControlRule;
  selection: RuleSelection;
  report: { id: string; version: string; options: Record<string, Json> };
  maxTracked: number;
  codes: {
    measurable: string[];
    /** Measurable codes that only mean "not yet in view": reported for this capture, never tracked. */
    pending: string[];
    unavailable: string;
    baseline: string;
    resolved: string;
    unobserved: string;
  };
  binding?: (control: Control, dom: DomEvidence, check: RuleCheck) => unknown;
  relatedNodeIds?: (check: RuleCheck, dom: DomEvidence) => string[];
}
type Sample = {
  instanceId: string;
  binding: string;
  captureId: string;
  scroll: { nodeId: string; left: number; top: number }[];
};
type Track = {
  id: string;
  key: string;
  identityId: string;
  firstCaptureId: string;
  label: string;
  lastObservedFinding?: Json;
  revision: number;
  lifecycle: 'pending' | 'suspected' | 'confirmed' | 'resolved' | 'unverified';
  warning: boolean;
  sample?: Sample;
  findingSample?: Sample;
  evidence: string[];
};
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
function sample(
  c: Control,
  dom: DomEvidence,
  captureId: string,
  extraBinding?: unknown,
  relatedNodeIds: string[] = [],
): Sample {
  const nodes = new Map(dom.nodes.map(n => [n.id, n]));
  const node = nodes.get(c.localId)!;
  const ids = [
    ...new Set([
      ...(node.layout?.scrollAncestorIds ?? []),
      ...relatedNodeIds.flatMap(id => [id, ...(nodes.get(id)?.layout?.scrollAncestorIds ?? [])]),
      ...(dom.environment?.scrollingElement ? [dom.environment.scrollingElement.nodeId] : []),
    ]),
  ];
  return {
    instanceId: c.instanceId,
    captureId,
    binding: canonical([
      c.stableKey,
      c.identityContext,
      c.role,
      c.tag,
      c.name,
      c.region,
      c.reviewAttributes,
      c.value,
      c.checked,
      c.selected,
      c.enabled,
      c.visible,
      c.expanded,
      node.parentId,
      extraBinding,
    ]),
    scroll: ids.flatMap(id => {
      const n = nodes.get(id),
        root = dom.environment?.scrollingElement;
      return n?.layout
        ? [
            {
              nodeId: id,
              left: root?.nodeId === id ? root.scrollLeft : n.layout.scroll.left,
              top: root?.nodeId === id ? root.scrollTop : n.layout.scroll.top,
            },
          ]
        : [];
    }),
  };
}

/**
 * Make room for a new track on a long crawl: drop the oldest track that never warned
 * (pending, resolved or unverified without a finding); only if none exists, the oldest of all.
 * Map order is insertion order, so the first match is the oldest.
 */
function evict(tracks: Map<string, Track>) {
  for (const [key, track] of tracks)
    if (!track.warning) {
      tracks.delete(key);
      return;
    }
  const first = tracks.keys().next();
  if (!first.done) tracks.delete(first.value);
}

/** Feed one session's saved inspections in sequence. No browser operations exist here. */
export class ObservedControlTracker {
  private readonly options: ObservedControlOptions;
  private tracks = new Map<string, Track>();
  private last?: { sessionId: string; sequence: number; inspectionId: string; report: RuleReport };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(options: ObservedControlOptions) {
    this.options = options;
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
    const [screened] = await new RuleRunner([this.options.rule]).run(source, [this.options.selection]);
    const o = source.observation,
      dom = source.snapshot.dom;
    const scenario =
      o && canonical([o.documentId, o.url, o.context, inspection.focus.scopeId, inspection.focus.regionKey]);
    const tracks = structuredClone(this.tracks),
      visited = new Set<string>(),
      checks: RuleCheck[] = [];
    const revise = (track: Track, check: RuleCheck, current?: Sample, currentObservation?: RuleCheck) => {
      const prior = track.sample;
      const changes =
        current && prior
          ? current.scroll.flatMap(after => {
              const before = prior.scroll.find(s => s.nodeId === after.nodeId);
              return before && (Math.abs(before.left - after.left) > 0.5 || Math.abs(before.top - after.top) > 0.5)
                ? [{ nodeId: after.nodeId, before, after }]
                : [];
            })
          : [];
      if (
        current &&
        ['suspected', 'confirmed'].includes(track.lifecycle) &&
        (check.severity === 'warning' || check.severity === 'error')
      ) {
        track.lastObservedFinding = findingSnapshot(check, inspection.captureId, track.label);
        track.findingSample = current;
      }
      track.revision++;
      track.sample = current;
      track.evidence = [...new Set([...track.evidence, inspection.captureId])].slice(-32);
      checks.push({
        ...check,
        evidence: [...new Set([track.firstCaptureId, ...track.evidence, ...check.evidence])],
        facts: {
          ...check.facts,
          identityId: track.identityId,
          issueId: track.id,
          revision: track.revision,
          lifecycle: track.lifecycle,
          firstCaptureId: track.firstCaptureId,
          attribution: 'observed_during_interval',
          ancestorScrollChanges: json(changes),
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
          ...(prior ? { previousCaptureId: prior.captureId } : {}),
        },
      });
    };
    const unavailable = (track: Track, code: string, actual: string, target?: RuleCheck['target']): RuleCheck => ({
      verdict: 'unknown',
      severity: track.warning ? 'warning' : 'info',
      code,
      actual,
      target,
      expected: 'Comparable geometry evidence of the same control in the original scope',
      evidence: [inspection.captureId],
    });
    for (const check of screened.checks) {
      const c = o?.controls.find(c => c.localId === check.target?.nodeId);
      if (!c || !o || !dom) {
        checks.push(check);
        continue;
      }
      const key = canonical([scenario, c.identityId]);
      const track = tracks.get(key);
      const reliableIdentity =
        c.identityId && !c.hypothesisId && o.controls.filter(n => n.identityId === c.identityId).length === 1;
      if (!reliableIdentity) {
        if (track && !visited.has(key) && track.lifecycle !== 'resolved') {
          visited.add(key);
          track.lifecycle = 'unverified';
          revise(track, unavailable(track, this.options.codes.unavailable, 'IDENTITY_UNCERTAIN'));
        }
        checks.push(currentCaptureOnly(check));
        continue;
      }
      if (track) visited.add(key);
      const measurable = this.options.codes.measurable.includes(check.code);
      if (!measurable) {
        if (track && track.lifecycle !== 'resolved') {
          track.lifecycle = 'unverified';
          revise(
            track,
            unavailable(track, this.options.codes.unavailable, check.actual, check.target),
            undefined,
            check,
          );
        } else checks.push(check);
        continue;
      }
      const current = sample(
        c,
        dom,
        inspection.captureId,
        this.options.binding?.(c, dom, check),
        this.options.relatedNodeIds?.(check, dom),
      );
      if (!track && check.verdict === 'pass') {
        checks.push(check);
        continue;
      }
      // A control not yet fully on screen is checked when exploration brings it into view;
      // tracking it now would only hold an empty placeholder.
      if (!track && this.options.codes.pending.includes(check.code)) {
        checks.push({ ...check, facts: { ...check.facts, observationStatus: 'current', tracking: 'not-in-view' } });
        continue;
      }
      if (!track && tracks.size >= this.options.maxTracked) evict(tracks);
      const active: Track = track ?? {
        id: crypto.randomUUID(),
        key,
        identityId: c.identityId!,
        firstCaptureId: inspection.captureId,
        label: c.name,
        lifecycle: 'pending',
        warning: false,
        revision: 0,
        evidence: [],
      };
      if (!track) {
        tracks.set(key, active);
        visited.add(key);
      }
      const prior = active.sample;
      const sameBinding = (other: Sample | undefined) =>
        other && other.instanceId === current.instanceId && other.binding === current.binding;
      if (active.lifecycle === 'resolved' && check.verdict === 'pass' && !sameBinding(prior)) {
        // A healthy replacement does not reopen an already resolved finding.
        active.sample = current;
        checks.push({
          ...check,
          facts: { ...check.facts, observationStatus: 'current', tracking: 'current-capture-only' },
        });
        continue;
      }
      // A new label/instance fitting twice still does not resolve the old label.
      const historicalMismatch =
        check.verdict === 'pass' &&
        active.lifecycle !== 'resolved' &&
        active.warning &&
        !sameBinding(active.findingSample);
      if (track && (!sameBinding(prior) || historicalMismatch)) {
        const continuity = {
          status: 'baseline-changed',
          code: this.options.codes.baseline,
          reason: historicalMismatch
            ? 'FINDING_BINDING_CHANGED'
            : !prior
              ? 'PREVIOUS_SAMPLE_UNAVAILABLE'
              : 'INSTANCE_OR_BINDING_CHANGED',
          previousCaptureId: prior?.captureId ?? null,
        };
        // Do not generate scroll comparisons across an invalid baseline.
        active.sample = undefined;
        if (check.severity === 'warning' || check.severity === 'error') {
          active.lifecycle = check.verdict === 'fail' ? 'confirmed' : 'suspected';
          active.warning = true;
          active.label = c.name;
          revise(active, { ...check, facts: { ...check.facts, continuity } }, current);
        } else {
          active.lifecycle = 'unverified';
          revise(
            active,
            {
              ...unavailable(
                active,
                this.options.codes.baseline,
                'The historical finding cannot be compared with this observation; the current assessment is independent',
              ),
              facts: { continuity },
            },
            current,
            check,
          );
          checks.push({
            ...check,
            facts: { ...check.facts, observationStatus: 'current', continuity, tracking: 'current-capture-only' },
          });
        }
        continue;
      }
      active.lifecycle =
        check.verdict === 'pass'
          ? 'resolved'
          : check.verdict === 'fail'
            ? 'confirmed'
            : check.severity === 'warning'
              ? 'suspected'
              : 'pending';
      active.warning ||= check.severity === 'warning' || check.severity === 'error';
      if (active.warning && active.lifecycle === 'pending') {
        active.lifecycle = 'unverified';
        revise(
          active,
          {
            ...check,
            severity: 'warning',
            actual: 'Full recovery of the prior warning remains unverified at this observation',
          },
          current,
          check,
        );
        continue;
      }
      // Repetition, an action label or a scroll endpoint never adds an error.
      revise(
        active,
        check.verdict === 'pass'
          ? {
              ...check,
              code: this.options.codes.resolved,
              actual:
                'The same control now satisfies the captured geometry check; changes in scrolling or layout are interval evidence, not a causal proof',
            }
          : check,
        current,
      );
    }
    for (const track of tracks.values())
      if (!visited.has(track.key) && track.lifecycle !== 'resolved') {
        track.lifecycle = 'unverified';
        revise(
          track,
          unavailable(
            track,
            this.options.codes.unobserved,
            'The target, original context or usable capture is absent; its issue remains unresolved',
          ),
        );
      }
    const report: RuleReport = {
      ...screened,
      ruleId: this.options.report.id,
      ruleVersion: this.options.report.version,
      selection: {
        ruleId: this.options.report.id,
        ruleVersion: this.options.report.version,
        options: structuredClone(this.options.report.options),
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
