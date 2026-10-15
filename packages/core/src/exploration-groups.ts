import type { Persistence } from './ports.js';
import { EngineError, type ActionCandidate, type ExplorationGroup, type ExplorationGroupDecision, type ExplorationGroupProposal, type FrontierItem, type Observation } from './types.js';
import { explorationGroupDecisionSchema, explorationGroupProposalSchema } from './schema.js';
import { canonical, contextKey, hash, id, now } from './util.js';

/** Validate the whole batch before writing anything, including caller references. */
export function validateExplorationProposals(input: unknown, actions: ActionCandidate[]): ExplorationGroupProposal[] {
  if (!Array.isArray(input)) throw new EngineError('INVALID_EXPLORATION_GROUP', 'Scope hook must return an array');
  const ids = new Set(actions.map(a => a.id)); const keys = new Set<string>();
  return input.map(value => {
    const p = explorationGroupProposalSchema.parse(value);
    const key = canonical([p.kind, p.key]); const members = [...p.actionIds, ...p.traversalActionIds];
    if (keys.has(key) || new Set(members).size !== members.length || members.some(aid => !ids.has(aid))) {
      throw new EngineError('INVALID_EXPLORATION_GROUP', 'Scopes require unique keys and distinct current action references');
    }
    keys.add(key); return p;
  });
}

/** Persistent scheduling decisions. No interpretation of browser actions or business effects. */
export class ExplorationGroups {
  constructor(private store: Persistence, private emit: (sessionId: string, type: string, data: unknown) => unknown) {}

  discover(proposals: ExplorationGroupProposal[], actions: ActionCandidate[], o: Observation, keyOf: (action: ActionCandidate) => string) {
    const byAction = new Map(actions.map(a => [a.id, a]));
    const known = this.store.list<ExplorationGroup>('exploration-group', o.sessionId);
    if (!known.length && !proposals.length) return { references: new Map<string, NonNullable<FrontierItem['explorationGroups']>>(), requested: [] };
    const caseKeys = new Map<string, string>(); const computeKey = keyOf;
    keyOf = a => { let key = caseKeys.get(a.id); if (!key) { key = computeKey(a); caseKeys.set(a.id, key); } return key; };
    const invalidate = (group: ExplorationGroup) => {
      group.status = 'invalidated'; group.revision++; group.invalidation = { observationId: o.id, reason: 'exploration_conditions_changed' };
      this.store.put('exploration-group', group);
      this.emit(o.sessionId, 'exploration.group_invalidated', { groupId: group.id, revision: group.revision, ...group.invalidation });
    };
    for (const g of known) if (g.status !== 'invalidated' && (g.kind !== 'similar-list' || g.conditions !== undefined)
      && (g.binding !== 'context' && g.instanceScope !== o.instanceScope || g.contextKey !== contextKey(o.context))) invalidate(g);
    const groups = new Map(known.filter(g => g.status !== 'invalidated').map(g => [g.key, g]));
    const references = new Map<string, NonNullable<FrontierItem['explorationGroups']>>();
    const requested: ExplorationGroup[] = [];
    const addRef = (aid: string, groupId: string, memberKey?: string) => {
      if (byAction.get(aid)?.boundary?.intent === 'exit') return;
      const refs = references.get(aid) || [];
      if (!refs.some(ref => ref.groupId === groupId)) refs.push({ groupId, ...(memberKey ? { memberKey } : {}) });
      references.set(aid, refs);
    };
    for (const proposal of proposals) {
      // Preserve persisted list keys; custom scopes also bind their declared conditions.
      const key = hash({ proposal: proposal.key, scope: proposal.binding === 'context' ? 'context-bound' : o.instanceScope, context: contextKey(o.context),
        ...(proposal.kind !== 'similar-list' || proposal.conditions !== undefined ? { kind: proposal.kind, conditions: proposal.conditions } : {}) });
      // A generic scope is a decision under current conditions, never a reusable
      // approval for returning to old conditions. Legacy list decisions keep their contract.
      for (const old of known) if (old.status !== 'invalidated' && old.kind === proposal.kind && old.proposalKey === proposal.key && old.key !== key
        && (proposal.kind !== 'similar-list' || proposal.conditions !== undefined)) {
        invalidate(old); groups.delete(old.key);
      }
      let group = groups.get(key);
      const memberActions = proposal.actionIds.map(aid => byAction.get(aid)!).filter(a => a.boundary?.intent !== 'exit');
      const traversal = proposal.traversalActionIds.filter(aid => byAction.get(aid)!.boundary?.intent !== 'exit');
      const members = new Map(memberActions.map(a => [keyOf(a), { key: keyOf(a), actionId: a.id, observationId: o.id, localId: a.localId, label: a.label, kind: a.kind, value: a.value, risk: a.risk, excluded: a.excluded }]));
      // A known virtual list remains known when filtering leaves one or zero members.
      if (!group && (proposal.kind === 'similar-list' ? members.size < 2 : proposal.binding !== 'context' && !members.size && !traversal.length)) continue;
      const created = !group;
      group ??= { id: id(), sessionId: o.sessionId, key, proposalKey: proposal.key, kind: proposal.kind, label: proposal.label, conditions: proposal.conditions, binding: proposal.binding,
        membership: 'observed-action-cases', instanceScope: o.instanceScope, contextKey: contextKey(o.context), observationId: o.id, revision: 1,
        status: 'pending', evidence: proposal.evidence, members: [], decisions: [] };
      const existing = new Map(group.members.map(m => [m.key, m]));
      const added = [...members.keys()].filter(k => !existing.has(k));
      const traversalKeys = new Set(group.traversalKeys || []);
      for (const aid of traversal) traversalKeys.add(keyOf(byAction.get(aid)!));
      for (const [key, member] of members) existing.set(key, member);
      group.members = [...existing.values()]; group.observationId = o.id; group.traversalKeys = [...traversalKeys];
      if (!created && added.length) group.revision++;
      this.store.put('exploration-group', group); groups.set(key, group);
      for (const a of memberActions) addRef(a.id, group.id, keyOf(a));
      for (const aid of traversal) addRef(aid, group.id);
      if (created) { known.push(group); requested.push(group); this.emit(o.sessionId, 'exploration.group_detected', group); }
      else if (added.length) this.emit(o.sessionId, 'exploration.group_updated', { groupId: group.id, revision: group.revision, observationId: o.id, addedMemberKeys: added });
    }
    // Omitting a previously declared scope is not approval of its still-observed
    // members. Producers must keep proposing it to enroll newly observed members.
    const byMember = new Map<string, { groupId: string; memberKey?: string }[]>();
    for (const g of groups.values()) if ((g.binding === 'context' || g.instanceScope === o.instanceScope) && g.contextKey === contextKey(o.context)) {
      for (const m of g.members) { const owners = byMember.get(m.key) || []; owners.push({ groupId: g.id, memberKey: m.key }); byMember.set(m.key, owners); }
      for (const key of g.traversalKeys || []) { const owners = byMember.get(key) || []; owners.push({ groupId: g.id }); byMember.set(key, owners); }
    }
    for (const a of actions) for (const ref of byMember.get(keyOf(a)) || []) addRef(a.id, ref.groupId, ref.memberKey);
    return { references, requested };
  }

  apply(sessionId: string, items: FrontierItem[]) {
    const groups = new Map(this.store.list<ExplorationGroup>('exploration-group', sessionId).map(g => [g.id, g]));
    for (const item of items) {
      // Capability, risk, identity and reachability blockers retain their original reason.
      if (!['pending', 'deferred', 'skipped', 'needs_revalidation'].includes(item.status) || !item.explorationGroups?.length) continue;
      if (item.explorationGroups.some(ref => groups.get(ref.groupId)?.status === 'invalidated') && !item.attempts.length) {
        item.status = 'superseded'; item.reason = 'exploration_scope_invalidated'; item.unblock = undefined; this.store.put('frontier', item); continue;
      }
      if (item.status === 'needs_revalidation') continue;
      const gates = item.explorationGroups.map(ref => {
        const group = groups.get(ref.groupId); const decision = group?.decisions.at(-1)?.decision;
        const prefix = group?.kind === 'similar-list' ? 'list' : 'exploration';
        if (!decision) return { priority: 1, reason: `awaiting_${prefix}_decision` };
        if (decision.mode === 'skip') return { priority: 0, reason: 'exploration_skipped_by_caller' };
        if (decision.mode === 'defer') return { priority: 2, reason: `${prefix}_deferred_by_caller` };
        if (decision.mode === 'sample' && (!ref.memberKey || !decision.memberKeys.includes(ref.memberKey))) return { priority: 3, reason: `${prefix}_member_not_selected` };
      }).filter(g => g !== undefined).sort((a, b) => a.priority - b.priority);
      const reason = gates[0]?.reason;
      if (reason) { item.status = gates[0].priority === 0 ? 'skipped' : 'deferred'; item.reason = reason; item.unblock = 'Supply an exploration group decision; unexecuted members remain uncovered'; }
      else if (item.status === 'deferred' || item.status === 'skipped') { item.status = 'pending'; item.reason = undefined; item.unblock = undefined; }
      else continue;
      this.store.put('frontier', item);
    }
  }

  decide(sessionId: string, groupId: string, revision: number, input: ExplorationGroupDecision) {
    const group = this.store.get<ExplorationGroup>('exploration-group', groupId);
    if (!group || group.sessionId !== sessionId) throw new EngineError('NOT_FOUND', 'Exploration group not found');
    if (group.status === 'invalidated') throw new EngineError('EXPLORATION_SCOPE_INVALIDATED', 'Scope conditions changed; decide the newly observed scope');
    if (group.revision !== revision) throw new EngineError('STALE_GROUP_DECISION', 'Read the latest group revision before deciding');
    const decision = explorationGroupDecisionSchema.parse(input);
    if (decision.mode === 'sample' && (new Set(decision.memberKeys).size !== decision.memberKeys.length || decision.memberKeys.some(k => !group.members.some(m => m.key === k)))) {
      throw new EngineError('INVALID_GROUP_DECISION', 'Sample members must be distinct observed members of this group');
    }
    if (canonical(group.decisions.at(-1)?.decision) === canonical(decision)) return group;
    group.decisions.push({ revision: group.revision, at: now(), decision }); group.status = 'decided'; group.revision++;
    this.store.put('exploration-group', group);
    this.apply(sessionId, this.store.list<FrontierItem>('frontier', sessionId));
    this.emit(sessionId, 'exploration.group_decided', { groupId, revision: group.revision, decision });
    this.emit(sessionId, 'frontier.updated', { groupId });
    return group;
  }
}
