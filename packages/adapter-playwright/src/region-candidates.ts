import type { Control, RegionCandidate } from './types.js';

/** Serialized into the page. Structural suggestions only; no label/class-name business rules. */
export function collectRegionCandidates(controls: Control[], elements: Element[], instance: (el: Element) => string, selector: (el: Element) => string, collectFragments=false): RegionCandidate[] {
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const byId = new Map(controls.filter(c => c.visible).map(c => [c.instanceId, c]));
  const elementById = new Map(elements.map(el => [instance(el), el]));
  for (const el of elements) for (let p=el.parentElement;p;p=p.parentElement) {
    if(elementById.has(instance(p))) break; elementById.set(instance(p),p);
  }
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
  const reuseSources = new Map<string,{el:Element;ids:string[];facts:object;heading?:Element}>();
  const ancestry = (el: Element) => { const path: string[] = []; for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) path.push(`${instance(p)}:${p.tagName}`); return path; };
  // Aggregate text of a passive/tentative container is evidence, not the name
  // of an established operation. Keep explicit labels and record bindings;
  // reviewed operations separately retain their exact target conditions.
  const memberName = (c: Control) => c.nativeReadOnly === true && c.readOnly && ['input','textarea'].includes(c.tag) && c.actions.length > 0 && c.actions.every(kind => kind === 'fill') ? undefined : c.liveContent?.name ?? (c.label || (Object.values(c.actionBasis || {}).some(b => b.status === 'supported') ? c.name : undefined));
  // Reuse describes structure, not historical identity. Keep full attributes and
  // explicit labels, but not geometry, inline styles or native disabled readiness.
  // Disabled is enforced by fresh action preconditions; it does not change this
  // grouping boundary. Keep aria-disabled and arbitrary/custom attributes.
  const nativeDisabled=(el:Element)=>el.namespaceURI==='http://www.w3.org/1999/xhtml'&&['button','input','select','textarea','optgroup','option','fieldset'].includes(el.localName);
  const pathCache = new Map<Element, object[] | undefined>();
  const uniqueTargets=new Map<Element,boolean>();
  const uniqueTarget=(el:Element)=>{
    if(!uniqueTargets.has(el)){
      try {const found=document.querySelectorAll(selector(el));uniqueTargets.set(el,found.length===1&&found[0]===el);}
      catch {uniqueTargets.set(el,false);}
    }
    return uniqueTargets.get(el);
  };
  const path = (el: Element | undefined): object[] | undefined => {
    if (!el) return;
    if (pathCache.has(el)) return pathCache.get(el);
    const nodes: object[] = [];
    for (let p: Element | null = el; p; p = p.parentElement) {
      if (nodes.length >= 32) { pathCache.set(el, undefined); return; }
      nodes.push({ tag:p.tagName.toLowerCase(), selector:selector(p),
        attributes:Object.fromEntries([...p.attributes].filter(a=>a.name!=='style'&&(a.name!=='disabled'||!nativeDisabled(p!))).map(a=>[a.name,a.value])),
        label:[p.getAttribute('aria-label') || '', (p.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>document.getElementById(id)?.textContent || '').join(' ')] });
    }
    const result = JSON.stringify(nodes).length <= 16000 ? nodes : undefined;
    pathCache.set(el,result); return result;
  };
  const reusable = (el:Element, ids:string[], facts:object, heading?:Element) => {
    const anchor = path(el); if (!anchor || ids.length>500) return;
    const members = ids.map(id=>{
      const c=byId.get(id)!, target=elementById.get(id)!;
      const ancestry=path(target), form='form' in target ? (target as HTMLInputElement).form : null;
      const owner=c.structuralItem && elementById.get(c.structuralItem.ownerInstanceId);
      const row=c.structuralItem && elementById.get(c.structuralItem.rowInstanceId);
      // List owners/rows may not themselves be controls; locate only observed
      // instances from the current DOM inventory, never guess their identity.
      const structural=c.structuralItem && { template:c.structuralItem.template,slot:c.structuralItem.slot,recordKey:c.structuralItem.recordKey,
        owner:path(owner || undefined),row:path(row || undefined) };
      if (!ancestry || form && !path(form) || structural && (!structural.owner || !structural.row)) return;
      let stableKey:unknown=c.stableKey;
      if(c.stableKey?.startsWith('structural-item:')) {
        // The collector's owner token is document-local. Replace only that
        // verified redundancy; complete owner/row paths and record/slot facts
        // remain in this binding. Never reinterpret old v1 stored proofs.
        if(!c.structuralItem||!owner||!row||!owner.contains(row)||!row.contains(target))return;
        try {
          const key:unknown=JSON.parse(c.stableKey.slice('structural-item:'.length));
          if(!Array.isArray(key)||key.length!==3||key.some(v=>typeof v!=='string')||key[0]!==c.structuralItem.ownerInstanceId
            ||key[1]!==c.structuralItem.recordKey||!key[2]||!uniqueTarget(owner)||!uniqueTarget(row))return;
          stableKey={kind:'structural-item',recordKey:key[1],localKey:key[2]};
        }catch{return;}
      }
      return { ancestry, tag:c.tag,role:c.role,name:memberName(c),stableKey,actions:c.actions,actionBasis:c.actionBasis,
        region:c.region,form:form?{ancestry:path(form),action:form.action,method:form.method,target:form.target}:null,
        list:c.list&&{role:c.list.role,label:c.list.label,selector:c.list.selector},structural,
        constraints:{...c.constraints,valid:undefined},options:c.options.map(o=>({value:o.value,label:o.label,disabled:o.disabled})) };
    });
    if (members.some(m=>!m)) return;
    const value={version:'region-structure-reuse/v2',anchor,heading:heading?{path:path(heading),text:heading.textContent}:null,facts,members};
    if (heading && !value.heading?.path || JSON.stringify(value).length>100000) return;
    return JSON.parse(JSON.stringify(value));
  };
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
      // Share the collector's evidenced passive-readout projection with control
      // traversal. Raw names remain in the observation/review material; quote
      // ticks must not invalidate an otherwise unchanged region partition.
      members: ids.map(id => { const c = byId.get(id)!; const target = elementById.get(id)!; return { id, ancestry: ancestry(target), tag: c.tag, role: c.role, name: memberName(c),
        stableKey: c.stableKey || null, actions: c.actions, actionBasis: c.actionBasis || null, region: c.regionInstanceId || null, list: c.list || null, purposeBinding: c.purposeBinding || null, structuralItem: c.structuralItem || null,
        constraints: { ...c.constraints, valid: undefined }, options: c.options.map(o => ({ value: o.value, label: o.label, disabled: o.disabled })) }; }) };
    reuseSources.set(instance(el),{el,ids,facts:{tag:facts.tag,role:facts.role,label:facts.label,layout:style.display,border,semantic,root},heading});
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
  for (const c of result) { const source=reuseSources.get(c.id)!; c.reuseBinding=reusable(source.el,source.ids,source.facts,source.heading); }
  for (const c of result) c.suggested = !result.some(other => other.parentId === c.id);
  if(collectFragments){
    // Region parentId means membership containment; use actual DOM ancestry here.
    // Bounds decline a fragment: truncated trees must never be matched.
    let remainingNodes=2048,remainingBytes=196608,roots=0;
    const semantic='header,nav,main,footer,aside,form,[role=navigation],[role=dialog],[role=region]';
    for(const c of [...result].sort((a,b)=>Number(!!b.suggested)-Number(!!a.suggested))){
      if(roots>=32||remainingNodes<=0||remainingBytes<=0)break;
      roots++;
      const root=reuseSources.get(c.id)!.el,nodes:NonNullable<RegionCandidate['fragment']>['nodes']=[];
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT);let el:Element|null=root,complete=true;
      const paths=new Map<Element,string>([[root,'.']]);
      while(el){
        if(nodes.length>=256||remainingNodes<=0||el.shadowRoot||el.matches('iframe,object,embed,canvas')){complete=false;break;}
        const parent=el.parentElement,path=el===root?'.':`${paths.get(parent!)}/${el.tagName.toLowerCase()}[${[...parent!.children].filter(s=>s.tagName===el!.tagName).indexOf(el)+1}]`;
        paths.set(el,path);
        const attributes=Object.fromEntries([...el.attributes].filter(a=>a.name!=='style').map(a=>[a.name,a.value]));
        if(el instanceof HTMLAnchorElement&&el.hasAttribute('href'))attributes.href=el.href;
        if(el instanceof HTMLInputElement&&['checkbox','radio'].includes(el.type))attributes['@checked']=String(el.checked);
        if(el instanceof HTMLSelectElement)attributes['@selected']=JSON.stringify([...el.selectedOptions].map(o=>o.value));
        const text=[...el.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent||'').join(' ').replace(/\s+/g,' ').trim();
        remainingNodes--;
        if(text.length>8192||JSON.stringify(attributes).length>8192){complete=false;break;}
        nodes.push({instanceId:instance(el),path,tag:el.tagName.toLowerCase(),attributes,text});
        el=walker.nextNode() as Element|null;
      }
      if(!complete)continue;
      const owners=[];for(let p:Element|null=root;p;p=p.parentElement)if(p===root||p.matches(semantic))owners.push({tag:p.tagName.toLowerCase(),role:p.getAttribute('role'),id:p.id,label:p.getAttribute('aria-label'),labelledby:p.getAttribute('aria-labelledby')});
      const parents=result.filter(other=>other.id!==c.id&&reuseSources.get(other.id)!.el.contains(root));
      const parent=parents.find(p=>!parents.some(q=>q!==p&&reuseSources.get(p.id)!.el.contains(reuseSources.get(q.id)!.el)));
      const fragment={policy:'host-dom-fragment/v1' as const,parentId:parent?.id,owner:JSON.stringify(owners),nodes};
      const bytes=JSON.stringify(fragment).length*2;if(bytes>remainingBytes)continue;
      c.fragment=fragment;remainingBytes-=bytes;
    }
  }
  return result;
}
