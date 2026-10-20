import type {
  CheckSummary,
  CrawlPlugin,
  CrawlStateContext,
  DOMSnapshot,
  Finding,
  RuntimeEvidence,
  SweepView,
} from '@interaction/crawler';
import { builtinRulePlugins, type RulePlugin } from './plugins.js';
import { ruleReasons } from './reasons.js';
import type { Control, RuleCheck, RulePage, RuleReport, RuleVerdict } from './types.js';

export interface RulesPluginOptions {
  /** Rule plugins to run; defaults to all built-in rules. */
  rules?: readonly RulePlugin[];
  /** Severities reported as findings; 'info' (pass, not-applicable, unknown) is omitted by default. */
  report?: readonly ('info' | 'warning' | 'error')[];
}

/** Results that only mean the control was not (fully) on screen in this capture; scrolling settles them. */
const offscreen = (c: RuleCheck) =>
  c.code === 'VIEWPORT_RECHECK_PENDING' ||
  c.code === 'TEXT_SCROLL_RECHECK_PENDING' ||
  c.code === 'OUTSIDE_VIEWPORT' ||
  (c.code === 'OCCLUSION_RECHECK_UNAVAILABLE' && c.actual === 'Error: TARGET_NOT_FULLY_IN_VIEW');

/** A rule's result on one target, with the capture it was measured in and that capture's screenshot. */
type Seen = { check: RuleCheck; page: RulePage; shot?: string };

/**
 * UI rules as a crawl plugin. For each new state it takes the crawler's detailed capture, builds
 * the page the rules read, and runs every rule with its cross-state history; warnings and
 * errors become findings, and every rule's verdict is summarized in counts. The crawler core
 * knows nothing about these rules.
 *
 * Controls below the first screen, or inside a scrolling container, cannot be judged from that
 * capture. The crawler scrolls every new state to the end and hands over what it saw; each such
 * control is judged in the first of those views that shows it, with a fresh rule instance (no
 * history: a scrolled view is not the next state).
 */
export function rulesPlugin(options: RulesPluginOptions = {}): CrawlPlugin {
  const rules = (options.rules ?? builtinRulePlugins).map(rule => ({ rule, tracker: rule.create() }));
  const report = new Set(options.report ?? ['warning', 'error']);
  const sessionId = crypto.randomUUID(),
    viewSession = crypto.randomUUID();
  // The crawler's component class names the same control across states; give it a stable id.
  const identities = new Map<string, string>();
  let viewSequence = 0;
  return {
    id: 'rules',
    checks: () => rules.map(({ rule }) => ({ id: rule.id, name: rule.name, description: rule.description })),
    reasons: () => ruleReasons,
    async onState(context) {
      const page = await rulePage(context, sessionId, identities);
      const findings: Finding[] = [];
      const checks: CheckSummary[] = [];
      const results: { rule: RulePlugin; report: RuleReport; ms: number }[] = [];
      // One rule failing must not discard the others' results for this state.
      for (const { rule, tracker } of rules) {
        const started = performance.now();
        try {
          results.push({ rule, report: await tracker.run(page), ms: performance.now() - started });
        } catch (error) {
          context.reportError(`${rule.id}: ${String(error)}`);
          checks.push({
            id: rule.id,
            verdict: 'unknown',
            targets: 0,
            ms: Math.round(performance.now() - started),
            codes: [{ code: 'RULE_ERROR', verdict: 'unknown', count: 1 }],
          });
        }
      }
      const further = await lookFurther(context, page, results, {
        report,
        view: n => ({ sessionId: viewSession, sequence: ++viewSequence, state: `${context.state}@${n}` }),
        identities,
      });
      for (const { rule, report: result, ms } of results) {
        const inPlace = new Set(result.checks.flatMap(c => (c.target ? [`${rule.id}|${c.target.nodeId}`] : [])));
        const seen: Seen[] = [
          ...result.checks.map(
            check => (check.target && further.get(`${rule.id}|${check.target.nodeId}`)) || { check, page },
          ),
          // Controls that only appeared while scrolling.
          ...[...further].filter(([key]) => key.startsWith(`${rule.id}|`) && !inPlace.has(key)).map(([, v]) => v),
        ];
        for (const s of seen)
          if (report.has(s.check.severity)) findings.push(finding(rule.id, s.check, s.page, s.shot));
        // A rule with nothing to check here is left out; the catalog still names it.
        if (result.verdict !== 'not-applicable' || seen.some(v => v.check.target))
          checks.push(
            summary(
              rule.id,
              seen.map(s => s.check),
              ms + (further.ms.get(rule.id) ?? 0),
            ),
          );
      }
      return { findings, checks };
    },
  };
}

/**
 * Judge what the first capture could not: controls that were off screen in it, and controls that
 * only appeared while scrolling (lazy sections, rows a virtual list renders on demand). Each is
 * judged in the first of the crawler's scrolled views where it is fully on screen. Results are keyed
 * by `rule|nodeId` (node ids are stable across captures of one document); those that were in the
 * first capture replace its result there, the others are added. A view holding a problem gets a
 * screenshot.
 */
async function lookFurther(
  context: CrawlStateContext,
  page: RulePage,
  results: { rule: RulePlugin; report: RuleReport }[],
  input: {
    report: Set<string>;
    view: (n: number) => { sessionId: string; sequence: number; state: string };
    identities: Map<string, string>;
  },
): Promise<Map<string, Seen> & { ms: Map<string, number> }> {
  const settled = Object.assign(new Map<string, Seen>(), { ms: new Map<string, number>() });
  const views = context.views().filter(v => v.capture.dom);
  // Off screen and not looked at: either it is unchanged since an earlier state of the page was
  // scrolled and checked, or it is in a long list the sweep sampled instead of exhausting.
  const unchanged = context.unchanged().length > 0;
  const lists = new Set(page.observation.controls.filter(c => c.list || c.structuralItem).map(c => c.localId));
  const notLooked = (check: RuleCheck): Seen => ({
    check: {
      ...check,
      verdict: 'not-applicable',
      severity: 'info',
      ...(unchanged && !lists.has(check.target!.nodeId)
        ? {
            code: 'CHECKED_FURTHER_DOWN_EARLIER',
            actual: 'Off screen here, and unchanged since an earlier state of the page was scrolled and checked',
          }
        : {
            code: 'LIST_SAMPLED',
            actual: 'Off screen in a long list the crawler sampled instead of scrolling to its end',
          }),
    },
    page,
  });
  // Per rule, the targets already judged on screen; everything else in a view is still open.
  const judged = new Map<string, Set<string>>();
  for (const { rule, report } of results)
    judged.set(rule.id, new Set(report.checks.flatMap(c => (c.target && !offscreen(c) ? [c.target.nodeId] : []))));
  for (const [n, sweepView] of views.entries()) {
    const view = pageFromCapture(sweepView.capture, {
      ...input.view(n),
      runtime: context.runtime(),
      identities: input.identities,
    });
    const controls = view.observation.controls;
    let found = false;
    const here: [string, Seen][] = [];
    for (const { rule } of results) {
      const done = judged.get(rule.id)!;
      const open = controls.filter(c => !done.has(c.localId));
      if (!open.length) continue;
      const started = performance.now();
      try {
        view.observation.controls = open;
        const report = await rule.create().run(view);
        for (const check of report.checks) {
          const nodeId = check.target?.nodeId;
          if (!nodeId || done.has(nodeId) || offscreen(check)) continue;
          done.add(nodeId);
          here.push([`${rule.id}|${nodeId}`, { check, page: view }]);
          found ||= input.report.has(check.severity);
        }
      } catch (error) {
        context.reportError(`${rule.id} (scrolled view ${n + 1}): ${String(error)}`);
      } finally {
        view.observation.controls = controls;
      }
      settled.ms.set(rule.id, (settled.ms.get(rule.id) ?? 0) + performance.now() - started);
    }
    // A problem found here is shown on a picture of this view.
    const shot = found ? await context.shoot(sweepView) : undefined;
    for (const [key, seen] of here) settled.set(key, shot ? { ...seen, shot } : seen);
  }
  // Still off screen in every view: unchanged since checked, or in a list the sweep sampled.
  for (const { rule, report } of results)
    for (const check of report.checks) {
      const nodeId = check.target?.nodeId;
      if (nodeId && offscreen(check) && !settled.has(`${rule.id}|${nodeId}`) && (unchanged || lists.has(nodeId)))
        settled.set(`${rule.id}|${nodeId}`, notLooked(check));
    }
  return settled;
}

async function rulePage(
  context: CrawlStateContext,
  sessionId: string,
  identities: Map<string, string>,
): Promise<RulePage> {
  return pageFromCapture(await context.detail(), {
    sessionId,
    sequence: context.sequence,
    state: context.state,
    runtime: context.runtime(),
    identities,
  });
}

/**
 * Build the page rules read from one detailed crawler capture. `identities` maps a control's
 * stable description to a logical id, so trackers can follow the same control across captures.
 */
export function pageFromCapture(
  capture: DOMSnapshot,
  input: {
    sessionId: string;
    sequence: number;
    state?: string;
    runtime: RuntimeEvidence;
    identities: Map<string, string>;
  },
): RulePage {
  const { sessionId, identities } = input;
  const observationId = `${input.state ?? capture.documentId}#${input.sequence}`,
    captureId = `capture:${observationId}`;
  const controls: Control[] = capture.controls.map(c => {
    const key = JSON.stringify([c.role, c.tag, c.stableKey ?? c.name, c.landmark ?? '']);
    if (!identities.has(key)) identities.set(key, crypto.randomUUID());
    return { ...c, identityId: identities.get(key) };
  });
  // Controls sharing an identity in one capture are ambiguous for cross-state history.
  const counts = new Map<string, number>();
  for (const c of controls) counts.set(c.identityId!, (counts.get(c.identityId!) ?? 0) + 1);
  for (const c of controls) if (counts.get(c.identityId!)! > 1) c.hypothesisId = c.identityId;
  const overlay = capture.overlays.at(-1);
  return {
    inspection: {
      id: `inspection:${observationId}`,
      sessionId,
      captureId,
      observationId,
      sequence: input.sequence,
      protocolVersion: 1,
      focus: {
        regionKey: overlay?.key ?? 'document',
        scopeId: overlay?.key,
        kind: overlay ? 'overlay' : 'document',
        confidence: 'observed',
      },
    },
    capture: {
      id: captureId,
      sessionId,
      observationId,
      documentId: capture.documentId,
      capturedAt: capture.dom?.capturedAt ?? new Date().toISOString(),
      quality: {
        status: capture.dom && !capture.gaps.some(g => g.critical) ? 'complete' : 'incomplete',
        missingRequired: capture.dom ? [] : ['web.dom'],
      },
    },
    observation: {
      id: observationId,
      documentId: capture.documentId,
      url: capture.url,
      stable: !capture.gaps.some(g => g.critical),
      context: {},
      controls,
      overlays: capture.overlays,
      boundaries: capture.overlays
        .filter(o => o.kind === 'modal' || o.kind === 'dialog')
        .map(o => ({ key: o.key, name: o.name })),
    },
    snapshot: { observationId, documentId: capture.documentId, dom: capture.dom, runtime: input.runtime },
  };
}

type Reason = NonNullable<CheckSummary['codes']>[number];
/** Codes kept per verdict that did not pass, most frequent first. */
const codesPerVerdict = 3;

/** A rule's verdict on one state in counts: targets by verdict, and why they did not pass. */
function summary(id: string, checks: RuleCheck[], ms: number): CheckSummary {
  const counts: NonNullable<CheckSummary['counts']> = {};
  const reasons = new Map<string, Reason>();
  let targets = 0;
  for (const check of checks) {
    counts[check.verdict] = (counts[check.verdict] ?? 0) + 1;
    if (check.target) targets++;
    if (check.verdict === 'pass') continue;
    const key = `${check.verdict} ${check.code}`;
    const reason = reasons.get(key) ?? { code: check.code, verdict: check.verdict, count: 0 };
    reason.count++;
    reasons.set(key, reason);
  }
  const order: Reason['verdict'][] = ['fail', 'unknown', 'not-applicable'];
  const codes = order.flatMap(v =>
    [...reasons.values()]
      .filter(r => r.verdict === v)
      .sort((a, b) => b.count - a.count)
      .slice(0, codesPerVerdict),
  );
  // As the rule runner decides: a known failure stays a failure even when other targets are unknown.
  const verdict: RuleVerdict = counts.fail
    ? 'fail'
    : counts.unknown
      ? 'unknown'
      : counts.pass
        ? 'pass'
        : 'not-applicable';
  return {
    id,
    verdict,
    targets,
    ...(Object.keys(counts).length > 1 ? { counts } : {}),
    ms: Math.round(ms),
    ...(codes.length ? { codes } : {}),
  };
}

function finding(rule: string, check: RuleCheck, page: RulePage, shot?: string): Finding {
  const nodeId = check.target?.nodeId;
  const control = page.observation.controls.find(c => c.localId === nodeId);
  const node = page.snapshot.dom?.nodes.find(n => n.id === nodeId);
  // Page-level rules name a non-control element themselves; its tag alone would merge distinct ones.
  const own = (key: string) => (typeof check.facts?.[key] === 'string' ? (check.facts[key] as string) : undefined);
  const lost = Array.isArray(check.facts?.lostText) ? String(check.facts.lostText[0] ?? '') : undefined;
  // Measured in the same capture, so the box matches the page as the state's screenshot shows it.
  const box = node?.rect ?? control?.rect;
  const environment = page.snapshot.dom?.environment;
  return {
    rule,
    severity: check.severity,
    selector: control?.selector ?? own('selector') ?? node?.tag ?? nodeId ?? '',
    text: (control?.name || control?.label || lost || node?.text || '').slice(0, 80),
    detail: `${check.code}: ${check.actual}`,
    code: check.code,
    ...(box && environment && box.width > 0 && box.height > 0
      ? {
          target: {
            box: { x: box.x, y: box.y, width: box.width, height: box.height },
            scroll: environment.scroll,
            viewport: { width: environment.layoutViewport.width, height: environment.layoutViewport.height },
            ...(shot ? { shot } : {}),
          },
        }
      : {}),
    facts: { code: check.code, verdict: check.verdict, expected: check.expected, facts: check.facts },
  };
}
