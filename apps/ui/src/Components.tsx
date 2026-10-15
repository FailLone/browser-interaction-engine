import { useEffect, useState } from 'react';
import type { InteractionClient } from '@interaction/client';
import type { ComponentDetails, Observation } from '@interaction/browser';

export function Components({ api, sessionId, observation, openDom }: { api: InteractionClient; sessionId: string; observation: Observation; openDom: (id: string) => void }) {
  const [selected, setSelected] = useState(observation.components?.[0]?.id || '');
  const [details, setDetails] = useState<ComponentDetails>(); const [error, setError] = useState(''); const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    let active = true; setDetails(undefined); setError(''); setImageFailed(false);
    if (selected) void api.componentDetails(sessionId, observation.id, selected).then(d => { if (active) setDetails(d); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api, sessionId, observation.id, selected]);
  const r = details?.screenshotRegion; const v = observation.viewport;
  const inView = r && r.width > 0 && r.height > 0 && r.x < v.width && r.y < v.height && r.x + r.width > 0 && r.y + r.height > 0;
  const imageAvailable = details?.screenshot && details.availability.screenshot?.status === 'available' && !imageFailed;
  const base = `/v1/sessions/${encodeURIComponent(sessionId)}/observations/${encodeURIComponent(observation.id)}`;
  return <div className="control-inspector"><aside><div className="control-picker">{observation.components?.map(c => <button key={c.id} aria-pressed={selected === c.id} onClick={() => setSelected(c.id)}><b>{c.name || '未命名组'}</b><small>{c.kind} · {c.members.length} 个成员</small></button>)}</div></aside>
    <section aria-label="复合控件详情">
      <p className="muted">组描述逻辑关系；成员仍保留独立身份和操作目标。结构推测不代表已确认业务含义。</p>
      {!selected && <p>这次观察没有记录复合控件。</p>}{error && <p role="alert">{error}</p>}
      {selected && !details && !error && <p role="status">正在读取组件证据…</p>}
      {details && <><h4>{details.component.name || '未命名组'}</h4><p>{details.component.kind} · {details.component.basis.status === 'tentative' ? '结构推测，待验证' : '页面声明'}</p>
        <table><thead><tr><th>成员</th><th>角色</th><th>显式值</th><th>选中状态</th></tr></thead><tbody>{details.members.map(m => <tr key={m.localId}><td>{m.name || '未命名'}<small> · {m.localId}</small></td><td>{m.role}</td><td>{m.value === undefined ? '未知' : JSON.stringify(m.value)}</td><td>{m.selected === undefined ? '未知' : String(m.selected)}</td></tr>)}</tbody></table>
        <figure><figcaption>观察时的局部截图</figcaption>{inView && imageAvailable ? <svg role="img" aria-label="复合控件局部截图" style={{ width: '100%', maxWidth: 500, maxHeight: 300 }} viewBox={`${Math.max(0, r.x - 16)} ${Math.max(0, r.y - 16)} ${Math.min(v.width - Math.max(0, r.x - 16), r.width + 32)} ${Math.min(v.height - Math.max(0, r.y - 16), r.height + 32)}`}><image href={`${base}/artifacts/screenshot`} width={v.width} height={v.height} onError={() => setImageFailed(true)} /></svg> : <p className="muted">{!inView ? '该组件当时不在可见视口内。' : '截图未留存、已过期或读取失败。'}</p>}</figure>
        <button onClick={() => openDom(details.component.rootNodeId)}>查看组件 DOM 子树</button>
        {([['结构依据', details.component.basis], ['成员、状态与操作', details.members], ['祖先与局部子树', { ancestors: details.ancestors, subtree: details.subtree, children: details.children }], ['外部解释（保留来源）', details.descriptions], ['同一节点实例的观察历史', { timeline: details.timeline, truncated: details.timelineTruncated }], ['采集缺口', details.gaps]] as const).map(([title, value]) => <details key={title} className="evidence-section"><summary>{title}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>)}
        <a href={`${base}/components/${encodeURIComponent(selected)}`} target="_blank" rel="noreferrer">打开组件证据 API ↗</a>
      </>}
    </section></div>;
}
