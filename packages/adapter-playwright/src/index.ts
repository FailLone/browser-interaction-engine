import { nativeFormScope } from './dependencies.js';
import { canonical, id, type InteractionAdapter, type EvidenceStore, type Predicate, type InteractionScope } from '@interaction/core';
import { BrowserAdapter } from './browser.js';
import { observableCanonical, compareObservations } from './model.js';
import { sessionSchema } from './schema.js';
import { signature } from './util.js';
import { constrain, hasDeclaredBoundaryExit, hasObservedBoundaryExit } from './policy.js';
import { controlCase, explorationCase, restorationStep } from './exploration.js';
import { historyReturn } from './navigation.js';
import { listGroups } from './list-groups.js';
import { decisionScopes } from './decision-scopes.js';
import type { ActionCandidate, Control, EngineHooks, Observation, Session, SessionOptions } from './types.js';
export * from './types.js';
export * from './purpose-review.js';
export * from './control-review.js';
export { sessionSchema, commandSchema, regionReviewSchema, predicateSchema, domQuerySchema, artifactKindSchema } from './schema.js';
export type { Command } from './schema.js';
export { compareObservations, observableCanonical } from './model.js';

export class PlaywrightAdapter implements InteractionAdapter<Observation, SessionOptions> {
  readonly ruleVersion = 'observable-v3-live-v2';
  validationScope(action: ActionCandidate, observation: Observation) {
    const target = observation.controls.find(c => c.localId === action.localId);
    return action.risk === 'interface' && target ? nativeFormScope(target, action.kind) : undefined;
  }
  actionObservationReady(action: ActionCandidate, before: Observation, after: Observation) {
    if (!after.gaps.some(g => g.code === 'PARTIAL_INTERACTION_READY')) return true;
    const target = before.controls.find(c => c.localId === action.localId);
    const scope = this.validationScope(action, before);
    return !!target && !!scope && !!after.controls.find(c => c.instanceId === target.instanceId && !c.readiness && nativeFormScope(c, action.kind) === scope);
  }
  constructor(private hooks: EngineHooks = {}) {}
  parseOptions(input: unknown) { return sessionSchema.parse(input) as SessionOptions; }
  createDriver(options: SessionOptions, evidence: EvidenceStore) { return new BrowserAdapter(options, evidence, this.hooks); }
  signature = signature;
  normalize = observableCanonical;
  compare = compareObservations;
  constrain = constrain;
  explorationCase(a: ActionCandidate, o: Observation, s: Session) { return s.options.exploration === 'controls' ? controlCase(a, o) : explorationCase(a, o); }
  explorationScope(o: Observation) { return canonical({ url: o.url, boundaries: o.boundaries?.map(b => b.key) || [] }); }
  restorationStep = restorationStep;
  explorationGroups(...args: Parameters<typeof listGroups>) { return [...listGroups(...args), ...decisionScopes(args[0], args[1], args[2])]; }
  returnToObservation = historyReturn;
  testPredicate(predicate: Predicate, observation: Observation): 'pass' | 'fail' | 'unknown' {
    if (predicate.target === 'url') return observation.url === predicate.equals ? 'pass' : 'fail';
    if (predicate.target === 'context') { const value = observation.context[predicate.key || '']; return !value || value.status === 'unknown' ? 'unknown' : canonical(value.value) === canonical(predicate.equals) ? 'pass' : 'fail'; }
    const control = observation.controls.find(c => c.identityId === predicate.identityId);
    if (!control || control.hypothesisId || !predicate.field || !['value', 'checked', 'visible', 'enabled'].includes(predicate.field)) return 'unknown';
    return canonical(control[predicate.field as 'value']) === canonical(predicate.equals) ? 'pass' : 'fail';
  }
  replayMatches(candidate: ActionCandidate, recorded: ActionCandidate) { return candidate.controlId === recorded.controlId && candidate.kind === recorded.kind && (candidate.kind === 'fill' || canonical(candidate.value) === canonical(recorded.value)); }
  returnAction(actions: ActionCandidate[], observation: Observation) {
    return actions.find(a => a.boundary?.intent === 'exit' && a.risk === 'interface' && a.basis?.status !== 'tentative' && !a.excluded
      && a.preconditions.visible && a.preconditions.enabled && !a.preconditions.blockers?.length
      && (a.replayable && a.preconditions.identityResolved
        || a.observationId === observation.id && a.preconditions.targetResolved
          && (hasDeclaredBoundaryExit(a, observation) || hasObservedBoundaryExit(a, observation))));
  }
  entryAction(observation: Observation, session: Session): ActionCandidate {
    return { id: id(), sessionId: session.id, observationId: observation.id, stateId: observation.stateId, kind: 'navigate', value: session.options.url, label: 'Reopen session entry', source: 'recovery-entry', risk: 'interface', replayable: false, excluded: false, sampleValidity: 'known', preconditions: { context: observation.context, visible: true, enabled: true, identityResolved: true } };
  }
  resetAction(observation: Observation, session: Session): ActionCandidate | undefined {
    if (session.options.environmentReset !== 'document-reload') return;
    return { ...this.entryAction(observation, session), source: 'recovery-reset', label: 'Reset declared document-local environment',
      basis: { status: 'supported', evidence: [{ source: 'session-options', rule: 'declared-document-reset/v1', facts: { environmentReset: 'document-reload', entryUrl: session.options.url } }] } };
  }
  inRegion(control: Control, region: string, observation: Observation) {
    if (region === 'document') return true;
    let key = control.region; const seen = new Set<string>();
    while (key && !seen.has(key)) { if (key === region) return true; seen.add(key); key = observation.regions.find(r => r.key === key)?.parentKey || ''; }
    return false;
  }
}

export * from './inspection-contract.js';
