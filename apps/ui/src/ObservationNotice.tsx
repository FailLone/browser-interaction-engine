import React from 'react';
import type { Observation, SessionOptions, Session } from '@interaction/browser';

export function ObservationNotice({ observation, exploration, failures, validationFailures }: { observation?: Observation; exploration?: SessionOptions['exploration']; failures?: Session['observationFailures']; validationFailures?: Session['validationFailures'] }) {
  const gaps = observation?.gaps.filter(g => g.critical) || [];
  const stalled = (failures?.count || 0) >= 3;
  const partial = observation?.controls.some(c => c.readiness?.status === 'unstable');
  const blockedScopes = validationFailures?.filter(f => f.count >= 3) || [];
  if (!gaps.length && !stalled && !partial && !blockedScopes.length) return null;
  const codes = new Set(gaps.map(g => g.code));
  if (stalled) codes.add('OBSERVATION_NO_PROGRESS');
  if (partial) codes.add('PARTIAL_INTERACTION_READY');
  if (blockedScopes.length) codes.add('ACTION_DEPENDENCIES_BLOCKED');
  const changing = codes.has('UNSTABLE') || codes.has('EVIDENCE_CAPTURE_CHANGED');
  return <div className="boundary-notice" role="status">
    <b>{stalled ? '连续观察未能推进，探索已暂停' : gaps.length ? '观察不完整，探索已暂缓' : '部分操作尚未就绪'}</b>
    {stalled && <small>已连续 {failures!.count} 次无法获得可执行的观察。刷新价格或截图不算遍历进展；请查看变化的目标、业务上下文或采集缺口，处理后继续。单纯重新观察或恢复探索不会清除失败计数；解除采集缺口或成功执行后可恢复。</small>}
    {(partial || blockedScopes.length > 0) && <small>变化中的操作保留为覆盖缺口，其他可独立验证的操作可以继续；局部稳定不代表整页状态稳定。</small>}
    {blockedScopes.length > 0 && <small>{blockedScopes.length} 个依赖范围反复失效，已停止自动重试。处理变化原因后，手动执行该范围中的新动作以验证恢复；单纯重新观察或恢复 DFS 不会清除计数。</small>}
    <span>观察状态：{[...codes].join(' · ')}</span>
    {changing && <small>{exploration === 'controls'
      ? '交互目标或弹层持续变化，尚未确认可执行条件。已识别的实时展示不会要求静止；请检查未识别的变化、目标绑定或业务上下文，单纯延长等待不保证恢复。'
      : '当前模式要求完整可观察状态稳定。实时行情等持续更新内容可能使反复观察仍然失败；可为此网址新建“控件覆盖”会话，只要求交互区域稳定。'}</small>}
    {codes.has('TRUNCATED') && <small>页面控件超过采集上限，存在未采集的目标。重复观察不能消除这个上限，需要缩小页面范围或调整采集实现。</small>}
    {codes.has('EVIDENCE_BUDGET_EXHAUSTED') && <small>详细证据保存预算不足。请释放不再需要的固定证据，或新建具有更大证据预算的会话。</small>}
    {gaps.length > 0 && !stalled && !changing && !codes.has('TRUNCATED') && !codes.has('EVIDENCE_BUDGET_EXHAUSTED') && <small>请查看下方对应代码的采集缺口，处理原因后重新观察。</small>}
    <small>已执行的动作不会因重新观察而自动重试。</small>
  </div>;
}
