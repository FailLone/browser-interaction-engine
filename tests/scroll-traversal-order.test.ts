import { expect, it } from 'vitest';
import type { ActionAttempt, FrontierItem } from '@interaction/core';
import type { Observation } from '@interaction/browser';
import { continueScrollTraversal } from '../packages/browser/src/scroll-traversal.js';

function setup() {
  const before = { id: 'before', documentId: 'doc', instanceScope: 'instance', url: 'https://example.test/', context: {},
    boundaries: [], gaps: [], scroll: { x: 0, y: 1000, maxY: 2000 }, viewport: { width: 900, height: 600 }, controls: [] } as unknown as Observation;
  const after = { ...before, id: 'after', scroll: { ...before.scroll, y: 550 } };
  const current = { ...after, id: 'current' };
  const item = (id: string, kind: string, value?: number) => ({ id, action: { id, observationId: 'current', kind, value } }) as FrontierItem;
  const items = [item('forward', 'scroll', 450), item('new-control', 'click'), item('reverse', 'scroll', -450)];
  const attempt = { id: 'attempt', beforeId: 'before', afterId: 'after', status: 'succeeded', action: { kind: 'scroll', value: -450 } } as ActionAttempt;
  const lookup = (id: string) => id === 'before' ? before : id === 'after' ? after : undefined;
  return { before, after, current, items, attempt, lookup };
}

it('keeps new non-scroll work in place while continuing a verified reverse sweep', () => {
  const f = setup();
  expect(continueScrollTraversal(f.items, f.current, [f.attempt], f.lookup).map(i => i.id)).toEqual(['reverse', 'new-control', 'forward']);
  expect(f.items.map(i => i.id)).toEqual(['forward', 'new-control', 'reverse']);
  // Ordering cannot recreate an excluded or deferred direction absent from the
  // eligible input; normal gates and the caller choose hook still own permission.
  const eligible = f.items.slice(0, 2);
  expect(continueScrollTraversal(eligible, f.current, [f.attempt], f.lookup)).toEqual(eligible);
});

it.each(['failed', 'missing-evidence', 'new-document', 'new-context', 'new-boundary', 'displaced', 'resized', 'no-movement'] as const)('does not reuse a previous direction after %s', condition => {
  const f = setup();
  if (condition === 'failed') f.attempt.status = 'failed';
  if (condition === 'missing-evidence') f.attempt.afterId = 'expired';
  if (condition === 'new-document') f.current.documentId = 'new-doc';
  if (condition === 'new-context') f.current.context = { entity: { value: 'other', status: 'known', source: 'test' } };
  if (condition === 'new-boundary') f.current.boundaries = [{ key: 'dialog', name: 'Dialog', region: 'document', evidence: [] }];
  if (condition === 'displaced') f.current.scroll = { ...f.current.scroll, y: 800 };
  if (condition === 'resized') f.current.viewport = { ...f.current.viewport, height: 700 };
  if (condition === 'no-movement') f.before.scroll = { ...f.after.scroll };
  expect(continueScrollTraversal(f.items, f.current, [f.attempt], f.lookup)).toEqual(f.items);
});

function absoluteSetup() {
  const f = setup();
  const container = (top: number, nodeId = 'root') => ({ nodeId, selector: 'html', name: 'page', root: true,
    left: 0, top, width: 900, height: 600, maxLeft: 0, maxTop: 2000 });
  f.before.scrollContainers = [container(1000)];
  f.after.scrollContainers = [container(550)];
  f.current.scrollContainers = [container(550)];
  const value = (top: number, expectedTop = 550, containerNodeId = 'root') => ({ documentId: 'doc', containerNodeId,
    left: 0, top, expectedLeft: 0, expectedTop, width: 900, height: 600, maxLeft: 0, maxTop: 2000 });
  f.items[0].action = { ...f.items[0].action, source: 'scroll-traversal', value: value(1000) };
  f.items[2].action = { ...f.items[2].action, source: 'scroll-traversal', value: value(100) };
  f.attempt.action = { ...f.attempt.action, source: 'scroll-traversal', value: value(550, 1000) };
  return { ...f, container, value };
}

it('continues an absolute-coordinate page sweep using its observed root container', () => {
  const f = absoluteSetup();
  expect(continueScrollTraversal(f.items, f.current, [f.attempt], f.lookup).map(i => i.id)).toEqual(['reverse', 'new-control', 'forward']);
  expect(continueScrollTraversal(f.items.slice(0, 2), f.current, [f.attempt], f.lookup)).toEqual(f.items.slice(0, 2));
});

it('keeps distinct absolute containers in their own priority slots despite missing localIds', () => {
  const f = absoluteSetup();
  for (const o of [f.before, f.after, f.current]) o.scrollContainers!.push({ ...f.container(550, 'other'), root: false });
  const other = (id: string, top: number) => ({ ...f.items[0], id, action: { ...f.items[0].action, id, value: f.value(top, 550, 'other') } });
  const items = [f.items[0], other('other-forward', 1000), f.items[1], f.items[2], other('other-reverse', 100)];
  expect(continueScrollTraversal(items, f.current, [f.attempt], f.lookup).map(i => i.id))
    .toEqual(['reverse', 'other-forward', 'new-control', 'forward', 'other-reverse']);
});

it.each(['stale-candidate-position', 'stale-prior-position', 'wrong-document', 'missing-container', 'duplicate-container',
  'range-changed', 'prior-range-changed', 'opposite-displacement', 'wrong-boundary', 'invalid-destination', 'malformed-value', 'failed-latest'] as const)(
  'does not infer an absolute sweep from %s', condition => {
    const f = absoluteSetup();
    if (condition === 'stale-candidate-position') f.items[2].action.value = { ...f.value(100), expectedTop: 551 };
    if (condition === 'stale-prior-position') f.attempt.action.value = f.value(550, 1001);
    if (condition === 'wrong-document') f.items[2].action.value = { ...f.value(100), documentId: 'other-doc' };
    if (condition === 'missing-container') f.current.scrollContainers = [];
    if (condition === 'duplicate-container') f.current.scrollContainers!.push(f.container(550));
    if (condition === 'range-changed') f.current.scrollContainers![0].maxTop = 2100;
    if (condition === 'prior-range-changed') f.before.scrollContainers![0].maxTop = 2100;
    if (condition === 'opposite-displacement') f.attempt.action.value = f.value(1450, 1000);
    if (condition === 'wrong-boundary') f.current.scrollContainers![0].boundaryKey = 'other-overlay';
    if (condition === 'invalid-destination') f.items[2].action.value = f.value(-100);
    if (condition === 'malformed-value') f.items[2].action.value = { ...f.value(100), width: 0 };
    const attempts = condition === 'failed-latest' ? [f.attempt, { ...f.attempt, id: 'failed', status: 'failed' as const }] : [f.attempt];
    expect(continueScrollTraversal(f.items, f.current, attempts, f.lookup)).toEqual(f.items);
  });

it('does not mix inspection probes with automatic traversal direction evidence', () => {
  const f = absoluteSetup();
  f.attempt.action.source = 'external-probe';
  expect(continueScrollTraversal(f.items, f.current, [f.attempt], f.lookup)).toEqual(f.items);
});

it('supports absolute horizontal sweeps using actual left displacement', () => {
  const f = absoluteSetup();
  for (const o of [f.before, f.after, f.current]) {
    const c = o.scrollContainers![0]; c.left = c.top; c.top = 0; c.maxLeft = c.maxTop; c.maxTop = 0;
  }
  for (const a of [f.attempt.action, f.items[0].action, f.items[2].action]) {
    const v = a.value as ReturnType<typeof f.value>;
    a.value = { ...v, left: v.top, top: 0, expectedLeft: v.expectedTop, expectedTop: 0, maxLeft: 2000, maxTop: 0 };
  }
  expect(continueScrollTraversal(f.items, f.current, [f.attempt], f.lookup).map(i => i.id)).toEqual(['reverse', 'new-control', 'forward']);
});
