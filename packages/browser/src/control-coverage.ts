import { hash, type ActionAttempt, type ActionKind, type Observation } from '@interaction/adapter-playwright';

export interface ControlCoverageItem {
  id: string; label: string; role: string; target: 'logical' | 'instance';
  controlIds: string[]; observationIds: string[];
  classification: 'actionable' | 'read_only' | 'unconfirmed';
  status: 'covered' | 'incomplete' | 'observed_only';
  operations: { kind: ActionKind; succeeded: boolean; attemptIds: string[] }[];
}
export interface ControlCoverage {
  unit: 'encountered_control_operations';
  counts: { actionable: number; covered: number; incomplete: number; readOnly: number; unconfirmed: number };
  items: ControlCoverageItem[];
  limitation: string;
}

/** Read-only audit, independent of scheduling statuses and traversal work. */
export function describeControlCoverage(observations: Observation[], attempts: ActionAttempt[]): ControlCoverage {
  const groups = new Map<string, ControlCoverageItem>();
  const occurrences = new Map<string, ControlCoverageItem>();
  for (const o of observations) for (const c of o.controls.filter(c => c.visible)) {
    const instance = `${o.instanceScope}:${c.instanceId}`;
    const logical = !!c.identityId && !c.hypothesisId && !c.readOnly;
    const key = logical ? `identity:${c.identityId}` : `instance:${instance}`;
    const kinds = c.actions.filter(kind => c.actionBasis?.[kind]?.status === 'supported' && !(c.readOnly && kind === 'fill'));
    let item = groups.get(key);
    if (!item) {
      item = { id: hash(key), label: c.name, role: c.role, target: logical ? 'logical' : 'instance', controlIds: [], observationIds: [],
        classification: kinds.length ? 'actionable' : c.readOnly ? 'read_only' : 'unconfirmed', status: 'observed_only', operations: [] };
      groups.set(key, item);
    }
    if (c.identityId && !item.controlIds.includes(c.identityId)) item.controlIds.push(c.identityId);
    if (!item.observationIds.includes(o.id)) item.observationIds.push(o.id);
    for (const kind of kinds) if (!item.operations.some(op => op.kind === kind)) item.operations.push({ kind, succeeded: false, attemptIds: [] });
    if (item.operations.length) item.classification = 'actionable';
    occurrences.set(`${o.id}:${c.localId}`, item);
  }
  for (const a of attempts) {
    const op = occurrences.get(`${a.beforeId}:${a.action.localId}`)?.operations.find(op => op.kind === a.action.kind);
    if (op) { op.attemptIds.push(a.id); op.succeeded ||= a.status === 'succeeded'; }
  }
  const items = [...groups.values()];
  for (const item of items) item.status = item.classification !== 'actionable' ? 'observed_only'
    : item.operations.every(op => op.succeeded) ? 'covered' : 'incomplete';
  return { unit: 'encountered_control_operations', items,
    counts: { actionable: items.filter(i => i.classification === 'actionable').length, covered: items.filter(i => i.status === 'covered').length,
      incomplete: items.filter(i => i.status === 'incomplete').length, readOnly: items.filter(i => i.classification === 'read_only').length,
      unconfirmed: items.filter(i => i.classification === 'unconfirmed').length },
    limitation: 'Successful execution of each supported operation on encountered controls; not every value/state combination, business assertion, or undiscovered control. Read-only elements and unconfirmed operation hints are reported separately.' };
}
