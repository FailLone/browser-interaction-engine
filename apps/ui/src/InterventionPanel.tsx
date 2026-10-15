import React, { useState } from 'react';
import type { Command, ContinuationRecord, InterventionMaterial } from '@interaction/browser';

const status = { awaiting_decision: '等待决定', deferred: '已暂缓', skipped: '本轮不测', blocked: '需要处理', failed: '结果待核实' };
export function InterventionPanel({ material, busy, perform, navigate, inspect }: {
  material: InterventionMaterial; busy: boolean; perform: (command: Command) => Promise<unknown>;
  navigate: (tab: string) => void; inspect: (observationId: string) => void;
}) {
  const [limit, setLimit] = useState(50), [result, setResult] = useState<ContinuationRecord>();
  const byId = new Map(material.items.map(i => [i.id, i]));
  const pending = material.items.filter(i => !['skipped', 'deferred'].includes(i.status));
  return <section aria-label="上游待处理事项" data-revision={material.revision}>
    <p>待处理 {pending.length} 项 · 可优先处理 {material.readyIds.length} 项 · 需要先解除的会话阻塞 {material.sessionBlockerIds.length} 项</p>
    <p className="muted">同一原因合并展示，依赖事项保留。答复不等于操作成功；处理后重新验证现场，再继续已获准的工作。暂缓和不测仍保留未覆盖。</p>
    <button disabled={busy} onClick={async () => {
      const response = await perform({ type: 'continueExploration', continuation: { requestId: crypto.randomUUID(), observationId: material.observationId, source: 'debug-ui', evidence: ['用户请求重新验证当前现场并继续已获准工作'] } });
      if (response) setResult((response as { continuation: ContinuationRecord }).continuation);
    }}>重新验证并继续</button>
    {result && <div role="status"><p>{result.started ? '已完成本次恢复前验证，探索已启动；仍待决定的范围继续保留。' : '尚未满足继续条件，已保留现场与原因。'}</p>
      <details><summary>查看本次验证</summary><ul>{result.checks.map((c, i) => <li key={i}>{c.name} · {{ pass: '通过', fail: '不符合', unknown: '未确认' }[c.result]}{c.evidence?.length ? ` · ${c.evidence.join('；')}` : ''}</li>)}</ul>{result.error && <p>{result.error.message}</p>}</details>
    </div>}
    {!material.items.length && <p>没有当前待处理事项；这不表示整页发现或测试已完成。</p>}
    {material.items.slice(0, limit).map(item => <article className="review-scope" key={item.id}>
      <div className="data-row"><b>{item.title}</b><span className="badge">{status[item.status]}</span>{!item.current && <span>来自历史范围</span>}</div>
      <p>{item.reason} · 影响 {item.affected.frontierIds.length} 个已记录操作</p>
      {!!item.dependsOn.length && <p>建议先处理：{item.dependsOn.map(id => byId.get(id)?.title || id).join('、')}</p>}
      <ul>{item.options.map(o => <li key={o.command}>{o.label}：{o.effect}</li>)}</ul>
      {['region', 'exploration', 'boundary'].includes(item.kind) && <button disabled={busy} onClick={() => navigate('review')}>打开范围与退出审阅</button>}
      {item.kind === 'identity' && <button disabled={busy} onClick={() => navigate('identity')}>打开身份审阅</button>}
      {item.subject.checkpointId && <button disabled={busy} onClick={() => navigate('checkpoints')}>打开检查点</button>}
      {item.evidence.observationIds[0] && <button onClick={() => inspect(item.evidence.observationIds[0])}>查看来源观察</button>}
      <details><summary>证据与处理接口</summary>{item.evidence.messages.map((m, i) => <p key={i}>{m}</p>)}<pre>{JSON.stringify({ material: item.material, subject: item.subject, evidence: item.evidence, options: item.options, interventionId: item.id, conditionKey: item.conditionKey }, null, 2)}</pre></details>
    </article>)}
    {material.items.length > limit && <button onClick={() => setLimit(n => n + 50)}>再显示 50 项（共 {material.items.length} 项）</button>}
  </section>;
}
