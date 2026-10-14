import { useEffect, useState } from 'react';
import type { InteractionClient } from '@interaction/client';
import type { BrowserDiffDetails, ControlOccurrenceDetails, Observation } from '@interaction/browser';
import './diff.css';
import { EvidencePanel } from './EvidencePanel.js';
import { evidenceStatusText } from './EvidenceImage.js';

const kindText = { appeared: '出现', disappeared: '未再观察到', rebuilt: '实例重建', changed: '属性变化', context: '上下文变化' };
const correspondenceText = { same_identity: '沿用同一逻辑身份', uncertain: '身份对应不确定', one_sided: '仅在一侧观察到', unavailable: '缺少身份事实' };
const valueText = (value: unknown) => value === undefined ? '未记录' : value === null ? 'null（无声明 / 不适用）' : value === '' ? '""（空字符串）' : typeof value === 'string' ? value : JSON.stringify(value);
const json = (value: unknown) => JSON.stringify(value, null, 2);

export function DiffExplanation({ api, sessionId, beforeId, afterId, attemptId, scopeId }: {
  api: InteractionClient; sessionId: string; beforeId: string; afterId: string; attemptId?: string; scopeId?: string;
}) {
  const key = `${sessionId}:${beforeId}:${afterId}:${attemptId || ''}:${scopeId || ''}`;
  const [loaded, setLoaded] = useState<{ key: string; details?: BrowserDiffDetails; error?: string }>();
  const [selected, setSelected] = useState<{ key: string; controlId: string }>();
  const [revision, setRevision] = useState(0);
  const [expandedEvidence, setExpandedEvidence] = useState<{ key: string; side: 'before' | 'after' }>();
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    const request = scopeId ? api.scopeDiffDetails(sessionId, scopeId) : attemptId ? api.attemptDiffDetails(sessionId, attemptId) : api.diffDetails(sessionId, beforeId, afterId);
    void request.then(details => { if (!cancelled) setLoaded({ key, details }); }, error => { if (!cancelled) setLoaded({ key, error: String(error) }); });
    return () => { cancelled = true; };
  }, [api, sessionId, beforeId, afterId, attemptId, scopeId, key, revision]);
  const result = loaded?.key === key ? loaded : undefined;
  if (!result?.details) return <div className="diff-loading" role={result?.error ? 'alert' : 'status'}>{result?.error ? <>详细差异读取失败：{result.error} <button onClick={() => { setLoaded(undefined); setFailedImages({}); setRevision(n => n + 1); }}>重试</button></> : '正在读取控件、身份和历史证据…'}</div>;
  const d = result.details;
  const activeId = selected?.key === key ? selected.controlId : d.changes.find(c => c.change.controlId)?.change.controlId;
  const active = activeId ? d.controls[activeId] : undefined;
  const base = `/v1/sessions/${encodeURIComponent(sessionId)}`;
  const query = new URLSearchParams({ before: beforeId, after: afterId });
  const url = scopeId ? `${base}/scopes/${encodeURIComponent(scopeId)}/diff/details` : attemptId ? `${base}/attempts/${encodeURIComponent(attemptId)}/diff/details` : `${base}/compare/details?${query}`;
  return <section className="diff-explanation" data-testid="diff-explanation" data-after-id={d.diff.afterId}>
    <div className="diff-summary"><div><b>{d.summary.changes} 项变化</b><span>{d.summary.affectedControls} 个变化控件 · {d.summary.uncertainControls} 个历史身份对应不确定 · {d.gaps.length} 项采集或比较缺口</span></div><button onClick={() => { setLoaded(undefined); setFailedImages({}); setRevision(n => n + 1); }}>刷新详情</button><a href={url} target="_blank" rel="noreferrer">完整详情 API ↗</a></div>
    <p className="diff-caveat">观察区间内的变化，尚未证明由本次操作导致。{d.summary.contextChanged && '业务上下文已变化，旧探索结果需要重新验证。'}</p>
    <div className="diff-time">{d.interval.beforeAt} → {d.interval.afterAt}<span>间隔 {d.interval.elapsedMs === null ? '未知' : `${d.interval.elapsedMs} ms`}</span></div>
    <div className="diff-changes">{d.changes.length ? d.changes.map(item => {
      const change = item.change; const field = change.field ? d.browser.fields[change.field] : undefined;
      return <article className={`diff-change ${activeId && activeId === change.controlId ? 'selected' : ''}`} key={item.index} data-testid="explained-change">
        <div className="diff-change-heading"><b>{item.index + 1}. {item.target.label}</b><span className="badge">{kindText[change.kind]}</span>{change.controlId && <button onClick={() => setSelected({ key, controlId: change.controlId! })}>定位控件</button>}</div>
        <p>{item.interpretation.summary}</p>
        {item.interpretation.certainty === 'identity_uncertain' && <p className="diff-warning">身份对应尚未确定，请结合候选判断；此条不是已确认的对象增删或状态变化。</p>}
        {change.field && <><div className="diff-values"><div><small>之前 · {field?.label || change.field}</small><code>{valueText(change.before)}</code></div><div><small>之后 · {field?.label || change.field}</small><code>{valueText(change.after)}</code></div></div><details><summary>字段含义与判断边界 · {change.field}</summary><p>{field?.description || '适配器保存的属性差异。'}</p>{field?.nullMeaning && <p>null：{field.nullMeaning}</p>}{field?.falseMeaning && <p>false：{field.falseMeaning}</p>}<ul>{item.interpretation.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul></details></>}
        {change.kind === 'context' && <div className="diff-values"><pre>{json(change.before)}</pre><pre>{json(change.after)}</pre></div>}
        {change.controlId && <code className="diff-id">{change.controlId}</code>}
      </article>;
    }) : <p className="diff-caveat">没有记录到属性差异；这不保证页面完全相同，也不表示没有采集或身份缺口。</p>}</div>
    <div className="compare-images detailed-images">{(['before', 'after'] as const).map(side => {
      const o = d.observations[side]; const storage = d.browser.evidence[side]; const screenshot = storage.artifacts.screenshot; const available = screenshot.availability.status === 'available'; const label = side === 'before' ? '操作前' : '操作后';
      return <figure key={side}><div className="diff-image" style={{ aspectRatio: `${o.viewport.width} / ${o.viewport.height}` }}>
        {available && !failedImages[o.id] ? <img alt={label} src={`${base}/evidence/${encodeURIComponent(o.id)}`} onError={() => setFailedImages(old => ({ ...old, [o.id]: true }))} /> : <span>{failedImages[o.id] ? '截图读取失败，可能在查询后过期或被清理；请刷新详情。控件属性仍可查询。' : `截图${evidenceStatusText[screenshot.availability.status]}；历史控件属性仍可查询。`}</span>}
        {available && !failedImages[o.id] && <svg viewBox={`0 0 ${o.viewport.width} ${o.viewport.height}`} aria-label={`${label}控件位置`}><title>{active?.label || '选择控件查看位置'}</title>{active?.[side].map(({ control }) => <rect key={control.localId} x={control.rect.x} y={control.rect.y} width={control.rect.width} height={control.rect.height} />)}</svg>}
      </div><figcaption>{label} · {o.title || '无标题'}<small>{active ? `${active.label} · ${active[side].length ? '红框为采集时区域' : '此侧未观察到该身份'}` : '选择下方控件，在截图中定位'}</small></figcaption>
      <div className="diff-retention" data-testid={`diff-retention-${side}`}><b>证据留存 · 查询时状态</b><small>检查时间：{storage.checkedAt}；状态不保证后续请求仍可读取。</small>
        {Object.entries(storage.artifacts).map(([kind, artifact]) => <p key={kind}><span>{kind === 'screenshot' ? '视口截图' : kind === 'fullPageScreenshot' ? '整页截图' : '详细 DOM / HTML'}：{evidenceStatusText[artifact.availability.status]}</span>{artifact.availability.status !== 'not_captured' && <small>{artifact.availability.mode || '未配置留存策略'} · {artifact.availability.durability === 'persistent' ? '持久介质' : artifact.availability.durability === 'process' ? '仅当前进程' : '介质未知'}{artifact.availability.expiresAt && ` · 到期时间 ${artifact.availability.expiresAt}`}</small>}{artifact.availability.reason && <small>{artifact.availability.reason}</small>}</p>)}
        <button onClick={() => setExpandedEvidence({ key, side })}>读取{label}完整证据</button>
      </div>
      <details><summary>页面与采集信息</summary><dl><dt>URL</dt><dd>{o.url}</dd><dt>观察 ID</dt><dd>{o.id}</dd><dt>状态 / 访问</dt><dd>{o.stateId} / {o.visitId}</dd><dt>规则 / 原因</dt><dd>{o.ruleVersion} / {o.cause}</dd><dt>稳定性</dt><dd>{o.stable ? '在稳定等待规则下稳定' : '不稳定 / 部分观察'}</dd><dt>属性 / 截图时间</dt><dd>{o.capturedAt}<br/>{o.screenshotAt || '未记录'}</dd><dt>视口 / 滚动</dt><dd>{json(o.viewport)} / {json(o.scroll)}</dd></dl><h4>业务上下文</h4><pre>{json(o.context)}</pre><h4>交互边界 / 浮层</h4><pre>{json({ boundaries: o.boundaries, overlays: o.overlays })}</pre></details></figure>;
    })}</div>
    {expandedEvidence?.key === key && <section className="diff-section" data-testid="diff-full-evidence"><button onClick={() => setExpandedEvidence(undefined)}>收起完整证据</button><EvidencePanel key={`${key}:${expandedEvidence.side}:${revision}`} api={api} sessionId={sessionId} observationId={d.observations[expandedEvidence.side].id} /></section>}
    {d.browser.pageChanges.length > 0 && <details className="diff-section"><summary>页面与浮层变化（{d.browser.pageChanges.length}）</summary><pre>{json(d.browser.pageChanges)}</pre></details>}
    <section className="diff-section"><h3>控件与身份依据</h3>{Object.values(d.controls).map(control => <details className="diff-control" key={control.identityId} data-testid="diff-control"><summary><b>{control.label}</b> · {correspondenceText[control.correspondence]}<code>{control.identityId}</code></summary>
      <button onClick={() => setSelected({ key, controlId: control.identityId })}>在前后截图中定位</button>
      <div className="diff-values">{(['before', 'after'] as const).map(side => <div key={side}><h4>{side === 'before' ? '之前' : '之后'}</h4>{control[side].length ? control[side].map(o => <Occurrence key={o.control.localId} occurrence={o} />) : <p>{d.observations[side].gaps.some(g => g.critical) ? '采集不完整，无法确认是否存在。' : '该观察中未记录此逻辑身份；不等于已证明 DOM 不存在。'}</p>}</div>)}</div>
      {control.historical && <details><summary>候选的较早历史出现（{control.historical.observationId}）</summary><Occurrence occurrence={control.historical} /></details>}
      {control.alternatives.length > 0 && <div className="diff-alternatives"><h4>候选对应关系（未验证，不自动合并）</h4>{control.alternatives.map(a => <p key={a.identityId}><button onClick={() => setSelected({ key, controlId: a.identityId })}>{d.controls[a.identityId]?.label || '未解析候选'}</button><code>{a.identityId}</code><span>{a.evidence.map(e => e === 'same_instance' ? '相同 DOM 实例' : '身份假设候选').join(' · ')}</span></p>)}</div>}
      {control.hypothesisIds.map(id => { const h = d.hypotheses.find(h => h.id === id); return <details key={id}><summary>身份假设 · {id}</summary>{h ? <><p>比较时：{h.statusAtComparison}；查询时裁决：{h.currentResolution.status}。后续裁决不会改写原观察。</p><h4>匹配证据</h4><pre>{json(h.evidence)}</pre><h4>冲突</h4><pre>{json(h.conflicts)}</pre><h4>候选、来源和修订记录</h4><pre>{json(h)}</pre></> : <p>假设记录不可用，已保留引用。</p>}</details>; })}
    </details>)}</section>
    <details className="diff-section" open={d.gaps.length > 0}><summary>采集与比较缺口（{d.gaps.length}）</summary>{d.gaps.map((entry, i) => <div className="diff-gap" key={i}><b>{entry.gap.code}</b><small>来源：{entry.origin} {entry.gap.critical ? ' · 关键缺口' : ''}</small><p>{entry.gap.message}</p>{entry.controlIds.map(id => <button key={id} onClick={() => setSelected({ key, controlId: id })}>{d.controls[id]?.label || id}</button>)}{entry.hypothesisIds.length > 0 && <small>身份假设：{entry.hypothesisIds.join(', ')}</small>}</div>)}</details>
    <details className="diff-section"><summary>关联操作、访问路径与流程范围</summary><pre>{json(d.related)}</pre></details>
    <details className="diff-section"><summary>完整详细 JSON / 解释限制</summary><ul>{d.browser.limitations.map(text => <li key={text}>{text}</li>)}</ul><pre>{json(d)}</pre></details>
  </section>;
}

function Occurrence({ occurrence: o }: { occurrence: ControlOccurrenceDetails<Observation> }) {
  const c = o.control;
  return <div className="diff-occurrence"><dl><dt>名称 / 标签</dt><dd>{c.name || '未命名'} / {c.label || '未提供'}</dd><dt>角色 / 标签类型</dt><dd>{c.role} / {c.tag}</dd><dt>文案</dt><dd>{c.displayedText || '空'}</dd><dt>区域路径</dt><dd>{o.regionPath.map(r => r.label || r.key).join(' → ') || c.region}</dd><dt>表单</dt><dd>{c.form || '无'}</dd><dt>定位证据</dt><dd>{c.selector}</dd><dt>稳定标识</dt><dd>{c.stableKey || '未提供'}</dd><dt>出现 / 实例</dt><dd>{c.localId}<br/>{c.instanceId}</dd><dt>矩形</dt><dd>{json(c.rect)}</dd><dt>当前值</dt><dd>{valueText(c.value)}</dd></dl>
    <h4>身份匹配依据</h4><pre>{json(o.identityEvidence)}</pre>
    <details><summary>状态、约束与可操作性</summary><pre>{json({ checked: c.checked, selected: c.selected, expanded: c.expanded, controls: c.controls, visible: c.visible, enabled: c.enabled, editable: c.editable, constraints: c.constraints, options: c.options, actionable: c.actionable })}</pre></details>
    <details><summary>操作候选及前提（{o.actions.length}）</summary><pre>{json(o.actions)}</pre></details>
    <details><summary>完整控件记录</summary><pre>{json(c)}</pre></details>
  </div>;
}
