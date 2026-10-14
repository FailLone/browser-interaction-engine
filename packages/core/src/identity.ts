import type { ControlIdentity, IdentityHypothesis, Observation, UIState, Control } from './types.js';
import { canonical, hash, id, now, clone as structuredClone } from './util.js';
export function matchIdentities<C extends Control>(observation: Observation<C>, identities: ControlIdentity<C>[], hypotheses: IdentityHypothesis[], signature: (control: C) => string) {
  const claimed = new Set<string>(); const pending: IdentityHypothesis[] = [];
  for (const control of observation.controls) {
    const sig = signature(control);
    const explicit = hypotheses.filter(h => h.status === 'resolved').find(h => {
      const provisional = identities.find(i => i.id === h.provisionalIdentityId);
      return provisional?.lastControl.instanceId === control.instanceId;
    });
    let candidates: ControlIdentity<C>[] = [];
    let evidence: string[] = [];
    if (explicit) {
      const chosen = identities.find(i => i.id === explicit.revisions.at(-1)?.identityId);
      if (chosen) { candidates = [chosen]; evidence = ['external-resolution', ...explicit.revisions.at(-1)!.evidence]; }
    } else {
      const unresolved = hypotheses.find(h => h.status === 'pending' && identities.find(i => i.id === h.provisionalIdentityId)?.lastControl.instanceId === control.instanceId);
      if (unresolved) {
        control.identityId = unresolved.provisionalIdentityId; control.hypothesisId = unresolved.id;
        const provisional = identities.find(i => i.id === unresolved.provisionalIdentityId)!;
        provisional.occurrences.push({ observationId: observation.id, localId: control.localId, instanceId: control.instanceId, context: observation.context, evidence: ['unresolved-hypothesis-retained'] });
        provisional.lastControl = structuredClone(control); provisional.status = 'present'; claimed.add(provisional.id); continue;
      }
      if (control.stableKey) {
        candidates = identities.filter(i => i.stableKey === control.stableKey && i.lastControl.region === control.region && i.lastControl.role === control.role);
        evidence = ['scoped-stable-key', 'compatible-role'];
      }
      if (!candidates.length) { candidates = identities.filter(i => i.signature === sig); evidence = ['adapter-semantic-signature']; }
      // A node instance is supporting evidence, not an override for duplicate semantics.
      const duplicates = observation.controls.filter(c => control.stableKey ? c.stableKey === control.stableKey && c.region === control.region : signature(c) === sig);
      if (duplicates.length > 1 && candidates.length) evidence.push('duplicate-current-candidates');
      if (candidates.length === 1 && duplicates.length > 1) candidates = [];
    }
    candidates = candidates.filter(i => !claimed.has(i.id));
    const duplicates = observation.controls.filter(c => control.stableKey ? c.stableKey === control.stableKey && c.region === control.region : signature(c) === sig);
    if (candidates.length === 1 && (explicit || duplicates.length === 1 && !!(control.stableKey || control.label || control.name))) {
      const identity = candidates[0]; control.identityId = identity.id;
      if (identity.lastControl.instanceId === control.instanceId) evidence.push('same-instance');
      else evidence.push('instance-rebuilt');
      if (canonical(identity.occurrences.at(-1)?.context) !== canonical(observation.context)) evidence.push('business-binding-changed');
      identity.occurrences.push({ observationId: observation.id, localId: control.localId, instanceId: control.instanceId, context: observation.context, evidence });
      identity.lastControl = structuredClone(control); identity.status = 'present'; claimed.add(identity.id);
    } else {
      const identityId = id(); control.identityId = identityId;
      const similar = identities.filter(i => !claimed.has(i.id) && i.signature === sig);
      if (candidates.length > 1 || duplicates.length > 1 || similar.length > 0) {
        const h: IdentityHypothesis = { id: id(), sessionId: observation.sessionId, observationId: observation.id, localId: control.localId, provisionalIdentityId: identityId, candidateIds: [...new Set([...candidates, ...similar].map(i => i.id))], evidence, conflicts: [duplicates.length > 1 ? 'multiple-current-controls' : 'multiple-historical-controls'], status: 'pending', revisions: [] };
        control.hypothesisId = h.id; pending.push(h);
      }
      identities.push({ id: identityId, sessionId: observation.sessionId, createdAt: now(), signature: sig, stableKey: control.stableKey, occurrences: [{ observationId: observation.id, localId: control.localId, instanceId: control.instanceId, context: observation.context, evidence: ['first-occurrence'] }], lastControl: structuredClone(control), status: 'present' });
      claimed.add(identityId);
    }
  }
  for (const identity of identities) if (!claimed.has(identity.id)) {
    identity.status = observation.gaps.some(g => g.critical) ? 'unknown' : identity.lastControl.instanceId.startsWith(observation.instanceScope) ? 'removed' : 'not_observed';
  }
  // Include all contemporaneous alternatives, without silently merging them.
  for (const h of pending) {
    const c = observation.controls.find(c => c.localId === h.localId)!;
    h.candidateIds = [...new Set([...h.candidateIds, ...observation.controls.filter(x => x.localId !== c.localId && signature(x) === signature(c)).map(x => x.identityId!)])];
  }
  return { identities, hypotheses: pending };
}

export function assignState(o: Observation, states: UIState[], normalize: (observation: Observation) => string): UIState {
  o.canonical = normalize(o); o.fingerprint = hash(o.canonical);
  const prior = !o.gaps.some(g => g.critical) && states.find(s => s.ruleVersion === o.ruleVersion && s.fingerprint === o.fingerprint && s.canonical === o.canonical);
  const state = prior || { id: id(), sessionId: o.sessionId, fingerprint: o.fingerprint, canonical: o.canonical, ruleVersion: o.ruleVersion, observationIds: [], context: o.context };
  state.observationIds.push(o.id); o.stateId = state.id; return state;
}
