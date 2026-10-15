import { canonical, currentExplorationDecision, EngineError, hash, id, now, type ExplorationGroup, type Persistence } from '@interaction/core';
import type { ActionCandidate, ControlReviewRecord, ExplorationDecisionConditions, ExplorationDecisionReuseApplication, ExplorationDecisionReuseCandidate, ExplorationDecisionReuseMaterial, ExplorationDecisionReuseRecord, Observation, ReviewExplorationDecisionReuseInput, ReuseExplorationDecisionsInput, RevokeExplorationDecisionReuseInput } from '@interaction/adapter-playwright';
import { RegionReuse } from './region-reuse.js';

/** Conditional scheduling policy only: never transfers identity, execution or purpose. */
export class ExplorationDecisionReuse {
  private readonly regions: RegionReuse;
  constructor(private store: Persistence, private emit: (sid: string, type: string, data: unknown) => unknown,
    private invalidate: (sid: string, groupId: string, observationId: string, reason: string) => void) {
    this.regions = new RegionReuse(store, emit);
  }
  private groups(sid: string) { return this.store.list<ExplorationGroup>('exploration-group', sid); }
  private records(sid: string) { return this.store.list<ExplorationDecisionReuseRecord>('exploration-decision-review', sid); }
  private source(sid: string, reviewId: string) { const r = this.store.get<ExplorationDecisionReuseRecord>('exploration-decision-review', reviewId); return r?.sessionId === sid ? r : undefined; }
  private available(r: ExplorationDecisionReuseRecord, seen = new Set<string>()): boolean {
    if (seen.size >= 64 || seen.has(r.id) || r.revocation) return false; seen.add(r.id);
    const g = this.store.get<ExplorationGroup>('exploration-group', r.groupId), d = currentExplorationDecision(g);
    if (!g || g.sessionId !== r.sessionId || d?.revision !== r.decisionRevision || !this.regions.available(r.sessionId, r.regionReviewId, r.regionKey)) return false;
    const parent = r.parentReviewId && this.source(r.sessionId, r.parentReviewId);
    return !r.parentReviewId || !!parent && this.available(parent, seen);
  }
  private basis(action: ActionCandidate) {
    return action.basis && { status: action.basis.status, evidence: action.basis.evidence.filter(e => e.rule !== 'reused-control-review/v1').map(e => {
      if (e.rule !== 'reviewed-control/v1') return e;
      // Only this documented evidence record may shed its instance-bound IDs.
      // A rebuilt purpose must explicitly descend from the same review source.
      let review = typeof e.facts.reviewId === 'string' && this.store.get<ControlReviewRecord>('control-review', e.facts.reviewId);
      if (!review || review.sessionId !== action.sessionId || review.status !== 'active') throw new EngineError('DEPTH_REUSE_PURPOSE_UNAVAILABLE', 'Review the current operation purpose first');
      const seen = new Set<string>();
      while (review && review.reusedFrom) {
        if (seen.size >= 64 || seen.has(review.id)) return e; seen.add(review.id);
        const parent: ControlReviewRecord | undefined = this.store.get<ControlReviewRecord>('control-review', review.reusedFrom.reviewId);
        if (!parent || parent.sessionId !== action.sessionId || ['revoked','superseded'].includes(parent.status)) throw new EngineError('DEPTH_REUSE_PURPOSE_UNAVAILABLE', 'The current purpose source was withdrawn'); review = parent;
      }
      return review ? { rule: e.rule, sourceReviewId: review.id, risk: review.risk, replayable: review.replayable, samples: review.samples, businessScope: review.reuse?.businessScope } : e;
    }) };
  }
  private snapshot(o: Observation, actions: ActionCandidate[], g: ExplorationGroup, allowEmpty = false) {
    if (g.kind !== 'reviewed-region') throw new EngineError('UNSUPPORTED_DEPTH_REUSE', 'Fresh decisions are supported here; reuse currently requires an explicitly reusable reviewed region');
    if (g.status === 'invalidated' || g.observationId !== o.id || g.instanceScope !== o.instanceScope) throw new EngineError('STALE_GROUP_DECISION', 'Read the current region group');
    const ref = g.conditions as { regionReviewId?: string; regionKey?: string };
    const proof = ref?.regionReviewId && ref.regionKey && this.regions.source(o.sessionId, ref.regionReviewId, ref.regionKey);
    if (!proof || proof.region.status !== 'active' || !proof.region.reuse || !proof.region.reuseConditions || !this.regions.matches(proof.review, proof.region, o)) {
      throw new EngineError('REGION_REUSE_REQUIRED', 'Review an unchanged reusable region before reusing its depth decision');
    }
    const { region, review } = proof;
    // Compare complete bounded structural evidence, not a label or an ordinal alone.
    const targets = new Map<string, unknown[]>();
    for (const anchor of region.anchors) {
      const c = o.regionCandidates?.find(c => c.id === anchor.id);
      const binding = c?.reuseBinding as { members?: unknown[] } | undefined;
      if (!c || !binding?.members || binding.members.length !== c.controlIds.length) throw new EngineError('REGION_REUSE_REQUIRED', 'Complete structural member evidence is unavailable');
      for (const localId of region.controlIds.filter(localId => c.controlIds.includes(localId))) {
        const member = binding.members[c.controlIds.indexOf(localId)];
        if (binding.members.filter(m => canonical(m) === canonical(member)).length !== 1) throw new EngineError('AMBIGUOUS_DEPTH_TARGET', 'Structural target correspondence is not unique');
        targets.set(localId, [...targets.get(localId) || [], member]);
      }
    }
    const scoped = actions.filter(a => a.boundary?.intent !== 'exit' && (a.localId && region.controlIds.includes(a.localId) || a.kind === 'scroll' && !a.localId && region.pageTraversal));
    const members = scoped.map(a => {
      const memberKey = a.kind === 'scroll' ? undefined : g.members.find(m => m.observationId === o.id && m.actionId === a.id)?.key;
      if (a.kind !== 'scroll' && !memberKey || a.localId && !targets.has(a.localId)) throw new EngineError('INCOMPLETE_DEPTH_MEMBERS', 'Current action membership could not be verified');
      const descriptor = JSON.parse(JSON.stringify({ target: a.localId ? targets.get(a.localId) : 'page-traversal', kind: a.kind, value: a.value,
        risk: a.risk, replayable: a.replayable, source: a.source, basis: this.basis(a), excluded: a.excluded, exclusionReason: a.exclusionReason, sampleValidity: a.sampleValidity,
        visible: a.preconditions.visible, enabled: a.preconditions.enabled, blockers: a.preconditions.blockers })) as import('@interaction/core').Json;
      return { signature: hash(descriptor), descriptor, memberKey, actionId: a.id, label: a.label, kind: a.kind, value: a.value };
    });
    if (!allowEmpty && !members.length || new Set(members.map(m => m.signature)).size !== members.length) throw new EngineError('AMBIGUOUS_DEPTH_TARGET', 'Current operations must have unique structural and parameter bindings');
    const conditions: ExplorationDecisionConditions = { version: 'exploration-decision-reuse/v1', region: region.reuseConditions!, operations: members.map(({ signature, descriptor }) => ({ signature, descriptor })).sort((a,b) => a.signature.localeCompare(b.signature)) };
    return { conditions, members, region, review };
  }
  register(o: Observation, actions: ActionCandidate[], input: ReviewExplorationDecisionReuseInput, persist = true) {
    const g = this.groups(o.sessionId).find(g => g.id === input.groupId), d = currentExplorationDecision(g);
    if (input.observationId !== o.id || !g || g.revision !== input.revision || !d) throw new EngineError('STALE_GROUP_DECISION', 'Opt in the latest current depth decision');
    const s = this.snapshot(o, actions, g);
    if (s.region.reuse!.businessScope !== input.businessScope || d.decision.mode === 'sample' && d.decision.memberKeys.some(k => !s.members.some(m => m.memberKey === k))) throw new EngineError('INVALID_DEPTH_REUSE', 'Business scope and every selected sample must match current material');
    const r: ExplorationDecisionReuseRecord = { id: id(), sessionId: o.sessionId, observationId: o.id, at: now(), source: input.source, evidence: input.evidence, businessScope: input.businessScope,
      groupId: g.id, decisionRevision: d.revision, decision: d.decision, regionReviewId: s.review.id, regionKey: s.region.key, conditions: s.conditions,
      members: s.members.map(({ signature, actionId, memberKey }) => ({ signature, actionId, memberKey })), parentReviewId: d.reusedFrom?.reviewId };
    if (persist) { this.store.put('exploration-decision-review', r); this.emit(o.sessionId, 'exploration.decision_reuse_registered', { reviewId: r.id, groupId: g.id, decisionRevision: d.revision }); } return r;
  }
  material(o: Observation, actions: ActionCandidate[]): ExplorationDecisionReuseMaterial {
    const material: ExplorationDecisionReuseMaterial = { sessionId: o.sessionId, observationId: o.id, candidates: [], unavailable: [], reusableGroupIds: [] };
    for (const g of this.groups(o.sessionId).filter(g => g.status !== 'invalidated' && g.observationId === o.id)) {
      let snapshot: ReturnType<ExplorationDecisionReuse['snapshot']>;
      try { snapshot = this.snapshot(o, actions, g); }
      catch (error) { material.unavailable.push({ groupId: g.id, reason: error instanceof EngineError ? error.code : 'DEPTH_REUSE_UNAVAILABLE', next: error instanceof EngineError && error.code === 'DEPTH_REUSE_PURPOSE_UNAVAILABLE' ? 'review_purpose' : g.kind === 'reviewed-region' ? 'review_region' : 'fresh_decision' }); continue; }
      const decision = currentExplorationDecision(g)?.decision;
      if (decision) {
        if (decision.mode === 'sample' && decision.memberKeys.some(k => !snapshot.members.some(m => m.memberKey === k))) material.unavailable.push({groupId:g.id,reason:'DEPTH_REUSE_SAMPLE_UNMAPPED',next:'fresh_decision'});
        else material.reusableGroupIds.push(g.id);
        continue;
      }
      for (const r of this.records(o.sessionId).filter(r => r.regionKey === snapshot.region.key && r.groupId !== g.id)) {
        let reason: string | undefined;
        if (!this.available(r)) reason = 'DEPTH_REUSE_SOURCE_UNAVAILABLE';
        else if (r.businessScope !== snapshot.region.reuse!.businessScope || canonical(r.conditions) !== canonical(snapshot.conditions)) reason = 'DEPTH_REUSE_CONDITIONS_CHANGED';
        // The partition itself must have been explicitly reused from this proof chain.
        else {
          let region = snapshot.region, review = snapshot.review; const seen = new Set<string>(); let linked = false;
          while (region.reusedFrom && seen.size < 64 && !seen.has(review.id)) {
            seen.add(review.id); const parent = this.regions.source(o.sessionId, region.reusedFrom.reviewId, region.reusedFrom.regionKey); if (!parent) break;
            if (parent.review.id === r.regionReviewId && parent.region.key === r.regionKey) { linked = true; break; }
            region = parent.region; review = parent.review;
          }
          if (!linked) reason = 'DEPTH_REUSE_REGION_PROVENANCE_REQUIRED';
        }
        if (reason) { material.unavailable.push({ groupId: g.id, reviewId: r.id, reason, next: 'fresh_decision' }); continue; }
        const mapping = snapshot.members.map(m => {
          const old = r.members.find(old => old.signature === m.signature)!;
          return { signature: m.signature, previousActionId: old.actionId, previousMemberKey: old.memberKey, actionId: m.actionId, memberKey: m.memberKey, label: m.label, kind: m.kind, value: m.value,
            selected: r.decision.mode === 'all' || r.decision.mode === 'sample' && !!old.memberKey && r.decision.memberKeys.includes(old.memberKey) };
        });
        const decision = r.decision.mode === 'sample' ? { ...r.decision, memberKeys: mapping.filter(m => m.selected).map(m => m.memberKey!) } : r.decision;
        if (decision.mode === 'sample' && (!decision.memberKeys.length || decision.memberKeys.some(k => !k))) { material.unavailable.push({ groupId: g.id, reviewId: r.id, reason: 'DEPTH_REUSE_SAMPLE_UNMAPPED', next: 'fresh_decision' }); continue; }
        const candidate = { reviewId: r.id, groupId: g.id, revision: g.revision, businessScope: r.businessScope, decision, conditions: snapshot.conditions, mapping };
        material.candidates.push({ ...candidate, conditionKey: hash(candidate) });
      }
    }
    return material;
  }
  plan(o: Observation, actions: ActionCandidate[], input: ReuseExplorationDecisionsInput) {
    if (input.observationId !== o.id || new Set(input.decisions.map(d => d.groupId)).size !== input.decisions.length) throw new EngineError('STALE_DEPTH_REUSE', 'Use current observation and distinct target groups');
    const material = this.material(o, actions);
    return input.decisions.map(ref => {
      const c = material.candidates.find(c => c.reviewId === ref.reviewId && c.groupId === ref.groupId && c.revision === ref.revision && c.conditionKey === ref.conditionKey && c.businessScope === input.businessScope);
      if (!c) throw new EngineError('STALE_DEPTH_REUSE', 'Reuse conditions changed; read fresh material or submit a fresh depth decision'); return c;
    });
  }
  record(o: Observation, input: ReuseExplorationDecisionsInput, matches: ExplorationDecisionReuseCandidate[], groups: ExplorationGroup[]) {
    for (const c of matches) {
      const group = groups.find(g => g.id === c.groupId)!, entry = group.decisions.at(-1)!;
      entry.reusedFrom = { reviewId: c.reviewId, conditionKey: c.conditionKey }; this.store.put('exploration-group', group);
      const application: ExplorationDecisionReuseApplication = { id: id(), sessionId: o.sessionId, observationId: o.id, groupId: group.id, decisionRevision: entry.revision,
        reviewId: c.reviewId, conditionKey: c.conditionKey, conditions: c.conditions, members: c.mapping.map(({signature,actionId}) => ({signature,actionId})), at: now(), source: input.source, evidence: input.evidence };
      this.store.put('exploration-decision-application', application);
      this.emit(o.sessionId, 'exploration.decision_reused', { applicationId: application.id, groupId: group.id, reviewId: c.reviewId, decisionRevision: entry.revision, conditionKey: c.conditionKey });
    }
  }
  reconcile(o: Observation, actions: ActionCandidate[]) {
    for (const a of this.store.list<ExplorationDecisionReuseApplication>('exploration-decision-application', o.sessionId)) {
      const g = this.groups(o.sessionId).find(g => g.id === a.groupId), d = currentExplorationDecision(g);
      if (!g || d?.revision !== a.decisionRevision) continue;
      const r = this.source(o.sessionId, a.reviewId); let reason: string | undefined;
      if (!r || !this.available(r)) reason = 'DEPTH_REUSE_SOURCE_UNAVAILABLE';
      // An old document is archived evidence, not an active policy to reconcile.
      else if (g.status !== 'invalidated' && g.instanceScope === o.instanceScope) {
        try {
          const current = this.snapshot(o, actions, g, true).conditions;
          const known = new Set(a.conditions.operations.map(m => m.signature));
          const remaining = new Set(current.operations.map(m => m.signature));
          // Finishing a current operation may remove it from discovery (e.g. filling
          // its only sample). Keep the remaining grant only with real local success.
          const completed = (signature: string) => {
            const ref = a.members.find(m => m.signature === signature);
            const original = ref && this.store.get<ActionCandidate>('action', ref.actionId);
            return !!original && this.store.list<import('@interaction/core').ActionAttempt>('attempt', o.sessionId).some(attempt => {
              const before = this.store.get<Observation>('observation', attempt.beforeId);
              return attempt.status === 'succeeded' && attempt.startedAt >= a.at && before?.instanceScope === o.instanceScope
                && attempt.action.localId === original.localId && attempt.action.kind === original.kind
                && canonical(attempt.action.value) === canonical(original.value) && canonical(this.basis(attempt.action)) === canonical(this.basis(original));
            });
          };
          if (canonical(current.region) !== canonical(a.conditions.region) || [...remaining].some(key => !known.has(key))
            || [...known].some(key => !remaining.has(key) && !completed(key))) reason = 'DEPTH_REUSE_CONDITIONS_CHANGED';
        }
        catch { reason = 'DEPTH_REUSE_CONDITIONS_CHANGED'; }
      }
      if (reason) this.invalidate(o.sessionId, g.id, o.id, reason);
    }
  }
  validate(action: ActionCandidate, o: Observation) {
    for (const g of this.groups(o.sessionId)) {
      if (g.status === 'invalidated' || g.instanceScope !== o.instanceScope || !g.decisions.at(-1)?.invalidation) continue;
      const application = this.store.list<ExplorationDecisionReuseApplication>('exploration-decision-application', o.sessionId).find(a => a.groupId === g.id && a.decisionRevision === g.decisions.at(-1)?.revision);
      const owned = g.members.some(m => m.actionId === action.id || m.observationId === o.id && m.localId === action.localId && m.kind === action.kind)
        || application?.members.some(m => {
          const original = this.store.get<ActionCandidate>('action', m.actionId);
          return original?.kind === action.kind && original.localId === action.localId && canonical(original.value) === canonical(action.value);
        });
      if (owned) throw new EngineError('DEPTH_REUSE_INVALIDATED', 'Submit a current depth decision before automatic dispatch');
    }
  }
  revoke(o: Observation, actions: ActionCandidate[], input: RevokeExplorationDecisionReuseInput) {
    const r = this.source(o.sessionId, input.reviewId); if (!r) throw new EngineError('NOT_FOUND', 'Depth reuse source not found');
    if (!r.revocation) { r.revocation = { source: input.source, reason: input.reason, at: now() }; this.store.put('exploration-decision-review', r); this.emit(o.sessionId, 'exploration.decision_reuse_revoked', { reviewId: r.id, ...r.revocation }); }
    this.reconcile(o, actions); return r;
  }
  request(o: Observation, actions: ActionCandidate[]) {
    const material = this.material(o, actions); if (!material.candidates.length) return;
    const key = hash(material.candidates.map(c => c.conditionKey)); const requestId = `depth-reuse:${o.sessionId}`;
    if (this.store.get<{ key: string }>('exploration-decision-request', requestId)?.key === key) return;
    this.store.put('exploration-decision-request', { id: requestId, sessionId: o.sessionId, key });
    this.emit(o.sessionId, 'exploration.decision_reuse_requested', { observationId: o.id, candidates: material.candidates.map(({ reviewId, groupId, revision, conditionKey }) => ({ reviewId, groupId, revision, conditionKey })) }); return material;
  }
}
