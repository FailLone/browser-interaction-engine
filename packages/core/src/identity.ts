import type { ControlIdentity, IdentityHypothesis, Observation, UIState, Control, StateGrouping } from './types.js';
import { canonical, hash, id, now, clone as structuredClone } from './util.js';
export function matchIdentities<C extends Control>(observation: Observation<C>, identities: ControlIdentity<C>[], hypotheses: IdentityHypothesis[], signature: (control: C) => string) {
  // Decide against one immutable view of history. New identities and updates from
  // this observation must not become evidence for controls later in DOM order.
  const history = identities.map(i => ({ ...i, lastControl: structuredClone(i.lastControl) }));
  const byId = new Map(history.map(i => [i.id, i]));
  const byKey = new Map<string, ControlIdentity<C>[]>();
  const superseded = new Set(hypotheses.filter(h => h.status === 'resolved' && h.revisions.at(-1)?.identityId !== h.provisionalIdentityId).map(h => h.provisionalIdentityId));
  const keyFor = (control: C, sig: string) => canonical([control.identityScope === 'instance'
    ? ['instance', control.instanceId, control.region, control.role, control.stableKey || sig]
    : control.stableKey ? ['key', control.region, control.role, control.stableKey] : ['semantic', sig],
    control.identityContext?.scope, control.identityContext?.binding]);
  for (const identity of history) {
    if (superseded.has(identity.id) || identity.lastControl.identityScope === 'instance' && identity.status !== 'present') continue;
    const key = keyFor(identity.lastControl, identity.signature);
    byKey.set(key, [...(byKey.get(key) || []), identity]);
  }
  const entries = observation.controls.map(control => {
    const sig = signature(control);
    return { control, sig, key: keyFor(control, sig) };
  });
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) groups.set(entry.key, [...(groups.get(entry.key) || []), entry]);
  const plans = entries.map(entry => {
    const { control, key } = entry;
    const historical = byKey.get(key) || [];
    const current = groups.get(key)!;
    // Component test IDs often describe a class of controls. Refine collisions
    // using independently collected semantics, without changing the public key.
    // Unlabelled alternatives remain possible: missing evidence is not a mismatch.
    const refined = !!control.stableKey && !!(control.label || control.name) && (historical.length > 1 || current.length > 1);
    const candidates = refined ? historical.filter(i => i.signature === entry.sig || !(i.lastControl.label || i.lastControl.name)) : historical;
    const duplicates = refined ? current.filter(e => e.sig === entry.sig || !(e.control.label || e.control.name)) : current;
    const compatible = (previous: C) => keyFor(previous, signature(previous)) === key && (!refined || signature(previous) === entry.sig);
    const evidence = control.stableKey ? ['scoped-stable-key', 'compatible-role'] : ['adapter-semantic-signature'];
    if (control.identityScope === 'instance') evidence.push('current-instance-only');
    if (refined) evidence.push('shared-key-refined-by-semantics');
    evidence.push(...(control.identityContext?.evidence || []));
    if (duplicates.length > 1) evidence.push('duplicate-current-candidates');
    // An earlier human decision or pending hypothesis only follows the same
    // element while its binding remains compatible. Virtual rows recycle nodes.
    const anchored = hypotheses.findLast(h => {
      const identity = byId.get(h.provisionalIdentityId);
      const previous = identity?.lastControl;
      if (previous?.identityScope === 'instance' && identity?.status !== 'present') return false;
      return previous?.instanceId === control.instanceId && compatible(previous);
    });
    let chosen: string | undefined;
    let retained: IdentityHypothesis | undefined;
    if (anchored?.status === 'resolved') {
      const revision = anchored.revisions.at(-1);
      const identity = revision && byId.get(revision.identityId);
      if (identity && compatible(identity.lastControl) && !superseded.has(identity.id)) {
        chosen = identity.id;
        evidence.push('external-resolution', ...revision!.evidence);
      }
    } else if (anchored?.status === 'pending') {
      chosen = anchored.provisionalIdentityId; retained = anchored;
      evidence.push('unresolved-hypothesis-retained');
    }
    if (!chosen && candidates.length === 1 && duplicates.length === 1 && (!refined || candidates[0].signature === entry.sig) && (control.stableKey || control.name || control.label || control.identityContext?.binding || control.identityContext?.scope)) chosen = candidates[0].id;
    return { ...entry, candidates, duplicates, evidence, chosen, retained };
  });
  const claims = new Map<string, number>();
  for (const plan of plans) if (plan.chosen) claims.set(plan.chosen, (claims.get(plan.chosen) || 0) + 1);
  const claimed = new Set<string>(); const pending: IdentityHypothesis[] = [];
  const mutableById = new Map(identities.map(i => [i.id, i]));
  for (const plan of plans) {
    const { control, sig, candidates, duplicates, evidence, retained } = plan;
    // Never carry stale IDs supplied by an adapter into a new observation.
    delete control.identityId; delete control.hypothesisId;
    if (plan.chosen && claims.get(plan.chosen) === 1) {
      const identity = mutableById.get(plan.chosen)!;
      control.identityId = identity.id;
      if (retained) control.hypothesisId = retained.id;
      evidence.push(identity.lastControl.instanceId === control.instanceId ? 'same-instance' : 'instance-rebuilt');
      if (canonical(identity.occurrences.at(-1)?.context) !== canonical(observation.context)) evidence.push('business-binding-changed');
      identity.occurrences.push({ observationId: observation.id, localId: control.localId, instanceId: control.instanceId, context: observation.context, evidence });
      identity.lastControl = structuredClone(control); identity.signature = sig; identity.status = 'present'; claimed.add(identity.id);
      continue;
    }
    const identityId = id(); control.identityId = identityId;
    const contested = !!plan.chosen && claims.get(plan.chosen)! > 1;
    if (candidates.length > 0 || duplicates.length > 1 || contested) {
      if (contested) evidence.push('competing-current-matches');
      const h: IdentityHypothesis = { id: id(), sessionId: observation.sessionId, observationId: observation.id, localId: control.localId, provisionalIdentityId: identityId, candidateIds: [...new Set([...candidates.map(i => i.id), ...(plan.chosen ? [plan.chosen] : [])])], evidence, conflicts: [duplicates.length > 1 || contested ? 'multiple-current-controls' : 'multiple-historical-controls'], status: 'pending', revisions: [] };
      control.hypothesisId = h.id; pending.push(h);
    }
    identities.push({ id: identityId, sessionId: observation.sessionId, createdAt: now(), signature: sig, stableKey: control.stableKey, occurrences: [{ observationId: observation.id, localId: control.localId, instanceId: control.instanceId, context: observation.context, evidence: ['first-occurrence'] }], lastControl: structuredClone(control), status: 'present' });
    claimed.add(identityId);
  }
  for (const identity of identities) if (!claimed.has(identity.id)) {
    identity.status = observation.gaps.some(g => g.critical) ? 'unknown' : identity.lastControl.instanceId.startsWith(observation.instanceScope) ? 'removed' : 'not_observed';
  }
  // Include every contemporaneous alternative, but never cross conflicting keys.
  for (const h of pending) {
    const plan = plans.find(e => e.control.localId === h.localId)!;
    h.candidateIds = [...new Set([...h.candidateIds, ...plan.duplicates.filter(e => e.control !== plan.control).map(e => e.control.identityId!)])];
  }
  return { identities, hypotheses: pending };
}

/** Strict observable equality; graph membership alone supplies no such evidence. */
export function sameObservedState(before: Observation, after: Observation): boolean {
  return !before.gaps.some(g => g.critical) && !after.gaps.some(g => g.critical)
    && before.ruleVersion === after.ruleVersion && before.canonical === after.canonical;
}

export function assignState(o: Observation, states: UIState[], normalize: (observation: Observation) => string, projection?: StateGrouping): UIState {
  o.canonical = normalize(o); o.fingerprint = hash(o.canonical);
  if (projection && !o.gaps.some(g => g.critical)) {
    o.stateGrouping = projection.policy;
    const fingerprint = hash(projection.canonical);
    const stateId = hash({ kind: 'state-group', sessionId: o.sessionId, ruleVersion: o.ruleVersion, policy: projection.policy, fingerprint });
    const prior = states.find(s => s.id === stateId && s.grouping?.policy === projection.policy && s.grouping.canonical === projection.canonical);
    const state: UIState = prior || { id: stateId, sessionId: o.sessionId, fingerprint: o.fingerprint, canonical: o.canonical,
      ruleVersion: o.ruleVersion, observationIds: [], context: o.context,
      grouping: { ...projection, fingerprint, observationCount: 0, memberReferences: 'first-and-latest' } };
    if (state.observationIds.at(-1) !== o.id) state.grouping!.observationCount++;
    state.observationIds = [...new Set([state.observationIds[0] || o.id, o.id])];
    o.stateId = state.id; return state;
  }
  delete o.stateGrouping;
  const prior = !o.gaps.some(g => g.critical) && states.find(s => !s.grouping && s.ruleVersion === o.ruleVersion && s.fingerprint === o.fingerprint && s.canonical === o.canonical);
  const state = prior || { id: id(), sessionId: o.sessionId, fingerprint: o.fingerprint, canonical: o.canonical, ruleVersion: o.ruleVersion, observationIds: [], context: o.context };
  if (!state.observationIds.includes(o.id)) state.observationIds.push(o.id); o.stateId = state.id; return state;
}
