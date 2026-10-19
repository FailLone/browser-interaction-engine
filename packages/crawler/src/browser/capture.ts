import type { Control, EvidenceOptions, Gap, Region } from './types.js';
import type { collectOverlays } from './overlays.js';
import type { collectActionEvidence } from './action-evidence.js';
import type { collectIdentityContexts } from './identity-context.js';
import type { collectPopupRelations } from './popup-relations.js';
import type { collectComponents } from './components.js';
import type { collectScrollContainers } from './scroll-containers.js';
import type { discoverStructuralLists, describeStructuralLists } from './structural-lists.js';
import type { collectEvidence } from './collect-evidence.js';

/**
 * Runs in the page (serialized with its collectors) without DOM mutation: controls with their
 * action evidence, regions, overlays, components, scroll containers, structural lists and,
 * when a detail collector is passed, the full DOM evidence that UI rule plugins read.
 */
export function collectDOM(overlayCollector: typeof collectOverlays, actionCollector: typeof collectActionEvidence, identityCollector: typeof collectIdentityContexts, popupCollector: typeof collectPopupRelations, componentCollector: typeof collectComponents, scrollCollector: typeof collectScrollContainers, listCollector: typeof discoverStructuralLists, listDescription: typeof describeStructuralLists, detailCollector?: typeof collectEvidence, detailOptions?: EvidenceOptions) {
  const w = window as any;
  const tracker = w.__interactionEvidenceTracker ??= { documentId: crypto.randomUUID(), ids: new WeakMap(), counter: 0 };
  const instance = (el: Element) => { if (!tracker.ids.has(el)) tracker.ids.set(el, `${tracker.documentId}:${++tracker.counter}`); return tracker.ids.get(el) as string; };
  const ancestryCache=new WeakMap<Element,NonNullable<Control['domAncestry']>>();
  const ancestry=(el:Element)=>{
    const saved=ancestryCache.get(el);if(saved)return saved;
    const instanceIds:string[]=[];let parent=el.parentElement;
    while(parent&&instanceIds.length<64){instanceIds.push(instance(parent));parent=parent.parentElement;}
    const result={documentId:tracker.documentId as string,instanceIds,complete:!parent};ancestryCache.set(el,result);return result;
  };
  const landmark=(el:Element):'banner'|'navigation'|undefined=>{
    let navigation=false,parent:Element|null=el;
    while(parent){
      const explicit=parent.getAttribute('role')?.split(/\s+/)[0];
      if(explicit==='banner'||!explicit&&parent.tagName==='HEADER'&&!parent.parentElement?.closest('article,aside,main,nav,section'))return 'banner';
      if(explicit==='navigation'||!explicit&&parent.tagName==='NAV')navigation=true;
      parent=parent.parentElement;
    }
    return navigation?'navigation':undefined;
  };
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const label = (el: Element) => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) return clean(labelled.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const labels = (el as HTMLInputElement).labels;
    return labels?.length ? clean([...labels].map(l => { const copy = l.cloneNode(true) as Element; copy.querySelectorAll('input,select,textarea,button,[role=combobox]').forEach(child => child.remove()); return copy.textContent; }).join(' ')) : '';
  };
  const role = (el: Element): string => el.getAttribute('role') || (el.tagName === 'A' ? el.hasAttribute('href') ? 'link' : 'generic' : { BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', FORM: 'form', MAIN: 'main', NAV: 'navigation', DIALOG: 'dialog', SUMMARY: 'button' }[el.tagName] || (el.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', number: 'spinbutton' }[(el as HTMLInputElement).type] || 'textbox') : 'generic'));
  const rect = (el: Element | null) => { const r = el?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : { x: 0, y: 0, width: 0, height: 0 }; };
  const body = document.body;
  const bodyText = body?.innerText ?? body?.textContent ?? '';
  const selector = (el: Element): string => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let p: Element | null = el;
    while (p && p !== document.documentElement) {
      let index = 1; let previous = p.previousElementSibling;
      while (previous) { if (previous.tagName === p.tagName) index++; previous = previous.previousElementSibling; }
      parts.unshift(`${p.tagName.toLowerCase()}:nth-of-type(${index})`); p = p.parentElement;
    }
    return `html > ${parts.join(' > ')}`;
  };
  const regionSelector = 'form,main,nav,section[aria-label],section[aria-labelledby],[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=tabpanel],dialog';
  const regionKey = (el: Element | null) => {
    if (!el) return 'document';
    return `${role(el)}:${el.getAttribute('data-testid') || el.id || label(el) || el.getAttribute('name') || selector(el)}`;
  };
  const elementKey = (el: Element) => el.getAttribute('data-testid') ? `testid:${el.getAttribute('data-testid')}` : el.id ? `id:${el.id}` : el.getAttribute('name') ? `name:${el.getAttribute('name')}` : undefined;
  const itemSelector = '[data-row-key],[data-item-key],li,tr,[role=row],[role=listitem],[role=treeitem],[role=option]';
  const listSelector = 'ul,ol,table,[role=list],[role=listbox],[role=grid],[role=tree],[data-list-key]';
  const contentName = (el: Element, independentScopes?: Set<Element>) => {
    // Fallback names describe this control, not an independent descendant panel.
    // Explicit labels are resolved separately (including hidden referenced text).
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        const child = node as Element;
        if (independentScopes?.has(child) || child.matches('script,style,[hidden],[aria-hidden=true],dialog,[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=grid],[role=tree],[role=tabpanel],[role=tooltip],[popover]')) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(child);
        return style.display === 'none' || style.visibility === 'hidden' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.textContent || '');
    const input = el as HTMLInputElement;
    return clean(parts.join('')) || clean(el.getAttribute('title')) || clean(el.getAttribute('placeholder')) || (['submit', 'button'].includes(input.type) ? input.value : '');
  };
  const itemKeyCache = new Map<Element, string | undefined>();
  const instanceBoundItems = new Set<Element>();
  const recordScopeCache = new Map<Element, Element[]>();
  const recordScopes = (item: Element) => {
    if (recordScopeCache.has(item)) return recordScopeCache.get(item)!;
    const openers = [...item.querySelectorAll('[aria-expanded]')].filter(el => el.closest(itemSelector) === item);
    const itemRect = item.getBoundingClientRect();
    const scopes = [...item.querySelectorAll('*')].filter(el => {
      if (el.matches(`${listSelector},dialog,[role=dialog],[role=alertdialog],[role=menu],[role=tabpanel],[popover],[hidden],[aria-hidden=true]`)) return true;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      const panelRect = el.getBoundingClientRect();
      const outsideItem = panelRect.width > 0 && panelRect.height > 0 && (panelRect.left < itemRect.left || panelRect.right > itemRect.right || panelRect.top < itemRect.top || panelRect.bottom > itemRect.bottom);
      // Position alone is not ownership: require an expanded-control relationship
      // and a separate descendant panel extending beyond the record.
      return ['absolute', 'fixed'].includes(style.position)
        && outsideItem && el.children.length > 0 && openers.some(opener => opener !== el && !el.contains(opener));
    });
    recordScopeCache.set(item, scopes); return scopes;
  };
  const linkBindings = new Map<Element, string | undefined>();
  const recordLinks = (item: Element) => {
    if (linkBindings.has(item)) return linkBindings.get(item);
    // Child menus change their destinations when opened, searched or switched.
    // Use the same record boundary for links and text; neither identifies the parent.
    const scopes = recordScopes(item);
    const links = [...item.querySelectorAll('a[href]')].filter(a => a.closest(itemSelector) === item && !scopes.some(scope => scope === a || scope.contains(a)))
      .map(a => (a as HTMLAnchorElement).href).filter(href => {
        try { const u = new URL(href); return ['http:', 'https:'].includes(u.protocol) && u.origin + u.pathname + u.search !== location.origin + location.pathname + location.search; } catch { return false; }
      });
    const binding = links.length ? JSON.stringify(['record-links', [...new Set(links)].sort()]) : undefined;
    linkBindings.set(item, binding); return binding;
  };
  const recordLinkCounts = new Map<Element, Map<string, number>>();
  const uniqueRecordLinks = (list: Element, binding: string) => {
    let counts = recordLinkCounts.get(list);
    if (!counts) {
      counts = new Map();
      for (const item of list.querySelectorAll(itemSelector)) if (item.parentElement?.closest(listSelector) === list) {
        const key = recordLinks(item); if (key) counts.set(key, (counts.get(key) || 0) + 1);
      }
      recordLinkCounts.set(list, counts);
    }
    return counts.get(binding) === 1;
  };
  const descriptions = new Map<Element, { text: string; fullText: string }>();
  const recordDescription = (item: Element) => {
    if (descriptions.has(item)) return descriptions.get(item)!;
    const copy = item.cloneNode(true) as Element;
    // A record can contain a nested list or an independently positioned
    // expanded panel. Its changing contents are not the parent record's name.
    // Keep ordinary positioned descriptions: position alone is not ownership.
    const descendants = [...item.querySelectorAll('*')]; const copies = [...copy.querySelectorAll('*')];
    for (const scope of recordScopes(item)) copies[descendants.indexOf(scope)].remove();
    copy.querySelectorAll('button,input,select,textarea,[role=button],[role=checkbox],[role=switch],[role=combobox],script,style,[hidden],[aria-hidden=true]').forEach(child => child.remove());
    const labelledBy = item.getAttribute('aria-labelledby');
    const fullLabel = labelledBy ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') : item.getAttribute('aria-label');
    const fullText = (fullLabel || copy.textContent || '').replace(/\s+/g, ' ').trim();
    // These are typed display values, not textual record descriptions. Keep
    // plain numbers (which could be record IDs) and explicit row labels.
    if (!fullLabel) for (const el of [...copy.querySelectorAll('*')].reverse()) {
      const text = (el.textContent || '').trim();
      const readout = /^[+\-−]?\p{Sc}\s*\d[\d,.]*(?:\s*[KMBTkmbt])?$/u.test(text)
        || /^[+\-−]?\d[\d,.]*\s*[%‰]$/.test(text);
      if (readout && !el.closest('label') && !el.matches('a,[role],output[for]') && !el.querySelector('a,[role],input,button,select,textarea')) el.remove();
    }
    const text = (fullLabel || copy.textContent || '').replace(/\s+/g, ' ').trim();
    const description = { text, fullText }; descriptions.set(item, description); return description;
  };
  const descriptionCounts = new Map<Element, Map<string, number>>();
  const uniqueDescription = (list: Element, text: string) => {
    let counts = descriptionCounts.get(list);
    if (!counts) {
      counts = new Map();
      for (const item of list.querySelectorAll(itemSelector)) if (item.parentElement?.closest(listSelector) === list) {
        const value = recordDescription(item).text; counts.set(value, (counts.get(value) || 0) + 1);
      }
      descriptionCounts.set(list, counts);
    }
    return counts.get(text) === 1;
  };
  const itemKey = (item: Element) => {
    if (itemKeyCache.has(item)) return itemKeyCache.get(item);
    // Explicit record keys survive reorder/rebuild and change when a virtual row
    // is recycled. Do not use sibling indexes, geometry or input values as keys.
    const declared = ['data-row-key', 'data-item-key', 'data-key'].map(key => [key, item.getAttribute(key)]).find(([, value]) => value);
    let key = declared ? JSON.stringify(declared) : undefined;
    const links = recordLinks(item), list = item.parentElement?.closest(listSelector);
    // Shared generic links do not identify a record. A changed destination creates
    // a different binding even when a virtual list recycles the same DOM slot.
    if (!key && links && list && uniqueRecordLinks(list, links)) { key = links; instanceBoundItems.add(item); }
    if (!key) {
      const { text, fullText } = recordDescription(item);
      const projected = text !== fullText && /[\p{L}]/u.test(text) && list && uniqueDescription(list, text);
      const description = projected ? text : fullText;
      if (projected) instanceBoundItems.add(item);
      // Long/truncated descriptions are not a unique business record key.
      if (description && description.length <= 500) key = JSON.stringify([projected ? 'item-description' : 'item-text', description]);
    }
    // A row's DOM id/testid may identify a reusable viewport slot, not its item.
    // Without a declared record key or descriptive text, leave it unresolved.
    // Present-snapshot uniqueness cannot prove identity across virtualization/rebuild.
    if (key && instanceBoundItems.has(item)) key = JSON.stringify(['record-instance', instance(item), key]);
    itemKeyCache.set(item, key); return key;
  };
  const scopedControlKey = (el: Element, name: string, type: string) => {
    const own = elementKey(el);
    const bindings: string[][] = [];
    let item = el.closest(itemSelector);
    while (item) {
      const key = itemKey(item);
      // Missing item evidence must not turn a recycled slot ID into a record ID.
      if (!key) return undefined;
      const list = item.parentElement?.closest(listSelector);
      const scope = list ? list.getAttribute('data-list-key') || elementKey(list) || label(list) || list.tagName.toLowerCase() : '';
      bindings.unshift([scope, key]);
      item = item.parentElement?.closest(itemSelector) || null;
    }
    if (!bindings.length) return own;
    const localKey = el.matches(itemSelector) ? JSON.stringify([role(el), 'record', type]) : el.getAttribute('data-testid') || el.getAttribute('name') || (name ? JSON.stringify([role(el), name, type]) : own);
    // Duplicate controls within one item still share this key and stay ambiguous.
    return localKey ? `item:${JSON.stringify([bindings, localKey])}` : undefined;
  };
  const regions: Region[] = [...document.querySelectorAll(regionSelector)].map(el => ({ key: regionKey(el), instanceId: instance(el), label: label(el) || el.getAttribute('name') || role(el), role: role(el), selector: selector(el), parentKey: regionKey(el.parentElement?.closest(regionSelector) ?? null), rect: rect(el), text: ((el as HTMLElement).innerText || el.textContent || '').slice(0, 8000) }));
  // Titles often embed live values (prices, counters). The document region is
  // part of every obligation scope, so numeric runs are masked to keep one page
  // from re-registering all of its controls whenever such a value ticks.
  const documentLabel = clean(document.title).replace(/[-+]?\d[\d.,:%]*/g, '#');
  regions.unshift({ key: 'document', instanceId: document.documentElement ? instance(body || document.documentElement) : undefined, label: documentLabel, role: 'document', selector: 'body', parentKey: '', rect: rect(body), text: bodyText.slice(0, 8000) });
  const query = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=dialog],[role=alertdialog],dialog,[popover],[aria-expanded],[onclick],[tabindex],[contenteditable]:not([contenteditable=false])';
  const selected = new Set(document.querySelectorAll(query));
  const popupRelations = popupCollector();
  for (const relation of popupRelations) if (relation.trigger) selected.add(relation.trigger);
  // Document roots host event delegation and focus management. Preserve those
  // signals separately instead of making the entire document an action target.
  const documentRoots = [document.documentElement, body].filter((el): el is HTMLElement => !!el);
  const documentHints = documentRoots.flatMap(el => actionCollector(el).interactionHints.map(hint => ({ ...hint, facts: { ...hint.facts, tag: el.tagName.toLowerCase(), scope: 'document' } })));
  for (const root of documentRoots) selected.delete(root);
  const elements = [...document.querySelectorAll('*')];
  const scanElements = elements.slice(0, 5000);
  const scrollViewport = (el: Element) => {
    if (el === body || el === document.documentElement || el.matches('input,textarea,select,[contenteditable]:not([contenteditable=false])')) return;
    const style = getComputedStyle(el);
    const maxX = /^(auto|scroll)$/.test(style.overflowX) ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;
    const maxY = /^(auto|scroll)$/.test(style.overflowY) ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
    if ((maxX > 1 || maxY > 1) && el.clientWidth && el.clientHeight) return { x: el.scrollLeft, y: el.scrollTop, maxX, maxY, width: el.clientWidth, height: el.clientHeight };
  };
  // A bounded supplemental scan finds scroll viewports, handlers and cursor hints.
  // Inherited pointer cursors do not turn every descendant into another target.
  for (const el of scanElements) if (el !== body && el !== document.documentElement && !selected.has(el) && (scrollViewport(el) || typeof (el as HTMLElement).onclick === 'function'&&actionCollector(el).interactionHints.some(h=>h.rule==='click-handler/v1') || getComputedStyle(el).cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer'))) selected.add(el);
  const structuralScan=listCollector(scanElements,selected,instance,selector,actionCollector,undefined);
  // Semantic rows already have scoped record evidence, including instance-bound
  // passive readouts. Structural discovery must not reintroduce raw quote text
  // as a second, conflicting record identity or freshness prerequisite.
  for (const list of structuralScan.candidates) for (const member of list.members) {
    if (member.row.matches(itemSelector)) member.recordKey = itemKey(member.row);
  }
  for(const list of structuralScan.candidates)for(const member of list.members)selected.add(member.element);
  const structuralMembers=new Map(structuralScan.candidates.flatMap(list=>list.members.map(member=>[member.element,{ownerInstanceId:instance(list.owner),template:list.template,slot:member.slot,rowInstanceId:instance(member.row),...(member.recordKey?{recordKey:member.recordKey}:{}),...(member.recordEvidence?{recordEvidence:member.recordEvidence}:{})}] as const)));
  const all = [...selected];
  const reuseBindings = new Map<Element, Control['reviewReuseBinding']>();
  const reuseBinding = (owner: Element): Control['reviewReuseBinding'] => {
    if (reuseBindings.has(owner)) return reuseBindings.get(owner);
    const ancestors: NonNullable<Control['reviewReuseBinding']>['ancestors'] = [];
    let parent: Element | null = owner;
    for (; parent && ancestors.length < 32; parent = parent.parentElement) {
      ancestors.push({ tag: parent.tagName.toLowerCase(), selector: selector(parent),
        attributes: Object.fromEntries(Array.from(parent.attributes).filter(a => a.name !== 'style').map(a => [a.name, a.value])),
        label: parent.getAttribute('aria-label') || (parent.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') });
    }
    const result = !parent && JSON.stringify(ancestors).length <= 16000 ? { ancestors } : undefined;
    reuseBindings.set(owner, result); return result;
  };
  const classificationBinding = (el: Element, includeReferences=true): Control['classificationBinding'] => {
    const nodes: NonNullable<Control['classificationBinding']>['nodes'] = [];
    const text = el.textContent || ''; let characters = text.length, truncated = text.length > 8000;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    let next: Element | null = el;
    while (next && nodes.length < 200 && characters <= 16000) {
      const attributes: Record<string, string> = {};
      for (const a of [...next.attributes].sort((a,b) => a.name.localeCompare(b.name))) {
        characters += a.name.length + a.value.length;
        if (a.value.length > 1000 || characters > 16000) { truncated = true; break; }
        attributes[a.name] = a.value;
      }
      nodes.push({ instanceId: instance(next), parentInstanceId: instance(next.parentElement || document.documentElement), tag: next.tagName.toLowerCase(), attributes });
      next = walker.nextNode() as Element | null;
    }
    const result:NonNullable<Control['classificationBinding']>={ nodes, text: text.slice(0, 8000), truncated: truncated || !!next };
    if(includeReferences){
      const ids=[...new Set(nodes.flatMap(n=>Object.entries(n.attributes).filter(([name])=>['for','aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','aria-details','aria-errormessage','headers','list','form'].includes(name)).flatMap(([,value])=>value.trim().split(/\s+/).filter(Boolean))))];
      result.references=ids.slice(0,32).map(id=>{const matches=document.querySelectorAll(`#${CSS.escape(id)}`),target=matches[0];if(!target)return {id,missing:true as const};if(matches.length!==1)return {id,ambiguous:true as const};
        const targetInstanceId=instance(target);return {id,targetInstanceId,...(nodes.some(n=>n.instanceId===targetInstanceId)?{}:{target:classificationBinding(target,false)!})};});
      if(ids.length>32||result.references.some(r=>r.target?.truncated))result.truncated=true;
    }
    return result;
  };
  const unnamedScrolls = new Set<Element>();
  const ownerOf = (el: Element) => 'form' in el ? (el as HTMLInputElement).form : el.closest('form');
  const incomingRelations = new Set<HTMLFormElement>();
  for (const source of document.querySelectorAll('[aria-controls],[aria-owns],[aria-labelledby],[aria-describedby]')) {
    for (const attribute of ['aria-controls', 'aria-owns', 'aria-labelledby', 'aria-describedby']) for (const key of (source.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
      const target = document.getElementById(key), owner = target && ownerOf(target);
      if (owner && owner !== ownerOf(source)) incomingRelations.add(owner);
    }
  }
  const formOwners = new Map<HTMLFormElement, NonNullable<Control['formOwner']>>();
  const formOwner = (el: Element) => {
    const form = ownerOf(el);
    if (!form) return;
    if (!formOwners.has(form)) {
      // Cross-form ARIA relationships and enclosing records defeat local ownership.
      // Keep those cases global; native .form includes externally associated fields.
      const members = [...form.elements, ...form.querySelectorAll('*')];
      const external = incomingRelations.has(form) || [form, ...members].some(node => node.matches('[aria-controls],[aria-owns],[aria-describedby]') || ['aria-controls', 'aria-owns', 'aria-labelledby', 'aria-describedby'].some(attribute =>
        (node.getAttribute(attribute) || '').split(/\s+/).filter(Boolean).some(key => { const ref = document.getElementById(key); return !ref || !form.contains(ref); })));
      formOwners.set(form, { key: regionKey(form), instanceId: instance(form), action: form.action, method: form.method, target: form.target,
        isolated: !external && !form.closest(itemSelector) });
    }
    return formOwners.get(form);
  };
  const controls = all.slice(0, 1500).map(el => {
    const e = el as HTMLInputElement;
    const r = rect(el); const style = getComputedStyle(el);
    // A descendant of closed native details can retain a nonzero layout box.
    // Chromium's rendering visibility includes that native hidden subtree and
    // content-visibility; opacity and pointer interception remain separate facts.
    const visible = el.checkVisibility() && r.width > 0 && r.height > 0 && style.visibility === 'visible' && !el.closest('[hidden],[inert]');
    const enabled = !e.disabled && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[inert]');
    const semanticRole = role(el);
    const type = el.tagName === 'INPUT' ? e.type : el.tagName.toLowerCase();
    const capabilities = actionCollector(el);
    const popupRelation = popupRelations.find(p => p.trigger === el);
    if (popupRelation && !capabilities.actions.length) {
      capabilities.actions.push('click');
      capabilities.actionBasis.click = { status: 'tentative', evidence: [{ source: 'dom-structure', rule: 'positioned-choice-popup-trigger/v1',
        facts: { contentRole: popupRelation.content.getAttribute('role') || '', relation: popupRelation.retained ? 'observed-panel-continuity' : 'positioned-child-panel-with-sibling-title', purpose: 'unverified' } }] };
    }
    const structuralItem=structuralMembers.get(el);
    if(structuralItem&&!capabilities.actions.length&&style.cursor==='pointer'){
      const {recordEvidence,...record}=structuralItem;
      capabilities.actions.push('click');capabilities.actionBasis.click={status:'tentative',evidence:[{source:'dom',rule:'repeated-record-probe/v1',facts:{...record,meaning:'Repeated custom pointer record; click purpose remains unconfirmed'}},...(recordEvidence||[])]};
    }
    const scroll = scrollViewport(el);
    // Virtualized descendants change as the viewport moves. They are not the
    // identity/name of an otherwise unnamed scroll viewport.
    const unnamedScroll = scroll && capabilities.actions.every(kind => capabilities.actionBasis[kind]?.status === 'tentative');
    if (unnamedScroll) unnamedScrolls.add(el);
    const name = label(el) || (unnamedScroll ? clean(el.getAttribute('title')) || `Scrollable ${semanticRole}` : contentName(el));
    if (scroll) {
      capabilities.actions.push('scroll');
      capabilities.actionBasis.scroll = { status: 'supported', evidence: [{ source: 'cssom', rule: 'element-scroll-viewport/v1', facts: { overflowX: style.overflowX, overflowY: style.overflowY } }] };
    }
    const editable = enabled && !e.readOnly && el.getAttribute('aria-readonly') !== 'true' && capabilities.actions.includes('fill');
    const x = Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)); const y = Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    const isInView = r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight;
    const options = el.tagName === 'SELECT' ? [...(el as HTMLSelectElement).options].map(o => ({ value: o.value, label: clean(o.label), disabled: o.disabled })) : [];
    const stableKey = scopedControlKey(el, name, type);
    let record = el.closest(itemSelector); let identityScope: 'instance' | undefined;
    while (record) { if (instanceBoundItems.has(record)) identityScope = 'instance'; record = record.parentElement?.closest(itemSelector) || null; }
    const nestedLists = scroll ? el.querySelectorAll('[role=listbox]') : [];
    const list = el.tagName === 'SELECT' ? el : el.closest('[role=listbox]') || (nestedLists.length === 1 ? nestedLists[0] : undefined);
    const boundForm = (el as HTMLInputElement).form;
    // Bind every captured runtime hint used to interpret this target, including
    // native controls whose HTML action basis itself does not change. The same
    // binding participates in review invalidation, reuse and live preflight.
    const runtimeEvents=capabilities.interactionHints.filter(h=>h.source==='runtime-metadata');
    const purposeBinding = list ? { attributes: Object.fromEntries(['type', 'role', 'href', 'target', 'form', 'formaction', 'formmethod', 'formtarget', 'aria-controls', 'aria-haspopup'].filter(k => el.hasAttribute(k)).map(k => [k, el.getAttribute(k)!])),
      ...(runtimeEvents.length?{runtimeEvents}:{}),
      ...(boundForm ? { form: { instanceId: instance(boundForm), action: boundForm.action, method: boundForm.method, target: boundForm.target } } : {}) } : undefined;
    const reviewBinding = { parentInstanceId: instance(el.parentElement || document.documentElement),
      ...(runtimeEvents.length?{runtimeEvents}:{}),
      attributes: Object.fromEntries(['type','role','name','href','target','src','alt','title','form','formaction','formmethod','formtarget','aria-label','aria-labelledby','aria-describedby','aria-controls','aria-haspopup','popovertarget','popovertargetaction','command','commandfor','contenteditable','onclick','onchange','oninput','onkeydown','onmouseenter','onmouseover','onpointerenter'].filter(k=>el.hasAttribute(k)).map(k=>[k,el.getAttribute(k)!])),
      ...(boundForm ? {form:{instanceId:instance(boundForm),action:boundForm.action,method:boundForm.method,target:boundForm.target}} : {}) };
    // No node IDs or geometry in this projection. Missing/bounded evidence cannot
    // support reuse; this does not establish identity or an operation's purpose.
    const reviewReuseBinding = visible && !list && !structuralItem && el.parentElement ? reuseBinding(el.parentElement) : undefined;
    return {
      localId: instance(el), instanceId: instance(el), tag: el.tagName.toLowerCase(), role: semanticRole, name, label: label(el), stableKey, ...(identityScope ? { identityScope } : {}),
      ...(list ? { list: { instanceId: instance(list), role: list.tagName === 'SELECT' ? 'select' : 'listbox', label: label(list), selector: selector(list) } } : {}),
      ...(purposeBinding ? { purposeBinding } : {}),
      reviewAttributes: Object.fromEntries(Array.from(el.attributes).filter(a => /^data-(?!testid)|^name$/.test(a.name)).map(a => [a.name, a.value])),
      reviewBinding, reviewReuseBinding, domAncestry:ancestry(el),...(landmark(el)?{landmark:landmark(el)}:{}), ...(structuralItem ? { structuralItem } : {}),
      ...(!Object.values(capabilities.actionBasis).some(b => b.status === 'supported') ? { classificationBinding: classificationBinding(el) } : {}),
      region: regionKey(el.closest(regionSelector)), regionInstanceId: instance(el.closest(regionSelector) || body || document.documentElement), form: regionKey(el.closest('form')), formOwner: formOwner(el), selector: selector(el), rect: r,
      value: typeof e.value === 'string' ? e.value : (el as HTMLElement).isContentEditable ? clean(el.textContent) : '', displayedText: clean(el.textContent),
      checked: ['checkbox', 'radio'].includes(type) ? e.checked : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : null,
      pressed: el.getAttribute('aria-pressed') === 'mixed' ? 'mixed' as const : el.hasAttribute('aria-pressed') ? el.getAttribute('aria-pressed') === 'true' : null,
      selected: el.tagName === 'SELECT' ? [...(el as HTMLSelectElement).selectedOptions].map(o => o.value) : el.getAttribute('aria-selected') === 'true' ? [name] : [],
      visible: !!visible, enabled: !!enabled, editable: !!editable, readOnly: !!e.readOnly || el.getAttribute('aria-readonly') === 'true',
      ...(['INPUT', 'TEXTAREA'].includes(el.tagName) ? { nativeReadOnly: e.readOnly === true } : {}),
      expanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : null, controls: el.getAttribute('aria-controls'),
      constraints: { type, required: !!e.required, min: e.min || undefined, max: e.max || undefined, step: e.step || undefined, pattern: e.pattern || undefined, minLength: e.minLength >= 0 ? e.minLength : undefined, maxLength: e.maxLength >= 0 ? e.maxLength : undefined, valid: e.validity?.valid ?? true },
      options, ...capabilities, ...(scroll ? { scroll } : {}), discovery: [...query.split(',').filter(q => el.matches(q)).map(q => `selector:${q}`), ...(typeof (el as HTMLElement).onclick === 'function' ? ['property:onclick'] : []), ...(style.cursor === 'pointer' ? ['style:cursor=pointer'] : []), ...(scroll ? ['cssom:scroll-viewport'] : [])],
      actionable: { visible: !!visible, enabled: !!enabled, editable: !!editable, hitTarget: isInView ? !!hit && (hit === el || el.contains(hit)) : null, unknown: ['event-handler-completeness', 'business-preconditions', ...(!isInView ? ['off-viewport-hit-target'] : [])] },
    };
  });
  const scanned = new Set(scanElements), firstOmittedIndex = elements.findIndex(el => !scanned.has(el));
  const firstOmitted = elements[firstOmittedIndex];
  const gaps: (Gap & {selector?:string})[] = [];
  if(structuralScan.limits.templatesTruncated||structuralScan.limits.collectionsTruncated||structuralScan.limits.rowWindowsTruncated)gaps.push({code:'STRUCTURAL_LIST_SCAN_TRUNCATED',reference:'discovery:structural',message:`Repeated-record discovery: ${structuralScan.limits.templatesTruncated} limited templates, ${structuralScan.limits.rowWindowsTruncated} partial sibling windows; collection limit reached: ${structuralScan.limits.collectionsTruncated}`});
  for (const omission of structuralScan.limits.omissions) gaps.push({ code: 'STRUCTURAL_DISCOVERY_LIMIT', selector: omission.rowSelector || omission.ownerSelector, reference: `discovery:${omission.ownerId}:${omission.rowId || ''}:${omission.kind}`, message: `${omission.kind}: limit ${omission.limit}, observed at least ${omission.observed}; inspect discoveryScan for the exact owner and bounded supplementation target` });
  if (!body) gaps.push({ code: 'DOM_ROOT_UNAVAILABLE', message: 'Document body is absent; the page may be navigating or rebuilding', critical: true });
  if (document.readyState === 'loading') gaps.push({ code: 'DOCUMENT_LOADING', message: 'Document parsing is still in progress', critical: true });
  for (const el of document.querySelectorAll('iframe,canvas,input[type=file]')) gaps.push({ code: `UNSUPPORTED_${el.tagName === 'INPUT' ? 'FILE_INPUT' : el.tagName}`, message: `${el.tagName} internals are outside V0.1 coverage`, selector: selector(el) });
  for (const el of elements) if (el.shadowRoot) gaps.push({ code: 'UNSUPPORTED_SHADOW_DOM', message: 'Shadow root contents were not collected', selector: selector(el) });
  for (const c of controls) if (c.tag === 'input' && ['color', 'range'].includes(c.constraints.type)) gaps.push({ code: 'UNSUPPORTED_INPUT_TYPE', message: `No V0.1 operation for input type ${c.constraints.type}`, selector: c.selector });
  if (firstOmitted) gaps.push({ code: 'SIGNAL_SCAN_TRUNCATED', selector: selector(firstOmitted), reference: 'discovery:signal', message: `${elements.length - scanned.size} elements outside the current bounded signal scan; first omission at document index ${firstOmittedIndex}. Semantic selectors are collected separately` });
  gaps.push({ code: 'EVENT_LISTENER_COVERAGE', message: 'Complete delegated and addEventListener enumeration is unavailable. Current-element event metadata is only a hint; handler purpose and business effects are unknown. Focus and appearance alone do not establish an operation.' });
  if (all.length > controls.length) gaps.push({ code: 'TRUNCATED', message: `${all.length - controls.length} controls omitted`, critical: true });
  if (bodyText.length > 50000) gaps.push({ code: 'TEXT_TRUNCATED', message: 'Visible text was truncated to 50000 characters' });
  const layers = overlayCollector(controls, regions, roots => {
    const scopes = new Set(roots);
    controls.forEach((control, index) => {
      const el = all[index];
      if (control.label || unnamedScrolls.has(el) || !roots.some(root => root !== el && el.contains(root))) return;
      // A composite popup can remove its list while showing empty results. Its
      // observed boundary still separates that content from the ancestor's name.
      control.name = contentName(el, scopes);
      control.stableKey = scopedControlKey(el, control.name, control.constraints.type);
      if (el.getAttribute('aria-selected') === 'true' && el.tagName !== 'SELECT') control.selected = [control.name];
    });
  }, popupRelations);
  // Detected overlays may introduce regions outside the native semantic selectors.
  for(const c of controls)if(c.structuralItem){
    const item=c.structuralItem;
    if(c.stableKey?.startsWith('item:'))continue; // Preserve established nested record identity.
    const el=all[controls.indexOf(c)];
    const localKey=el.getAttribute('data-testid')||el.getAttribute('name')||(c.role==='link'&&item.recordKey?.startsWith('["href",')?'record-link':JSON.stringify([c.role,c.label||c.name,c.constraints.type]));
    // A corresponding DOM slot organizes decisions; it is not proof that two
    // same-named controls in one record have distinct historical identities.
    c.stableKey=item.recordKey?`structural-item:${JSON.stringify([item.ownerInstanceId,item.recordKey,localKey])}`:undefined;
  }
  for (const region of regions) if (!region.instanceId) {
    const owners = document.querySelectorAll(region.selector);
    if (owners.length === 1) region.instanceId = instance(owners[0]);
  }
  identityCollector(all.slice(0, 1500), controls);
  const components = componentCollector(all.slice(0, 1500), controls, popupRelations);
  const scrollSurfaces = scrollCollector(layers.overlays);
  if (scrollSurfaces.truncated) gaps.push({ code: 'SCROLL_CONTAINERS_TRUNCATED', message: 'Scroll container inventory was truncated' });
  if (scrollSurfaces.unsupported) gaps.push({ code: 'SCROLL_WRITING_MODE_UNSUPPORTED', message: 'Scroll traversal supports horizontal-tb, ltr containers' });
  return { scrollContainers: scrollSurfaces.containers, documentId: tracker.documentId as string, url: location.href, title: document.title, text: bodyText.slice(0, 50000), controls, regions, components, ...layers, structuralLists: listDescription(structuralScan, controls, all.slice(0, 1500), instance), detailDom: detailCollector && detailOptions ? detailCollector(detailOptions, regions) : undefined, scroll: { x: scrollX, y: scrollY, maxY: Math.max(0, (document.documentElement?.scrollHeight ?? 0) - innerHeight) }, gaps };
}
