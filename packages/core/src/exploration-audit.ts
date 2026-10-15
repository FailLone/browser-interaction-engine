import type { ActionAttempt, ExplorationGroup, FrontierItem, Observation, Session } from './types.js';
import { canonical, contextKey } from './util.js';
import type { EquivalentCoverage } from './coverage-reconciliation.js';

export type ExplorationCaseDisposition = 'succeeded' | 'covered_equivalent' | 'policy_excluded' | 'awaiting_decision' | 'pending' | 'blocked' | 'retired';
export interface ExplorationAudit {
  unit: 'discovered_action_cases';
  status: 'in_progress' | 'awaiting_decision' | 'blocked' | 'complete';
  /** Completion is relative to observed cases and explicit policies, never discovery completeness. */
  discoveryComplete: false;
  counts: Record<ExplorationCaseDisposition, number> & { notAttempted: number };
  cases: { frontierId: string; actionId: string; label: string; kind: string; observationId: string;
    disposition: ExplorationCaseDisposition; reason: string; schedulingReason?: string; attemptIds: string[];
    equivalentTo?: EquivalentCoverage;
    policies: { groupId: string; groupKind: string; revision: number; decisionRevision: number; at: string; validity: 'current' | 'historical'; mode: string; source: string; evidence: string[] }[] }[];
  pendingGroupIds: string[];
  stopReasons: string[];
  limitation: string;
}

const retiredReasons = new Set(['traversal_position_changed', 'boundary_already_exited', 'boundary_document_changed', 'exploration_scope_invalidated', 'purpose_review_invalidated', 'purpose_review_replaced', 'control_review_invalidated', 'control_review_replaced', 'control_classified_noninteractive']);

/** Explain actual execution separately from scheduling decisions. Does not change the frontier. */
export function auditExploration(session: Session, frontier: FrontierItem[], attempts: ActionAttempt[], observations: Observation[], groups: ExplorationGroup[], equivalents = new Map<string, EquivalentCoverage>()): ExplorationAudit {
  const byAttempt = new Map(attempts.filter(a => a.sessionId === session.id).map(a => [a.id, a]));
  const byObservation = new Map(observations.filter(o => o.sessionId === session.id).map(o => [o.id, o]));
  const byGroup = new Map(groups.filter(g => g.sessionId === session.id).map(g => [g.id, g]));
  const cases: ExplorationAudit['cases'] = frontier.map(f => {
    const policies: ExplorationAudit['cases'][number]['policies'] = [];
    let excluded = false, waiting = false, invalidReference = false;
    for (const ref of f.explorationGroups || []) {
      const g = byGroup.get(ref.groupId);
      if (!g) { invalidReference = true; continue; }
      // An arbitrary/stale reference cannot erase an untested case from the audit.
      if (ref.memberKey ? ref.memberKey !== f.key || !g.members.some(m => m.key === ref.memberKey) : !g.traversalKeys?.includes(f.key)) { invalidReference = true; continue; }
      const d = g.decisions.at(-1);
      const observed = byObservation.get(f.action.observationId);
      const invalidated = g.invalidation && byObservation.get(g.invalidation.observationId);
      // Archived decisions explain historical non-execution only. They grant no
      // permission to a new document, context, case or post-invalidation action.
      if (!observed || contextKey(observed.context) !== g.contextKey
        || g.binding !== 'context' && observed.instanceScope !== g.instanceScope
        || g.status === 'invalidated' && (!d || !invalidated || d.revision >= g.revision
          || !(Date.parse(d.at) <= Date.parse(invalidated.capturedAt))
          || !(Date.parse(observed.capturedAt) < Date.parse(invalidated.capturedAt)))) {
        invalidReference = true; continue;
      }
      if (!d) { waiting = true; continue; }
      policies.push({ groupId: g.id, groupKind: g.kind, revision: g.revision, decisionRevision: d.revision, at: d.at,
        validity: g.status === 'invalidated' ? 'historical' : 'current', mode: d.decision.mode, source: d.decision.source, evidence: d.decision.evidence });
      excluded ||= d.decision.mode === 'skip' || d.decision.mode === 'sample' && (!ref.memberKey || !d.decision.memberKeys.includes(ref.memberKey));
      waiting ||= d.decision.mode === 'defer';
    }
    const last = f.attempts.length ? byAttempt.get(f.attempts.at(-1)!) : undefined;
    const equivalent = equivalents.get(f.id);
    let disposition: ExplorationCaseDisposition, reason: string;
    if (f.attempts.length) {
      const before = last && byObservation.get(last.beforeId), after = last?.afterId && byObservation.get(last.afterId);
      const sameTarget = last && (last.action.localId === f.action.localId && last.action.observationId === f.action.observationId
        || !!last.action.controlId && last.action.controlId === f.action.controlId);
      if (last?.status === 'succeeded' && before && after && last.action.observationId === before.id
        && last.action.kind === f.action.kind && canonical(last.action.value) === canonical(f.action.value) && sameTarget
        && !before.gaps.some(g => g.critical) && !after.gaps.some(g => g.critical)) {
        disposition = 'succeeded'; reason = 'successful_attempt_with_observations';
      } else {
        disposition = 'blocked'; reason = !last || last.status === 'succeeded' ? 'execution_evidence_missing_or_incomplete' : `attempt_${last.status}`;
      }
    } else if (equivalent && byAttempt.get(equivalent.attemptId)?.status === 'succeeded'
      && byObservation.has(equivalent.beforeId) && byObservation.has(equivalent.afterId)) {
      disposition = 'covered_equivalent'; reason = 'equivalent_operation_sample_with_observations';
    } else if (excluded && !invalidReference && f.action.boundary?.intent !== 'exit') {
      disposition = 'policy_excluded'; reason = 'explicit_scope_policy';
    } else if (f.status === 'superseded' && retiredReasons.has(f.reason || '')) {
      disposition = 'retired'; reason = f.reason!;
    } else if (invalidReference) {
      disposition = 'blocked'; reason = 'scope_reference_unverified';
    } else if (waiting || f.reason === 'region_review_required') {
      disposition = 'awaiting_decision'; reason = f.reason || 'scope_decision_required';
    } else if (f.status === 'pending' || f.status === 'executing') {
      disposition = 'pending'; reason = f.status;
    } else {
      disposition = 'blocked'; reason = f.status === 'executed' ? 'execution_evidence_missing_or_incomplete' : f.reason || f.status;
    }
    return { frontierId: f.id, actionId: f.action.id, label: f.action.label, kind: f.action.kind, observationId: f.action.observationId,
      disposition, reason, schedulingReason: f.reason, attemptIds: [...f.attempts], policies,
      ...(disposition === 'covered_equivalent' ? { equivalentTo: equivalent } : {}) };
  });
  const counts: ExplorationAudit['counts'] = { succeeded: 0, covered_equivalent: 0, policy_excluded: 0, awaiting_decision: 0, pending: 0, blocked: 0, retired: 0, notAttempted: 0 };
  for (const c of cases) { counts[c.disposition]++; if (!c.attemptIds.length) counts.notAttempted++; }
  const pendingGroupIds = groups.filter(g => g.sessionId === session.id && g.status !== 'invalidated' && (!g.decisions.length || g.decisions.at(-1)?.decision.mode === 'defer')).map(g => g.id);
  const current = session.currentObservationId && byObservation.get(session.currentObservationId);
  const stopReasons: string[] = [];
  if (!current) stopReasons.push('current_observation_missing');
  else {
    if (current.gaps.some(g => g.critical)) stopReasons.push('current_observation_incomplete');
    if (current.boundaries?.length) stopReasons.push('active_boundary');
  }
  if (session.stopReason && !['known_frontier_exhausted', 'known_frontier_exhausted_with_gaps', 'LIST_DECISION_REQUIRED', 'EXPLORATION_DECISION_REQUIRED', 'EXPLORATION_DEFERRED', 'REGION_REVIEW_REQUIRED', 'PAGE_DECISION_REQUIRED', 'PAGE_EXPLORATION_DEFERRED'].includes(session.stopReason)) stopReasons.push(session.stopReason);
  const status = counts.blocked || stopReasons.length ? 'blocked' : counts.pending || session.status === 'running' ? 'in_progress'
    : counts.awaiting_decision || pendingGroupIds.length ? 'awaiting_decision' : session.status === 'finished' ? 'complete' : 'in_progress';
  return { unit: 'discovered_action_cases', status, discoveryComplete: false, counts, cases, pendingGroupIds, stopReasons,
    limitation: 'Complete only means all recorded cases have successful execution, equivalent operation-sample evidence, or explicit scope exclusion/retirement. Equivalent cases were not dispatched again; exclusions are not coverage. Undiscovered controls, value combinations, business assertions and adapter discovery gaps require separate verification.' };
}
