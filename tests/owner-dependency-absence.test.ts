import { expect, it } from 'vitest';
import { hash } from '@interaction/core';
import { createOwnerDependencyCodec } from '@interaction/adapter-playwright';
import type { ActionAttempt, ActionCandidate, Control, Observation, OwnerDependencies, OwnerDependencyNode } from '@interaction/browser';
import { documentCoverageReader } from '../packages/browser/src/document-coverage.js';

// Pure retained-evidence fixtures. They model the trusted producer's lookup and
// dispatch assertions; no synthetic graph is represented as a live-page receipt.
function fixture() {
  const control: Control = { localId: 'run', instanceId: 'run', identityId: 'identity:run', identityScope: 'instance',
    tag: 'button', role: 'button', name: 'Run', label: 'Run', region: 'main', form: '', selector: '#run',
    rect: { x: 1, y: 1, width: 20, height: 20 }, value: '', displayedText: 'Run', checked: null, selected: [], visible: true,
    enabled: true, editable: false, expanded: null, controls: null, constraints: { type: '', required: false, valid: true },
    options: [], actions: ['click'], discovery: [], actionable: { visible: true, enabled: true, editable: false, hitTarget: true, unknown: [] } };
  const nodes: OwnerDependencyNode[] = [node('html', 'html', ''), node('body', 'body', 'html'),
    { ...node('owner', 'section', 'body'), childrenComplete: true, children: [{ nodeId: 'run' }] },
    { ...node('run', 'button', 'owner'), attributes: { id: 'run', 'aria-controls': 'panel' }, childrenComplete: true,
      children: [{ text: 'Run' }], live: { disabled: false }, associations: { formId: '', labelIds: [] } }];
  const graph: OwnerDependencies = { version: 'browser-owner-dependencies-v2', documentId: 'document', baseURI: 'https://fixture.test/',
    selectorIds: [], inventoryComplete: true, nativeInputIds: [], nativeRoots: [],
    roots: [{ localId: 'run', instanceId: 'run', ownerId: 'owner', closureId: 'owner', complete: true, reasons: [] }],
    closures: [{ id: 'owner', subtreeId: 'owner', nodeIds: nodes.map(n => n.id), referenceIds: [0], subtreeIds: ['owner'], complete: true, reasons: [] }],
    nodes, references: [{ sourceId: 'run', attribute: 'aria-controls', token: 'panel', status: 'missing', targetIds: [],
      lookup: { scope: 'document-light-dom', documentId: 'document', matches: 0 } }],
    limits: { nodes: 512, references: 64, bytes: 131072, depth: 16 }, complete: true, reasons: [] };
  const before: Observation = { id: 'before', sessionId: 'session', stateId: 'state', visitId: 'visit', capturedAt: '2026-10-17T00:00:00Z',
    instanceScope: 'browser:document', documentId: 'document', navigation: { browserSessionId: 'browser', currentIndex: 0, entries: [] },
    url: 'https://fixture.test/', title: 'Fixture', text: 'Raw page', viewport: { width: 100, height: 100 }, scroll: { x: 0, y: 0, maxY: 0 },
    controls: [control], regions: [], context: {}, boundaries: [], gaps: [], stable: true, fingerprint: 'fingerprint', canonical: 'canonical',
    ruleVersion: 'observable-v7', cause: 'inspection', ownerDependencies: graph };
  const current = structuredClone(before); current.id = 'current';
  const after = structuredClone(before); after.id = 'after'; after.capturedAt = '2026-10-17T00:00:02Z'; after.controls = []; delete after.ownerDependencies;
  const action: ActionCandidate = { id: 'current-action', sessionId: 'session', observationId: current.id, stateId: 'state', localId: 'run', controlId: 'identity:run',
    kind: 'click', label: 'Run', preconditions: { context: {}, visible: true, enabled: true, identityResolved: false, targetResolved: true },
    target: { kind: 'instance', instanceScope: current.instanceScope!, instanceId: 'run', evidence: ['native'] },
    basis: { status: 'supported', evidence: [{ source: 'html', rule: 'button/v1', facts: {} }] }, replayable: false, risk: 'interface', source: 'native', excluded: false, sampleValidity: 'known' };
  const prior = { ...structuredClone(action), id: 'prior-action', observationId: before.id };
  const attempt: ActionAttempt = { id: 'receipt', sessionId: 'session', requestId: 'request', action: prior, beforeId: before.id, afterId: after.id,
    status: 'succeeded', startedAt: '2026-10-17T00:00:01Z', finishedAt: '2026-10-17T00:00:02Z', purpose: 'exploration' };
  const f = { before, current, after, action, attempt }; witness(f); return f;
}
function node(id: string, tag: string, parentId: string): OwnerDependencyNode {
  return { id, tag, parentId, attributes: {}, childrenComplete: false, complete: true, reasons: [] };
}
type F = ReturnType<typeof fixture>;
const graph = (o: Observation) => o.ownerDependencies as OwnerDependencies;
const get = (o: Observation, id: string) => graph(o).nodes.find(n => n.id === id)!;
function witness(f: F) {
  f.after.ownerDependencyDispatch = { version: 'browser-owner-dispatch-v1', sessionId: f.attempt.sessionId, beforeId: f.before.id,
    actionId: f.attempt.action.id, actionKey: hash(f.attempt.action), graphKey: hash(f.before.ownerDependencies), contextKey: hash(f.before.context),
    documentId: f.before.documentId, instanceScope: f.before.instanceScope!, browserSessionId: f.before.navigation!.browserSessionId,
    url: f.before.url, capturedAt: f.attempt.startedAt };
}
function both(f: F, mutate: (o: Observation) => void) { mutate(f.before); mutate(f.current); witness(f); }
const run = (f: F) => documentCoverageReader((action, _o, attempt) => ({ source: attempt.action, target: action, evidence: ['native-authority'] }))(
  f.action, f.current, f.attempt, f.before, f.after);
function panel(o: Observation) {
  const g = graph(o), edge = g.references[0]; edge.status = 'unique'; edge.targetIds = ['panel']; edge.lookup!.matches = 1;
  g.nodes.push({ ...node('panel', 'span', 'body'), attributes: { id: 'panel' }, childrenComplete: true, children: [{ text: 'Panel' }] });
  g.closures[0].nodeIds.push('panel'); g.closures[0].subtreeIds.push('panel');
}
function parents(o: Observation, count: number) {
  const g = graph(o); let parent = 'body';
  for (let i = 0; i < count; i++) { const id = `parent-${i}`; g.nodes.push(node(id, 'div', parent)); g.closures[0].nodeIds.push(id); parent = id; }
  get(o, 'owner').parentId = parent;
}

it('retains an explicit complete zero lookup as a negative fact with no invented target', () => {
  const f = fixture(), proof = run(f);
  expect(proof?.policy).toBe('browser-document-coverage-v1');
  expect(proof?.evidence).toContain('coverage-only-not-identity-arrival-or-replay');
  expect(graph(f.before).references[0].targetIds).toEqual([]);
});
it('normalizes compact evidence without changing a complete raw proof or its condition key', () => {
  const f = fixture(), raw = run(f)!; expect(raw).toBeDefined();
  const codec = createOwnerDependencyCodec();
  for (const o of [f.before, f.current]) {
    const compact = codec.encode(graph(o)); expect(compact?.version).toBe('browser-owner-dependencies-v3');
    o.ownerDependencies = compact!;
  }
  witness(f); expect(run(f)).toEqual(raw);
});
it('keeps the legacy raw byte ceiling while admitting codec-validated compact evidence within both limits', () => {
  const f = fixture(); both(f, o => {
    const g = graph(o); parents(o, 508); g.ancestry = 'node-bounded-v1';
    const longer = (id: string) => id.startsWith('parent-') ? 'captured-instance-prefix-'.repeat(4) + id : id;
    for (const n of g.nodes) { n.id = longer(n.id); n.parentId = longer(n.parentId); }
    g.closures[0].nodeIds = g.closures[0].nodeIds.map(longer);
  });
  expect(Buffer.byteLength(JSON.stringify(graph(f.before)))).toBeGreaterThan(graph(f.before).limits.bytes);
  expect(run(f)).toBeUndefined();
  const codec = createOwnerDependencyCodec();
  for (const o of [f.before, f.current]) {
    const compact = codec.encode(graph(o)); expect(compact).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(graph(o).limits.bytes);
    o.ownerDependencies = compact!;
  }
  witness(f); expect(run(f)).toBeDefined();
});
it('does not interpret an invalid compact envelope as a legacy graph', () => {
  const f = fixture(); both(f, o => { (graph(o) as unknown as { version: string }).version = 'browser-owner-dependencies-v3'; });
  expect(run(f)).toBeUndefined();
});
it.each(['legacy', 'wrong-document', 'shadow-scope', 'negative-count', 'fractional-count', 'false-count', 'target-contradiction', 'captured-id-contradiction', 'ambiguous', 'missing-edge'] as const)(
  'rejects unproved or contradictory zero lookups: %s', reason => {
    const f = fixture(); both(f, o => {
      const g = graph(o), edge = g.references[0];
      if (reason === 'legacy') delete edge.lookup;
      if (reason === 'wrong-document') edge.lookup!.documentId = 'foreign';
      if (reason === 'shadow-scope') (edge.lookup as unknown as { scope: string }).scope = 'shadow-root';
      if (reason === 'negative-count') edge.lookup!.matches = -1;
      if (reason === 'fractional-count') edge.lookup!.matches = 0.5;
      if (reason === 'false-count') edge.lookup!.matches = 1;
      if (reason === 'target-contradiction') edge.targetIds = ['invented'];
      if (reason === 'captured-id-contradiction') g.nodes.push({ ...node('outside-closure', 'span', 'body'), attributes: { id: 'panel' } });
      if (reason === 'ambiguous') { edge.status = 'ambiguous'; edge.targetIds = ['one', 'two']; edge.lookup!.matches = 2; }
      if (reason === 'missing-edge') { g.references = []; g.closures[0].referenceIds = []; }
    }); expect(run(f)).toBeUndefined();
  });
it.each(['appeared', 'deleted', 'duplicate'] as const)('invalidates retained coverage when an IDREF target is %s', change => {
  const f = fixture();
  if (change === 'deleted') { panel(f.before); witness(f); } else panel(f.current);
  if (change === 'duplicate') { const edge = graph(f.current).references[0]; edge.status = 'ambiguous'; edge.targetIds.push('duplicate'); edge.lookup!.matches = 2; }
  expect(run(f)).toBeUndefined();
});
it('binds the lookup declaration to dispatch and keeps new declarations in the condition key', () => {
  const f = fixture(); both(f, panel); const declared = run(f)!;
  both(f, o => { delete graph(o).references[0].lookup; }); const legacy = run(f)!;
  expect(legacy).toBeDefined(); expect(declared.key).not.toBe(legacy.key);
  graph(f.before).references[0].lookup = { scope: 'document-light-dom', documentId: 'document', matches: 1 };
  expect(run(f)).toBeUndefined(); // The producer's graph hash no longer matches.
});
it.each([40, 508])('walks %s ancestor-only nodes to html under the explicit node-bounded contract', count => {
  const f = fixture(); both(f, o => { parents(o, count); graph(o).ancestry = 'node-bounded-v1'; });
  expect(run(f)).toBeDefined();
  both(f, o => { delete graph(o).ancestry; }); expect(run(f)).toBeUndefined();
});
it('admits 513 through 768 compact nodes only with explicit expanded limits and preserves legacy ceilings', () => {
  const codec = createOwnerDependencyCodec();
  for (const count of [513, 640, 768]) {
    const f = fixture(); both(f, o => {
      const g = graph(o); parents(o, count - g.nodes.length); g.ancestry = 'node-bounded-v1';
      g.limits = { ...g.limits, nodes: 768, bytes: 196608 };
    });
    expect(run(f)).toBeUndefined(); // The same raw v2 graph never acquires larger ceilings.
    const rawV1 = structuredClone(f); both(rawV1, o => {
      const g = graph(o); g.version = 'browser-owner-dependencies-v1'; delete g.nativeInputIds; delete g.nativeRoots;
    });
    expect(run(rawV1)).toBeUndefined();
    for (const o of [f.before, f.current]) {
      const compact = codec.encode(graph(o)); expect(compact).toBeDefined(); o.ownerDependencies = compact!;
    }
    witness(f); expect(run(f)).toBeDefined();
    const oldLimits = structuredClone(f);
    for (const o of [oldLimits.before, oldLimits.current]) o.ownerDependencies!.limits = { nodes: 512, references: 64, bytes: 131072, depth: 16 };
    witness(oldLimits); expect(run(oldLimits)).toBeUndefined();
    const excessiveLimits = structuredClone(f);
    for (const o of [excessiveLimits.before, excessiveLimits.current]) o.ownerDependencies!.limits.nodes = 769;
    witness(excessiveLimits); expect(run(excessiveLimits)).toBeUndefined();
    if (count === 768) {
      // A 769th, otherwise valid ancestor cannot fit a declared 768-node graph.
      for (const o of [f.before, f.current]) {
        const wire = o.ownerDependencies!;
        if (wire.version !== 'browser-owner-dependencies-v3') throw Error('Expected compact fixture');
        const extra = wire.ids.length; wire.ids.push('extra-parent');
        const owner = wire.nodes.find(n => wire.ids[n[0]] === 'owner')!;
        const ancestor = structuredClone(wire.nodes.find(n => wire.ids[n[0]] === 'parent-0')!);
        ancestor[0] = extra; ancestor[1] = owner[1]; owner[1] = extra;
        wire.nodes.push(ancestor); wire.closures[0][2].push(extra);
      }
      witness(f); expect(run(f)).toBeUndefined();
    }
  }
});
it.each(['over-node-budget', 'cycle', 'missing-parent', 'outside-closure', 'non-html-root', 'unknown-profile'] as const)(
  'does not mistake incomplete ancestry for a complete chain: %s', reason => {
    const f = fixture(); both(f, o => {
      const g = graph(o); g.ancestry = 'node-bounded-v1'; parents(o, reason === 'over-node-budget' ? 509 : 40);
      if (reason === 'cycle') get(o, 'parent-0').parentId = 'parent-1';
      if (reason === 'missing-parent') get(o, 'parent-0').parentId = 'absent';
      if (reason === 'outside-closure') g.closures[0].nodeIds = g.closures[0].nodeIds.filter(id => id !== 'parent-0');
      if (reason === 'non-html-root') get(o, 'html').tag = 'div';
      if (reason === 'unknown-profile') (g as unknown as { ancestry: string }).ancestry = 'unbounded';
    }); expect(run(f)).toBeUndefined();
  });
it.each(['subtree', 'idref'] as const)('preserves the recursive depth limit for %s traversal even with long valid ancestry', kind => {
  const f = fixture(); both(f, o => {
    const g = graph(o); g.ancestry = 'node-bounded-v1'; parents(o, 40);
    let prior = kind === 'subtree' ? get(o, 'owner') : get(o, 'run');
    for (let i = 0; i < 17; i++) {
      const id = `deep-${i}`, next = { ...node(id, 'span', kind === 'subtree' ? prior.id : 'body'), attributes: { id }, childrenComplete: true, children: [] };
      g.nodes.push(next); g.closures[0].nodeIds.push(id);
      if (kind === 'subtree') prior.children = [...(prior.children || []), { nodeId: id }];
      else {
        prior.attributes['aria-describedby'] = id;
        g.closures[0].referenceIds.push(g.references.length); g.closures[0].subtreeIds.push(id);
        g.references.push({ sourceId: prior.id, attribute: 'aria-describedby', token: id, status: 'unique', targetIds: [id],
          lookup: { scope: 'document-light-dom', documentId: 'document', matches: 1 } });
      }
      prior = next;
    }
  }); expect(run(f)).toBeUndefined();
});
