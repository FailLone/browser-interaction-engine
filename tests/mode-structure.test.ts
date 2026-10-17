import { expect, it } from 'vitest';
import { hash } from '@interaction/core';
import { assessBrowserReviewBranchConditions, browserBranchConditions, browserReviewBranchConditions } from '../packages/adapter-playwright/src/branch-conditions.js';
import { modeStructureReader } from '../packages/adapter-playwright/src/mode-structure.js';
import { modeStructureFixture, setModeExpanded, type ModeStructureFixture } from './fixtures/mode-structure.js';

const conditions = (f: ModeStructureFixture) => browserReviewBranchConditions(f.target, f.observation);
const reference = (f: ModeStructureFixture, record = 'b') => modeStructureReader(f.observation)(f.modes[record]);

it('resolves same-name hidden mode references from distinct complete owner fragments without granting identity', () => {
  const f = modeStructureFixture(), retained = structuredClone(f.observation), read = modeStructureReader(f.observation);
  for (const mode of Object.values(f.modes)) {
    expect(mode.visible).toBe(false); expect(mode.classificationBinding).toBeUndefined(); expect(mode.reviewReuseBinding).toBeUndefined();
    expect(mode.hypothesisId).toBeTruthy();
  }
  expect(read(f.modes.a)).toMatchObject({ policy: 'selector-structural-reference/v1', ownerLocalId: 'trade', ownerNodes: 8, fragmentNodes: 3 });
  expect(read(f.modes.b)?.key).toBeTruthy(); expect(read(f.modes.b)?.key).not.toBe(read(f.modes.a)?.key);
  expect(conditions(f)).toMatchObject({ policy: 'browser-branch-conditions-v3' });
  expect(conditions(f)?.conditions).toHaveLength(2); expect(f.observation).toEqual(retained);
});

it('keeps references and complete branch conditions stable through document rebuild and sibling reordering', () => {
  const before = modeStructureFixture(), after = modeStructureFixture({ documentId: 'rebuilt-document', reverse: true });
  expect(after.owner.instanceId).not.toBe(before.owner.instanceId);
  expect(after.owner.classificationBinding!.nodes.map(n => n.instanceId)).not.toEqual(before.owner.classificationBinding!.nodes.map(n => n.instanceId));
  for (const record of ['a', 'b']) expect(reference(after, record)?.key).toBe(reference(before, record)?.key);
  expect(conditions(after)?.key).toBe(conditions(before)?.key);
});

it('preserves surviving B after A disappears while recording deleted and newly added modes in branch conditions', () => {
  const before = modeStructureFixture(), onlyB = modeStructureFixture({ records: ['b'] }), plusC = modeStructureFixture({ records: ['b', 'c'] });
  // A vanished rival must not make B's own name become a different anchor.
  for (const f of [before, onlyB, plusC]) for (const [record, mode] of Object.entries(f.modes)) {
    mode.reviewBinding!.attributes['aria-label'] = 'More'; f.nodes[`mode-${record}`].attributes['aria-label'] = 'More';
  }
  const b = reference(before)!.key;
  expect(reference(onlyB)?.key).toBe(b); expect(reference(plusC)?.key).toBe(b);
  expect(reference(onlyB)?.key).not.toBe(reference(before, 'a')?.key);
  expect(reference(plusC, 'c')?.key).not.toBe(b);
  expect(conditions(onlyB)?.conditions).toHaveLength(1); expect(conditions(plusC)?.conditions).toHaveLength(2);
  expect(conditions(onlyB)?.key).not.toBe(conditions(before)?.key); expect(conditions(plusC)?.key).not.toBe(conditions(onlyB)?.key);
});

it('retains A/B mode changes in branch conditions while keeping their structural references stable', () => {
  const before = modeStructureFixture(), changed = modeStructureFixture(); setModeExpanded(changed, 'b', true);
  for (const record of ['a', 'b']) expect(reference(changed, record)?.key).toBe(reference(before, record)?.key);
  expect(conditions(changed)?.key).not.toBe(conditions(before)?.key);
  expect(conditions(changed)?.conditions.map(c => c.state.expanded).sort()).toEqual([false, true]);
});

it('ignores passive price text in mode references while retaining raw evidence and semantic href changes', () => {
  const before = modeStructureFixture(), quote = modeStructureFixture();
  quote.observation.text = 'BTC 68001'; quote.owner.displayedText = 'Trade BTC 68001';
  quote.owner.classificationBinding!.text = 'Trade More Spot More Futures BTC 68001';
  expect(reference(quote)?.key).toBe(reference(before)?.key); expect(conditions(quote)?.key).toBe(conditions(before)?.key);
  expect(quote.owner.classificationBinding!.text).toContain('68001'); expect(quote.observation.text).toBe('BTC 68001');
  quote.nodes['link-b'].attributes.href = '/trade/options';
  expect(reference(quote)?.key).not.toBe(reference(before)?.key); expect(conditions(quote)?.key).not.toBe(conditions(before)?.key);
});

it('rejects a symmetric sibling rival instead of assigning a DOM-order identity', () => {
  const f = modeStructureFixture(); f.nodes['link-b'].attributes.href = f.nodes['link-a'].attributes.href;
  expect(reference(f, 'a')).toBeUndefined(); expect(reference(f, 'b')).toBeUndefined();
  expect(assessBrowserReviewBranchConditions(f.target, f.observation)).toMatchObject({ assessment: { status: 'unavailable', reason: 'selector_binding_duplicate' } });
});

it('requires a complete bounded owner tree and rejects broken node containment', () => {
  const mutations: [string, (f: ModeStructureFixture) => void][] = [
    ['missing tree', f => { delete f.owner.classificationBinding; }],
    ['truncated tree', f => { f.owner.classificationBinding!.truncated = true; }],
    ['missing parent', f => { f.nodes['link-a'].parentInstanceId = 'not-captured'; }],
    ['duplicate node', f => { f.owner.classificationBinding!.nodes.push(structuredClone(f.nodes['link-a'])); }],
    ['disconnected cycle', f => { f.nodes['row-a'].parentInstanceId = f.nodes['link-a'].instanceId; }],
    ['wrong target parent', f => { f.modes.b.reviewBinding!.parentInstanceId = 'different-parent'; }],
  ];
  for (const [reason, mutate] of mutations) {
    const f = modeStructureFixture(); mutate(f);
    expect(reference(f), reason).toBeUndefined(); expect(conditions(f), reason).toBeUndefined();
  }
});

it('counts an incomplete same-anchor owner rival rather than inventing a unique owner', () => {
  const f = modeStructureFixture(), rival = structuredClone(f.owner);
  rival.localId = 'trade-rival'; rival.instanceId = 'document-before:trade-rival'; delete rival.classificationBinding;
  f.observation.controls.push(rival);
  expect(reference(f)).toBeUndefined(); expect(conditions(f)).toBeUndefined();
});

it('keeps otherwise identical mode fragments under different semantic owners distinct', () => {
  const trade = modeStructureFixture(), wallet = modeStructureFixture();
  wallet.owner.name = wallet.owner.label = 'Wallet'; wallet.owner.stableKey = 'id:wallet'; wallet.owner.identityContext!.binding = 'wallet';
  expect(reference(wallet)?.key).toBeTruthy(); expect(reference(wallet)?.key).not.toBe(reference(trade)?.key);
});

it('changes the reference when the same mode moves between groups named only by sibling links', () => {
  const before = modeStructureFixture({ records: ['b'] }), after = modeStructureFixture({ records: ['b'] });
  for (const f of [before, after]) {
    const documentId = f.observation.documentId;
    for (const group of ['a', 'b']) {
      const parent = { instanceId: `${documentId}:group-${group}`, parentInstanceId: f.owner.instanceId, tag: 'div', attributes: {} };
      const label = { instanceId: `${documentId}:group-label-${group}`, parentInstanceId: parent.instanceId, tag: 'a', attributes: { href: `/group/${group}` } };
      f.owner.classificationBinding!.nodes.push(parent, label);
    }
    f.nodes.list.parentInstanceId = `${documentId}:group-a`;
  }
  after.nodes.list.parentInstanceId = `${after.observation.documentId}:group-b`;
  expect(reference(before)).toMatchObject({ fragmentNodes: 3 }); expect(reference(after)).toMatchObject({ fragmentNodes: 3 });
  expect(reference(after)?.key).not.toBe(reference(before)?.key); expect(conditions(after)?.key).not.toBe(conditions(before)?.key);
});

it('does not upgrade instance-only, unkeyed-record, or duplicate target evidence into portable references', () => {
  const mutations: [string, (f: ModeStructureFixture) => void][] = [
    ['instance-only', f => { f.modes.b.identityScope = 'instance'; }],
    ['unkeyed record', f => { f.modes.b.structuralItem = { ownerInstanceId: f.owner.instanceId, rowInstanceId: f.nodes['row-b'].instanceId, template: 'li', slot: 'button' }; }],
    ['duplicate instance', f => { f.observation.controls.push({ ...structuredClone(f.modes.b), localId: 'rival' }); }],
    ['duplicate local ID', f => { f.observation.controls.push({ ...structuredClone(f.modes.b), instanceId: 'other-document:mode-b' }); }],
  ];
  for (const [reason, mutate] of mutations) {
    const f = modeStructureFixture(); mutate(f); expect(reference(f), reason).toBeUndefined(); expect(conditions(f), reason).toBeUndefined();
  }
});

it('rejects unresolved IDREFs and inconsistent mode facts instead of silently stripping them', () => {
  const f = modeStructureFixture(); f.nodes['mode-b'].attributes['aria-controls'] = 'missing-panel';
  expect(reference(f)).toBeUndefined(); expect(conditions(f)).toBeUndefined();
  delete f.nodes['mode-b'].attributes['aria-controls']; f.nodes['mode-b'].attributes['aria-expanded'] = 'true';
  expect(reference(f)).toBeUndefined(); expect(conditions(f)).toBeUndefined();
});

it('preserves critical-gap, unstable-mode and missing-mode-state rejection after structural disambiguation', () => {
  const mutations: [string, (f: ModeStructureFixture) => void][] = [
    ['observation_critical_gap', f => { f.observation.gaps.push({ code: 'incomplete', message: 'capture missing', critical: true }); }],
    ['selector_unstable', f => { f.modes.b.readiness = { status: 'unstable', reason: 'moving' }; }],
    ['selector_state_missing', f => { f.modes.b.role = 'checkbox'; f.modes.b.checked = null; }],
  ];
  for (const [reason, mutate] of mutations) {
    const f = modeStructureFixture(); mutate(f);
    expect(assessBrowserReviewBranchConditions(f.target, f.observation), reason).toMatchObject({ assessment: { status: 'unavailable', reason } });
  }
});

it('keeps the v1 retained-key decoder unchanged and never enables its structural fallback', () => {
  const f = modeStructureFixture(), action = { kind: 'click', localId: f.target.localId };
  const legacy = browserBranchConditions(action, f.observation, 'v1');
  expect(legacy).toMatchObject({ policy: 'browser-branch-conditions-v1', conditions: [] });
  expect(legacy?.key).toBe(hash({ policy: 'browser-branch-conditions-v1', conditions: [] }));
  expect(browserBranchConditions(action, f.observation, 'v2')).toBeUndefined();
  for (const mode of Object.values(f.modes)) mode.visible = true;
  expect(browserBranchConditions(action, f.observation, 'v1')).toBeUndefined();
  expect(browserBranchConditions(action, f.observation, 'v2')).toBeUndefined();
  expect(conditions(f)?.policy).toBe('browser-branch-conditions-v3');
});

it('preserves successful v2 keys when semantic bindings already distinguish all modes', () => {
  const f = modeStructureFixture({ hypotheses: false, duplicateBindings: false });
  const before = conditions(f)!;
  expect(before.policy).toBe('browser-branch-conditions-v2');
  expect(before.key).toBe(hash({ policy: 'browser-branch-conditions-v2', conditions: before.conditions }));
  expect(browserBranchConditions({ kind: 'click', localId: f.target.localId }, f.observation, 'v2')?.key).toBe(before.key);
  delete f.owner.classificationBinding;
  expect(conditions(f)).toEqual(before);
  expect(browserBranchConditions({ kind: 'click', localId: f.target.localId }, f.observation, 'v2')?.key).toBe(before.key);
});
