import React, { useState } from 'react';
import type { Command, ExplorationGroupDecision, ExplorationReviewMaterial } from '@interaction/browser';

const modes = { all: '穷尽所选范围', sample: '仅测所选样本', defer: '暂缓所选范围', skip: '本轮不测所选范围' };
const status = { all: '穷尽', sample: '指定样本', defer: '暂缓', skip: '本轮不测' };
export function ExplorationReviewPanel({ material, busy, decide }: { material: ExplorationReviewMaterial; busy: boolean; decide: (command: Command) => Promise<unknown> }) {
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [samples, setSamples] = useState<Record<string, string[]>>({});
  const groups = new Map(material.groups.map(g => [g.id, g]));
  const entries = Object.entries(selected);
  const stale = entries.some(([id, revision]) => groups.get(id)?.revision !== revision);
  const disabled = busy || !entries.length || entries.length > 1000 || stale;
  const submit = async (mode: ExplorationGroupDecision['mode']) => { const result = await decide({ type: 'decideExplorationGroups', resolutions: entries.map(([groupId, revision]) => ({ groupId, revision,
    decision: { mode, ...(mode === 'sample' ? { memberKeys: samples[groupId] || [] } : {}), source: 'debug-ui', evidence: [`用户批量选择：${modes[mode]}；范围版本 ${revision}`] } as ExplorationGroupDecision,
  })) }); if (result !== undefined) { setSelected({}); setSamples({}); } };
  return <section aria-label="探索范围决策" className="exploration-review">
    <p className="muted">按观察到的来源整理。选择只对列出的范围生效；新范围需另行决定。重叠范围须全部允许同一项操作，仍会检查当前控件和执行条件。</p>
    <div className="review-toolbar"><span>已选 {entries.length} 个范围</span><button disabled={busy || !entries.length} onClick={() => { setSelected({}); setSamples({}); }}>清空选择</button>
      {(Object.keys(modes) as ExplorationGroupDecision['mode'][]).map(mode => <button key={mode} disabled={disabled || mode === 'sample' && entries.some(([id]) => !samples[id]?.length)} onClick={() => void submit(mode)}>{modes[mode]}</button>)}
    </div>
    {stale && <p role="status">所选范围已变化，请清空后重新选择。</p>}
    {entries.length > 1000 && <p role="status">单次最多提交 1000 个范围，请减少选择。</p>}
    <p className="muted">提交决定不会启动探索；点击 DFS 探索继续。暂缓和本轮不测都保留未覆盖记录。</p>
    {!material.groups.length && <p className="empty">尚未发现需要决定的范围。</p>}
    {material.collections.map(c => <details className="review-collection" key={c.key} open={material.collections.length < 5}>
      <summary>{c.label} · {c.groupIds.length} 个范围</summary>
      <button disabled={busy} onClick={() => setSelected(old => ({ ...old, ...Object.fromEntries(c.groupIds.map(id => [id, groups.get(id)!.revision])) }))}>选择此组当前 {c.groupIds.length} 项</button>
      {c.groupIds.map(id => { const g = groups.get(id)!; const overlaps = material.overlaps.filter(o => o.groupIds.includes(id)); const latest = g.decisions.at(-1);
        return <div className="review-scope" key={id}><label className="review-scope-title"><input type="checkbox" aria-label={`选择范围：${g.label}`} checked={selected[id] !== undefined} disabled={busy} onChange={e => setSelected(old => { const next = { ...old }; if (e.target.checked) next[id] = g.revision; else delete next[id]; return next; })} /><b>{g.label}</b><span className="badge">{latest?.invalidation ? '等待重新决定' : latest ? status[latest.decision.mode] : '等待决定'}</span></label>
          <small>{g.kind} · 版本 {g.revision} · 已观察 {g.members.length} 个操作样本{g.observationId !== material.observationId ? ' · 来自较早观察' : ''}</small>
          {latest?.invalidation && <p role="status">原决定已失效，请重新确认。原因：{latest.invalidation.reason}</p>}
          {!!overlaps.length && <p className="muted">重叠约束：{[...new Set(overlaps.flatMap(o => o.groupIds.filter(other => other !== id)))].map(other => groups.get(other)!.label).join('、')}</p>}
          <details><summary>查看样本与判断依据</summary><p className="muted">样本仅包含已发现的操作，不代表全部业务组合。勾选样本后同时选择所属范围，再提交“仅测所选样本”。</p>
            {g.members.map(m => <label className="review-sample" key={m.key}><input type="checkbox" aria-label={`样本：${g.label}：${m.label || m.kind}：${m.key}`} disabled={busy} checked={samples[id]?.includes(m.key) || false} onChange={e => setSamples(old => ({ ...old, [id]: e.target.checked ? [...old[id] || [], m.key] : (old[id] || []).filter(key => key !== m.key) }))} />{m.label || m.kind} · {m.kind}{m.value !== undefined ? ` · ${JSON.stringify(m.value)}` : ''}{m.excluded ? ' · 当前不可执行' : ''}</label>)}
            <pre>{JSON.stringify({ conditions: g.conditions, scopeEvidence: g.evidence, collectionEvidence: c.evidence, latestDecision: latest }, null, 2)}</pre>
          </details>
        </div>;
      })}
    </details>)}
  </section>;
}
