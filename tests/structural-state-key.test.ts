import { expect, it } from 'vitest';
import { assignState, sameObservedState } from '@interaction/core';
import { observableCanonical, browserStateGrouping } from '../packages/adapter-playwright/src/model.js';
import { structuralStateKeys } from '../packages/adapter-playwright/src/structural-state-key.js';
import type { Control, Observation, RegionCandidate, Session } from '../packages/adapter-playwright/src/types.js';

// Complete captured exact/portable evidence, with no browser, server, provider
// or database. Node numbering deliberately changes as well as the document UUID.
function fixture(document = '00000000-1111-4111-8111-000000000001', offset = 0, owners = ['Chart']) {
  const node = (id: number) => `${document}:${id + offset}`;
  const pathNode = (tag: string, selector: string, attributes: Record<string, string> = {}) => ({ tag, selector, attributes, label: ['', ''] });
  const root = [pathNode('body', 'html > body'), pathNode('html', 'html')];
  const controls: Control[] = [], rawMembers: unknown[] = [], members: unknown[] = [];
  const ownerPaths: ReturnType<typeof pathNode>[][] = [];
  for (const [index, ownerLabel] of owners.entries()) {
    const base = 10 + index * 10, ownerId = node(base), rowId = node(base + 1), localId = node(base + 2);
    const ownerSelector = `section[aria-label="${ownerLabel}"]`;
    const owner = [pathNode('section', ownerSelector, { 'aria-label': ownerLabel }), ...root];
    const row = [pathNode('div', `${ownerSelector} > div:nth-of-type(1)`, { 'data-record': '1h' }), ...owner];
    const ancestry = [pathNode('div', `${ownerSelector} > div:nth-of-type(1) > div[role="tab"]`, { role: 'tab' }), ...row];
    const item = { ownerInstanceId: ownerId, rowInstanceId: rowId, recordKey: '["description","1h"]', template: 'tab-record', slot: '0' };
    const localKey = '["tab","1h","div"]';
    const control = { localId, instanceId: localId, identityId: `tab-${ownerLabel}`, identityScope: 'semantic', tag: 'div', role: 'tab',
      name: '1h', label: '1h', region: 'document', form: 'document', selector: ancestry[0].selector,
      stableKey: `structural-item:${JSON.stringify([ownerId, item.recordKey, localKey])}`, structuralItem: item,
      value: '', displayedText: '1h', checked: null, selected: ['1h'], visible: true, enabled: true, editable: false, expanded: null,
      constraints: { type: 'div', required: false, valid: true }, options: [], actions: ['click'],
      actionBasis: { click: { status: 'supported', evidence: [{ source: 'aria', rule: 'declared-activation/v1', facts: { role: 'tab' } }] } },
      actionable: { visible: true, enabled: true, editable: false, hitTarget: true, unknown: [] },
    } as unknown as Control;
    controls.push(control); ownerPaths.push(owner);
    rawMembers.push({ id: localId, stableKey: control.stableKey, structuralItem: structuredClone(item),
      ancestry: [`${localId}:DIV`, `${rowId}:DIV`, `${ownerId}:SECTION`, `${node(1)}:BODY`] });
    members.push({ ancestry, tag: control.tag, role: control.role,
      stableKey: { kind: 'structural-item', recordKey: item.recordKey, localKey },
      structural: { owner, row, recordKey: item.recordKey, template: item.template, slot: item.slot } });
  }
  const candidate = { id: node(1), label: 'Page', selector: 'html > body', controlIds: controls.map(c => c.localId), basis: 'document',
    rect: { x: 0, y: 0, width: 900, height: 800 }, evidence: [], binding: { members: rawMembers },
    reuseBinding: { version: 'region-structure-reuse/v2', members },
  } as unknown as RegionCandidate;
  const observation = { id: `observation-${document}`, sessionId: 'session', documentId: document, instanceScope: document,
    url: 'https://structural-state.fixture.invalid/', ruleVersion: 'observable-v8', stable: true, controls, context: {}, gaps: [], regions: [],
    scroll: { x: 0, y: 0, maxY: 0 }, overlays: [], regionCandidates: [candidate],
    components: [{ id: node(100), kind: 'tabs', name: 'Ranges', basis: { status: 'supported', evidence: [] },
      members: controls.map(c => ({ localId: c.localId, role: 'tab' })) }],
  } as unknown as Observation;
  return { observation, controls, candidate, rawMembers: rawMembers as any[], members: members as any[], ownerPaths };
}
const groupSession = { options: { exploration: 'controls' } } as Session;
const normalize = (o: Parameters<typeof assignState>[0]) => observableCanonical(o as Observation);
const current = () => fixture('00000000-2222-4222-8222-000000000002', 137);

it('replaces only proved document-local structural owners in strict state and component members', () => {
  const before = fixture(), after = current(), rawBefore = structuredClone(before.observation), rawAfter = structuredClone(after.observation);
  const oldKey = before.controls[0].stableKey!, newKey = after.controls[0].stableKey!;
  expect(oldKey).not.toBe(newKey);
  const projected = structuralStateKeys(before.observation).get(before.controls[0]); expect(projected).toMatch(/^structural-state-hash:v1:[a-f0-9]{64}$/);
  expect(observableCanonical(before.observation)).toBe(observableCanonical(after.observation));
  const parsed = JSON.parse(observableCanonical(before.observation));
  expect(parsed.controls[0].stableKey).toBe(projected); expect(parsed.components[0].members[0].stableKey).toBe(projected);
  expect(before.observation).toEqual(rawBefore); expect(after.observation).toEqual(rawAfter);
  const exactState = assignState(before.observation, [], normalize);
  expect(assignState(after.observation, [exactState], normalize).id).toBe(exactState.id);
  expect(sameObservedState(before.observation, after.observation)).toBe(true);
  const firstGroup = browserStateGrouping(before.observation, groupSession)!;
  const nextGroup = browserStateGrouping(after.observation, groupSession)!;
  expect(firstGroup.policy).toBe('browser-state-grouping-v2'); expect(nextGroup.canonical).toBe(firstGroup.canonical);
  const state = assignState(before.observation, [], normalize, firstGroup);
  expect(assignState(after.observation, [state], normalize, nextGroup).id).toBe(state.id);
});

it('distinguishes same-name records in different owners and does not transfer A to surviving B', () => {
  const both = fixture(undefined, 0, ['A', 'B']), next = fixture('new-document', 50, ['B']);
  const keys = structuralStateKeys(both.observation);
  expect(keys.size).toBe(2); expect(keys.get(both.controls[0])).not.toBe(keys.get(both.controls[1]));
  expect(structuralStateKeys(next.observation).get(next.controls[0])).toBe(keys.get(both.controls[1]));
  expect(observableCanonical(both.observation)).not.toBe(observableCanonical(next.observation));
  expect(browserStateGrouping(both.observation, groupSession)!.canonical).not.toBe(browserStateGrouping(next.observation, groupSession)!.canonical);
});

it.each(['missing proof', 'old proof', 'wrong owner pointer', 'broken containment', 'conflicting proof', 'duplicate slot', 'hypothesis'] as const)(
  'keeps exact instance keys when portable structural evidence has %s', change => {
    const left = fixture(), right = current();
    for (const f of [left, right]) {
      if (change === 'missing proof') delete f.candidate.reuseBinding;
      if (change === 'old proof') (f.candidate.reuseBinding as any).version = 'region-structure-reuse/v1';
      if (change === 'wrong owner pointer') f.rawMembers[0].ancestry[2] = 'unrelated:SECTION';
      if (change === 'broken containment') f.members[0].structural.owner = [{ tag: 'section', selector: '#another', attributes: {}, label: ['', ''] }, ...f.members[0].structural.owner.slice(1)];
      if (change === 'conflicting proof') {
        const rival = structuredClone(f.candidate); (rival.reuseBinding as any).members[0].ancestry[0].attributes.role = 'button';
        f.observation.regionCandidates!.push(rival);
      }
      if (change === 'duplicate slot') {
        const rival = structuredClone(f.controls[0]); rival.localId += '-duplicate'; rival.instanceId = rival.localId;
        f.controls.push(rival); f.candidate.controlIds.push(rival.localId);
        const exact = structuredClone(f.rawMembers[0]); exact.id = rival.instanceId; exact.ancestry[0] = `${rival.instanceId}:DIV`;
        f.rawMembers.push(exact); f.members.push(structuredClone(f.members[0]));
      }
      if (change === 'hypothesis') f.controls[0].hypothesisId = 'pending-identity';
      expect(structuralStateKeys(f.observation).size).toBe(0);
      expect(JSON.parse(observableCanonical(f.observation)).controls[0].stableKey).toBe(f.controls[0].stableKey);
    }
    expect(observableCanonical(left.observation)).not.toBe(observableCanonical(right.observation));
  },
);

it.each(['context', 'selected mode', 'editable input', 'record', 'owner meaning', 'list member', 'scroll extent'] as const)(
  'retains real %s differences in strict state and graph membership', change => {
    const left = fixture(), right = current();
    if (change === 'context') right.observation.context = { mode: { status: 'known', value: 'B', source: 'fixture' } };
    if (change === 'selected mode') right.controls[0].selected = ['24h'];
    if (change === 'editable input') { left.controls[0].editable = right.controls[0].editable = true; right.controls[0].value = 'B'; }
    if (change === 'record') {
      right.controls[0].structuralItem!.recordKey = '["description","24h"]';
      // An inconsistent retained proof cannot normalize a changed record either.
    }
    if (change === 'owner meaning') right.ownerPaths[0][0].attributes['aria-label'] = 'Another application context';
    if (change === 'list member') right.controls.push({ ...structuredClone(right.controls[0]), localId: 'new-member', instanceId: 'new-member', name: '24h', label: '24h' });
    if (change === 'scroll extent') right.observation.scrollContainers = [{ nodeId: 'scroll', selector: '#list', name: 'List', root: false, left: 0, top: 0, maxLeft: 2982, maxTop: 0, width: 900, height: 400 }];
    expect(observableCanonical(left.observation)).not.toBe(observableCanonical(right.observation));
    expect(browserStateGrouping(left.observation, groupSession)!.canonical).not.toBe(browserStateGrouping(right.observation, groupSession)!.canonical);
  },
);

it('retains exact dynamic prices and arbitrary page-declared UUIDs rather than erasing strings', () => {
  const left = fixture(), right = current();
  left.controls[0].displayedText = 'BTC 0.00001225'; right.controls[0].displayedText = 'BTC 0.00001224';
  expect(observableCanonical(left.observation)).not.toBe(observableCanonical(right.observation));
  expect(left.controls[0].displayedText).toBe('BTC 0.00001225'); expect(right.controls[0].displayedText).toBe('BTC 0.00001224');
  right.controls[0].displayedText = left.controls[0].displayedText;
  left.ownerPaths[0][0].attributes['data-tenant'] = '00000000-1111-4111-8111-000000000001';
  right.ownerPaths[0][0].attributes['data-tenant'] = '00000000-2222-4222-8222-000000000002';
  expect(observableCanonical(left.observation)).not.toBe(observableCanonical(right.observation));
});

it('preserves old encodings and refuses to merge old checkpoints with the new rule and grouping policy', () => {
  const old = fixture(), fresh = fixture(); old.observation.ruleVersion = 'observable-v7';
  const oldCanonical = observableCanonical(old.observation), parsed = JSON.parse(oldCanonical);
  expect(parsed.policy).toBeUndefined(); expect(parsed.controls[0].stableKey).toBe(old.controls[0].stableKey);
  expect(parsed.components[0].members[0].stableKey).toBe(old.controls[0].stableKey);
  const oldState = assignState(old.observation, [], normalize), stored = structuredClone(oldState);
  expect(assignState(fresh.observation, [oldState], normalize).id).not.toBe(oldState.id);
  expect(oldState).toEqual(stored); expect(old.observation.canonical).toBe(oldCanonical);
  expect(sameObservedState(old.observation, fresh.observation)).toBe(false);
  const oldGroup = browserStateGrouping(old.observation, groupSession)!; expect(oldGroup.policy).toBe('browser-state-grouping-v1');
  expect(browserStateGrouping(fresh.observation, groupSession)!.canonical).not.toBe(oldGroup.canonical);
  const { ruleVersion: _version, ...rawCapture } = fresh.observation;
  expect(observableCanonical(rawCapture)).toBe(observableCanonical(fresh.observation));
});
