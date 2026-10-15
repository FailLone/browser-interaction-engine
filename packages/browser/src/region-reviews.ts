import { contextKey, EngineError, hash, id, now, type Persistence, type ExplorationGroup, type ExplorationGroupProposal, type FrontierItem } from '@interaction/core';
import { regionReviewSchema, type ActionCandidate, type Observation, type RegionReviewInput, type RegionReviewMaterial, type RegionReviewRecord, type Session } from '@interaction/adapter-playwright';

/** Reviewed partitions use exact observed instances. They never infer business purpose. */
export class RegionReviews {
  constructor(private store: Persistence, private emit: (sid: string, type: string, data: unknown) => unknown) {}
  current(sid: string) { return this.store.list<RegionReviewRecord>('region-review', sid).findLast(r => r.status === 'active'); }
  private controls(o: Observation, actions: ActionCandidate[]) {
    const ids = new Set(actions.filter(a => a.boundary?.intent !== 'exit' && a.preconditions.visible).map(a => a.localId));
    return o.controls.filter(c => c.visible && (ids.has(c.localId) || c.actions.length > 0 && !actions.some(a => a.localId === c.localId)));
  }
  material(o: Observation, actions: ActionCandidate[], session: Session): RegionReviewMaterial {
    if (session.options.regionExploration !== 'review') return {sessionId:o.sessionId,observationId:o.id,enabled:false,candidates:[],controls:[],unassignedControlIds:[],unassignedPageTraversal:false};
    const review = this.current(o.sessionId) || this.store.list<RegionReviewRecord>('region-review', o.sessionId).at(-1); const controls = this.controls(o, actions);
    const assigned = new Set(review?.status === 'active' ? review.regions.filter(r => r.status === 'active').flatMap(r => r.controlIds) : []);
    return { sessionId: o.sessionId, observationId: o.id, enabled: session.options.regionExploration === 'review', candidates: o.regionCandidates || [], review,
      controls: controls.map(c => ({ localId: c.localId, label: c.name, role: c.role, actionKinds: [...new Set([...c.actions, ...actions.filter(a => a.localId === c.localId && a.boundary?.intent !== 'exit').map(a => a.kind)])] })),
      unassignedControlIds: controls.filter(c => !assigned.has(c.localId)).map(c => c.localId),
      unassignedPageTraversal: actions.some(a => a.kind === 'scroll' && !a.localId) && !review?.regions.some(r => review.status === 'active' && r.status === 'active' && r.pageTraversal) };
  }
  private retireGroups(review: RegionReviewRecord, keys: string[], observationId: string) {
    for (const group of this.store.list<ExplorationGroup>('exploration-group', review.sessionId)) {
      const conditions = group.conditions as { regionReviewId?: string; regionKey?: string } | undefined;
      if (group.status === 'invalidated' || conditions?.regionReviewId !== review.id || !keys.includes(conditions.regionKey || '')) continue;
      group.status = 'invalidated'; group.revision++; group.invalidation = { observationId, reason: 'reviewed_region_changed' }; this.store.put('exploration-group', group);
      this.emit(review.sessionId, 'exploration.group_invalidated', { groupId: group.id, revision: group.revision, ...group.invalidation });
    }
  }
  reconcile(o: Observation) {
    const review = this.current(o.sessionId); if (!review || o.gaps.some(g => g.critical)) return;
    const changedContext = review.instanceScope !== o.instanceScope || review.url !== o.url || review.contextKey !== contextKey(o.context);
    const candidates = new Map((o.regionCandidates || []).map(c => [c.id, hash(c.binding)]));
    const invalidated: string[] = [];
    for (const region of review.regions) if (region.status === 'active' && (changedContext || region.anchors.some(a => candidates.get(a.id) !== a.fingerprint))) {
      region.status = 'invalidated'; region.invalidation = { observationId: o.id, reason: changedContext ? 'document_url_or_context_changed' : 'region_structure_changed' }; invalidated.push(region.key);
    }
    if (changedContext || review.regions.length && review.regions.every(r => r.status === 'invalidated')) review.status = 'invalidated';
    if (invalidated.length || changedContext) {
      this.store.put('region-review', review); this.retireGroups(review, invalidated, o.id);
      this.emit(o.sessionId, 'region.review_invalidated', { reviewId: review.id, observationId: o.id, regionKeys: invalidated, changedContext });
    }
  }
  request(o: Observation, actions: ActionCandidate[], session: Session) {
    if (session.options.regionExploration !== 'review' || o.gaps.some(g => g.critical)) return false;
    const material = this.material(o, actions, session);
    const key = hash({ document: o.instanceScope, url: o.url, context: o.context, candidates: material.candidates.map(c => [c.id, c.binding]),
      // Candidate bindings already validate semantic names. Raw material labels
      // also contain passive readouts and must not re-trigger the same request.
      controls: material.controls.map(({ localId, role, actionKinds }) => ({ localId, role, actionKinds })), review: material.review && { regions: material.review.regions, rejected: material.review.rejectedCandidateIds }, unassigned: material.unassignedControlIds, pageTraversal: material.unassignedPageTraversal });
    const old = this.store.get<{ id: string; sessionId: string; key: string }>('region-review-request', `region-request:${o.sessionId}`);
    if (old?.key === key || !material.unassignedControlIds.length && !material.unassignedPageTraversal) return false;
    this.store.put('region-review-request', { id: `region-request:${o.sessionId}`, sessionId: o.sessionId, key });
    this.emit(o.sessionId, 'region.review_requested', { observationId: o.id, candidateIds: material.candidates.map(c => c.id), unassignedControlIds: material.unassignedControlIds, unassignedPageTraversal: material.unassignedPageTraversal });
    return true;
  }
  record(o: Observation, actions: ActionCandidate[], session: Session, input: RegionReviewInput): RegionReviewRecord {
    const value = regionReviewSchema.parse(input);
    if (session.options.regionExploration !== 'review') throw new EngineError('REGION_REVIEW_DISABLED', 'Enable regionExploration review when creating the session');
    if (value.observationId !== o.id || o.gaps.some(g => g.critical)) throw new EngineError('STALE_REGION_REVIEW', 'Review the latest complete observation');
    const candidates = new Map((o.regionCandidates || []).map(c => [c.id, c]));
    const controllable = new Set(this.controls(o, actions).map(c => c.localId)); const used = new Set<string>(); const keys = new Set<string>();
    const reject = () => { throw new EngineError('INVALID_REGION_REVIEW', 'Use distinct region keys and non-overlapping observed controls anchored to current candidates'); };
    if (new Set(value.rejectedCandidateIds).size !== value.rejectedCandidateIds.length || value.rejectedCandidateIds.some(id => !candidates.has(id))) reject();
    let traversalAssigned = false;
    const regions = value.regions.map(r => {
      if (keys.has(r.key) || new Set(r.candidateIds).size !== r.candidateIds.length || r.candidateIds.some(id => !candidates.has(id) || value.rejectedCandidateIds.includes(id))) reject(); keys.add(r.key);
      const pool = new Set(r.candidateIds.flatMap(id => candidates.get(id)!.controlIds).filter(id => controllable.has(id)));
      const controlIds = r.controlIds || [...pool];
      if (!controlIds.length && !r.pageTraversal || new Set(controlIds).size !== controlIds.length || controlIds.some(id => !pool.has(id) || used.has(id))) reject();
      if (r.pageTraversal && traversalAssigned) reject(); traversalAssigned ||= r.pageTraversal;
      controlIds.forEach(id => used.add(id));
      return { key: r.key, label: r.label, controlIds, pageTraversal: r.pageTraversal, anchors: r.candidateIds.map(id => ({ id, fingerprint: hash(candidates.get(id)!.binding) })), status: 'active' as const };
    });
    const old = this.current(o.sessionId);
    // Whole input is validated before superseding any previous partition or decision.
    if (old) { old.status = 'superseded'; this.store.put('region-review', old); this.retireGroups(old, old.regions.map(r => r.key), o.id); }
    const record: RegionReviewRecord = { id: id(), sessionId: o.sessionId, observationId: o.id, instanceScope: o.instanceScope, url: o.url, contextKey: contextKey(o.context), at: now(),
      source: value.source, evidence: value.evidence, regions, rejectedCandidateIds: value.rejectedCandidateIds, status: 'active' };
    this.store.put('region-review', record); this.emit(o.sessionId, 'region.reviewed', record); return record;
  }
  proposals(o: Observation, actions: ActionCandidate[]): ExplorationGroupProposal[] {
    this.reconcile(o); const review = this.current(o.sessionId); if (!review) return [];
    return review.regions.filter(r => r.status === 'active').map(r => ({ key: `reviewed-region:${r.key}`, kind: 'reviewed-region', label: r.label,
      conditions: { regionReviewId: review.id, regionKey: r.key, anchors: r.anchors, context: review.contextKey, url: review.url },
      collection: { key: review.id, label: '已确认探索区域', evidence: [{ source: review.source, rule: 'caller-region-partition/v1', facts: { reviewId: review.id, evidence: review.evidence } }] },
      actionIds: actions.filter(a => a.localId && r.controlIds.includes(a.localId) && a.kind !== 'scroll' && a.boundary?.intent !== 'exit').map(a => a.id),
      traversalActionIds: actions.filter(a => (a.localId ? r.controlIds.includes(a.localId) : r.pageTraversal) && a.kind === 'scroll' && a.boundary?.intent !== 'exit').map(a => a.id),
      evidence: [{ source: review.source, rule: 'caller-region-partition/v1', facts: { reviewId: review.id, evidence: review.evidence, anchors: r.anchors } }],
    }));
  }
  gate(o: Observation, session: Session) {
    if (session.options.regionExploration !== 'review') return;
    const review = this.current(o.sessionId); const assigned = new Set(review?.status === 'active' ? review.regions.filter(r => r.status === 'active').flatMap(r => r.controlIds) : []);
    for (const f of this.store.list<FrontierItem>('frontier', o.sessionId)) {
      if (f.attempts.length || !['pending', 'deferred'].includes(f.status) || f.action.boundary?.intent === 'exit' || f.action.kind === 'history') continue;
      // A reviewed owner authorizes its exact instances in this document only.
      const owned = f.action.observationId === o.id && (f.action.localId ? assigned.has(f.action.localId) : f.action.kind === 'scroll' && review?.regions.some(r => r.status === 'active' && r.pageTraversal));
      if (!owned) { f.status = 'deferred'; f.reason = 'region_review_required'; f.unblock = 'Confirm an observed region partition before choosing its exploration policy'; this.store.put('frontier', f); }
    }
  }
  idleReason(sid: string, frontier = this.store.list<FrontierItem>('frontier', sid)) {
    return frontier.some(f => f.reason === 'region_review_required' && f.status === 'deferred') ? 'REGION_REVIEW_REQUIRED' : undefined;
  }
}
