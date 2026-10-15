import type { Control, RegionCandidate } from './types.js';

/** Serialized into the page. Structural suggestions only; no label/class-name business rules. */
export function collectRegionCandidates(controls: Control[], elements: Element[], instance: (el: Element) => string, selector: (el: Element) => string): RegionCandidate[] {
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const byId = new Map(controls.filter(c => c.visible).map(c => [c.instanceId, c]));
  const elementById = new Map(elements.map(el => [instance(el), el]));
  const ownership = new Map<Element, string[]>();
  if (document.body) ownership.set(document.body, [...byId.keys()]);
  for (const el of elements) {
    const id = instance(el); if (!byId.has(id)) continue;
    let parent: Element | null = el;
    for (let depth = 0; parent && depth < 24; depth++, parent = parent.parentElement) {
      if (parent === document.body) break;
      const ids = ownership.get(parent) || []; ids.push(id); ownership.set(parent, ids);
    }
  }
  const candidates: RegionCandidate[] = [];
  const ancestry = (el: Element) => { const path: string[] = []; for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) path.push(`${instance(p)}:${p.tagName}`); return path; };
  for (const [el, ids] of ownership) {
    if (candidates.length >= 500) break;
    const style = getComputedStyle(el), box = el.getBoundingClientRect();
    if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden') continue;
    const heading = [...el.children].flatMap(child => child.matches('h1,h2,h3,h4,h5,h6,[role=heading]') ? [child] : [...child.children].filter(c => c.matches('h1,h2,h3,h4,h5,h6,[role=heading]')))[0];
    const semantic = el.matches('main,nav,header,footer,aside,section,article,form,fieldset,[role=region],[role=navigation],[role=dialog],[role=tabpanel]');
    const layout = ['flex', 'grid', 'inline-flex', 'inline-grid'].includes(style.display);
    const border = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(v => parseFloat(v) > 0);
    const root = el === document.body;
    if (!root && !semantic && !heading && !(ids.length >= 2 && (layout || border))) continue;
    const title = clean(el.getAttribute('aria-label')) || clean((el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent).join(' ')) || clean(heading?.textContent);
    const facts = { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', heading: heading ? { instanceId: instance(heading), text: clean(heading.textContent) } : null,
      label: title, ancestry: ancestry(el), layout: style.display, border, semantic, root,
      members: ids.map(id => { const c = byId.get(id)!; const target = elementById.get(id)!; return { id, ancestry: ancestry(target), tag: c.tag, role: c.role, name: c.name,
        stableKey: c.stableKey || null, actions: c.actions, actionBasis: c.actionBasis || null, region: c.regionInstanceId || null, list: c.list || null, purposeBinding: c.purposeBinding || null,structuralItem:c.structuralItem||null,
        constraints: { ...c.constraints, valid: undefined }, options: c.options.map(o => ({ value: o.value, label: o.label, disabled: o.disabled })) }; }) };
    candidates.push({ id: instance(el), label: title || (root ? '未细分页面' : `${el.tagName.toLowerCase()} 容器`), selector: selector(el),
      controlIds: ids, rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      basis: root ? 'document' : title ? 'heading' : semantic ? 'semantic' : 'layout', binding: JSON.parse(JSON.stringify(facts)),
      evidence: [{ source: 'dom', rule: 'structural-region-candidate/v1', facts: { semantic, layout, border, heading: clean(heading?.textContent), meaning: 'Observed container and descendants; business boundary requires caller review' } }] });
  }
  // Equal membership through wrapper chains adds no useful choice. Keep the strongest description.
  const score = (c: RegionCandidate) => ({ heading: 4, semantic: 3, layout: 2, document: 1 })[c.basis];
  const unique = new Map<string, RegionCandidate>();
  for (const c of candidates) { const key = JSON.stringify(c.controlIds.slice().sort()); const old = unique.get(key); if (!old || score(c) > score(old)) unique.set(key, c); }
  const result = [...unique.values()];
  for (const c of result) c.parentId = result.filter(p => p.id !== c.id && p.controlIds.length > c.controlIds.length && c.controlIds.every(id => p.controlIds.includes(id))).sort((a,b) => a.controlIds.length - b.controlIds.length)[0]?.id;
  for (const c of result) c.suggested = !result.some(other => other.parentId === c.id);
  return result;
}
