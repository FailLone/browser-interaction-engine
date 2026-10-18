import {boundaryExitTransition} from './capture-readiness.js';
import { scrollProbeInPage, scrollProbeSchema } from './scroll-probe.js';
import {navigationIntent,sameHTTPDestination} from './navigation.js';
import {executionURLAllowed} from './execution-boundary.js';
import { collectScrollContainers, traversalScrollInPage, traversalScrollSchema } from './scroll-containers.js';
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';
import { createHash } from 'node:crypto';
import type { CaptureContext, EvidenceStore, InteractionDriver, HookInvoker, PreflightResult } from '@interaction/core';
import { canonical, timeout, hash } from '@interaction/core';
import { observableCanonical } from './model.js';
import { controlSurroundingsReader } from './control-surroundings.js';
import { interactionProjection } from './exploration.js';
import { dependencyProjection, dependencyProjections, nativeFormScope } from './dependencies.js';
import {collectNavigationScopes,navigationScopeFor,navigationScopeProjection} from './navigation-readiness.js';
import { activeInteractionIds, interactionScope, boundaryBinding, targetFacts } from './interaction-scope.js';
import type { Session, EngineHooks } from './types.js';
import { constrain } from './policy.js';
import { id } from './util.js';
import type { ActionCandidate, Context, Control, Gap, Observation, Region, SessionOptions } from './types.js';
import { EngineError } from './types.js';
import { now } from './util.js';
import { collectRegionCandidates } from './region-candidates.js';
import { discoverStructuralLists, describeStructuralLists } from './structural-lists.js';
import type { DiscoveryScanPlan, DiscoverySnapshot } from './discovery-scan.js';
import { collectBoundaryExits } from './collect-boundary-exits.js';
import { dismissalReference, exitCandidateKey, hasReviewedDismissal, preservedControlFacts, type BoundaryExitDispatch } from './boundary-exit.js';
import { collectOverlays } from './overlays.js';
import { collectLiveContent } from './live-content.js';
import { collectActionEvidence } from './action-evidence.js';
import { collectEvidence } from './collect-evidence.js';
import { installImageResourceEvidence } from './image-resource-evidence.js';
import { collectIdentityContexts } from './identity-context.js';
import { collectOwnerDependencies } from './owner-dependencies.js';
import { createOwnerDependencyCodec } from './owner-dependency-codec.js';
import { collectPopupRelations } from './popup-relations.js';
import { collectComponents } from './components.js';
import { evidenceOptionsSchema } from './schema.js';
import { RuntimeRecorder } from './runtime-evidence.js';
import { historyPosition, historyTarget } from './navigation.js';
import type { BrowserHistory } from './types.js';
import type { BrowserEvidenceManifest, DetailSnapshot, DomEvidence, EvidenceOptions } from './evidence-types.js';

type DOMSnapshot = {
  documentId: string; url: string; title: string; text: string; controls: Control[]; regions: Region[];
  overlays: NonNullable<Observation['overlays']>; boundaries: NonNullable<Observation['boundaries']>;
  components?: Observation['components']; regionCandidates?: Observation['regionCandidates']; structuralLists?: Observation['structuralLists'];
  boundaryExitCandidates?: Observation['boundaryExitCandidates'];
  actionDiscovery?: Observation['actionDiscovery']; discoveryScan?: DiscoverySnapshot;
  ownerDependencies?: Observation['ownerDependencies'];
  navigationScopes?: Observation['navigationScopes'];
  scroll: Observation['scroll']; scrollContainers?: Observation['scrollContainers']; gaps: Gap[]; detailDom?: DomEvidence;
};
type OwnerDependencyCollector = (controls: Control[], elements: Element[], instance: (el: Element) => string,
  documentId: string, priorityLocalIds: string[]) => Observation['ownerDependencies'];

// Runs in the page without DOM mutation. Event metadata remains bounded hints.
function collectDOM(overlayCollector: typeof collectOverlays, actionCollector: typeof collectActionEvidence, identityCollector: typeof collectIdentityContexts, popupCollector: typeof collectPopupRelations, componentCollector: typeof collectComponents, scrollCollector: typeof collectScrollContainers, exitCollector: typeof collectBoundaryExits, ownerCollector: OwnerDependencyCollector | undefined, candidateCollector: typeof collectRegionCandidates | undefined, listCollector: typeof discoverStructuralLists | undefined, listDescription: typeof describeStructuralLists | undefined, detailCollector?: typeof collectEvidence, detailOptions?: EvidenceOptions, liveCollector?: typeof collectLiveContent, liveEpoch = 0, scanPlan?: DiscoveryScanPlan, navigationCollector?: typeof collectNavigationScopes) {
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
  const live = liveCollector?.(instance, liveEpoch);
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
  const contentName = (el: Element, independentScopes?: Set<Element>, omitLive = false) => {
    // Fallback names describe this control, not an independent descendant panel.
    // Explicit labels are resolved separately (including hidden referenced text).
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        const child = node as Element;
        if (omitLive && live?.ignored.has(child) || independentScopes?.has(child) || child.matches('script,style,[hidden],[aria-hidden=true],dialog,[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=grid],[role=tree],[role=tabpanel],[role=tooltip],[popover]')) return NodeFilter.FILTER_REJECT;
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
  regions.unshift({ key: 'document', instanceId: document.documentElement ? instance(body || document.documentElement) : undefined, label: document.title, role: 'document', selector: 'body', parentKey: '', rect: rect(body), text: bodyText.slice(0, 8000) });
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
  const scanRoot = scanPlan && scanPlan.documentId === tracker.documentId && scanPlan.url === location.href ? elements.find(el => tracker.ids.get(el) === scanPlan.targetId) : undefined;
  const scopedElements = scanRoot ? [scanRoot, ...scanRoot.querySelectorAll('*')] : [];
  const scanElements = [...new Set([...elements.slice(0, 5000), ...(scanPlan && scanRoot ? scopedElements.slice(scanPlan.budget.offset, scanPlan.budget.offset + scanPlan.budget.elements) : [])])];
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
  const structuralElements = scanRoot && !scanElements.includes(scanRoot) ? [...scanElements, scanRoot] : scanElements;
  const structuralScan=listCollector?.(structuralElements,selected,instance,selector,actionCollector,scanRoot&&scanPlan?{root:scanRoot,...scanPlan.budget}:undefined)||{candidates:[],limits:{templatesTruncated:0,collectionsTruncated:false,rowWindowsTruncated:0,omissions:[],omittedLocations:0}};
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
    const liveEvidence = live?.evidence.get(el);
    const liveName = liveEvidence?.length ? label(el) || contentName(el, undefined, true) : undefined;
    const liveContent = liveName ? { name: liveName, text: contentName(el, undefined, true), evidence: liveEvidence! } : undefined;
    const stableKey = scopedControlKey(el, liveName || name, type);
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
      localId: instance(el), instanceId: instance(el), tag: el.tagName.toLowerCase(), role: semanticRole, name, label: label(el), stableKey, ...(identityScope ? { identityScope } : {}), ...(liveContent ? { liveContent } : {}),
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
  const targetElements = new Set<Element>(document.documentElement ? [document.documentElement] : []);
  if (firstOmitted?.parentElement) targetElements.add(firstOmitted.parentElement);
  const omittedOwners = new Set(structuralScan.limits.omissions.map(o => o.ownerId));
  for (const el of elements) if (omittedOwners.has(tracker.ids.get(el))) targetElements.add(el);
  const discoveryScan: DiscoverySnapshot = { version: 'dom-discovery/v1', topologyKey: '', nodeCount: elements.length,
    signal: { baselineLimit: 5000, scanned: scanned.size, omitted: elements.length - scanned.size,
      ...(firstOmitted ? { firstOmitted: { id: instance(firstOmitted), selector: selector(firstOmitted), index: firstOmittedIndex, parentId: firstOmitted.parentElement ? instance(firstOmitted.parentElement) : undefined } } : {}) },
    structural: structuralScan.limits, controls: { discovered: all.length, collected: controls.length, limit: 1500 },
    targets: [...targetElements].map(el => ({ id: instance(el), selector: el === document.documentElement ? 'html' : selector(el), tag: el.tagName.toLowerCase(), label: label(el), elementCount: 1 + el.querySelectorAll('*').length })),
    ...(scanPlan ? { supplement: { requestId: scanPlan.requestId, targetId: scanPlan.targetId, budget: scanPlan.budget, status: scanRoot ? 'active' : 'invalidated', ...(!scanRoot ? { reason: 'scan_root_changed' } : {}) } } : {}) };
  // Returned only to the host for hashing; the full topology is not retained in observations.
  const discoveryTopology = elements.map(el => [instance(el), el.parentElement ? instance(el.parentElement) : '', el.tagName]);
  const gaps: (Gap & {selector?:string})[] = [];
  const coverageScope=(el:Element):NonNullable<Gap['coverageScope']>=>({version:'dom-subtree-v1',documentId:tracker.documentId,rootInstanceId:instance(el),ancestorInstanceIds:ancestry(el).instanceIds,
    affectedControlIds:controls.filter((_control,index)=>el.contains(all[index])).map(control=>control.localId),complete:ancestry(el).complete&&all.length===controls.length,...(landmark(el)?{landmark:landmark(el)}:{})});
  if(structuralScan.limits.templatesTruncated||structuralScan.limits.collectionsTruncated||structuralScan.limits.rowWindowsTruncated)gaps.push({code:'STRUCTURAL_LIST_SCAN_TRUNCATED',reference:'discovery:structural',message:`Repeated-record discovery: ${structuralScan.limits.templatesTruncated} limited templates, ${structuralScan.limits.rowWindowsTruncated} partial sibling windows; collection limit reached: ${structuralScan.limits.collectionsTruncated}`});
  for (const omission of structuralScan.limits.omissions) gaps.push({ code: 'STRUCTURAL_DISCOVERY_LIMIT', selector: omission.rowSelector || omission.ownerSelector, reference: `discovery:${omission.ownerId}:${omission.rowId || ''}:${omission.kind}`, message: `${omission.kind}: limit ${omission.limit}, observed at least ${omission.observed}; inspect discoveryScan for the exact owner and bounded supplementation target` });
  if (!body) gaps.push({ code: 'DOM_ROOT_UNAVAILABLE', message: 'Document body is absent; the page may be navigating or rebuilding', critical: true });
  if (document.readyState === 'loading') gaps.push({ code: 'DOCUMENT_LOADING', message: 'Document parsing is still in progress', critical: true });
  for (const el of document.querySelectorAll('iframe,canvas,input[type=file]')) gaps.push({ code: `UNSUPPORTED_${el.tagName === 'INPUT' ? 'FILE_INPUT' : el.tagName}`, message: `${el.tagName} internals are outside V0.1 coverage`, selector: selector(el),coverageScope:coverageScope(el) });
  for (const el of elements) if (el.shadowRoot) gaps.push({ code: 'UNSUPPORTED_SHADOW_DOM', message: 'Shadow root contents were not collected', selector: selector(el),coverageScope:coverageScope(el) });
  for (const c of controls) if (c.tag === 'input' && ['color', 'range'].includes(c.constraints.type)) gaps.push({ code: 'UNSUPPORTED_INPUT_TYPE', message: `No V0.1 operation for input type ${c.constraints.type}`, selector: c.selector,coverageScope:coverageScope(all[controls.indexOf(c)]) });
  if (firstOmitted) gaps.push({ code: 'SIGNAL_SCAN_TRUNCATED', selector: selector(firstOmitted), reference: 'discovery:signal', message: `${discoveryScan.signal.omitted} elements outside the current bounded signal scan; first omission at document index ${firstOmittedIndex}. Semantic selectors are collected separately` });
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
  // Prioritize every member of the observed exclusive interaction boundary,
  // including ordinary buttons. This only allocates evidence: global selectors
  // and native inputs remain required, and no coverage/identity is inferred.
  const active = layers.overlays.at(-1);
  const priorityLocalIds = active && active.key === layers.boundaries.at(-1)?.key ? [...new Set([...active.exitControlIds, ...active.controlIds])] : [];
  const ownerDependencies = ownerCollector?.(controls, all.slice(0, 1500), instance, tracker.documentId, priorityLocalIds);
  if (ownerDependencies && all.length !== controls.length) { ownerDependencies.inventoryComplete = false; ownerDependencies.complete = false; ownerDependencies.reasons.push('control_inventory_truncated'); }
  return { ...(ownerDependencies ? { ownerDependencies } : {}), ...(navigationCollector ? {navigationScopes:navigationCollector(controls,instance)} : {}), scrollContainers: scrollSurfaces.containers, documentId: tracker.documentId as string, url: location.href, title: document.title, text: bodyText.slice(0, 50000), controls, regions, components, ...layers, boundaryExitCandidates: exitCollector(layers.overlays, instance, selector), discoveryScan, discoveryTopology, regionCandidates: candidateCollector?.(controls, all.slice(0, 1500), instance, selector), structuralLists:listDescription?.(structuralScan,controls,all.slice(0,1500),instance), actionDiscovery: { version: 'dom-actions-v2' as const, documentHints }, detailDom: detailCollector && detailOptions ? detailCollector(detailOptions, regions) : undefined, scroll: { x: scrollX, y: scrollY, maxY: Math.max(0, (document.documentElement?.scrollHeight ?? 0) - innerHeight) }, gaps };
}

export class BrowserAdapter implements InteractionDriver<Observation, SessionOptions> {
  browser?: Browser; context?: BrowserContext; page?: Page;
  private gaps: Gap[] = [];
  private liveEpoch = 0;
  private recorder?: RuntimeRecorder;
  private navigationClient?: CDPSession;
  private navigationSessionId = '';
  private documentMethods = new Map<string, string>();
  private entryMethods = new Map<number, string>();
  private loaderMethods = new Map<string, string>();
  private documentRequests = new Map<string, { loaderId: string; method: string }>();
  private lastDocumentResponse?: { url: string; method: string };
  private discoveryPlan?: DiscoveryScanPlan & { status: 'active' | 'invalidated'; reason?: string };
  private preparedOwnerDispatch?: { action: ActionCandidate; beforeId: string; graphKey: string; context: Context;
    documentId: string; instanceScope: string; browserSessionId: string; url: string };
  private ownerDispatch?: Observation['ownerDependencyDispatch'];
  setDiscoveryScan(plan: DiscoveryScanPlan) { this.discoveryPlan = { ...structuredClone(plan), status: 'active' }; }
  async validateDiscoveryScan(current: Observation) {
    const live = await timeout(this.readDOM(false, false), this.options.observeTimeoutMs, 'Discovery validation deadline exceeded');
    return !live.gaps.some(g => g.critical) && live.documentId === current.documentId && live.url === current.url
      && !!current.discoveryScan && live.discoveryScan?.topologyKey === current.discoveryScan.topologyKey;
  }
  invalidateDiscoveryScan(reason: string) { if (this.discoveryPlan) this.discoveryPlan = { ...this.discoveryPlan, status: 'invalidated', reason }; }
  constructor(public options: SessionOptions, private evidence: EvidenceStore, private hooks: EngineHooks = {}) { this.options = { ...options, evidence: evidenceOptionsSchema.parse(options.evidence) }; }
  connected() { return !!this.page && !this.page.isClosed(); }
  async start() {
    this.browser = await chromium.launch({ headless: this.options.headless });
    this.context = await this.browser.newContext({ viewport: this.options.viewport, storageState: this.options.storageState as any, acceptDownloads: false });
    this.page = await this.context.newPage();
    this.navigationSessionId = id(); this.documentMethods.clear(); this.entryMethods.clear(); this.loaderMethods.clear(); this.documentRequests.clear(); this.lastDocumentResponse = undefined;
    this.navigationClient = await this.context.newCDPSession(this.page);
    // A document may replace its URL before the first capture. Bind the HTTP
    // method to its native loader, never infer GET from the rewritten pathname.
    this.navigationClient.on('Network.requestWillBeSent', event => {
      if (event.type === 'Document') this.documentRequests.set(event.requestId, { loaderId: event.loaderId, method: event.request.method });
    });
    this.navigationClient.on('Network.responseReceived', event => {
      const request = this.documentRequests.get(event.requestId);
      if (event.type === 'Document' && request && request.loaderId === event.loaderId) {
        this.loaderMethods.set(event.loaderId, request.method);
        this.documentRequests.delete(event.requestId);
      }
    });
    await this.navigationClient.send('Network.enable');
    this.page.on('response', response => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === this.page?.mainFrame()) this.lastDocumentResponse = { url: response.url(), method: request.method() };
    });
    this.recorder = new RuntimeRecorder(this.options.evidence.maxRuntimeEntries, this.options.evidence.maxTextLength);
    if (this.options.evidence.enabled) this.recorder.attach(this.page);
    if (this.options.evidence.enabled) await this.page.addInitScript(`(() => { const __name = fn => fn; (${installImageResourceEvidence.toString()})(); })()`);
    this.page.setDefaultTimeout(this.options.actionTimeoutMs);
    this.context.on('page', async p => { if (p !== this.page) { this.gaps.push({ code: 'UNSUPPORTED_NEW_TAB', message: `New tab blocked: ${p.url()}`, critical: true }); await p.close().catch(() => {}); } });
    this.page.on('dialog', async dialog => { this.gaps.push({ code: 'UNSUPPORTED_NATIVE_DIALOG', message: `${dialog.type()}: ${dialog.message()}; dismissed`, critical: true }); await dialog.dismiss().catch(() => {}); });
    this.page.on('download', d => { this.gaps.push({ code: 'UNSUPPORTED_DOWNLOAD', message: d.suggestedFilename(), critical: true }); void d.cancel().catch(() => {}); });
    await this.page.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === this.page?.mainFrame() && (new URL(request.url()).origin !== new URL(this.options.url).origin
        ||this.options.executionBoundary&&!executionURLAllowed(this.options.executionBoundary,request.url(),true))) {
        this.gaps.push({ code: 'OUT_OF_SCOPE_NAVIGATION', message: request.url(), critical: true }); await route.abort();
      } else await route.continue();
    });
    await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' });
  }
  private async readHistory(documentId?: string): Promise<BrowserHistory> {
    if (!this.navigationClient) throw new EngineError('BROWSER_UNAVAILABLE', 'Native navigation history is unavailable');
    const history = await this.navigationClient.send('Page.getNavigationHistory');
    const current = history.entries[history.currentIndex];
    if (documentId && current) {
      const { frameTree } = await this.navigationClient.send('Page.getFrameTree'), frame = frameTree.frame;
      const loaderMethod = this.loaderMethods.get(frame.loaderId);
      if (!this.documentMethods.has(documentId) && loaderMethod && frame.url + (frame.urlFragment || '') === current.url) this.documentMethods.set(documentId, loaderMethod);
      const withoutHash = (url: string) => url.split('#')[0];
      if (!this.documentMethods.has(documentId) && this.lastDocumentResponse && withoutHash(this.lastDocumentResponse.url) === withoutHash(current.url)) {
        this.documentMethods.set(documentId, this.lastDocumentResponse.method);
      }
      const method = this.documentMethods.get(documentId);
      if (method) this.entryMethods.set(current.id, method);
    }
    return { browserSessionId: this.navigationSessionId, currentIndex: history.currentIndex,
      entries: history.entries.map(e => ({ id: e.id, url: e.url, method: this.entryMethods.get(e.id) })) };
  }
  /** Validation reads retain fresh DOM guards without building persistence-only
   * dependency evidence. Capture always requests the graph in the same sample. */
  async readDOM(detailed = false, ownerDependencies = true): Promise<DOMSnapshot> {
    if (!this.page || this.page.isClosed()) throw new EngineError('BROWSER_UNAVAILABLE', 'Browser is not connected');
    // tsx preserves nested function names using a module-local helper. Supply it
    // inside the serialized closure so development and compiled execution agree.
    const args = `, ${this.options.regionExploration === 'review' ? collectRegionCandidates.toString() : 'undefined'}, ${this.options.listExploration !== undefined ? discoverStructuralLists.toString() : 'undefined'}, ${this.options.listExploration !== undefined ? describeStructuralLists.toString() : 'undefined'}, ${detailed ? collectEvidence.toString() : 'undefined'}, ${JSON.stringify(this.options.evidence)}, ${this.options.exploration === 'controls' ? collectLiveContent.toString() : 'undefined'}, ${this.liveEpoch}, ${this.discoveryPlan?.status === 'active' ? JSON.stringify(this.discoveryPlan) : 'undefined'}, ${this.options.executionBoundary?.programNavigation ? collectNavigationScopes.toString() : 'undefined'}`;
    const ownerCollector = ownerDependencies && this.options.exploration === 'controls'
      ? `(controls, elements, instance, documentId, priorityLocalIds) => (${collectOwnerDependencies.toString()})(controls, elements, instance, documentId, undefined, (${createOwnerDependencyCodec.toString()}), priorityLocalIds)`
      : 'undefined';
    const source = `(() => { const __name = (fn) => fn; const dom = (${collectDOM.toString()})(${collectOverlays.toString()}, ${collectActionEvidence.toString()}, ${collectIdentityContexts.toString()}, ${collectPopupRelations.toString()}, ${collectComponents.toString()}, ${collectScrollContainers.toString()}, ${collectBoundaryExits.toString()}, ${ownerCollector}${args}); return JSON.stringify(dom); })()`;
    // Preserve arbitrary legal HTML attribute keys across the automation protocol.
    // The complete snapshot is inert JSON evidence. One string avoids the browser
    // protocol recursively tagging, validating and reconstructing every field.
    // Capture scope, samples, bounds and all retained evidence stay unchanged.
    const raw = JSON.parse(await this.page.evaluate(source) as string) as DOMSnapshot & { discoveryTopology: string[][]; discoveryScan: DiscoverySnapshot };
    const { discoveryTopology, ...dom } = raw;
    dom.discoveryScan.topologyKey = hash(discoveryTopology);
    const plan = this.discoveryPlan;
    if (plan?.status === 'active' && (dom.documentId !== plan.documentId || dom.url !== plan.url || dom.discoveryScan.topologyKey !== plan.topologyKey || dom.discoveryScan.supplement?.status !== 'active')) {
      this.invalidateDiscoveryScan('document_url_or_topology_changed');
      return this.readDOM(detailed, ownerDependencies);
    }
    if (plan?.status === 'invalidated') dom.discoveryScan.supplement = { requestId: plan.requestId, targetId: plan.targetId, budget: plan.budget, status: 'invalidated', reason: plan.reason };
    return dom;
  }
  async capture(observationId: string, captureContext?: CaptureContext<Observation>) {
    // A capture consumes the slot even on failure, mismatch or ordinary observe.
    const dispatch = this.ownerDispatch; this.ownerDispatch = undefined; this.preparedOwnerDispatch = undefined;
    return this.captureWithinDeadline(observationId, captureContext, Date.now() + this.options.observeTimeoutMs, dispatch);
  }
  private async captureWithinDeadline(observationId: string, captureContext: CaptureContext<Observation> | undefined,
    deadline: number, dispatch: Observation['ownerDependencyDispatch'], consistencyRetries = 0): ReturnType<InteractionDriver<Observation, SessionOptions>['capture']> {
    const dispatched = captureContext?.afterAction;
    const ownerDependencyDispatch = dispatch && dispatched && dispatch.beforeId === dispatched.before.id
      && dispatch.sessionId === dispatched.before.sessionId && dispatch.actionId === dispatched.action.id
      && dispatched.before.ownerDependencies?.inventoryComplete
      && dispatch.documentId === dispatched.before.documentId && dispatch.instanceScope === dispatched.before.instanceScope
      && dispatch.browserSessionId === dispatched.before.navigation?.browserSessionId && dispatch.browserSessionId === this.navigationSessionId
      && dispatch.url === dispatched.before.url
      && dispatch.actionKey === hash(dispatched.action) && dispatch.graphKey === hash(dispatched.before.ownerDependencies)
      && dispatch.contextKey === hash(dispatched.before.context) ? dispatch : undefined;
    if (!this.page) throw new EngineError('BROWSER_UNAVAILABLE', 'Browser is not connected');
    let stable = false; let interactionStable = false; let captureRetries = 0;
    let dom: Awaited<ReturnType<BrowserAdapter['readDOM']>> | undefined;
    let lastError: string | undefined;
    // All windows describe the same sampled DOM. Time spent computing its
    // projections cannot turn a single sample into stability evidence.
    let sampledAt = 0;
    const projections = new WeakMap<object, Map<string, string>>();
    const project = (view: NonNullable<typeof dom>) => {
      if (!projections.has(view)) {
        const result=dependencyProjections(view);
        for(const scope of view.navigationScopes||[])if(scope.complete&&scope.binding){
          const key=navigationScopeProjection(view,scope);
          for(const localId of scope.controlIds){const target=view.controls.find(c=>c.localId===localId);if(target&&!scope.blockedControlIds.includes(localId)&&!result.has(target.instanceId))result.set(target.instanceId,key);}
        }
        projections.set(view,result);
      }
      return projections.get(view)!;
    };
    const dependencyWindows = new Map<string, { key: string; since: number }>();
    let exitWindow:{since:number;samples:number}|undefined;
    let documentWindow:{key:string;since:number;samples:number}|undefined;
    const sampleDependencies = (view: NonNullable<typeof dom>) => {
      if(pending&&boundaryExitTransition(pending.action,pending.before,view)){
        if(exitWindow)exitWindow.samples++;else exitWindow={since:sampledAt,samples:1};
      }else exitWindow=undefined;
      const documentKey=JSON.stringify([view.documentId,view.url]);
      if(view.gaps.some(g=>g.critical||['DOM_ROOT_UNAVAILABLE','DOCUMENT_LOADING'].includes(g.code)))documentWindow=undefined;
      else if(documentWindow?.key===documentKey)documentWindow.samples++;
      else documentWindow={key:documentKey,since:sampledAt,samples:1};
      const present = new Set<string>();
      for (const control of view.controls) {
        const key = project(view).get(control.instanceId); if (!key) continue;
        present.add(control.instanceId);
        if (dependencyWindows.get(control.instanceId)?.key !== key) dependencyWindows.set(control.instanceId, { key, since: sampledAt });
      }
      for (const key of dependencyWindows.keys()) if (!present.has(key)) dependencyWindows.delete(key);
    };
    const readyDependencies = (view: NonNullable<typeof dom>) => new Set(view.controls.filter(control => {
      const window = dependencyWindows.get(control.instanceId);
      return control.visible && (control.enabled || control.instanceId===pendingTarget?.instanceId) && !!window && window.key === project(view).get(control.instanceId)
        && sampledAt - window.since >= this.options.settleMs;
    }).map(control => control.instanceId));
    const pending = captureContext?.afterAction;
    const pendingTarget = pending?.before.controls.find(c => c.localId === pending.action.localId);
    const pendingScope = pending?.action.risk === 'interface' && pendingTarget ? nativeFormScope(pendingTarget, pending.action.kind) : undefined;
    const pendingNavigationScope=pendingTarget&&navigationScopeFor(pending!.before,[pendingTarget.localId]);
    const pendingNavigation=pending&&navigationIntent(pending.action,pending.before);
    const sameWindow=!pendingTarget?.reviewBinding?.attributes.target||pendingTarget.reviewBinding.attributes.target==='_self';
    const navigationReady=(view:NonNullable<typeof dom>)=>!!pendingNavigation&&sameWindow&&!!documentWindow&&documentWindow.samples>=2
      &&documentWindow.key===JSON.stringify([view.documentId,view.url])&&sampledAt-documentWindow.since>=this.options.settleMs
      &&(view.documentId!==pending!.before.documentId||sameHTTPDestination(pendingNavigation!.targetUrl,view.url))&&view.url!==pending!.before.url&&!view.gaps.some(g=>g.critical);
    const exitReady=(view:NonNullable<typeof dom>)=>!!pending&&!!exitWindow&&exitWindow.samples>=2&&sampledAt-exitWindow.since>=this.options.settleMs
      &&boundaryExitTransition(pending.action,pending.before,view);
    const partialSufficient = (view: NonNullable<typeof dom>) => {
      const ready = readyDependencies(view);
      if (!pending) return ready.size > 0;
      if(exitReady(view))return true;
      // Native navigation addresses the browser document, not a changing field
      // on its destination. Retain each unready control; do not replay the link.
      if(navigationReady(view)){
        // A committed document is enough for the navigation receipt, but a
        // captured local navigation region gets the remaining bounded window
        // to settle before the caller chooses whether to leave the destination.
        const scopes=view.navigationScopes?.filter(scope=>scope.complete&&scope.binding)||[];
        return !scopes.length||scopes.some(scope=>scope.controlIds.some(id=>view.controls.some(c=>c.localId===id&&ready.has(c.instanceId))));
      }
      if(pendingNavigationScope&&pendingTarget&&ready.has(pendingTarget.instanceId)
        &&navigationScopeFor(view,[pendingTarget.localId])?.rootId===pendingNavigationScope.rootId)return true;
      // An unrelated ready input cannot finish a click/navigation's observation.
      // Native field operations may still finish using their own verified form.
      return !!pendingScope && !!pendingTarget && ready.has(pendingTarget.instanceId)
        && view.controls.some(c => c.instanceId === pendingTarget.instanceId && nativeFormScope(c, pending.action.kind) === pendingScope);
    };
    const evidenceManifest: BrowserEvidenceManifest = { schemaVersion: 1, status: this.options.evidence.enabled ? 'captured' : 'disabled', artifacts: {}, gaps: [] };
    for (;;) {
      let previous = ''; let unchangedSince = Date.now();
      let previousInteraction = ''; let interactionSince = Date.now();
      stable = false; interactionStable = false;
      do {
        try {
          dom = await timeout(this.readDOM(false, true), Math.max(1, deadline - Date.now()), 'DOM capture deadline exceeded');
          sampledAt = Date.now();
          lastError = undefined;
          sampleDependencies(dom);
          const incomplete = dom.gaps.some(g => ['DOM_ROOT_UNAVAILABLE', 'DOCUMENT_LOADING'].includes(g.code));
          const key = JSON.stringify({ documentId: dom.documentId, url: dom.url, overlays: dom.overlays.map(o => o.key), controls: dom.controls.map(c => [c.instanceId, c.name, c.value, c.displayedText, c.checked, c.pressed, c.visible, c.enabled, c.editable, c.expanded, c.constraints, c.rect, c.actionable.hitTarget, c.actionBasis]) });
          if (key !== previous || incomplete) { previous = key; unchangedSince = sampledAt; }
          const scoped = interactionScope(dom);
          const interactive = interactionProjection(scoped) + boundaryBinding(dom) + canonical(scoped.regionCandidates?.map(c => [c.id, c.binding])) + canonical(scoped.structuralLists);
          if (interactive !== previousInteraction || incomplete) { previousInteraction = interactive; interactionSince = sampledAt; }
          interactionStable = !incomplete && sampledAt - interactionSince >= this.options.settleMs;
          if (!incomplete && sampledAt - unchangedSince >= this.options.settleMs) { stable = true; break; }
          if (this.options.exploration === 'controls' && !dom.gaps.some(g => g.critical) && (interactionStable || partialSufficient(dom))) break;
        } catch (error) {
          dependencyWindows.clear(); documentWindow=undefined; exitWindow=undefined; lastError = String(error); previous = ''; unchangedSince = Date.now(); previousInteraction = ''; interactionSince = Date.now(); interactionStable = false;
          if (this.page.isClosed()) break;
        }
        if (Date.now() >= deadline) break;
        await new Promise(r => setTimeout(r, Math.min(50, Math.max(0, deadline - Date.now()))));
      } while (Date.now() < deadline);
      if (this.options.evidence.enabled && dom && !lastError) {
        try {
          const detailed = await timeout(this.readDOM(true, true), this.options.observeTimeoutMs, 'Detailed DOM capture deadline exceeded');
          if (observableCanonical({ ...dom, context: {} }) !== observableCanonical({ ...detailed, context: {} }) || dom.documentId !== detailed.documentId || canonical(dom.regionCandidates?.map(c => [c.id, c.binding])) !== canonical(detailed.regionCandidates?.map(c => [c.id, c.binding])) || canonical(dom.structuralLists) !== canonical(detailed.structuralLists)) {
            interactionStable &&= interactionProjection(interactionScope(dom)) === interactionProjection(interactionScope(detailed)) && boundaryBinding(dom) === boundaryBinding(detailed) && canonical(interactionScope(dom).regionCandidates?.map(c => [c.id, c.binding])) === canonical(interactionScope(detailed).regionCandidates?.map(c => [c.id, c.binding])) && canonical(interactionScope(dom).structuralLists) === canonical(interactionScope(detailed).structuralLists);
            stable = false;
            const critical = !(this.options.exploration === 'controls' && (interactionStable || readyDependencies(detailed).size > 0 || navigationReady(detailed) || exitReady(detailed)));
            const sufficient = this.options.exploration === 'controls' && (interactionStable || partialSufficient(detailed));
            dom = detailed;
            // A transition can arrive after the quiet sampling window. Re-sample
            // for this action within the original deadline. Its needs do not
            // invalidate unrelated ready facts or authorize repeating the action.
            if (!sufficient && Date.now() < deadline) { captureRetries++; continue; }
            detailed.gaps.push({ code: 'EVIDENCE_CAPTURE_CHANGED', message: 'Page changed between stability sampling and detailed capture', critical });
          }
          dom = detailed;
        } catch (error) { evidenceManifest.gaps.push({ code: 'DETAIL_CAPTURE_FAILED', message: String(error) }); }
      }
      break;
    }
    // Keep the last successful evidence, or an explicitly incomplete record when
    // the execution context never became readable. Never replay the action here.
    dom ??= { documentId: `unavailable:${id()}`, url: this.page.url(), title: '', text: '', controls: [], regions: [], overlays: [], boundaries: [], scroll: { x: 0, y: 0, maxY: 0 }, gaps: [] };
    const ready = this.options.exploration === 'controls' && !stable && !interactionStable && !lastError && !dom.gaps.some(g => g.critical)
      ? readyDependencies(dom) : new Set<string>();
    const capturedAt = now(); const gaps = [...dom.gaps, ...this.gaps.splice(0)];
    let navigation: BrowserHistory | undefined;
    try { navigation = await this.readHistory(dom.documentId); }
    catch (error) { gaps.push({ code: 'NAVIGATION_HISTORY_UNAVAILABLE', message: String(error) }); }
    const currentEntry=navigation?.entries[navigation.currentIndex],sourceHistory=pending?.before.navigation;
    const navigationPositionCapture:Observation['navigationPositionCapture']=!lastError&&documentWindow&&documentWindow.samples>=2
      &&documentWindow.key===JSON.stringify([dom.documentId,dom.url])&&sampledAt-documentWindow.since>=this.options.settleMs
      &&!gaps.some(g=>g.critical)&&currentEntry?.url===dom.url&&currentEntry.method==='GET'
      ?{version:1,documentId:dom.documentId,url:dom.url,browserSessionId:navigation!.browserSessionId,entryId:currentEntry.id,samples:documentWindow.samples,settledMs:sampledAt-documentWindow.since}:undefined;
    const navigationCapture:Observation['navigationCapture']=!lastError&&navigationReady(dom)&&currentEntry?.method==='GET'&&currentEntry.url===dom.url
      &&sourceHistory?.browserSessionId===navigation?.browserSessionId&&sourceHistory?.entries[sourceHistory.currentIndex]?.method==='GET'
      &&(dom.documentId===pending!.before.documentId||currentEntry.id!==sourceHistory.entries[sourceHistory.currentIndex].id)
      ?{...(dom.documentId===pending!.before.documentId?{version:2 as const,transition:'same-document-url' as const,sourceEntryId:sourceHistory.entries[sourceHistory.currentIndex].id,entryId:currentEntry.id}:{version:1 as const}),beforeId:pending!.before.id,actionId:pending!.action.id,sourceDocumentId:pending!.before.documentId,documentId:dom.documentId,sourceUrl:pending!.before.url,requestedUrl:pendingNavigation!.targetUrl,observedUrl:dom.url,samples:documentWindow!.samples,settledMs:sampledAt-documentWindow!.since}:undefined;
    const boundaryExitCapture:Observation['boundaryExitCapture']=!lastError&&exitReady(dom)?{version:1,beforeId:pending!.before.id,actionId:pending!.action.id,samples:exitWindow!.samples,settledMs:sampledAt-exitWindow!.since}:undefined;
    if(ready.size||(navigationCapture||boundaryExitCapture)&&!stable&&!interactionStable)for(const control of dom.controls)if(!ready.has(control.instanceId)){
      control.readiness={status:'unstable',reason:'This operation’s dependency scope did not settle during capture'};
    }
    if(boundaryExitCapture&&!stable&&!interactionStable)gaps.push({code:'PARTIAL_BOUNDARY_EXIT_READY',message:'The exclusive layer closed and the remaining boundary stack settled; parent control dependencies remain independently unready'});
    if(navigationCapture&&!stable&&!interactionStable)gaps.push({code:'PARTIAL_NATIVE_NAVIGATION_READY',message:'The native HTTP destination and GET history were observed; destination control dependencies remain independently unready'});
    if (captureRetries) gaps.push({ code: 'EVIDENCE_CAPTURE_RETRIED', message: `Re-sampled after ${captureRetries} change(s) during detailed capture; the browser action was not repeated` });
    if (lastError) gaps.push({ code: 'DOM_CAPTURE_FAILED', message: lastError, critical: true });
    if (!stable) gaps.push({ code: 'UNSTABLE', message: 'Page did not settle within the observation budget', critical: !(this.options.exploration === 'controls' && (interactionStable || ready.size > 0 || !!navigationCapture || !!boundaryExitCapture)) });
    if (ready.size) gaps.push({ code: 'PARTIAL_INTERACTION_READY', message: `${ready.size} local targets have stable captured dependencies; unsettled operations remain blocked` });
    if (!stable && this.options.exploration === 'controls' && interactionStable) gaps.push({ code: 'INTERACTION_STABLE', message: 'Supported interactive controls settled; passive display changes remain in the full observation' });
    const context: Context = Object.fromEntries(Object.entries(this.options.context).map(([k, value]) => [k, { value, status: 'known', source: 'declared' }]));
    for (const rule of this.options.contextRules) {
      try {
        const locator = this.page.locator(rule.selector);
        if (await locator.count() !== 1) throw new Error('Context selector is absent or ambiguous');
        const value = rule.attribute ? await locator.getAttribute(rule.attribute) : await locator.evaluate(el => 'value' in el ? String((el as HTMLInputElement).value) : el.textContent?.trim() ?? '');
        if (value === null) throw new Error('Context attribute absent');
        context[rule.key] = { value, status: 'known', source: `dom:${rule.selector}` };
      } catch (error) {
        context[rule.key] = { value: null, status: 'unknown', source: `dom:${rule.selector}` };
        gaps.push({ code: 'CONTEXT_UNKNOWN', message: `${rule.key}: ${String(error)}`, critical: rule.required ?? true });
      }
    }
    let screenshot: string | undefined; let screenshotAt: string | undefined;
    const saveImage = async (key: string, fullPage = false) => {
      // Hiding carets can leave an empty style attribute on inputs after capture,
      // invalidating the very subtree evidence we just collected.
      const data = await this.page!.screenshot({ timeout: this.options.actionTimeoutMs, fullPage, caret: 'initial' }); const at = now();
      await this.evidence.put(key, { data, mediaType: 'image/png' });
      // Hash the exact bytes rather than their JSON representation.
      return { key, mediaType: 'image/png', capturedAt: at, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    };
    try { screenshot = `${observationId}.png`; evidenceManifest.artifacts.screenshot = await saveImage(screenshot); screenshotAt = evidenceManifest.artifacts.screenshot.capturedAt; }
    catch (error) { gaps.push({ code: 'SCREENSHOT_FAILED', message: String(error), critical: error instanceof EngineError && error.code === 'EVIDENCE_BUDGET_EXHAUSTED' }); screenshot = undefined; }
    const accessibility: DetailSnapshot['accessibility'] = { status: 'disabled', format: 'playwright-aria-yaml', gaps: [] };
    if (this.options.evidence.enabled && this.options.evidence.accessibility) {
      try {
        const text = await this.page.locator('body').ariaSnapshot({ timeout: this.options.observeTimeoutMs });
        Object.assign(accessibility, { status: 'captured', capturedAt: now(), text: text.slice(0, this.options.evidence.maxHtmlLength), truncated: text.length > this.options.evidence.maxHtmlLength });
        if (accessibility.truncated) accessibility.gaps.push({ code: 'ARIA_TRUNCATED', message: 'ARIA snapshot exceeds the configured character limit' });
      } catch (error) { accessibility.status = 'unavailable'; accessibility.gaps.push({ code: 'ARIA_UNAVAILABLE', message: String(error) }); }
    }
    if (this.options.evidence.enabled && this.options.evidence.fullPageScreenshot) {
      try { evidenceManifest.artifacts.fullPageScreenshot = await saveImage(`${observationId}.full.png`, true); }
      catch (error) { evidenceManifest.gaps.push({ code: 'FULL_PAGE_SCREENSHOT_FAILED', message: String(error) }); }
    }
    try {
      const current = await timeout(this.page.evaluate(() => ({ documentId: (window as any).__interactionEvidenceTracker?.documentId, hasBody: !!document.body })), this.options.observeTimeoutMs, 'Document verification deadline exceeded');
      if (current.documentId !== dom.documentId || !current.hasBody) { stable = false; gaps.push({ code: 'OBSERVATION_INTERRUPTED', message: 'Document changed or became unavailable between DOM and evidence collection', critical: true }); }
      if (navigation && (historyPosition(navigation).url !== dom.url || canonical(historyPosition(navigation)) !== canonical(historyPosition(await this.readHistory())))) {
        stable = false; gaps.push({ code: 'NAVIGATION_HISTORY_CHANGED', message: 'Browser history changed during evidence collection', critical: true });
      }
    } catch (error) { stable = false; gaps.push({ code: 'OBSERVATION_INTERRUPTED', message: String(error), critical: true }); }
    // Native GET destinations can replace their URL after the first DOM window.
    // Re-collect the complete evidence inside the original capture deadline;
    // never replay the input or attach a new history position to the old DOM.
    if (pendingNavigation && Date.now() < deadline && gaps.some(g => ['NAVIGATION_HISTORY_CHANGED', 'OBSERVATION_INTERRUPTED'].includes(g.code))) {
      return this.captureWithinDeadline(observationId, captureContext, deadline, dispatch, consistencyRetries + 1);
    }
    if (consistencyRetries) gaps.push({ code: 'EVIDENCE_CONSISTENCY_RETRIED', message: `Re-collected after ${consistencyRetries} navigation consistency change(s) inside the original capture deadline; the browser action was not repeated` });
    if (this.options.evidence.enabled) {
      if (!dom.detailDom) evidenceManifest.gaps.push({ code: 'DETAIL_DOM_UNAVAILABLE', message: 'Detailed DOM was not captured; historical queries cannot reconstruct it later' });
      evidenceManifest.gaps.push(...gaps, ...accessibility.gaps, ...(dom.detailDom?.gaps || []));
      const runtime = this.recorder!.snapshot(this.page);
      if (runtime.truncatedFields || Object.values(runtime.dropped).some(n => n > 0)) evidenceManifest.gaps.push({ code: 'RUNTIME_TRUNCATED', message: 'Runtime evidence exceeded entry or text limits; see dropped and truncatedFields' });
      const snapshot: DetailSnapshot = { schemaVersion: 1, observationId, documentId: dom.documentId, dom: dom.detailDom, accessibility, runtime, gaps: evidenceManifest.gaps, limits: this.options.evidence, semantics: { businessIntent: 'not_inferred', textTrust: 'page_content', execution: 'inert_evidence', consistency: 'components_have_individual_timestamps' } };
      try {
        const json = JSON.stringify(snapshot); const bytes = new TextEncoder().encode(json); const key = `${observationId}.details.json`;
        await this.evidence.put(key, { data: bytes, mediaType: 'application/json' });
        evidenceManifest.artifacts.details = { key, mediaType: 'application/json', capturedAt: dom.detailDom?.capturedAt || capturedAt, bytes: bytes.length, sha256: hash(json) };
      } catch (error) { evidenceManifest.gaps.push({ code: 'DETAIL_STORAGE_FAILED', message: String(error) }); if (error instanceof EngineError && error.code === 'EVIDENCE_BUDGET_EXHAUSTED') gaps.push({ code: error.code, message: error.message, critical: true }); }
      if (evidenceManifest.gaps.length || dom.detailDom?.nodes.some(n => n.gaps.length)) evidenceManifest.status = 'partial';
    }
    const { detailDom: _, ...observation } = dom;
    return { ...observation, ...(this.options.coveragePolicy ? {coveragePolicy:this.options.coveragePolicy}:{}), ...(ownerDependencyDispatch ? { ownerDependencyDispatch } : {}), navigation, ...(navigationPositionCapture?{navigationPositionCapture}:{}), ...(navigationCapture?{navigationCapture}:{}), ...(boundaryExitCapture?{boundaryExitCapture}:{}), evidence: evidenceManifest, instanceScope: dom.documentId, capturedAt, screenshotAt, screenshot, context, gaps, stable, viewport: dom.detailDom?.environment ? { width: dom.detailDom.environment.layoutViewport.width, height: dom.detailDom.environment.layoutViewport.height } : this.options.viewport };
  }
  private lastDismissal?: BoundaryExitDispatch & { actionId: string };
  dismissalDispatch(actionId: string): BoundaryExitDispatch | undefined {
    if (this.lastDismissal?.actionId !== actionId) return;
    const { actionId: _id, ...dispatch } = this.lastDismissal; return { ...dispatch };
  }
  async execute(action: ActionCandidate, control?: Control) {
    const prepared = this.preparedOwnerDispatch; this.preparedOwnerDispatch = undefined; this.ownerDispatch = undefined;
    this.liveEpoch++;
    const page = this.page!;
    if (action.kind === 'scroll' && action.source === 'scroll-traversal') return this.traversalScroll(action, true);
    if (action.kind === 'scroll' && action.source === 'external-probe') return this.controlledScroll(action, control, true);
    if (action.kind === 'dismiss') {
      const dispatch = this.lastDismissal = { actionId: action.id, inputPhase: 'none', closedAfterMove: false } as NonNullable<typeof this.lastDismissal>;
      const { point } = await this.validateDismissal(action);
      try { await page.mouse.move(point.x, point.y); dispatch.inputPhase = 'pointer-move'; } catch (error) { dispatch.inputPhase = 'unknown'; throw error; }
      const afterMove = await this.validateDismissal(action, true);
      if (afterMove.closedAfterMove) { dispatch.closedAfterMove = true; return; }
      try {
        await page.mouse.down(); dispatch.inputPhase = 'pointer-down';
        await page.mouse.up(); dispatch.inputPhase = 'click';
      } catch (error) { dispatch.inputPhase = 'unknown'; await page.mouse.up().catch(() => {}); throw error; }
      return;
    }
    if (action.kind === 'history') {
      const target = historyTarget(action, await this.readHistory());
      if (!target) throw new EngineError('STALE_OBSERVATION', 'Native history no longer matches the observed return path');
      await this.navigationClient!.send('Page.navigateToHistoryEntry', { entryId: target.id });
      const deadline = Date.now() + this.options.actionTimeoutMs;
      while (true) {
        const history = await this.readHistory(); const current = history.entries[history.currentIndex];
        if (current?.id === target.id && current.url === target.url) break;
        if (Date.now() >= deadline) throw new EngineError('NAVIGATION_RETURN_UNVERIFIED', 'Native history did not reach the expected entry');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await page.waitForURL(target.url, { waitUntil: 'domcontentloaded', timeout: this.options.actionTimeoutMs });
      return;
    }
    if (action.kind === 'scroll' && !control) { await page.mouse.wheel(0, Number(action.value ?? 600)); return; }
    if (action.kind === 'press' && !control) { await page.keyboard.press(String(action.value || 'Escape')); return; }
    if (!control) throw new EngineError('TARGET_MISSING', 'A current control is required');
    const target = page.locator(control.selector);
    if (await target.count() !== 1) throw new EngineError('TARGET_AMBIGUOUS', 'Target is no longer unique');
    const sameInstance = await target.evaluate((el, expected) => (window as any).__interactionEvidenceTracker?.ids.get(el) === expected, control.instanceId);
    if (!sameInstance) throw new EngineError('STALE_TARGET', 'Target was rebuilt after observation');
    const clickOptions = control.actionable.clickPoint ? { position: control.actionable.clickPoint } : {};
    // No witness for multi-stage scroll/dismiss/history or custom dispatch/read
    // implementations. Capture failure only withholds coverage evidence.
    if (action.kind !== 'scroll') this.ownerDispatch = await this.dispatchWitness(prepared, action, control);
    if (action.kind === 'scroll') {
      const delta = typeof action.value === 'object' && action.value !== null ? action.value as { x: number; y: number } : { x: 0, y: Number(action.value) };
      await target.hover(clickOptions);
      const before = await target.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
      await page.mouse.wheel(delta.x, delta.y);
      await page.waitForFunction(({ selector, instanceId, before, delta }) => {
        const el = document.querySelector(selector);
        return el && (window as any).__interactionEvidenceTracker?.ids.get(el) === instanceId
          && (delta.x !== 0 && el.scrollLeft !== before.x || delta.y !== 0 && el.scrollTop !== before.y);
      }, { selector: control.selector, instanceId: control.instanceId, before, delta }, { timeout: this.options.actionTimeoutMs });
    } else if (action.kind === 'hover') await target.hover(clickOptions);
    else if (action.kind === 'fill') await target.fill(String(action.value ?? ''));
    else if (action.kind === 'select') await target.selectOption(String(action.value));
    else if (action.kind === 'check') {
      if (control.tag === 'input') await target.setChecked(Boolean(action.value), clickOptions);
      else if (control.checked !== action.value) await target.click(clickOptions);
    } else if (action.kind === 'press') await target.press(String(action.value));
    else if (action.kind === 'click') await target.click(clickOptions);
    else if (action.kind === 'focus') await target.focus();
    else throw new EngineError('UNSUPPORTED_ACTION', `Unsupported browser action: ${action.kind}`);
  }
  async validateInput(control: Control, value: string) {
    if (!['input', 'textarea'].includes(control.tag)) return { valid: true, reason: '' };
    // A detached native element checks syntax and constraints without changing the page.
    return this.page!.evaluate(({ tag, constraints, value }) => {
      const input = document.createElement(tag) as HTMLInputElement;
      if (tag === 'input') input.type = constraints.type;
      for (const [key, constraint] of Object.entries(constraints)) if (!['type', 'valid'].includes(key) && constraint !== undefined && constraint !== false) input.setAttribute(key, String(constraint));
      input.value = value;
      const lengthValid = (!constraints.minLength || value.length >= constraints.minLength) && (constraints.maxLength === undefined || value.length <= constraints.maxLength);
      return { valid: input.value === value && input.checkValidity() && lengthValid, reason: input.validationMessage || (!lengthValid ? 'Input length violates constraints' : input.value !== value ? 'Value cannot be represented by this input type' : '') };
    }, { tag: control.tag, constraints: control.constraints, value });
  }
  async discover(o: Observation, session: Session, invoke: HookInvoker): Promise<ActionCandidate[]> {
    const actions: ActionCandidate[] = [];
    const add = (kind: ActionCandidate['kind'], value: ActionCandidate['value'], c?: Control, sampleValidity: ActionCandidate['sampleValidity'] = 'known', blocked?: string) => {
      const submitsForm = kind === 'click' && c?.actionBasis?.click?.evidence.some(e => e.rule === 'native-button/v1' && e.facts.submitsForm === true);
      const boundaryExit = kind === 'click' && !!c && o.overlays?.at(-1)?.exitControlIds.includes(c.localId);
      const interfaceAction = !submitsForm && (boundaryExit || ['fill', 'select', 'check', 'scroll', 'press'].includes(kind) || c?.expanded !== null && c?.expanded !== undefined || ['menuitem', 'option', 'tab', 'link'].includes(c?.role || '') || c?.tag === 'summary');
      const risk = submitsForm ? 'submission' : interfaceAction ? 'interface' : 'unknown';
      const basis: NonNullable<ActionCandidate['basis']> = c ? c.actionBasis?.[kind] || { status: 'tentative', evidence: [{ source: 'adapter-playwright', rule: 'missing-operation-evidence/v1', facts: { kind } }] } : { status: 'supported', evidence: [{ source: 'adapter-playwright', rule: kind === 'scroll' ? 'viewport-scroll/v1' : 'overlay-escape-probe/v1', facts: kind === 'scroll' ? { y: o.scroll.y, maxY: o.scroll.maxY } : { key: 'Escape', boundary: o.overlays?.at(-1)?.key || '', effect: 'unknown' } }] };
      const a: ActionCandidate = { id: id(), sessionId: o.sessionId, observationId: o.id, stateId: o.stateId, controlId: c?.identityId, localId: c?.localId, kind, value, label: c ? c.name || `Unnamed ${c.role || c.tag}` : kind === 'scroll' ? 'Scroll page' : 'Close overlay', preconditions: { context: o.context, visible: true, enabled: true, identityResolved: true }, basis, replayable: interfaceAction && basis.status !== 'tentative', risk: basis.status === 'tentative' ? 'unknown' : risk, source: 'dom-actions-v2', excluded: !!blocked, exclusionReason: blocked, sampleValidity };
      actions.push(constrain(a, o, session));
    };
    for (const c of o.controls.filter(c => c.visible)) {
      for (const kind of c.actions) {
        if (session.options.exploration === 'controls' && kind === 'fill' && c.readOnly) continue;
        if (kind === 'fill') {
          let values: (string | boolean)[] | undefined; let blocked: string | undefined;
          if (this.hooks.samples) { const result = await invoke('samples', async () => { const values = await this.hooks.samples!(structuredClone(c), structuredClone({ session, observation: o })); if (values !== undefined && (!Array.isArray(values) || values.some(v => typeof v !== 'string' && typeof v !== 'boolean'))) throw new EngineError('INVALID_PLUGIN_SAMPLE', 'Samples must be strings or booleans'); return values; }); values = result.value; if (result.error) blocked = 'samples_hook_failed'; }
          if (!values) {
            const constraint = c.constraints;
            let value = ({ email: 'explorer@example.test', url: 'https://example.test', date: '2026-01-01', time: '12:00', 'datetime-local': '2026-01-01T12:00', month: '2026-01', week: '2026-W01', tel: '1234567890', password: 'TestPassword1!' } as Record<string, string>)[constraint.type] || 'example';
            if (constraint.type === 'number') { const min = constraint.min === undefined ? undefined : Number(constraint.min); const max = constraint.max === undefined ? undefined : Number(constraint.max); value = String(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, min ?? 1))); }
            if (constraint.minLength) value = value.padEnd(constraint.minLength, 'x');
            if (constraint.maxLength !== undefined) value = value.slice(0, constraint.maxLength);
            if (constraint.pattern) { try { if (!new RegExp(`^(?:${constraint.pattern})$`, 'v').test(value)) blocked = 'input_sample_required'; } catch { blocked = 'constraint_not_understood'; } }
            values = [value];
          }
          for (const value of values) if (String(value) !== c.value || blocked) {
            const validation = await this.validateInput(c, String(value));
            add(kind, value, c, 'shape_only', blocked || (!validation.valid ? 'input_sample_required' : undefined));
          }
        } else if (kind === 'scroll' && c.scroll) {
          for (const [axis, position, max, size] of [['y', c.scroll.y, c.scroll.maxY, c.scroll.height], ['x', c.scroll.x, c.scroll.maxX, c.scroll.width]] as const) {
            const step = Math.max(1, Math.round(size * .75));
            // Align both directions to the same grid, including partial last
            // pages, instead of producing endlessly shifted return positions.
            const targets = [Math.min(max, (Math.floor(position / step) + 1) * step), Math.max(0, (Math.ceil(position / step) - 1) * step)];
            for (const next of targets) if (Math.abs(next - position) > 1) add(kind, { x: axis === 'x' ? next - position : 0, y: axis === 'y' ? next - position : 0 }, c);
          }
        } else if (kind === 'select') for (const option of c.options.filter(x => !x.disabled && (session.options.coveragePolicy==='finite-ui-v1'||x.value !== c.value))) add(kind, option.value, c);
        else if (kind === 'check') { if (!['radio', 'menuitemradio'].includes(c.role) || !c.checked) add(kind, !c.checked, c); }
        else add(kind, undefined, c);
      }
    }
    for (const c of o.scrollContainers ?? []) {
      // Element scrolling already has an identity-bound control action.
      if (!c.root) continue;
      if (c.boundaryKey !== o.overlays?.at(-1)?.key) continue;
      const destinations = [
        ...(c.top < c.maxTop ? [[c.left, Math.min(c.maxTop, c.top + c.height * .75)]] : []),
        ...(c.top > 0 && c.maxTop > 0 ? [[c.left, Math.max(0, c.top - c.height * .75)]] : []),
        ...(c.left < c.maxLeft ? [[Math.min(c.maxLeft, c.left + c.width * .75), c.top]] : []),
        ...(c.left > 0 && c.maxLeft > 0 ? [[Math.max(0, c.left - c.width * .75), c.top]] : []),
      ];
      for (const [left, top] of destinations) {
        const value = { documentId: o.documentId, containerNodeId: c.nodeId, left, top, expectedLeft: c.left, expectedTop: c.top,
          width: c.width, height: c.height, maxLeft: c.maxLeft, maxTop: c.maxTop };
        actions.push(constrain({ id: id(), sessionId: session.id, observationId: o.id, stateId: o.stateId, kind: 'scroll', value,
          label: `Scroll ${c.name}`, source: 'scroll-traversal', risk: 'interface', replayable: false, excluded: false, sampleValidity: 'known',
          preconditions: { context: o.context, visible: true, enabled: true, identityResolved: true },
          basis: { status: 'supported', evidence: [{ source: 'adapter-playwright', rule: 'container-scroll/v1', facts: value }] } }, o, session));
      }
    }
    if (o.overlays?.length) add('press', 'Escape');
    return actions;
  }
  async preflight(current: Observation, action?: ActionCandidate, reviewTargetLocalIds: string[] = [], reuseTargetLocalIds: string[] = [], regionReuseCandidateIds: string[] = [], surroundingTargetLocalIds: string[] = []): Promise<PreflightResult> {
    this.preparedOwnerDispatch = undefined; this.ownerDispatch = undefined;
    let live: Awaited<ReturnType<BrowserAdapter['readDOM']>>;
    try { live = await timeout(this.readDOM(false, false), this.options.observeTimeoutMs, 'Preflight deadline exceeded'); }
    catch { return 'stale'; }
    if (live.gaps.some(g => g.critical)) return 'stale';
    if (current.discoveryScan?.supplement?.status === 'active' && (live.discoveryScan?.supplement?.status !== 'active' || live.discoveryScan?.supplement.requestId !== current.discoveryScan.supplement.requestId)) return 'stale';
    let liveHistory: BrowserHistory | undefined;
    if (current.navigation) {
      try { liveHistory = await this.readHistory(live.documentId); if (canonical(historyPosition(current.navigation)) !== canonical(historyPosition(liveHistory))) return 'stale'; }
      catch { return 'stale'; }
    }
    for (const rule of this.options.contextRules) {
      const locator = this.page!.locator(rule.selector);
      let observed: string | null = null;
      if (await locator.count() === 1) observed = rule.attribute ? await locator.getAttribute(rule.attribute) : await locator.evaluate(el => 'value' in el ? String((el as HTMLInputElement).value) : el.textContent?.trim() ?? '');
      if (canonical(observed) !== canonical(current.context[rule.key]?.value)) return 'context_changed';
    }
    // Native history has no DOM target; retain exact history/document/context checks.
    const returning = !!action && action.observationId === current.id && !!historyTarget(action, current.navigation) && !!historyTarget(action, liveHistory);
    if (returning) return current.documentId === live.documentId && current.url === live.url && !current.boundaries?.length && !live.boundaries.length ? 'valid' : 'stale';
    // These invariants and declared context apply to every operation, even local ones.
    const global = (o: typeof live | Observation) => canonical({ document: o.documentId, url: o.url, scroll: o.scroll, boundaries: o.boundaries });
    if (global(live) !== global(current) || boundaryBinding(live) !== boundaryBinding(current)) return 'stale';
    if (action?.kind === 'dismiss') {
      if (!hasReviewedDismissal(action, current)) return 'stale';
      const ref = dismissalReference(action)!;
      const candidate = live.boundaryExitCandidates?.find(c => c.id === ref.facts.candidateId);
      const preserved = ref.facts.preserved as { localId: string; facts: string }[];
      return candidate && exitCandidateKey(candidate) === ref.facts.binding && Array.isArray(preserved)
        && preserved.every(p => preservedControlFacts(live.controls.find(c => c.localId === p.localId)) === p.facts) ? 'valid' : 'stale';
    }
    if (regionReuseCandidateIds.some(id=>canonical(current.regionCandidates?.find(c=>c.id===id)?.reuseBinding)
      !== canonical(live.regionCandidates?.find(c=>c.id===id)?.reuseBinding))) return 'stale';
    const reviewTargets = new Set([...reviewTargetLocalIds, ...(action?.localId ? [action.localId] : [])]);
    const reuseTargets = new Set([...reuseTargetLocalIds, ...(action?.localId && action.basis?.evidence.some(e => e.rule === 'reused-control-review/v1') ? [action.localId] : [])]);
    if ([...reuseTargets].some(id => canonical(current.controls.find(c => c.localId === id)?.reviewReuseBinding)
      !== canonical(live.controls.find(c => c.localId === id)?.reviewReuseBinding))) return 'stale';
    const surroundingReferences=action?.basis?.evidence.filter(e=>e.rule==='reviewed-control/v1'&&typeof e.facts.surroundingContextKey==='string')||[];
    const surroundingTargets=new Set([...surroundingTargetLocalIds,...(surroundingReferences.length&&action?.localId?[action.localId]:[])]);
    if(surroundingTargets.size){
      const beforeContext=controlSurroundingsReader(current),liveContext=controlSurroundingsReader(live);
      for(const localId of surroundingTargets){
        const before=current.controls.find(c=>c.localId===localId),after=live.controls.find(c=>c.localId===localId);
        const old=before&&beforeContext(before),fresh=after&&liveContext(after);
        if(!old?.complete||!fresh?.complete||old.key!==fresh.key||localId===action?.localId&&surroundingReferences.some(ref=>ref.facts.surroundingContextKey!==fresh.key))return 'stale';
      }
    }
    const navigationScope=this.options.executionBoundary?.programNavigation&&navigationScopeFor(current,[...reviewTargets]);
    if(navigationScope){
      const fresh=navigationScopeFor(live,[...reviewTargets]);
      if(!fresh||fresh.rootId!==navigationScope.rootId||action?.localId&&current.controls.find(c=>c.localId===action.localId)?.readiness
        ||navigationScopeProjection(current,navigationScope)!==navigationScopeProjection(live,fresh))return 'stale';
      // Exact current DOM/URL/history/context/boundaries and local relationships
      // are checked above. This only narrows readiness, never operation policy.
      if(action)this.prepareDispatchWitness(current,action);
      return 'valid';
    }
    const activeIds = activeInteractionIds(current);
    const escapeExit = action?.kind === 'press' && action.value === 'Escape' && !action.controlId && !action.localId && action.boundary?.intent === 'exit' && action.boundary.key === current.boundaries?.at(-1)?.key;
    const scoped = this.options.exploration === 'controls' && !!activeIds && (escapeExit || reviewTargets.size > 0 && [...reviewTargets].every(id => activeIds.has(id)));
    if ([...reviewTargets].some(id => (scoped || reviewTargetLocalIds.includes(id)) && canonical(targetFacts(current.controls.find(c => c.localId === id))) !== canonical(targetFacts(live.controls.find(c => c.localId === id))))) return 'stale';
    const relevantCurrent = scoped ? interactionScope(current) : current;
    const relevantLive = scoped ? interactionScope(live) : live;
    if (canonical(relevantLive.regionCandidates?.map(c => [c.id, c.binding])) !== canonical(relevantCurrent.regionCandidates?.map(c => [c.id, c.binding]))) return 'stale';
    if (canonical(relevantLive.structuralLists) !== canonical(relevantCurrent.structuralLists)) return 'stale';
    const reviewedControls = new Map(current.controls.map(c => [c.instanceId, c]));
    // Preserve control-review bindings within the operation's validated dependencies.
    // Passive read-only background labels remain evidence, not global prerequisites.
    const reviewBindingsChanged = (controls: Control[]) => controls.some(c => {
      const before = reviewedControls.get(c.instanceId);
      return (!c.readOnly || !before?.readOnly || reviewTargets.has(c.localId)) &&
        (canonical(c.reviewBinding) !== canonical(before?.reviewBinding) || canonical(c.reviewAttributes || {}) !== canonical(before?.reviewAttributes || {}));
    });
    // External descriptions review the whole observed component; explicit probes
    // depend on the components containing their target. Ordinary local actions
    // keep their existing dependency scope instead of inheriting a global check.
    if (!action || action.source === 'external-probe') {
      const components = (o: typeof live | Observation) => (o.components || [])
        .filter(c => !action || c.members.some(m => m.localId === action.localId))
        .map(({ id, kind, name, parentId, members }) => ({ id, kind, name, parentId, members }));
      if (canonical(components(current)) !== canonical(components(live))) return 'stale';
    }
    if (this.options.decisionScopes?.length) {
      const owners = (regions: Region[]) => regions.map(({ key, instanceId, role, label, selector, parentKey }) => ({ key, instanceId, role, label, selector, parentKey }));
      if (canonical(owners(live.regions)) !== canonical(owners(current.regions))) return 'stale';
      const bindings = new Map(current.controls.map(c => [c.instanceId, c.regionInstanceId]));
      if (live.controls.some(c => c.regionInstanceId !== bindings.get(c.instanceId))) return 'stale';
    }
    const target = action && current.controls.find(c => c.localId === action.localId);
    const scopeKey = !scoped && this.options.exploration === 'controls' && action?.risk === 'interface' && target ? nativeFormScope(target, action.kind) : undefined;
    if (scopeKey && target) {
      const next = live.controls.find(c => c.instanceId === target.instanceId);
      // A replaced target/owner has no continuous local scope. Treat it as global
      // invalidation so repeated rebuilds cannot acquire a fresh retry budget.
      if (!next || nativeFormScope(next, action!.kind) !== scopeKey) return 'stale';
      if (dependencyProjection(current, target, action!.kind) !== dependencyProjection(live, next, action!.kind)
        || reviewBindingsChanged(live.controls.filter(c => c.formOwner?.instanceId === scopeKey))) {
        return { status: 'stale', scopeKey, evidence: ['native-form-dependencies-changed', `target:${target.instanceId}`, `form:${scopeKey}`] };
      }
    } else {
      if (reviewBindingsChanged(relevantLive.controls)) return 'stale';
      const listOwners = new Map(relevantCurrent.controls.map(c => [c.instanceId, c.list]));
      if (relevantLive.controls.some(c => canonical(c.list) !== canonical(listOwners.get(c.instanceId)))) return 'stale';
      const purposeBindings = new Map(relevantCurrent.controls.map(c => [c.instanceId, c.purposeBinding]));
      if (relevantLive.controls.some(c => canonical(c.purposeBinding) !== canonical(purposeBindings.get(c.instanceId)))) return 'stale';
      const changed = this.options.exploration === 'controls' ? interactionProjection(relevantLive, target?.instanceId) !== interactionProjection(relevantCurrent, target?.instanceId)
        : observableCanonical({ ...current, ...live, context: current.context, gaps: current.gaps }) !== current.canonical || live.controls.some((c, i) => c.instanceId !== current.controls[i]?.instanceId);
      if (changed) return 'stale';
    }
    // A submission or externally reviewed operation must retain its exact target text.
    if (target && action?.risk !== 'interface' && target.displayedText !== live.controls.find(c => c.instanceId === target.instanceId)?.displayedText) return 'stale';
    if(action&&target)this.prepareDispatchWitness(current,action);
    return 'valid';
  }
  private prepareDispatchWitness(current:Observation,action:ActionCandidate) {
    if (action.observationId === current.id && current.ownerDependencies?.inventoryComplete
      && current.navigation?.browserSessionId === this.navigationSessionId && current.instanceScope && !this.hooks.context && !this.options.contextRules.length) {
      this.preparedOwnerDispatch = { action: structuredClone(action), beforeId: current.id, graphKey: hash(current.ownerDependencies),
        context: structuredClone(current.context), documentId: current.documentId, instanceScope: current.instanceScope,
        browserSessionId: this.navigationSessionId, url: current.url };
    }
  }
  private async dispatchWitness(prepared: BrowserAdapter['preparedOwnerDispatch'], action: ActionCandidate, control: Control): Promise<Observation['ownerDependencyDispatch']> {
    try {
      if (!prepared || this.execute !== defaultExecute || this.readDOM !== defaultReadDOM
        || this.hooks.context || this.options.contextRules.length || action.risk !== 'interface' || action.basis?.status !== 'supported'
        || action.observationId !== prepared.beforeId || action.sessionId !== prepared.action.sessionId
        || prepared.browserSessionId !== this.navigationSessionId) return;
      // Core can supply an input value and lift only the corresponding missing-
      // input exclusion. All other action facts must still be the prepared ones.
      const comparable = { ...action, value: prepared.action.value,
        ...(prepared.action.exclusionReason === 'input_sample_required' ? { excluded: prepared.action.excluded, exclusionReason: prepared.action.exclusionReason } : {}) };
      if (canonical(comparable) !== canonical(prepared.action)) return;
      // DOM rules/custom hooks are sampled separately from the owner graph. A
      // second asynchronous read cannot prove they belonged to its final sample.
      const context: Context = Object.fromEntries(Object.entries(this.options.context).map(([key, value]) => [key, { value, status: 'known', source: 'declared' }]));
      if (canonical(context) !== canonical(prepared.context) || canonical(action.preconditions.context) !== canonical(prepared.context)) return;
      const live = await timeout(this.readDOM(false, true), this.options.observeTimeoutMs, 'Dispatch evidence deadline exceeded');
      if (this.execute !== defaultExecute || this.readDOM !== defaultReadDOM
        || prepared.browserSessionId !== this.navigationSessionId || live.documentId !== prepared.documentId || live.url !== prepared.url
        || live.gaps.some(g => g.critical) || !live.ownerDependencies?.inventoryComplete || hash(live.ownerDependencies) !== prepared.graphKey
        || live.controls.filter(c => c.localId === action.localId && c.instanceId === control.instanceId).length !== 1
        || live.controls.filter(c => c.instanceId === control.instanceId).length !== 1) return;
      return { version: 'browser-owner-dispatch-v1', sessionId: action.sessionId, beforeId: prepared.beforeId, actionId: action.id,
        actionKey: hash(action), graphKey: prepared.graphKey, contextKey: hash(context), documentId: live.documentId,
        instanceScope: prepared.instanceScope, browserSessionId: prepared.browserSessionId, url: live.url, capturedAt: now() };
    } catch { return; }
  }
  async validateDismissal(action: ActionCandidate, acceptClosedAfterMove = false) {
    const ref = dismissalReference(action);
    const live = await timeout(this.readDOM(false, false), this.options.observeTimeoutMs, 'Dismissal validation deadline exceeded');
    const preserved = ref?.facts.preserved as { localId: string; facts: string }[] | undefined;
    if (!ref || live.documentId !== ref.facts.documentId || live.url !== ref.facts.url || live.gaps.some(g => g.critical)
      || !Array.isArray(preserved) || !preserved.every(p => preservedControlFacts(live.controls.find(c => c.localId === p.localId)) === p.facts)) throw new EngineError('STALE_DISMISSAL_TARGET', 'Outside point or boundary changed');
    for (const rule of this.options.contextRules) {
      const locator = this.page!.locator(rule.selector);
      const value = await locator.count() === 1 ? rule.attribute ? await locator.getAttribute(rule.attribute) : await locator.evaluate(el => 'value' in el ? String((el as HTMLInputElement).value) : el.textContent?.trim() ?? '') : null;
      if (canonical(value) !== canonical(action.preconditions.context[rule.key]?.value)) throw new EngineError('PRECONDITIONS_CHANGED', 'Declared context changed before outside click');
    }
    // Pointer departure can already dismiss a hover-sensitive panel. Verify the
    // expected parent and preserved facts before omitting the now-unneeded click.
    const parents = live.overlays.map(o => ({ key: o.key, kind: o.kind, parentKey: o.parentKey, parentRegion: o.parentRegion, instanceId: live.regions.find(r => r.key === o.key)?.instanceId }));
    if (acceptClosedAfterMove && !live.boundaries.some(b => b.key === ref.facts.boundaryKey)
      && canonical(parents) === canonical(ref.facts.parentOwners)) return { point: ref.facts.point as { x: number; y: number }, closedAfterMove: true };
    const c = live.boundaryExitCandidates?.find(c => c.id === ref.facts.candidateId);
    if (!c || exitCandidateKey(c) !== ref.facts.binding || action.value !== c.id || live.boundaries.at(-1)?.key !== c.boundaryKey) throw new EngineError('STALE_DISMISSAL_TARGET', 'Outside point or boundary changed');
    return { point: c.point, closedAfterMove: false };
  }
  async validate(action: ActionCandidate, control?: Control) {
    if (action.kind === 'scroll' && action.source === 'scroll-traversal') return this.traversalScroll(action, false);
    if (action.kind === 'scroll' && action.source === 'external-probe') return this.controlledScroll(action, control, false);
    if (action.kind === 'dismiss') await this.validateDismissal(action);
    if (action.kind === 'focus' && (!control || !await this.page!.locator(control.selector).evaluate(el => el.matches('input:not([type=hidden]),textarea,select,button,a[href],[tabindex]') || (el as HTMLElement).isContentEditable))) throw new EngineError('INVALID_INPUT', 'Focus requires a focusable control');
    if (action.kind === 'history' && !historyTarget(action, await this.readHistory())) throw new EngineError('INVALID_INPUT', 'History return requires a previously observed GET entry');
    if (action.kind === 'scroll' && control) {
      const delta = typeof action.value === 'object' && action.value !== null ? action.value as { x: number; y: number } : { x: 0, y: action.value };
      if (!control.scroll || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) throw new EngineError('INVALID_INPUT', 'Element scroll requires a scroll viewport and finite deltas');
    }
    if (action.kind === 'fill' && typeof action.value !== 'string' && typeof action.value !== 'number') throw new EngineError('INVALID_INPUT', 'Fill requires text or a number');
    if (action.kind === 'check' && typeof action.value !== 'boolean') throw new EngineError('INVALID_INPUT', 'Check requires a boolean');
    if (action.kind === 'select' && !control?.options.some(o => o.value === action.value && !o.disabled)) throw new EngineError('INVALID_INPUT', 'Select value is not an enabled option');
    if (action.kind === 'fill' && control) { const validation = await this.validateInput(control, String(action.value)); if (!validation.valid) throw new EngineError('INVALID_INPUT', validation.reason); }
  }
  private async traversalScroll(action: ActionCandidate, perform: boolean) {
    const options = traversalScrollSchema.parse(action.value);
    const live = await this.readDOM(false, false); const active = live.overlays.at(-1);
    const container = live.scrollContainers?.find(c => c.nodeId === options.containerNodeId);
    if (!container || live.documentId !== options.documentId) throw new EngineError('STALE_TARGET', 'Scroll container is no longer available');
    if (container.boundaryKey !== active?.key || action.boundary?.key !== active?.key) throw new EngineError('ACTION_BLOCKED', 'Scroll container is outside the active boundary');
    const target = this.page!.locator(container.selector);
    if (await target.count() !== 1) throw new EngineError('TARGET_AMBIGUOUS', 'Scroll container is not unique');
    await target.evaluate(traversalScrollInPage, { options, boundarySelector: active?.selector, perform });
  }
  private async controlledScroll(action: ActionCandidate, control: Control | undefined, perform: boolean) {
    if (!control) throw new EngineError('TARGET_MISSING', 'A current control is required for a scroll probe');
    const options = scrollProbeSchema.parse(action.value);
    const target = this.page!.locator(control.selector);
    if (await target.count() !== 1) throw new EngineError('TARGET_AMBIGUOUS', 'Scroll probe target is not unique');
    // Resolve the active scope from a fresh read; no caller-supplied selector can relax it.
    const live = await this.readDOM(false, false);
    const active = live.overlays.at(-1);
    if (active?.key !== action.boundary?.key) throw new EngineError('ACTION_BLOCKED', 'Scroll probe scope changed before execution');
    if (active && !active.controlIds.includes(control.localId)) throw new EngineError('ACTION_BLOCKED', 'outside_active_boundary');
    await target.evaluate(scrollProbeInPage, { options, instanceId: control.instanceId, boundarySelector: active?.selector, perform });
  }
  async reopen() {
    this.preparedOwnerDispatch = undefined; this.ownerDispatch = undefined;
    const storageState = await this.context!.storageState(); await this.close();
    this.options = { ...this.options, storageState }; await this.start();
  }
  async close() { this.preparedOwnerDispatch = undefined; this.ownerDispatch = undefined; await this.context?.close().catch(() => {}); await this.browser?.close().catch(() => {}); this.page = undefined; }
}

// Capture implementation authority once. Later prototype replacement or an
// instance decorator cannot acquire this driver's dispatch evidence contract.
const defaultExecute = BrowserAdapter.prototype.execute;
const defaultReadDOM = BrowserAdapter.prototype.readDOM;
