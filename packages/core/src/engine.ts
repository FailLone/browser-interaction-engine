import { EventBus } from './events.js';
import { contextSchema, actionBasisSchema } from './schema.js';
import { assignState, matchIdentities } from './identity.js';
import { recoverStore } from './recovery.js';
import { describeFrontier, groupFrontier } from './frontier.js';
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
  constructor(options: EngineOptions<O, S>) {
    this.store = options.persistence; this.adapter = options.adapter; this.hooks = options.hooks || {};
    recoverStore(this.store);
  }
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
  report(sessionId: string) {
    const frontier = this.list<FrontierItem>(sessionId, 'frontier'); const attempts = this.list<ActionAttempt>(sessionId, 'attempt'); const observations = this.list<O>(sessionId, 'observation');
    const counts = (items: { status: string }[]) => items.reduce<Record<string, number>>((out, i) => { out[i.status] = (out[i.status] || 0) + 1; return out; }, {});
    return { session: this.session(sessionId), states: this.getGraph(sessionId).states.length, observations: observations.length, attempts: counts(attempts), frontier: counts(frontier), frontierCoverage: this.frontierCoverage(sessionId).map(({ id, controlId, kind, label, coverageStatus, counts }) => ({ id, controlId, kind, label, coverageStatus, counts })), gaps: observations.flatMap(o => o.gaps.map(g => ({ ...g, observationId: o.id }))), issues: this.list<Issue>(sessionId, 'issue'), coverage: 'discovered operations under the current budgets and observation contract; coverage of the entire interaction space is unknown' };
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
    await this.store.evidence.beginObservation?.({ sessionId, observationId, policy: session.options.evidenceRetention });
    try {
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
    if (o.gaps.some(g => g.critical)) for (const identity of matched.identities) if (identity.status !== 'present') identity.status = 'unknown';
    this.store.transaction(() => {
      this.store.put('observation', o); this.store.put('state', state); this.store.put('visit', visit);
      for (const identity of matched.identities) this.store.put('identity', identity);
      for (const hypothesis of matched.hypotheses) { this.store.put('hypothesis', hypothesis); this.emit(sessionId, 'identity.ambiguous', hypothesis); }
      if (previous && contextKey(previous.context) !== contextKey(o.context)) for (const item of this.frontier(sessionId)) {
        if (item.contextKey !== contextKey(o.context) && item.status !== 'executing') { item.status = 'needs_revalidation'; item.reason = 'business_context_changed'; this.store.put('frontier', item); }
      }
      for (const action of actions) {
        this.store.put('action', action);
        // These remain inspectable candidates. Their parent-state work is queued
        // only when that state is observed without the exclusive child boundary.
        if (this.outsideBoundary(action)) continue;
        const key = this.frontierKey(action);
        const existing = this.store.list<FrontierItem>('frontier', sessionId).find(f => f.key === key);
        const blocker = action.preconditions.blockers?.[0];
        const tentative = action.basis?.status === 'tentative';
        const reason = action.exclusionReason || (!action.preconditions.identityResolved ? 'identity_ambiguous' : !action.preconditions.enabled ? 'disabled' : blocker?.code) || (tentative ? 'action_basis_unconfirmed' : undefined);
        const unblock = blocker?.unblock || (tentative ? 'Explicitly execute a probe, or supply an action hook with supporting evidence' : undefined);
        if (tentative) this.emit(sessionId, 'action.tentative', { actionId: action.id, observationId: o.id, basis: action.basis });
        if (!existing) {
          const f: FrontierItem = { id: id(), sessionId, key, stateId: o.stateId, contextKey: contextKey(o.context), action, status: reason || action.excluded ? 'blocked' : 'pending', reason, unblock, depth: visit.depth, attempts: [] };
          this.store.put('frontier', f);
        } else {
          const temporarilyBlocked = existing.status === 'blocked' && (!!existing.action.preconditions.blockers?.length || existing.reason === 'action_basis_unconfirmed');
          existing.action = action;
          if (existing.status === 'pending' || temporarilyBlocked || (existing.status === 'blocked' && existing.reason === 'identity_ambiguous' && action.preconditions.identityResolved) || existing.status === 'needs_revalidation') {
            existing.status = reason || action.excluded ? 'blocked' : 'pending'; existing.reason = reason; existing.unblock = unblock;
          }
          this.store.put('frontier', existing);
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
    await this.store.evidence.endObservation?.(observationId, true);
    let resolvedByHook = false;
    for (const hypothesis of matched.hypotheses) if (this.hooks.identity) {
      const result = await this.hook(sessionId, 'identity', () => this.hooks.identity!(structuredClone(hypothesis), ctx()));
      if (result.value) { const resolution = await this.hook(sessionId, 'identity-resolution', () => this.resolveIdentityInternal(sessionId, hypothesis.id, result.value!.identityId, result.value!.source, result.value!.evidence)); if (resolution.value) resolvedByHook = true; }
    }
    if (resolvedByHook) return this.capture(sessionId, 'inspection');
    return o;
    } catch (error) { await this.store.evidence.endObservation?.(observationId, !!this.store.get('observation', observationId)); throw error; }
  }
  private frontierKey(a: ActionCandidate) { return hash({ state: a.stateId, control: a.controlId, kind: a.kind, value: a.value, context: a.preconditions.context }); }
  private constrain(action: ActionCandidate, observation: O, session: Session<S>) {
    const result = this.adapter.constrain(action, observation, session);
    if (!result.kind || typeof result.kind !== 'string') throw new EngineError('INVALID_PLUGIN_ACTION', 'Action kind must be a nonempty string');
    if (result.basis) result.basis = actionBasisSchema.parse(result.basis);
    if (result.basis?.status === 'tentative') result.replayable = false;
    const control = observation.controls.find(c => c.identityId === result.controlId && c.localId === result.localId);
    if (result.controlId && !control) { result.excluded = true; result.exclusionReason = 'unknown_control'; }
    result.preconditions = { ...result.preconditions, context: observation.context, visible: control?.visible ?? true, enabled: control?.enabled ?? true, identityResolved: !control?.hypothesisId };
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
    for (const item of this.store.list<FrontierItem>('frontier', attempt.sessionId).filter(f => f.key === this.frontierKey(attempt.action))) {
      item.status = attempt.status === 'succeeded' ? 'executed' : attempt.status === 'failed' || attempt.status === 'blocked' ? 'blocked' : attempt.status === 'executing' ? 'executing' : 'unknown';
      item.reason = attempt.reason; if (!item.attempts.includes(attempt.id)) item.attempts.push(attempt.id); this.store.put('frontier', item);
    }
  }
  private async runAction(sessionId: string, actionId: string, requestId: string, value?: ActionCandidate['value'], purpose: ActionAttempt['purpose'] = 'external'): Promise<ActionAttempt> {
    const payload = canonical({ actionId, value }); const prior = this.store.request(sessionId, requestId);
    if (prior) { if (prior.payload !== payload) throw new EngineError('REQUEST_CONFLICT', 'Request ID was used with different parameters'); return this.owned<ActionAttempt>('attempt', prior.attemptId, sessionId); }
    await this.attach(sessionId); let session = this.session(sessionId); this.budget(session);
    const original = this.owned<ActionCandidate>('action', actionId, sessionId);
    const originalObservation = this.observation(sessionId, original.observationId);
    const current = this.observation(sessionId);
    if (current.id !== original.observationId) throw new EngineError('STALE_OBSERVATION', 'Choose an action from the latest observation', { observationId: current.id, actions: this.actions(sessionId) });
    if (original.excluded && original.exclusionReason !== 'input_sample_required') throw new EngineError('ACTION_EXCLUDED', original.exclusionReason || 'Action excluded');
    if (original.basis?.status === 'tentative' && purpose !== 'external') throw new EngineError('ACTION_BLOCKED', 'action_basis_unconfirmed');
    if (!original.preconditions.identityResolved) throw new EngineError('IDENTITY_AMBIGUOUS', 'Resolve the identity before acting');
    const preflight = await this.driver!.preflight(current);
    if (preflight !== 'valid') {
      const fresh = await this.capture(sessionId, 'external');
      throw new EngineError(preflight === 'context_changed' ? 'PRECONDITIONS_CHANGED' : 'STALE_OBSERVATION', 'Interaction source changed before execution', { observationId: fresh.id, actions: this.actions(sessionId) });
    }
    const constrained = original.source === 'recovery-entry' ? original : this.constrain(structuredClone(original), current, session);
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
    const attempt: ActionAttempt = { id: id(), sessionId, requestId, action, startedAt: now(), beforeId: current.id, status: 'executing', purpose };
    const started = Date.now();
    this.store.transaction(() => {
      session.actionCount++; if (action.risk !== 'interface') session.dirty = true; this.store.put('session', session);
      if (!this.store.list<FrontierItem>('frontier', sessionId).some(f => f.key === this.frontierKey(action))) this.store.put('frontier', { id: id(), sessionId, key: this.frontierKey(action), stateId: action.stateId, contextKey: contextKey(action.preconditions.context), action, status: 'executing', attempts: [], depth: this.owned<Visit>('visit', current.visitId, sessionId).depth } as FrontierItem);
      this.store.put('attempt', attempt); this.store.recordRequest(sessionId, requestId, attempt.id, payload); this.updateFrontier(attempt); this.emit(sessionId, 'action.started', attempt);
    });
    let openedScope: InteractionScope | undefined;
    const scopeBefore = this.adapter.scopeBefore?.(action, current);
    if (scopeBefore) openedScope = this.openScopeInternal(sessionId, scopeBefore.name, scopeBefore.region, true);
    try {
      if (action.source === 'recovery-entry') await this.driver!.reopen();
      else await this.driver!.execute(action, control);
    }
    catch (error) { attempt.status = 'failed'; attempt.reason = String(error); this.store.put('attempt', attempt); }
    try {
      const after = await this.capture(sessionId, purpose === 'recovery' ? 'recovery' : 'action', attempt.id, action.source === 'recovery-entry' ? '' : undefined);
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
      if (visit.viaAttemptId) { const a = this.owned<ActionAttempt>('attempt', visit.viaAttemptId, sessionId); if (a.action.source === 'recovery-entry') break; result.unshift(visit.viaAttemptId); }
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
    if (o.gaps.some(g => g.critical) || checks.some(c => c.result === 'unknown')) return { status: 'UNVERIFIED', checks: [...checks, { name: 'observation-completeness', result: 'unknown' }] };
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
  private async reachInternal(sessionId: string, checkpointId: string): Promise<ReachResult> {
    const checkpoint = this.owned<Checkpoint>('checkpoint', checkpointId, sessionId); const performed: string[] = [];
    let checks: ReachResult['checks'] = []; let status: ReachResult['status'] = 'UNREACHABLE'; let reason = 'No verified path within the current recovery constraints';
    const finish = () => {
      const result: ReachResult = { id: id(), sessionId, checkpointId, status, reason, checks, attemptIds: performed, observationId: this.session(sessionId).currentObservationId, remainingFrontier: this.frontier(sessionId).filter(f => f.status !== 'executed').length };
      this.store.put('reach', result); this.emit(sessionId, 'checkpoint.result', result); return result;
    };
    try {
      await this.attach(sessionId); await this.capture(sessionId, 'recovery');
      let verification = await this.verify(sessionId, checkpoint); checks = verification.checks;
      if (verification.status) { status = verification.status; reason = `Checkpoint verification: ${status}`; return finish(); }
      const triedExits = new Set<string>();
      while (true) {
        const current = this.observation(sessionId);
        const close = this.adapter.returnAction?.(this.actions(sessionId).filter(a => !triedExits.has(this.frontierKey(a))), current);
        if (!close) {
          if (current.boundaries?.length) { reason = 'Active interaction boundary could not be exited and verified'; return finish(); }
          break;
        }
        triedExits.add(this.frontierKey(close));
        const a = await this.runAction(sessionId, close.id, id(), undefined, 'recovery'); performed.push(a.id);
        verification = await this.verify(sessionId, checkpoint); checks = verification.checks;
        if (verification.status) { status = verification.status; reason = 'Verified after boundary exit attempt'; return finish(); }
      }
      const path = this.navigationPath(sessionId, this.observation(sessionId).stateId, checkpoint.stateId);
      if (path?.length) {
        const failure = await this.replay(sessionId, path, false, performed);
        verification = await this.verify(sessionId, checkpoint); checks = verification.checks;
        if (verification.status) { status = verification.status; reason = failure || 'Recorded path verified'; return finish(); }
        if (failure) { reason = failure; return finish(); }
      }
      let session = this.session(sessionId); let resetConfirmed = false;
      if (session.dirty && this.hooks.reset) {
        const result = await this.hook(sessionId, 'reset', () => this.hooks.reset!(structuredClone(session)));
        resetConfirmed = result.value?.reset === true && !!result.value.evidence.length;
        this.emit(sessionId, 'environment.reset', result.value || { error: result.error });
        if (resetConfirmed) { session.dirty = false; this.store.put('session', session); }
      }
      if (session.dirty && !resetConfirmed) { reason = 'Cannot restore checkpoint: no verified return path and business state requires an environment reset'; return finish(); }
      if (!resetConfirmed && checkpoint.path.some(a => !this.owned<ActionAttempt>('attempt', a, sessionId).action.replayable)) { reason = 'Checkpoint path contains actions without replay permission'; return finish(); }
      this.budget(session);
      // Reopening the interaction driver follows the same durable intent/result ledger as every other action.
      const beforeEntry = this.observation(sessionId);
      const entry = this.adapter.entryAction?.(beforeEntry, session);
      if (!entry) { reason = 'Adapter does not provide an entry recovery action'; return finish(); }
      this.store.put('action', entry);
      const entryAttempt = await this.runAction(sessionId, entry.id, id(), undefined, 'recovery'); performed.push(entryAttempt.id);
      if (entryAttempt.status !== 'succeeded') { status = 'UNVERIFIED'; reason = 'Entry reopening could not be verified'; return finish(); }
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
  private async explorationLoop(sessionId: string, epoch: number) {
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
          for (const f of pending.filter(f => f.depth >= session.options.maxDepth && !isExit(f))) { f.status = 'blocked'; f.reason = 'depth_budget'; f.unblock = 'Increase maxDepth'; this.store.put('frontier', f); }
          pending = pending.filter(f => f.depth < session.options.maxDepth || isExit(f)).sort((a, b) => b.depth - a.depth);
          if (boundary) {
            // Never navigate to another branch while an exclusive interaction is open.
            // Adapters classify targets; core only enforces the generic boundary contract.
            pending = pending.filter(f => f.stateId === o.stateId && f.action.boundary?.key === boundary.key && !f.action.preconditions.blockers?.length);
            pending.sort((a, b) => Number(isExit(a)) - Number(isExit(b)));
            if (!pending.length) {
              session.status = 'paused'; session.stopReason = 'ACTIVE_BOUNDARY_BLOCKED'; this.pauseRequested = true; this.store.put('session', session);
              this.emit(sessionId, 'exploration.boundary_blocked', { boundary, observationId: o.id, reason: 'No untried executable operation or exit in the active boundary; parent exploration remains suspended' });
              return false;
            }
          }
          if (!pending.length) { session.status = 'finished'; session.stopReason = this.frontier(sessionId).some(f => f.status !== 'executed') ? 'known_frontier_exhausted_with_gaps' : 'known_frontier_exhausted'; this.store.put('session', session); this.emit(sessionId, 'exploration.finished', this.report(sessionId)); return false; }
          let chosen = pending.find(f => f.stateId === o.stateId) || pending[0];
          if (this.hooks.choose) {
            const result = await this.hook(sessionId, 'choose', () => this.hooks.choose!(describeFrontier(structuredClone(pending), this.store.list<ActionAttempt>('attempt', sessionId)), structuredClone({ session, observation: o })));
            if (result.error || result.value === null) { this.pauseRequested = true; session.status = 'paused'; session.stopReason = result.error || 'external_strategy_paused'; this.store.put('session', session); return false; }
            const item = pending.find(f => f.id === result.value); if (!item) throw new EngineError('INVALID_STRATEGY_CHOICE', 'Strategy returned an unknown frontier item'); chosen = item;
          }
          if (chosen.stateId !== this.observation(sessionId).stateId) {
            const state = this.owned<UIState>('state', chosen.stateId, sessionId); const checkpoint = this.checkpointInternal(sessionId, 'Exploration branch', [], [], state.observationIds[0]);
            const result = await this.reachInternal(sessionId, checkpoint.id);
            if (result.status !== 'REACHED_VERIFIED') { chosen.status = 'blocked'; chosen.reason = result.reason; chosen.unblock = 'Reach the branch checkpoint or repair its preconditions'; this.store.put('frontier', chosen); return true; }
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
