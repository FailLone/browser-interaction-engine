import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ObligationAuditSummary,PlanOutstandingCount,PlanItemSelection} from '../packages/explorer-plugin/src/ui.js';
import type {PlanItem} from '@interaction/explorer-plugin';
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

it('shows a transferred parent separately from unfinished children and disables selecting its coarse scope',()=>{
  const source={sessionId:'s',observationId:'o'},scope={url:'https://fixture.test',kind:'click' as const,label:'Run'};
  const parent:PlanItem={id:'parent',title:'Original Run',scope,prerequisites:[],completion:'Observe',required:true,dispatchScope:false,status:'superseded',reason:'condition_scope_split',evidence:[source],attempts:[],operationConditionKey:'v1',
    conditionMigration:{version:2,status:'split',fromKey:'v1',reason:'retained_sources_split',sources:[{...source,actionId:'a'}],children:[{itemId:'child',kind:'condition',scope,required:true,dispatchScope:false,operationConditionKey:'v2',sources:[source]}]}};
  const child:PlanItem={id:'child',title:'Run A',scope,prerequisites:[],completion:'Observe',required:true,dispatchScope:false,status:'pending',reason:'observed_in_scope',evidence:[source],attempts:[],operationConditionKey:'v2',operationConditionPolicy:'browser-operation-key-v2',conditionLineage:{parentItemId:'parent',policy:'operation-condition-split-v1',kind:'condition',fromKey:'v1'}};
  const count=()=>renderToStaticMarkup(createElement(PlanOutstandingCount,{plan:[parent,child]}));
  expect(count()).toContain('1 条未完成记录');
  expect(renderToStaticMarkup(createElement(PlanItemSelection,{item:parent,running:false,checked:false,onChange:()=>{}}))).toContain('disabled');
  expect(renderToStaticMarkup(createElement(PlanItemSelection,{item:child,running:false,checked:false,onChange:()=>{}}))).not.toContain('disabled');
  child.status='succeeded';expect(count()).toContain('0 条未完成记录');expect(parent.status).toBe('superseded');
  expect(renderToStaticMarkup(createElement(PlanOutstandingCount,{plan:[parent]}))).toContain('1 条未完成记录');
});
