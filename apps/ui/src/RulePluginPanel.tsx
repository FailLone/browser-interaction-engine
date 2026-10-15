import React, { useEffect, useRef, useState } from 'react';
import './rule-plugins.css';
import type { InteractionClient, RulePluginInfo, RulePluginRun, RulePluginRunRequest, RulePluginResult, RuleCheck, RuleAutomation } from '@interaction/client';

const verdicts = { pass: '通过', fail: '发现问题', unknown: '未判定', 'not-applicable': '不适用' };
const severities = { info: '信息', warning: '警告', error: '错误' };
const lifecycle: Record<string, string> = { pending: '等待后续观察', suspected: '疑似问题', confirmed: '已确认', resolved: '已恢复', unverified: '无法继续核验' };
const descriptions: Record<string, string> = {
  OBSERVED_POINT_REACHABLE: '已检查的点击采样点可达', SAMPLE_REACHABLE: '点击采样点可达',
  OCCLUSION_SUSPECTED: '本次采集的点击采样点被遮挡', OCCLUSION_STILL_OBSERVED: '后续采集中仍然观察到遮盖',
  OBSERVED_POINTER_REQUIREMENT_FAILED: '相关滚动后，全部点击采样点仍被遮挡，违反已声明的可点击要求',
  OCCLUSION_RECOVERED_AFTER_SCROLL: '滚动后，原有遮盖已恢复', OCCLUSION_NO_LONGER_OBSERVED: '本次采集中未再观察到原有遮盖',
  CONTROL_BOX_UNCLIPPED: '控件边界未被裁切', CONTROL_CLIPPING_SUSPECTED: '控件边界可能被容器裁切',
  CLIPPING_REQUIREMENT_FAILED: '控件被非滚动容器裁切，违反已声明的完整显示要求',
  SCROLL_CLIP_RECHECK_PENDING: '控件位于可滚动区域，等待后续复核', VIEWPORT_RECHECK_PENDING: '控件未完全进入视口，等待后续复核',
  CLIPPING_NO_LONGER_OBSERVED: '本次采集中未再观察到原有裁切',
  DOM_TEXT_BOXES_FIT: '已采集的文字边界完整', TEXT_HARD_CLIP_SUSPECTED: '文字可能被直接裁断',
  TEXT_ELISION_OBSERVED: '观察到文字省略，是否符合设计仍待判断', TEXT_SCROLL_RECHECK_PENDING: '文字位于可滚动区域，等待后续复核',
  TEXT_CLIPPING_NO_LONGER_OBSERVED: '本次采集中未再观察到原有文字裁切',
  MODAL_BACKGROUND: '弹层背景中的控件，本次不检查', OUTSIDE_ACTIVE_SCOPE: '位于当前活动范围之外',
  OUTSIDE_VIEWPORT: '位于当前视口之外', INACTIVE_CONTROL: '控件不可见或不可用',
  NO_DOM_LABEL: '没有可检查的页面文字标签', NO_RENDERED_DOM_TEXT: '没有已渲染的文字',
  EVIDENCE_UNAVAILABLE: '保存的证据不可用，无法判断', EVIDENCE_INCOMPLETE: '采集证据不完整，无法判断',
  OCCLUSION_RECHECK_UNAVAILABLE: '遮盖复核所需的命中或几何证据不足', CLIP_EVIDENCE_UNAVAILABLE: '裁切边界、样式或几何证据不完整',
  TEXT_RECHECK_UNAVAILABLE: '文字或几何证据不完整，无法确认是否完整显示',
  TARGET_EXCEEDS_VIEWPORT: '目标大于视口，单靠滚动无法满足完整检查条件',
  TARGET_EXCEEDS_CLIP_BOUNDS: '目标大于可见裁切区域，当前方法无法完整检查',
  TARGET_EXCEEDS_SCROLLPORT: '目标大于滚动容器，单靠滚动无法完整显示',
  OCCLUSION_TARGET_UNOBSERVED: '保留此前的遮挡记录；当前范围未观察到原目标',
  CLIPPING_TARGET_UNOBSERVED: '保留此前的裁切记录；当前范围未观察到原目标',
  TEXT_TARGET_UNOBSERVED: '保留此前的文字裁断记录；当前范围未观察到原目标',
  OCCLUSION_BASELINE_CHANGED: '原遮挡记录缺少可比较的后续证据；当前采样结果单独记录',
  CLIPPING_BASELINE_CHANGED: '原裁切记录缺少可比较的后续证据；当前几何结果单独记录',
  TEXT_BASELINE_CHANGED: '原文字记录缺少可比较的后续证据；当前文字结果单独记录',
  NO_TARGETS: '没有可检查的控件',
};

function Check({ check, labels }: { check: RuleCheck; labels: Record<string, string> }) {
  const phase = typeof check.facts?.lifecycle === 'string' ? lifecycle[check.facts.lifecycle] : undefined;
  const status = check.facts?.observationStatus;
  const statusLabel = status === 'historical' ? '历史记录 · 当前未复查' : status === 'unsupported' ? '检查范围受限' : status === 'current' && check.verdict === 'unknown' ? '当前观察' : undefined;
  const history = check.facts?.lastObservedFinding;
  const historicalLabel = history && typeof history === 'object' && !Array.isArray(history) && typeof history.label === 'string' ? history.label : undefined;
  return <li className={`rule-check rule-severity-${check.severity}`}>
    <div><b>{check.target ? labels[check.target.nodeId] || historicalLabel || '未命名控件' : historicalLabel || '检查范围'}</b><span>{statusLabel || verdicts[check.verdict]} · {severities[check.severity]}{!statusLabel && phase && ` · ${phase}`}</span></div>
    <p>{descriptions[check.code] || (check.verdict === 'unknown' ? '当前证据不足以确定结果，请查看检测依据。' : check.actual)}</p>
    {check.verdict === 'fail' && <p>判断依据：{check.expected}</p>}
    <details><summary>检测依据</summary><p>{check.actual}</p><pre>{JSON.stringify(check, null, 2)}</pre></details>
  </li>;
}

function Result({ result }: { result: RulePluginResult }) {
  if (result.status === 'failed') return <section className="rule-result"><h4>{result.plugin.name} · 运行失败</h4><p role="alert">本规则未完成，不能据此判断页面是否通过。</p><details><summary>失败原因</summary><pre>{result.error}</pre></details></section>;
  const { report, targetLabels } = result;
  const attention = report.checks.filter(c => c.verdict === 'unknown' || c.verdict === 'fail');
  const others = report.checks.filter(c => c.verdict !== 'unknown' && c.verdict !== 'fail');
  const warnings = report.checks.filter(c => c.severity === 'warning').length;
  const errors = report.checks.filter(c => c.severity === 'error').length;
  const checks = (items: RuleCheck[]) => <ul className="rule-checks">{items.map((check, i) => <Check key={i} check={check} labels={targetLabels} />)}</ul>;
  return <section className="rule-result" aria-label={`${result.plugin.name}结果`}>
    <h4>{result.plugin.name} · {verdicts[report.verdict]}</h4>
    <p className="rule-counts">{errors} 项错误 · {warnings} 项警告 · {report.checks.filter(c => c.verdict === 'unknown').length} 项未判定 · {report.checks.filter(c => c.verdict === 'pass').length} 项通过 · {report.checks.filter(c => c.verdict === 'not-applicable').length} 项不适用</p>
    {checks(attention)}
    {!!others.length && <details><summary>通过与不适用的结果（{others.length}）</summary>{checks(others)}</details>}
  </section>;
}

/** The parent keys this component by session and inspection, keeping async results scoped. */
export function RulePluginPanel({ api, sessionId, inspectionId, revision }: { api: InteractionClient; sessionId: string; inspectionId: string; revision?: number }) {
  const [plugins, setPlugins] = useState<RulePluginInfo[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [runs, setRuns] = useState<RulePluginRun[]>([]);
  const [activeRun, setActiveRun] = useState('');
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [automation, setAutomation] = useState<RuleAutomation | null>(null);
  const mounted = useRef(false);
  const retry = useRef<RulePluginRunRequest | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    void Promise.all([api.rulePlugins(), api.ruleRuns(sessionId, inspectionId)]).then(([catalogue, history]) => {
      if (!active) return;
      setPlugins(catalogue.plugins); setSelected(catalogue.plugins.map(p => p.id)); setRuns(history.items); setActiveRun(history.items[0]?.id || '');
    }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, sessionId, inspectionId, reload]);
  useEffect(() => {
    let active = true;
    void Promise.all([api.ruleAutomation(sessionId), api.ruleRuns(sessionId, inspectionId)]).then(([state, history]) => {
      if (!active) return;
      setAutomation(state.automation); setRuns(history.items);
      setActiveRun(id => history.items.some(r => r.id === id) ? id : history.items[0]?.id || '');
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api, sessionId, inspectionId, revision, reload]);
  const configure = async (enabled: boolean) => {
    setBusy(true); setError('');
    try {
      const result = await api.setRuleAutomation(sessionId, { enabled, plugins: plugins.filter(p => selected.includes(p.id)).map(({ id, version }) => ({ id, version })) });
      if (mounted.current) setAutomation(result);
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const run = async () => {
    const choices = plugins.filter(p => selected.includes(p.id)).map(({ id, version }) => ({ id, version }));
    const request = retry.current && JSON.stringify(retry.current.plugins) === JSON.stringify(choices) ? retry.current : { requestId: crypto.randomUUID(), plugins: choices };
    retry.current = request; setBusy(true); setError('');
    try {
      const result = await api.runRules(sessionId, inspectionId, request);
      if (!mounted.current) return;
      retry.current = undefined; setRuns(old => [result, ...old.filter(r => r.id !== result.id)]); setActiveRun(result.id);
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const current = runs.find(r => r.id === activeRun);
  return <section className="rule-plugins" aria-label="规则插件">
    <h3>规则插件</h3>
    <p className="muted">检查当前所选任务，并利用此前的探索记录复核。检测只读取已保存的证据，不滚动或操作页面；探索可以继续。</p>
    <p className="muted">按已安装规则的配置检查；项目规范和 agent 提案尚未接入自动裁决。“未判定”包含已观察到但尚未判定违规的警告、历史记录和检查范围限制，并非都在等待后续观察。单个采样通过也不代表整个页面无问题。</p>
    <p role="status">自动检查：{automation ? ({ watching: '等待新的采集', checking: '正在处理采集', paused: '已关闭', failed: '处理失败' }[automation.status]) : '未开启'}{automation?.enabled && ` · 已处理 ${automation.completedCount} 条采集 · ${automation.plugins.length} 个规则`}</p>
    {automation?.error && <p role="alert">{automation.error}</p>}
    {loading ? <p role="status">正在加载规则与检测记录…</p> : <>
      <fieldset disabled={busy} className="rule-choices"><legend>选择检查规则</legend>{plugins.map(plugin => <label key={plugin.id}>
        <input type="checkbox" checked={selected.includes(plugin.id)} onChange={e => setSelected(old => e.target.checked ? [...old, plugin.id] : old.filter(id => id !== plugin.id))} />
        <span><b>{plugin.name}</b><small>{plugin.description}</small></span>
      </label>)}</fieldset>
      {!plugins.length && <p>当前服务未安装规则插件。</p>}
      <button disabled={busy || !selected.length} onClick={() => void run()}>{busy ? '正在检测…' : '运行选中规则'}</button>
      <button disabled={busy || !selected.length} onClick={() => void configure(true)}>自动检查使用选中规则</button>
      {automation?.enabled && <button disabled={busy} onClick={() => void configure(false)}>关闭自动检查</button>}
    </>}
    {error && <div role="alert" className="gap">{error} <button disabled={busy} onClick={() => setReload(n => n + 1)}>重新加载</button></div>}
    {busy && <p role="status">正在读取历史采集。离开此页后，可返回查看已保存的结果。</p>}
    {!!runs.length && <label>检测记录<select aria-label="选择检测记录" value={activeRun} onChange={e => setActiveRun(e.target.value)}>{runs.map((r, i) => <option key={r.id} value={r.id}>{new Date(r.completedAt).toLocaleString()} · {r.results.length} 个规则{i === 0 ? ' · 最近一次' : ''}</option>)}</select></label>}
    {current && <div className="rule-run-results"><p>{current.origin === 'automatic' ? '遍历自动检测' : '手动检测'}已保存 · 共读取 {current.history.count} 条采集（#{current.history.firstSequence}—#{current.history.lastSequence}）</p>{current.results.map(result => <Result key={result.plugin.id} result={result} />)}<details><summary>完整检测记录</summary><pre>{JSON.stringify(current, null, 2)}</pre></details></div>}
    {!loading && !runs.length && <p className="muted">此任务尚未运行规则检测。</p>}
  </section>;
}
