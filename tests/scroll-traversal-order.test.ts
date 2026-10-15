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
