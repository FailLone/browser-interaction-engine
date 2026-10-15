import type { IdentityHypothesis, Observation } from '@interaction/browser';

/** Current uncertainty and historical unresolved records are separate counts. */
export function identitySummary(hypotheses: IdentityHypothesis[], current?: Observation) {
  const pending = hypotheses.filter(h => h.status === 'pending');
  const ids = new Set(pending.map(h => h.id));
  const controls = current?.controls.filter(c => c.hypothesisId && ids.has(c.hypothesisId)) || [];
  const count = new Set(controls.map(c => c.hypothesisId)).size;
  return { total: pending.length, current: current ? count : undefined, historical: current ? pending.length - count : undefined,
    actionable: current ? controls.filter(c => c.actions.length > 0).length : undefined };
}
