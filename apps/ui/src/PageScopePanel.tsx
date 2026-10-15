import React from 'react';
import type { Command, ExplorationGroup } from '@interaction/browser';

export function PageScopePanel({ groups, busy, decide }: { groups: ExplorationGroup[]; busy: boolean; decide: (command: Command) => Promise<unknown> }) {
  const pages = groups.filter(g => g.kind === 'page' && g.binding === 'context' && g.status !== 'invalidated');
  if (!pages.length) return null;
  const labels = { all: '允许本页', sample: '仅指定样本', defer: '暂缓', skip: '本轮不测' };
  return <section className="panel page-scope-panel" aria-label="跳转页面范围">
    <div className="panel-title"><h2>跳转页面范围</h2><span>允许本页不会批准它通往的其他页面</span></div>
    <div className="page-scope-content"><p className="muted">未决定的页面先保留待测，系统尝试返回来源页面。调整决定后，点击 DFS 探索继续。</p>
      {pages.map(g => <div className="action-row" key={g.id}><div className="action-label"><b>{g.label}</b>
        <small>{g.conditions && typeof g.conditions === 'object' && !Array.isArray(g.conditions) ? String(g.conditions.url || '') : ''}</small></div>
        <span className="badge">{g.decisions.at(-1)?.invalidation ? '等待重新决定' : g.decisions.length ? labels[g.decisions.at(-1)!.decision.mode] : '等待决定'}</span>
        {(['all', 'defer', 'skip'] as const).map(mode => <button key={mode} disabled={busy} aria-label={`${labels[mode]}：${g.label}`} onClick={() => void decide({
          type: 'decideExplorationGroup', groupId: g.id, revision: g.revision,
          decision: { mode, source: 'debug-ui', evidence: [`用户选择${labels[mode]}：${g.label}；范围版本 ${g.revision}`] },
        })}>{labels[mode]}</button>)}
      </div>)}
    </div>
  </section>;
}
