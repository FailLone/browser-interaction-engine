import { canonical, id, now, sessionSchema, EngineError, type InteractionAdapter, type InteractionDriver, type Observation, type ObservationData, type SessionOptions, type Session, type ActionCandidate, type Predicate, type Diff } from '@interaction/core';

/** A non-UI state machine: no URL, DOM, browser, network or filesystem. */
export interface CounterObservation extends Observation { count: number }
export class CounterDriver implements InteractionDriver<CounterObservation, SessionOptions> {
  private count = 0;
  private scope = id();
  private active = false;
  async start() { this.active = true; }
  connected() { return this.active; }
  async capture(): Promise<ObservationData<CounterObservation>> {
    return { count: this.count, instanceScope: this.scope, capturedAt: now(), controls: [{ localId: 'counter', instanceId: `${this.scope}:counter`, stableKey: 'counter', name: 'Counter', label: 'Counter', role: 'accumulator', region: 'machine', visible: true, enabled: true }], regions: [{ key: 'machine', role: 'machine', label: 'State machine' }], context: {}, stable: true, gaps: [] };
  }
  async discover(observation: CounterObservation, session: Session): Promise<ActionCandidate[]> {
    const target = observation.controls[0];
    return [{ id: id(), sessionId: session.id, observationId: observation.id, stateId: observation.stateId, controlId: target.identityId, localId: target.localId, kind: 'increment', label: 'Increment counter', value: { by: 1 }, preconditions: { context: observation.context, visible: true, enabled: true, identityResolved: true }, replayable: true, risk: 'interface', source: 'counter-adapter', excluded: false, sampleValidity: 'known' }];
  }
  async preflight(observation: CounterObservation) { return observation.count === this.count ? 'valid' as const : 'stale' as const; }
  async validate(action: ActionCandidate) {
    if (action.source === 'recovery-entry') return;
    if (action.kind !== 'increment' || !action.value || typeof action.value !== 'object' || Array.isArray(action.value) || typeof action.value.by !== 'number') throw new EngineError('INVALID_INPUT', 'Expected an increment with a numeric by parameter');
  }
  async execute(action: ActionCandidate) { this.count += (action.value as { by: number }).by; }
  async reopen() { this.scope = id(); this.count = 0; this.active = true; }
  async close() { this.active = false; }
}
export class CounterAdapter implements InteractionAdapter<CounterObservation> {
  readonly ruleVersion = 'counter-v1';
  parseOptions(input: unknown) { return sessionSchema.parse(input); }
  createDriver() { return new CounterDriver(); }
  signature(control: CounterObservation['controls'][number]) { return canonical({ role: control.role, key: control.stableKey }); }
  normalize(observation: CounterObservation) { return canonical({ count: observation.count, context: observation.context }); }
  constrain(action: ActionCandidate) { return action; }
  compare(before: CounterObservation, after: CounterObservation): Diff { return { beforeId: before.id, afterId: after.id, changes: before.count === after.count ? [] : [{ kind: 'changed', field: 'count', before: before.count, after: after.count }], gaps: [], attribution: 'observed_during_interval' }; }
  testPredicate(predicate: Predicate, observation: CounterObservation) { return predicate.target === 'count' ? observation.count === predicate.equals ? 'pass' as const : 'fail' as const : 'unknown' as const; }
  replayMatches(candidate: ActionCandidate, recorded: ActionCandidate) { return candidate.kind === recorded.kind && canonical(candidate.value) === canonical(recorded.value); }
  entryAction(observation: CounterObservation, session: Session): ActionCandidate { return { id: id(), sessionId: session.id, observationId: observation.id, stateId: observation.stateId, kind: 'restart-machine', label: 'Restart counter', source: 'recovery-entry', risk: 'interface', replayable: false, excluded: false, sampleValidity: 'known', preconditions: { context: {}, visible: true, enabled: true, identityResolved: true } }; }
}
