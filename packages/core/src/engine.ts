import { EventBus } from './events.js';
import { contextSchema, actionBasisSchema } from './schema.js';
import { assignState, matchIdentities } from './identity.js';
import { recoverStore } from './recovery.js';
import { DiffQueries } from './diff-details.js';
import { describeFrontier, groupFrontier } from './frontier.js';
import { ExplorationGroups } from './exploration-groups.js';
import type { ExplorationGroup, ExplorationGroupDecision } from './types.js';
import { canonical, contextKey, hash, id, now, timeout, clone as structuredClone, defer, sleep } from './util.js';
import type { EngineOptions, InteractionAdapter, InteractionDriver, Persistence } from './ports.js';
import { EngineError, type ActionCandidate, type ActionAttempt, type Checkpoint, type ControlIdentity, type EngineHooks, type FrontierItem, type Graph, type IdentityHypothesis, type InteractionScope, type Issue, type Observation, type Predicate, type ReachResult, type Session, type SessionOptions, type Transition, type UIState, type Visit } from './types.js';
export class InteractionEngine<O extends Observation = Observation, S extends SessionOptions = SessionOptions> {
  readonly store: Persistence;
  readonly events = new EventBus();
  private readonly adapter: InteractionAdapter<O, S>;
  private readonly hooks: EngineHooks<O, S>;
  protected driver?: InteractionDriver<O, S>;
  private activeId?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private runner?: Promise<void>;
  private pauseRequested = true;
  private runEpoch = 0;
  private closing = false;
  private readonly groups: ExplorationGroups;
  constructor(options: EngineOptions<O, S>) {
    this.store = options.persistence; this.adapter = options.adapter; this.hooks = options.hooks || {};
    this.groups = new ExplorationGroups(this.store, (sid, type, data) => this.emit(sid, type, data));
    recoverStore(this.store);
  }
  /** Composition lifecycle: runs in the action queue, outside record transactions.
   * Implementations must not enqueue commands on this engine from these methods. */
  protected async beforeCapture(_sessionId: string, _observationId: string): Promise<void> {}
  protected async afterCapture(_observation: O, _previous?: O, _attemptId?: string): Promise<void> {}
  protected async captureFailed(_sessionId: string, _observationId: string, _error: unknown): Promise<void> {}
  protected async beforeAction(_sessionId: string): Promise<void> {}
  protected publish(sessionId: string, type: string, data: unknown) { return this.emit(sessionId, type, data); }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task;
  }
  private enqueueMeasured<T>(sessionId: string, fn: () => Promise<T>) {
    return this.enqueue(async () => {
      const start = Date.now(); const prior = this.session(sessionId).elapsedMs;
      try { return await fn(); }
      finally { const s = this.session(sessionId); s.elapsedMs = Math.max(s.elapsedMs, prior + Date.now() - start); this.store.put('session', s); }
    });
  }
  private emit(sessionId: string, type: string, data: unknown) {
    const event = this.store.event(sessionId, type, data);
    // Subscribers can query only after the surrounding synchronous transaction commits.
    defer(() => {
      if (this.closing) return;
      const committed = this.store.events(sessionId, event.sequence - 1, 1)[0];
      if (committed && canonical(committed) === canonical(event)) this.events.emit('event', event);
    }); return event;
  }
  private async hook<T>(sessionId: string, name: string, fn: () => Promise<T> | T): Promise<{ value?: T; error?: string }> {
    try { return { value: await timeout(Promise.resolve().then(fn), 5000, `Hook ${name} timed out`) }; }
    catch (error) { const message = String(error); this.emit(sessionId, 'hook.error', { name, message }); return { error: message }; }
  }
  sessions() { return this.store.list<Session<S>>('session'); }
  session(sessionId: string) { return this.store.require<Session<S>>('session', sessionId); }
  private owned<T extends { sessionId: string }>(kind: string, entityId: string, sessionId: string): T {
    const entity = this.store.require<T>(kind, entityId);
    if (entity.sessionId !== sessionId) throw new EngineError('NOT_FOUND', `${kind} does not belong to session`); return entity;
  }
  observation(sessionId: string, observationId?: string) {
    const oid = observationId || this.session(sessionId).currentObservationId;
    if (!oid) throw new EngineError('NO_OBSERVATION', 'No observation is available');
    return this.owned<O>('observation', oid, sessionId);
  }
  list<T>(sessionId: string, kind: string): T[] { this.session(sessionId); return kind === 'frontier' ? this.getFrontier(sessionId) as T[] : this.store.list<T>(kind, sessionId); }
  getFrontier(sessionId: string) { this.session(sessionId); return describeFrontier(this.frontier(sessionId), this.store.list<ActionAttempt>('attempt', sessionId)); }
  frontierCoverage(sessionId: string) { return groupFrontier(this.getFrontier(sessionId)); }
  decideExplorationGroup(sessionId: string, groupId: string, revision: number, decision: ExplorationGroupDecision) {
    return this.enqueueMeasured(sessionId, async () => {
      this.session(sessionId);
      return this.store.transaction(() => this.groups.decide(sessionId, groupId, revision, decision));
    });
  }
  private outsideBoundary(action: ActionCandidate) { return action.preconditions.blockers?.some(b => b.code === 'outside_active_boundary'); }
  private frontier(sessionId: string) {
    // Older sessions stored background candidates once per overlay state. Keep the
    // audit records, but do not count those impossible operations as coverage gaps.
    return this.store.list<FrontierItem>('frontier', sessionId).filter(f => f.attempts.length || !(f.reason === 'outside_active_boundary' || this.outsideBoundary(f.action)));
  }
  actions(sessionId: string, observationId?: string) { const o = this.observation(sessionId, observationId); return this.store.list<ActionCandidate>('action', sessionId).filter(a => a.observationId === o.id); }
  graph(sessionId: string): Graph { return this.getGraph(sessionId); }
  getGraph(sessionId: string): Graph { this.session(sessionId); return { states: this.store.list('state', sessionId), transitions: this.store.list('transition', sessionId), visits: this.store.list('visit', sessionId) }; }
  compare(sessionId: string, beforeId: string, afterId: string, region?: string) { return this.adapter.compare(this.observation(sessionId, beforeId), this.observation(sessionId, afterId), region); }
  private diffQueries() { return new DiffQueries<O>(this.store, (before, after, region) => this.adapter.compare(before, after, region)); }
  async diffDetails(sessionId: string, beforeId: string, afterId: string, region?: string) { return this.diffQueries().diffDetails(sessionId, beforeId, afterId, region); }
  async attemptDiffDetails(sessionId: string, attemptId: string) { return this.diffQueries().attemptDiffDetails(sessionId, attemptId); }
  async eventDiffDetails(sessionId: string, sequence: number) { return this.diffQueries().eventDiffDetails(sessionId, sequence); }
  async scopeDiffDetails(sessionId: string, scopeId: string) { return this.diffQueries().scopeDiffDetails(sessionId, scopeId); }
  report(sessionId: string) {
    const frontier = this.list<FrontierItem>(sessionId, 'frontier'); const attempts = this.list<ActionAttempt>(sessionId, 'attempt'); const observations = this.list<O>(sessionId, 'observation');
    const counts = (items: { status: string }[]) => items.reduce<Record<string, number>>((out, i) => { out[i.status] = (out[i.status] || 0) + 1; return out; }, {});
    return { session: this.session(sessionId), explorationGroups: this.store.list<ExplorationGroup>('exploration-group', sessionId).map(g => ({ id: g.id, label: g.label, status: g.status, revision: g.revision, observedCases: g.members.length, mode: g.decisions.at(-1)?.decision.mode })), states: this.getGraph(sessionId).states.length, observations: observations.length, attempts: counts(attempts), frontier: counts(frontier), frontierCoverage: this.frontierCoverage(sessionId).map(({ id, controlId, kind, label, coverageStatus, counts }) => ({ id, controlId, kind, label, coverageStatus, counts })), gaps: observations.flatMap(o => o.gaps.map(g => ({ ...g, observationId: o.id }))), issues: this.list<Issue>(sessionId, 'issue'), exploration: this.session(sessionId).options.exploration || 'stateful', coverage: this.session(sessionId).options.exploration === 'controls' ? 'encountered control operations; values and constraints are sampled, not exhaustive combinations or business assertions' : this.session(sessionId).options.exploration === 'representative' ? 'representative operation samples only; untested starting values, field combinations and undiscovered behavior remain unknown' : 'discovered operations under the current budgets and observation contract; coverage of the entire interaction space is unknown' };
  }
  async createSession(input: unknown): Promise<Session<S>> {
    const options = this.adapter.parseOptions(input);
    this.pauseRequested = true;
    return this.enqueue(async () => {
      if (this.activeId && !['stopped', 'finished'].includes(this.session(this.activeId).status)) throw new EngineError('ACTIVE_SESSION', 'Stop the active session before creating another');
      await this.driver?.close();
      const session: Session<S> = { id: id(), options, createdAt: now(), status: 'idle', actionCount: 0, elapsedMs: 0, mode: 'manual', dirty: false };
      this.store.put('session', session); this.activeId = session.id;
      this.driver = this.adapter.createDriver(options, this.store.evidence);
      try { await this.driver.start(); await this.capture(session.id, 'initial'); this.emit(session.id, 'session.created', { sessionId: session.id }); }
      catch (error) { session.status = 'paused'; session.stopReason = String(error); this.store.put('session', session); this.emit(session.id, 'session.error', { message: String(error) }); throw error; }
      return this.session(session.id);
    });
  }
  private async attach(sessionId: string) {
    if (this.activeId && this.activeId !== sessionId && !['stopped', 'finished'].includes(this.session(this.activeId).status)) throw new EngineError('ACTIVE_SESSION', 'A different session owns the interaction driver');
    if (this.activeId !== sessionId || !this.driver?.connected()) {
      await this.driver?.close(); const session = this.session(sessionId);
      this.activeId = sessionId; this.driver = this.adapter.createDriver(session.options, this.store.evidence);
      await this.driver.start();
      session.status = 'paused'; session.mode = 'manual'; this.store.put('session', session);
      // A newly initialized interaction driver is a new traversal root, not a continuation
      // of the old source's path. Historical visits remain independently queryable.
      await this.capture(sessionId, 'recovery', undefined, '');
      this.emit(sessionId, 'session.reattached', { note: 'Interaction entry reopened; previous business state has not been restored' });
    }
  }
  private async capture(sessionId: string, cause: O['cause'], attemptId?: string, parentId?: string): Promise<O> {
    let session = this.session(sessionId); const observationId = id();
    try {
    await this.beforeCapture(sessionId, observationId);
    await this.store.evidence.beginObservation?.({ sessionId, observationId, policy: session.options.evidenceRetention });
    const data = await this.driver!.capture(observationId);
    const o: O = { ...data, id: observationId, sessionId, cause, stateId: '', visitId: id(), fingerprint: '', canonical: '', ruleVersion: this.adapter.ruleVersion } as O;
    const declared = Object.fromEntries(Object.entries(session.options.context).map(([key, value]) => [key, { value, status: 'known' as const, source: 'declared' }]));
    o.context = { ...declared, ...o.context };
    const ctx = () => structuredClone({ session, observation: o });
    if (this.hooks.context) { const result = await this.hook(sessionId, 'context', async () => contextSchema.parse(await this.hooks.context!(ctx()))); if (result.value) Object.assign(o.context, result.value); if (result.error) o.gaps.push({ code: 'CONTEXT_HOOK_FAILED', message: result.error, critical: true }); }
    const identities = this.store.list<ControlIdentity<O['controls'][number]>>('identity', sessionId);
    const matched = matchIdentities(o, identities, this.store.list<IdentityHypothesis>('hypothesis', sessionId), c => this.adapter.signature(c));
    let state = assignState(o, this.store.list<UIState>('state', sessionId), value => this.adapter.normalize(value as O));
    const previous = session.currentObservationId ? this.observation(sessionId) : undefined;
    const parent = parentId ?? previous?.visitId;
    const parentVisit = parent ? this.store.get<Visit>('visit', parent) : undefined;
    const visit: Visit = { id: o.visitId, sessionId, stateId: o.stateId, observationId: o.id, parentId: parent, viaAttemptId: attemptId, depth: (parentVisit?.depth ?? 0) + (attemptId ? 1 : 0), at: now() };
    if (session.options.exploration !== 'stateful' && !!session.options.exploration && this.adapter.explorationScope) {
      visit.explorationScope = this.adapter.explorationScope(o);
      const earlier = this.store.list<Visit>('visit', sessionId).filter(v => v.explorationScope === visit.explorationScope && v.explorationDepth !== undefined);
      const depth = parentVisit ? (parentVisit.explorationDepth ?? parentVisit.depth) + Number(parentVisit.explorationScope !== visit.explorationScope) : 0;
      visit.explorationDepth = Math.min(depth, ...earlier.map(v => v.explorationDepth!));
    }
    const frontierDepth = visit.explorationDepth ?? visit.depth;
    let actions: ActionCandidate[] = [];
    if (!o.gaps.some(g => g.critical)) {
      try { actions = (await this.driver!.discover(o, session, (name, fn) => this.hook(sessionId, name, fn))).map(a => this.constrain(a, o, session)); }
      catch (error) { o.gaps.push({ code: 'ACTION_DISCOVERY_FAILED', message: String(error), critical: true }); }
    }
    if (this.hooks.actions) {
      const result = await this.hook(sessionId, 'actions', async () => {
        const proposed = await this.hooks.actions!(structuredClone(actions), ctx());
        if (!Array.isArray(proposed)) throw new EngineError('INVALID_PLUGIN_ACTION', 'Action hook must return an array');
        // Validation is part of the hook boundary: malformed output cannot discard facts.
        return proposed.map(a => this.constrain({ ...a, id: id(), sessionId, observationId: o.id, stateId: o.stateId }, o, session));
      });
      if (result.value) actions = result.value;
      if (result.error) { o.gaps.push({ code: 'ACTION_HOOK_FAILED', message: result.error }); actions = actions.map(a => ({ ...a, excluded: true, exclusionReason: 'action_hook_failed' })); }
    }
    // Discovery is fallible too; preserve captured facts and include late gaps in
    // state equivalence instead of discarding the entire post-action observation.
    if (this.adapter.normalize(o) !== o.canonical) {
      state = assignState(o, this.store.list<UIState>('state', sessionId), value => this.adapter.normalize(value as O));
      visit.stateId = o.stateId;
    }
    actions = actions.map(a => this.constrain({ ...a, stateId: o.stateId }, o, session));
    const proposals = o.gaps.some(g => g.critical) ? [] : this.adapter.explorationGroups?.(actions, o, session, this.store.list<ExplorationGroup>('exploration-group', sessionId)) || [];
    let groupDiscovery: ReturnType<ExplorationGroups['discover']>;
    if (o.gaps.some(g => g.critical)) for (const identity of matched.identities) if (identity.status !== 'present') identity.status = 'unknown';
    this.store.transaction(() => {
      this.store.put('observation', o); this.store.put('state', state); this.store.put('visit', visit);
      groupDiscovery = this.groups.discover(proposals, actions, o, a => this.frontierKey(a, o));
      for (const identity of matched.identities) this.store.put('identity', identity);
      for (const hypothesis of matched.hypotheses) { this.store.put('hypothesis', hypothesis); this.emit(sessionId, 'identity.ambiguous', hypothesis); }
      if (previous && contextKey(previous.context) !== contextKey(o.context)) for (const item of this.frontier(sessionId)) {
        // Completed representative samples describe their historical conditions.
        // Visiting a different context does not make that sample unexecuted.
        if (item.sampling) continue;
        if (item.contextKey !== contextKey(o.context) && item.status !== 'executing') { item.status = 'needs_revalidation'; item.reason = 'business_context_changed'; this.store.put('frontier', item); }
      }
      // Capture is serialized. Index this transaction's current records once,
      // and keep inserts in the index so duplicate candidates still update one row.
      const frontierByKey = new Map<string, FrontierItem>();
      for (const item of this.store.list<FrontierItem>('frontier', sessionId)) if (!frontierByKey.has(item.key)) frontierByKey.set(item.key, item);
      for (const action of actions) {
        this.store.put('action', action);
        if (action.basis?.status === 'tentative') this.emit(sessionId, 'action.tentative', { actionId: action.id, observationId: o.id, basis: action.basis });
        // These remain inspectable candidates. Their parent-state work is queued
        // only when that state is observed without the exclusive child boundary.
        if (this.outsideBoundary(action) || session.options.exploration === 'controls' && action.basis?.status === 'tentative') continue;
        const key = this.frontierKey(action, o);
        const sample = this.samplingCase(action, o);
        const existing = frontierByKey.get(key);
        const blocker = action.preconditions.blockers?.[0];
        const tentative = action.basis?.status === 'tentative';
        const reason = action.exclusionReason || (!this.targetResolved(action, o) ? 'identity_ambiguous' : !action.preconditions.enabled ? 'disabled' : blocker?.code) || (tentative ? 'action_basis_unconfirmed' : undefined);
        const unblock = blocker?.unblock || (tentative ? 'Explicitly execute a probe, or supply an action hook with supporting evidence' : undefined);
        if (!existing) {
          const f: FrontierItem = { id: id(), sessionId, key, stateId: o.stateId, contextKey: contextKey(o.context), action, status: reason || action.excluded ? 'blocked' : 'pending', reason, unblock, depth: frontierDepth, attempts: [] };
          f.explorationGroups = groupDiscovery.references.get(action.id);
          if (sample) f.sampling = { policy: sample.policy, evidence: sample.evidence, observationIds: [o.id] };
          this.store.put('frontier', f); frontierByKey.set(key, f);
        } else {
          const temporarilyBlocked = existing.status === 'blocked' && (!!existing.action.preconditions.blockers?.length || existing.reason === 'action_basis_unconfirmed');
          if (existing.sampling && !existing.sampling.observationIds.includes(o.id)) existing.sampling.observationIds.push(o.id);
          // A recorded attempt stays attached to its actual source observation.
          // Only unattempted samples may move to newly observed conditions.
          if (!existing.sampling || !existing.attempts.length) {
            existing.action = action;
            existing.explorationGroups = groupDiscovery.references.get(action.id);
            if (existing.sampling) { existing.stateId = o.stateId; existing.depth = Math.min(existing.depth, frontierDepth); }
          }
          if (existing.status === 'pending' || existing.status === 'deferred' || existing.status === 'superseded' || temporarilyBlocked || (existing.status === 'blocked' && (existing.reason === 'identity_ambiguous' && action.preconditions.identityResolved || !!existing.recovery && !!existing.sampling && !existing.attempts.length)) || existing.status === 'needs_revalidation') {
            existing.status = reason || action.excluded ? 'blocked' : 'pending'; existing.reason = reason; existing.unblock = unblock;
            existing.recovery = undefined;
          }
          this.store.put('frontier', existing);
        }
      }
      this.groups.apply(sessionId, [...frontierByKey.values()]);
      if (session.options.exploration === 'controls' && this.adapter.explorationScope && !o.gaps.some(g => g.critical)) {
        const scope = this.adapter.explorationScope(o);
        const currentKeys = new Set(actions.map(a => this.frontierKey(a, o)));
        // Scroll is traversal from a live viewport, not a demand to recreate a
        // historical business state. Preserve unused intents as unexecuted history.
        for (const f of this.frontier(sessionId)) if (!f.attempts.length && f.action.kind === 'scroll'
          && !currentKeys.has(f.key) && this.adapter.explorationScope(this.observation(sessionId, f.action.observationId)) === scope) {
          f.status = 'superseded'; f.reason = 'traversal_position_changed'; f.unblock = undefined; f.recovery = undefined; this.store.put('frontier', f);
        }
        // Untried exits (including reviewed controls) are traversal work, not a
        // reason to reopen a boundary already observed closed in this document.
        // Keep the records unexecuted; retiring an intent is not control coverage.
        for (const f of this.frontier(sessionId)) if (!f.attempts.length && f.action.boundary?.intent === 'exit'
          && this.observation(sessionId, f.action.observationId).instanceScope === o.instanceScope
          && !o.boundaries?.some(b => b.key === f.action.boundary!.key)) {
          f.status = 'superseded'; f.reason = 'boundary_already_exited'; f.unblock = undefined; f.recovery = undefined; this.store.put('frontier', f);
        }
      }
      session = this.session(sessionId); session.currentObservationId = o.id; this.store.put('session', session);
      if (attemptId) {
        const attempt = this.owned<ActionAttempt>('attempt', attemptId, sessionId);
        attempt.afterId = o.id; attempt.finishedAt = now();
        if (attempt.status === 'executing') {
          attempt.status = o.gaps.some(g => g.critical) ? 'unknown' : 'succeeded';
          if (attempt.status === 'unknown') attempt.reason = `Post-action observation incomplete: ${o.gaps.filter(g => g.critical).map(g => g.code).join(', ')}`;
        }
        attempt.diff = this.adapter.compare(this.observation(sessionId, attempt.beforeId), o);
        const transition: Transition = { id: id(), sessionId, from: attempt.action.stateId, to: o.stateId, attemptId, replayable: attempt.action.replayable && attempt.status === 'succeeded' };
        attempt.transitionId = transition.id; this.store.put('transition', transition); this.store.put('attempt', attempt);
        this.updateFrontier(attempt); this.emit(sessionId, 'action.completed', attempt); this.emit(sessionId, 'observation.diff', attempt.diff);
        for (const scope of this.store.list<InteractionScope>('scope', sessionId).filter(s => s.status === 'open')) { scope.attemptIds.push(attemptId); this.store.put('scope', scope); }
      } else if (previous && previous.canonical !== o.canonical) this.emit(sessionId, 'observation.external_change', this.adapter.compare(previous, o));
      this.emit(sessionId, 'observation.created', { observationId: o.id, stateId: o.stateId, visitId: o.visitId, gaps: o.gaps });
      this.emit(sessionId, 'frontier.updated', { observationId: o.id });
      this.syncBoundaries(sessionId, previous, o, attemptId);
    });
    await this.afterCapture(structuredClone(o), previous ? structuredClone(previous) : undefined, attemptId);
    await this.store.evidence.endObservation?.(observationId, true);
    for (const group of groupDiscovery!.requested) if (this.hooks.explorationGroup) {
      const result = await this.hook(sessionId, 'explorationGroup', () => this.hooks.explorationGroup!(structuredClone(group), ctx()));
      if (result.value !== undefined) await this.hook(sessionId, 'explorationGroup-decision', () => this.store.transaction(() => this.groups.decide(sessionId, group.id, group.revision, result.value!)));
    }
    let resolvedByHook = false;
    for (const hypothesis of matched.hypotheses) if (this.hooks.identity) {
      const result = await this.hook(sessionId, 'identity', () => this.hooks.identity!(structuredClone(hypothesis), ctx()));
      if (result.value) { const resolution = await this.hook(sessionId, 'identity-resolution', () => this.resolveIdentityInternal(sessionId, hypothesis.id, result.value!.identityId, result.value!.source, result.value!.evidence)); if (resolution.value) resolvedByHook = true; }
    }
    if (resolvedByHook) return this.capture(sessionId, 'inspection');
    return o;
    } catch (error) { await this.captureFailed(sessionId, observationId, error); await this.store.evidence.endObservation?.(observationId, !!this.store.get('observation', observationId)); throw error; }
  }
  private samplingCase(a: ActionCandidate, observation?: O) {
    const session = this.session(a.sessionId); const o = observation || this.observation(a.sessionId, a.observationId);
    if (!['representative', 'controls'].includes(session.options.exploration || '') || !a.controlId && session.options.exploration !== 'controls' || !this.targetResolved(a, o)) return undefined;
    return this.adapter.explorationCase?.(a, o, session);
  }
  private frontierKey(a: ActionCandidate, observation?: O) {
    const sample = this.samplingCase(a, observation);
    return hash({ ...(sample ? { sample: sample.key, policy: sample.policy } : { state: a.stateId }), control: a.controlId, kind: a.kind, value: a.value, context: a.preconditions.context });
  }
  private targetResolved(action: ActionCandidate, o: O) {
    if (action.preconditions.identityResolved) return true;
    const target = action.target;
    const matches = o.controls.filter(c => c.instanceId === target?.instanceId);
    return this.session(action.sessionId).options.exploration === 'controls' && target?.kind === 'instance' && target.instanceScope === o.instanceScope
      && matches.length === 1 && matches[0].localId === action.localId && matches[0].identityId === action.controlId;
  }
  private constrain(action: ActionCandidate, observation: O, session: Session<S>) {
    const result = this.adapter.constrain(action, observation, session);
    if (!result.kind || typeof result.kind !== 'string') throw new EngineError('INVALID_PLUGIN_ACTION', 'Action kind must be a nonempty string');
    if (result.basis) result.basis = actionBasisSchema.parse(result.basis);
    if (result.basis?.status === 'tentative') result.replayable = false;
    const control = observation.controls.find(c => c.identityId === result.controlId && c.localId === result.localId);
    if (result.controlId && !control) { result.excluded = true; result.exclusionReason = 'unknown_control'; }
    result.preconditions = { ...result.preconditions, context: observation.context, visible: control?.visible ?? true, enabled: control?.enabled ?? true, identityResolved: !control?.hypothesisId };
    result.preconditions.targetResolved = !!this.targetResolved(result, observation);
    if (result.target) result.replayable = false;
    const active = observation.boundaries?.at(-1);
    if (active && result.boundary?.key !== active.key && !result.preconditions.blockers?.some(b => b.code === 'outside_active_boundary')) {
      (result.preconditions.blockers ??= []).push({ code: 'outside_active_boundary', boundaryKey: active.key, evidence: active.evidence, unblock: `Exit and verify ${active.name} before interacting with its parent` });
    }
    if (observation.gaps.some(g => g.critical)) result.preconditions.blockers = [...(result.preconditions.blockers || []).filter(b => b.code !== 'observation_incomplete'), { code: 'observation_incomplete', evidence: observation.gaps.filter(g => g.critical).map(g => g.code), unblock: 'Collect a complete observation before executing another operation' }];
    if (Object.values(observation.context).some(c => c.status === 'unknown')) { result.excluded = true; result.exclusionReason = 'business_preconditions_unknown'; }
    return result;
  }
  async observe(sessionId: string) { return this.enqueue(async () => { await this.attach(sessionId); return this.capture(sessionId, 'inspection'); }); }
  async inspect(sessionId: string, region: string) {
    const observation = await this.observe(sessionId);
    if (!observation.regions.some(r => r.key === region)) throw new EngineError('REGION_NOT_FOUND', 'Requested region was not found', { observationId: observation.id });
    return { observation, region, controls: observation.controls.filter(c => this.adapter.inRegion?.(c, region, observation) ?? c.region === region), note: 'Observation only; no action was executed' };
  }
  private budget(session: Session<S>) {
    if (session.actionCount >= session.options.maxActions || session.elapsedMs >= session.options.maxDurationMs) throw new EngineError('BUDGET_EXHAUSTED', 'Action or elapsed-time budget exhausted');
  }
  private updateFrontier(attempt: ActionAttempt) {
    const key = this.frontierKey(attempt.action);
    for (const item of this.store.list<FrontierItem>('frontier', attempt.sessionId).filter(f => f.key === key)) {
      item.status = attempt.status === 'succeeded' ? 'executed' : attempt.status === 'failed' || attempt.status === 'blocked' ? 'blocked' : attempt.status === 'executing' ? 'executing' : 'unknown';
      item.action = attempt.action; item.stateId = attempt.action.stateId;
      item.reason = attempt.reason; if (!item.attempts.includes(attempt.id)) item.attempts.push(attempt.id); this.store.put('frontier', item);
    }
  }
  private async runAction(sessionId: string, actionId: string, requestId: string, value?: ActionCandidate['value'], purpose: ActionAttempt['purpose'] = 'external'): Promise<ActionAttempt> {
    const payload = canonical({ actionId, value }); const prior = this.store.request(sessionId, requestId);
    if (prior) { if (prior.payload !== payload) throw new EngineError('REQUEST_CONFLICT', 'Request ID was used with different parameters'); return this.owned<ActionAttempt>('attempt', prior.attemptId, sessionId); }
    await this.attach(sessionId); await this.beforeAction(sessionId); let session = this.session(sessionId); this.budget(session);
    const original = this.owned<ActionCandidate>('action', actionId, sessionId);
    const originalObservation = this.observation(sessionId, original.observationId);
    const current = this.observation(sessionId);
    if (current.id !== original.observationId) throw new EngineError('STALE_OBSERVATION', 'Choose an action from the latest observation', { observationId: current.id, actions: this.actions(sessionId) });
    if (original.excluded && original.exclusionReason !== 'input_sample_required') throw new EngineError('ACTION_EXCLUDED', original.exclusionReason || 'Action excluded');
    if (original.basis?.status === 'tentative' && purpose !== 'external') throw new EngineError('ACTION_BLOCKED', 'action_basis_unconfirmed');
    if (!this.targetResolved(original, current)) throw new EngineError('IDENTITY_AMBIGUOUS', 'Resolve the identity before acting');
    const preflight = await this.driver!.preflight(current);
    if (preflight !== 'valid') {
      const fresh = await this.capture(sessionId, 'external');
      throw new EngineError(preflight === 'context_changed' ? 'PRECONDITIONS_CHANGED' : 'STALE_OBSERVATION', 'Interaction source changed before execution', { observationId: fresh.id, actions: this.actions(sessionId) });
    }
    const constrained = ['recovery-entry', 'recovery-reset'].includes(original.source) ? original : this.constrain(structuredClone(original), current, session);
    if (constrained.preconditions.blockers?.length) throw new EngineError('ACTION_BLOCKED', constrained.preconditions.blockers[0].code, { blockers: constrained.preconditions.blockers, observationId: current.id });
    if (this.hooks.context) {
      const check = await this.hook(sessionId, 'context-preflight', async () => contextSchema.parse(await this.hooks.context!(structuredClone({ session, observation: current }))));
      if (check.error) throw new EngineError('PRECONDITIONS_UNKNOWN', check.error);
      if (canonical({ ...current.context, ...check.value }) !== canonical(current.context)) { const fresh = await this.capture(sessionId, 'external'); throw new EngineError('PRECONDITIONS_CHANGED', 'Context hook reported changed preconditions', { observationId: fresh.id }); }
    }
    const action = structuredClone(original); if (value !== undefined) { action.value = value; if (action.exclusionReason === 'input_sample_required') { action.excluded = false; action.exclusionReason = undefined; } }
    if (action.excluded) throw new EngineError('INPUT_REQUIRED', 'Provide an input sample');
    const control = current.controls.find(c => c.localId === action.localId);
    if (control && (!control.visible || !control.enabled)) throw new EngineError('ACTION_BLOCKED', 'Control is not visible or enabled');
    await this.driver!.validate(action, control);
    await this.beforeAction(sessionId);
    const attempt: ActionAttempt = { id: id(), sessionId, requestId, action, startedAt: now(), beforeId: current.id, status: 'executing', purpose };
    const started = Date.now();
    this.store.transaction(() => {
      session.actionCount++;
      if (action.risk !== 'interface') { session.dirty = true; (session.dirtyAttemptIds ??= []).push(attempt.id); }
      this.store.put('session', session);
      const key = this.frontierKey(action, current);
      if (!this.store.list<FrontierItem>('frontier', sessionId).some(f => f.key === key)) {
        const sample = this.samplingCase(action, current);
        this.store.put('frontier', { id: id(), sessionId, key, stateId: action.stateId, contextKey: contextKey(action.preconditions.context), action, status: 'executing', attempts: [], depth: this.owned<Visit>('visit', current.visitId, sessionId).depth,
          ...(sample ? { sampling: { policy: sample.policy, evidence: sample.evidence, observationIds: [current.id] } } : {}) } as FrontierItem);
      }
      this.store.put('attempt', attempt); this.store.recordRequest(sessionId, requestId, attempt.id, payload); this.updateFrontier(attempt); this.emit(sessionId, 'action.started', attempt);
    });
    let openedScope: InteractionScope | undefined;
    const scopeBefore = this.adapter.scopeBefore?.(action, current);
    if (scopeBefore) openedScope = this.openScopeInternal(sessionId, scopeBefore.name, scopeBefore.region, true);
    try {
      if (['recovery-entry', 'recovery-reset'].includes(action.source)) await this.driver!.reopen();
      else await this.driver!.execute(action, control);
    }
    catch (error) { attempt.status = 'failed'; attempt.reason = String(error); this.store.put('attempt', attempt); }
    try {
      const after = await this.capture(sessionId, purpose === 'recovery' ? 'recovery' : 'action', attempt.id, ['recovery-entry', 'recovery-reset'].includes(action.source) ? '' : undefined);
      const scopes = this.adapter.scopeAfter?.(action, current, after);
      if (!openedScope && scopes?.start) { openedScope = this.openScopeInternal(sessionId, scopes.start.name, scopes.start.region, true, originalObservation.id); openedScope.attemptIds.push(attempt.id); this.store.put('scope', openedScope); }
      if (openedScope) { openedScope = this.owned<InteractionScope>('scope', openedScope.id, sessionId); openedScope.anchors = scopes?.anchors || []; this.store.put('scope', openedScope); }
      for (const scope of this.store.list<InteractionScope>('scope', sessionId).filter(s => s.status === 'open' && s.automatic)) {
        if (this.adapter.scopeClosed?.(scope, after)) this.closeScopeInternal(sessionId, scope.id);
      }
      if (this.hooks.check) {
        const result = await this.hook(sessionId, 'check', async () => {
          const issues = await this.hooks.check!(this.owned<ActionAttempt>('attempt', attempt.id, sessionId), structuredClone({ session: this.session(sessionId), observation: after }));
          if (!Array.isArray(issues) || issues.some(i => !i || typeof i.source !== 'string' || typeof i.message !== 'string' || !['info', 'warning', 'error'].includes(i.severity))) throw new EngineError('INVALID_PLUGIN_ISSUE', 'Check hook must return structured issues');
          return issues;
        });
        for (const issue of result.value || []) { const record: Issue = { ...issue, id: id(), sessionId, observationId: after.id }; this.store.put('issue', record); this.emit(sessionId, 'issue.reported', record); }
      }
    } catch (error) {
      const result = this.owned<ActionAttempt>('attempt', attempt.id, sessionId); result.status = 'unknown'; result.reason = `Post-action observation unavailable: ${String(error)}`; result.finishedAt = now();
      this.store.transaction(() => { this.store.put('attempt', result); this.updateFrontier(result); this.emit(sessionId, 'action.unknown', result); });
    } finally { session = this.session(sessionId); session.elapsedMs += Date.now() - started; this.store.put('session', session); }
    return this.owned<ActionAttempt>('attempt', attempt.id, sessionId);
  }
  async execute(sessionId: string, actionId: string, requestId: string, value?: ActionCandidate['value']) {
    this.pauseRequested = true;
    return this.enqueue(async () => { const s = this.session(sessionId); s.mode = 'manual'; if (s.status === 'running') s.status = 'paused'; this.store.put('session', s); return this.runAction(sessionId, actionId, requestId, value); });
  }
  private resolveIdentityInternal(sessionId: string, hypothesisId: string, identityId: string, source: string, evidence: string[]) {
    const h = this.owned<IdentityHypothesis>('hypothesis', hypothesisId, sessionId);
    this.owned<ControlIdentity<O['controls'][number]>>('identity', identityId, sessionId);
    if (![h.provisionalIdentityId, ...h.candidateIds].includes(identityId)) throw new EngineError('INVALID_RESOLUTION', 'Identity must be one of the recorded candidates or the provisional identity');
    if (this.observation(sessionId).controls.some(c => c.identityId === identityId && c.localId !== h.localId && c.identityId !== h.provisionalIdentityId)) throw new EngineError('INVALID_RESOLUTION', 'The chosen identity is already represented by another current control');
    if (!source.trim() || !evidence.length) throw new EngineError('INVALID_RESOLUTION', 'Source and evidence are required');
    h.status = 'resolved'; h.revisions.push({ identityId, source, evidence, at: now() }); this.store.put('hypothesis', h); this.emit(sessionId, 'identity.resolved', h); return h;
  }
  resolveIdentity(sessionId: string, hypothesisId: string, identityId: string, source: string, evidence: string[]) {
    this.pauseRequested = true; return this.enqueue(async () => { const h = this.resolveIdentityInternal(sessionId, hypothesisId, identityId, source, evidence); await this.attach(sessionId); await this.capture(sessionId, 'inspection'); return h; });
  }
  private openScopeInternal(sessionId: string, name: string, region: string, automatic = false, beforeId?: string, metadata: Partial<Pick<InteractionScope, 'boundaryKey' | 'parentScopeId' | 'baseline' | 'anchors' | 'attemptIds'>> = {}) {
    const before = this.observation(sessionId, beforeId);
    if (!before.regions.some(r => r.key === region)) throw new EngineError('REGION_NOT_FOUND', 'Cannot anchor scope to an unknown region');
    const scope: InteractionScope = { id: id(), sessionId, name, region, beforeId: before.id, attemptIds: [], status: 'open', automatic, anchors: [], ...metadata }; this.store.put('scope', scope); this.emit(sessionId, 'scope.opened', scope); return scope;
  }
  private syncBoundaries(sessionId: string, previous: O | undefined, current: O, attemptId?: string) {
    if (current.gaps.some(g => g.critical)) {
      this.emit(sessionId, 'interaction.boundary_unverified', { observationId: current.id, gaps: current.gaps.filter(g => g.critical) });
      return;
    }
    const boundaries = current.boundaries || [];
    for (const scope of this.store.list<InteractionScope>('scope', sessionId).filter(s => s.status === 'open' && s.boundaryKey)) {
      if (!boundaries.some(b => b.key === scope.boundaryKey)) this.closeScopeInternal(sessionId, scope.id);
    }
    for (const boundary of boundaries) {
      const open = this.store.list<InteractionScope>('scope', sessionId).filter(s => s.status === 'open' && s.boundaryKey);
      if (open.some(s => s.boundaryKey === boundary.key)) continue;
      const before = previous?.regions.some(r => r.key === boundary.region) ? previous : current;
      this.openScopeInternal(sessionId, boundary.name, boundary.region, true, before.id, {
        boundaryKey: boundary.key, anchors: [boundary.key], parentScopeId: open.find(s => s.boundaryKey === boundary.parentKey)?.id,
        baseline: previous && !previous.boundaries?.some(b => b.key === boundary.key) && before === previous ? 'before_entry' : 'already_open',
        attemptIds: attemptId ? [attemptId] : [],
      });
    }
    if (canonical(previous?.boundaries?.map(b => b.key) || []) !== canonical(boundaries.map(b => b.key))) {
      this.emit(sessionId, 'interaction.boundary_changed', { observationId: current.id, active: boundaries.at(-1), stack: boundaries });
    }
  }
  openScope(sessionId: string, name: string, region: string) { return this.enqueue(async () => this.openScopeInternal(sessionId, name, region)); }
  private closeScopeInternal(sessionId: string, scopeId: string) {
    const scope = this.owned<InteractionScope>('scope', scopeId, sessionId); const current = this.observation(sessionId);
    if (scope.status !== 'open') return scope;
    if (current.gaps.some(g => g.critical)) throw new EngineError('OBSERVATION_INCOMPLETE', 'A complete observation is required to verify scope exit');
    if (scope.boundaryKey && current.boundaries?.some(b => b.key === scope.boundaryKey)) throw new EngineError('SCOPE_ACTIVE', 'The interaction boundary is still present; exit must be observed before closing its scope');
    scope.afterId = current.id; scope.diff = this.compare(sessionId, scope.beforeId, current.id, scope.region);
    if (scope.baseline === 'already_open') scope.diff.gaps.push({ code: 'SCOPE_ENTRY_BASELINE_UNAVAILABLE', message: 'The boundary was already open at first observation; its entry effect is unknown' });
    scope.status = 'closed'; this.store.put('scope', scope); this.emit(sessionId, 'scope.closed', scope); return scope;
  }
  closeScope(sessionId: string, scopeId: string) { return this.enqueue(async () => { await this.attach(sessionId); await this.capture(sessionId, 'inspection'); return this.closeScopeInternal(sessionId, scopeId); }); }
  private visitPath(sessionId: string, visitId: string) {
    const result: string[] = []; let visit = this.owned<Visit>('visit', visitId, sessionId); const seen = new Set<string>();
    while (visit && !seen.has(visit.id)) {
      seen.add(visit.id);
      if (visit.viaAttemptId) { const a = this.owned<ActionAttempt>('attempt', visit.viaAttemptId, sessionId); if (['recovery-entry', 'recovery-reset'].includes(a.action.source)) break; result.unshift(visit.viaAttemptId); }
      if (!visit.parentId) break; visit = this.owned<Visit>('visit', visit.parentId, sessionId);
    }
    return result;
  }
  private checkpointInternal(sessionId: string, name: string, predicates: Predicate[] = [], acceptable: Predicate[] = [], observationId?: string, checkpointId = id()) {
    const o = this.observation(sessionId, observationId); const checkpoint: Checkpoint = { id: checkpointId, sessionId, name, observationId: o.id, stateId: o.stateId, context: o.context, predicates, acceptable, path: this.visitPath(sessionId, o.visitId), createdAt: now() };
    this.store.put('checkpoint', checkpoint); this.emit(sessionId, 'checkpoint.created', checkpoint); return checkpoint;
  }
  createCheckpoint(sessionId: string, name: string, predicates: Predicate[] = [], acceptable: Predicate[] = [], retainedEvidence: string[] | ((observation: O) => string[]) = []) {
    return this.enqueue(async () => {
      const owner = id();
      // Resolve platform evidence only after earlier actions finish, against the
      // same observation that the checkpoint will describe.
      const evidenceKeys = typeof retainedEvidence === 'function' ? retainedEvidence(this.observation(sessionId)) : [...retainedEvidence];
      if (evidenceKeys.length) {
        if (!this.store.evidence.pin) throw new EngineError('EVIDENCE_RETENTION_UNSUPPORTED', 'This evidence plugin cannot guarantee retained evidence');
        await this.store.evidence.pin(evidenceKeys, `checkpoint:${owner}`);
      }
      try {
        return this.store.transaction(() => {
          const cp = this.checkpointInternal(sessionId, name, predicates, acceptable, undefined, owner);
          if (evidenceKeys.length) { cp.evidenceKeys = evidenceKeys; this.store.put('checkpoint', cp); this.emit(sessionId, 'checkpoint.evidence_retained', { checkpointId: cp.id, observationId: cp.observationId, owner: `checkpoint:${owner}`, keys: evidenceKeys }); }
          return cp;
        });
      } catch (error) { if (evidenceKeys.length) await this.store.evidence.unpin?.(`checkpoint:${owner}`); throw error; }
    });
  }
  private testPredicate(predicate: Predicate, observation: O) { return this.adapter.testPredicate(predicate, observation); }
  private async verify(sessionId: string, checkpoint: Checkpoint): Promise<{ status?: ReachResult['status']; checks: ReachResult['checks'] }> {
    const o = this.observation(sessionId); const checks: ReachResult['checks'] = [];
    for (const key of checkpoint.evidenceKeys || []) {
      let available = false;
      try { available = this.store.evidence.availability ? (await this.store.evidence.availability(key)).status === 'available' : !!(await this.store.evidence.get(key)); } catch { /* Verification remains unknown on storage failure. */ }
      checks.push({ name: `retained-evidence:${key}`, result: available ? 'pass' : 'unknown' });
    }
    if (checks.some(c => c.result === 'unknown')) return { status: 'UNVERIFIED', checks };
    for (const [key, expected] of Object.entries(checkpoint.context)) { const actual = o.context[key]; checks.push({ name: `context:${key}`, result: !actual || actual.status === 'unknown' || expected.status === 'unknown' ? 'unknown' : canonical(actual.value) === canonical(expected.value) ? 'pass' : 'fail' }); }
    if (checks.some(c => c.result === 'fail')) return { status: 'PRECONDITIONS_CHANGED', checks };
    if (!o.stable || o.gaps.some(g => g.critical) || checks.some(c => c.result === 'unknown')) return { status: 'UNVERIFIED', checks: [...checks, { name: 'observation-completeness', result: 'unknown' }] };
    for (const [i, p] of checkpoint.predicates.entries()) checks.push({ name: `predicate:${i}`, result: this.testPredicate(p, o) });
    checks.push({ name: 'observable-state', result: o.canonical === this.observation(sessionId, checkpoint.observationId).canonical ? 'pass' : 'fail' });
    if (this.hooks.verify) { const h = await this.hook(sessionId, 'verify', () => this.hooks.verify!(structuredClone(checkpoint), structuredClone({ session: this.session(sessionId), observation: o }))); checks.push({ name: `verifier:${h.value?.evidence.join('; ') || h.error || ''}`, result: h.value?.result || 'unknown' }); }
    if (checks.every(c => c.result === 'pass')) return { status: 'REACHED_VERIFIED', checks };
    if (checkpoint.acceptable.length && checkpoint.acceptable.every(p => this.testPredicate(p, o) === 'pass')) return { status: 'REACHED_ACCEPTABLE', checks };
    if (this.hooks.accept) { const h = await this.hook(sessionId, 'accept', () => this.hooks.accept!(structuredClone(checkpoint), structuredClone({ session: this.session(sessionId), observation: o }))); if (h.value?.accepted) return { status: 'REACHED_ACCEPTABLE', checks: [...checks, { name: `accepted:${h.value.evidence.join('; ')}`, result: 'pass' }] }; }
    if (checks.some(c => c.result === 'unknown')) return { status: 'UNVERIFIED', checks };
    return { checks };
  }
  navigationPath(sessionId: string, from: string, to: string): string[] | null {
    const edges = this.getGraph(sessionId).transitions.filter(e => e.replayable); const queue = [{ state: from, path: [] as string[] }]; const visited = new Set<string>();
    while (queue.length) { const item = queue.shift()!; if (item.state === to) return item.path; if (visited.has(item.state)) continue; visited.add(item.state); for (const edge of edges.filter(e => e.from === item.state)) queue.push({ state: edge.to, path: [...item.path, edge.attemptId] }); }
    return null;
  }
  private async replay(sessionId: string, attemptIds: string[], allowWrites: boolean, performed: string[]) {
    for (const attemptId of attemptIds) {
      const old = this.owned<ActionAttempt>('attempt', attemptId, sessionId); const current = this.observation(sessionId);
      if (old.status !== 'succeeded') return 'recorded_action_not_verified';
      if (!old.action.replayable && !allowWrites) return 'path_contains_nonreplayable_action';
      if (contextKey(current.context) !== contextKey(old.action.preconditions.context)) return 'preconditions_changed';
      const target = this.actions(sessionId).filter(a => this.adapter.replayMatches(a, old.action));
      if (target.length !== 1) return 'replay_target_not_unique_or_missing';
      let result: ActionAttempt;
      try { result = await this.runAction(sessionId, target[0].id, id(), old.action.value, 'recovery'); }
      catch (error) { return error instanceof EngineError ? error.code : String(error); }
      performed.push(result.id);
      if (result.status !== 'succeeded' || !result.afterId || !old.afterId) return 'replay_action_not_verified';
      if (this.observation(sessionId, result.afterId).canonical !== this.observation(sessionId, old.afterId).canonical) return 'replay_state_diverged';
    }
    return undefined;
  }
  private observationReturn(sessionId: string, target: O) {
    const session = this.session(sessionId), current = this.observation(sessionId);
    if (session.dirty || current.boundaries?.length || current.gaps.some(g => g.critical)) return;
    const proposed = this.adapter.returnToObservation?.(target, current, session);
    if (!proposed) return;
    const action = this.constrain(proposed, current, session);
    if (action.excluded || action.risk !== 'interface' || action.basis?.status !== 'supported' || action.preconditions.blockers?.length) return;
    return action;
  }
  private boundaryExitKey(action: ActionCandidate, observation: O) {
    const target = observation.controls.find(c => c.localId === action.localId && c.identityId === action.controlId);
    // Fresh audit references do not make the same current exit a new route.
    return canonical({ instanceScope: observation.instanceScope, scope: this.adapter.explorationScope?.(observation),
      boundary: action.boundary?.key, target: target?.instanceId || action.controlId, kind: action.kind, value: action.value });
  }
  private async reachInternal(sessionId: string, checkpointId: string): Promise<ReachResult> {
    const checkpoint = this.owned<Checkpoint>('checkpoint', checkpointId, sessionId); const performed: string[] = [];
    let checks: ReachResult['checks'] = []; let status: ReachResult['status'] = 'UNREACHABLE'; let reason = 'No verified path within the current recovery constraints';
    const strategies: string[] = [];
    const finish = () => {
      const session = this.session(sessionId);
      const dirtyActions = (session.dirtyAttemptIds || []).flatMap(attemptId => {
        const a = this.store.get<ActionAttempt>('attempt', attemptId); return a ? [{ attemptId, label: a.action.label, risk: a.action.risk }] : [];
      });
      const diagnostics = { strategies, dirtyActions, resetAvailable: !!this.hooks.reset || !!this.adapter.resetAction?.(this.observation(sessionId), session) };
      const result: ReachResult = { id: id(), sessionId, checkpointId, status, reason, checks, attemptIds: performed, observationId: session.currentObservationId, remainingFrontier: this.frontier(sessionId).filter(f => f.status !== 'executed').length, diagnostics };
      this.store.put('reach', result); this.emit(sessionId, 'checkpoint.result', result); return result;
    };
    try {
      await this.attach(sessionId); await this.capture(sessionId, 'recovery');
      strategies.push('verify_current');
      let verification = await this.verify(sessionId, checkpoint); checks = verification.checks;
      if (verification.status) { status = verification.status; reason = `Checkpoint verification: ${status}`; return finish(); }
      const triedExits = new Set<string>();
      let returnedToSource = false;
      strategies.push('boundary_exit');
      while (true) {
        const current = this.observation(sessionId);
        const close = this.adapter.returnAction?.(this.actions(sessionId).filter(a => !triedExits.has(this.boundaryExitKey(a, current))), current);
        if (!close) {
          if (current.boundaries?.length) { reason = 'Active interaction boundary could not be exited and verified'; return finish(); }
          const sourceReturn = !returnedToSource && this.observationReturn(sessionId, this.observation(sessionId, checkpoint.observationId));
          if (sourceReturn) {
            returnedToSource = true; strategies.push('observed_source_return'); this.store.put('action', sourceReturn);
            const attempt = await this.runAction(sessionId, sourceReturn.id, id(), undefined, 'recovery'); performed.push(attempt.id);
            verification = await this.verify(sessionId, checkpoint); checks = verification.checks;
            if (attempt.status !== 'succeeded') { status = 'UNVERIFIED'; reason = 'Return to observed source could not be verified'; return finish(); }
            if (verification.status) { status = verification.status; reason = 'Verified after return to observed source'; return finish(); }
            triedExits.clear();
            // Native history may restore an open interaction boundary. Exit and
            // verify it before considering any replay or environment reopening.
            continue;
          }
          break;
        }
        triedExits.add(this.boundaryExitKey(close, current));
        const a = await this.runAction(sessionId, close.id, id(), undefined, 'recovery'); performed.push(a.id);
        verification = await this.verify(sessionId, checkpoint); checks = verification.checks;
        if (verification.status) { status = verification.status; reason = 'Verified after boundary exit attempt'; return finish(); }
      }
      strategies.push('recorded_path');
      const path = this.navigationPath(sessionId, this.observation(sessionId).stateId, checkpoint.stateId);
      if (path?.length) {
        const failure = await this.replay(sessionId, path, false, performed);
        verification = await this.verify(sessionId, checkpoint); checks = verification.checks;
        if (verification.status) { status = verification.status; reason = failure || 'Recorded path verified'; return finish(); }
        if (failure) { reason = failure; return finish(); }
      }
      strategies.push('declared_local_restore');
      const restored = new Set<string>();
      while (!this.session(sessionId).dirty && this.adapter.restorationStep) {
        const current = this.observation(sessionId);
        const step = this.adapter.restorationStep(this.observation(sessionId, checkpoint.observationId), current, this.session(sessionId));
        if (!step) break;
        const key = canonical({ from: current.canonical, control: step.action.controlId, kind: step.action.kind, value: step.action.value });
        if (restored.has(key)) break;
        restored.add(key);
        const action = this.constrain(step.action, current, this.session(sessionId));
        if (action.risk !== 'interface' || !action.replayable || action.excluded || action.preconditions.blockers?.length || !action.preconditions.identityResolved || action.basis?.status === 'tentative') break;
        this.store.put('action', action);
        const attempt = await this.runAction(sessionId, action.id, id(), undefined, 'recovery'); performed.push(attempt.id);
        if (attempt.status !== 'succeeded' || this.observation(sessionId).canonical !== step.expectedCanonical) {
          status = 'UNVERIFIED'; reason = 'Declared local restoration diverged from its expected observation'; return finish();
        }
        this.emit(sessionId, 'checkpoint.local_restore', { checkpointId, attemptId: attempt.id, evidence: step.evidence });
        verification = await this.verify(sessionId, checkpoint); checks = verification.checks;
        if (verification.status) { status = verification.status; reason = 'Verified after declared local restoration'; return finish(); }
      }
      let session = this.session(sessionId); let resetConfirmed = false; let entryReopened = false;
      if (session.dirty && this.hooks.reset) {
        await this.beforeAction(sessionId);
        strategies.push('reset_hook');
        const result = await this.hook(sessionId, 'reset', () => this.hooks.reset!(structuredClone(session)));
        resetConfirmed = result.value?.reset === true && !!result.value.evidence.length;
        this.emit(sessionId, 'environment.reset', result.value || { error: result.error });
        if (resetConfirmed) { session.dirty = false; session.dirtyAttemptIds = []; this.store.put('session', session); }
      }
      const resetAction = session.dirty && !resetConfirmed ? this.adapter.resetAction?.(this.observation(sessionId), session) : undefined;
      if (resetAction) {
        strategies.push('configured_environment_reset');
        this.store.put('action', resetAction);
        const attempt = await this.runAction(sessionId, resetAction.id, id(), undefined, 'recovery'); performed.push(attempt.id);
        resetConfirmed = attempt.status === 'succeeded'; entryReopened = resetConfirmed;
        this.emit(sessionId, 'environment.reset', { reset: resetConfirmed, attemptId: attempt.id, evidence: resetAction.basis?.evidence || [] });
        if (!resetConfirmed) { status = 'UNVERIFIED'; reason = 'Configured environment reset could not be verified'; return finish(); }
        session = this.session(sessionId); session.dirty = false; session.dirtyAttemptIds = []; this.store.put('session', session);
      }
      if (session.dirty && !resetConfirmed) { reason = 'Cannot restore checkpoint: no verified return path and business state requires an environment reset'; return finish(); }
      if (!resetConfirmed && checkpoint.path.some(a => !this.owned<ActionAttempt>('attempt', a, sessionId).action.replayable)) { reason = 'Checkpoint path contains actions without replay permission'; return finish(); }
      // Reopening the interaction driver follows the same durable intent/result ledger as every other action.
      if (!entryReopened) {
        this.budget(session);
        strategies.push('entry_replay');
        const beforeEntry = this.observation(sessionId);
        const entry = this.adapter.entryAction?.(beforeEntry, session);
        if (!entry) { reason = 'Adapter does not provide an entry recovery action'; return finish(); }
        this.store.put('action', entry);
        const entryAttempt = await this.runAction(sessionId, entry.id, id(), undefined, 'recovery'); performed.push(entryAttempt.id);
        if (entryAttempt.status !== 'succeeded') { status = 'UNVERIFIED'; reason = 'Entry reopening could not be verified'; return finish(); }
      }
      const failure = await this.replay(sessionId, checkpoint.path, resetConfirmed, performed);
      verification = await this.verify(sessionId, checkpoint); checks = verification.checks;
      status = verification.status || (failure === 'preconditions_changed' ? 'PRECONDITIONS_CHANGED' : 'UNREACHABLE'); reason = failure || `Entry replay verification: ${status}`;
    } catch (error) { reason = String(error); status = error instanceof EngineError && error.code === 'BUDGET_EXHAUSTED' ? 'UNREACHABLE' : 'UNVERIFIED'; }
    return finish();
  }
  reachCheckpoint(sessionId: string, checkpointId: string) { this.pauseRequested = true; return this.enqueueMeasured(sessionId, () => this.reachInternal(sessionId, checkpointId)); }
  async pause(sessionId: string) { this.pauseRequested = true; return this.enqueue(async () => { const session = this.session(sessionId); session.status = 'paused'; session.mode = 'manual'; this.store.put('session', session); this.emit(sessionId, 'session.paused', session); return session; }); }
  async stop(sessionId: string) { this.pauseRequested = true; return this.enqueue(async () => { const session = this.session(sessionId); session.status = 'stopped'; this.store.put('session', session); if (this.activeId === sessionId) { await this.driver?.close(); this.driver = undefined; this.activeId = undefined; } this.emit(sessionId, 'session.stopped', session); return session; }); }
  async explore(sessionId: string): Promise<Session<S>> {
    return this.enqueue(async () => {
      await this.attach(sessionId);
      if (this.runner && !this.pauseRequested && this.session(sessionId).status === 'running') return this.session(sessionId);
      await this.capture(sessionId, 'inspection');
      const session = this.session(sessionId); session.status = 'running'; session.mode = 'dfs'; session.stopReason = undefined; this.store.put('session', session); this.pauseRequested = false; this.emit(sessionId, 'exploration.started', session);
      const epoch = ++this.runEpoch; const task = this.explorationLoop(sessionId, epoch); this.runner = task;
      void task.finally(() => { if (this.runner === task) this.runner = undefined; });
      return session;
    });
  }
  async waitForIdle() { await this.runner; await this.queue; }
  /** Follow observed reveal relationships without treating inline UI as an exclusive boundary. */
  private async revealFrontierTarget(sessionId: string, item: FrontierItem, tried: Set<string>) {
    const current = this.observation(sessionId);
    const targetId = item.action.controlId;
    if (!targetId || !item.action.preconditions.identityResolved || !this.adapter.explorationScope) return false;
    const visible = (o: O, controlId: string, resolved = true) => {
      const matches = o.controls.filter(c => c.identityId === controlId && c.visible);
      return resolved ? matches.length === 1 && !matches[0].hypothesisId : matches.length > 0;
    };
    if (visible(current, targetId, false)) return false;
    const scope = this.adapter.explorationScope(current);
    const attempts = this.store.list<ActionAttempt>('attempt', sessionId);
    const visits = this.store.list<Visit>('visit', sessionId);
    const indices = new Map(visits.map((v, i) => [v.observationId, i]));
    const history = attempts.filter(a => a.status === 'succeeded' && a.afterId
      && a.action.controlId && a.action.risk === 'interface' && a.action.replayable && a.action.preconditions.identityResolved
      && a.action.basis?.status !== 'tentative').toReversed().flatMap(attempt => {
      const before = this.observation(sessionId, attempt.beforeId);
      const start = indices.get(attempt.afterId!);
      const next = attempts[attempts.indexOf(attempt) + 1];
      const end = next ? indices.get(next.beforeId) : visits.length - 1;
      if (start === undefined || end === undefined || start > end) return [];
      // Async content may first appear in a later inspection. Include only the
      // contiguous read-only interval before the next attempt (even a failed one).
      const observations: O[] = [];
      for (let i = start; i <= end; i++) {
        const o = this.observation(sessionId, visits[i].observationId);
        if (i !== start && (visits[i].viaAttemptId || o.cause !== 'inspection')) break;
        if (o.instanceScope !== current.instanceScope || o.gaps.some(g => g.critical)
          || contextKey(o.context) !== item.contextKey || this.adapter.explorationScope!(o) !== scope) break;
        observations.push(o);
      }
      // A same-document reveal is evidence for another traversal attempt, not a
      // cross-document identity decision or proof that business state was reset.
      return before.instanceScope === current.instanceScope && !before.gaps.some(g => g.critical)
        && contextKey(before.context) === item.contextKey && this.adapter.explorationScope!(before) === scope
        ? observations.toReversed().map(after => ({ attempt, before, after })) : [];
    });
    const actions = this.actions(sessionId);
    const entry = (controlId: string, seen: Set<string>): { recorded: ActionAttempt; witnessed: O; action: ActionCandidate; reveals: string; key: string } | undefined => {
      if (seen.has(controlId)) return;
      const next = new Set(seen).add(controlId);
      for (const { attempt, before, after } of history) {
        if (visible(before, controlId, false) || !visible(after, controlId)) continue;
        const target = after.controls.find(c => c.identityId === controlId)!;
        // Resolving an already visible instance's identity is not a UI reveal.
        if (before.controls.some(c => c.visible && c.hypothesisId && c.instanceId === target.instanceId)) continue;
        const key = canonical({ frontier: item.id, entry: attempt.action.controlId, kind: attempt.action.kind, value: attempt.action.value });
        if (tried.has(key)) continue;
        const matches = actions.filter(a => this.adapter.replayMatches(a, attempt.action) && a.replayable && a.risk === 'interface'
          && a.basis?.status !== 'tentative' && !a.excluded && !a.preconditions.blockers?.length
          && a.preconditions.visible && a.preconditions.enabled && this.targetResolved(a, current));
        if (matches.length === 1) return { recorded: attempt, witnessed: after, action: matches[0], reveals: controlId, key };
        // Nested menus may require revealing their opener first. Execute only
        // one currently valid step, then re-plan from the new complete capture.
        if (!visible(current, attempt.action.controlId!, false)) {
          const parent = entry(attempt.action.controlId!, next);
          if (parent) return parent;
        }
      }
    };
    const plan = entry(targetId, new Set());
    if (!plan) return false;
    tried.add(plan.key);
    const result = await this.runAction(sessionId, plan.action.id, id(), plan.recorded.action.value, 'recovery');
    const after = this.observation(sessionId);
    this.emit(sessionId, 'exploration.target_reentry', { frontierId: item.id, attemptId: result.id, sourceAttemptId: plan.recorded.id,
      sourceObservationId: plan.witnessed.id, attribution: 'observed_during_interval',
      expectedControlId: plan.reveals, targetControlId: targetId, observationId: after.id,
      revealed: !after.gaps.some(g => g.critical) && visible(after, plan.reveals) });
    return true;
  }
  /** Re-enter a previously observed interaction scope without claiming checkpoint equality. */
  private async enterFrontierScope(sessionId: string, item: FrontierItem, tried: Set<string>) {
    const current = this.observation(sessionId);
    if (current.boundaries?.length || tried.has(item.id) || !this.adapter.explorationScope) return false;
    const target = this.observation(sessionId, item.action.observationId);
    const boundary = target.boundaries?.[0];
    if (contextKey(current.context) !== item.contextKey) return false;
    const returnKey = `source-return:${item.id}`;
    const sourceReturn = !tried.has(returnKey) && this.observationReturn(sessionId, target);
    if (sourceReturn) {
      tried.add(returnKey); this.store.put('action', sourceReturn);
      const result = await this.runAction(sessionId, sourceReturn.id, id(), undefined, 'recovery');
      const after = this.observation(sessionId);
      this.emit(sessionId, 'exploration.source_return', { frontierId: item.id, attemptId: result.id, targetObservationId: target.id,
        observationId: after.id, returnedScope: result.status === 'succeeded' && !after.gaps.some(g => g.critical)
          && this.adapter.explorationScope(after) === this.adapter.explorationScope(target) });
      return true;
    }
    if (!boundary) return this.revealFrontierTarget(sessionId, item, tried);
    const openers = this.store.list<ActionAttempt>('attempt', sessionId).filter(a => a.status === 'succeeded' && a.afterId && a.action.risk === 'interface' && a.action.replayable
      && contextKey(a.action.preconditions.context) === item.contextKey
      && this.adapter.explorationScope!(this.observation(sessionId, a.beforeId)) === this.adapter.explorationScope!(current)
      && !this.observation(sessionId, a.beforeId).boundaries?.some(b => b.key === boundary.key)
      && this.observation(sessionId, a.afterId).boundaries?.some(b => b.key === boundary.key));
    for (const old of openers) {
      const matches = this.actions(sessionId).filter(a => this.adapter.replayMatches(a, old.action) && a.replayable && a.risk === 'interface'
        && !a.excluded && !a.preconditions.blockers?.length && a.preconditions.enabled && this.targetResolved(a, current));
      if (matches.length !== 1) continue;
      tried.add(item.id);
      const result = await this.runAction(sessionId, matches[0].id, id(), old.action.value, 'recovery');
      this.emit(sessionId, 'exploration.scope_reentry', { frontierId: item.id, attemptId: result.id, boundaryKey: boundary.key,
        entered: this.observation(sessionId).boundaries?.some(b => b.key === boundary.key) || false });
      return true;
    }
    return false;
  }
  private async explorationLoop(sessionId: string, epoch: number) {
    const triedScopeEntries = new Set<string>();
    while (!this.pauseRequested && !this.closing && epoch === this.runEpoch) {
      try {
        const keepGoing = await this.enqueueMeasured(sessionId, async () => {
          if (this.pauseRequested || epoch !== this.runEpoch) return false;
          const session = this.session(sessionId); this.budget(session);
          const o = this.observation(sessionId);
          if (o.gaps.some(g => g.critical)) {
            session.status = 'paused'; session.stopReason = 'OBSERVATION_INCOMPLETE'; this.pauseRequested = true; this.store.put('session', session);
            this.emit(sessionId, 'exploration.paused', { reason: session.stopReason, observationId: o.id, gaps: o.gaps });
            return false;
          }
          let pending = this.frontier(sessionId).filter(f => f.status === 'pending');
          const boundary = o.boundaries?.at(-1);
          const isExit = (f: FrontierItem) => !!boundary && f.stateId === o.stateId && f.action.boundary?.key === boundary.key && f.action.boundary.intent === 'exit';
          const explored = new Set(this.store.list<ActionAttempt>('attempt', sessionId).filter(a => a.status === 'succeeded').map(a => a.action.controlId));
          const novelty = (f: FrontierItem) => session.options.exploration === 'controls' && (f.action.kind === 'scroll' || f.action.controlId && !explored.has(f.action.controlId)) ? 0 : 1;
          const observationOrder = new Map(this.store.list<Visit>('visit', sessionId).map((v, i) => [v.observationId, i]));
          const revealed = (f: FrontierItem) => session.options.exploration === 'controls' && f.action.controlId
            ? observationOrder.get(f.sampling?.observationIds[0] || f.action.observationId) ?? 0 : 0;
          for (const f of pending.filter(f => f.depth >= session.options.maxDepth && !isExit(f))) { f.status = 'blocked'; f.reason = 'depth_budget'; f.unblock = 'Increase maxDepth'; this.store.put('frontier', f); }
          pending = pending.filter(f => f.depth < session.options.maxDepth || isExit(f)).sort((a, b) => b.depth - a.depth);
          if (boundary) {
            // Never navigate to another branch while an exclusive interaction is open.
            // Adapters classify targets; core only enforces the generic boundary contract.
            pending = pending.filter(f => f.stateId === o.stateId && f.action.boundary?.key === boundary.key && !f.action.preconditions.blockers?.length);
            const scope = this.store.list<InteractionScope>('scope', sessionId).find(s => s.status === 'open' && s.boundaryKey === boundary.key);
            const attempted = new Set<string>();
            for (const aid of scope?.attemptIds || []) {
              const a = this.store.get<ActionAttempt>('attempt', aid);
              if (!a || a.action.boundary?.key !== boundary.key) continue;
              if (a.action.boundary.intent !== 'exit') { attempted.clear(); continue; }
              attempted.add(this.boundaryExitKey(a.action, this.observation(sessionId, a.beforeId)));
            }
            pending = pending.filter(f => {
              if (!isExit(f) || !attempted.has(this.boundaryExitKey(f.action, o))) return true;
              f.status = 'blocked'; f.reason = 'boundary_exit_not_verified';
              f.unblock = 'Try a different exit or change the active boundary before retrying this operation'; this.store.put('frontier', f); return false;
            });
            pending.sort((a, b) => Number(isExit(a)) - Number(isExit(b))
              || (session.options.exploration === 'controls' ? Number(a.action.risk !== 'interface') - Number(b.action.risk !== 'interface') : 0)
              || novelty(a) - novelty(b) || revealed(b) - revealed(a));
            if (!pending.length) {
              // Sampling can finish this scope before a later visit. Exiting is
              // still necessary traversal work, even when its sample was executed.
              if (['controls', 'representative'].includes(session.options.exploration || '')) {
                const exit = this.adapter.returnAction?.(this.actions(sessionId).filter(a => !attempted.has(this.boundaryExitKey(a, o))), o);
                if (exit) { await this.runAction(sessionId, exit.id, id(), undefined, 'recovery'); return true; }
              }
              session.status = 'paused'; session.stopReason = 'ACTIVE_BOUNDARY_BLOCKED'; this.pauseRequested = true; this.store.put('session', session);
              this.emit(sessionId, 'exploration.boundary_blocked', { boundary, observationId: o.id, reason: 'No untried executable operation or exit in the active boundary; parent exploration remains suspended' });
              return false;
            }
          }
          if (!pending.length) {
            const waiting = this.frontier(sessionId).filter(f => f.status === 'deferred' && f.reason === 'awaiting_list_decision');
            if (waiting.length) {
              session.status = 'paused'; session.stopReason = 'LIST_DECISION_REQUIRED'; this.pauseRequested = true; this.store.put('session', session);
              this.emit(sessionId, 'exploration.paused', { reason: session.stopReason, groupIds: [...new Set(waiting.flatMap(f => f.explorationGroups?.map(g => g.groupId) || []))] }); return false;
            }
            session.status = 'finished'; session.stopReason = this.frontier(sessionId).some(f => !['executed', 'superseded'].includes(f.status)) ? 'known_frontier_exhausted_with_gaps' : 'known_frontier_exhausted'; this.store.put('session', session); this.emit(sessionId, 'exploration.finished', this.report(sessionId)); return false;
          }
          // Controls mode prefers unseen targets; risk breaks ties. Representative
          // mode exhausts ordinary work first. The caller may override ordering.
          const riskOrdered = !boundary && ['controls', 'representative'].includes(session.options.exploration || '');
          if (riskOrdered) pending.sort((a, b) => novelty(a) - novelty(b) || Number(a.action.risk !== 'interface') - Number(b.action.risk !== 'interface')
            || Number(b.stateId === o.stateId) - Number(a.stateId === o.stateId) || revealed(b) - revealed(a) || b.depth - a.depth);
          if (!boundary) pending.sort((a, b) => Number(!!a.explorationGroups?.length) - Number(!!b.explorationGroups?.length));
          const eligible = !boundary ? pending.filter(f => !!f.explorationGroups?.length === !!pending[0].explorationGroups?.length) : pending;
          const pool = riskOrdered ? eligible.filter(f => novelty(f) === novelty(eligible[0]) && (f.action.risk === 'interface') === (eligible[0].action.risk === 'interface')) : eligible;
          let chosen = pool.find(f => f.stateId === o.stateId) || pool[0];
          if (this.hooks.choose) {
            const result = await this.hook(sessionId, 'choose', () => this.hooks.choose!(describeFrontier(structuredClone(pending), this.store.list<ActionAttempt>('attempt', sessionId)), structuredClone({ session, observation: o })));
            if (result.error || result.value === null) { this.pauseRequested = true; session.status = 'paused'; session.stopReason = result.error || 'external_strategy_paused'; this.store.put('session', session); return false; }
            const item = pending.find(f => f.id === result.value); if (!item) throw new EngineError('INVALID_STRATEGY_CHOICE', 'Strategy returned an unknown frontier item'); chosen = item;
          }
          if (chosen.stateId !== this.observation(sessionId).stateId) {
            if (session.options.exploration === 'controls' && await this.enterFrontierScope(sessionId, chosen, triedScopeEntries)) return true;
            const state = this.owned<UIState>('state', chosen.stateId, sessionId); const checkpoint = this.checkpointInternal(sessionId, 'Exploration branch', [], [], state.observationIds[0]);
            const result = await this.reachInternal(sessionId, checkpoint.id);
            if (result.status !== 'REACHED_VERIFIED') {
              // One failed reach proves the same target unavailable for all of
              // its pending work at this instant. Do not repeat a full capture
              // for each sibling. Later observations can revalidate the items.
              const affected = this.frontier(sessionId).filter(f => f.status === 'pending' && f.stateId === chosen.stateId && f.contextKey === chosen.contextKey);
              for (const item of affected) {
                item.status = 'blocked'; item.reason = result.reason; item.unblock = 'Reach the branch checkpoint or repair its preconditions';
                if (result.diagnostics) item.recovery = { resultId: result.id, diagnostics: result.diagnostics };
                this.store.put('frontier', item);
              }
              this.emit(sessionId, 'exploration.recovery_shared', { resultId: result.id, targetStateId: chosen.stateId, frontierIds: affected.map(f => f.id) });
              return true;
            }
          }
          const action = this.actions(sessionId).find(a => this.frontierKey(a) === chosen.key);
          if (!action) { chosen.status = 'blocked'; chosen.reason = 'action_no_longer_available'; this.store.put('frontier', chosen); return true; }
          try { await this.runAction(sessionId, action.id, id(), undefined, 'exploration'); }
          catch (error) {
            if (error instanceof EngineError && ['STALE_OBSERVATION', 'PRECONDITIONS_CHANGED'].includes(error.code)) { chosen.status = 'needs_revalidation'; chosen.reason = error.code; this.store.put('frontier', chosen); }
            else if (error instanceof EngineError && error.code === 'ACTION_BLOCKED') { chosen.status = 'blocked'; chosen.reason = error.message; this.store.put('frontier', chosen); }
            else throw error;
          }
          return true;
        });
        if (!keepGoing) break;
        await sleep(0);
      } catch (error) {
        await this.enqueue(async () => { const s = this.session(sessionId); s.status = 'paused'; s.stopReason = error instanceof EngineError ? error.code : String(error); this.store.put('session', s); this.emit(sessionId, 'exploration.paused', { reason: s.stopReason }); }); break;
      }
    }
  }
  async close() { this.closing = true; this.pauseRequested = true; await this.runner; await this.queue; await this.driver?.close(); await this.store.evidence.flush?.(); this.store.close(); }
}
