import React from 'react';
import type { BrowserCompletionAudit } from '@interaction/browser';

export function CompletionSummary({ audit }: { audit: BrowserCompletionAudit }) {
  const limits = audit.gaps.filter(g => !g.diagnostic);
  const discovery = audit.discovery?.find(d => d.current)?.scan;
  return <div className="completion-summary" aria-label="整页完成判定">
    <b>整页穷尽尚未证明</b>
    <span>已观察 {audit.scopes.length} 个页面范围 · 操作依据未确认 {audit.unconfirmedControls.length} · 发现与观察限制 {limits.length}</span>
    <span>上层分类：展示内容 {audit.controls.display} · 容器 {audit.controls.containers}（均不计执行覆盖）</span>
    <small>已记录操作处理完毕，不表示所有入口均已发现。上层决定不测的项目保留未执行；历史目的页的缺口不要求重新进入该页。</small>
    {discovery && <details><summary>当前扫描范围与遗漏位置</summary>
      <p>信号扫描 {discovery.signal.scanned} / {discovery.nodeCount} 个节点，尚有 {discovery.signal.omitted} 个节点未扫描。补采只更新观察材料，不会执行操作。</p>
      {discovery.signal.firstOmitted && <p>首个未扫描位置：{discovery.signal.firstOmitted.selector}</p>}
      {discovery.supplement && <p>补采窗口：{discovery.supplement.status === 'active' ? '有效' : '已失效，需重新指定'}</p>}
      <ul>{discovery.structural.omissions.map((o, i) => <li key={i}>{o.rowSelector || o.ownerSelector} · {{template_nodes:'记录内容超过扫描上限',template_depth:'记录层级超过扫描上限',row_window:'部分记录未扫描',collections:'列表数量超过扫描上限'}[o.kind]}</li>)}</ul>
      {!!discovery.structural.omittedLocations && <p>另有 {discovery.structural.omittedLocations} 处限制未逐项列出。</p>}
    </details>}
    <details><summary>按页面范围查看缺口</summary>{audit.scopes.map(s => {
      const gaps = limits.filter(g => g.scopeKey === s.key);
      return <div key={s.key}><b>{s.url}</b><p>{s.instanceScopes.length} 个文档 · {s.observationIds.length} 次观察 · 未确认控件 {s.unconfirmedControlIds.length}</p>
        {s.pageDecisions.map(g => { const d = g.decisions.at(-1); return <p key={g.id}>页面决定：{d?.invalidation ? '原决定已失效，等待上层重新决定' : d ? `${{all:'穷尽该范围',sample:'指定样本',skip:'不深入',defer:'暂缓'}[d.decision.mode]} · ${d.decision.source} · 版本 ${d.revision}` : '等待上层决定'}{g.status === 'invalidated' ? '（已失效的历史决定）' : ''}</p>; })}
        {gaps.length ? <ul>{gaps.map(g => <li key={g.id}>{g.code} · {g.current ? '当前仍有' : '历史记录'} · 出现在 {g.observationIds.length} 次观察{g.criticalObservationIds.length ? `，其中 ${g.criticalObservationIds.length} 次为关键缺口` : ''}</li>)}</ul>
          : <p>没有已记录的限制；仍不等于发现完整。</p>}</div>;
    })}</details>
  </div>;
}
