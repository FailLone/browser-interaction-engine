import { canonical, EngineError, id, now, type Persistence, type ExplorationGroup, type FrontierItem } from '@interaction/core';
import { listPurposeReviewSchema, revokePurposeReviewSchema, purposeConditions, purposeConditionKey,
  type ActionCandidate, type Observation, type PurposeReview, type PurposeReviewMaterial, type ListPurposeReviewInput, type RevokePurposeReviewInput } from '@interaction/adapter-playwright';

/** Upper-layer judgments, distinct from list traversal and logical identity decisions. */
export class PurposeReviews {
  constructor(private store: Persistence, private emit: (sid: string, type: string, data: unknown) => unknown) {}

  material(o: Observation, actions: ActionCandidate[], groupId: string): PurposeReviewMaterial {
    const group = this.store.get<ExplorationGroup>('exploration-group', groupId);
    if (!group || group.sessionId !== o.sessionId) throw new EngineError('NOT_FOUND', 'Exploration group not found');
    if (group.observationId !== o.id) throw new EngineError('STALE_PURPOSE_REVIEW', 'Observe the list in the current document before reviewing');
    const current = new Set(group.members.filter(m => m.observationId === o.id).map(m => m.actionId));
    const conditions = new Map<string, PurposeReviewMaterial['conditions'][number]>();
    for (const a of actions.filter(a => current.has(a.id))) {
      const c = o.controls.find(c => c.localId === a.localId); const facts = c && purposeConditions(a, c, o);
      if (!c || !facts) continue;
      const key = purposeConditionKey(facts); const item = conditions.get(key) || { key, conditions: facts, members: [] };
      item.members.push({ actionId: a.id, localId: c.localId, label: a.label, value: a.value, risk: a.risk, excluded: a.excluded }); conditions.set(key, item);
    }
    return { sessionId: o.sessionId, groupId, revision: group.revision, observationId: o.id,
      variations: ['member-instance', 'option-label', 'option-value'], conditions: [...conditions.values()] };
  }

  record(o: Observation, actions: ActionCandidate[], input: ListPurposeReviewInput) {
    const review = listPurposeReviewSchema.parse(input); const material = this.material(o, actions, review.groupId);
    if (review.observationId !== o.id || review.revision !== material.revision) throw new EngineError('STALE_PURPOSE_REVIEW', 'Read current purpose materials before deciding');
    const match = material.conditions.find(c => c.key === review.conditionKey);
    if (!match) throw new EngineError('INVALID_PURPOSE_REVIEW', 'Conditions must match an observed supported list operation');
    const record: PurposeReview = { ...review, id: id(), sessionId: o.sessionId, at: now(), status: 'active',
      conditions: match.conditions, sourceActionIds: match.members.map(m => m.actionId) };
    // Replacing a judgment is explicit: revoking the new one cannot resurrect an older grant.
    for (const previous of this.store.list<PurposeReview>('purpose-review', o.sessionId).filter(r => r.status === 'active' && r.conditionKey === record.conditionKey)) {
      previous.status = 'superseded'; previous.replacedBy = record.id; this.store.put('purpose-review', previous);
      this.emit(o.sessionId, 'purpose.review_superseded', previous);
    }
    this.store.put('purpose-review', record); this.emit(o.sessionId, 'purpose.review_recorded', record); return record;
  }

  revoke(sessionId: string, input: RevokePurposeReviewInput) {
    const { reviewId, source, reason } = revokePurposeReviewSchema.parse(input);
    const review = this.store.get<PurposeReview>('purpose-review', reviewId);
    if (!review || review.sessionId !== sessionId) throw new EngineError('NOT_FOUND', 'Purpose review not found');
    if (review.status === 'revoked') return review;
    review.status = 'revoked'; review.revocation = { at: now(), source, reason };
    this.store.put('purpose-review', review); this.emit(sessionId, 'purpose.review_revoked', review); return review;
  }

  apply(actions: ActionCandidate[], o: Observation) {
    const reviews = this.store.list<PurposeReview>('purpose-review', o.sessionId).filter(r => r.status === 'active');
    for (const review of reviews) {
      const scope = review.conditions.scope;
      const changed = scope.instanceScope !== o.instanceScope || scope.url !== o.url || canonical(scope.context) !== canonical(o.context)
        || o.controls.some(c => c.list && (c.list.instanceId === scope.owner.instanceId || c.list.selector === scope.owner.selector) && canonical(c.list) !== canonical(scope.owner));
      if (changed) {
        review.status = 'invalidated'; review.invalidation = { at: now(), observationId: o.id, reason: 'document_url_context_or_list_owner_changed' };
        this.store.put('purpose-review', review); this.emit(o.sessionId, 'purpose.review_invalidated', review);
      }
    }
    return actions.map(a => {
      // A purpose review cannot erase unrelated exclusions or invent an operation.
      if (a.excluded && a.exclusionReason !== 'operation_requires_review') return a;
      const c = o.controls.find(c => c.localId === a.localId); const conditions = c && purposeConditions(a, c, o);
      if (!conditions) return a;
      const key = purposeConditionKey(conditions); const review = reviews.findLast(r => r.status === 'active' && r.conditionKey === key);
      if (!review) return a;
      return { ...a, risk: review.risk, excluded: false, exclusionReason: undefined, source: 'conditional-purpose-review',
        // No new replay grant follows from sharing a purpose judgment.
        replayable: a.risk === 'interface' && a.replayable,
        basis: { status: 'supported' as const, evidence: [...a.basis?.evidence || [], { source: review.source, rule: 'conditional-purpose-review/v1',
          facts: { reviewId: review.id, conditionKey: key, purpose: review.purpose, businessScope: review.businessScope, sourceObservationId: review.observationId, evidence: review.evidence } }] } };
    });
  }

  validate(action: ActionCandidate, o: Observation) {
    const references = action.basis?.evidence.filter(e => e.rule === 'conditional-purpose-review/v1') || [];
    for (const reference of references) {
      const reviewId = reference.facts.reviewId; const review = typeof reviewId === 'string' && this.store.get<PurposeReview>('purpose-review', reviewId);
      const c = o.controls.find(c => c.localId === action.localId); const conditions = c && purposeConditions(action, c, o);
      if (!review || review.sessionId !== o.sessionId || review.status !== 'active' || !conditions || review.conditionKey !== purposeConditionKey(conditions)) {
        throw new EngineError('PURPOSE_REVIEW_EXPIRED', 'Refresh the observation and obtain a valid purpose judgment before dispatch');
      }
    }
  }

  /** A new judgment replaces an unattempted scheduling intent, never an execution result. */
  reconcile(o: Observation, actions: ActionCandidate[]) {
    const reviews = new Map(this.store.list<PurposeReview>('purpose-review', o.sessionId).map(r => [r.id, r]));
    if (!reviews.size) return;
    const refs = (a: ActionCandidate) => a.basis?.evidence.filter(e => e.rule === 'conditional-purpose-review/v1').map(e => e.facts.reviewId) || [];
    const key = (a: ActionCandidate) => canonical([a.localId, a.kind, a.value]);
    const current = new Map<string, ActionCandidate[]>();
    for (const a of actions) current.set(key(a), [...current.get(key(a)) || [], a]);
    const observations = new Map<string, Observation>([[o.id, o]]); const retired: string[] = [];
    this.store.transaction(() => {
      for (const item of this.store.list<FrontierItem>('frontier', o.sessionId)) {
        if (item.attempts.length || !['pending', 'deferred', 'needs_revalidation'].includes(item.status) && !(item.status === 'blocked' && item.reason === 'operation_requires_review')) continue;
        const oldRefs = refs(item.action);
        let reason = oldRefs.some(r => typeof r !== 'string' || reviews.get(r)?.status !== 'active') ? 'purpose_review_invalidated' : undefined;
        const replacements = current.get(key(item.action)) || [];
        const replacement = replacements.length === 1 ? replacements[0] : undefined;
        if (!reason && replacement && canonical(oldRefs) !== canonical(refs(replacement))) {
          const old = observations.get(item.action.observationId) || this.store.get<Observation>('observation', item.action.observationId);
          if (old) observations.set(old.id, old);
          const before = old?.controls.find(c => c.localId === item.action.localId); const after = o.controls.find(c => c.localId === replacement.localId);
          if (old && before && after && old.instanceScope === o.instanceScope && canonical(old.context) === canonical(o.context)
            && before.name === after.name && before.stableKey === after.stableKey) {
            const conditions = purposeConditions(item.action, before, old);
            const newRefs = refs(replacement);
            if (oldRefs.length || conditions && newRefs.some(r => typeof r === 'string' && reviews.get(r)?.conditionKey === purposeConditionKey(conditions))) reason = 'purpose_review_replaced';
          }
        }
        if (reason) { item.status = 'superseded'; item.reason = reason; item.unblock = undefined; this.store.put('frontier', item); retired.push(item.id); }
      }
      if (retired.length) this.emit(o.sessionId, 'frontier.updated', { reason: 'purpose_review_changed', frontierIds: retired });
    });
  }
}
