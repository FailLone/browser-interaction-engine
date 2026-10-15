import React, { useState } from 'react';
import type { BoundaryExitMaterial, Command, Observation } from '@interaction/browser';

export function BoundaryExitPanel({ material, observation, busy, perform }: {
  material: BoundaryExitMaterial; observation?: Observation; busy: boolean; perform: (c: Command) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<{ material: BoundaryExitMaterial; observation: Observation }>();
  const [candidateId, setCandidateId] = useState(''); const [preserved, setPreserved] = useState<string[]>([]); const [reason, setReason] = useState('');
  const stale = !!draft && draft.material.observationId !== material.observationId;
  const result = material.results.at(-1);
  if (!material.boundary && !result) return null;
  const submit = async (attempt: boolean) => {
    if (!draft) return;
    const response = await perform({ type: 'reviewBoundaryExit', review: { observationId: draft.material.observationId,
      boundaryKey: draft.material.boundary!.key, source: 'debug-ui', evidence: [reason.trim()],
      decision: attempt ? { mode: 'attempt', candidateId, preserveControlIds: preserved } : { mode: 'defer' } } });
    if (response !== undefined) setDraft(undefined);
  };
  return <section aria-label="弹层退出审阅" className="region-review">
    <h3>弹层退出审阅</h3>
    <p>空白位置只是候选。确认其用途后可批准一次尝试；执行后分别验证弹层关闭、父页面就绪和指定字段未改变。</p>
    {result && <p role="status">最近结果：{{ verified: '已验证退出', not_closed: '弹层未关闭', changed: '页面或指定字段已改变', unverified: '退出结果未验证' }[result.status]}；弹层关闭：{result.closed ? '是' : '否'}；父页面就绪：{result.parentReady ? '是' : '否'}；指定字段保留：{result.preserved ? '是' : '否'}</p>}
    {material.boundary && <>
      <p>当前弹层：{material.boundary.name || material.boundary.selector}；已尝试 {material.attempts.length} 次退出。</p>
      <button disabled={busy || observation?.id !== material.observationId} onClick={() => { setDraft({ material, observation: observation! }); setCandidateId(''); setPreserved([]); setReason(''); }}>查看当前退出候选</button>
      {draft && <>
        {stale && <p role="status">观察已更新，请重新载入退出候选。</p>}
        {draft.material.candidates.map(c => <div className="data-row" key={c.id}>
          <label><input type="radio" name="exit-point" disabled={busy || stale || c.attempted} checked={candidateId === c.id} onChange={() => setCandidateId(c.id)} />位置 ({c.point.x}, {c.point.y}) · {c.tag}{c.attempted ? ' · 本次已尝试' : ''}</label>
          <details><summary>查看依据</summary><p>{c.selector}</p><pre>{JSON.stringify({ point: c.point, rect: c.rect, evidence: c.evidence }, null, 2)}</pre></details>
        </div>)}
        {!draft.material.candidates.length && <p>当前没有可供审阅的外部点击位置。</p>}
        <details><summary>选择退出后必须保留的控件</summary>{draft.observation.controls.filter(c => c.visible).map(c => <label className="data-row" key={c.localId}><input type="checkbox" disabled={busy || stale} checked={preserved.includes(c.localId)} onChange={e => setPreserved(ids => e.target.checked ? [...ids, c.localId] : ids.filter(id => id !== c.localId))} />{c.name || c.role} · {c.selector} · {String(c.value ?? c.selected ?? c.checked ?? '')}</label>)}</details>
        <p className="muted">仅验证所选控件、文档、地址和声明的上下文；不代表未声明的服务端状态已恢复。</p>
        <label>判断依据<input aria-label="退出判断依据" value={reason} disabled={busy || stale} onChange={e => setReason(e.target.value)} /></label>
        <button disabled={busy || stale || !candidateId || !reason.trim()} onClick={() => void submit(true)}>批准一次退出尝试</button>
        <button disabled={busy || stale || !reason.trim()} onClick={() => void submit(false)}>暂缓退出判断</button>
      </>}
    </>}
  </section>;
}
