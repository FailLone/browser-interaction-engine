import React from 'react';
import type { BrowserCompletionAudit } from '@interaction/browser';

export function CompletionSummary({ audit }: { audit: BrowserCompletionAudit }) {
  const limits = audit.gaps.filter(g => !g.diagnostic);
  return <div className="completion-summary" aria-label="整页完成判定">
    <b>整页穷尽尚未证明</b>
    <span>已观察 {audit.scopes.length} 个页面范围 · 操作依据未确认 {audit.unconfirmedControls.length} · 发现与观察限制 {limits.length}</span>
    <small>已记录操作处理完毕，不表示所有入口均已发现。上层决定不测的项目保留未执行；历史目的页的缺口不要求重新进入该页。</small>
    <details><summary>按页面范围查看缺口</summary>{audit.scopes.map(s => {
      const gaps = limits.filter(g => g.scopeKey === s.key);
      return <div key={s.key}><b>{s.url}</b><p>{s.instanceScopes.length} 个文档 · {s.observationIds.length} 次观察 · 未确认控件 {s.unconfirmedControlIds.length}</p>
        {s.pageDecisions.map(g => { const d = g.decisions.at(-1); return <p key={g.id}>页面决定：{d ? `${{all:'穷尽该范围',sample:'指定样本',skip:'不深入',defer:'暂缓'}[d.decision.mode]} · ${d.decision.source} · 版本 ${d.revision}` : '等待上层决定'}{g.status === 'invalidated' ? '（已失效的历史决定）' : ''}</p>; })}
        {gaps.length ? <ul>{gaps.map(g => <li key={g.id}>{g.code} · {g.current ? '当前仍有' : '历史记录'} · 出现在 {g.observationIds.length} 次观察{g.criticalObservationIds.length ? `，其中 ${g.criticalObservationIds.length} 次为关键缺口` : ''}</li>)}</ul>
          : <p>没有已记录的限制；仍不等于发现完整。</p>}</div>;
    })}</details>
  </div>;
}
