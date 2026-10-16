import { contextKey, EngineError, hash, id, now, type Persistence, type ExplorationGroup, type ExplorationGroupProposal, type FrontierItem } from '@interaction/core';
import { RegionReuse } from './region-reuse.js';
import { regionReviewSchema, reuseRegionReviewsSchema, revokeRegionReuseSchema, type ActionCandidate, type Observation, type RegionReviewDelta, type RegionReviewInput, type RegionReviewMaterial, type RegionReviewRecord, type Session } from '@interaction/adapter-playwright';

/** Reviewed partitions use exact observed instances. They never infer business purpose. */
export class RegionReviews {
  private readonly reuse: RegionReuse;
  constructor(private store: Persistence, private emit: (sid: string, type: string, data: unknown) => unknown) { this.reuse=new RegionReuse(store,emit); }
  current(sid: string) { return this.store.list<RegionReviewRecord>('region-review', sid).findLast(r => r.status === 'active'); }
  private compatible(review: RegionReviewRecord, o: Observation) {
    return review.instanceScope === o.instanceScope && review.url === o.url && review.contextKey === contextKey(o.context);
  }
  private delta(review: RegionReviewRecord, o: Observation, controllable: Set<string>): RegionReviewDelta {
    const candidates = new Map((o.regionCandidates || []).map(c => [c.id, c]));
    const canUpdate = this.compatible(review, o) && !o.gaps.some(g => g.critical);
    const unchangedRegionKeys = canUpdate ? review.regions.filter(r => r.status === 'active' && this.reuse.matches(review,r,o) && r.anchors.every(a => candidates.has(a.id) && hash(candidates.get(a.id)!.binding) === a.fingerprint)).map(r => r.key) : [];
    const memberBindings = (observation: Observation | undefined, ids: string[]) => {
      const result = new Map<string, string>();
      for (const c of observation?.regionCandidates || []) if (ids.includes(c.id) && c.binding && typeof c.binding === 'object' && !Array.isArray(c.binding) && Array.isArray(c.binding.members)) {
        for (const member of c.binding.members) if (member && typeof member === 'object' && !Array.isArray(member) && typeof member.id === 'string') result.set(member.id, hash(member));
      }
      return result;
    };
    return { baseReviewId: review.id, canUpdate, unchangedRegionKeys, changedRegions: review.regions.filter(r => !unchangedRegionKeys.includes(r.key)).map(r => {
      const proof = r.reviewId ? this.store.get<RegionReviewRecord>('region-review', r.reviewId) : review;
      const before = proof && this.store.get<Observation>('observation', proof.observationId);
      const anchors = r.anchors.map(a => a.id);
      const baselineAvailable = !!before && anchors.every(id => before.regionCandidates?.some(c => c.id === id));
      const previousPool = new Set(before?.regionCandidates?.filter(c => anchors.includes(c.id)).flatMap(c => c.controlIds) || []);
      const pool = new Set(anchors.flatMap(id => candidates.get(id)?.controlIds || []).filter(id => controllable.has(id)));
      const beforeBindings = memberBindings(before, anchors), currentBindings = memberBindings(o, anchors);
      return { key: r.key, label: r.label, reason: !canUpdate ? 'document_url_context_or_observation_changed' : r.invalidation?.reason || 'region_structure_changed', baselineAvailable,
        addedControlIds: baselineAvailable ? [...pool].filter(id => !previousPool.has(id)) : [],
        removedControlIds: r.controlIds.filter(id => !pool.has(id)),
        changedControlIds: baselineAvailable ? r.controlIds.filter(id => pool.has(id) && beforeBindings.get(id) !== currentBindings.get(id)) : [],
        changedCandidateIds: r.anchors.filter(a => candidates.has(a.id) && hash(candidates.get(a.id)!.binding) !== a.fingerprint).map(a => a.id),
        missingCandidateIds: anchors.filter(id => !candidates.has(id)) };
    }) };
  }
  private controls(o: Observation, actions: ActionCandidate[]) {
    const ids = new Set(actions.filter(a => a.boundary?.intent !== 'exit' && a.preconditions.visible).map(a => a.localId));
    return o.controls.filter(c => c.visible && (ids.has(c.localId) || c.actions.length > 0 && !actions.some(a => a.localId === c.localId)));
  }
  material(o: Observation, actions: ActionCandidate[], session: Session): RegionReviewMaterial {
    if (session.options.regionExploration !== 'review') return {sessionId:o.sessionId,observationId:o.id,enabled:false,candidates:[],controls:[],unassignedControlIds:[],unassignedPageTraversal:false};
    const review = this.current(o.sessionId) || this.store.list<RegionReviewRecord>('region-review', o.sessionId).at(-1); const controls = this.controls(o, actions);
    const assigned = new Set(review?.status === 'active' ? review.regions.filter(r => r.status === 'active').flatMap(r => r.controlIds) : []);
    return { sessionId: o.sessionId, observationId: o.id, enabled: session.options.regionExploration === 'review', candidates: o.regionCandidates || [], review,
      delta: review && this.delta(review, o, new Set(controls.map(c => c.localId))),
      reuseCandidates:this.reuse.candidates(o,new Set(controls.map(c=>c.localId)),review),
      controls: controls.map(c => ({ localId: c.localId, label: c.name, role: c.role, actionKinds: [...new Set([...c.actions, ...actions.filter(a => a.localId === c.localId && a.boundary?.intent !== 'exit').map(a => a.kind)])] })),
      unassignedControlIds: controls.filter(c => !assigned.has(c.localId)).map(c => c.localId),
      unassignedPageTraversal: actions.some(a => a.kind === 'scroll' && !a.localId) && !review?.regions.some(r => review.status === 'active' && r.status === 'active' && r.pageTraversal) };
  }
  private retireGroups(review: RegionReviewRecord, keys: string[], observationId: string) {
    const proofs = new Map(review.regions.filter(r => keys.includes(r.key)).map(r => [r.key, r.reviewId || review.id]));
    for (const group of this.store.list<ExplorationGroup>('exploration-group', review.sessionId)) {
      const conditions = group.conditions as { regionReviewId?: string; regionKey?: string } | undefined;
      if (group.status === 'invalidated' || !conditions?.regionKey || !proofs.has(conditions.regionKey) || conditions.regionReviewId !== proofs.get(conditions.regionKey)) continue;
      group.status = 'invalidated'; group.revision++; group.invalidation = { observationId, reason: 'reviewed_region_changed' }; this.store.put('exploration-group', group);
      this.emit(review.sessionId, 'exploration.group_invalidated', { groupId: group.id, revision: group.revision, ...group.invalidation });
    }
  }
  reconcile(o: Observation) {
    const review = this.current(o.sessionId); if (!review || o.gaps.some(g => g.critical)) return;
    const changedContext = !this.compatible(review, o);
    const candidates = new Map((o.regionCandidates || []).map(c => [c.id, hash(c.binding)]));
    const invalidated: string[] = [];
    for (const region of review.regions) if (region.status === 'active' && (changedContext || !this.reuse.matches(review,region,o) || region.anchors.some(a => candidates.get(a.id) !== a.fingerprint))) {
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
      controls: material.controls.map(({ localId, role, actionKinds }) => ({ localId, role, actionKinds })), review: material.review && { regions: material.review.regions, rejected: material.review.rejectedCandidateIds }, unassigned: material.unassignedControlIds, pageTraversal: material.unassignedPageTraversal, reuse:material.reuseCandidates?.map(c=>c.conditionKey) });
    const old = this.store.get<{ id: string; sessionId: string; key: string }>('region-review-request', `region-request:${o.sessionId}`);
    if (old?.key === key || !material.unassignedControlIds.length && !material.unassignedPageTraversal) return false;
    this.store.put('region-review-request', { id: `region-request:${o.sessionId}`, sessionId: o.sessionId, key });
    this.emit(o.sessionId, 'region.review_requested', { observationId: o.id, candidateIds: material.candidates.map(c => c.id), unassignedControlIds: material.unassignedControlIds, unassignedPageTraversal: material.unassignedPageTraversal, delta: material.delta, reuseCandidates:material.reuseCandidates?.map(({reviewId,regionKey,conditionKey})=>({reviewId,regionKey,conditionKey})) });
    return true;
  }
  record(o: Observation, actions: ActionCandidate[], session: Session, input: RegionReviewInput, provenance?: Map<string, RegionReviewRecord['regions'][number]['reusedFrom']>): RegionReviewRecord {
    const value = regionReviewSchema.parse(input);
    if (session.options.regionExploration !== 'review') throw new EngineError('REGION_REVIEW_DISABLED', 'Enable regionExploration review when creating the session');
    if (value.observationId !== o.id || o.gaps.some(g => g.critical)) throw new EngineError('STALE_REGION_REVIEW', 'Review the latest complete observation');
    const old = this.store.list<RegionReviewRecord>('region-review', o.sessionId).at(-1);
    if (value.update && (!old || old.id !== value.update.baseReviewId || !this.compatible(old, o))) throw new EngineError('STALE_REGION_REVIEW', 'The base partition or its document, URL or context changed; prepare a fresh review');
    const candidates = new Map((o.regionCandidates || []).map(c => [c.id, c]));
    const controllable = new Set(this.controls(o, actions).map(c => c.localId)); const used = new Set<string>(); const keys = new Set<string>();
    const reject = () => { throw new EngineError('INVALID_REGION_REVIEW', 'Use distinct region keys and non-overlapping observed controls anchored to current candidates'); };
    const removed = value.update?.removeRegionKeys || [];
    if (new Set(removed).size !== removed.length || removed.some(key => !old?.regions.some(r => r.key === key) || value.regions.some(r => r.key === key))) reject();
    const retained = value.update ? old!.regions.filter(r => !removed.includes(r.key) && !value.regions.some(next => next.key === r.key)).map(r => ({ ...r, reviewId: r.reviewId || old!.id })) : [];
    const rejected = value.rejectedCandidateIds ?? (value.update ? old!.rejectedCandidateIds.filter(id => candidates.has(id)) : []);
    if (new Set(rejected).size !== rejected.length || rejected.some(id => !candidates.has(id)) || retained.length + value.regions.length > 500) reject();
    let traversalAssigned = false;
    for (const r of retained) {
      keys.add(r.key); if (r.status !== 'active') continue;
      if (!this.reuse.matches(old!,r,o) || r.anchors.some(a => !candidates.has(a.id) || hash(candidates.get(a.id)!.binding) !== a.fingerprint)) throw new EngineError('STALE_REGION_REVIEW', 'An omitted region changed; observe and review its new facts');
      if (r.anchors.some(a => rejected.includes(a.id)) || r.controlIds.some(id => !controllable.has(id) || used.has(id)) || r.pageTraversal && traversalAssigned) reject();
      r.controlIds.forEach(id => used.add(id)); traversalAssigned ||= r.pageTraversal;
    }
    const reviewId = id();
    const regions = value.regions.map(r => {
      if (keys.has(r.key) || new Set(r.candidateIds).size !== r.candidateIds.length || r.candidateIds.some(id => !candidates.has(id) || rejected.includes(id))) reject(); keys.add(r.key);
      const pool = new Set(r.candidateIds.flatMap(id => candidates.get(id)!.controlIds).filter(id => controllable.has(id)));
      const controlIds = r.controlIds || [...pool];
      if (!controlIds.length && !r.pageTraversal || new Set(controlIds).size !== controlIds.length || controlIds.some(id => !pool.has(id) || used.has(id))) reject();
      if (r.pageTraversal && traversalAssigned) reject(); traversalAssigned ||= r.pageTraversal;
      controlIds.forEach(id => used.add(id));
      const reuseConditions=r.reuse && this.reuse.conditions(o,r.candidateIds,controlIds,r.pageTraversal);
      if(r.reuse && !reuseConditions) throw new EngineError('INVALID_REGION_REUSE','Complete bounded structural evidence and known context are required outside active boundaries');
      return { key: r.key, label: r.label, controlIds, pageTraversal: r.pageTraversal, anchors: r.candidateIds.map(id => ({ id, fingerprint: hash(candidates.get(id)!.binding) })), reviewId, status: 'active' as const,
        ...(reuseConditions?{reuse:r.reuse,reuseConditions}:{}),...(provenance?.get(r.key)?{reusedFrom:provenance.get(r.key)}:{}) };
    });
    // Whole input is validated before superseding any previous partition or decision.
    if (old) {
      const replaced=value.update ? [...removed,...value.regions.map(r=>r.key)] : old.regions.map(r=>r.key);
      if(!provenance && this.compatible(old,o)) for(const region of old.regions.filter(r=>r.reuse && replaced.includes(r.key))) {
        this.reuse.withdraw(o.sessionId,{reviewId:region.reviewId || old.id,regionKey:region.key,source:value.source,reason:'region_partition_replaced'});
      }
      const previous=this.store.require<RegionReviewRecord>('region-review',old.id); previous.status='superseded';this.store.put('region-review',previous);this.retireGroups(old,replaced,o.id);
    }
    const combined = [...retained, ...regions];
    const record: RegionReviewRecord = { id: reviewId, sessionId: o.sessionId, observationId: o.id, instanceScope: o.instanceScope, url: o.url, contextKey: contextKey(o.context), at: now(),
      source: value.source, evidence: value.evidence, regions: combined, rejectedCandidateIds: rejected,
      status: combined.length && combined.every(r => r.status === 'invalidated') ? 'invalidated' : 'active', ...(value.update ? { baseReviewId: value.update.baseReviewId } : {}) };
    this.store.put('region-review', record); this.emit(o.sessionId, 'region.reviewed', record); return record;
  }
  reusePlan(o:Observation,actions:ActionCandidate[],session:Session,input:import('@interaction/adapter-playwright').ReuseRegionReviewsInput) {
    const value=reuseRegionReviewsSchema.parse(input),material=this.material(o,actions,session);
    if(value.observationId!==o.id || material.review?.id!==value.baseReviewId) throw new EngineError('STALE_REGION_REVIEW','Read the current observation and partition before accepting reuse');
    const seen=new Set<string>();
    const matches=value.regions.map(ref=>{
      const match=material.reuseCandidates?.find(c=>c.reviewId===ref.reviewId && c.regionKey===ref.regionKey && c.conditionKey===ref.conditionKey && c.businessScope===value.businessScope);
      if(!match || seen.has(match.regionKey)) throw new EngineError('REGION_REUSE_MISMATCH','Source, business scope or current structure no longer matches');
      seen.add(match.regionKey); return match;
    });
    return {value,matches};
  }
  acceptReuse(o:Observation,actions:ActionCandidate[],session:Session,input:import('@interaction/adapter-playwright').ReuseRegionReviewsInput) {
    const {value,matches}=this.reusePlan(o,actions,session,input);
    const old=this.store.require<RegionReviewRecord>('region-review',value.baseReviewId);
    const record=this.record(o,actions,session,{observationId:o.id,source:value.source,evidence:value.evidence,
      ...(this.compatible(old,o)?{update:{baseReviewId:old.id}}:{}),
      regions:matches.map(c=>({key:c.regionKey,label:c.label,candidateIds:c.candidateIds,controlIds:c.controlIds,pageTraversal:c.pageTraversal,reuse:{binding:'same-url-context',businessScope:value.businessScope}}))},
      new Map(matches.map(c=>[c.regionKey,{reviewId:c.reviewId,regionKey:c.regionKey,conditionKey:c.conditionKey,evidence:value.evidence}])));
    this.emit(o.sessionId,'region.review_reused',record);return record;
  }
  revokeReuse(o:Observation,input:import('@interaction/adapter-playwright').RevokeRegionReuseInput) {
    const result=this.reuse.withdraw(o.sessionId,revokeRegionReuseSchema.parse(input));this.reconcile(o);return result;
  }
  activeReuseAnchors(sid:string) { return [...new Set(this.current(sid)?.regions.filter(r=>r.status==='active' && r.reuse).flatMap(r=>r.anchors.map(a=>a.id)) || [])]; }
  reuseAnchors(o:Observation,action:ActionCandidate) {
    const review=this.current(o.sessionId);
    return [...new Set(review?.regions.filter(r=>r.status==='active' && r.reuse && (action.localId?r.controlIds.includes(action.localId):action.kind==='scroll'&&r.pageTraversal)).flatMap(r=>r.anchors.map(a=>a.id)) || [])];
  }
  validationMaterial(o:Observation,session:Session) {
    const records=session.options.regionExploration==='review'?this.store.list<RegionReviewRecord>('region-review',o.sessionId):[];
    return {records,current:records.findLast(r=>r.status==='active')};
  }
  validateAction(o:Observation,action:ActionCandidate,session:Session,material?:ReturnType<RegionReviews['validationMaterial']>) {
    if(session.options.regionExploration!=='review' || action.boundary?.intent==='exit' || action.kind==='history') return;
    // Preserve ordinary/manual region semantics. Recheck only operations whose
    // current-document scope was based on this explicit reuse contract.
    const facts=material||this.validationMaterial(o,session);
    const scoped=facts.records.some(review=>review.instanceScope===o.instanceScope && review.regions.some(r=>r.reuse && (action.localId?r.controlIds.includes(action.localId):action.kind==='scroll'&&r.pageTraversal)));
    if(!scoped) return;
    const review=facts.current;
    if(!review?.regions.some(r=>r.status==='active' && (action.localId?r.controlIds.includes(action.localId):action.kind==='scroll'&&r.pageTraversal))) throw new EngineError('REGION_REVIEW_REQUIRED','Review the current region before automated dispatch');
  }
  proposals(o: Observation, actions: ActionCandidate[]): ExplorationGroupProposal[] {
    this.reconcile(o); const review = this.current(o.sessionId); if (!review) return [];
    return review.regions.filter(r => r.status === 'active').map(r => {
      const reviewId = r.reviewId || review.id, proof = reviewId === review.id ? review : this.store.get<RegionReviewRecord>('region-review', reviewId);
      const evidence = [{ source: proof?.source || 'unavailable-region-review', rule: 'caller-region-partition/v1', facts: { reviewId, evidence: proof?.evidence || [] } }];
      return { key: `reviewed-region:${r.key}`, kind: 'reviewed-region', label: r.label,
      conditions: { regionReviewId: reviewId, regionKey: r.key, anchors: r.anchors, context: review.contextKey, url: review.url },
      collection: { key: reviewId, label: '已确认探索区域', evidence },
      actionIds: actions.filter(a => a.localId && r.controlIds.includes(a.localId) && a.kind !== 'scroll' && a.boundary?.intent !== 'exit').map(a => a.id),
      traversalActionIds: actions.filter(a => (a.localId ? r.controlIds.includes(a.localId) : r.pageTraversal) && a.kind === 'scroll' && a.boundary?.intent !== 'exit').map(a => a.id),
      evidence: evidence.map(e => ({ ...e, facts: { ...e.facts, anchors: r.anchors } })),
    }; });
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
