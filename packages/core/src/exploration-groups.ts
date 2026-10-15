import type { Persistence } from './ports.js';
import { EngineError, type ActionCandidate, type ExplorationGroup, type ExplorationGroupDecision, type ExplorationGroupProposal, type FrontierItem, type Observation } from './types.js';
import { explorationGroupDecisionSchema } from './schema.js';
import { canonical, contextKey, hash, id, now } from './util.js';

/** Persistent scheduling decisions. No interpretation of browser actions or business effects. */
export class ExplorationGroups {
  constructor(private store: Persistence, private emit: (sessionId: string, type: string, data: unknown) => unknown) {}

  discover(proposals: ExplorationGroupProposal[], actions: ActionCandidate[], o: Observation, keyOf: (action: ActionCandidate) => string) {
    const byAction = new Map(actions.map(a => [a.id, a]));
    const groups = new Map(this.store.list<ExplorationGroup>('exploration-group', o.sessionId).map(g => [g.key, g]));
    const references = new Map<string, NonNullable<FrontierItem['explorationGroups']>>();
    const requested: ExplorationGroup[] = [];
    for (const proposal of proposals) {
      const key = hash({ proposal: proposal.key, scope: o.instanceScope, context: contextKey(o.context) });
      let group = groups.get(key);
      const members = new Map(proposal.actionIds.map(aid => {
        const a = byAction.get(aid); if (!a) throw new EngineError('INVALID_EXPLORATION_GROUP', 'Group refers to an absent action');
        return [keyOf(a), { key: keyOf(a), actionId: a.id, observationId: o.id, localId: a.localId, label: a.label, kind: a.kind, value: a.value, risk: a.risk, excluded: a.excluded }];
      }));
      // A known virtual list remains known when filtering leaves one or zero members.
      if (!group && members.size < 2) continue;
      const created = !group;
      group ??= { id: id(), sessionId: o.sessionId, key, proposalKey: proposal.key, kind: proposal.kind, label: proposal.label, membership: 'observed-action-cases', instanceScope: o.instanceScope,
        contextKey: contextKey(o.context), observationId: o.id, revision: 1, status: 'pending', evidence: proposal.evidence, members: [], decisions: [] };
      const existing = new Map(group.members.map(m => [m.key, m]));
      const added = [...members.keys()].filter(k => !existing.has(k));
      for (const [key, member] of members) existing.set(key, member);
      group.members = [...existing.values()]; group.observationId = o.id;
      if (!created && added.length) group.revision++;
      this.store.put('exploration-group', group); groups.set(key, group);
      for (const aid of [...proposal.actionIds, ...proposal.traversalActionIds]) {
        const action = byAction.get(aid); if (!action) throw new EngineError('INVALID_EXPLORATION_GROUP', 'Traversal refers to an absent action');
        const refs = references.get(aid) || [];
        refs.push({ groupId: group.id, ...(proposal.actionIds.includes(aid) ? { memberKey: keyOf(action) } : {}) }); references.set(aid, refs);
      }
      if (created) { requested.push(group); this.emit(o.sessionId, 'exploration.group_detected', group); }
      else if (added.length) this.emit(o.sessionId, 'exploration.group_updated', { groupId: group.id, revision: group.revision, observationId: o.id, addedMemberKeys: added });
    }
    return { references, requested };
  }

  apply(sessionId: string, items: FrontierItem[]) {
    const groups = new Map(this.store.list<ExplorationGroup>('exploration-group', sessionId).map(g => [g.id, g]));
    for (const item of items) {
      // Capability, risk, identity and reachability blockers retain their original reason.
      if (!['pending', 'deferred'].includes(item.status)) continue;
      const reasons = (item.explorationGroups || []).map(ref => {
        const decision = groups.get(ref.groupId)?.decisions.at(-1)?.decision;
        return !decision ? 'awaiting_list_decision' : decision.mode === 'defer' ? 'list_deferred_by_caller'
          : decision.mode === 'sample' && (!ref.memberKey || !decision.memberKeys.includes(ref.memberKey)) ? 'list_member_not_selected' : undefined;
      }).filter(Boolean);
      const reason = reasons.includes('awaiting_list_decision') ? 'awaiting_list_decision' : reasons[0];
      if (reason) { item.status = 'deferred'; item.reason = reason; item.unblock = 'Supply an exploration group decision; unexecuted members remain uncovered'; }
      else if (item.status === 'deferred') { item.status = 'pending'; item.reason = undefined; item.unblock = undefined; }
      else continue;
      this.store.put('frontier', item);
    }
  }

  decide(sessionId: string, groupId: string, revision: number, input: ExplorationGroupDecision) {
    const group = this.store.get<ExplorationGroup>('exploration-group', groupId);
    if (!group || group.sessionId !== sessionId) throw new EngineError('NOT_FOUND', 'Exploration group not found');
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
