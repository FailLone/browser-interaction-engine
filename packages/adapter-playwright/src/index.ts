export { traversalScrollSchema } from './scroll-containers.js';
import { scrollProbeSchema } from './scroll-probe.js';
export { scrollProbeSchema } from './scroll-probe.js';
export type { ScrollProbeOptions } from './scroll-probe.js';
import { hasReviewedDismissal } from './boundary-exit.js';
import { nativeFormScope } from './dependencies.js';
import { canonical, id, EngineError, type InteractionAdapter, type EvidenceStore, type Predicate, type InteractionScope } from '@interaction/core';
import { BrowserAdapter } from './browser.js';
import { observableCanonical, compareObservations, browserStateGrouping } from './model.js';
import { sessionSchema } from './schema.js';
import { signature } from './util.js';
import { constrain, hasDeclaredBoundaryExit, hasObservedBoundaryExit } from './policy.js';
import { browserControlCorrespondence, browserOperationCorrespondenceHint, controlCase, controlsTraversalCase, explorationCase, restorationStep, verifyRestorationStep } from './exploration.js';
export { browserControlCorrespondence, browserControlBindingKey, browserOperationCorrespondenceHint, browserOperationKey, browserOperationSchedulingKey, legacyBrowserOperationKey } from './exploration.js';
export { navigationIntent, type NavigationIntent } from './navigation.js';
import { historyReturn, observedSourcePosition } from './navigation.js';
import { browserTargetConditions, browserTargetReady, browserTargetRecoverable } from './target-arrival.js';
import { browserControlReviewTargetCorrespondence, createBrowserControlReviewTargetCorrespondenceReader } from './review-target.js';
export { browserControlReviewTargetCorrespondence, createBrowserControlReviewTargetCorrespondenceReader, browserControlReviewMaterialKey, createBrowserControlReviewMaterialKey } from './review-target.js';
export { browserTargetConditions, browserTargetReady, browserTargetRecoverable } from './target-arrival.js';
import { listGroups, structuralListGroups } from './list-groups.js';
import { decisionScopes } from './decision-scopes.js';
import type { ActionCandidate, Control, EngineHooks, Observation, Session, SessionOptions } from './types.js';
export * from './types.js';
export { createOwnerDependencyCodec } from './owner-dependency-codec.js';
export type { OwnerDependencyCodec, OwnerDependencyBuilder } from './owner-dependency-codec.js';
export * from './boundary-exit.js';
export * from './purpose-review.js';
export * from './control-review.js';
export * from './control-classification.js';
export { classificationCorrespondenceConditions } from './classification-correspondence.js';
export * from './discovery-scan.js';
export * from './interventions.js';
export { interventionResponseSchema, continuationSchema } from './schema.js';
export { BrowserAdapter } from './browser.js';
export { sessionSchema, commandSchema, regionReviewSchema, reuseRegionReviewsSchema, revokeRegionReuseSchema, predicateSchema, domQuerySchema, artifactKindSchema } from './schema.js';
export type { Command } from './schema.js';
export { compareObservations, observableCanonical } from './model.js';

export class PlaywrightAdapter implements InteractionAdapter<Observation, SessionOptions> {
  explorationTargetConditions = browserTargetConditions;
  explorationTargetReady = browserTargetReady;
  explorationTargetRecoverable = browserTargetRecoverable;
  controlReviewTargetCorrespondence = browserControlReviewTargetCorrespondence;
  createControlReviewTargetCorrespondenceReader(before: Observation, current: Observation) {
    // An existing callback override remains authoritative; only the default
    // closed projection chain opts into shared derived facts.
    return this.controlReviewTargetCorrespondence === browserControlReviewTargetCorrespondence
      ? createBrowserControlReviewTargetCorrespondenceReader(before, current)
      : (source: Control, target: Control) => this.controlReviewTargetCorrespondence(source, before, target, current);
  }
  controlCorrespondence = browserControlCorrespondence;
  operationCorrespondenceHint = browserOperationCorrespondenceHint;
  correspondenceCase(a: ActionCandidate,o: Observation) { return controlCase(a,o,true); }
  private static readonly defaultCorrespondenceCase=PlaywrightAdapter.prototype.correspondenceCase;
  get receiptIdentityScope() {
    return this.correspondenceCase===PlaywrightAdapter.defaultCorrespondenceCase?'captured-operation-controls-v1' as const:undefined;
  }
  readonly ruleVersion = 'observable-v8';
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
  reviewBinding = (control: Control) => control.reviewAttributes;
  probeAction(kind: string, control: Control, observation: Observation, session: Session, parameters?: ActionCandidate['value']): ActionCandidate {
    if (!['hover', 'focus', 'scroll'].includes(kind)) throw new EngineError('UNSUPPORTED_PROBE', 'Supported browser probes are hover, focus and controlled scroll');
    const value = kind === 'scroll' ? scrollProbeSchema.parse(parameters) : undefined;
    if (kind !== 'scroll' && parameters !== undefined) throw new EngineError('INVALID_INPUT', 'This probe does not accept parameters');
    if (value && value.documentId !== observation.documentId) throw new EngineError('STALE_OBSERVATION', 'Scroll probe document does not match');
    return { id: id(), sessionId: session.id, observationId: observation.id, stateId: observation.stateId,
      ...(value ? { value } : {}),
      controlId: control.identityId, localId: control.localId, kind, label: `${kind}: ${control.name || control.role}`, source: 'external-probe',
      risk: 'unknown', replayable: false, excluded: false, sampleValidity: 'known',
      target: { kind: 'instance', instanceScope: observation.instanceScope, instanceId: control.instanceId, evidence: [`observation:${observation.id}`, 'Explicit probe of a current node; effects are unknown'] },
      basis: { status: 'supported', evidence: [{ source: 'browser-operation', rule: 'explicit-probe/v1', facts: { kind, effects: 'unknown' } }] },
      preconditions: { context: observation.context, visible: control.visible, enabled: control.enabled, identityResolved: !control.hypothesisId } };
  }
  normalize = observableCanonical;
  stateGrouping = browserStateGrouping;
  readonly explorationCaseRevision = 'browser-branch-conditions-v2';
  compare = compareObservations;
  constrain = constrain;
  explorationCase(a: ActionCandidate, o: Observation, s: Session) { return s.options.exploration === 'controls' ? controlsTraversalCase(a, o) : explorationCase(a, o); }
  legacyExplorationCases(a: ActionCandidate, o: Observation, s: Session) {
    const previous = s.options.exploration === 'representative' ? explorationCase(a, o, 'v1') : undefined;
    return previous ? [previous] : [];
  }
  explorationScope(o: Observation) { return canonical({ url: o.url, boundaries: o.boundaries?.map(b => b.key) || [] }); }
  restorationStep = restorationStep;
  verifyRestorationStep = verifyRestorationStep;
  explorationGroups(...args: Parameters<typeof listGroups>) { return [...listGroups(...args), ...structuralListGroups(...args), ...decisionScopes(args[0], args[1], args[2])]; }
  returnToObservation = historyReturn;
  observedSourcePosition = observedSourcePosition;
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
      && (hasReviewedDismissal(a, observation) || a.replayable && a.preconditions.identityResolved
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

export * from './exploration-decision-reuse.js';
