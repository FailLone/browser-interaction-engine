import { contextKey, hash, type ExplorationAudit, type ExplorationGroup } from '@interaction/core';
import type { Observation, ControlClassificationRecord } from '@interaction/adapter-playwright';
import type { ControlCoverage } from './control-coverage.js';

export interface BrowserCompletionAudit {
  unit: 'observed_browser_scope';
  status: 'in_progress' | 'awaiting_decision' | 'blocked' | 'unverified';
  exhaustive: false;
  recordedActions: Pick<ExplorationAudit, 'status' | 'counts' | 'pendingGroupIds' | 'stopReasons'>;
  controls: ControlCoverage['counts'];
  controlClassifications: ControlClassificationRecord[];
  unconfirmedControls: { id: string; label: string; role: string; controlIds: string[]; observationIds: string[] }[];
  /** URL plus declared context; document instances remain separately traceable. */
  scopes: { key: string; url: string; contextKey: string; observationIds: string[]; instanceScopes: string[]; unconfirmedControlIds: string[]; gapIds: string[];
    pageDecisions: Pick<ExplorationGroup, 'id' | 'revision' | 'status' | 'observationId' | 'decisions' | 'invalidation'>[] }[];
  gaps: { id: string; scopeKey: string; origin: 'observation' | 'evidence'; code: string; selector?: string; reference?: string; messages: string[];
    observationIds: string[]; criticalObservationIds: string[]; current: boolean; diagnostic: boolean }[];
  limitation: string;
}

/** Read-only synthesis: a finished action ledger never attests exhaustive browser discovery. */
export function auditBrowserCompletion(audit: ExplorationAudit, coverage: ControlCoverage, observations: Observation[], currentObservationId?: string, groups: ExplorationGroup[] = [], classifications: ControlClassificationRecord[] = []): BrowserCompletionAudit {
  const scopes = new Map<string, BrowserCompletionAudit['scopes'][number]>();
  const scopeByObservation = new Map<string, string>();
  const gaps = new Map<string, BrowserCompletionAudit['gaps'][number]>();
  for (const o of observations) {
    const context = contextKey(o.context), key = hash({ url: o.url, context });
    let scope = scopes.get(key);
    if (!scope) {
      const pageDecisions = groups.filter(g => g.kind === 'page' && g.binding === 'context' && g.proposalKey === `page:${o.url}` && g.contextKey === context)
        .map(({ id, revision, status, observationId, decisions, invalidation }) => structuredClone({ id, revision, status, observationId, decisions, invalidation }));
      scope = { key, url: o.url, contextKey: context, observationIds: [], instanceScopes: [], unconfirmedControlIds: [], gapIds: [], pageDecisions };
      scopes.set(key, scope);
    }
    scopeByObservation.set(o.id, key);
    if (!scope.observationIds.includes(o.id)) scope.observationIds.push(o.id);
    if (o.instanceScope && !scope.instanceScopes.includes(o.instanceScope)) scope.instanceScopes.push(o.instanceScope);
    const observedGaps = [...o.gaps.map(g => ({ g, origin: 'observation' as const })),
      ...(o.evidence?.gaps || []).map(g => ({ g, origin: 'evidence' as const }))];
    for (const { g, origin } of observedGaps) {
      const selector = 'selector' in g && typeof g.selector === 'string' ? g.selector : undefined;
      const id = hash({ scope: key, origin, code: g.code, selector, reference: g.reference });
      let gap = gaps.get(id);
      if (!gap) {
        gap = { id, scopeKey: key, origin, code: g.code, ...(selector ? { selector } : {}), ...(g.reference ? { reference: g.reference } : {}), messages: [],
          observationIds: [], criticalObservationIds: [], current: false,
          diagnostic: ['INTERACTION_STABLE', 'EVIDENCE_CAPTURE_RETRIED'].includes(g.code) };
        gaps.set(id, gap); scope.gapIds.push(id);
      }
      if (!gap.messages.includes(g.message)) gap.messages.push(g.message);
      if (!gap.observationIds.includes(o.id)) gap.observationIds.push(o.id);
      if (g.critical && !gap.criticalObservationIds.includes(o.id)) gap.criticalObservationIds.push(o.id);
      if (g.critical) gap.diagnostic = false;
      gap.current ||= o.id === currentObservationId;
    }
  }
  const unconfirmedControls = coverage.items.filter(c => c.classification === 'unconfirmed').map(c => {
    for (const oid of c.observationIds) {
      const key = scopeByObservation.get(oid), scope = key && scopes.get(key);
      if (scope && !scope.unconfirmedControlIds.includes(c.id)) scope.unconfirmedControlIds.push(c.id);
    }
    return { id: c.id, label: c.label, role: c.role, controlIds: [...c.controlIds], observationIds: [...c.observationIds] };
  });
  return { unit: 'observed_browser_scope', status: audit.status === 'complete' ? 'unverified' : audit.status, exhaustive: false,
    recordedActions: { status: audit.status, counts: { ...audit.counts }, pendingGroupIds: [...audit.pendingGroupIds], stopReasons: [...audit.stopReasons] },
    controls: { ...coverage.counts }, controlClassifications: structuredClone(classifications), unconfirmedControls, scopes: [...scopes.values()], gaps: [...gaps.values()],
    limitation: 'All recorded observations, including destinations, remain traceable. Scope exclusions are not execution coverage and do not erase discovery gaps. Unknown controls, adapter limits, unobserved behavior, input combinations and business results have no exhaustive discovery proof. Historical gaps do not by themselves authorize or require revisiting excluded pages.' };
}
