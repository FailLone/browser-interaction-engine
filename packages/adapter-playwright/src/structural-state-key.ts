import type { Control, Observation } from './types.js';
import { canonical, hash } from './util.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is Record<string, string> => record(value) && Object.values(value).every(v => typeof v === 'string');
type PathNode = { tag: string; selector: string; attributes: Record<string, string>; label: string[] };
function path(value: unknown): value is PathNode[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(node => record(node)
    && typeof node.tag === 'string' && !!node.tag && typeof node.selector === 'string' && !!node.selector
    && strings(node.attributes) && Array.isArray(node.label) && node.label.every(v => typeof v === 'string'))
    && value.at(-1).tag === 'html';
}
const tail = (child: PathNode[], parent: PathNode[]) => child.length >= parent.length
  && canonical(child.slice(child.length - parent.length)) === canonical(parent);

/** State representation only. The collector's v2 reusable-region evidence
 * proves owner/row selector uniqueness and containment in the captured DOM.
 * Verify its instance pointers and complete path chains before replacing the
 * redundant owner token. Missing or ambiguous evidence keeps the exact key.
 * This never establishes action/identity correspondence or replay permission.
 */
export function structuralStateKeys(o: Pick<Observation, 'controls' | 'regionCandidates'>): ReadonlyMap<Control, string> {
  const controls = new Map<string, Control[]>(), instances = new Map<string, number>();
  for (const control of o.controls) {
    const peers = controls.get(control.localId) || []; peers.push(control); controls.set(control.localId, peers);
    instances.set(control.instanceId, (instances.get(control.instanceId) || 0) + 1);
  }
  const proposed = new Map<Control, string>(), conflicts = new Set<Control>();
  for (const candidate of o.regionCandidates || []) {
    const raw = candidate.binding, reuse = candidate.reuseBinding;
    if (!record(raw) || !record(reuse) || reuse.version !== 'region-structure-reuse/v2'
      || !Array.isArray(raw.members) || !Array.isArray(reuse.members)
      || raw.members.length !== candidate.controlIds.length || reuse.members.length !== candidate.controlIds.length
      || new Set(candidate.controlIds).size !== candidate.controlIds.length) continue;
    for (let i = 0; i < candidate.controlIds.length; i++) {
      const peers = controls.get(candidate.controlIds[i]); if (peers?.length !== 1) continue;
      const control = peers[0], item = control.structuralItem;
      if (!item?.recordKey || !control.stableKey?.startsWith('structural-item:') || control.hypothesisId
        || control.identityScope === 'instance' || instances.get(control.instanceId) !== 1) continue;
      let parts: unknown;
      try { parts = JSON.parse(control.stableKey.slice('structural-item:'.length)); } catch { continue; }
      if (!Array.isArray(parts) || parts.length !== 3 || !parts.every(v => typeof v === 'string' && !!v)
        || parts[0] !== item.ownerInstanceId || parts[1] !== item.recordKey) continue;
      const captured = raw.members[i], member = reuse.members[i];
      if (!record(captured) || captured.id !== control.instanceId || captured.stableKey !== control.stableKey
        || !record(captured.structuralItem) || canonical(captured.structuralItem) !== canonical(item)
        || !record(member) || member.tag !== control.tag || member.role !== control.role
        || !record(member.stableKey) || member.stableKey.kind !== 'structural-item'
        || member.stableKey.recordKey !== item.recordKey || member.stableKey.localKey !== parts[2]
        || !record(member.structural) || member.structural.recordKey !== item.recordKey
        || member.structural.template !== item.template || member.structural.slot !== item.slot) continue;
      const { owner, row } = member.structural, ancestry = member.ancestry;
      if (!path(owner) || !path(row) || !path(ancestry) || !tail(row, owner) || !tail(ancestry, row)
        || ancestry[0].tag !== control.tag || ancestry[0].selector !== control.selector) continue;
      // The exact binding records node instances up to (but excluding) html;
      // the portable path records the same chain including html. Link the row
      // and owner to their precise positions, not merely matching path strings.
      const exact = captured.ancestry;
      if (!Array.isArray(exact) || exact.length !== ancestry.length - 1
        || !exact.every((node, at) => typeof node === 'string' && node.endsWith(`:${ancestry[at].tag.toUpperCase()}`))
        || exact[0] !== `${control.instanceId}:${control.tag.toUpperCase()}`
        || exact[ancestry.length - row.length] !== `${item.rowInstanceId}:${row[0].tag.toUpperCase()}`
        || exact[ancestry.length - owner.length] !== `${item.ownerInstanceId}:${owner[0].tag.toUpperCase()}`) continue;
      const facts = `structural-state:v1:${canonical({ owner, row, ancestry, recordKey: item.recordKey,
        template: item.template, slot: item.slot, localKey: parts[2] })}`;
      // Full exact/portable paths remain in the captured region evidence. Keep
      // only their versioned digest in each control and component state member.
      const key = `structural-state-hash:v1:${hash(facts)}`;
      if (proposed.has(control) && proposed.get(control) !== key) conflicts.add(control);
      else proposed.set(control, key);
    }
  }
  // Two captured controls with one portable slot remain ambiguous. Do not let
  // deletion of one occurrence silently establish continuity for the other.
  const counts = new Map<string, number>();
  for (const key of proposed.values()) counts.set(key, (counts.get(key) || 0) + 1);
  return new Map([...proposed].filter(([control, key]) => !conflicts.has(control) && counts.get(key) === 1));
}
