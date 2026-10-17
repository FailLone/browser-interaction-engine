import { canonical, hash, type ActionAttempt, type ActionCandidate, type ExplorationCase } from '@interaction/core';
import { createOwnerDependencyCodec } from '@interaction/adapter-playwright';
import type { Control, Observation, OwnerDependencies, OwnerDependencyNode, OwnerDependencyReference, OwnerDependencyNativeRoot } from '@interaction/adapter-playwright';

/** Re-read revocable authority on every comparison. This callback grants neither
 * document equivalence nor execution permission; the reader proves conditions. */
export type RetainedCoverageAuthority = (action: ActionCandidate, observation: Observation, attempt: ActionAttempt, before: Observation) =>
  { source: ActionCandidate; target: ActionCandidate; evidence: string[]; reviewSource?: { observation: Observation; control: Control } } | undefined;
const policy = 'browser-document-coverage-v1';
const idrefs = new Set(['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'headers', 'list', 'form', 'popovertarget', 'commandfor']);
const formTags = new Set(['input', 'button', 'select', 'textarea', 'fieldset', 'output']);
const labelTags = new Set(['input', 'button', 'select', 'textarea', 'output', 'meter', 'progress']);
const sorted = (values: string[]) => [...values].sort();
const equalSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && canonical(sorted(a)) === canonical(sorted(b));
const selector = (c: Control) => c.checked != null || c.pressed != null || c.expanded != null || c.tag === 'select'
  || ['checkbox', 'radio', 'switch', 'tab', 'option', 'treeitem'].includes(c.role);
const record = (n: OwnerDependencyNode) => Object.hasOwn(n.attributes, 'data-row-key') || Object.hasOwn(n.attributes, 'data-item-key')
  || ['li', 'tr'].includes(n.tag) || ['row', 'listitem', 'treeitem', 'option'].includes(n.attributes.role);
const refKey = (r: OwnerDependencyReference) => canonical([r.sourceId, r.attribute, r.token]);
const knownContext = (o: Observation) => !!o.context && Object.values(o.context).every(v => v.status === 'known');
const owned = (a: ActionCandidate, o: Observation) => a.sessionId === o.sessionId && a.observationId === o.id && a.stateId === o.stateId;

interface GraphIndex {
  graph: OwnerDependencies;
  controls: Map<string, Control>;
  nodes: Map<string, OwnerDependencyNode>;
  roots: Map<string, OwnerDependencies['roots'][number]>;
  nativeRoots: Map<string, OwnerDependencyNativeRoot>;
  closures: Map<string, OwnerDependencies['closures'][number]>;
  references: Map<string, { value: OwnerDependencyReference; index: number }[]>;
  selectors: string[];
  inventory: string;
  projections: Map<string, string | undefined>;
}
function index(o: Observation, decode: ReturnType<typeof createOwnerDependencyCodec>['decode']): GraphIndex | undefined {
  const snapshot = o.ownerDependencies, compact = snapshot?.version === 'browser-owner-dependencies-v3';
  // Compact wire/expanded budgets are checked by the codec. Legacy evidence
  // retains its original raw representation and byte ceiling unchanged.
  const g = compact ? decode(snapshot) : snapshot;
  if (!g || !['browser-owner-dependencies-v1', 'browser-owner-dependencies-v2'].includes(g.version) || !g.inventoryComplete || g.documentId !== o.documentId || !g.baseURI) return;
  if (g.ancestry !== undefined && g.ancestry !== 'node-bounded-v1') return;
  const maximum = { nodes: compact ? 768 : 512, references: 64, bytes: compact ? 196608 : 131072, depth: 16 };
  if (!g.limits || Object.entries(maximum).some(([key, max]) => {
    const value = g.limits[key as keyof typeof maximum]; return !Number.isInteger(value) || value <= 0 || value > max;
  }) || g.nodes.length > g.limits.nodes || g.references.length > g.limits.references
    || !compact && Buffer.byteLength(JSON.stringify(g), 'utf8') > g.limits.bytes) return;
  const controls = new Map(o.controls.map(c => [c.localId, c])), nodes = new Map(g.nodes.map(n => [n.id, n]));
  const roots = new Map(g.roots.map(r => [r.localId, r])), closures = new Map(g.closures.map(c => [c.id, c]));
  if (controls.size !== o.controls.length || roots.size !== g.roots.length || nodes.size !== g.nodes.length || closures.size !== g.closures.length
    || new Set(o.controls.map(c => c.instanceId)).size !== o.controls.length || g.roots.length !== o.controls.length
    || o.controls.some(c => !c.localId || !c.instanceId || roots.get(c.localId)?.instanceId !== c.instanceId)
    || g.nodes.some(n => !n.id || !n.tag || !n.attributes || typeof n.parentId !== 'string')) return;
  const selectors = o.controls.filter(selector).map(c => c.localId);
  if (!equalSet(g.selectorIds, selectors)) return;
  const nativeRoots = new Map((g.nativeRoots || []).map(root => [root.instanceId, root]));
  if (g.version === 'browser-owner-dependencies-v2') {
    if (!Array.isArray(g.nativeInputIds) || !Array.isArray(g.nativeRoots) || g.nativeInputIds.some(id => !id)
      || nativeRoots.size !== g.nativeRoots.length || g.nativeInputIds.length > g.limits.nodes) return;
    const nativeControls = o.controls.filter(c => ['input', 'select', 'textarea'].includes(c.tag)).map(c => c.instanceId);
    if (!equalSet(g.nativeInputIds, [...nativeControls, ...nativeRoots.keys()])
      || !equalSet(g.nativeInputIds, g.nodes.filter(n => ['input', 'select', 'textarea'].includes(n.tag)).map(n => n.id))
      || [...nativeRoots.keys()].some(id => o.controls.some(c => c.instanceId === id))) return;
  } else if (g.nativeInputIds !== undefined || g.nativeRoots !== undefined) return;
  const references = new Map<string, { value: OwnerDependencyReference; index: number }[]>();
  g.references.forEach((value, index) => references.set(value.sourceId, [...(references.get(value.sourceId) || []), { value, index }]));
  return { graph: g, controls, nodes, roots, nativeRoots, closures, references, selectors,
    inventory: canonical(o.controls.map(c => [c.localId, c.instanceId]).sort((a, b) => canonical(a).localeCompare(canonical(b)))), projections: new Map() };
}

/** Reconstruct a required closure from raw edges. Ancestor-only nodes contribute
 * their own attributes and references, never children appended by another root. */
function rootProjection(i: GraphIndex, root: OwnerDependencyNativeRoot, instanceId: string, key: string): string | undefined {
  if (i.projections.has(key)) return i.projections.get(key);
  i.projections.set(key, undefined);
  if (!root.complete || root.reasons.length || root.instanceId !== instanceId) return;
  const closure = i.closures.get(root.closureId);
  if (!closure || !closure.complete || closure.reasons.length || closure.id !== root.ownerId || closure.subtreeId !== root.ownerId
    || !equalSet(closure.nodeIds, [...new Set(closure.nodeIds)]) || !equalSet(closure.subtreeIds, [...new Set(closure.subtreeIds)])
    || new Set(closure.referenceIds).size !== closure.referenceIds.length || !closure.nodeIds.includes(instanceId)) return;
  const allowed = new Set(closure.nodeIds), allowedRefs = new Set(closure.referenceIds);
  if (closure.nodeIds.some(id => !i.nodes.has(id)) || closure.referenceIds.some(n => !Number.isInteger(n) || n < 0 || !i.graph.references[n])) return;
  const members = new Set<string>(), subtrees = new Set<string>(), refs = new Set<number>(), expanded = new Set<string>(), visited = new Map<string, number>();
  let valid = true;
  const ancestry = (id: string) => {
    const result: OwnerDependencyNode[] = [], seen = new Set<string>();
    let node = i.nodes.get(id);
    while (node) {
      const maximum = i.graph.ancestry === 'node-bounded-v1' ? i.graph.limits.nodes : i.graph.limits.depth + 1;
      if (seen.has(node.id) || result.length >= maximum || !allowed.has(node.id)) { valid = false; break; }
      seen.add(node.id); result.push(node);
      if (!node.parentId) { if (node.tag !== 'html') valid = false; break; }
      node = i.nodes.get(node.parentId); if (!node) valid = false;
    }
    return result;
  };
  const targetChain = ancestry(instanceId), owner = targetChain.find(record) || targetChain[1] || targetChain[0];
  if (!valid || !owner || owner.id !== root.ownerId || ['body', 'html'].includes(owner.tag)) return;
  const ancestors = (id: string, depth: number) => { for (const node of ancestry(id).slice(1)) visit(node.id, false, depth); };
  const visit = (id: string, tree: boolean, depth: number) => {
    if (!valid) return;
    if (depth > i.graph.limits.depth || !allowed.has(id)) { valid = false; return; }
    const mode = tree ? 2 : 1; if ((visited.get(id) || 0) >= mode) return; visited.set(id, mode);
    const n = i.nodes.get(id);
    if (!n || !n.complete || n.reasons.length || ['iframe', 'object', 'embed'].includes(n.tag)) { valid = false; return; }
    members.add(id);
    const expected: { attribute: string; token: string; target?: string }[] = [];
    for (const [attribute, raw] of Object.entries(n.attributes)) {
      if (typeof raw !== 'string') { valid = false; return; }
      if (idrefs.has(attribute)) for (const token of new Set(raw.trim().split(/\s+/).filter(Boolean))) expected.push({ attribute, token });
    }
    if (formTags.has(n.tag)) {
      if (typeof n.associations?.formId !== 'string') { valid = false; return; }
      if (n.associations.formId) expected.push({ attribute: 'native:form', token: '', target: n.associations.formId });
    }
    if (labelTags.has(n.tag)) {
      const labels = n.associations?.labelIds;
      if (!Array.isArray(labels) || labels.some(id => !id) || new Set(labels).size !== labels.length) { valid = false; return; }
      for (const label of labels) expected.push({ attribute: 'native:label', token: label, target: label });
    }
    // Native property inventories must not turn omitted live state into equality.
    const liveKeys = [...(['input', 'textarea', 'select'].includes(n.tag) ? ['value'] : []),
      ...(n.tag === 'input' ? ['checked', 'indeterminate'] : []), ...(n.tag === 'option' ? ['selected'] : []),
      ...(['input', 'textarea'].includes(n.tag) ? ['readOnly'] : []), ...(['input', 'select'].includes(n.tag) ? ['multiple'] : []),
      ...(['input', 'textarea', 'select', 'button', 'option', 'fieldset'].includes(n.tag) ? ['disabled'] : [])];
    if (liveKeys.some(key => typeof n.live?.[key as keyof NonNullable<typeof n.live>] !== (key === 'value' ? 'string' : 'boolean'))) { valid = false; return; }
    const edges = i.references.get(id) || [];
    if (edges.length !== expected.length || new Set(edges.map(e => refKey(e.value))).size !== edges.length) { valid = false; return; }
    for (const e of expected) {
      const edge = edges.find(r => r.value.attribute === e.attribute && r.value.token === e.token);
      if (!edge || !allowedRefs.has(edge.index)) { valid = false; return; }
      const lookup = edge.value.lookup;
      if (lookup !== undefined && (!lookup || lookup.scope !== 'document-light-dom' || lookup.documentId !== i.graph.documentId
        || !Number.isInteger(lookup.matches) || lookup.matches < 0 || lookup.matches > 2
        || lookup.matches !== Math.min(2, edge.value.targetIds.length))) { valid = false; return; }
      // A zero result is a new producer assertion about a complete light-DOM
      // lookup, not an inference from this bounded node subset. Old missing
      // edges, native association targets and contradictory evidence fail shut.
      if (edge.value.status === 'missing' && lookup?.matches === 0 && !e.target && edge.value.targetIds.length === 0
        && !i.graph.nodes.some(n => n.attributes.id === e.token)) { refs.add(edge.index); continue; }
      if (edge.value.status !== 'unique' || edge.value.targetIds.length !== 1 || lookup && lookup.matches !== 1) { valid = false; return; }
      const target = i.nodes.get(edge.value.targetIds[0]);
      if (!target || e.target && target.id !== e.target || !e.target && (target.attributes.id !== e.token
        || i.graph.nodes.filter(n => n.attributes.id === e.token).length !== 1)
        || e.attribute === 'native:form' && target.tag !== 'form' || e.attribute === 'native:label' && target.tag !== 'label') { valid = false; return; }
      refs.add(edge.index); subtrees.add(target.id); visit(target.id, true, depth + 1); ancestors(target.id, depth + 1);
    }
    if (tree) {
      if (!n.childrenComplete || !Array.isArray(n.children)) { valid = false; return; }
      expanded.add(id); const childIds = new Set<string>();
      for (const child of n.children) {
        if ('nodeId' in child) {
          if (Object.keys(child).length !== 1 || !child.nodeId || childIds.has(child.nodeId) || i.nodes.get(child.nodeId)?.parentId !== id) { valid = false; return; }
          childIds.add(child.nodeId); visit(child.nodeId, true, depth + 1);
        } else if (typeof child.text !== 'string' || Object.keys(child).length !== 1) { valid = false; return; }
      }
    }
  };
  subtrees.add(owner.id); visit(owner.id, true, 0); ancestors(owner.id, 0);
  for (const node of ancestry(owner.id).slice(1).filter(record)) { subtrees.add(node.id); visit(node.id, true, 0); }
  if (!valid || !equalSet([...members], closure.nodeIds) || !equalSet([...subtrees], closure.subtreeIds)
    || refs.size !== allowedRefs.size || [...refs].some(id => !allowedRefs.has(id))) return;
  // Verify the parent chain of every subtree member, including leaves reached
  // through children, not just declared subtree roots and dependency targets.
  for (const id of members) ancestry(id);
  if (!valid) return;
  const projection = canonical({ owner: owner.id, subtreeIds: sorted([...subtrees]),
    ...(i.graph.ancestry ? { ancestry: i.graph.ancestry } : {}),
    nodes: sorted([...members]).map(id => {
      const n = i.nodes.get(id)!;
      return { id: n.id, parentId: n.parentId, tag: n.tag, attributes: n.attributes, live: n.live, resolved: n.resolved,
        associations: n.associations ? { ...n.associations, ...(n.associations.labelIds ? { labelIds: sorted(n.associations.labelIds) } : {}) } : undefined,
        ...(expanded.has(id) ? { children: n.children } : {}) };
    }), references: [...refs].map(id => i.graph.references[id]).sort((a, b) => refKey(a).localeCompare(refKey(b))) });
  i.projections.set(key, projection); return projection;
}
function closureProjection(i: GraphIndex, localId: string): string | undefined {
  const root = i.roots.get(localId), control = i.controls.get(localId);
  return root && control ? rootProjection(i, root, control.instanceId, `control:${localId}`) : undefined;
}
function nativeProjection(i: GraphIndex): string | undefined {
  if (i.graph.version === 'browser-owner-dependencies-v1') return canonical({ version: 1 });
  const roots: { instanceId: string; closure: string }[] = [];
  for (const instanceId of sorted([...i.nativeRoots.keys()])) {
    const closure = rootProjection(i, i.nativeRoots.get(instanceId)!, instanceId, `native:${instanceId}`);
    if (!closure) return;
    roots.push({ instanceId, closure });
  }
  return canonical({ version: 2, ids: sorted(i.graph.nativeInputIds!), roots });
}
function target(a: ActionCandidate, o: Observation, i: GraphIndex) {
  const c = a.localId && i.controls.get(a.localId);
  // Logical identity may be unresolved. This policy binds unique captured
  // instances and raw conditions only; readiness is still a prerequisite.
  if (!c || c.readiness || a.controlId !== undefined && a.controlId !== c.identityId
    || a.target && (a.target.kind !== 'instance' || a.target.instanceId !== c.instanceId || a.target.instanceScope !== o.instanceScope)) return;
  return c;
}
function conditions(o: Observation, i: GraphIndex, c: Control): string | undefined {
  const nativeInputs = nativeProjection(i); if (!nativeInputs) return;
  const required = new Set([c.localId, ...i.selectors, ...o.controls.filter(c => ['input', 'select', 'textarea'].includes(c.tag) || c.editable).map(c => c.localId)]);
  const components = o.components || [];
  const result: unknown[] = [];
  for (const localId of sorted([...required])) {
    const control = i.controls.get(localId)!;
    if (control.readiness) return;
    if (i.selectors.includes(localId)) {
      if (['checkbox', 'radio', 'switch'].includes(control.role) && typeof control.checked !== 'boolean') return;
      if (['tab', 'option'].includes(control.role) && !control.selected.length) {
        const node = i.nodes.get(control.instanceId), members = components.flatMap(c => c.members.filter(m => m.localId === localId && typeof m.selected === 'boolean'));
        const selected = node?.attributes['aria-selected'];
        if (selected !== 'true' && selected !== 'false' && !members.length || new Set(members.map(m => m.selected)).size > 1) return;
      }
    }
    const closure = closureProjection(i, localId); if (!closure) return;
    result.push({ control, closure });
  }
  return canonical({ baseURI: i.graph.baseURI, inventory: i.inventory, selectors: sorted(i.selectors), controls: result,
    ...(i.graph.version === 'browser-owner-dependencies-v2' ? { nativeInputs } : {}),
    // Component membership can supply explicit unselected state; retain the
    // whole captured membership, not a first matching boolean.
    components: [...components].sort((a, b) => a.id.localeCompare(b.id)), boundaries: o.boundaries || [] });
}
function actionConditions(a: ActionCandidate) {
  const basis = a.basis && { ...a.basis, evidence: a.basis.evidence.map(e => {
    if (!['reviewed-control/v1', 'reused-control-review/v1', 'declared-boundary-exit/v1'].includes(e.rule)) return e;
    const { observationId: _observation, sourceObservationId: _source, localId: _local, ...facts } = e.facts;
    return { ...e, facts };
  }) };
  return canonical({ kind: a.kind, value: a.value, label: a.label, basis, risk: a.risk,
    boundary: a.boundary, preconditions: a.preconditions, replayable: a.replayable });
}

/** Synchronous query-local memo only. Do not retain this reader across awaits,
 * mutable observation edits or review revisions. Authority is never memoized.
 * This policy is intentionally unavailable to target arrival and replay. */
export function documentCoverageReader(authority: RetainedCoverageAuthority) {
  const { decode } = createOwnerDependencyCodec();
  const indexes = new WeakMap<Observation, GraphIndex | undefined>();
  const samples = new WeakMap<Observation, Map<string, string | undefined>>();
  const read = (o: Observation) => { if (!indexes.has(o)) indexes.set(o, index(o, decode)); return indexes.get(o); };
  const sample = (o: Observation, i: GraphIndex, c: Control) => {
    let values = samples.get(o); if (!values) { values = new Map(); samples.set(o, values); }
    if (!values.has(c.localId)) values.set(c.localId, conditions(o, i, c)); return values.get(c.localId);
  };
  return (action: ActionCandidate, o: Observation, attempt: ActionAttempt, before: Observation, after: Observation): ExplorationCase | undefined => {
    try {
      // Legacy/no-graph reads reject before any review/ledger authority work.
      if (!o.ownerDependencies?.inventoryComplete || !before.ownerDependencies?.inventoryComplete
        || !o.documentId || !o.instanceScope || !o.navigation?.browserSessionId || !o.ruleVersion
        || attempt.status !== 'succeeded' || !attempt.afterId || attempt.afterId !== after.id || attempt.beforeId !== before.id
        || attempt.sessionId !== o.sessionId || !owned(action, o) || !owned(attempt.action, before)
        || [before, after].some(other => other.sessionId !== o.sessionId || other.documentId !== o.documentId || other.instanceScope !== o.instanceScope
          || other.navigation?.browserSessionId !== o.navigation!.browserSessionId)
        || [o, before, after].some(other => other.gaps.some(g => g.critical)) || o.url !== before.url || before.ruleVersion !== o.ruleVersion
        || !knownContext(o) || !knownContext(before) || canonical(o.context) !== canonical(before.context)
        || canonical(action.preconditions.context) !== canonical(o.context) || canonical(attempt.action.preconditions.context) !== canonical(before.context)
        || action.kind !== attempt.action.kind || canonical(action.value) !== canonical(attempt.action.value)) return;
      // Successful status alone does not bind the retained graph to the actual
      // dispatch: DOM owner facts may have changed after its before capture.
      const witness = after.ownerDependencyDispatch;
      if (!witness || witness.version !== 'browser-owner-dispatch-v1' || witness.sessionId !== attempt.sessionId
        || witness.beforeId !== before.id || witness.actionId !== attempt.action.id || witness.actionKey !== hash(attempt.action)
        || witness.graphKey !== hash(before.ownerDependencies) || witness.contextKey !== hash(before.context)
        || witness.documentId !== before.documentId || witness.instanceScope !== before.instanceScope
        || witness.browserSessionId !== before.navigation?.browserSessionId || witness.url !== before.url) return;
      const dispatchAt = Date.parse(witness.capturedAt), startedAt = Date.parse(attempt.startedAt), afterAt = Date.parse(after.capturedAt);
      if (![dispatchAt, startedAt, afterAt].every(Number.isFinite) || dispatchAt < startedAt || dispatchAt > afterAt) return;
      const current = read(o), source = read(before); if (!current || !source || current.inventory !== source.inventory) return;
      const c = target(action, o, current), old = target(attempt.action, before, source);
      if (!c || !old || c.instanceId !== old.instanceId) return;
      const expected = sample(before, source, old), actual = sample(o, current, c);
      if (!expected || actual !== expected) return;
      const granted = authority(action, o, attempt, before);
      if (!granted || !owned(granted.source, before) || !owned(granted.target, o) || granted.source.id !== attempt.action.id || granted.target.id !== action.id
        || granted.source.localId !== old.localId || granted.target.localId !== c.localId
        || !target(granted.source, before, source) || !target(granted.target, o, current)
        || granted.source.kind !== attempt.action.kind || granted.target.kind !== action.kind
        || canonical(granted.source.value) !== canonical(attempt.action.value) || canonical(granted.target.value) !== canonical(action.value)
        || granted.source.basis?.status !== 'supported' || granted.target.basis?.status !== 'supported'
        || granted.source.risk !== 'interface' || granted.target.risk !== 'interface' || actionConditions(granted.source) !== actionConditions(granted.target)) return;
      if (granted.reviewSource) {
        const { observation: review, control: reviewed } = granted.reviewSource;
        if (review.sessionId !== before.sessionId || review.documentId !== before.documentId || review.instanceScope !== before.instanceScope
          || review.navigation?.browserSessionId !== before.navigation?.browserSessionId || review.ruleVersion !== before.ruleVersion
          || review.url !== before.url || !knownContext(review) || canonical(review.context) !== canonical(before.context)
          || review.gaps.some(g => g.critical) || reviewed.instanceId !== old.instanceId || reviewed.readiness) return;
        const origin = read(review), retained = origin?.controls.get(reviewed.localId);
        if (!origin || !retained || canonical(retained) !== canonical(reviewed) || nativeProjection(origin) !== nativeProjection(source)
          || closureProjection(origin, reviewed.localId) !== closureProjection(source, old.localId)) return;
      } else if ([granted.source, granted.target].some(a => a.basis?.evidence.some(e =>
        ['reviewed-control/v1', 'reused-control-review/v1'].includes(e.rule)))) return;
      return { policy, key: hash({ policy, session: o.sessionId, browser: o.navigation.browserSessionId, document: o.documentId,
        instanceScope: o.instanceScope, url: o.url, rule: o.ruleVersion, context: o.context, conditions: actual, action: actionConditions(granted.target) }),
        evidence: [`actual-succeeded-attempt:${attempt.id}`, ...granted.evidence, 'same-document-complete-owner-dependencies',
          'all-captured-modes-and-native-inputs', 'coverage-only-not-identity-arrival-or-replay', 'undeclared-JavaScript-business-state-requires-context'] };
    } catch { return; }
  };
}
