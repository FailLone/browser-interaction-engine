import React, { useCallback, useEffect, useMemo, useState } from 'react';

interface Run { id: string; url: string; status: 'running' | 'finished' | 'failed' | 'interrupted'; summary?: Summary; error?: string; createdAt: string; options: { resumeFrom?: string; plugins?: string[] } }
interface Summary {
  elapsedMs: number; actions: number; states: number; resumedStates?: number; failed: number; onEntryPage: number;
  models?: { jev: { calls: number; costUsd: number }; llm: { calls: number; costUsd: number } };
  navigations?: { intercepted: number; sameDocument: unknown[] };
  coverage?: { pages: { page: string; classesExecuted: number; classesSeen: number; textBlocksRevealedByActions: number }[]; statesPerMinute: number[] };
}
type Event =
  | { seq: number; type: 'state'; at: number; state: { key: string; url: string; overlay?: string; controls: number } }
  | { seq: number; type: 'action'; at: number; step: { kind: string; label: string; value?: string }; tier: string; outcome: string; newState: boolean; overlay?: string; error?: string }
  | { seq: number; type: 'navigation'; at: number; kind: string; to: string; action: string; outcome: string }
  | { seq: number; type: 'judgement'; at: number; question: string; label: string; verdict: string; source: string; probability?: number }
  | { seq: number; type: 'backtrack' | 'stop'; at: number; reason: string }
  | { seq: number; type: 'finding'; at: number; plugin: string; state: string; url: string; finding: { rule: string; severity: 'info' | 'warning' | 'error'; selector: string; text: string; detail: string } }
  | { seq: number; type: 'plugin_error'; at: number; plugin: string; state: string; error: string };

const statusText: Record<Run['status'], string> = { running: '运行中', finished: '已完成', failed: '失败', interrupted: '已中断' };
const pluginText: Record<string, string> = { rules: 'UI 规则', checks: '轻量检查' };
const severityText: Record<string, string> = { info: '提示', warning: '警告', error: '错误' };
const outcomeText: Record<string, string> = { ok: '成功', no_change: '无变化', failed: '失败' };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || response.statusText);
  return body as T;
}

/** Sampled crawler runs: start one, follow its actions and states live, view state screenshots, resume. */
export function CrawlPanel() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState('');
  const [events, setEvents] = useState<Event[]>([]);
  const [url, setUrl] = useState('https://www.okx.com/convert/usd-to-btc');
  const [minutes, setMinutes] = useState(5);
  const [models, setModels] = useState(true);
  const [available, setAvailable] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [state, setState] = useState('');
  const [error, setError] = useState('');
  const run = runs.find(r => r.id === selected);

  const refresh = useCallback(async () => { try { setRuns(await call<Run[]>('/v1/crawls')); } catch (e) { setError(String((e as Error).message)); } }, []);
  useEffect(() => { void refresh(); call<string[]>('/v1/crawl-plugins').then(setAvailable).catch(() => {}); }, [refresh]);
  // Poll the selected run's new events while it is running.
  useEffect(() => {
    if (!selected) return;
    let stop = false, last = 0;
    setEvents([]); setState('');
    const tick = async () => {
      const batch = await call<Event[]>(`/v1/crawls/${selected}/events?after=${last}&limit=2000`).catch(() => []);
      if (stop) return;
      if (batch.length) { last = batch.at(-1)!.seq; setEvents(prev => [...prev, ...batch]); }
      const current = await call<Run>(`/v1/crawls/${selected}`).catch(() => undefined);
      if (current) setRuns(prev => prev.map(r => r.id === current.id ? current : r));
      if (!stop && current?.status === 'running') setTimeout(tick, 1500);
    };
    void tick();
    return () => { stop = true; };
  }, [selected]);

  const start = async (resumeFrom?: string) => {
    setError('');
    try {
      const created = await call<Run>('/v1/crawls', { method: 'POST', body: JSON.stringify({ url: resumeFrom ? run!.url : url, durationMs: minutes * 60000, models, plugins: resumeFrom ? run!.options.plugins ?? [] : plugins, ...(resumeFrom ? { resumeFrom } : {}) }) });
      setRuns(prev => [created, ...prev]); setSelected(created.id);
    } catch (e) { setError(String((e as Error).message)); }
  };
  const stopRun = async () => { try { await call(`/v1/crawls/${selected}/stop`, { method: 'POST', body: '{}' }); await refresh(); } catch (e) { setError(String((e as Error).message)); } };

  const states = useMemo(() => events.filter((e): e is Extract<Event, { type: 'state' }> => e.type === 'state'), [events]);
  const findings = useMemo(() => events.filter((e): e is Extract<Event, { type: 'finding' | 'plugin_error' }> => e.type === 'finding' || e.type === 'plugin_error'), [events]);
  const summary = run?.summary;

  return <section className="crawl-panel">
    {error && <div role="alert" className="error">{error}<button onClick={() => setError('')}>×</button></div>}
    <div className="crawl-start panel">
      <label>网址<input value={url} onChange={e => setUrl(e.target.value)} /></label>
      <label>时长（分钟）<input type="number" min={1} max={60} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></label>
      <label className="check"><input type="checkbox" checked={models} onChange={e => setModels(e.target.checked)} />使用模型（JEV / LLM）</label>
      {available.map(name => <label key={name} className="check"><input type="checkbox" checked={plugins.includes(name)}
        onChange={e => setPlugins(prev => e.target.checked ? [...prev, name] : prev.filter(p => p !== name))} />{pluginText[name] ?? name}</label>)}
      <button onClick={() => start()}>开始遍历</button>
      <small className="muted">只测当前页：跳转被拦截并记录，不会离开页面。</small>
    </div>
    <div className="crawl-grid">
      <aside className="panel crawl-runs"><div className="panel-title"><h2>运行记录</h2><button onClick={refresh}>刷新</button></div>
        {runs.map(r => <button key={r.id} className={`crawl-run${r.id === selected ? ' selected' : ''}`} onClick={() => setSelected(r.id)}>
          <span className={`badge ${r.status}`}>{statusText[r.status]}</span><b>{new URL(r.url).pathname}</b>
          <small>{new Date(r.createdAt).toLocaleString()}{r.options.resumeFrom ? ' · 续跑' : ''}{r.summary ? ` · ${r.summary.actions} 动作 / ${r.summary.states} 状态` : ''}</small>
        </button>)}
        {!runs.length && <p className="muted">还没有运行记录。</p>}
      </aside>
      {run ? <div className="crawl-detail">
        <div className="panel"><div className="panel-title"><h2>{run.url}</h2>
          <span>{run.status === 'running' ? <button onClick={stopRun}>停止</button> : <button onClick={() => start(run.id)}>续跑（跳过已测）</button>}</span></div>
          {run.error && <div className="gap error">{run.error}</div>}
          {summary && <div className="stats">{[
            ['用时', seconds(summary.elapsedMs)], ['动作', summary.actions], ['新状态', summary.states], ['续跑沿用状态', summary.resumedStates ?? 0], ['失败', summary.failed],
            ['拦截的跳转', summary.navigations?.intercepted ?? 0], ['JEV', `${summary.models?.jev.calls ?? 0} 次 $${(summary.models?.jev.costUsd ?? 0).toFixed(5)}`], ['LLM', `${summary.models?.llm.calls ?? 0} 次`],
          ].map(([k, v]) => <div key={String(k)}><span>{k}</span><b>{v}</b></div>)}</div>}
          {summary?.coverage && <table className="crawl-coverage"><thead><tr><th>页面</th><th>执行的控件类 / 出现的</th><th>动作揭示的文本块</th></tr></thead><tbody>
            {summary.coverage.pages.map(p => <tr key={p.page}><td>{new URL(p.page).pathname}</td><td>{p.classesExecuted} / {p.classesSeen}</td><td>{p.textBlocksRevealedByActions}</td></tr>)}</tbody></table>}
        </div>
        <div className="crawl-columns">
          <section className="panel"><div className="panel-title"><h2>动作</h2><span>{events.filter(e => e.type === 'action').length}</span></div>
            <ol className="crawl-events">{events.filter(e => e.type !== 'state' && e.type !== 'finding' && e.type !== 'plugin_error').map(e => <li key={e.seq} className={`crawl-${e.type}`}>
              <span className="mono">{seconds(e.at)}</span>
              {e.type === 'action' && <><span className="kind">{e.step.kind}</span><b>{e.step.label || '未命名'}</b>{e.step.value && <code>{e.step.value}</code>}<small>{e.tier}{e.overlay ? ` · ${e.overlay}` : ''} · {outcomeText[e.outcome] ?? e.outcome}{e.newState ? ' · 新状态' : ''}{e.error ? ` · ${e.error.slice(0, 80)}` : ''}</small></>}
              {e.type === 'navigation' && <><span className="kind">跳转</span><small>{e.kind} · {e.outcome} · {e.action} → {e.to}</small></>}
              {e.type === 'judgement' && <><span className="kind">模型</span><small>{e.question} · {e.source} · {e.verdict}{e.probability !== undefined ? ` ${e.probability.toFixed(2)}` : ''} · {e.label}</small></>}
              {(e.type === 'backtrack' || e.type === 'stop') && <><span className="kind">{e.type === 'stop' ? '结束' : '回退'}</span><small>{e.reason}</small></>}
            </li>)}</ol></section>
          <section className="panel"><div className="panel-title"><h2>状态</h2><span>{states.length}</span></div>
            <ol className="crawl-states">{states.map(e => <li key={e.seq}><button className={state === e.state.key ? 'selected' : ''} onClick={() => setState(e.state.key)}>
              <span className="mono">{seconds(e.at)}</span> {e.state.overlay || '页面'} <small>{e.state.controls} 个可见控件</small></button></li>)}</ol>
            {state && <img className="crawl-shot" alt="状态截图" src={`/v1/crawls/${selected}/screenshot?state=${encodeURIComponent(state)}`} />}
          </section>
          {!!run.options.plugins?.length && <section className="panel"><div className="panel-title"><h2>插件结果</h2><span>{findings.length}</span></div>
            <ol className="crawl-events">{findings.map(e => <li key={e.seq} className={`crawl-${e.type}`}>
              <span className="mono">{seconds(e.at)}</span><span className="kind">{pluginText[e.plugin] ?? e.plugin}</span>
              {e.type === 'finding' ? <><b className={`severity-${e.finding.severity}`}>{severityText[e.finding.severity]} · {e.finding.rule}</b>
                <small>{e.finding.text || e.finding.selector} · {e.finding.detail.slice(0, 160)}</small>
                <button className="link" onClick={() => setState(e.state)}>状态截图</button></>
                : <small className="error">插件出错：{e.error}</small>}
            </li>)}</ol>
            {!findings.length && <p className="muted">还没有发现问题。</p>}</section>}
        </div>
      </div> : <div className="welcome"><h2>选择或开始一次遍历</h2><p>遍历在服务端运行；关闭页面不会中断。中断后可以续跑，已测过的动作不会重测。</p></div>}
    </div>
  </section>;
}
