import type { Control, Observation } from '../../packages/adapter-playwright/src/types.js';

export type ModeStructureNode = NonNullable<Control['classificationBinding']>['nodes'][number];
export interface ModeStructureFixtureOptions {
  documentId?: string;
  records?: string[];
  reverse?: boolean;
  hypotheses?: boolean;
  duplicateBindings?: boolean;
}

/** Retained capture evidence only. Hidden modes deliberately have neither their
 * own classification subtree nor visible-only reviewReuseBinding ancestry. */
export function modeStructureFixture(options: ModeStructureFixtureOptions = {}) {
  const documentId = options.documentId ?? 'document-before';
  const records = [...(options.records ?? ['a', 'b'])];
  if (options.reverse) records.reverse();
  const instance = (name: string) => `${documentId}:${name}`;
  const control = (localId: string, tag: string, role: string, name: string, parent: string): Control => ({
    localId, instanceId: instance(localId), identityId: `identity:${localId}`, tag, role, name, label: name, stableKey: `id:${localId}`,
    region: 'document', form: '', selector: `#${localId}`, rect: { x: 0, y: 0, width: 100, height: 30 },
    visible: true, enabled: true, editable: false, readOnly: false, value: '', displayedText: name, checked: null, selected: [], pressed: null,
    expanded: null, controls: null, constraints: { type: tag, required: false, valid: true }, options: [], actions: [], discovery: [], actionBasis: {},
    actionable: { visible: true, enabled: true, editable: false, hitTarget: true, unknown: [] },
    reviewBinding: { parentInstanceId: instance(parent), attributes: {} },
  });
  const target = control('usd', 'div', 'generic', 'USD', 'converter');
  target.identityContext = { scope: 'converter', binding: 'usd', evidence: ['captured-owner'] };
  target.reviewBinding!.attributes = { id: 'usd' };
  target.reviewReuseBinding = { ancestors: [{ tag: 'main', selector: '#converter', attributes: { id: 'converter' }, label: 'Converter' }] };
  target.classificationBinding = { truncated: false, text: 'USD', nodes: [{ instanceId: target.instanceId,
    parentInstanceId: target.reviewBinding!.parentInstanceId, tag: target.tag, attributes: { id: 'usd' } }], references: [] };
  const owner = control('trade', 'div', 'generic', 'Trade', 'body');
  owner.identityContext = { scope: 'header', binding: 'trade', evidence: ['captured-owner'] };
  owner.reviewBinding!.attributes = { 'data-testid': 'trade-navigation' };
  const nodes: Record<string, ModeStructureNode> = {};
  const append = (name: string, parent: string, tag: string, attributes: Record<string, string> = {}) => {
    const node = { instanceId: instance(name), parentInstanceId: instance(parent), tag, attributes };
    nodes[name] = node;
    return node;
  };
  const tree = [append('trade', 'body', 'div', { 'data-testid': 'trade-navigation' }), append('list', 'trade', 'ul')];
  const modes: Record<string, Control> = {};
  for (const record of records) {
    const mode = control(`mode-${record}`, 'button', 'button', 'More', `row-${record}`);
    mode.stableKey = options.duplicateBindings === false ? `menu:more:${record}` : 'menu:more';
    if (options.hypotheses !== false) mode.hypothesisId = `pending-${record}`;
    mode.visible = false; mode.actionable.visible = false; mode.actionable.hitTarget = false;
    mode.expanded = false; mode.reviewBinding!.attributes = { 'aria-expanded': 'false' };
    modes[record] = mode;
    tree.push(append(`row-${record}`, 'list', 'li'), append(`mode-${record}`, `row-${record}`, 'button', { 'aria-expanded': 'false' }),
      append(`link-${record}`, `row-${record}`, 'a', { href: `/trade/${record}` }));
  }
  owner.classificationBinding = { nodes: tree, text: 'Trade More Spot More Futures BTC 67000', truncated: false, references: [] };
  const observation: Observation = {
    id: `observation-${documentId}`, sessionId: 'session', documentId, instanceScope: documentId, capturedAt: '2026-10-17T00:00:00.000Z',
    url: 'https://mode-structure.fixture.invalid/', title: 'Trade', text: 'BTC 67000', viewport: { width: 1200, height: 900 }, scroll: { x: 0, y: 0, maxY: 0 },
    ruleVersion: 'observable-v8', context: {}, stable: true, gaps: [], controls: [target, owner, ...Object.values(modes)],
    regions: [{ key: 'document', role: 'document', label: 'Document', selector:'body', rect:{x:0,y:0,width:1200,height:900},text:'Trade' }], components: [], boundaries: [], overlays: [],
    stateId: `state-${documentId}`, visitId: `visit-${documentId}`, canonical: `retained-${documentId}`, fingerprint: `retained-${documentId}`, cause: 'inspection',
  };
  return { observation, target, owner, modes, nodes };
}

export type ModeStructureFixture = ReturnType<typeof modeStructureFixture>;

/** Change both observed mode state and the complete retained tree consistently. */
export function setModeExpanded(fixture: ModeStructureFixture, record: string, expanded: boolean) {
  fixture.modes[record].expanded = expanded;
  fixture.modes[record].reviewBinding!.attributes['aria-expanded'] = String(expanded);
  fixture.nodes[`mode-${record}`].attributes['aria-expanded'] = String(expanded);
}

/** A navigation disclosure is scoped by captured native link destinations,
 * independently of the visible-list instance identity chosen by capture. */
export function navigationModeFixture(options: ModeStructureFixtureOptions & { instanceBound?: boolean; open?: boolean } = {}) {
  const f = modeStructureFixture(options), documentId = f.observation.documentId;
  f.owner.label = ''; f.owner.name = options.open ? 'Trade Spot Futures' : 'Trade';
  f.owner.reviewReuseBinding = { ancestors: [{ tag: 'nav', selector: 'nav', attributes: { 'aria-label': 'Main menu' }, label: 'Main menu' }] };
  const trigger: Control = { ...structuredClone(f.target), localId: 'trade-toggle', instanceId: `${documentId}:trade-toggle`,
    identityId: 'identity:trade-toggle', tag: 'button', role: 'button', name: 'Trade', label: '', stableKey: 'id:trade-toggle',
    expanded: !!options.open, constraints: { type: 'button', required: false, valid: true },
    identityContext: { scope: 'header', binding: 'trade-toggle', evidence: ['captured-owner'] },
    reviewBinding: { parentInstanceId: f.owner.instanceId, attributes: { type: 'button' } }, actions: ['click'],
    actionBasis: { click: { status: 'supported', evidence: [{ source: 'html', rule: 'native-button/v1', facts: { type: 'button', submitsForm: false } }] } } };
  delete trigger.classificationBinding; delete trigger.reviewReuseBinding;
  f.nodes.trigger = { instanceId: trigger.instanceId, parentInstanceId: f.owner.instanceId, tag: 'button',
    attributes: { id: 'trade-toggle', type: 'button', 'aria-expanded': String(trigger.expanded) } };
  f.owner.classificationBinding!.nodes.push(f.nodes.trigger); f.observation.controls.push(trigger);
  for (const [record, mode] of Object.entries(f.modes)) {
    mode.label = mode.name = 'Open sub-menu';
    mode.reviewBinding!.attributes['aria-label'] = mode.label; f.nodes[`mode-${record}`].attributes['aria-label'] = mode.label;
    if (options.instanceBound) { mode.identityScope = 'instance'; mode.stableKey = `record-instance:${documentId}:${record}`; delete mode.hypothesisId; }
    const node = f.nodes[`link-${record}`], link: Control = { ...structuredClone(f.target), tag: 'a', role: 'link', name: '', label: '',
      localId: `link-${record}`, instanceId: node.instanceId, stableKey: undefined,
      identityContext: { binding: JSON.stringify([['link-destination', `https://navigation.fixture.invalid/trade/${record}`, '']]), evidence: ['link-destination/v1'] },
      reviewBinding: { parentInstanceId: node.parentInstanceId, attributes: { ...node.attributes } } };
    delete link.classificationBinding; delete link.reviewReuseBinding; f.observation.controls.push(link);
  }
  return { ...f, trigger };
}
