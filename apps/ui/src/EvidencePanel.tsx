import React, { useEffect, useState } from 'react';
import type { InteractionClient } from '@interaction/client';
import type { ControlDetails, DomResult, EventContext, Gap, ObservationDetails } from '@interaction/browser';

const relationNames: Record<string, string> = { before: '操作前', after: '操作后', observation: '关联观察', actionSource: '操作来源', currentAtEvent: '事件发生时' };
const views = [['controls', '控件详情'], ['dom', 'DOM / HTML'], ['images', '截图'], ['aria', 'ARIA'], ['runtime', '页面与运行记录'], ['gaps', '采集缺口'], ['json', '完整 JSON']];
const json = (value: unknown) => JSON.stringify(value, null, 2);
function Json({ value }: { value: unknown }) { return <pre>{json(value)}</pre>; }
function Section({ title, value }: { title: string; value: unknown }) { return <details className="evidence-section"><summary>{title}</summary><Json value={value} /></details>; }
function Gaps({ gaps }: { gaps: Gap[] }) {
  const unique = [...new Map(gaps.map(g => [json(g), g])).values()];
  return unique.length ? <div>{unique.map((g, i) => <div className="gap" key={i}><b>{g.code}</b> {g.message}</div>)}</div> : <p className="muted">此项没有记录采集缺口；支持范围仍以能力清单为准。</p>;
}

/** Public queries only. This inspector never observes again or changes the explored page. */
export function EvidencePanel({ api, sessionId, observationId, eventSequence }: { api: InteractionClient; sessionId: string; observationId?: string; eventSequence?: number }) {
  const [context, setContext] = useState<EventContext>();
  const [direct, setDirect] = useState<ObservationDetails>();
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setContext(undefined); setDirect(undefined); setSelected('');
    (async () => {
      if (eventSequence !== undefined) {
        const result = await api.eventContext(sessionId, eventSequence); if (!active) return;
        setContext(result); setSelected((result.observations.find(o => o.relations.includes('after')) || result.observations[0])?.observationId || '');
      } else if (observationId) {
        const result = await api.observationDetails(sessionId, observationId); if (!active) return;
        setDirect(result); setSelected(observationId);
      }
    })().catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, sessionId, observationId, eventSequence]);
  const details = context ? context.observations.find(o => o.observationId === selected)?.details : direct;
  return <div className="evidence-inspector">
    <div className="evidence-heading"><h3>{eventSequence !== undefined ? `事件 #${eventSequence} · 历史详细数据` : '观察详细数据'}</h3><span className="badge">只读查询</span></div>
    <p className="muted">原始 data 是事件通知；下方通过公共接口读取该时刻保存的证据，不会重新观察或操作页面。</p>
    {loading && <p role="status">正在读取详细证据…</p>}
    {error && <div role="alert" className="error">{error}</div>}
    {context && <>
      <div className="evidence-observations" aria-label="事件关联观察">{context.observations.map(o => <button aria-pressed={o.observationId === selected} key={o.observationId} onClick={() => setSelected(o.observationId)}>{o.relations.map(r => relationNames[r] || r).join(' / ')} · {o.observationId.slice(0, 8)}</button>)}</div>
      <Gaps gaps={context.gaps} />
      {!context.observations.length && <p className="empty">此事件没有可查询的历史观察引用。可从“遍历路径”选择观察，再打开“详细数据”。</p>}
      <Section title="原始事件 data" value={context.event.data} />
    </>}
    {details && <ObservationEvidence key={details.observation.id} api={api} sessionId={sessionId} details={details} />}
    {!loading && !error && !context && !details && <p className="empty">先选择一个观察。</p>}
  </div>;
}

function ObservationEvidence({ api, sessionId, details }: { api: InteractionClient; sessionId: string; details: ObservationDetails }) {
  const [view, setView] = useState('controls'); const [rootId, setRootId] = useState<string>();
  const { observation: o, snapshot } = details;
  const base = `/v1/sessions/${encodeURIComponent(sessionId)}/observations/${encodeURIComponent(o.id)}`;
  return <>
    <div className="evidence-facts"><b>{o.title || '无标题页面'}</b><span>{o.url}</span><code>observationId: {o.id}</code><span>观察时间：{o.capturedAt} · {o.controls.length} 个控件 · 已保存 {snapshot?.dom?.nodes.length ?? 0} 个 DOM 节点</span><a href={`${base}/details`} target="_blank" rel="noreferrer">打开详细数据 API ↗</a></div>
    {!snapshot && <div className="gap"><b>详细证据未保存</b> 此观察只有基础记录；请使用“重新观察”显式创建新观察。旧观察不会被补写。</div>}
    <nav className="evidence-views" aria-label="详细证据分类">{views.map(([key, label]) => <button key={key} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}</nav>
    {view === 'controls' && <Controls api={api} sessionId={sessionId} details={details} openDom={id => { setRootId(id); setView('dom'); }} />}
    {view === 'dom' && <><DomTree key={rootId || 'document'} api={api} sessionId={sessionId} observationId={o.id} rootId={rootId} /><button disabled={!rootId} onClick={() => setRootId(undefined)}>查看整个文档</button><details className="evidence-section"><summary>原始 HTML{snapshot?.dom?.htmlTruncated ? '（采集已截断）' : ''}</summary><pre>{snapshot?.dom?.html ?? '此观察没有保存 HTML'}</pre></details></>}
    {view === 'images' && <div className="evidence-images">{(['screenshot', 'fullPageScreenshot'] as const).map(kind => {
      const artifact = o.evidence?.artifacts[kind]; const present = !!artifact || kind === 'screenshot' && !!o.screenshot;
      const label = kind === 'screenshot' ? '历史视口截图' : '历史整页截图';
      return <figure key={kind}><figcaption>{label} · {artifact?.capturedAt || '未记录独立时间'}</figcaption>{present ? <><a href={`${base}/artifacts/${kind}`} target="_blank" rel="noreferrer">打开原图 ↗</a><img alt={label} src={`${base}/artifacts/${kind}`} /></> : <p className="muted">未采集{kind === 'fullPageScreenshot' ? '（需要在会话配置中启用）' : ''}</p>}</figure>;
    })}</div>}
    {view === 'aria' && <><p className="muted">{snapshot?.accessibility.status || '未保存'} · {snapshot?.accessibility.capturedAt} · Playwright ARIA 快照</p><pre>{snapshot?.accessibility.text || '此观察没有保存 ARIA 快照'}</pre><Gaps gaps={snapshot?.accessibility.gaps || []} /></>}
    {view === 'runtime' && <><Section title="页面元数据" value={snapshot?.dom?.page || { url: o.url, title: o.title }} /><Section title="区域、弹层和业务上下文" value={{ regions: o.regions, overlays: o.overlays, context: o.context }} /><p className="muted">运行记录：{snapshot?.runtime.since || '未保存'} → {snapshot?.runtime.capturedAt || '未保存'}</p><Section title="网络请求元数据" value={snapshot?.runtime.network} /><Section title="控制台消息" value={snapshot?.runtime.console} /><Section title="页面异常" value={snapshot?.runtime.errors} /><Section title="Frame 清单" value={snapshot?.runtime.frames} /></>}
    {view === 'gaps' && <><Gaps gaps={details.gaps} /><Section title="节点级采集缺口" value={snapshot?.dom?.nodes.filter(n => n.gaps.length).map(n => ({ nodeId: n.id, gaps: n.gaps }))} /><Section title="采集限额与截断计数" value={{ limits: snapshot?.limits, dropped: snapshot?.runtime.dropped, truncatedFields: snapshot?.runtime.truncatedFields }} /><Section title="已支持与未支持能力" value={details.capabilities} /></>}
    {view === 'json' && <><a href={`${base}/details`} target="_blank" rel="noreferrer">在新标签页读取完整 JSON ↗</a><Json value={details} /></>}
  </>;
}

function Controls({ api, sessionId, details, openDom }: { api: InteractionClient; sessionId: string; details: ObservationDetails; openDom: (id: string) => void }) {
  const [filter, setFilter] = useState(''); const [selected, setSelected] = useState(details.observation.controls[0]?.localId || '');
  const [control, setControl] = useState<ControlDetails>(); const [error, setError] = useState('');
  const o = details.observation;
  useEffect(() => {
    let active = true; setControl(undefined); setError('');
    if (selected) void api.controlDetails(sessionId, o.id, selected).then(c => { if (active) setControl(c); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api, sessionId, o.id, selected]);
  const controls = o.controls.filter(c => `${c.name} ${c.label} ${c.role} ${c.tag} ${c.localId}`.toLowerCase().includes(filter.toLowerCase()));
  return <div className="control-inspector"><aside><label>筛选控件<input value={filter} onChange={e => setFilter(e.target.value)} placeholder="文案、role、标签或 ID" /></label><div className="control-picker">{controls.map(c => <button key={c.localId} aria-pressed={selected === c.localId} onClick={() => setSelected(c.localId)}><b>{c.name || c.label || '未命名控件'}</b><small>{c.tag} · {c.role} · {c.constraints.type}</small></button>)}{!controls.length && <p className="empty">没有匹配的控件</p>}</div></aside>
    <section aria-label="所选控件详情">{error && <p role="alert" className="error">{error}</p>}{selected && !control && !error && <p role="status">正在读取控件…</p>}{control && <>
      <h4>{control.control.name || '未命名控件'}</h4><dl className="control-facts"><dt>类型</dt><dd>{control.control.tag} / {control.control.role} / {control.control.constraints.type}</dd><dt>当前值</dt><dd>{json(control.control.value) ?? '未记录'}</dd><dt>控件文案</dt><dd>{control.control.displayedText || control.content.text || control.control.label || '无文本'}</dd><dt>所属区域</dt><dd>{control.region?.label || control.control.region}</dd><dt>业务意图</dt><dd>未推断；文案、属性、关系和上下文供上层判断。</dd></dl>
      <button disabled={!control.node} onClick={() => control.node && openDom(control.node.id)}>查看该控件 DOM 子树</button>
      <Section title="属性与实时状态" value={{ attributes: control.node?.attributes, properties: control.node?.properties, constraints: control.control.constraints, actionable: control.control.actionable }} />
      <Section title="完整文案与标签关系" value={{ content: control.content, label: control.control.label, relations: control.relations }} />
      <Section title="操作候选、依据与前提" value={control.actions} />
      <Section title="身份依据与业务上下文" value={{ identityId: control.control.identityId, identityEvidence: control.identityEvidence, hypothesis: control.hypothesis, context: control.context }} />
      <Section title="空间、样式与祖先" value={{ rect: control.control.rect, styles: control.node?.styles, ancestors: control.ancestors, region: control.region, form: control.form, overlays: control.overlays }} />
      <Section title="完整控件 JSON" value={control} /><Gaps gaps={control.gaps} />
    </>}</section>
  </div>;
}

function DomTree({ api, sessionId, observationId, rootId }: { api: InteractionClient; sessionId: string; observationId: string; rootId?: string }) {
  const [offset, setOffset] = useState(0); const [depth, setDepth] = useState(20); const [tree, setTree] = useState<DomResult>(); const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setTree(undefined); setError('');
    void api.dom(sessionId, observationId, { ...(rootId ? { rootId } : {}), offset, depth, limit: 50 }).then(t => { if (active) setTree(t); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api, sessionId, observationId, rootId, offset, depth]);
  return <div className="dom-inspector"><div className="dom-toolbar"><label>DOM 查询深度<select value={depth} onChange={e => { setDepth(Number(e.target.value)); setOffset(0); }}>{[0, 2, 4, 10, 20, 100].map(d => <option key={d} value={d}>{d}</option>)}</select></label><button disabled={!offset || !tree} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><button disabled={tree?.nextOffset == null} onClick={() => tree?.nextOffset != null && setOffset(tree.nextOffset)}>下一页</button></div>
    {error && <div role="alert" className="error">{error}</div>}{!tree && !error && <p role="status">正在读取 DOM…</p>}
    {tree && <><p className="muted">第 {tree.nodes.length ? offset + 1 : 0}–{offset + tree.nodes.length} 个节点 / 当前查询共 {tree.total} 个 · {tree.capturedAt}{tree.depthLimited ? ' · 查询深度有限' : ''}{tree.captureTruncated ? ' · 原始采集已截断' : ''}</p><div className="dom-nodes">{tree.nodes.map(n => <details key={n.id}><summary><code>{n.nodeType === 'element' ? `<${n.tag}${n.attributes?.id ? ` id="${n.attributes.id}"` : ''}>` : '#text'}</code> {n.text?.slice(0, 120)} <small>{n.id}</small></summary><Json value={n} /></details>)}</div><Gaps gaps={tree.gaps} /></>}
  </div>;
}
