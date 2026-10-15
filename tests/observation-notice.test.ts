import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ObservationNotice } from '../apps/ui/src/ObservationNotice.js';

it('explains a persisted stall even when the latest snapshot has no critical gaps', () => {
  const html = renderToStaticMarkup(createElement(ObservationNotice, { failures: { count: 3, kind: 'stale', observationIds: ['1','2','3'] }, exploration: 'controls' }));
  expect(html).toContain('连续观察未能推进');
  expect(html).toContain('重新观察或恢复探索不会清除失败计数');
  expect(renderToStaticMarkup(createElement(ObservationNotice, { exploration: 'controls' }))).toBe('');
});
