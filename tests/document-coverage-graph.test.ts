import { expect, it, vi } from 'vitest';
import type { ActionAttempt, ActionCandidate, Control, Observation, OwnerDependencies, OwnerDependencyNode } from '@interaction/browser';
import { documentCoverageReader, type RetainedCoverageAuthority } from '../packages/browser/src/document-coverage.js';

const authority: RetainedCoverageAuthority = (action, _o, attempt) => ({ source: attempt.action, target: action, evidence: ['native-authority'] });
function node(id: string, tag: string, parentId: string, attributes: Record<string, string> = {}, children: OwnerDependencyNode['children'] = []): OwnerDependencyNode {
  return { id, tag, parentId, attributes, childrenComplete: true, children, complete: true, reasons: [],
    ...(['button', 'input'].includes(tag) ? { associations: { formId: '', labelIds: [] }, live: tag === 'button' ? { disabled: false }
      : { value: 'A', checked: false, indeterminate: false, readOnly: false, multiple: false, disabled: false } } : {}) };
}
function control(localId: string, tag: string, role: string): Control {
  return { localId, instanceId: localId, identityId: `identity:${localId}`, identityScope: 'instance', tag, role, name: localId, label: localId,
    region: 'main', form: '', selector: `#${localId}`, rect: { x: 1, y: 1, width: 20, height: 20 }, value: tag === 'input' ? 'A' : '', displayedText: localId,
    checked: null, selected: [], visible: true, enabled: true, editable: tag === 'input', expanded: null, controls: null,
    constraints: { type: tag === 'input' ? 'text' : '', required: false, valid: true }, options: [], actions: ['click'], discovery: [],
    actionable: { visible: true, enabled: true, editable: tag === 'input', hitTarget: true, unknown: [] } };
}
function fixture() {
  const controls = [control('run', 'button', 'button'), { ...control('mode', 'button', 'button'), expanded: false, visible: false }, control('field', 'input', 'textbox')];
  const nodes = [node('html', 'html', ''), node('body', 'body', 'html'), node('owner', 'section', 'body', { 'data-record': 'A' }, [{ nodeId: 'run' }, { nodeId: 'mode' }, { nodeId: 'field' }, { nodeId: 'link' }]),
    node('run', 'button', 'owner', { id: 'run' }, [{ text: 'Run' }]), node('mode', 'button', 'owner', { id: 'mode', 'aria-expanded': 'false' }),
    node('field', 'input', 'owner', { id: 'field' }), { ...node('link', 'a', 'owner', { href: '/record-A' }), resolved: { href: 'https://fixture.test/record-A' } }];
  nodes[0].childrenComplete = false; delete nodes[0].children; nodes[1].childrenComplete = false; delete nodes[1].children;
  const graph: OwnerDependencies = { version: 'browser-owner-dependencies-v1', documentId: 'document', baseURI: 'https://fixture.test/', selectorIds: ['mode'], inventoryComplete: true,
    roots: controls.map(c => ({ localId: c.localId, instanceId: c.instanceId, ownerId: 'owner', closureId: 'owner', complete: true, reasons: [] })),
    closures: [{ id: 'owner', subtreeId: 'owner', nodeIds: nodes.map(n => n.id).sort(), referenceIds: [], subtreeIds: ['owner'], complete: true, reasons: [] }],
    nodes, references: [], limits: { nodes: 512, references: 64, bytes: 131072, depth: 16 }, complete: true, reasons: [] };
  const before: Observation = { id: 'before', sessionId: 'session', stateId: 'state', visitId: 'visit', capturedAt: '2026-10-17T00:00:00Z',
    instanceScope: 'browser:document', documentId: 'document', navigation: { browserSessionId: 'browser', currentIndex: 0, entries: [] },
    url: 'https://fixture.test/', title: 'Fixture', text: 'Raw page', viewport: { width: 100, height: 100 }, scroll: { x: 0, y: 0, maxY: 0 },
    controls, regions: [], context: { account: { value: 'A', status: 'known', source: 'declared' } }, boundaries: [], gaps: [], stable: true,
    fingerprint: 'fingerprint', canonical: 'canonical', ruleVersion: 'observable-v7', cause: 'inspection', ownerDependencies: graph };
  const current = structuredClone(before); current.id = 'current';
  const after = structuredClone(before); after.id = 'after'; after.controls = []; delete after.ownerDependencies;
  const action: ActionCandidate = { id: 'current-action', sessionId: 'session', observationId: 'current', stateId: 'state', localId: 'run', controlId: 'identity:run',
    kind: 'click', label: 'run', preconditions: { context: current.context, visible: true, enabled: true, identityResolved: false, targetResolved: true },
    target: { kind: 'instance', instanceScope: current.instanceScope, instanceId: 'run', evidence: ['native'] },
    basis: { status: 'supported', evidence: [{ source: 'html', rule: 'button/v1', facts: {} }] }, replayable: false, risk: 'interface', source: 'native', excluded: false, sampleValidity: 'known' };
  const prior = structuredClone(action); prior.id = 'prior-action'; prior.observationId = before.id;
  const attempt: ActionAttempt = { id: 'receipt', sessionId: 'session', requestId: 'request', action: prior, beforeId: before.id, afterId: after.id,
    status: 'succeeded', startedAt: '2026-10-17T00:00:01Z', finishedAt: '2026-10-17T00:00:02Z', purpose: 'exploration' };
  return { before, current, after, action, attempt };
}
type F = ReturnType<typeof fixture>;
const run = (f: F, auth = authority) => documentCoverageReader(auth)(f.action, f.current, f.attempt, f.before, f.after);
const graph = (o: Observation) => o.ownerDependencies!;
const n = (o: Observation, id: string) => graph(o).nodes.find(n => n.id === id)!;
function both(f: F, change: (o: Observation) => void) { change(f.before); change(f.current); }
function reference(o: Observation) {
  n(o, 'run').attributes['aria-describedby'] = 'description';
  graph(o).nodes.push(node('description', 'span', 'body', { id: 'description' }, [{ text: 'Full dependency' }]));
  graph(o).references.push({ sourceId: 'run', attribute: 'aria-describedby', token: 'description', status: 'unique', targetIds: ['description'] });
  graph(o).closures[0].nodeIds.push('description'); graph(o).closures[0].referenceIds.push(0); graph(o).closures[0].subtreeIds.push('description');
}

it('returns coverage-only conditions for a real success even when the result removed the target and changed context/modes', () => {
  const f = fixture(); f.after.context.account.value = 'changed'; f.after.boundaries = [{ key: 'new', name: 'New', region: 'new', evidence: [] }];
  const saved = structuredClone(f), result = run(f)!;
  expect(result.policy).toBe('browser-document-coverage-v1'); expect(result.evidence).toContain('actual-succeeded-attempt:receipt'); expect(f).toEqual(saved);
  f.attempt.id = 'another-real-receipt'; expect(run(f)?.key).toBe(result.key);
});
it('canonicalizes graph index order and reference indexes while preserving DOM child order', () => {
  const f = fixture(); both(f, o => { reference(o); n(o, 'description').attributes['aria-controls'] = 'run'; graph(o).references.push({ sourceId: 'description', attribute: 'aria-controls', token: 'run', status: 'unique', targetIds: ['run'] }); graph(o).closures[0].referenceIds.push(1); graph(o).closures[0].subtreeIds.push('run'); }); const expected = run(f)!;
  expect(expected).toBeDefined();
  for (const o of [f.current]) { const g = graph(o); g.nodes.reverse(); g.roots.reverse(); g.closures.reverse(); g.selectorIds.reverse(); g.references.reverse(); g.closures[0].referenceIds = g.closures[0].referenceIds.map(id => g.references.length - 1 - id); g.closures[0].nodeIds.reverse(); g.closures[0].subtreeIds.reverse(); }
  expect(run(f)?.key).toBe(expected.key);
  n(f.current, 'owner').children!.reverse(); expect(run(f)).toBeUndefined();
});
it('does not import unrelated children later expanded on an ancestor by another root', () => {
  const f = fixture(); n(f.current, 'body').childrenComplete = true; n(f.current, 'body').children = [{ nodeId: 'owner' }, { text: 'Unrelated' }];
  expect(run(f)?.policy).toBe('browser-document-coverage-v1');
});
it('retains native empty associations and validates explicit label/form references', () => {
  const f = fixture(); both(f, o => {
    const g = graph(o); g.nodes.push(node('label', 'label', 'body', {}, [{ text: 'Field label' }])); n(o, 'field').associations!.labelIds = ['label'];
    g.references.push({ sourceId: 'field', attribute: 'native:label', token: 'label', status: 'unique', targetIds: ['label'] });
    g.closures[0].nodeIds.push('label'); g.closures[0].subtreeIds.push('label'); g.closures[0].referenceIds.push(0);
  });
  expect(run(f)).toBeDefined(); both(f, o => { graph(o).references = []; graph(o).closures[0].referenceIds = []; }); expect(run(f)).toBeUndefined();
});
it.each(['no-graph', 'inventory', 'browser', 'document', 'scope', 'session', 'rule', 'url', 'unknown-context', 'context', 'critical', 'boundary', 'state-owner', 'control-owner', 'target-owner', 'kind', 'value', 'risk', 'basis', 'unknown-receipt', 'after-owner', 'after-document', 'after-browser', 'after-critical'] as const)('rejects missing or different authority/conditions: %s', reason => {
  const f = fixture();
  if (reason === 'no-graph') delete f.current.ownerDependencies;
  if (reason === 'inventory') graph(f.current).inventoryComplete = false;
  if (reason === 'browser') delete f.current.navigation;
  if (reason === 'document') f.current.documentId = 'other';
  if (reason === 'scope') f.current.instanceScope = 'other';
  if (reason === 'session') f.current.sessionId = 'other';
  if (reason === 'rule') f.current.ruleVersion = 'observable-v6';
  if (reason === 'url') f.current.url = 'https://fixture.test/other';
  if (reason === 'unknown-context') f.current.context.account.status = 'unknown';
  if (reason === 'context') f.current.context.account.value = 'B';
  if (reason === 'critical') f.before.gaps.push({ code: 'MISSING', message: 'Missing', critical: true });
  if (reason === 'boundary') f.current.boundaries = [{ key: 'new', name: 'New', region: 'new', evidence: [] }];
  if (reason === 'state-owner') f.action.stateId = 'other';
  if (reason === 'control-owner') f.action.controlId = 'other';
  if (reason === 'target-owner') f.action.target!.instanceId = 'other';
  if (reason === 'kind') f.action.kind = 'check';
  if (reason === 'value') f.action.value = true;
  if (reason === 'risk') f.action.risk = 'unknown';
  if (reason === 'basis') f.action.basis!.evidence[0].facts.changed = true;
  if (reason === 'unknown-receipt') f.attempt.status = 'unknown';
  if (reason === 'after-owner') f.after.id = 'other';
  if (reason === 'after-document') f.after.documentId = 'other';
  if (reason === 'after-browser') f.after.navigation!.browserSessionId = 'other';
  if (reason === 'after-critical') f.after.gaps.push({ code: 'MISSING', message: 'Missing', critical: true });
  expect(run(f)).toBeUndefined();
});
it.each(['parent-record', 'sibling-href', 'text', 'native-value', 'target-value', 'checked', 'hidden-mode', 'new-control', 'replaced-instance', 'hypothesis', 'readiness'] as const)('retains raw nonlocal and target conditions: %s', reason => {
  const f = fixture();
  if (reason === 'parent-record') n(f.current, 'owner').attributes['data-record'] = 'B';
  if (reason === 'sibling-href') n(f.current, 'link').attributes.href = '/B';
  if (reason === 'text') n(f.current, 'run').children = [{ text: 'Changed' }];
  if (reason === 'native-value') n(f.current, 'field').live!.value = 'B';
  if (reason === 'target-value') f.current.controls[0].value = 'B';
  if (reason === 'checked') f.current.controls[0].checked = true;
  if (reason === 'hidden-mode') f.current.controls[1].expanded = true;
  if (reason === 'new-control') f.current.controls.push(control('new', 'button', 'button'));
  if (reason === 'replaced-instance') f.current.controls[0].instanceId = 'new';
  if (reason === 'hypothesis') f.current.controls[1].hypothesisId = 'pending';
  if (reason === 'readiness') f.current.controls[1].readiness = { status: 'unstable', reason: 'Pending' };
  expect(run(f)).toBeUndefined();
});
it.each(['missing-node', 'missing-child', 'missing-parent', 'parent-cycle', 'missing-subtree', 'false-children', 'duplicate-root', 'wrong-root', 'missing-selector', 'duplicate-instance', 'native-label-inventory', 'native-form-inventory', 'native-live', 'unknown-checkbox', 'unknown-tab', 'node-budget', 'byte-budget', 'depth-budget', 'future-version'] as const)('does not trust matching complete booleans over invalid raw evidence: %s', reason => {
  const f = fixture(); both(f, o => {
    const g = graph(o), closure = g.closures[0];
    if (reason === 'missing-node') closure.nodeIds = closure.nodeIds.filter(id => id !== 'link');
    if (reason === 'missing-child') g.nodes = g.nodes.filter(node => node.id !== 'link');
    if (reason === 'missing-parent') n(o, 'owner').parentId = 'absent';
    if (reason === 'parent-cycle') n(o, 'body').parentId = 'owner';
    if (reason === 'missing-subtree') closure.subtreeIds = [];
    if (reason === 'false-children') n(o, 'owner').childrenComplete = false;
    if (reason === 'duplicate-root') g.roots.push(g.roots[0]);
    if (reason === 'wrong-root') g.roots[0].ownerId = 'body';
    if (reason === 'missing-selector') g.selectorIds = [];
    if (reason === 'duplicate-instance') o.controls[1].instanceId = o.controls[0].instanceId;
    if (reason === 'native-label-inventory') delete n(o, 'field').associations!.labelIds;
    if (reason === 'native-form-inventory') delete n(o, 'field').associations!.formId;
    if (reason === 'native-live') delete n(o, 'field').live!.value;
    if (reason === 'unknown-checkbox') o.controls[1].role = 'checkbox';
    if (reason === 'unknown-tab') o.controls[1].role = 'tab';
    if (reason === 'node-budget') g.limits.nodes = 2;
    if (reason === 'byte-budget') g.limits.bytes = 2;
    if (reason === 'depth-budget') g.limits.depth = 1;
    if (reason === 'future-version') (g as { version: string }).version = 'future';
  }); expect(run(f)).toBeUndefined();
});
it.each(['missing-edge', 'duplicate-edge', 'ambiguous', 'missing-target', 'wrong-target-id', 'foreign-source', 'missing-member', 'missing-target-subtree'] as const)('validates every transitive IDREF edge: %s', reason => {
  const f = fixture(); both(f, o => {
    reference(o); const g = graph(o), closure = g.closures[0];
    if (reason === 'missing-edge') { g.references = []; closure.referenceIds = []; }
    if (reason === 'duplicate-edge') { g.references.push(g.references[0]); closure.referenceIds.push(1); }
    if (reason === 'ambiguous') g.references[0].status = 'ambiguous';
    if (reason === 'missing-target') g.references[0].targetIds = ['absent'];
    if (reason === 'wrong-target-id') n(o, 'description').attributes.id = 'wrong';
    if (reason === 'foreign-source') g.references[0].sourceId = 'field';
    if (reason === 'missing-member') closure.nodeIds = closure.nodeIds.filter(id => id !== 'description');
    if (reason === 'missing-target-subtree') closure.subtreeIds = ['owner'];
  }); expect(run(f)).toBeUndefined();
});
it('requires original review owner evidence and rejects owner rebinding', () => {
  const f = fixture(), review = structuredClone(f.before); review.id = 'review-source';
  const auth: RetainedCoverageAuthority = (a, _o, attempt) => ({ source: attempt.action, target: a, evidence: ['review-authority'], reviewSource: { observation: review, control: review.controls[0] } });
  expect(run(f, auth)).toBeDefined(); n(review, 'owner').attributes['data-record'] = 'old-record'; expect(run(f, auth)).toBeUndefined();
  delete review.ownerDependencies; expect(run(f, auth)).toBeUndefined();
});
it('rechecks authority each call and rejects legacy evidence before invoking the authority', () => {
  const f = fixture(), fn = vi.fn(authority), reader = documentCoverageReader(fn);
  expect(reader(f.action, f.current, f.attempt, f.before, f.after)).toBeDefined();
  fn.mockReturnValueOnce(undefined); expect(reader(f.action, f.current, f.attempt, f.before, f.after)).toBeUndefined(); expect(fn).toHaveBeenCalledTimes(2);
  delete f.current.ownerDependencies; expect(run(f, fn)).toBeUndefined(); expect(fn).toHaveBeenCalledTimes(2);
});
it('fresh queries reject edited same-ID raw material and never expose a shared mutable result', () => {
  const f = fixture(), reader = documentCoverageReader(authority), first = reader(f.action, f.current, f.attempt, f.before, f.after)!;
  first.evidence.push('caller mutation'); expect(reader(f.action, f.current, f.attempt, f.before, f.after)!.evidence).not.toContain('caller mutation');
  n(f.current, 'owner').attributes['data-record'] = 'B'; expect(run(f)).toBeUndefined();
});

it('checks the review-source target owner without imposing its unrelated global selector state', () => {
  const f = fixture(); both(f, o => {
    const g = graph(o); n(o, 'owner').children = n(o, 'owner').children!.filter(c => !('nodeId' in c) || c.nodeId !== 'mode');
    n(o, 'mode').parentId = 'mode-owner'; g.nodes.push(node('mode-owner', 'div', 'body', {}, [{ nodeId: 'mode' }]));
    g.closures[0].nodeIds = g.closures[0].nodeIds.filter(id => id !== 'mode');
    g.closures.push({ id: 'mode-owner', subtreeId: 'mode-owner', nodeIds: ['html', 'body', 'mode-owner', 'mode'], subtreeIds: ['mode-owner'], referenceIds: [], complete: true, reasons: [] });
    Object.assign(g.roots.find(r => r.localId === 'mode')!, { ownerId: 'mode-owner', closureId: 'mode-owner' });
  });
  const review = structuredClone(f.before); review.id = 'review'; review.controls[1].expanded = true; n(review, 'mode').attributes['aria-expanded'] = 'true';
  const auth: RetainedCoverageAuthority = (a, _o, attempt) => ({ source: attempt.action, target: a, evidence: ['review-authority'], reviewSource: { observation: review, control: review.controls[0] } });
  expect(run(f, auth)).toBeDefined();
  n(review, 'owner').attributes['data-record'] = 'changed'; expect(run(f, auth)).toBeUndefined();
});
it('compares legal prototype-named attributes as data', () => {
  const f = fixture(); both(f, o => { n(o, 'owner').attributes = JSON.parse('{"__proto__":"A"}'); });
  expect(run(f)).toBeDefined(); Object.defineProperty(n(f.current, 'owner').attributes, '__proto__', { value: 'B', enumerable: true }); expect(run(f)).toBeUndefined();
});
it('accepts explicit unselected component state and rejects conflicting or changed memberships', () => {
  const f = fixture(); both(f, o => { o.controls[1].role = 'tab'; o.components = [{ id: 'tabs', kind: 'tabs', name: 'Modes', rootNodeId: 'owner', rect: { x: 0, y: 0, width: 1, height: 1 }, members: [{ localId: 'mode', role: 'tab', selected: false }], basis: { status: 'supported', evidence: [] } }]; });
  expect(run(f)).toBeDefined(); f.current.components![0].members[0].selected = true; expect(run(f)).toBeUndefined();
});
