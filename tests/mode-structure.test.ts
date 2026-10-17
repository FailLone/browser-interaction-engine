import { expect, it } from 'vitest';
import { hash } from '@interaction/core';
import { assessBrowserReviewBranchConditions, browserBranchConditions, browserPortableBranchConditions, browserReviewBranchConditions } from '../packages/adapter-playwright/src/branch-conditions.js';
import { browserTargetConditions } from '../packages/adapter-playwright/src/target-arrival.js';
import { controlCase } from '../packages/adapter-playwright/src/exploration.js';
import { constrain } from '../packages/adapter-playwright/src/policy.js';
import { PlaywrightAdapter, type ActionCandidate, type Session } from '@interaction/browser';
import { modeStructureReader } from '../packages/adapter-playwright/src/mode-structure.js';
import { modeStructureFixture, navigationModeFixture, setModeExpanded, type ModeStructureFixture } from './fixtures/mode-structure.js';

const conditions = (f: ModeStructureFixture) => browserReviewBranchConditions(f.target, f.observation);
const reference = (f: ModeStructureFixture, record = 'b') => modeStructureReader(f.observation)(f.modes[record]);

it('resolves same-name hidden mode references from distinct complete owner fragments without granting identity', () => {
  const f = modeStructureFixture(), retained = structuredClone(f.observation), read = modeStructureReader(f.observation);
  for (const mode of Object.values(f.modes)) {
    expect(mode.visible).toBe(false); expect(mode.classificationBinding).toBeUndefined(); expect(mode.reviewReuseBinding).toBeUndefined();
    expect(mode.hypothesisId).toBeTruthy();
  }
  expect(read(f.modes.a)).toMatchObject({ policy: 'selector-structural-reference/v2', ownerLocalId: 'trade', ownerNodes: 8, fragmentNodes: 3 });
  expect(read(f.modes.b)?.key).toBeTruthy(); expect(read(f.modes.b)?.key).not.toBe(read(f.modes.a)?.key);
  expect(conditions(f)).toMatchObject({ policy: 'browser-branch-conditions-v4' });
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

it('retains captured ancestry outside the owner tree without using selectors as identity',()=>{
  const before=modeStructureFixture(),after=modeStructureFixture();
  before.owner.reviewReuseBinding={ancestors:[{tag:'nav',selector:'#before',attributes:{'aria-label':'Primary'},label:'Primary'}]};
  after.owner.reviewReuseBinding=structuredClone(before.owner.reviewReuseBinding);
  after.owner.reviewReuseBinding.ancestors[0].selector='#rebuilt-node';
  expect(reference(after)?.key).toBe(reference(before)?.key);
  after.owner.reviewReuseBinding.ancestors[0].attributes['aria-label']='Secondary';
  after.owner.reviewReuseBinding.ancestors[0].label='Secondary';
  expect(reference(after)?.key).not.toBe(reference(before)?.key);
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
  expect(conditions(f)?.policy).toBe('browser-branch-conditions-v4');
});

it('keeps operation v2 keys unchanged while review consistently prefers complete structural references', () => {
  const f = modeStructureFixture({ hypotheses: false, duplicateBindings: false });
  const action = { kind: 'click', localId: f.target.localId }, operation = browserBranchConditions(action, f.observation, 'v2')!;
  expect(operation.policy).toBe('browser-branch-conditions-v2');
  expect(operation.key).toBe(hash({ policy: 'browser-branch-conditions-v2', conditions: operation.conditions }));
  expect(conditions(f)?.policy).toBe('browser-branch-conditions-v4');
  const before = conditions(f);
  for (const mode of Object.values(f.modes)) { mode.stableKey = 'shared-key'; mode.hypothesisId = 'unresolved'; }
  expect(conditions(f)).toEqual(before);
  for (const [record, mode] of Object.entries(f.modes)) { mode.stableKey = `menu:more:${record}`; delete mode.hypothesisId; }
  delete f.owner.classificationBinding;
  expect(conditions(f)).toEqual(operation);
  expect(browserBranchConditions(action, f.observation, 'v2')).toEqual(operation);
});

it('compares navigation mode facts across visible-instance and hidden-unresolved captures without upgrading operation identity', () => {
  const before = navigationModeFixture({ instanceBound: true, open: true }), current = navigationModeFixture({ documentId: 'rebuilt', open: true });
  const retained = structuredClone(before.observation);
  for (const record of ['a', 'b']) expect(reference(current, record)?.key).toBe(reference(before, record)?.key);
  expect(conditions(current)).toEqual(conditions(before)); expect(conditions(before)?.conditions).toHaveLength(3);
  expect(before.modes.b.identityScope).toBe('instance'); expect(current.modes.b.hypothesisId).toBeTruthy();
  expect(browserBranchConditions({ kind: 'click', localId: before.target.localId }, before.observation, 'v2')).toBeUndefined();
  expect(before.observation).toEqual(retained);
});

it('separates the disclosure title from expanded owner text and still retains changed modes and titles', () => {
  const before = navigationModeFixture({ instanceBound: true, open: true }), closed = navigationModeFixture({ open: false });
  expect(reference(before)?.key).toBe(reference(closed)?.key);
  expect(conditions(before)?.key).not.toBe(conditions(closed)?.key);
  closed.trigger.expanded = true; closed.nodes.trigger.attributes['aria-expanded'] = 'true';
  expect(conditions(closed)?.key).toBe(conditions(before)?.key);
  closed.trigger.name = 'Wallet'; expect(reference(closed)?.key).not.toBe(reference(before)?.key);
});

it.each(['checkbox', 'pressed', 'unkeyed-record', 'outside-navigation', 'outer-record', 'nested-business-record', 'no-link-proof', 'missing-rival-proof', 'multi-link-rival', 'competing-destination', 'fragment-link', 'script-link', 'multiple-direct-links', 'nested-only-link', 'nested-title-record', 'instance-owner'])(
  'refuses instance mode portability when navigation proof is %s', reason => {
    const f = navigationModeFixture({ instanceBound: true }), mode = f.modes.b;
    const link = f.observation.controls.find(c => c.localId === 'link-b')!;
    if (reason === 'checkbox') { mode.role = 'checkbox'; mode.checked = false; }
    if (reason === 'pressed') mode.pressed = false;
    if (reason === 'unkeyed-record') mode.structuralItem = { ownerInstanceId: f.owner.instanceId, rowInstanceId: f.nodes['row-b'].instanceId, slot: 'button', template: 'li' };
    if (reason === 'outside-navigation') f.owner.reviewReuseBinding!.ancestors[0].tag = 'main';
    if (reason === 'outer-record') f.owner.reviewReuseBinding!.ancestors.push({ tag: 'li', selector: 'li', attributes: {}, label: '' });
    if (reason === 'no-link-proof') delete link.identityContext;
    if (reason === 'missing-rival-proof') delete f.observation.controls.find(c => c.localId === 'link-a')!.identityContext;
    if (reason === 'multi-link-rival') {
      const rival = { ...structuredClone(link), localId: 'rival-link', instanceId: 'rival-link',
        reviewBinding: { ...link.reviewBinding!, parentInstanceId: f.nodes['row-a'].instanceId } };
      f.observation.controls.push(rival);
      f.owner.classificationBinding!.nodes.push({ ...f.nodes['link-b'], instanceId: rival.instanceId, parentInstanceId: rival.reviewBinding.parentInstanceId });
    }
    if (reason === 'nested-business-record') {
      const node = { instanceId: 'business-record', parentInstanceId: f.nodes['row-b'].instanceId, tag: 'div', attributes: { 'data-item-key': 'A' } };
      f.owner.classificationBinding!.nodes.push(node); f.nodes['mode-b'].parentInstanceId = mode.reviewBinding!.parentInstanceId = node.instanceId;
    }
    if (reason === 'competing-destination') link.identityContext = structuredClone(f.observation.controls.find(c => c.localId === 'link-a')!.identityContext);
    if (reason === 'fragment-link') link.reviewBinding!.attributes.href = f.nodes['link-b'].attributes.href = '#panel';
    if (reason === 'script-link') link.identityContext!.binding = JSON.stringify([['link-destination', 'javascript:void(0)', '']]);
    if (reason === 'multiple-direct-links') f.owner.classificationBinding!.nodes.push({ ...f.nodes['link-b'], instanceId: 'other-link' });
    if (reason === 'nested-only-link') {
      const wrapper = { instanceId: 'wrapper', parentInstanceId: f.nodes['row-b'].instanceId, tag: 'div', attributes: {} };
      f.owner.classificationBinding!.nodes.push(wrapper); f.nodes['link-b'].parentInstanceId = link.reviewBinding!.parentInstanceId = wrapper.instanceId;
    }
    if (reason === 'nested-title-record') f.owner.classificationBinding!.nodes.push({ instanceId: 'title-record', parentInstanceId: f.trigger.instanceId, tag: 'li', attributes: {} });
    if (reason === 'instance-owner') f.owner.identityScope = 'instance';
    expect(reference(f)).toBeUndefined(); expect(conditions(f)).toBeUndefined();
  });

it('retains captured link baseURI resolution, query, hash and destination changes without inventing page-relative resolution', () => {
  const before = navigationModeFixture({ instanceBound: true }), current = navigationModeFixture();
  const link = current.observation.controls.find(c => c.localId === 'link-b')!;
  link.identityContext!.binding = JSON.stringify([['link-destination', 'https://different-base.invalid/trade/b?mode=B#panel', '']]);
  expect(current.nodes['link-b'].attributes.href).toBe(before.nodes['link-b'].attributes.href);
  expect(reference(current)?.key).not.toBe(reference(before)?.key);
  expect(conditions(current)?.key).not.toBe(conditions(before)?.key);
});

it('uses portable state prerequisites for resolved operations without granting instance targets replay rights or merging A/B', () => {
  const before = navigationModeFixture({ instanceBound: true }), current = navigationModeFixture({ documentId: 'rebuilt' });
  const action = (f: ReturnType<typeof navigationModeFixture>, target = f.trigger): ActionCandidate => ({ id: 'action', sessionId: f.observation.sessionId,
    observationId: f.observation.id, stateId: f.observation.stateId, controlId: target.identityId, localId: target.localId,
    kind: 'click', label: target.name, risk: 'interface', replayable: true, excluded: false, sampleValidity: 'known', source: 'fixture',
    basis: { status: 'supported', evidence: [{ source: 'html', rule: 'native-button/v1', facts: { submitsForm: false } }] },
    preconditions: { context: {}, visible: true, enabled: true, identityResolved: true } });
  const a = action(before), b = action(current);
  expect(browserPortableBranchConditions(a, before.observation)?.key).toBe(browserPortableBranchConditions(b, current.observation)?.key);
  expect(browserTargetConditions(a, before.observation)?.key).toBeTruthy();
  expect(browserTargetConditions(a, before.observation)?.key).toBe(browserTargetConditions(b, current.observation)?.key);
  expect(controlCase(a, before.observation, true)?.key).toBeTruthy();
  expect(controlCase(a, before.observation, true)?.key).toBe(controlCase(b, current.observation, true)?.key);
  setModeExpanded(current, 'b', true);
  expect(browserTargetConditions(a, before.observation)?.key).not.toBe(browserTargetConditions(b, current.observation)?.key);
  expect(controlCase(a, before.observation, true)?.key).not.toBe(controlCase(b, current.observation, true)?.key);
  const instanceAction = action(before, before.modes.b);
  expect(browserPortableBranchConditions(instanceAction, before.observation)).toBeUndefined();
  expect(browserTargetConditions(instanceAction, before.observation)).toBeUndefined();
  expect(controlCase(instanceAction, before.observation, true)).toBeUndefined();
  const session = { options: new PlaywrightAdapter().parseOptions({ url: before.observation.url, exploration: 'controls' }) } as Session;
  expect(constrain(instanceAction, before.observation, session)).toMatchObject({ replayable: false, target: { kind: 'instance' } });
});
