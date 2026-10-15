import React, { useState } from 'react';
import type { Command, RegionReviewMaterial } from '@interaction/browser';
type Draft = { key: string; label: string; candidateIds: string[]; controlIds: string[]; pageTraversal: boolean };
export function RegionReviewPanel({ material, busy, perform }: { material: RegionReviewMaterial; busy: boolean; perform: (c: Command) => Promise<unknown> }) {
  const [snapshot, setSnapshot] = useState<RegionReviewMaterial>(); const [draft, setDraft] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<string[]>([]); const [omitted, setOmitted] = useState<string[]>([]); const [rejected, setRejected] = useState<string[]>([]); const [label, setLabel] = useState(''); const [traversal, setTraversal] = useState(false);
  if (!material.enabled) return null;
  const stale = snapshot && snapshot.observationId !== material.observationId;
  const controls = new Map((snapshot || material).controls.map(c => [c.localId,c]));
  const candidates = snapshot?.candidates || [];
  const used = new Set(draft.flatMap(r=>r.controlIds));
  const pool = [...new Set(candidates.filter(c=>selected.includes(c.id)).flatMap(c=>c.controlIds))].filter(id=>controls.has(id)&&!used.has(id));
  const begin = (suggested: boolean) => {
    setSnapshot(material); setSelected([]); setOmitted([]); setLabel(''); setTraversal(false); setRejected(suggested ? [] : material.review?.rejectedCandidateIds.filter(id=>material.candidates.some(c=>c.id===id)) || []);
    const assigned = new Set<string>();
    const currentControls = new Set(material.controls.map(c=>c.localId));
    const proposed = suggested ? material.candidates.filter(c=>c.suggested).map(c=>({key:crypto.randomUUID(),label:c.label,candidateIds:[c.id],controlIds:c.controlIds.filter(id=>currentControls.has(id)),pageTraversal:false}))
      : material.review?.status === 'active' ? material.review.regions.filter(r=>r.status==='active').map(r=>({key:r.key,label:r.label,candidateIds:r.anchors.map(a=>a.id),controlIds:r.controlIds,pageTraversal:r.pageTraversal})) : [];
    setDraft(proposed.filter(r=> { if ((!r.controlIds.length && !r.pageTraversal) || r.controlIds.some(id=>assigned.has(id))) return false; r.controlIds.forEach(id=>assigned.add(id)); return true; }));
  };
  const add = () => {
    const ids = pool.filter(id=>!omitted.includes(id)); if (!ids.length && !traversal) return;
    setDraft(old=>[...old.map(r=>traversal?{...r,pageTraversal:false}:r),{key:crypto.randomUUID(),label:label.trim()||candidates.filter(c=>selected.includes(c.id)).map(c=>c.label).join(' + '),candidateIds:selected,controlIds:ids,pageTraversal:traversal}]);setSelected([]);setOmitted([]);setLabel('');setTraversal(false);
  };
  return <section className="region-review" aria-label="业务区域划分">
    <h3>先确认业务区域</h3><p className="muted">候选来自容器、标题和布局线索。可合并候选，或挑选部分控件拆成多个区域；这一步只确认划分，随后再决定测哪些区域。</p>
    <p>尚未划分 {material.unassignedControlIds.length} 个可操作控件{material.unassignedPageTraversal ? '，页面滚动也待指定所属区域' : ''}</p>
    {material.review && <details><summary>上次划分：{material.review.status === 'active' ? '含有效区域' : '已失效'}</summary>{material.review.regions.map(r=><p key={r.key}>{r.label} · {r.controlIds.length} 个控件 · {r.status === 'active' && material.review?.status==='active' ? '有效' : '需重新确认'}</p>)}</details>}
    <div className="review-toolbar"><button disabled={busy} onClick={()=>begin(false)}>开始或调整划分</button><button disabled={busy} onClick={()=>begin(true)}>采用建议生成草稿</button></div>
    {snapshot && <>
      {stale && <p role="status">观察已更新，请重新载入划分草稿。</p>}
      <div className="region-draft"><h4>划分草稿</h4>{draft.map(r=><div className="data-row" key={r.key}><input aria-label={`区域名称：${r.label}`} value={r.label} disabled={busy||!!stale} onChange={e=>setDraft(old=>old.map(x=>x.key===r.key?{...x,label:e.target.value}:x))}/><span>{r.controlIds.length} 个控件</span><label><input type="checkbox" checked={r.pageTraversal} disabled={busy||!!stale} onChange={e=>setDraft(old=>old.map(x=>({...x,pageTraversal:x.key===r.key?e.target.checked:false})))}/>包含页面滚动</label><button disabled={busy||!!stale} onClick={()=>setDraft(old=>old.filter(x=>x.key!==r.key))}>移除此区域</button></div>)}</div>
      <details><summary>查看候选并合并、拆分或拒绝</summary>
        {candidates.map(c=><div className="region-candidate" key={c.id}><label><input type="checkbox" aria-label={`选候选：${c.label}：${c.id}`} disabled={busy||!!stale||rejected.includes(c.id)} checked={selected.includes(c.id)} onChange={e=>{setSelected(old=>e.target.checked?[...old,c.id]:old.filter(id=>id!==c.id));setOmitted([]);}}/>{c.label} · {c.controlIds.filter(id=>controls.has(id)).length} 个可操作控件 · {{heading:'标题线索',semantic:'语义容器',layout:'布局线索',document:'整页后备'}[c.basis]}</label>
          <button disabled={busy||!!stale||draft.some(r=>r.candidateIds.includes(c.id))} onClick={()=>{setRejected(old=>old.includes(c.id)?old.filter(id=>id!==c.id):[...old,c.id]);setSelected(old=>old.filter(id=>id!==c.id));}}>{rejected.includes(c.id)?'恢复候选':'拒绝建议'}</button>
          <details><summary>分组依据</summary><p>{c.selector}</p><pre>{JSON.stringify({rect:c.rect,evidence:c.evidence},null,2)}</pre></details>
        </div>)}
        {!!selected.length && <div className="region-members"><h4>加入新区域的控件</h4>{pool.map(id=><label key={id}><input type="checkbox" checked={!omitted.includes(id)} disabled={busy||!!stale} onChange={e=>setOmitted(old=>e.target.checked?old.filter(x=>x!==id):[...old,id])}/>{controls.get(id)!.label || controls.get(id)!.role}</label>)}<label><input type="checkbox" checked={traversal} onChange={e=>setTraversal(e.target.checked)} disabled={busy||!!stale}/>包含页面滚动</label><label>新区域名称<input aria-label="新区域名称" value={label} onChange={e=>setLabel(e.target.value)}/></label><button disabled={busy||!!stale||!pool.some(id=>!omitted.includes(id))&&!traversal} onClick={add}>添加区域</button></div>}
      </details>
      <p className="muted">未纳入草稿的控件仍待确认。包含页面滚动的区域在选择穷尽后才会自动滚动；新发现的区域仍需审阅。</p>
      <button className="primary" disabled={busy||!!stale||draft.some(r=>!r.label.trim())||!draft.length&&!rejected.length} onClick={async()=>{const result=await perform({type:'reviewRegions',review:{observationId:snapshot.observationId,source:'debug-ui',evidence:['用户确认当前候选与控件的区域划分'],regions:draft,rejectedCandidateIds:rejected}});if(result!==undefined)setSnapshot(undefined);}}>确认划分并生成探索范围</button>
    </>}
  </section>;
}
