import React, { useState } from 'react';
import type { BrowserFrontierCoverageGroup, FrontierItemView, FrontierStateSummary } from '@interaction/browser';
import { differenceText, factText, referenceFor, sameValue, sampleText, stateDifferences, summaryFacts } from './frontier-comparison.js';
import { RecoveryDetails } from './RecoveryDetails.js';

const executionText: Record<FrontierItemView['coverage']['executionStatus'], string> = {
  not_attempted: '尚未执行', executing: '执行中', succeeded: '已执行成功', failed: '已尝试，执行失败', blocked: '已尝试，执行受阻', unknown: '执行结果未知',
};
const statusText: Record<FrontierItemView['status'], string> = {
  pending: '待执行', deferred: '列表待办暂缓', executing: '执行中', executed: '已执行', blocked: '受阻', unknown: '结果未知', needs_revalidation: '需重新验证', superseded: '历史遍历意图已失效',
};
function groupLabel(group: BrowserFrontierCoverageGroup) {
  const unit = group.kind === 'fill' ? '样本' : '测试项';
  if (group.items.every(f => f.status === 'superseded')) return '历史遍历意图（未执行）';
  if (group.coverageStatus === 'complete') return group.items.some(f => f.sampling) ? '所选操作样本均已执行' : '已发现测试项均已执行';
  if (group.coverageStatus === 'partial') return group.counts.blocked ? `已探索，仍有${unit}受阻` : '已探索，仍有测试项待完成';
  if (group.coverageStatus === 'attempted') return '已尝试，仍有测试项待确认';
  return group.counts.blocked ? `尚未执行，存在受阻${unit}` : '尚未执行';
}
type Props = { groups: BrowserFrontierCoverageGroup[]; blockerText: Record<string, string>; unblockText: Record<string, string>; inspectObservation?: (id: string) => unknown };
export function FrontierPanel({ groups, ...props }: Props) {
  return <>
    <p className="muted">每行展示操作样本与执行前界面。控件覆盖优先完成每个控件的支持操作；代表性模式增加界面结构等取样条件；逐状态模式保留每个界面的独立测试。样本完成度独立于上方的控件计数，已执行记录始终对应真实执行条件。</p>
    {groups.map(group => <FrontierGroup key={group.id} group={group} {...props} />)}
    {!groups.length && <div className="empty">当前没有探索待办。</div>}
  </>;
}
function FrontierGroup({ group, blockerText, unblockText, inspectObservation }: Omit<Props, 'groups'> & { group: BrowserFrontierCoverageGroup }) {
  const [referenceId, setReferenceId] = useState('auto');
  const executed = group.items.filter(f => f.status === 'executed');
  return <details className="frontier-group" data-control-id={group.controlId} data-kind={group.kind} open>
    <summary><b>{group.label || '未命名控件'}</b> <code>{group.kind}</code><span className={`badge ${group.coverageStatus === 'complete' ? 'executed' : 'pending'}`}>{groupLabel(group)}</span><small>已完成 {group.counts.executed} / {group.counts.total} 项 · 尚未执行 {group.counts.notAttempted} 项 · 受阻 {group.counts.blocked} 项</small><code>控件 {group.controlId?.slice(0, 8) || '身份未提供'}</code></summary>
    {!!executed.length && <label className="frontier-reference">对照成功记录<select aria-label={`${group.label} 对照记录`} value={executed.some(f => f.id === referenceId) ? referenceId : 'auto'} onChange={e => setReferenceId(e.target.value)}><option value="auto">自动：优先相同样本、相近界面</option>{executed.map(f => <option key={f.id} value={f.id}>{sampleText(f.action.value)} · 界面 {f.stateId.slice(0, 8)}</option>)}</select></label>}
    <table><thead><tr><th>{group.kind === 'fill' ? '输入样本' : '操作参数'}</th><th>所属界面（执行前）</th><th>与成功记录相比</th><th>状态 / 执行情况</th><th>原因 / 解除条件</th></tr></thead><tbody>{group.items.map(item => {
      const state = group.states.find(s => s.stateId === item.stateId);
      const reference = referenceFor(group, item, executed.some(f => f.id === referenceId) ? referenceId : 'auto');
      const referenceState = group.states.find(s => s.stateId === reference?.stateId);
      return <tr key={item.id} data-frontier-id={item.id}>
        <td><code>{sampleText(item.action.value)}</code>{item.sampling && <details><summary>代表性样本 · {item.sampling.observationIds.length} 次观察</summary><p>这些观察共享一个抽样任务，不表示界面等价或均已执行。其他输入起始值及字段组合不在完整覆盖范围内。</p><code>{item.sampling.policy}</code></details>}</td>
        <td className="frontier-state"><code>{item.stateId.slice(0, 8)}</code>{state?.status === 'available' ? <>
          <ul className="state-facts">{summaryFacts(state).map(f => <li key={f.key}><span>{f.label}</span><b>{factText(f.value, f.field)}</b></li>)}</ul>
          <button onClick={() => inspectObservation?.(state.observationId)}>查看历史界面</button>
          <details><summary>完整界面摘要 / 业务上下文</summary><dl className="state-details">{state.facts.map(f => <React.Fragment key={f.key}><dt>{f.label}</dt><dd>{factText(f.value, f.field)}</dd></React.Fragment>)}</dl>{Object.keys(item.action.preconditions.context).length ? <pre>{JSON.stringify(item.action.preconditions.context, null, 2)}</pre> : <p>未记录业务上下文；上方为实际记录的界面状态。</p>}</details>
        </> : <p className="muted">历史界面记录不可用，无法还原执行前条件。</p>}</td>
        <td className="frontier-differences"><Comparison item={item} state={state} reference={reference} referenceState={referenceState} /></td>
        <td><span className={`badge ${item.status}`}>{group.kind === 'fill' && item.status === 'blocked' ? '样本受阻' : statusText[item.status]}</span><p>{executionText[item.coverage.executionStatus]}</p></td>
        <td>{blockerText[item.reason || ''] || item.reason || '—'} {unblockText[item.unblock || ''] || item.unblock}<RecoveryDetails diagnostics={item.recovery?.diagnostics} /></td>
      </tr>;
    })}</tbody></table>
  </details>;
}
function Comparison({ item, state, reference, referenceState }: { item: FrontierItemView; state?: FrontierStateSummary; reference?: FrontierItemView; referenceState?: FrontierStateSummary }) {
  if (!reference) return <span className="muted">暂无成功记录可对照</span>;
  if (reference.id === item.id) return <span className="muted">此条为成功记录</span>;
  const differences = stateDifferences(referenceState, state);
  const inputDiffers = !sameValue(reference.action.value, item.action.value);
  const contextDiffers = !sameValue(reference.action.preconditions.context, item.action.preconditions.context);
  const sameState = item.stateId === reference.stateId;
  const inputName = item.coverage.unit === 'input_sample' ? '输入样本' : '操作参数';
  return <>
    <small>对照已执行：<code>{sampleText(reference.action.value)}</code> · {reference.stateId.slice(0, 8)}</small>
    {sameState && !contextDiffers && <p>{inputDiffers ? `执行前界面相同，仅${inputName}不同` : `执行前界面和${inputName}相同`}</p>}
    {inputDiffers && <p className="state-change"><b>{inputName}</b><span>{sampleText(reference.action.value)} → {sampleText(item.action.value)}</span></p>}
    {contextDiffers && <p className="state-change"><b>业务上下文不同</b><span>{JSON.stringify(reference.action.preconditions.context)} → {JSON.stringify(item.action.preconditions.context)}</span></p>}
    {state?.status !== 'available' || referenceState?.status !== 'available' ? <p>历史界面记录不可用，无法比较界面条件。</p> : <>
      {differences.map(d => <p className="state-change" key={d.key}><b>{d.label}</b><span title={`${factText(d.before, d.field)} → ${factText(d.after, d.field)}`}>{differenceText(d.before, d.after, d.field)} → {differenceText(d.after, d.before, d.field)}</span></p>)}
      {!sameState && !differences.length && <p>界面状态不同，摘要未覆盖其余差异。可查看历史界面。</p>}
    </>}
    <small>箭头：成功记录 → 本条记录；这些差异用于区分测试条件，不代表受阻原因。</small>
  </>;
}
