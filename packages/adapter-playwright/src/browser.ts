import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';
import { createHash } from 'node:crypto';
import type { EvidenceStore, InteractionDriver, HookInvoker } from '@interaction/core';
import { canonical, timeout, hash } from '@interaction/core';
import { observableCanonical } from './model.js';
import { interactionProjection } from './exploration.js';
import type { Session, EngineHooks } from './types.js';
import { constrain } from './policy.js';
import { id } from './util.js';
import type { ActionCandidate, Context, Control, Gap, Observation, Region, SessionOptions } from './types.js';
import { EngineError } from './types.js';
import { now } from './util.js';
import { collectRegionCandidates } from './region-candidates.js';
import { collectOverlays } from './overlays.js';
import { collectActionEvidence } from './action-evidence.js';
import { collectEvidence } from './collect-evidence.js';
import { evidenceOptionsSchema } from './schema.js';
import { RuntimeRecorder } from './runtime-evidence.js';
import { historyPosition, historyTarget } from './navigation.js';
import type { BrowserHistory } from './types.js';
import type { BrowserEvidenceManifest, DetailSnapshot, DomEvidence, EvidenceOptions } from './evidence-types.js';

// Runs in the page without framework knowledge or DOM mutation.
function collectDOM(overlayCollector: typeof collectOverlays, actionCollector: typeof collectActionEvidence, candidateCollector: typeof collectRegionCandidates | undefined, detailCollector?: typeof collectEvidence, detailOptions?: EvidenceOptions) {
  const w = window as any;
  const tracker = w.__interactionEvidenceTracker ??= { documentId: crypto.randomUUID(), ids: new WeakMap(), counter: 0 };
  const instance = (el: Element) => { if (!tracker.ids.has(el)) tracker.ids.set(el, `${tracker.documentId}:${++tracker.counter}`); return tracker.ids.get(el) as string; };
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
  const itemKey = (item: Element) => {
    if (itemKeyCache.has(item)) return itemKeyCache.get(item);
    // Explicit record keys survive reorder/rebuild and change when a virtual row
    // is recycled. Do not use sibling indexes, geometry or input values as keys.
    const declared = ['data-row-key', 'data-item-key', 'data-key'].map(key => [key, item.getAttribute(key)]).find(([, value]) => value);
    let key = declared ? JSON.stringify(declared) : undefined;
    if (!key) {
      const copy = item.cloneNode(true) as Element;
      // A record can contain a nested list or an independently positioned
      // expanded panel. Its changing contents are not the parent record's name.
      // Keep ordinary positioned descriptions: position alone is not ownership.
      const descendants = [...item.querySelectorAll('*')]; const copies = [...copy.querySelectorAll('*')];
      const openers = [...item.querySelectorAll('[aria-expanded]')].filter(el => el.closest(itemSelector) === item);
      const itemRect = item.getBoundingClientRect();
      descendants.forEach((el, index) => {
        const nestedScope = el.matches(`${listSelector},dialog,[role=dialog],[role=alertdialog],[role=menu],[role=tabpanel],[popover]`);
        const panelRect = el.getBoundingClientRect();
        const outsideItem = panelRect.width > 0 && panelRect.height > 0 && (panelRect.left < itemRect.left || panelRect.right > itemRect.right || panelRect.top < itemRect.top || panelRect.bottom > itemRect.bottom);
        const expandedPanel = ['absolute', 'fixed'].includes(getComputedStyle(el).position)
          && outsideItem && el.children.length > 0 && openers.some(opener => opener !== el && !el.contains(opener));
        if (nestedScope || expandedPanel) copies[index].remove();
      });
      copy.querySelectorAll('button,input,select,textarea,[role=button],[role=checkbox],[role=switch],[role=combobox],script,style,[hidden],[aria-hidden=true]').forEach(child => child.remove());
      const labelledBy = item.getAttribute('aria-labelledby');
      const fullLabel = labelledBy ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') : item.getAttribute('aria-label');
      const text = (fullLabel || copy.textContent || '').replace(/\s+/g, ' ').trim();
      // Long/truncated descriptions are not a unique business record key.
      if (text && text.length <= 500) key = JSON.stringify(['item-text', text]);
    }
    // A row's DOM id/testid may identify a reusable viewport slot, not its item.
    // Without a declared record key or descriptive text, leave it unresolved.
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
    const localKey = el.getAttribute('data-testid') || el.getAttribute('name') || (name ? JSON.stringify([role(el), name, type]) : own);
    // Duplicate controls within one item still share this key and stay ambiguous.
    return localKey ? `item:${JSON.stringify([bindings, localKey])}` : undefined;
  };
  const regions: Region[] = [...document.querySelectorAll(regionSelector)].map(el => ({ key: regionKey(el), instanceId: instance(el), label: label(el) || el.getAttribute('name') || role(el), role: role(el), selector: selector(el), parentKey: regionKey(el.parentElement?.closest(regionSelector) ?? null), rect: rect(el), text: ((el as HTMLElement).innerText || el.textContent || '').slice(0, 8000) }));
  regions.unshift({ key: 'document', instanceId: document.documentElement ? instance(body || document.documentElement) : undefined, label: document.title, role: 'document', selector: 'body', parentKey: '', rect: rect(body), text: bodyText.slice(0, 8000) });
  const query = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=dialog],[role=alertdialog],dialog,[popover],[aria-expanded],[onclick],[tabindex],[contenteditable]:not([contenteditable=false])';
  const selected = new Set(document.querySelectorAll(query));
  // Document roots host event delegation and focus management. Preserve those
  // signals separately instead of making the entire document an action target.
  const documentRoots = [document.documentElement, body].filter((el): el is HTMLElement => !!el);
  const documentHints = documentRoots.flatMap(el => actionCollector(el).interactionHints.map(hint => ({ ...hint, facts: { ...hint.facts, tag: el.tagName.toLowerCase(), scope: 'document' } })));
  for (const root of documentRoots) selected.delete(root);
  const elements = [...document.querySelectorAll('*')];
  const scrollViewport = (el: Element) => {
    if (el === body || el === document.documentElement || el.matches('input,textarea,select,[contenteditable]:not([contenteditable=false])')) return;
    const style = getComputedStyle(el);
    const maxX = /^(auto|scroll)$/.test(style.overflowX) ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;
    const maxY = /^(auto|scroll)$/.test(style.overflowY) ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
    if ((maxX > 1 || maxY > 1) && el.clientWidth && el.clientHeight) return { x: el.scrollLeft, y: el.scrollTop, maxX, maxY, width: el.clientWidth, height: el.clientHeight };
  };
  // A bounded supplemental scan finds scroll viewports, handlers and cursor hints.
  // Inherited pointer cursors do not turn every descendant into another target.
  for (const el of elements.slice(0, 5000)) if (el !== body && el !== document.documentElement && !selected.has(el) && (scrollViewport(el) || typeof (el as HTMLElement).onclick === 'function' || getComputedStyle(el).cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer'))) selected.add(el);
  const all = [...selected];
  const unnamedScrolls = new Set<Element>();
  const controls = all.slice(0, 1500).map(el => {
    const e = el as HTMLInputElement;
    const r = rect(el); const style = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[hidden],[inert]');
    const enabled = !e.disabled && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[inert]');
    const semanticRole = role(el);
    const type = el.tagName === 'INPUT' ? e.type : el.tagName.toLowerCase();
    const capabilities = actionCollector(el);
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
    const nestedLists = scroll ? el.querySelectorAll('[role=listbox]') : [];
    const list = el.tagName === 'SELECT' ? el : el.closest('[role=listbox]') || (nestedLists.length === 1 ? nestedLists[0] : undefined);
    const boundForm = (el as HTMLInputElement).form;
    const purposeBinding = list ? { attributes: Object.fromEntries(['type', 'role', 'href', 'target', 'form', 'formaction', 'formmethod', 'formtarget', 'aria-controls', 'aria-haspopup'].filter(k => el.hasAttribute(k)).map(k => [k, el.getAttribute(k)!])),
      ...(boundForm ? { form: { instanceId: instance(boundForm), action: boundForm.action, method: boundForm.method, target: boundForm.target } } : {}) } : undefined;
    return {
      localId: instance(el), instanceId: instance(el), tag: el.tagName.toLowerCase(), role: semanticRole, name, label: label(el), stableKey,
      ...(list ? { list: { instanceId: instance(list), role: list.tagName === 'SELECT' ? 'select' : 'listbox', label: label(list), selector: selector(list) } } : {}),
      ...(purposeBinding ? { purposeBinding } : {}),
      region: regionKey(el.closest(regionSelector)), regionInstanceId: instance(el.closest(regionSelector) || body || document.documentElement), form: regionKey(el.closest('form')), selector: selector(el), rect: r,
      value: typeof e.value === 'string' ? e.value : (el as HTMLElement).isContentEditable ? clean(el.textContent) : '', displayedText: clean(el.textContent),
      checked: ['checkbox', 'radio'].includes(type) ? e.checked : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : null,
      selected: el.tagName === 'SELECT' ? [...(el as HTMLSelectElement).selectedOptions].map(o => o.value) : el.getAttribute('aria-selected') === 'true' ? [name] : [],
      visible: !!visible, enabled: !!enabled, editable: !!editable, readOnly: !!e.readOnly || el.getAttribute('aria-readonly') === 'true', expanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : null, controls: el.getAttribute('aria-controls'),
      constraints: { type, required: !!e.required, min: e.min || undefined, max: e.max || undefined, step: e.step || undefined, pattern: e.pattern || undefined, minLength: e.minLength >= 0 ? e.minLength : undefined, maxLength: e.maxLength >= 0 ? e.maxLength : undefined, valid: e.validity?.valid ?? true },
      options, ...capabilities, ...(scroll ? { scroll } : {}), discovery: [...query.split(',').filter(q => el.matches(q)).map(q => `selector:${q}`), ...(typeof (el as HTMLElement).onclick === 'function' ? ['property:onclick'] : []), ...(style.cursor === 'pointer' ? ['style:cursor=pointer'] : []), ...(scroll ? ['cssom:scroll-viewport'] : [])],
      actionable: { visible: !!visible, enabled: !!enabled, editable: !!editable, hitTarget: isInView ? !!hit && (hit === el || el.contains(hit)) : null, unknown: ['event-handler-completeness', 'business-preconditions', ...(!isInView ? ['off-viewport-hit-target'] : [])] },
    };
  });
  const gaps: { code: string; message: string; selector?: string; critical?: boolean }[] = [];
  if (!body) gaps.push({ code: 'DOM_ROOT_UNAVAILABLE', message: 'Document body is absent; the page may be navigating or rebuilding', critical: true });
  if (document.readyState === 'loading') gaps.push({ code: 'DOCUMENT_LOADING', message: 'Document parsing is still in progress', critical: true });
  for (const el of document.querySelectorAll('iframe,canvas,input[type=file]')) gaps.push({ code: `UNSUPPORTED_${el.tagName === 'INPUT' ? 'FILE_INPUT' : el.tagName}`, message: `${el.tagName} internals are outside V0.1 coverage`, selector: selector(el) });
  for (const el of elements) if (el.shadowRoot) gaps.push({ code: 'UNSUPPORTED_SHADOW_DOM', message: 'Shadow root contents were not collected', selector: selector(el) });
  for (const c of controls) if (c.tag === 'input' && ['color', 'range'].includes(c.constraints.type)) gaps.push({ code: 'UNSUPPORTED_INPUT_TYPE', message: `No V0.1 operation for input type ${c.constraints.type}`, selector: c.selector });
  if (elements.length > 5000) gaps.push({ code: 'SIGNAL_SCAN_TRUNCATED', message: 'Supplemental scroll-viewport, property-handler and cursor scan limited to 5000 elements; semantic selectors are collected separately' });
  gaps.push({ code: 'EVENT_LISTENER_COVERAGE', message: 'Delegated and addEventListener handlers are not enumerated. Handler purpose and business effects are unknown; focus and appearance alone do not establish an operation.' });
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
  });
  // Detected overlays may introduce regions outside the native semantic selectors.
  for (const region of regions) if (!region.instanceId) {
    const owners = document.querySelectorAll(region.selector);
    if (owners.length === 1) region.instanceId = instance(owners[0]);
  }
  return { documentId: tracker.documentId as string, url: location.href, title: document.title, text: bodyText.slice(0, 50000), controls, regions, ...layers, regionCandidates: candidateCollector?.(controls, all.slice(0, 1500), instance, selector), actionDiscovery: { version: 'dom-actions-v2' as const, documentHints }, detailDom: detailCollector && detailOptions ? detailCollector(detailOptions, regions) : undefined, scroll: { x: scrollX, y: scrollY, maxY: Math.max(0, (document.documentElement?.scrollHeight ?? 0) - innerHeight) }, gaps };
}

export class BrowserAdapter implements InteractionDriver<Observation, SessionOptions> {
  browser?: Browser; context?: BrowserContext; page?: Page;
  private gaps: Gap[] = [];
  private recorder?: RuntimeRecorder;
  private navigationClient?: CDPSession;
  private navigationSessionId = '';
  private documentMethods = new Map<string, string>();
  private entryMethods = new Map<number, string>();
  private lastDocumentResponse?: { url: string; method: string };
  constructor(public options: SessionOptions, private evidence: EvidenceStore, private hooks: EngineHooks = {}) { this.options = { ...options, evidence: evidenceOptionsSchema.parse(options.evidence) }; }
  connected() { return !!this.page && !this.page.isClosed(); }
  async start() {
    this.browser = await chromium.launch({ headless: this.options.headless });
    this.context = await this.browser.newContext({ viewport: this.options.viewport, storageState: this.options.storageState as any, acceptDownloads: false });
    this.page = await this.context.newPage();
    this.navigationSessionId = id(); this.documentMethods.clear(); this.entryMethods.clear(); this.lastDocumentResponse = undefined;
    this.navigationClient = await this.context.newCDPSession(this.page);
    this.page.on('response', response => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === this.page?.mainFrame()) this.lastDocumentResponse = { url: response.url(), method: request.method() };
    });
    this.recorder = new RuntimeRecorder(this.options.evidence.maxRuntimeEntries, this.options.evidence.maxTextLength);
    if (this.options.evidence.enabled) this.recorder.attach(this.page);
    this.page.setDefaultTimeout(this.options.actionTimeoutMs);
    this.context.on('page', async p => { if (p !== this.page) { this.gaps.push({ code: 'UNSUPPORTED_NEW_TAB', message: `New tab blocked: ${p.url()}`, critical: true }); await p.close().catch(() => {}); } });
    this.page.on('dialog', async dialog => { this.gaps.push({ code: 'UNSUPPORTED_NATIVE_DIALOG', message: `${dialog.type()}: ${dialog.message()}; dismissed`, critical: true }); await dialog.dismiss().catch(() => {}); });
    this.page.on('download', d => { this.gaps.push({ code: 'UNSUPPORTED_DOWNLOAD', message: d.suggestedFilename(), critical: true }); void d.cancel().catch(() => {}); });
    await this.page.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === this.page?.mainFrame() && new URL(request.url()).origin !== new URL(this.options.url).origin) {
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
  async readDOM(detailed = false) {
    if (!this.page || this.page.isClosed()) throw new EngineError('BROWSER_UNAVAILABLE', 'Browser is not connected');
    // tsx preserves nested function names using a module-local helper. Supply it
    // inside the serialized closure so development and compiled execution agree.
    const args = detailed ? `, ${collectEvidence.toString()}, ${JSON.stringify(this.options.evidence)}` : '';
    const source = `(() => { const __name = (fn) => fn; return (${collectDOM.toString()})(${collectOverlays.toString()}, ${collectActionEvidence.toString()}, ${this.options.regionExploration === 'review' ? collectRegionCandidates.toString() : 'undefined'}${args}); })()`;
    return this.page.evaluate(source) as Promise<{ documentId: string; url: string; title: string; text: string; controls: Control[]; regions: Region[]; overlays: NonNullable<Observation['overlays']>; boundaries: NonNullable<Observation['boundaries']>; regionCandidates?: Observation['regionCandidates']; actionDiscovery?: Observation['actionDiscovery']; scroll: Observation['scroll']; gaps: Gap[]; detailDom?: DomEvidence }>;
  }
  async capture(observationId: string) {
    if (!this.page) throw new EngineError('BROWSER_UNAVAILABLE', 'Browser is not connected');
    const deadline = Date.now() + this.options.observeTimeoutMs;
    let stable = false; let interactionStable = false; let captureRetries = 0;
    let dom: Awaited<ReturnType<BrowserAdapter['readDOM']>> | undefined;
    let lastError: string | undefined;
    const evidenceManifest: BrowserEvidenceManifest = { schemaVersion: 1, status: this.options.evidence.enabled ? 'captured' : 'disabled', artifacts: {}, gaps: [] };
    for (;;) {
      let previous = ''; let unchangedSince = Date.now();
      let previousInteraction = ''; let interactionSince = Date.now();
      stable = false; interactionStable = false;
      do {
        try {
          dom = await timeout(this.readDOM(), Math.max(1, deadline - Date.now()), 'DOM capture deadline exceeded');
          lastError = undefined;
          const incomplete = dom.gaps.some(g => ['DOM_ROOT_UNAVAILABLE', 'DOCUMENT_LOADING'].includes(g.code));
          const key = JSON.stringify({ documentId: dom.documentId, url: dom.url, overlays: dom.overlays.map(o => o.key), controls: dom.controls.map(c => [c.instanceId, c.name, c.value, c.displayedText, c.checked, c.visible, c.enabled, c.editable, c.expanded, c.constraints, c.rect, c.actionable.hitTarget, c.actionBasis]) });
          if (key !== previous || incomplete) { previous = key; unchangedSince = Date.now(); }
          const interactive = interactionProjection(dom) + canonical(dom.regionCandidates?.map(c => [c.id, c.binding]));
          if (interactive !== previousInteraction || incomplete) { previousInteraction = interactive; interactionSince = Date.now(); }
          interactionStable = !incomplete && Date.now() - interactionSince >= this.options.settleMs;
          if (!incomplete && Date.now() - unchangedSince >= this.options.settleMs) { stable = true; break; }
          if (this.options.exploration === 'controls' && interactionStable) break;
        } catch (error) {
          lastError = String(error); previous = ''; unchangedSince = Date.now(); previousInteraction = ''; interactionSince = Date.now(); interactionStable = false;
          if (this.page.isClosed()) break;
        }
        if (Date.now() >= deadline) break;
        await new Promise(r => setTimeout(r, Math.min(50, Math.max(0, deadline - Date.now()))));
      } while (Date.now() < deadline);
      if (this.options.evidence.enabled && dom && !lastError) {
        try {
          const detailed = await timeout(this.readDOM(true), this.options.observeTimeoutMs, 'Detailed DOM capture deadline exceeded');
          if (observableCanonical({ ...dom, context: {} }) !== observableCanonical({ ...detailed, context: {} }) || dom.documentId !== detailed.documentId || canonical(dom.regionCandidates?.map(c => [c.id, c.binding])) !== canonical(detailed.regionCandidates?.map(c => [c.id, c.binding]))) {
            interactionStable &&= interactionProjection(dom) === interactionProjection(detailed) && canonical(dom.regionCandidates?.map(c => [c.id, c.binding])) === canonical(detailed.regionCandidates?.map(c => [c.id, c.binding]));
            stable = false;
            const critical = !(this.options.exploration === 'controls' && interactionStable);
            dom = detailed;
            // A transition can arrive after the quiet sampling window. Re-sample
            // within the original deadline; never retry the browser action.
            if (critical && Date.now() < deadline) { captureRetries++; continue; }
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
    const capturedAt = now(); const gaps = [...dom.gaps, ...this.gaps.splice(0)];
    let navigation: BrowserHistory | undefined;
    try { navigation = await this.readHistory(dom.documentId); }
    catch (error) { gaps.push({ code: 'NAVIGATION_HISTORY_UNAVAILABLE', message: String(error) }); }
    if (captureRetries) gaps.push({ code: 'EVIDENCE_CAPTURE_RETRIED', message: `Re-sampled after ${captureRetries} change(s) during detailed capture; the browser action was not repeated` });
    if (lastError) gaps.push({ code: 'DOM_CAPTURE_FAILED', message: lastError, critical: true });
    if (!stable) gaps.push({ code: 'UNSTABLE', message: 'Page did not settle within the observation budget', critical: !(this.options.exploration === 'controls' && interactionStable) });
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
      const data = await this.page!.screenshot({ timeout: this.options.actionTimeoutMs, fullPage }); const at = now();
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
    return { ...observation, navigation, evidence: evidenceManifest, instanceScope: dom.documentId, capturedAt, screenshotAt, screenshot, context, gaps, stable, viewport: dom.detailDom?.environment ? { width: dom.detailDom.environment.layoutViewport.width, height: dom.detailDom.environment.layoutViewport.height } : this.options.viewport };
  }
  async execute(action: ActionCandidate, control?: Control) {
    const page = this.page!;
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
        } else if (kind === 'select') for (const option of c.options.filter(x => !x.disabled && x.value !== c.value)) add(kind, option.value, c);
        else if (kind === 'check') { if (!['radio', 'menuitemradio'].includes(c.role) || !c.checked) add(kind, !c.checked, c); }
        else add(kind, undefined, c);
      }
    }
    if (o.scroll.y < o.scroll.maxY) add('scroll', Math.round(o.viewport.height * 0.75));
    if (o.scroll.y > 0) add('scroll', -Math.round(o.viewport.height * 0.75));
    if (o.overlays?.length) add('press', 'Escape');
    return actions;
  }
  async preflight(current: Observation): Promise<'valid' | 'stale' | 'context_changed'> {
    let live: Awaited<ReturnType<BrowserAdapter['readDOM']>>;
    try { live = await timeout(this.readDOM(), this.options.observeTimeoutMs, 'Preflight deadline exceeded'); }
    catch { return 'stale'; }
    if (live.gaps.some(g => g.critical)) return 'stale';
    if (current.navigation) {
      try { if (canonical(historyPosition(current.navigation)) !== canonical(historyPosition(await this.readHistory(live.documentId)))) return 'stale'; }
      catch { return 'stale'; }
    }
    if (canonical(live.regionCandidates?.map(c => [c.id, c.binding])) !== canonical(current.regionCandidates?.map(c => [c.id, c.binding]))) return 'stale';
    const liveCanonical = observableCanonical({ ...current, ...live, context: current.context, gaps: current.gaps });
    const listOwners = new Map(current.controls.map(c => [c.instanceId, c.list]));
    if (live.controls.some(c => canonical(c.list) !== canonical(listOwners.get(c.instanceId)))) return 'stale';
    const purposeBindings = new Map(current.controls.map(c => [c.instanceId, c.purposeBinding]));
    if (live.controls.some(c => canonical(c.purposeBinding) !== canonical(purposeBindings.get(c.instanceId)))) return 'stale';
    if (this.options.decisionScopes?.length) {
      const owners = (regions: Region[]) => regions.map(({ key, instanceId, role, label, selector, parentKey }) => ({ key, instanceId, role, label, selector, parentKey }));
      if (canonical(owners(live.regions)) !== canonical(owners(current.regions))) return 'stale';
      const bindings = new Map(current.controls.map(c => [c.instanceId, c.regionInstanceId]));
      if (live.controls.some(c => c.regionInstanceId !== bindings.get(c.instanceId))) return 'stale';
    }
    const changed = this.options.exploration === 'controls' ? interactionProjection(live) !== interactionProjection(current)
      : liveCanonical !== current.canonical || live.controls.some((c, i) => c.instanceId !== current.controls[i]?.instanceId);
    if (changed) {
      return 'stale';
    }
    // Context rules must be re-read even when their DOM node is not an interactive control.
    for (const rule of this.options.contextRules) {
      const locator = this.page!.locator(rule.selector);
      let observed: string | null = null;
      if (await locator.count() === 1) observed = rule.attribute ? await locator.getAttribute(rule.attribute) : await locator.evaluate(el => 'value' in el ? String((el as HTMLInputElement).value) : el.textContent?.trim() ?? '');
      if (canonical(observed) !== canonical(current.context[rule.key]?.value)) return 'context_changed';
    }
    return 'valid';
  }
  async validate(action: ActionCandidate, control?: Control) {
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
  async reopen() {
    const storageState = await this.context!.storageState(); await this.close();
    this.options = { ...this.options, storageState }; await this.start();
  }
  async close() { await this.context?.close().catch(() => {}); await this.browser?.close().catch(() => {}); this.page = undefined; }
}
