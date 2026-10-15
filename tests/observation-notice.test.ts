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

it('explains scoped failures without claiming that every observation is incomplete', () => {
  const html = renderToStaticMarkup(createElement(ObservationNotice, { exploration: 'controls', validationFailures: [{ scopeKey: 'form:1', count: 3, observationIds: ['1', '2', '3'], evidence: ['native-form-dependencies-changed'] }] }));
  expect(html).toContain('部分操作尚未就绪');
  expect(html).toContain('其他可独立验证的操作可以继续');
  expect(html).toContain('不会清除计数');
  expect(html).not.toContain('观察不完整');
});
