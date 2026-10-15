import type { ExplorationGroup, ExplorationReviewMaterial, FrontierItem, IdentityHypothesis, Observation } from './types.js';
import { canonical, hash } from './util.js';

/** Organize stored facts without browsing, mutating scopes, or inferring business equivalence. */
export function explorationReviewMaterial(sessionId: string, observationId: string, stored: ExplorationGroup[], requestedGroupIds: string[] = [],
  identityWork?: { hypotheses: IdentityHypothesis[]; frontier: FrontierItem[]; current: Observation }): ExplorationReviewMaterial {
  const groups = stored.filter(g => g.sessionId === sessionId && g.status !== 'invalidated');
  const collections = new Map<string, ExplorationReviewMaterial['collections'][number]>();
  const owners = new Map<string, Set<string>>();
  for (const g of groups) {
    const declared = g.collection;
    // Include evidence in the key: conflicting caller declarations never silently coalesce.
    const key = hash(declared ? { declared } : { unassignedKind: g.kind });
    const collection = collections.get(key) || { key, label: declared?.label || g.kind, evidence: declared?.evidence || [{
      source: 'core', rule: 'scope-kind-review-collection/v1', facts: { kind: g.kind, meaning: 'Presentation by scope type only; no shared business purpose or authorization' },
    }], groupIds: [] };
    collection.groupIds.push(g.id); collections.set(key, collection);
    for (const memberKey of [...g.members.map(m => m.key), ...g.traversalKeys || []]) {
      const groupIds = owners.get(memberKey) || new Set<string>(); groupIds.add(g.id); owners.set(memberKey, groupIds);
    }
  }
  const overlaps = new Map<string, ExplorationReviewMaterial['overlaps'][number]>();
  for (const [memberKey, ownersOfMember] of owners) if (ownersOfMember.size > 1) {
    const groupIds = [...ownersOfMember].sort(), key = canonical(groupIds);
    const overlap = overlaps.get(key) || { groupIds, caseKeys: [] };
    overlap.caseKeys.push(memberKey); overlaps.set(key, overlap);
  }
  const identityReviews = (identityWork?.hypotheses || []).filter(h => h.sessionId === sessionId && h.status === 'pending').flatMap(h => {
    const work = identityWork!.frontier.filter(f => f.sessionId === sessionId && f.action.controlId === h.provisionalIdentityId);
    if (!work.length) return [];
    return [{ hypothesisId: h.id, observationId: h.observationId, localId: h.localId, provisionalIdentityId: h.provisionalIdentityId,
      candidateIds: [...h.candidateIds], frontierIds: work.map(f => f.id),
      groupIds: [...new Set(work.flatMap(f => f.explorationGroups?.map(r => r.groupId) || []))],
      currentLocalIds: identityWork!.current.controls.filter(c => c.hypothesisId === h.id).map(c => c.localId) }];
  });
  return { sessionId, observationId, groups, collections: [...collections.values()], overlaps: [...overlaps.values()], requestedGroupIds, identityReviews };
}
