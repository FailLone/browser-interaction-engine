import { canonical, id, type InteractionAdapter, type EvidenceStore, type Predicate, type InteractionScope } from '@interaction/core';
import { BrowserAdapter } from './browser.js';
import { observableCanonical, compareObservations } from './model.js';
import { sessionSchema } from './schema.js';
import { signature } from './util.js';
import { constrain } from './policy.js';
import { explorationCase, restorationStep } from './exploration.js';
import type { ActionCandidate, Control, EngineHooks, Observation, Session, SessionOptions } from './types.js';
export * from './types.js';
export { sessionSchema, commandSchema, predicateSchema, domQuerySchema, artifactKindSchema } from './schema.js';
export type { Command } from './schema.js';
export { compareObservations, observableCanonical } from './model.js';

export class PlaywrightAdapter implements InteractionAdapter<Observation, SessionOptions> {
  readonly ruleVersion = 'observable-v3';
  constructor(private hooks: EngineHooks = {}) {}
  parseOptions(input: unknown) { return sessionSchema.parse(input) as SessionOptions; }
  createDriver(options: SessionOptions, evidence: EvidenceStore) { return new BrowserAdapter(options, evidence, this.hooks); }
  signature = signature;
  normalize = observableCanonical;
  compare = compareObservations;
  constrain = constrain;
  explorationCase = explorationCase;
  explorationScope(o: Observation) { return canonical({ url: o.url, boundaries: o.boundaries?.map(b => b.key) || [] }); }
  restorationStep = restorationStep;
  testPredicate(predicate: Predicate, observation: Observation): 'pass' | 'fail' | 'unknown' {
    if (predicate.target === 'url') return observation.url === predicate.equals ? 'pass' : 'fail';
    if (predicate.target === 'context') { const value = observation.context[predicate.key || '']; return !value || value.status === 'unknown' ? 'unknown' : canonical(value.value) === canonical(predicate.equals) ? 'pass' : 'fail'; }
    const control = observation.controls.find(c => c.identityId === predicate.identityId);
    if (!control || control.hypothesisId || !predicate.field || !['value', 'checked', 'visible', 'enabled'].includes(predicate.field)) return 'unknown';
    return canonical(control[predicate.field as 'value']) === canonical(predicate.equals) ? 'pass' : 'fail';
  }
  replayMatches(candidate: ActionCandidate, recorded: ActionCandidate) { return candidate.controlId === recorded.controlId && candidate.kind === recorded.kind && (candidate.kind === 'fill' || canonical(candidate.value) === canonical(recorded.value)); }
  returnAction(actions: ActionCandidate[]) { return actions.find(a => a.boundary?.intent === 'exit' && a.risk === 'interface' && a.replayable && a.basis?.status !== 'tentative' && !a.excluded && a.preconditions.visible && a.preconditions.enabled && a.preconditions.identityResolved && !a.preconditions.blockers?.length); }
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
