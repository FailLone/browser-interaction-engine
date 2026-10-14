import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InteractionClient } from '@interaction/client';
import type { ActionCandidate, ActionAttempt, Checkpoint, Command, EngineEvent, FrontierItem, Graph, IdentityHypothesis, InteractionScope, Issue, Observation, ReachResult, Session } from '@interaction/browser';
import './style.css';
import { VisitDiff } from './VisitDiff.js';
import { DiffExplanation } from './DiffExplanation.js';
const api = new InteractionClient('');
const short = (id?: string) => id?.slice(0, 8) || '—';
const blockerText: Record<string, string> = { outside_active_boundary: '等待当前弹层关闭', pointer_intercepted: '目标被遮挡', outside_scrollable_area: '目标位于不可滚动到达的区域', observation_incomplete: '等待完整观察' };
const statusText: Record<string, string> = { running: '探索中', idle: '等待选择', paused: '已暂停', stopped: '已停止', finished: '本轮结束', pending: '待执行', executed: '已执行', blocked: '受阻', unknown: '结果未知', needs_revalidation: '需重新验证', executing: '执行中', succeeded: '成功', failed: '失败' };
function App() {
  const [sessions, setSessions] = useState<Session[]>([]); const [sessionId, setSessionId] = useState(''); const [session, setSession] = useState<Session>();
  const [url, setUrl] = useState('http://127.0.0.1:4174'); const [headless, setHeadless] = useState(true); const [maxActions, setMaxActions] = useState(100);
  const [contextRules, setContextRules] = useState('[]'); const [exclude, setExclude] = useState('[]');
  const [current, setCurrent] = useState<Observation>(); const [graph, setGraph] = useState<Graph>({ states: [], transitions: [], visits: [] });
  const [history, setHistory] = useState<{ sessionId: string; observationId: string }>();
  const [inspected, setInspected] = useState<{ sessionId: string; observationId: string; observation?: Observation; error?: string }>();
  const historyPinned = history?.sessionId === sessionId;
  const historyResult = historyPinned && inspected?.sessionId === sessionId && inspected.observationId === history.observationId ? inspected : undefined;
  const shown = historyPinned ? historyResult?.observation : current?.sessionId === sessionId ? current : undefined;
  const [actions, setActions] = useState<ActionCandidate[]>([]); const [frontier, setFrontier] = useState<FrontierItem[]>([]); const [attempts, setAttempts] = useState<ActionAttempt[]>([]);
  const [hypotheses, setHypotheses] = useState<IdentityHypothesis[]>([]); const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]); const [scopes, setScopes] = useState<InteractionScope[]>([]); const [issues, setIssues] = useState<Issue[]>([]); const [recovery, setRecovery] = useState<ReachResult>();
  const [events, setEvents] = useState<EngineEvent[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [tab, setTab] = useState('actions');
  const selected = useRef(''); const refreshVersion = useRef(0); const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detail = useRef<HTMLDivElement>(null);
  useEffect(() => { if (detail.current) detail.current.scrollTop = 0; }, [tab, shown?.id]);
  const refresh = useCallback(async () => {
    const id = selected.current; const version = ++refreshVersion.current; setSessions(await api.sessions()); if (!id) return;
    try {
      const [s, o, g, a, f, attempts, h, cp, scopes, issues, reaches] = await Promise.all([api.session(id), api.observation(id), api.graph(id), api.actions(id), api.list<FrontierItem>(id, 'frontier', { limit: 1000 }), api.list<ActionAttempt>(id, 'attempts', { limit: 1000 }), api.list<IdentityHypothesis>(id, 'hypotheses', { limit: 1000 }), api.list<Checkpoint>(id, 'checkpoints', { limit: 1000 }), api.list<InteractionScope>(id, 'scopes', { limit: 1000 }), api.list<Issue>(id, 'issues', { limit: 1000 }), api.list<ReachResult>(id, 'recoveries', { limit: 1000 })]);
      if (selected.current !== id || version !== refreshVersion.current) return;
      setSession(s); setCurrent(o); setGraph(g); setActions(a); setFrontier(f.items); setAttempts(attempts.items); setHypotheses(h.items); setCheckpoints(cp.items); setScopes(scopes.items); setIssues(issues.items); setRecovery(reaches.items.at(-1));
    } catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { selected.current = sessionId; setHistory(undefined); setInspected(undefined); setEvents([]); if (!sessionId) return; void refresh(); const stream = new EventSource(`/v1/sessions/${sessionId}/events`); stream.onmessage = event => { const data = JSON.parse(event.data); setEvents(old => [...old, data].slice(-80)); clearTimeout(timer.current); timer.current = setTimeout(() => void refresh(), 100); }; return () => { stream.close(); clearTimeout(timer.current); }; }, [sessionId, refresh]);
  useEffect(() => {
    if (!history || history.sessionId !== sessionId) return;
    let cancelled = false;
    void api.observation(sessionId, history.observationId).then(observation => {
      if (!cancelled) setInspected({ ...history, observation });
    }, error => { if (!cancelled) setInspected({ ...history, error: String(error) }); });
    return () => { cancelled = true; };
  }, [sessionId, history]);
  const perform = async (command: Command) => { setBusy(true); setError(''); try { const result = await api.command(sessionId, command); await refresh(); return result; } catch (e) { setError(String(e)); await refresh(); } finally { setBusy(false); } };
  const create = async () => { setBusy(true); setError(''); try { const session = await api.createSession({ url, headless, maxActions, contextRules: JSON.parse(contextRules), exclude: JSON.parse(exclude) }); setSessionId(session.id); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const inspectVisit = (observationId: string) => setHistory({ sessionId, observationId });
  const shownVisit = graph.visits.find(v => v.observationId === shown?.id);
  const shownAttempt = attempts.find(a => a.id === shownVisit?.viaAttemptId);
  const parentObservationId = graph.visits.find(v => v.id === shownVisit?.parentId)?.observationId;
  const pending = frontier.filter(f => f.status === 'pending').length;
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">↗</span><div>Interaction Atlas<small>浏览器交互探索引擎 · V0.1</small></div></div>
      <div className="sidebar-label">探索工作区</div><label>起始网址<input value={url} onChange={e => setUrl(e.target.value)} /></label>
      <div className="form-row"><label>动作预算<input type="number" min="1" value={maxActions} onChange={e => setMaxActions(Number(e.target.value))} /></label><label className="check"><input type="checkbox" checked={headless} onChange={e => setHeadless(e.target.checked)} />无界面运行</label></div>
      <details><summary>上下文与排除规则</summary><label>上下文提取（JSON）<textarea value={contextRules} onChange={e => setContextRules(e.target.value)} /></label><label>排除规则（JSON）<textarea value={exclude} onChange={e => setExclude(e.target.value)} /></label><small>例：上下文 {"[{\"key\":\"pair\",\"selector\":\"#pair\"}]"}</small></details>
      <button className="primary wide" onClick={create} disabled={busy}>＋ 创建探索会话</button><p className="scope-note">测试环境 · 同源导航<br/>默认尝试已发现操作，包括提交。</p>
      <div className="sidebar-label">历史会话 <span>{sessions.length}</span></div><div className="session-list">{sessions.slice().reverse().map(s => <button className={`session-item ${s.id === sessionId ? 'selected' : ''}`} key={s.id} onClick={() => setSessionId(s.id)}><span>{new URL(s.options.url).host}</span><small><i className={`dot ${s.status}`} />{statusText[s.status]} · {short(s.id)}</small></button>)}</div>
      <footer><span className="dot" />模型无关 · 本地证据存储</footer>
    </aside>
    <main className="workspace"><header className="topbar"><div><div className="eyebrow">OBSERVE / ACT / VERIFY</div><h1>把每一次交互，变成可追溯的路径。</h1></div><span className="version">SDK + API + EVENTS</span></header>
      {error && <div role="alert" className="error">{error}<button onClick={() => setError('')}>×</button></div>}
      {!sessionId ? <div className="welcome"><span className="welcome-symbol">⌘</span><h2>从一个网址开始</h2><p>创建会话后，查看页面的操作候选、探索路径与变化证据。<br/>所有操作共用同一个浏览器执行器。</p><div className="pill-row"><span>逻辑控件身份</span><span>持久交互图</span><span>可验证恢复</span></div><a href="http://127.0.0.1:4174" target="_blank" rel="noreferrer">打开 Limit / Market 测试站 ↗</a></div> : <>
      <section className="runbar"><div><span className={`badge ${session?.status}`}>{statusText[session?.status || 'idle']}</span><span className="mono">{short(sessionId)}</span>{session?.stopReason && <span className="muted">{session.stopReason === 'ACTIVE_BOUNDARY_BLOCKED' ? '当前弹层尚未退出，父页面探索已暂停' : session.stopReason === 'OBSERVATION_INCOMPLETE' ? '观察不完整，请重新观察后继续' : session.stopReason}</span>}</div><div className="buttons"><button onClick={() => perform({ type: 'observe' })} disabled={busy}>重新观察</button><button onClick={() => perform({ type: 'pause' })} disabled={busy}>暂停 / 接管</button><button onClick={() => perform({ type: 'stop' })} disabled={busy}>停止</button><button className="primary" onClick={() => perform({ type: 'explore' })} disabled={busy || session?.status === 'running'}>▶ DFS 探索</button></div></section>
      {!!current?.boundaries?.length && <div className="boundary-notice" role="status"><b>优先探索：{current.boundaries.at(-1)!.name}</b><span>{current.boundaries.map(b => b.name).join(' → ')}</span><small>父页面操作已暂缓；验证当前弹层关闭后继续。{session?.stopReason === 'ACTIVE_BOUNDARY_BLOCKED' ? '当前没有可继续的内部操作或退出操作，请查看受阻待办。' : ''}</small></div>}
      {current?.gaps.some(g => g.critical) && <div className="boundary-notice" role="status"><b>观察不完整，探索已暂缓</b><small>当前无法确认完整页面及弹层状态。请重新观察；已执行的动作不会自动重试。</small></div>}
      <section className="stats">{[['界面状态', graph.states.length], ['访问记录', graph.visits.length], ['实际动作', `${session?.actionCount || 0} / ${session?.options.maxActions || 100}`], ['待探索', pending], ['身份歧义', hypotheses.filter(h => h.status === 'pending').length]].map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</section>
      <div className="explorer-grid"><section className="panel paths"><div className="panel-title"><h2>遍历路径</h2><span>{graph.transitions.length} 条迁移</span></div><div className="visit-list">{graph.visits.map((v, index) => { const a = attempts.find(a => a.id === v.viaAttemptId); const repeated = graph.visits.findIndex(x => x.stateId === v.stateId) !== index; return <button key={v.id} className={`visit ${v.observationId === shown?.id ? 'active' : ''}`} style={{ paddingLeft: 14 + Math.min(v.depth, 6) * 12 }} onClick={() => inspectVisit(v.observationId)}><span className="visit-line">{a ? '↳' : '◇'} {a ? `${a.action.kind} · ${a.action.label}` : index ? '补充观察' : '入口界面'}</span><small>{short(v.stateId)}{repeated ? ' · 再次到达' : ''}</small></button>; })}</div></section>
      <section className="panel evidence"><div className="panel-title"><h2>观察证据 <small>{short(shown?.id)}</small></h2>{historyPinned ? <button onClick={() => setHistory(undefined)}>返回当前</button> : <span className="live-label"><i className="dot running" />当前页面</span>}</div><div className="screenshot">{shown?.screenshot ? <img alt="页面观察截图" src={`/v1/sessions/${sessionId}/evidence/${shown.id}`} /> : <div className="empty" role={historyResult?.error ? 'alert' : 'status'}>{historyResult?.error || (historyPinned && !shown ? '正在加载所选观察…' : '截图不可用')}</div>}</div><div className="evidence-meta"><span>{shown?.controls.length || 0} 个控件 · {shown?.gaps.some(g => g.critical) ? '观察不完整' : shown?.stable ? '观察窗口稳定' : '页面仍在变化'}</span><span>{shown?.capturedAt ? new Date(shown.capturedAt).toLocaleTimeString() : ''}</span></div>{shown?.gaps.map((g, i) => <div key={i} className="gap"><b>{g.code}</b> {g.message}</div>)}</section></div>
      <section className="panel detail-panel"><nav className="tabs">{[['actions', '操作候选'], ['frontier', '探索待办'], ['diff', '变化比较'], ['identity', '身份与歧义'], ['checkpoints', '检查点'], ['scopes', '交互流程'], ['issues', '问题报告'], ['events', '事件']].map(([key, text]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{text}</button>)}</nav>
      <div className="tab-content" ref={detail}>
        {tab === 'actions' && <><p className="muted">候选来自当前观察。手动执行会暂停默认策略；业务输入有效性仍需调用方判断。</p>{actions.length ? actions.map(a => <ActionRow key={`${sessionId}:${a.controlId}:${a.kind}:${a.kind === 'fill' ? '' : a.value}`} action={a} disabled={busy} run={value => perform({ type: 'execute', actionId: a.id, requestId: crypto.randomUUID(), value })} />) : <div className="empty">当前没有发现可执行操作。</div>}</>}
        {tab === 'frontier' && <table><thead><tr><th>操作</th><th>状态</th><th>所属界面</th><th>原因 / 解除条件</th></tr></thead><tbody>{frontier.map(f => <tr key={f.id}><td>{f.action.label} <code>{f.action.kind}</code></td><td><span className={`badge ${f.status}`}>{statusText[f.status]}</span></td><td className="mono">{short(f.stateId)}</td><td>{blockerText[f.reason || ''] || f.reason || '—'} {f.unblock}</td></tr>)}</tbody></table>}
        {tab === 'diff' && <VisitDiff api={api} sessionId={sessionId} visit={shownVisit} parentObservationId={parentObservationId} attempt={shownAttempt} statusText={statusText} />}
        {tab === 'identity' && <>{hypotheses.length ? hypotheses.map(h => <IdentityCard key={h.id} hypothesis={h} disabled={busy} resolve={(identityId, evidence) => perform({ type: 'resolveIdentity', hypothesisId: h.id, identityId, source: 'human-ui', evidence: [evidence] })} />) : <div className="empty">当前没有身份歧义。</div>}<details><summary>当前控件与身份</summary><JsonView value={current?.controls.map(c => ({ name: c.name, role: c.role, identityId: c.identityId, instanceId: c.instanceId, region: c.region, value: c.value, constraints: c.constraints }))} /></details></>}
        {tab === 'checkpoints' && <><button onClick={() => { const name = prompt('检查点名称', `检查点 ${checkpoints.length + 1}`); if (name) void perform({ type: 'createCheckpoint', name, predicates: [], acceptable: [] }); }} disabled={busy}>＋ 保存当前检查点</button>{checkpoints.map(cp => <div className="data-row" key={cp.id}><b>{cp.name}</b><span className="mono">{short(cp.stateId)}</span><span>{cp.path.length} 步路径</span><button disabled={busy} onClick={() => perform({ type: 'reachCheckpoint', checkpointId: cp.id })}>到达并验证</button></div>)}{recovery && <div className="recovery"><h3>{recovery.status}</h3><p>{recovery.reason}</p><JsonView value={recovery.checks} /></div>}</>}
        {tab === 'scopes' && <><button disabled={busy} onClick={() => perform({ type: 'openScope', name: `手动流程 ${scopes.length + 1}`, region: 'document' })}>＋ 开启页面流程范围</button>{scopes.map(s => <div className="scope-card" key={s.id}><div className="data-row"><b>{s.name}</b><span>{s.status} · {s.attemptIds.length} 次操作</span>{s.status === 'open' && !s.boundaryKey && <button disabled={busy} onClick={() => perform({ type: 'closeScope', scopeId: s.id })}>结束并比较</button>}</div><small>父区域：{s.region}</small>{s.diff && <ScopeDetails sessionId={sessionId} scope={s} />}</div>)}</>}
        {tab === 'issues' && <>{issues.length ? issues.map(issue => <div className={`gap ${issue.severity}`} key={issue.id}><b>{issue.source}</b> {issue.message}<small>{issue.evidence?.join(' · ')}</small></div>) : <div className="empty">检查 hook 尚未报告问题。采集缺口显示在观察证据中。</div>}</>}
        {tab === 'events' && <div className="event-list">{events.slice().reverse().map(e => <div key={e.sequence}><time>{new Date(e.at).toLocaleTimeString()}</time><code>#{e.sequence}</code><b>{e.type}</b><details><summary>数据</summary><JsonView value={e.data} /></details></div>)}</div>}
      </div></section><p className="coverage-note">进度仅针对已发现范围；采集缺口和未探索路径始终保留。恢复成功以验证结果为准。</p>
      </>}
    </main>
  </div>;
}
function ScopeDetails({ sessionId, scope }: { sessionId: string; scope: InteractionScope }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>查看流程累计差异详情</summary>{open && scope.afterId && <DiffExplanation api={api} sessionId={sessionId} beforeId={scope.beforeId} afterId={scope.afterId} scopeId={scope.id} />}</details>;
}
function JsonView({ value }: { value: unknown }) { return <pre>{JSON.stringify(value, null, 2)}</pre>; }
function ActionRow({ action, disabled, run }: { action: ActionCandidate; disabled: boolean; run: (value?: string | boolean | number) => unknown }) {
  const [value, setValue] = useState(String(action.value ?? ''));
  const blocker = action.preconditions.blockers?.[0];
  return <div className="action-row"><span className="kind">{action.kind}</span><div className="action-label"><b>{action.label || '未命名控件'}</b><small>{short(action.controlId)} · {action.replayable ? '允许重放' : '重放需许可'} · {action.sampleValidity}{action.boundary?.intent === 'exit' ? ' · 退出当前弹层' : ''}</small></div>{action.kind === 'fill' ? <input aria-label={`${action.label} 输入样本`} value={value} onChange={e => setValue(e.target.value)} /> : <code>{action.value === undefined ? '' : String(action.value)}</code>}<span className="muted">{action.exclusionReason || (blocker ? blockerText[blocker.code] || blocker.code : !action.preconditions.identityResolved ? '身份待确认' : '')}</span><button disabled={disabled || !!blocker || action.excluded && action.exclusionReason !== 'input_sample_required' || !action.preconditions.identityResolved || !action.preconditions.enabled} onClick={() => run(action.kind === 'fill' ? value : undefined)}>执行 ↗</button></div>;
}
function IdentityCard({ hypothesis: h, disabled, resolve }: { hypothesis: IdentityHypothesis; disabled: boolean; resolve: (id: string, evidence: string) => unknown }) {
  const [choice, setChoice] = useState(h.provisionalIdentityId); const [evidence, setEvidence] = useState('');
  return <div className="scope-card"><div className="data-row"><b>身份歧义 · {short(h.id)}</b><span className={`badge ${h.status}`}>{h.status}</span></div><p>{h.conflicts.join(' · ')}</p><small>依据：{h.evidence.join(' · ')}</small>{h.status === 'pending' && <div className="resolution"><select value={choice} onChange={e => setChoice(e.target.value)}><option value={h.provisionalIdentityId}>保留为独立控件 · {short(h.provisionalIdentityId)}</option>{h.candidateIds.map(id => <option key={id} value={id}>历史候选 · {short(id)}</option>)}</select><input placeholder="填写判断依据" value={evidence} onChange={e => setEvidence(e.target.value)} /><button disabled={disabled || !evidence.trim()} onClick={() => resolve(choice, evidence)}>提交裁决</button></div>}{h.revisions.length > 0 && <JsonView value={h.revisions} />}</div>;
}
createRoot(document.getElementById('root')!).render(<App />);
