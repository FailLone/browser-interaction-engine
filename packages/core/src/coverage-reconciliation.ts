import type { ActionAttempt, ActionCandidate, Control, FrontierItem, IdentityHypothesis, Observation, Session } from './types.js';
import type { ExplorationCase } from './ports.js';
import { canonical, hash } from './util.js';

/** Read-time identity projection. Historical observations and dispatch bindings stay immutable. */
export function identityResolver(hypotheses: IdentityHypothesis[]) {
  const byId = new Map(hypotheses.map(h => [h.id, h]));
  const aliases = new Map(hypotheses.filter(h => h.status === 'resolved' && h.revisions.length)
    .map(h => [h.provisionalIdentityId, h.revisions.at(-1)!.identityId]));
  const pending = new Set(hypotheses.filter(h => h.status === 'pending').map(h => h.provisionalIdentityId));
  return (c: Control): string | undefined => {
    if (!c.identityId || c.identityScope === 'instance') return;
    if (c.hypothesisId && byId.get(c.hypothesisId)?.status !== 'resolved') return;
    let identity = c.identityId; const seen = new Set<string>();
    while (aliases.has(identity) && aliases.get(identity) !== identity) {
      if (seen.has(identity)) return;
      seen.add(identity); identity = aliases.get(identity)!;
    }
    return pending.has(identity) ? undefined : identity;
  };
}

export interface EquivalentCoverage {
  attemptId: string; beforeId: string; afterId: string;
  identityId?: string; policy: string; evidence: string[];
}

/** A correspondence is evidence for scheduling, never an identity or replay grant. */
export interface CorrespondenceHint {
  key: string; policy: string; evidence: string[]; invalidatedBy: string[];
}
export interface OperationCorrespondence {
  equivalent: boolean; reason: string; policy?: string; evidence: string[];
  source: { sessionId: string; attemptId: string; beforeId?: string; afterId?: string };
  target: { sessionId: string; observationId: string; actionId: string };
  invalidatedBy: string[]; identityAuthorized: false; replayAuthorized: false; currentExecution: false;
}

/** Shared sample eligibility for coverage reconciliation and cross-session references. */
export function operationSample<O extends Observation>(a: ActionCandidate, o: O, sample: (a: ActionCandidate, o: O) => ExplorationCase | undefined) {
  if (a.sessionId !== o.sessionId || a.observationId !== o.id || a.basis?.status !== 'supported' || o.gaps.some(g => g.critical)
    || canonical(a.preconditions.context) !== canonical(o.context) || Object.values(o.context).some(c => c.status !== 'known')) return;
  const result = sample(a, o);
  return result && { ...result, key: hash({ policy: result.policy, sample: result.key, kind: a.kind, value: a.value, context: o.context, risk: a.risk }) };
}

/** Successful operation samples may discharge equivalent unattempted work, never failed attempts.
 * This is coverage only: it grants no identity, scope, replay or dispatch permission. */
export function reconcileCoverage<O extends Observation>(session: Session, frontier: FrontierItem[], attempts: ActionAttempt[], observations: O[],
  hypotheses: IdentityHypothesis[], sample: (a: ActionCandidate, o: O) => ExplorationCase | undefined): Map<string, EquivalentCoverage> {
  const result = new Map<string, EquivalentCoverage>();
  if (session.options.exploration !== 'controls') return result;
  const resolve = identityResolver(hypotheses.filter(h => h.sessionId === session.id));
  const byObservation = new Map(observations.filter(o => o.sessionId === session.id).map(o => [o.id, o]));
  const controls = new Map([...byObservation].map(([id, o]) => [id, new Map(o.controls.map(c => [c.localId, c]))]));
  const identityCounts = new Map([...byObservation].map(([id, o]) => {
    const counts = new Map<string, number>();
    for (const c of o.controls) { const identity = resolve(c); if (identity) counts.set(identity, (counts.get(identity) || 0) + 1); }
    return [id, counts] as const;
  }));
  const keys = new WeakMap<ActionCandidate, ReturnType<typeof key>>();
  function key(a: ActionCandidate) {
    const o = byObservation.get(a.observationId);
    if (!o || a.sessionId !== session.id || !a.controlId || a.basis?.status !== 'supported' || o.gaps.some(g => g.critical)) return;
    if (canonical(a.preconditions.context) !== canonical(o.context) || Object.values(o.context).some(c => c.status !== 'known')) return;
    const c = a.localId && controls.get(o.id)?.get(a.localId);
    if (!c || c.identityId !== a.controlId) return;
    const identity = resolve(c);
    // A contradictory decision cannot make two simultaneous targets equivalent.
    if (identity && identityCounts.get(o.id)?.get(identity) !== 1) return;
    const control = identity ? { ...c, identityId: identity, hypothesisId: undefined } : c;
    const action = identity ? { ...a, controlId: identity, target: undefined, preconditions: { ...a.preconditions, identityResolved: true } } : a;
    const projected = identity ? { ...o, controls: o.controls.map(old => old === c ? control : old) } : o;
    const s = operationSample(action, projected, sample);
    if (!s) return;
    return { key: hash({ sample: s.key, target: identity || [o.instanceScope, c.instanceId] }), identity, sample: s };
  }
  const cached = (a: ActionCandidate) => {
    // Supplied input variants can share an ID; cache only the exact action object.
    if (!keys.has(a)) keys.set(a, key(a));
    return keys.get(a);
  };
  const succeeded = new Map<string, EquivalentCoverage>();
  for (const a of attempts) {
    const before = byObservation.get(a.beforeId), after = a.afterId && byObservation.get(a.afterId);
    if (a.sessionId !== session.id || a.status !== 'succeeded' || !before || !after || a.action.observationId !== before.id
      || before.gaps.some(g => g.critical) || after.gaps.some(g => g.critical)) continue;
    const k = cached(a.action);
    if (k) succeeded.set(k.key, { attemptId: a.id, beforeId: before.id, afterId: after.id, identityId: k.identity,
      policy: k.sample.policy, evidence: k.sample.evidence });
  }
  for (const f of frontier) {
    if (f.sessionId !== session.id || f.attempts.length || ['executing', 'unknown'].includes(f.status)) continue;
    const k = cached(f.action), proof = k && succeeded.get(k.key);
    if (proof) result.set(f.id, proof);
  }
  return result;
}
