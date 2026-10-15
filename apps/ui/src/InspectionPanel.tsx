import React, { useEffect, useState } from 'react';
import type { InteractionClient, RuleRunSummary } from '@interaction/client';
import type { Inspection } from '@interaction/browser';
import { RulePluginPanel } from './RulePluginPanel.js';

const reasons: Record<string, string> = { initial: '首次进入', scope_entered: '打开弹层', scope_exited: '关闭弹层', after_action: '操作后', navigation: '页面跳转', observed_update: '发现页面变化', environment_changed: '视口变化', manual: '主动采集' };
const roles: Record<string, string> = { previous: '上次采集', scopeEntry: '进入弹层前', actionBefore: '操作前' };
const deliveryStatus: Record<string, string> = { pending: '等待检查', completed: '检查完成', expired: '租约已过期', unavailable: '证据不可用', cancelled: '已取消' };
const verdicts: Record<string, string> = { pass: '通过', fail: '发现问题', inconclusive: '无法判断', unsupported: '不适用或不支持', 'not-applicable': '不适用' };
const severities = { info: '信息', warning: '警告', error: '错误' };

export function InspectionPanel({ api, sessionId, observationId, revision }: { api: InteractionClient; sessionId: string; observationId?: string; revision?: number }) {
  const [items, setItems] = useState<Inspection[]>([]); const [selected, setSelected] = useState('');
  const [after, setAfter] = useState(0); const [next, setNext] = useState(0); const [more, setMore] = useState(false);
  const [record, setRecord] = useState<Awaited<ReturnType<InteractionClient['inspection']>>>();
  const [capture, setCapture] = useState<Awaited<ReturnType<InteractionClient['captureDetails']>>>();
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<RuleRunSummary[]>([]); const [summaryMore, setSummaryMore] = useState(false);
  useEffect(() => {
    let active = true;
    void api.ruleRunSummary(sessionId).then(result => { if (active) { setSummary(result.items); setSummaryMore(result.hasMore); } }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api, sessionId, revision]);
  useEffect(() => {
    let active = true; setError('');
    void api.listInspections(sessionId, { after, limit: 50 }).then(page => {
      if (!active) return; setItems(page.items); setNext(page.nextCursor); setMore(page.hasMore);
      setSelected(id => page.items.some(i => i.id === id) ? id : page.items.at(-1)?.id || '');
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api, sessionId, observationId, after, revision]);
  useEffect(() => {
    let active = true; setRecord(undefined); setCapture(undefined); setError('');
    if (selected) void api.inspection(sessionId, selected).then(async result => {
      const details = await api.captureDetails(sessionId, result.inspection.captureId);
      if (active) { setRecord(result); setCapture(details); }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api, sessionId, selected, observationId, revision]);
  return <div className="inspection-panel">
    <h3>UI 检查任务</h3><p className="muted">每条任务对应一次已保存的采集。建议范围之外的页面环境仍可查询；数据完整不代表 UI 已通过检查。</p>
    {error && <div role="alert" className="gap">{error}</div>}
    {!!summary.length && <details className="rule-summary" open><summary>检测记录概览（{summary.length} 条采集{summaryMore ? '，仅显示最近 500 条' : ''}）</summary>
      <p className="muted">按采集统计，同一问题可能多次出现；未判定包含当前警告、历史记录与检查范围限制。</p>
      <div style={{ maxHeight: 240, overflow: 'auto' }}><table><thead><tr><th>采集</th><th>错误</th><th>警告</th><th>未判定</th><th>规则失败</th></tr></thead><tbody>{summary.map(row => <tr key={row.inspectionId}>
        <td><button onClick={() => { if (!items.some(i => i.id === row.inspectionId)) setAfter(row.sequence - 1); setSelected(row.inspectionId); }}>查看 #{row.sequence}</button></td><td>{row.errors}</td><td>{row.warnings}</td><td>{row.unknown}</td><td>{row.failedPlugins}</td>
      </tr>)}</tbody></table></div>
    </details>}
    {!items.length ? <p className="empty">此会话还没有检查任务。创建会话时开启“生成 UI 检查任务”。</p> : <>
      <label>选择检查任务<select aria-label="选择检查任务" value={selected} onChange={e => setSelected(e.target.value)}>{items.slice().reverse().map(i => <option key={i.id} value={i.id}>#{i.sequence} · {i.reasons.map(r => reasons[r]).join('、')} · {i.focus.kind === 'overlay' ? '弹层' : '页面'}</option>)}</select></label>
      <div><button disabled={after === 0} onClick={() => setAfter(0)}>回到第一页</button><button disabled={!more} onClick={() => setAfter(next)}>下一页</button></div>
      {selected && <RulePluginPanel key={`${sessionId}:${selected}`} api={api} sessionId={sessionId} inspectionId={selected} revision={revision} />}
      {record && <>
        <p>建议检查：<b>{record.inspection.focus.regionKey}</b> · {record.inspection.focus.confidence === 'observed' ? '范围已识别' : '范围不确定'}</p>
        <p>必需数据：<b>{record.inspection.quality.status === 'complete' ? '采集完整' : '采集不完整'}</b> · {capture?.capture.phase === 'timeout' ? '等待稳定超时' : '稳定状态采集'}</p>
        {record.inspection.quality.missingRequired.length > 0 && <p className="gap">缺少：{record.inspection.quality.missingRequired.join('、')}</p>}
        <h4>对照快照</h4>{record.inspection.baselines.map(b => <p key={b.role}>{roles[b.role]}：{b.comparison === 'comparable' ? '可比较' : b.comparison === 'incomparable' ? '环境不同' : '不可用'} {b.reason && `（${b.reason}）`}</p>)}
        <h4>证据可用性</h4>{capture?.availability.map(a => <p key={a.kind}>{a.kind}：{a.availability.status === 'available' ? '可查询' : '不可查询'}{a.availability.reason && `（${a.availability.reason}）`}</p>)}
        <h4>外部检查程序</h4>{!record.deliveries.length && <p className="muted">未注册外部检查程序。可使用上方规则插件；证据可查询期限由会话的保留设置决定。</p>}
        {record.deliveries.map(d => <div key={d.id}><b>{d.consumerId} · {deliveryStatus[d.status]}</b><p>证据保护截止：{new Date(d.leaseUntil).toLocaleString()}</p>{d.reason && <p>{d.reason}</p>}{d.results?.map(r => <div key={`${r.ruleId}:${r.ruleVersion}`}><p>{verdicts[r.status]}{r.severity && ` · ${severities[r.severity]}`} · {r.message}</p>{r.details !== undefined && <details><summary>逐控件规则结果 · {r.ruleId}</summary><pre>{JSON.stringify(r.details, null, 2)}</pre></details>}</div>)}</div>)}
        <details><summary>检查记录与空间数据</summary><pre>{JSON.stringify({ inspection: record.inspection, capture: capture?.capture, environment: capture?.details?.snapshot?.dom?.environment }, null, 2)}</pre></details>
      </>}
    </>}
  </div>;
}
