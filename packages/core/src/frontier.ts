import type { ActionAttempt, FrontierCoverageGroup, FrontierItem, FrontierItemView } from './types.js';
import { hash } from './util.js';

export function describeFrontier(items: FrontierItem[], attempts: ActionAttempt[]): FrontierItemView[] {
  const byId = new Map(attempts.map(a => [a.id, a]));
  return items.map(item => {
    const lastId = item.attempts.at(-1);
    const executionStatus = lastId ? byId.get(lastId)?.status ?? 'unknown'
      : item.status === 'executed' ? 'succeeded'
      : item.status === 'unknown' || item.status === 'executing' ? 'unknown' : 'not_attempted';
    return { ...item, coverage: {
      // Unidentified targets must not collapse merely because their labels match.
      groupId: hash({ session: item.sessionId, control: item.action.controlId ?? item.id, kind: item.action.kind }),
      unit: item.action.kind === 'fill' ? 'input_sample' : 'action_case',
      executionStatus,
    } };
  });
}

export function groupFrontier(items: FrontierItemView[]): FrontierCoverageGroup[] {
  const groups = new Map<string, FrontierCoverageGroup>();
  for (const item of items) {
    const id = item.coverage.groupId;
    let group = groups.get(id);
    if (!group) {
      group = { id, controlId: item.action.controlId, kind: item.action.kind, label: item.action.label,
        coverageStatus: 'not_attempted', counts: { total: 0, executed: 0, blocked: 0, notAttempted: 0 }, items: [] };
      groups.set(id, group);
    }
    group.items.push(item); group.counts.total++;
    if (item.status === 'executed') group.counts.executed++;
    if (item.status === 'blocked') group.counts.blocked++;
    if (item.coverage.executionStatus === 'not_attempted') group.counts.notAttempted++;
  }
  for (const group of groups.values()) {
    const c = group.counts;
    group.coverageStatus = c.executed === c.total ? 'complete' : c.executed ? 'partial'
      : c.notAttempted === c.total ? 'not_attempted' : 'attempted';
  }
  return [...groups.values()];
}
