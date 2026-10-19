import { z } from 'zod';
import { canonical, hash } from './util.js';
import type { Inspection, RulePage, RuleCheck, RuleReport } from './types.js';
import { RuleRunner } from './runner.js';
import { imageResourceOptionsSchema, imageResourceRule } from './image-resource.js';
import { findingSnapshot } from './finding-history.js';

export const imageResourceTrackerOptionsSchema = z
  .object({
    rule: imageResourceOptionsSchema.prefault({}),
    maxTracked: z.number().int().min(1).max(1000).default(500),
  })
  .strict();
export type ImageResourceTrackerOptions = z.input<typeof imageResourceTrackerOptionsSchema>;
type Finding = { id: string; firstCaptureId: string; label: string; check: RuleCheck };

/** DOM node IDs bind the same live instance in a document. Neither the alt text
 * nor the resource URL alone establishes identity across replacement nodes. */
export class ImageResourceTracker {
  private readonly options;
  private findings = new Map<string, Finding>();
  private last?: { sessionId: string; sequence: number; inspectionId: string; report: RuleReport };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(input: ImageResourceTrackerOptions = {}) {
    this.options = imageResourceTrackerOptionsSchema.parse(input);
  }
  run(page: RulePage): Promise<RuleReport> {
    const inspection = page.inspection;
    const task = structuredClone(inspection);
    const work = this.queue.then(() => this.process(page, task));
    this.queue = work.catch(() => {});
    return work;
  }
  private async process(page: RulePage, task: Inspection): Promise<RuleReport> {
    if (this.last) {
      if (this.last.sessionId !== task.sessionId) throw new Error('TRACKER_SESSION_MISMATCH');
      if (this.last.inspectionId === task.id) return structuredClone(this.last.report);
      if (task.sequence <= this.last.sequence) throw new Error('TRACKER_OUT_OF_ORDER');
    }
    const source = structuredClone(page);
    const [screened] = await new RuleRunner([imageResourceRule]).run(source, [
      { ruleId: imageResourceRule.id, ruleVersion: imageResourceRule.version, options: this.options.rule },
    ]);
    const dom = source.snapshot.dom,
      observation = source.observation;
    const nodes = new Map(dom?.nodes.map(n => [n.id, n]));
    const findings = structuredClone(this.findings),
      visited = new Set<string>(),
      checks: RuleCheck[] = [];
    for (const check of screened.checks) {
      const node = check.target && nodes.get(check.target.nodeId);
      if (!node || !observation || !check.facts?.resource) {
        checks.push(check);
        continue;
      }
      const label = String(check.facts.label ?? '图片');
      const key = canonical([
        task.sessionId,
        dom?.documentId,
        observation.url,
        observation.context,
        task.focus.scopeId,
        task.focus.regionKey,
        node.id,
        node.parentId,
        label,
        check.facts.resource,
      ]);
      const prior = findings.get(key);
      const anomaly = ['IMAGE_RESOURCE_LOAD_FAILED', 'IMAGE_RESOURCE_REQUIREMENT_FAILED'].includes(check.code);
      const recovered =
        check.code === 'IMAGE_RESOURCE_AVAILABLE' &&
        check.facts.event === 'load' &&
        Number(check.facts.eventSequence) > Number(prior?.check.facts?.eventSequence);
      if (!anomaly && !recovered) {
        checks.push(check);
        continue;
      }
      if (!prior && !anomaly) {
        checks.push(check);
        continue;
      }
      if (!prior && findings.size >= this.options.maxTracked) throw new Error('TRACKER_CAPACITY_EXCEEDED');
      const finding = prior ?? {
        id: `image-resource-issue:${hash([task.captureId, key])}`,
        firstCaptureId: task.captureId,
        label,
        check: structuredClone(check),
      };
      visited.add(key);
      if (anomaly) {
        finding.check = structuredClone(check);
        findings.set(key, finding);
      } else findings.delete(key);
      checks.push({
        ...check,
        ...(anomaly
          ? {}
          : {
              code: 'IMAGE_RESOURCE_RESTORED',
              actual:
                'A later native load event proves that the same image slot and source now load successfully; file bytes and fallback meaning are not compared',
            }),
        facts: {
          ...check.facts,
          issueId: finding.id,
          firstCaptureId: finding.firstCaptureId,
          lifecycle: anomaly ? (check.verdict === 'fail' ? 'confirmed' : 'suspected') : 'resolved',
          lastObservedFinding: findingSnapshot(finding.check, finding.check.target!.captureId, finding.label),
        },
      });
    }
    for (const [key, finding] of findings)
      if (!visited.has(key))
        checks.push({
          ...finding.check,
          verdict: 'unknown',
          code: 'IMAGE_RESOURCE_NOT_RECHECKED',
          actual:
            'The original image slot and source have no later verified success in the same scope; disappearance, fallback substitution and unfinished retries do not demonstrate recovery',
          facts: {
            ...finding.check.facts,
            issueId: finding.id,
            firstCaptureId: finding.firstCaptureId,
            observationStatus: 'historical',
            lifecycle: 'unverified',
            lastObservedFinding: findingSnapshot(finding.check, finding.check.target!.captureId, finding.label),
          },
        });
    const report: RuleReport = {
      ...screened,
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
    this.findings = findings;
    this.last = {
      sessionId: task.sessionId,
      sequence: task.sequence,
      inspectionId: task.id,
      report: structuredClone(report),
    };
    return report;
  }
}
