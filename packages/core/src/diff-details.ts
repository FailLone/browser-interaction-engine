import type { Persistence } from './ports.js';
import { EngineError, type ActionAttempt, type ActionCandidate, type Change, type ControlIdentity, type Diff, type Gap, type IdentityHypothesis, type InteractionScope, type Observation, type Session, type Visit } from './types.js';
import { canonical, clone } from './util.js';

export interface DiffSource { kind: 'comparison' | 'attempt' | 'event' | 'scope'; id?: string; sequence?: number }
export interface ControlOccurrenceDetails<O extends Observation> {
  observationId: string; control: O['controls'][number];
  regionPath: O['regions']; actions: ActionCandidate[];
  identityEvidence: string[];
}
export interface DiffControlDetails<O extends Observation> {
  identityId: string; label: string;
  before: ControlOccurrenceDetails<O>[]; after: ControlOccurrenceDetails<O>[];
  /** Only used when a candidate does not occur in either compared observation. */
  historical?: ControlOccurrenceDetails<O>;
  correspondence: 'same_identity' | 'uncertain' | 'one_sided' | 'unavailable';
  hypothesisIds: string[];
  alternatives: { identityId: string; evidence: ('hypothesis_candidate' | 'same_instance')[]; verified: false }[];
}
export interface DiffHypothesisDetails {
  id: string; observationId: string; localId: string; provisionalIdentityId: string;
  candidateIds: string[]; evidence: string[]; conflicts: string[];
  /** Historical occurrence references are never rewritten after a ruling. */
  statusAtComparison: 'pending' | 'resolved'; revisionsAtComparison: IdentityHypothesis['revisions'];
  currentResolution: { status: IdentityHypothesis['status']; revisions: IdentityHypothesis['revisions']; asOf: 'query_time' };
}
export interface ExplainedChange {
  index: number; change: Change; target: { kind: 'control' | 'context' | 'observation'; label: string; controlId?: string };
  interpretation: { code: string; summary: string; certainty: 'observed' | 'identity_uncertain'; limitations: string[] };
}
export interface DiffDetails<O extends Observation = Observation> {
  schemaVersion: 1; sessionId: string; source: DiffSource; diff: Diff;
  semantics: { attribution: Diff['attribution']; causality: 'not_established'; businessMeaning: 'not_inferred'; historicalEvidence: 'immutable_observations'; identityResolution: 'historical_and_current_separated' };
  interval: { beforeAt: string; afterAt: string; elapsedMs: number | null; chronological: boolean };
  summary: { changes: number; byKind: Record<Change['kind'], number>; affectedControls: number; uncertainControls: number; contextChanged: boolean; reuse: 'requires_revalidation' | 'not_assessed' };
  observations: { before: O; after: O };
  changes: ExplainedChange[];
  controls: Record<string, DiffControlDetails<O>>;
  hypotheses: DiffHypothesisDetails[];
  gaps: { origin: 'diff' | 'before' | 'after' | 'enrichment'; gap: Gap; controlIds: string[]; hypothesisIds: string[] }[];
  related: { attempts: ActionAttempt[]; visits: Visit[]; scopes: InteractionScope[]; path: { verifiedAncestry: boolean; visitIds: string[]; attemptIds: string[] } };
}

/** A read-only join of committed facts. No driver, platform, transport or storage implementation. */
export function describeDiff<O extends Observation>(store: Persistence, sessionId: string, diff: Diff, source: DiffSource): DiffDetails<O> {
  const owned = <T extends { sessionId: string }>(kind: string, id: string) => {
    const entity = store.require<T>(kind, id);
    if (entity.sessionId !== sessionId) throw new EngineError('NOT_FOUND', `${kind} does not belong to session`);
    return entity;
  };
  const before = owned<O>('observation', diff.beforeId), after = owned<O>('observation', diff.afterId);
  const endAt = before.capturedAt > after.capturedAt ? before.capturedAt : after.capturedAt;
  const identities = new Map(store.list<ControlIdentity<O['controls'][number]>>('identity', sessionId).map(i => [i.id, i]));
  const hypotheses = new Map(store.list<IdentityHypothesis>('hypothesis', sessionId).map(h => [h.id, h]));
  const actions = store.list<ActionCandidate>('action', sessionId);
  const visits = store.list<Visit>('visit', sessionId), attempts = store.list<ActionAttempt>('attempt', sessionId);
  const scopes = store.list<InteractionScope>('scope', sessionId).filter(s => s.beforeId === before.id && s.afterId === after.id);
  const visitMap = new Map(visits.map(v => [v.id, v])); const path: Visit[] = []; const seenVisits = new Set<string>();
  let cursor = visitMap.get(after.visitId);
  while (cursor && !seenVisits.has(cursor.id)) {
    path.unshift(cursor); seenVisits.add(cursor.id);
    if (cursor.observationId === before.id) break;
    cursor = cursor.parentId ? visitMap.get(cursor.parentId) : undefined;
  }
  const verifiedAncestry = path[0]?.observationId === before.id;
  const pathAttemptIds = verifiedAncestry ? path.slice(1).flatMap(v => v.viaAttemptId ? [v.viaAttemptId] : []) : [];
  const relatedAttempts = attempts.filter(a => a.beforeId === before.id && a.afterId === after.id || pathAttemptIds.includes(a.id) || scopes.some(s => s.attemptIds.includes(a.id)));
  const selectedIds = new Set(diff.changes.flatMap(c => c.controlId ? [c.controlId] : []));
  relatedAttempts.forEach(a => { if (a.action.controlId) selectedIds.add(a.action.controlId); });
  for (const gap of diff.gaps) for (const ref of [gap.reference, gap.message]) {
    if (ref && identities.has(ref)) selectedIds.add(ref);
    const h = ref && hypotheses.get(ref); if (h) selectedIds.add(h.provisionalIdentityId);
  }
  const controls: DiffDetails<O>['controls'] = Object.create(null);
  const selectedHypotheses = new Set<string>();
  const enrichmentGaps: Gap[] = [];
  const occurrence = (o: O, c: O['controls'][number]): ControlOccurrenceDetails<O> => {
    const path: O['regions'][number][] = []; const seen = new Set<string>(); let key = c.region;
    while (key && !seen.has(key)) { seen.add(key); const region = o.regions.find(r => r.key === key); if (!region) break; path.unshift(region); key = region.parentKey || ''; }
    return { observationId: o.id, control: c, regionPath: path as O['regions'], actions: actions.filter(a => a.observationId === o.id && (a.localId ? a.localId === c.localId : a.controlId === c.identityId)), identityEvidence: identities.get(c.identityId || '')?.occurrences.filter(x => x.observationId === o.id && x.localId === c.localId).flatMap(x => x.evidence) || [] };
  };
  const add = (identityId: string) => {
    if (controls[identityId]) return controls[identityId];
    const left = before.controls.filter(c => c.identityId === identityId).map(c => occurrence(before, c));
    const right = after.controls.filter(c => c.identityId === identityId).map(c => occurrence(after, c));
    let historical: ControlOccurrenceDetails<O> | undefined;
    if (!left.length && !right.length) {
      for (const ref of (identities.get(identityId)?.occurrences || []).slice().reverse()) {
        const observation = store.get<O>('observation', ref.observationId);
        if (!observation || observation.sessionId !== sessionId || observation.capturedAt > endAt) continue;
        const control = observation.controls.find(c => c.localId === ref.localId && c.identityId === identityId);
        if (control) { historical = occurrence(observation, control); break; }
      }
    }
    const all = [...left, ...right, ...(historical ? [historical] : [])];
    const hypothesisIds = [...new Set(all.flatMap(o => o.control.hypothesisId ? [o.control.hypothesisId] : []))];
    hypothesisIds.forEach(id => selectedHypotheses.add(id));
    const c = right[0]?.control || left[0]?.control || historical?.control;
    const details: DiffControlDetails<O> = { identityId, label: c?.name || c?.label || (c ? `Unnamed ${c.role || 'control'}` : 'Unresolved control reference'), before: left, after: right, historical, correspondence: hypothesisIds.length || left.length > 1 || right.length > 1 ? 'uncertain' : left.length && right.length ? 'same_identity' : all.length ? 'one_sided' : 'unavailable', hypothesisIds, alternatives: [] };
    if (!all.length) enrichmentGaps.push({ code: 'CONTROL_EVIDENCE_UNAVAILABLE', reference: identityId, message: 'No occurrence at or before the comparison interval is available' });
    for (const id of hypothesisIds) if (!hypotheses.has(id)) enrichmentGaps.push({ code: 'HYPOTHESIS_UNAVAILABLE', reference: id, message: 'The observation references an unavailable identity hypothesis' });
    controls[identityId] = details; return details;
  };
  // Include ambiguous occurrences even when the raw comparator emitted no change for them.
  for (const o of [before, after]) for (const c of o.controls) if (c.hypothesisId && c.identityId && (!diff.region || occurrence(o, c).regionPath.some(r => r.key === diff.region))) selectedIds.add(c.identityId);
  for (const id of selectedIds) add(id);
  // One-hop alternatives preserve ambiguity without recursively expanding the entire identity graph.
  for (const id of selectedIds) {
    const item = controls[id]; const related = new Map<string, Set<'hypothesis_candidate' | 'same_instance'>>();
    const relate = (other: string, evidence: 'hypothesis_candidate' | 'same_instance') => { if (other !== id) { if (!related.has(other)) related.set(other, new Set()); related.get(other)!.add(evidence); } };
    for (const h of hypotheses.values()) if (item.hypothesisIds.includes(h.id) || h.provisionalIdentityId === id && [before.id, after.id].includes(h.observationId)) {
      selectedHypotheses.add(h.id); h.candidateIds.forEach(candidate => relate(candidate, 'hypothesis_candidate'));
    }
    for (const side of item.before) for (const candidate of after.controls) if (before.instanceScope === after.instanceScope && candidate.instanceId === side.control.instanceId && candidate.identityId) relate(candidate.identityId, 'same_instance');
    for (const side of item.after) for (const candidate of before.controls) if (before.instanceScope === after.instanceScope && candidate.instanceId === side.control.instanceId && candidate.identityId) relate(candidate.identityId, 'same_instance');
    item.alternatives = [...related].map(([identityId, evidence]) => ({ identityId, evidence: [...evidence], verified: false }));
    if (item.alternatives.length) item.correspondence = 'uncertain';
    for (const other of related.keys()) add(other);
  }
  const resolvedHypotheses: DiffHypothesisDetails[] = [...selectedHypotheses].flatMap(id => {
    const h = hypotheses.get(id); if (!h) return [];
    const revisions = h.revisions.filter(r => r.at <= endAt);
    return [{ id: h.id, observationId: h.observationId, localId: h.localId, provisionalIdentityId: h.provisionalIdentityId, candidateIds: h.candidateIds, evidence: h.evidence, conflicts: h.conflicts, statusAtComparison: revisions.length ? 'resolved' : 'pending', revisionsAtComparison: revisions, currentResolution: { status: h.status, revisions: h.revisions, asOf: 'query_time' as const } }];
  });
  const changes: ExplainedChange[] = diff.changes.map((change, index) => {
    const target = change.controlId ? controls[change.controlId] : undefined;
    const uncertain = target?.correspondence === 'uncertain' || target?.correspondence === 'unavailable';
    const meanings: Record<Change['kind'], string> = { changed: 'A recorded property differs between the two observations.', appeared: 'This logical identity was observed only on the after side; this does not prove a new underlying object was created.', disappeared: 'This logical identity was observed only on the before side; this does not prove the underlying object was removed.', rebuilt: 'The recorded instance changed while the logical identity was retained.', context: 'Recorded business context differs; prior exploration results require revalidation.' };
    return { index, change, target: { kind: change.controlId ? 'control' : change.kind === 'context' ? 'context' : 'observation', label: target?.label || (change.kind === 'context' ? 'Business context' : 'Observation'), controlId: change.controlId }, interpretation: { code: change.kind, summary: meanings[change.kind], certainty: uncertain ? 'identity_uncertain' : 'observed', limitations: ['Changes were observed during the interval; causation by an action is not established.', ...(uncertain ? ['Identity correspondence is uncertain. Inspect hypotheses and alternatives before treating this as an object-level change.'] : [])] } };
  });
  const gaps: DiffDetails<O>['gaps'] = [];
  const addGaps = (origin: DiffDetails<O>['gaps'][number]['origin'], values: Gap[]) => values.forEach(gap => {
    const refs = [gap.reference, gap.message].filter((r): r is string => !!r);
    const controlIds = refs.filter(r => !!controls[r]);
    const hypothesisIds = [...new Set([...refs.filter(r => hypotheses.has(r)), ...controlIds.flatMap(id => controls[id].hypothesisIds)])];
    gaps.push({ origin, gap, controlIds, hypothesisIds });
  });
  addGaps('diff', diff.gaps); addGaps('before', before.gaps); addGaps('after', after.gaps); addGaps('enrichment', enrichmentGaps);
  const byKind = { appeared: 0, disappeared: 0, rebuilt: 0, changed: 0, context: 0 }; diff.changes.forEach(c => byKind[c.kind]++);
  const contextChanged = canonical(before.context) !== canonical(after.context);
  const elapsedMs = Date.parse(after.capturedAt) - Date.parse(before.capturedAt);
  return clone({ schemaVersion: 1, sessionId, source, diff,
    semantics: { attribution: diff.attribution, causality: 'not_established', businessMeaning: 'not_inferred', historicalEvidence: 'immutable_observations', identityResolution: 'historical_and_current_separated' },
    interval: { beforeAt: before.capturedAt, afterAt: after.capturedAt, elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null, chronological: Number.isFinite(elapsedMs) && elapsedMs >= 0 },
    summary: { changes: changes.length, byKind, affectedControls: new Set(diff.changes.flatMap(c => c.controlId ? [c.controlId] : [])).size, uncertainControls: Object.values(controls).filter(c => c.correspondence === 'uncertain').length, contextChanged, reuse: contextChanged ? 'requires_revalidation' : 'not_assessed' },
    observations: { before, after }, changes, controls, hypotheses: resolvedHypotheses, gaps,
    related: { attempts: relatedAttempts, visits: verifiedAncestry ? path : visits.filter(v => v.observationId === before.id || v.observationId === after.id), scopes, path: { verifiedAncestry, visitIds: verifiedAncestry ? path.map(v => v.id) : [], attemptIds: pathAttemptIds } },
  });
}

/** Standalone read API for offline evidence readers, with no session recovery or mutations. */
export class DiffQueries<O extends Observation = Observation> {
  constructor(readonly store: Persistence, private compare: (before: O, after: O, region?: string) => Diff) {}
  private owned<T extends { sessionId: string }>(kind: string, id: string, sessionId: string): T {
    const value = this.store.require<T>(kind, id);
    if (value.sessionId !== sessionId) throw new EngineError('NOT_FOUND', `${kind} does not belong to session`);
    return value;
  }
  diffDetails(sessionId: string, beforeId: string, afterId: string, region?: string) {
    this.store.require<Session>('session', sessionId);
    return describeDiff<O>(this.store, sessionId, this.compare(this.owned<O>('observation', beforeId, sessionId), this.owned<O>('observation', afterId, sessionId), region), { kind: 'comparison' });
  }
  attemptDiffDetails(sessionId: string, attemptId: string) {
    const attempt = this.owned<ActionAttempt>('attempt', attemptId, sessionId);
    if (!attempt.diff) throw new EngineError('DIFF_UNAVAILABLE', 'This attempt has no recorded diff', { attemptId, status: attempt.status, reason: attempt.reason });
    return describeDiff<O>(this.store, sessionId, attempt.diff, { kind: 'attempt', id: attemptId });
  }
  scopeDiffDetails(sessionId: string, scopeId: string) {
    const scope = this.owned<InteractionScope>('scope', scopeId, sessionId);
    if (!scope.diff) throw new EngineError('DIFF_UNAVAILABLE', 'This scope has no recorded diff', { scopeId, status: scope.status });
    return describeDiff<O>(this.store, sessionId, scope.diff, { kind: 'scope', id: scopeId });
  }
  eventDiffDetails(sessionId: string, sequence: number) {
    this.store.require<Session>('session', sessionId);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new EngineError('INVALID_QUERY', 'Event sequence must be a positive safe integer');
    const event = this.store.events(sessionId, sequence - 1, 1)[0];
    if (!event || event.sequence !== sequence) throw new EngineError('NOT_FOUND', 'Event does not belong to this session');
    const data = event.data as { diff?: Diff } & Partial<Diff> | null;
    const diff = ['observation.diff', 'observation.external_change'].includes(event.type) ? data as Diff : ['action.completed', 'scope.closed'].includes(event.type) ? data?.diff : undefined;
    if (!diff?.beforeId || !diff.afterId || !Array.isArray(diff.changes) || !Array.isArray(diff.gaps)) throw new EngineError('DIFF_UNAVAILABLE', 'This event has no recorded diff', { sequence, type: event.type });
    return describeDiff<O>(this.store, sessionId, diff, { kind: 'event', sequence });
  }
}
