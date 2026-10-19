import type { CrawlPlugin, CrawlStateContext, DOMSnapshot, Finding, RuntimeEvidence } from '@interaction/crawler';
import { builtinRulePlugins, type RulePlugin } from './plugins.js';
import type { Control, RuleCheck, RulePage } from './types.js';

export interface RulesPluginOptions {
  /** Rule plugins to run; defaults to all built-in rules. */
  rules?: readonly RulePlugin[];
  /** Severities reported as findings; 'info' (pass, not-applicable, unknown) is omitted by default. */
  report?: readonly ('info' | 'warning' | 'error')[];
}

/**
 * UI rules as a crawl plugin. For each new state it takes the crawler's detailed capture, builds
 * the page the rules read, and runs every rule with its cross-state history; warnings and
 * errors become findings. The crawler core knows nothing about these rules.
 */
export function rulesPlugin(options: RulesPluginOptions = {}): CrawlPlugin {
  const rules = (options.rules ?? builtinRulePlugins).map(rule => ({ rule, tracker: rule.create() }));
  const report = new Set(options.report ?? ['warning', 'error']);
  const sessionId = crypto.randomUUID();
  // The crawler's component class names the same control across states; give it a stable id.
  const identities = new Map<string, string>();
  return {
    id: 'rules',
    async onState(context) {
      const page = await rulePage(context, sessionId, identities);
      const findings: Finding[] = [];
      for (const { rule, tracker } of rules) {
        const result = await tracker.run(page);
        for (const check of result.checks) if (report.has(check.severity)) findings.push(finding(rule.id, check, page));
      }
      return findings;
    },
  };
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

function finding(rule: string, check: RuleCheck, page: RulePage): Finding {
  const nodeId = check.target?.nodeId;
  const control = page.observation.controls.find(c => c.localId === nodeId);
  const node = page.snapshot.dom?.nodes.find(n => n.id === nodeId);
  return {
    rule,
    severity: check.severity,
    selector: control?.selector ?? node?.tag ?? nodeId ?? '',
    text: (control?.name || control?.label || node?.text || '').slice(0, 80),
    detail: `${check.code}: ${check.actual}`,
    facts: { code: check.code, verdict: check.verdict, expected: check.expected, facts: check.facts },
  };
}
