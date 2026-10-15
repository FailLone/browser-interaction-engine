import { canonical, contextKey, type ExplorationGroup, type ExplorationGroupProposal } from '@interaction/core';
import type { ActionCandidate, Observation, Session } from './types.js';

export function listGroups(actions: ActionCandidate[], o: Observation, session: Session, known: ExplorationGroup[]): ExplorationGroupProposal[] {
  if (session.options.listExploration !== 'review') return [];
  const controls = new Map(o.controls.map(c => [c.localId, c]));
  const groups = new Map<string, ExplorationGroupProposal>();
  for (const action of actions) {
    const c = controls.get(action.localId || '');
    if (!c?.visible || !c.list || action.boundary?.intent === 'exit') continue;
    const selection = c.list.role === 'select' && action.kind === 'select';
    const option = c.list.role === 'listbox' && action.kind === 'click' && ['button', 'option'].includes(c.role);
    if (!selection && !option) continue;
    const basis = c.actionBasis?.[action.kind];
    const key = canonical({ owner: c.list, operation: action.kind, role: c.role, tag: c.tag, type: c.constraints.type,
      basis: basis?.status, submitsForm: basis?.evidence.some(e => e.facts.submitsForm === true), rules: basis?.evidence.map(e => [e.source, e.rule]) });
    let group = groups.get(key);
    if (!group) {
      group = { key, kind: 'similar-list', label: c.list.label || 'Similar list choices', actionIds: [],
        traversalActionIds: actions.filter(a => a.kind === 'scroll' && controls.get(a.localId || '')?.list?.instanceId === c.list!.instanceId).map(a => a.id),
        evidence: [{ source: 'adapter-playwright', rule: 'semantic-list-similarity/v1', facts: { observationId: o.id, ownerInstanceId: c.list.instanceId,
          ownerSelector: c.list.selector, ownerRole: c.list.role, operation: action.kind, memberRole: c.role, memberTag: c.tag,
          meaning: 'Same observed list owner and operation structure; business equivalence and total list size remain unverified' } }] };
      groups.set(key, group);
    }
    group.actionIds.push(action.id);
  }
  // A temporarily empty virtual window is not permission to enumerate the list.
  // Reuse only this document/context and the exact still-observed list owner.
  for (const previous of known) {
    if (previous.instanceScope !== o.instanceScope || previous.contextKey !== contextKey(o.context) || groups.has(previous.proposalKey)) continue;
    const owner = previous.evidence.find(e => e.rule === 'semantic-list-similarity/v1')?.facts.ownerInstanceId;
    const traversalActionIds = actions.filter(a => a.kind === 'scroll' && controls.get(a.localId || '')?.list?.instanceId === owner).map(a => a.id);
    if (typeof owner === 'string' && traversalActionIds.length) groups.set(previous.proposalKey, { key: previous.proposalKey, kind: previous.kind,
      label: previous.label, actionIds: [], traversalActionIds, evidence: previous.evidence });
  }
  return [...groups.values()];
}
