import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ObligationAuditSummary} from '../packages/explorer-plugin/src/ui.js';
import type {ObligationProjection} from '../packages/explorer-plugin/src/obligation-lifecycle.js';

it('separates current audit groups from historical rows without claiming aliases were executed',()=>{
  const projection:ObligationProjection={version:1,sessionId:'source-session',observationId:'source-observation',conditionVersion:'conditions',entries:[],
    counts:{rows:30,active:2,waiting:3,unreachable:1,aliases:20,resolved:3,excluded:0,authority:1,unresolved:26,unresolvedGroups:6}};
  const html=renderToStaticMarkup(createElement(ObligationAuditSummary,{projection}));
  expect(html).toContain('最近轮次审计');expect(html).toContain('活动目标 2 组');expect(html).toContain('等待条件 3 组');expect(html).toContain('暂不可达 1 组');expect(html).toContain('历史对应 20 条');
  expect(html).toContain('保留 26 条未完成记录，对应 6 组待测范围');expect(html).toContain('不计为已测');
  expect(html).toContain('会话 source-session · 观察 source-observation');expect(html).toContain('后续页面变化需要重新审计');
  expect(renderToStaticMarkup(createElement(ObligationAuditSummary,{}))).toBe('');
});
