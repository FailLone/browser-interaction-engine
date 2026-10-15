import { canonical, contextKey, EngineError, hash, id, now, type Persistence, type ActionAttempt, type ActionCandidate, type InteractionScope, type FrontierItem } from '@interaction/core';
import { boundaryExitReviewSchema, dismissalReference, exitCandidateKey, hasReviewedDismissal, preservedControlFacts,
  type BoundaryExitMaterial, type BoundaryExitReviewInput, type BoundaryExitReviewRecord, type BoundaryExitResult, type Observation } from '@interaction/adapter-playwright';

type Episode = { id: string; sessionId: string; key: string; episodeId: string; firstObservationId: string };
export class BoundaryExits {
  constructor(private store: Persistence, private emit: (sid: string, type: string, data: unknown) => unknown) {}
  private records(sid: string) { return this.store.list<BoundaryExitReviewRecord>('boundary-exit-review', sid); }
  private episode(o: Observation) { return this.store.get<Episode>('boundary-exit-episode', `boundary-exit:${o.sessionId}`); }
  reconcile(o: Observation) {
    const active = o.overlays?.at(-1), owner = o.regions.find(r => r.key === active?.key)?.instanceId;
    const key = active ? canonical({ document: o.instanceScope, url: o.url, context: contextKey(o.context), boundary: active.key, owner, parents: o.boundaries?.map(b => b.key) }) : '';
    const prior = this.episode(o);
    if (prior?.key !== key) this.store.put('boundary-exit-episode', { id: `boundary-exit:${o.sessionId}`, sessionId: o.sessionId, key, episodeId: id(), firstObservationId: o.id });
    for (const r of this.records(o.sessionId).filter(r => r.status === 'approved')) if (!this.matches(r, o)) {
      r.status = 'invalidated'; this.store.put('boundary-exit-review', r); this.emit(o.sessionId, 'boundary.exit_review_invalidated', { reviewId: r.id, observationId: o.id });
    }
    const approved = new Set(this.records(o.sessionId).filter(r => r.status === 'approved').map(r => r.id));
    for (const f of this.store.list<FrontierItem>('frontier', o.sessionId)) {
      const ref = dismissalReference(f.action);
      if (!ref || f.attempts.length || approved.has(String(ref.facts.reviewId)) || f.status === 'superseded') continue;
      f.status = 'superseded'; f.reason = 'boundary_exit_review_invalidated'; f.unblock = undefined; this.store.put('frontier', f);
    }
  }
  private matches(r: BoundaryExitReviewRecord, o: Observation) {
    return r.status === 'approved' && r.episodeId === this.episode(o)?.episodeId && r.boundaryKey === o.boundaries?.at(-1)?.key
      && !!r.candidate && o.boundaryExitCandidates?.some(c => exitCandidateKey(c) === exitCandidateKey(r.candidate!))
      && r.preserved?.every(p => preservedControlFacts(o.controls.find(c => c.localId === p.localId)) === p.facts);
  }
  private attempted(o: Observation, candidateId: string) {
    const ids = new Set(this.records(o.sessionId).filter(r => r.episodeId === this.episode(o)?.episodeId && r.candidate?.id === candidateId).map(r => r.id));
    return this.store.list<ActionAttempt>('attempt', o.sessionId).some(a => ids.has(String(dismissalReference(a.action)?.facts.reviewId)));
  }
  material(o: Observation, actions: ActionCandidate[]): BoundaryExitMaterial {
    const episode = this.episode(o), boundary = o.overlays?.at(-1);
    const scope = this.store.list<InteractionScope>('scope', o.sessionId).find(s => s.status === 'open' && s.boundaryKey === boundary?.key);
    const attempts = this.store.list<ActionAttempt>('attempt', o.sessionId).filter(a => scope?.attemptIds.includes(a.id) && a.action.boundary?.intent === 'exit');
    return { sessionId: o.sessionId, observationId: o.id, episodeId: boundary ? episode?.episodeId : undefined, boundary,
      candidates: (o.boundaryExitCandidates || []).map(c => ({ ...c, attempted: this.attempted(o, c.id) })),
      exits: actions.filter(a => a.boundary?.intent === 'exit').map(a => ({ actionId: a.id, label: a.label, kind: a.kind, blockers: a.preconditions.blockers?.map(b => b.code) || [] })),
      attempts: attempts.map(a => ({ id: a.id, label: a.action.label, status: a.status, afterId: a.afterId,
        closed: !!a.afterId && this.store.get<Observation>('observation', a.afterId)?.instanceScope === o.instanceScope && !this.store.get<Observation>('observation', a.afterId)?.boundaries?.some(b => b.key === boundary?.key) })),
      results: this.store.list<BoundaryExitResult>('boundary-exit-result', o.sessionId),
      review: this.records(o.sessionId).filter(r => r.episodeId === episode?.episodeId).at(-1),
      limitation: 'Outside points are geometric candidates, not proof of harmless cancellation. Existing control exits use reviewControls.exitBoundary. Dispatch, closure and preservation are separate results.' };
  }
  request(o: Observation, actions: ActionCandidate[], channel: 'hook' | 'event') {
    if (!o.boundaries?.length || o.gaps.some(g => g.critical)) return false;
    const m = this.material(o, actions), key = hash({ episode: m.episodeId, candidates: m.candidates.map(c => [exitCandidateKey(c), c.attempted]) });
    const requestId = `boundary-request:${o.sessionId}:${channel}`;
    if (this.store.get<{ key: string }>('boundary-exit-request', requestId)?.key === key) return false;
    this.store.put('boundary-exit-request', { id: requestId, sessionId: o.sessionId, key });
    if (channel === 'event') this.emit(o.sessionId, 'boundary.exit_review_requested', { observationId: o.id, boundaryKey: m.boundary!.key, candidateIds: m.candidates.map(c => c.id) });
    return true;
  }
  prepare(o: Observation, input: BoundaryExitReviewInput) {
    const parsed = boundaryExitReviewSchema.parse(input), episode = this.episode(o);
    if (parsed.observationId !== o.id || !episode || !o.overlays?.length || parsed.boundaryKey !== o.boundaries?.at(-1)?.key || o.gaps.some(g => g.critical)) throw new EngineError('STALE_BOUNDARY_EXIT_REVIEW', 'Review the current complete boundary');
    if (Object.values(o.context).some(v => v.status !== 'known')) throw new EngineError('UNKNOWN_REVIEW_CONTEXT', 'Resolve declared context before reviewing an exit');
    const decision = parsed.decision;
    const candidate = decision.mode === 'attempt' ? o.boundaryExitCandidates?.find(c => c.id === decision.candidateId) : undefined;
    if (decision.mode === 'attempt' && (!candidate || this.attempted(o, candidate.id))) throw new EngineError('INVALID_BOUNDARY_EXIT_REVIEW', 'Choose a current, unattempted outside point');
    const preserved = decision.mode === 'attempt' ? [...new Set(decision.preserveControlIds)].map(localId => {
      const c = o.controls.find(c => c.localId === localId), facts = preservedControlFacts(c);
      if (!facts || !c?.visible) throw new EngineError('INVALID_BOUNDARY_EXIT_REVIEW', 'Preserved controls must be currently visible instances');
      return { localId, facts };
    }) : [];
    const record: BoundaryExitReviewRecord = { ...parsed, id: id(), sessionId: o.sessionId, episodeId: episode.episodeId, at: now(),
      status: decision.mode === 'attempt' ? 'approved' : 'deferred', candidate, preserved };
    return record;
  }
  record(o: Observation, input: BoundaryExitReviewInput) {
    const record = this.prepare(o, input);
    for (const old of this.records(o.sessionId).filter(r => r.status === 'approved')) { old.status = 'invalidated'; this.store.put('boundary-exit-review', old); }
    this.store.put('boundary-exit-review', record); this.emit(o.sessionId, 'boundary.exit_reviewed', record); return record;
  }
  action(r: BoundaryExitReviewRecord, o: Observation): ActionCandidate {
    const c = r.candidate!;
    return { id: id(), sessionId: o.sessionId, observationId: o.id, stateId: o.stateId,
      kind: 'dismiss', value: c.id, label: 'Click reviewed outside point', risk: 'interface', replayable: false,
      source: 'boundary-exit-review', excluded: false, sampleValidity: 'known', preconditions: { context: o.context, visible: true, enabled: true, identityResolved: true },
      basis: { status: 'supported', evidence: [{ source: r.source, rule: 'reviewed-boundary-dismissal/v1', facts: {
        reviewId: r.id, observationId: o.id, boundaryKey: r.boundaryKey, candidateId: c.id, binding: exitCandidateKey(c),
        documentId: o.documentId, url: o.url, preserved: r.preserved!, evidence: r.evidence,
      } }] } };
  }
  apply(actions: ActionCandidate[], o: Observation) {
    return [...actions, ...this.records(o.sessionId).filter(r => this.matches(r, o) && !this.attempted(o, r.candidate!.id)).map(r => this.action(r, o))];
  }
  validate(a: ActionCandidate, o: Observation) {
    if (a.kind !== 'dismiss') return;
    const ref = dismissalReference(a), r = this.store.get<BoundaryExitReviewRecord>('boundary-exit-review', String(ref?.facts.reviewId));
    if (!r || !this.matches(r, o) || !hasReviewedDismissal(a, o) || this.attempted(o, r.candidate!.id)) throw new EngineError('BOUNDARY_EXIT_REVIEW_EXPIRED', 'Observe and review this boundary again');
  }
  blockingResult(sid: string) {
    const last = this.store.list<ActionAttempt>('attempt', sid).at(-1);
    return last && this.store.list<BoundaryExitResult>('boundary-exit-result', sid).find(r => r.attemptId === last.id && ['changed', 'unverified'].includes(r.status));
  }
  finishUnknown(a: ActionAttempt) {
    const ref = dismissalReference(a.action);
    if (!ref || this.store.list<BoundaryExitResult>('boundary-exit-result', a.sessionId).some(r => r.attemptId === a.id)) return;
    const r = this.store.require<BoundaryExitReviewRecord>('boundary-exit-review', String(ref.facts.reviewId));
    r.status = 'attempted'; this.store.put('boundary-exit-review', r);
    const result: BoundaryExitResult = { id: id(), sessionId: a.sessionId, reviewId: r.id, attemptId: a.id, beforeId: a.beforeId,
      afterId: a.afterId, dispatched: a.status, closed: false, parentReady: false, preserved: false, status: 'unverified', evidence: [a.reason || 'Post-action observation unavailable'] };
    this.store.put('boundary-exit-result', result); this.emit(a.sessionId, 'boundary.exit_result', result);
  }
  finish(o: Observation, before: Observation | undefined, attemptId?: string) {
    if (!attemptId || !before) return;
    const a = this.store.require<ActionAttempt>('attempt', attemptId), ref = dismissalReference(a.action);
    if (!ref) return;
    const r = this.store.require<BoundaryExitReviewRecord>('boundary-exit-review', String(ref.facts.reviewId));
    const complete = a.status === 'succeeded' && !o.gaps.some(g => g.critical);
    const same = before.instanceScope === o.instanceScope && before.url === o.url && contextKey(before.context) === contextKey(o.context);
    const closed = complete && same && !o.boundaries?.some(b => b.key === r.boundaryKey);
    const parentReady = closed && o.stable && !o.gaps.some(g => g.code === 'PARTIAL_INTERACTION_READY')
      && canonical(o.boundaries?.map(b => b.key) || []) === canonical((before.boundaries || []).slice(0, -1).map(b => b.key));
    const preserved = same && r.preserved!.every(p => preservedControlFacts(o.controls.find(c => c.localId === p.localId)) === p.facts);
    const result: BoundaryExitResult = { id: id(), sessionId: o.sessionId, reviewId: r.id, attemptId, beforeId: before.id, afterId: o.id,
      dispatched: a.status, closed, parentReady, preserved,
      status: !complete ? 'unverified' : !same || !preserved ? 'changed' : !closed ? 'not_closed' : parentReady ? 'verified' : 'unverified',
      evidence: ['Compared document, URL, declared context, boundary stack and caller-selected control facts', 'No assertion about undeclared server state'] };
    r.status = 'attempted'; this.store.put('boundary-exit-review', r); this.store.put('boundary-exit-result', result); this.emit(o.sessionId, 'boundary.exit_result', result);
  }
}
