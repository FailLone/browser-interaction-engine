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

/** Composition-owned proof for a retained successful receipt. This is narrower
 * than an adapter sample: it is never consulted for arrival or replay. */
export type ReceiptCoverageReader<O extends Observation> = {
  (action: ActionCandidate, observation: O, attempt: ActionAttempt, before: O, after: O): ExplorationCase | undefined;
  /** Explicit alternative to logical identity resolution. The reader must bind
   * unique captured instances in one document/browser lifetime, complete raw
   * dependency conditions and actual dispatch evidence, and recheck authority.
   * This is coverage only; it cannot authorize identity, arrival or replay.
   * Omission preserves the caller's logical-identity requirements. */
  identityBasis?: 'same-document-instance-v1';
  /** Optional cheap exclusion only. A true result grants no equivalence. */
  acceptsObservation?: (observation: O) => boolean;
};

/** A correspondence is evidence for scheduling, never an identity or replay grant. */
export interface CorrespondenceHint {
  key: string; policy: string; evidence: string[]; invalidatedBy: string[];
  /** Operation references may require uniqueness even when an instance/identity is retained. */
  requiresUniqueTarget?: boolean;
}
export interface OperationCorrespondence {
  equivalent: boolean; reason: string; policy?: string; evidence: string[];
  source: { sessionId: string; attemptId: string; beforeId?: string; afterId?: string };
  target: { sessionId: string; observationId: string; actionId: string };
  invalidatedBy: string[]; identityAuthorized: false; replayAuthorized: false; currentExecution: false;
}

/** Actual execution and reusable condition evidence are separate facts. A
 * portable sample retains its adapter's sampling policy; a document sample is
 * bounded to that retained document. Neither is arrival or replay authority. */
export interface OperationReceiptCondition {
  actualSuccess: boolean; conditionVerified: boolean;
  status: 'portable' | 'document' | 'unavailable'; reason: string;
  policy?: string; conditionKey?: string; evidence: string[];
  source: { sessionId: string; attemptId: string; beforeId?: string; afterId?: string; actionId?: string; actionKey?: string };
  identityAuthorized: false; replayAuthorized: false; currentExecution: false; arrivalVerified: false;
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
  hypotheses: IdentityHypothesis[], sample: (a: ActionCandidate, o: O) => ExplorationCase | undefined,
  receiptCoverage?: ReceiptCoverageReader<O>): Map<string, EquivalentCoverage> {
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
  function key(a: ActionCandidate, possible?: Set<string>) {
    const o = byObservation.get(a.observationId);
    if (!o || a.sessionId !== session.id || !a.controlId || a.basis?.status !== 'supported' || o.gaps.some(g => g.critical)) return;
    if (canonical(a.preconditions.context) !== canonical(o.context) || Object.values(o.context).some(c => c.status !== 'known')) return;
    const c = a.localId && controls.get(o.id)?.get(a.localId);
    if (!c || c.identityId !== a.controlId) return;
    const identity = resolve(c);
    // A contradictory decision cannot make two simultaneous targets equivalent.
    if (identity && identityCounts.get(o.id)?.get(identity) !== 1) return;
    const target = identity || [o.instanceScope, c.instanceId];
    // These are necessary fields of the final key, not an equivalence proof.
    // Skip an expensive adapter projection only when no fully sampled success
    // can share its target, operation, input, declared context and risk.
    const necessary = canonical({ target, kind: a.kind, value: a.value, context: o.context, risk: a.risk });
    if (possible && !possible.has(necessary)) return;
    const control = identity ? { ...c, identityId: identity, hypothesisId: undefined } : c;
    const action = identity ? { ...a, controlId: identity, target: undefined, preconditions: { ...a.preconditions, identityResolved: true } } : a;
    const projected = identity ? { ...o, controls: o.controls.map(old => old === c ? control : old) } : o;
    const s = operationSample(action, projected, sample);
    if (!s) return;
    return { key: hash({ sample: s.key, target }), necessary, identity, sample: s };
  }
  const cached = (a: ActionCandidate, possible?: Set<string>) => {
    // Supplied input variants can share an ID; cache only the exact action object.
    if (!keys.has(a)) keys.set(a, key(a, possible));
    return keys.get(a);
  };
  const succeeded = new Map<string, EquivalentCoverage>();
  const possible = new Set<string>();
  // Index actual receipts by instance and input. The composition still checks
  // their complete evidence; this index only avoids all-pairs reconciliation.
  const retained = new Map<string, {attempt:ActionAttempt;before:O;after:O}[]>();
  const receiptKey = (action:ActionCandidate, o:O) => {
    const c=action.localId?controls.get(o.id)?.get(action.localId):undefined;
    return c?.instanceId&&o.instanceScope?canonical([o.instanceScope,c.instanceId,action.kind,action.value]):undefined;
  };
  const rawSamples = new WeakMap<ActionCandidate, ReturnType<typeof operationSample>>();
  const rawSample = (action:ActionCandidate,o:O) => {
    if(!rawSamples.has(action))rawSamples.set(action,operationSample(action,o,sample));
    return rawSamples.get(action);
  };
  for (const a of attempts) {
    const before = byObservation.get(a.beforeId), after = a.afterId && byObservation.get(a.afterId);
    if (a.sessionId !== session.id || a.status !== 'succeeded' || !before || !after || a.action.observationId !== before.id
      || before.gaps.some(g => g.critical) || after.gaps.some(g => g.critical)) continue;
    const k = cached(a.action);
    if (k) {
      possible.add(k.necessary);
      succeeded.set(k.key, { attemptId: a.id, beforeId: before.id, afterId: after.id, identityId: k.identity,
        policy: k.sample.policy, evidence: k.sample.evidence });
    }
    const index=receiptCoverage&&receiptCoverage.acceptsObservation?.(before)!==false&&receiptKey(a.action,before);
    if(index){const entries=retained.get(index)||[];entries.push({attempt:a,before,after});retained.set(index,entries);}
  }
  for (const f of frontier) {
    if (f.sessionId !== session.id || f.samplingMigration || f.attempts.length || ['executing', 'unknown'].includes(f.status)) continue;
    const k = possible.size ? cached(f.action, possible) : undefined, proof = k && succeeded.get(k.key);
    if (proof) { result.set(f.id, proof); continue; }
    const o=byObservation.get(f.action.observationId);
    if(!receiptCoverage||!o||receiptCoverage.acceptsObservation?.(o)===false)continue;
    const index=receiptKey(f.action,o);if(!index)continue;
    for(const {attempt,before,after} of retained.get(index)||[]){
      // An unavailable portable proof may have a narrower retained alternative.
      // Two known portable cases that differ must never be washed into equality.
      if(rawSample(f.action,o)&&rawSample(attempt.action,before))continue;
      const retainedProof=receiptCoverage(f.action,o,attempt,before,after);
      if(retainedProof){result.set(f.id,{attemptId:attempt.id,beforeId:before.id,afterId:after.id,
        policy:retainedProof.policy,evidence:retainedProof.evidence});break;}
    }
  }
  return result;
}
