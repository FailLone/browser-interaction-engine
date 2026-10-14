import React, { useCallback, useEffect, useRef, useState } from 'react';
import { prepareIdentityReview, includeIdentityImages, identityDecisionCommand, type IdentityReview, type IdentityExhibit, type InteractionClient } from '@interaction/client';
import type { Control, ControlIdentity, IdentityHypothesis, Observation } from '@interaction/browser';

type Props = {
  api: InteractionClient; sessionId: string; hypotheses: IdentityHypothesis[]; current?: Observation; disabled: boolean;
  resolve: (hypothesisId: string, identityId: string, evidence: string[]) => Promise<unknown>;
};
type Example = { identityId: string; observation?: Observation; control?: Control; simultaneous: boolean; missing?: string };
const roles: Record<string, string> = { textbox: '文本输入框', spinbutton: '数字输入框', button: '按钮', combobox: '选择框', checkbox: '复选框', radio: '单选框', link: '链接', slider: '滑块', tab: '标签页', menuitem: '菜单项', option: '选项', switch: '开关' };
const nameOf = (c?: Control) => c?.name || c?.label || c?.displayedText || '未命名控件';
const typeOf = (c?: Control) => c ? roles[c.role] || c.role || c.tag : '类型未记录';
const regionOf = (c?: Control, o?: Observation) => !c ? '区域未记录' : o?.regions.find(r => r.key === c.region)?.label || (c.region === 'document' ? '页面主体' : c.region);
const timeOf = (o?: Observation) => o ? new Date(o.capturedAt).toLocaleString() : '时间未记录';
const evidenceText: Record<string, string> = {
  'scoped-stable-key': '按所在区域和页面提供的控件标识查找过往记录。',
  'compatible-role': '候选记录的控件类型相同。',
  'adapter-semantic-signature': '按控件的名称、类型、所属区域等特征查找相似记录。',
  'duplicate-current-candidates': '本次页面里有多个控件符合相同的识别特征，无法一一对应。',
  'external-resolution': '曾使用外部提供的判断。',
  'same-instance': '仍是同一个页面元素。',
  'instance-rebuilt': '页面元素已重新创建。',
  'business-binding-changed': '记录的业务上下文发生了变化。',
  'competing-current-matches': '多个当前控件试图沿用同一条记录，系统已暂停自动关联。',
};

export function IdentityPanel({ api, sessionId, hypotheses, current, disabled, resolve }: Props) {
  const [identities, setIdentities] = useState<ControlIdentity[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const observations = useRef(new Map<string, Promise<Observation>>());
  const loadObservation = useCallback((id: string) => {
    let result = observations.current.get(id);
    if (!result) {
      result = api.observation(sessionId, id).catch(error => { observations.current.delete(id); throw error; });
      observations.current.set(id, result);
    }
    return result;
  }, [api, sessionId]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void (async () => {
      const all: ControlIdentity[] = [];
      // Sessions can contain more than the API's per-page limit of 1,000 identities.
      for (;;) {
        const page = await api.list<ControlIdentity>(sessionId, 'identities', { offset: all.length, limit: 1000 });
        all.push(...page.items);
        if (cancelled) return;
        if (!page.items.length || all.length >= page.total) break;
      }
      if (!cancelled) setIdentities(all);
    })().catch(() => { if (!cancelled) setError('控件记录加载失败，请重试后再确认。'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, sessionId, current?.id, retry]);
  const ordered = [...hypotheses].sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved'));
  const active = ordered.find(h => h.id === selected) || ordered[0];
  useEffect(() => { if (active && selected !== active.id) setSelected(active.id); }, [active?.id, selected]);
  const pending = hypotheses.filter(h => h.status === 'pending').length;
  return <section className="identity-panel" aria-label="控件身份确认">
    <div className="identity-intro"><h3>帮系统认清：这是哪个控件？</h3><p>“身份歧义”表示系统看到了相似控件，无法确定它们是否是同一个。请先对照当时的截图，再决定单独记录，还是沿用已有控件的记录。</p><p>确认前，相关操作会暂缓；看不准可以先留待确认，继续查看其他控件。</p></div>
    <div className="identity-counts"><b>{pending} 项待确认</b><span>{hypotheses.length - pending} 项已确认</span></div>
    {error && <div role="alert" className="identity-notice">{error}<button onClick={() => setRetry(n => n + 1)}>重新加载控件</button></div>}
    {!active ? <div className="empty">当前没有需要确认的控件。</div> : <div className="identity-workbench">
      <nav className="identity-cases" aria-label="待确认与已确认的控件">{ordered.map(h => {
        const c = identities.find(i => i.id === h.provisionalIdentityId)?.lastControl;
        const number = hypotheses.indexOf(h) + 1;
        return <button key={h.id} aria-pressed={active.id === h.id} onClick={() => setSelected(h.id)}><span>控件 {number} · {h.status === 'pending' ? '待确认' : '已确认'}</span><b>{loading && !c ? '正在读取控件…' : nameOf(c)}</b><small>{typeOf(c)} · {h.candidateIds.length} 个相似记录</small></button>;
      })}</nav>
      <IdentityCase api={api} sessionId={sessionId} key={active.id} hypothesis={active} current={current} loadObservation={loadObservation} disabled={disabled || loading || !!error} resolve={resolve} />
    </div>}
  </section>;
}

function IdentityCase({ api, sessionId, hypothesis: h, current, loadObservation, disabled, resolve }: {
  api: InteractionClient; sessionId: string; hypothesis: IdentityHypothesis; current?: Observation;
  loadObservation: (id: string) => Promise<Observation>; disabled: boolean; resolve: Props['resolve'];
}) {
  const [review, setReview] = useState<IdentityReview>();
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const [origin, setOrigin] = useState<Observation>();
  const [examples, setExamples] = useState<Example[]>([]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [originMissing, setOriginMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const packet = await prepareIdentityReview(api, sessionId, h.id);
      const observed = packet.target.control ? await loadObservation(h.observationId).catch(() => undefined) : undefined;
      const candidates = await Promise.all(packet.candidates.map(async candidate => ({
        identityId: candidate.identityId, control: candidate.exhibit.control, simultaneous: candidate.simultaneous,
        observation: candidate.exhibit.observationId ? await loadObservation(candidate.exhibit.observationId).catch(() => undefined) : undefined,
        missing: !candidate.exhibit.control ? '这条候选的原始控件记录不可用，无法核对，暂不能选择。' : undefined,
      })));
      if (!cancelled) { setReview(packet); setOrigin(observed); setOriginMissing(!observed); setExamples(candidates); setLoading(false); }
    })().catch(error => { if (!cancelled) { setReview(undefined); setLoading(false); setOriginMissing(true); setNotice(String(error)); } });
    return () => { cancelled = true; };
  }, [h.id, h.observationId, h.status, h.candidateIds.join(","), loadObservation, api, sessionId, current?.id, retry]);
  const target = origin?.controls.find(c => c.localId === h.localId);
  const unavailable = (example: Example) => example.missing || (example.simultaneous ? '与待确认控件在同一次观察中同时存在，是两个不同控件，不能合并。' : current?.controls.some(c => c.identityId === example.identityId && c.localId !== h.localId) ? '当前页面已有另一个控件使用这条记录，不能重复绑定。' : undefined);
  const chosen = examples.find(e => e.identityId === choice);
  const independent = choice === h.provisionalIdentityId;
  const validChoice = independent || !!chosen && !unavailable(chosen);
  const locked = disabled || submitting || loading || !current || !review;
  const cannotResolve = !target || !review?.current.targetPresent || review?.current.bindingChanged;
  const revision = h.revisions.at(-1);
  const multipleCurrent = h.conflicts.includes('multiple-current-controls');
  return <article className="identity-case" data-hypothesis-id={h.id} aria-label={`确认 ${nameOf(target)}`}>
    <header className="identity-case-title"><div><small>这次需要确认的控件</small><h3>{loading ? '正在加载当时的记录…' : `${nameOf(target)} · ${typeOf(target)}`}</h3></div><span className={`badge ${h.status}`}>{h.status === 'pending' ? '待确认' : '已确认'}</span></header>
    <div className="identity-explanation"><b>为什么分不清？</b><p>{multipleCurrent ? '当时页面中有多个控件具有相同的识别特征，系统无法确定每一个应对应哪条记录。' : '已有记录中存在相似控件，系统无法唯一确定这次看到的控件应沿用哪条记录。'}</p><ul>{h.evidence.filter(e => evidenceText[e]).map((e, index) => <li key={`${e}:${index}`}>{evidenceText[e]}</li>)}</ul><p>截图的位置帮助你区分控件；系统不会仅凭位置就自动把它们当作同一个。</p></div>
    {loading ? <p role="status">正在加载控件和截图位置…</p> : <>
      <div className="identity-comparison">
        <section className="identity-target"><h4>① 待确认控件</h4>{target && origin ? <><ControlEvidence control={target} observation={origin} label="待确认控件" /><DeclaredEvidence exhibit={review?.target} /></> : <p className="identity-notice">发生歧义时的控件记录不可用，暂不能确认。</p>}
          {target && !current?.controls.some(c => c.instanceId === target.instanceId) && <p className="identity-notice">当前页面未再观察到这个控件。这里显示的是历史记录，重新出现时可能仍需确认。</p>}
        </section>
        <section className="identity-alternatives"><h4>② 与这些相似记录对照</h4>{!examples.length && <p>没有可供沿用的记录。核对后可将它单独记录，也可以先留待确认。</p>}{examples.map((example, index) => <div key={example.identityId} className="identity-alternative">
          <div className="identity-example-title"><b>候选 {index + 1} · {nameOf(example.control)}</b><span>{example.simultaneous ? '当时同时出现' : '历史控件'}</span></div>
          {example.control && example.observation ? <><ControlEvidence control={example.control} observation={example.observation} label={`候选 ${index + 1}`} /><ComparisonFacts target={target} candidate={example.control} /><DeclaredEvidence exhibit={review?.candidates[index]?.exhibit} /></> : <p className="identity-notice">{example.missing}</p>}
          {!example.missing && unavailable(example) && <p className="identity-notice">{unavailable(example)}</p>}
        </div>)}</section>
      </div>
      {(originMissing || examples.some(e => e.missing)) && <button onClick={() => setRetry(n => n + 1)}>重新加载证据</button>}
    </>}
    {review && <div className="identity-review-context"><h4>变化经过与证据完整性</h4><p>{review.timeline.action ? `在「${review.timeline.action.action.label}」操作后记录了本次观察。` : review.timeline.note}</p><p>历史对照只使用本次歧义发生时或之前的最近记录。声明的记录标识、操作标识见各卡片；截图位置只能定位，不能证明历史身份。</p>{review.gaps.map((gap, i) => <p key={i} className="identity-notice">{gap}</p>)}<button type="button" disabled={exporting} onClick={async () => {
      setExporting(true); setNotice('');
      try {
        const packet = await includeIdentityImages(api, await prepareIdentityReview(api, sessionId, h.id));
        const url = URL.createObjectURL(new Blob([JSON.stringify(packet, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = `identity-review-${h.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('已导出裁决材料：包含目标、候选、来源时间、截图和缺失证据，可交给其他人或模型独立判断。');
      } catch (error) { setNotice(String(error)); } finally { setExporting(false); }
    }}>{exporting ? '正在整理截图…' : '导出完整裁决材料'}</button></div>}
    {notice && <p role="status" className="identity-notice">{notice}</p>}
    {h.status === 'pending' ? <form className="identity-decision" onSubmit={async event => {
      event.preventDefault();
      if (locked || (!validChoice && choice !== 'uncertain') || !reason.trim()) return;
      setSubmitting(true);
      try {
        const fresh = await prepareIdentityReview(api, sessionId, h.id);
        const command = identityDecisionCommand(fresh, { decision: choice === 'uncertain' ? 'uncertain' : independent ? 'independent' : 'same', candidateId: chosen?.identityId, reason, evidenceRefs: ['target', ...fresh.candidates.map(c => c.exhibit.ref)], missingEvidence: choice === 'uncertain' ? [reason] : undefined }, 'human-ui');
        if (command) await resolve(command.hypothesisId, command.identityId, command.evidence);
        else setNotice('已保留待确认：没有提交身份裁决，没有解除操作限制。缺失信息仅显示在本页，刷新后不会保存。');
      } catch (error) { setNotice(String(error)); } finally { setSubmitting(false); }
    }}>
      <fieldset disabled={locked}><legend>③ 你认为它是哪一个？</legend><p>选择是在确认控件之间的关系，不会点击或填写被测页面上的控件。</p>
        <label className={`identity-choice ${independent ? 'selected' : ''}`}><input type="radio" name={`identity-${h.id}`} value={h.provisionalIdentityId} checked={independent} onChange={e => setChoice(e.target.value)} /><span><b>这是独立控件，单独记录</b><small>仅在能排除上面所有候选时选择；不代表已证明不存在其他历史对应。</small></span></label>
        {examples.map((example, index) => <label key={example.identityId} className={`identity-choice ${choice === example.identityId ? 'selected' : ''} ${unavailable(example) ? 'unavailable' : ''}`}><input type="radio" name={`identity-${h.id}`} value={example.identityId} checked={choice === example.identityId} disabled={!!unavailable(example)} onChange={e => setChoice(e.target.value)} /><span><b>这是候选 {index + 1}「{nameOf(example.control)}」，沿用它的记录</b><small>{unavailable(example) || '把本次控件与这条历史记录关联，后续按同一个控件追踪。'}</small></span></label>)}
        <label className={`identity-choice ${choice === 'uncertain' ? 'selected' : ''}`}><input type="radio" name={`identity-${h.id}`} value="uncertain" checked={choice === 'uncertain'} onChange={e => setChoice(e.target.value)} /><span><b>证据不足，暂不确认</b><small>保留待确认和操作限制；请填写还缺少哪些信息。不会把未知关系当作独立控件。</small></span></label>
        <label className="identity-reason">{choice === 'uncertain' ? '还缺什么信息（必填）' : '判断理由（必填）'}<textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="例如：两个 Reference 输入框同时存在，这个在上方，应单独记录。" /></label>
      </fieldset>
      <div className="identity-consequence" aria-live="polite">{choice === 'uncertain' ? '不会提交裁决；相关操作继续等待确认。' : validChoice ? independent ? '将单独记录这个控件，并保存你的判断理由。' : `将把这个控件关联到候选 ${examples.indexOf(chosen!) + 1}「${nameOf(chosen?.control)}」，并保存你的判断理由。` : '先选择一种关系，再填写理由；如果还无法判断，可以暂不确认。'}<br />{choice === 'uncertain' ? '缺失信息说明仅在本页保留。取得更多证据后，可以回来重新判断。' : '确认后会重新观察当前页面，重新检查相关操作是否可用。已有历史观察保留原样；需要继续自动探索时，请点击“DFS 探索”。'}</div>
      <button className="primary" disabled={locked || (choice !== 'uncertain' && (!validChoice || cannotResolve)) || !reason.trim()}>{submitting ? '正在处理…' : choice === 'uncertain' ? '保留待确认' : '保存身份判断'}</button>
    </form> : <div className="identity-resolved" role="status"><b>已确认：{revision?.identityId === h.provisionalIdentityId ? '作为独立控件记录' : `沿用候选 ${h.candidateIds.indexOf(revision?.identityId || '') + 1} 的记录`}</b><p>判断理由：{revision?.evidence.join('；') || '未记录'}</p><small>{revision ? new Date(revision.at).toLocaleString() : ''} · {revision?.source === 'human-ui' ? '通过本界面确认' : `来源：${revision?.source || '未记录'}`}</small><p>确认后的观察会重新检查相关操作是否可用；这里仍保留发生歧义时的截图。</p></div>}
    <details className="identity-technical"><summary>技术记录（编号、原始原因与修订历史）</summary><pre>{JSON.stringify(h, null, 2)}</pre></details>
  </article>;
}

function ComparisonFacts({ target, candidate }: { target?: Control; candidate: Control }) {
  if (!target) return null;
  const same = [target.name === candidate.name ? `名称「${nameOf(candidate)}」` : '', target.role === candidate.role ? `类型「${typeOf(candidate)}」` : '', target.region === candidate.region ? '所在区域' : '', target.stableKey && target.stableKey === candidate.stableKey ? '页面提供的控件标识' : ''].filter(Boolean);
  const different = [target.name !== candidate.name ? '名称' : '', target.role !== candidate.role ? '类型' : '', target.region !== candidate.region ? '区域' : '', target.value !== candidate.value ? '当前值' : '', target.rect.x !== candidate.rect.x || target.rect.y !== candidate.rect.y ? '截图位置' : ''].filter(Boolean);
  return <div className="identity-similarity"><p><b>相同：</b>{same.join('、') || '系统记录的匹配特征相似，详见技术记录'}</p><p><b>不同：</b>{different.join('、') || '已显示的特征未能区分；外观相同也不代表是同一个控件'}</p></div>;
}

function ControlEvidence({ control: c, observation: o, label }: { control: Control; observation: Observation; label: string }) {
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setFull(false); setFailed(false); }, [o.id, c.localId]);
  const { width, height } = o.viewport;
  const r = c.rect;
  const inView = width > 0 && height > 0 && c.visible && r.width > 0 && r.height > 0 && r.x < width && r.y < height && r.x + r.width > 0 && r.y + r.height > 0;
  const cropWidth = Math.min(width, Math.max(r.width + 64, 300));
  const cropHeight = Math.min(height, Math.max(r.height + 80, 140));
  const x = Math.max(0, Math.min(width - cropWidth, r.x + r.width / 2 - cropWidth / 2));
  const y = Math.max(0, Math.min(height - cropHeight, r.y + r.height / 2 - cropHeight / 2));
  const src = `/v1/sessions/${o.sessionId}/evidence/${o.id}?retry=${retry}`;
  return <div className="identity-control">
    <div className="identity-control-name"><b>{nameOf(c)}</b><span>{typeOf(c)}</span></div>
    <dl><div><dt>所在区域</dt><dd>{regionOf(c, o)}</dd></div><div><dt>当时的值</dt><dd>{c.value || '空'}{c.checked !== null ? c.checked ? ' · 已勾选' : ' · 未勾选' : ''}</dd></div><div><dt>页面</dt><dd>{o.title || o.url}</dd></div></dl>
    <figure className="identity-snapshot">
      {failed || !o.screenshot ? <div className="identity-image-missing">当时的截图未保存或已过期，无法展示外观。<br />仍可核对上方的名称、类型和区域。{o.screenshot && <button type="button" onClick={() => { setFailed(false); setRetry(n => n + 1); }}>重试截图</button>}</div> : !inView && !full ? <div className="identity-image-missing">这个控件当时不在可见视口内，无法提供局部截图。</div> : <svg role="img" aria-label={`${label}「${nameOf(c)}」${full ? '整页位置' : '局部截图'}`} viewBox={full ? `0 0 ${width} ${height}` : `${x} ${y} ${cropWidth} ${cropHeight}`}>
        <image href={src} width={width} height={height} onError={() => setFailed(true)} />
        {inView && <rect className="identity-highlight" x={Math.max(0, r.x - 2)} y={Math.max(0, r.y - 2)} width={r.width + 4} height={r.height + 4} rx="3" vectorEffect="non-scaling-stroke" />}
      </svg>}
      <figcaption>{inView && (r.x < 0 || r.y < 0 || r.x + r.width > width || r.y + r.height > height) ? '控件部分超出当时截图范围 · ' : ''}记录于 {timeOf(o)}{inView && !failed && o.screenshot ? ' · 橙框是此控件' : ''}</figcaption>
    </figure>
    {o.screenshot && !failed && <button type="button" aria-pressed={full} onClick={() => setFull(v => !v)}>{full ? '返回局部截图' : '查看整页位置'}</button>}
  </div>;
}

function DeclaredEvidence({ exhibit: e }: { exhibit?: IdentityExhibit }) {
  if (!e) return null;
  const names: Record<string, string> = { 'data-row-key': '所属记录', 'data-item-key': '所属记录', 'data-key': '页面记录标识', 'data-operation-key': '记录内操作', 'data-business-field': '业务字段', 'data-testid': '测试标识（可能重复）', id: '页面元素标识（可能复用）', name: '表单字段名' };
  const nodes = [e.node, ...(e.ancestors || [])].filter(n => n && (n === e.node || Object.keys(n.attributes || {}).some(k => k.startsWith('data-'))));
  const facts = nodes.flatMap(n => Object.entries(n!.attributes || {}).filter(([key]) => key in names || key.startsWith('data-')).map(([key, value]) => ({ key: `${n!.id}:${key}`, label: names[key] || `页面声明 ${key.slice(5)}`, value })));
  return <div className="identity-declared"><b>页面提供的识别线索</b>{facts.length ? <dl>{facts.map(f => <div key={f.key}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl> : <p>{e.node ? '页面没有提供可区分重复控件的记录或操作标识。' : '详细记录不可用，无法核对当时的识别线索。'}</p>}{e.gaps.length > 0 && <details><summary>证据缺口（{e.gaps.length}）</summary><ul>{e.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul></details>}<details><summary>原始属性与证据编号</summary><small>{e.ref} · {e.domCapturedAt || e.capturedAt}</small>{nodes.map(n => <pre key={n!.id}>{JSON.stringify(n!.attributes || {}, null, 2)}</pre>)}</details></div>;
}
