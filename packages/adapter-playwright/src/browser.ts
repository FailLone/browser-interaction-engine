import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { EvidenceStore, InteractionDriver, HookInvoker } from '@interaction/core';
import { canonical, timeout } from '@interaction/core';
import { observableCanonical } from './model.js';
import type { Session, EngineHooks } from './types.js';
import { constrain } from './policy.js';
import { id } from './util.js';
import type { ActionCandidate, Context, Control, Gap, Observation, Region, SessionOptions } from './types.js';
import { EngineError } from './types.js';
import { now } from './util.js';
import { collectOverlays } from './overlays.js';

// Runs in the page without framework knowledge or DOM mutation.
function collectDOM(overlayCollector: typeof collectOverlays) {
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
  const role = (el: Element): string => el.getAttribute('role') || ({ BUTTON: 'button', A: 'link', SELECT: 'combobox', TEXTAREA: 'textbox', FORM: 'form', MAIN: 'main', NAV: 'navigation', DIALOG: 'dialog', SUMMARY: 'button' }[el.tagName] || (el.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', number: 'spinbutton' }[(el as HTMLInputElement).type] || 'textbox') : 'generic'));
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
  const regionSelector = 'form,main,nav,section[aria-label],section[aria-labelledby],[role=dialog],[role=menu],[role=listbox],[role=tabpanel],dialog';
  const regionKey = (el: Element | null) => {
    if (!el) return 'document';
    return `${role(el)}:${el.getAttribute('data-testid') || el.id || label(el) || el.getAttribute('name') || selector(el)}`;
  };
  const regions = [...document.querySelectorAll(regionSelector)].map(el => ({ key: regionKey(el), label: label(el) || el.getAttribute('name') || role(el), role: role(el), selector: selector(el), parentKey: regionKey(el.parentElement?.closest(regionSelector) ?? null), rect: rect(el), text: ((el as HTMLElement).innerText || el.textContent || '').slice(0, 8000) }));
  regions.unshift({ key: 'document', label: document.title, role: 'document', selector: 'body', parentKey: '', rect: rect(body), text: bodyText.slice(0, 8000) });
  const query = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=option],[role=tab],[role=checkbox],[role=radio],[role=combobox],[aria-expanded],[onclick],[tabindex], [contenteditable=true]';
  const all = [...document.querySelectorAll(query)];
  const controls = all.slice(0, 1500).map(el => {
    const e = el as HTMLInputElement;
    const r = rect(el); const style = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[hidden],[inert]');
    const enabled = !e.disabled && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[inert]');
    const semanticRole = role(el); const name = label(el) || clean(el.textContent) || clean(el.getAttribute('title')) || clean(el.getAttribute('placeholder')) || (['submit', 'button'].includes(e.type) ? e.value : '');
    const type = el.tagName === 'INPUT' ? e.type : el.tagName.toLowerCase();
    const editable = enabled && !e.readOnly && (['INPUT', 'TEXTAREA'].includes(el.tagName) || el.getAttribute('contenteditable') === 'true');
    const actions: string[] = [];
    if (el.tagName === 'SELECT') actions.push('select');
    else if (['checkbox', 'radio'].includes(type) || ['checkbox', 'radio'].includes(semanticRole)) actions.push('check');
    else if (editable && !['file', 'submit', 'button', 'reset', 'color', 'range'].includes(type)) actions.push('fill');
    else actions.push('click');
    const x = Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)); const y = Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    const isInView = r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight;
    const options = el.tagName === 'SELECT' ? [...(el as HTMLSelectElement).options].map(o => ({ value: o.value, label: clean(o.label), disabled: o.disabled })) : [];
    const stableKey = el.getAttribute('data-testid') ? `testid:${el.getAttribute('data-testid')}` : el.id ? `id:${el.id}` : el.getAttribute('name') ? `name:${el.getAttribute('name')}` : undefined;
    return {
      localId: instance(el), instanceId: instance(el), tag: el.tagName.toLowerCase(), role: semanticRole, name, label: label(el), stableKey,
      region: regionKey(el.closest(regionSelector)), form: regionKey(el.closest('form')), selector: selector(el), rect: r,
      value: typeof e.value === 'string' ? e.value : el.getAttribute('contenteditable') === 'true' ? clean(el.textContent) : '', displayedText: clean(el.textContent),
      checked: ['checkbox', 'radio'].includes(type) ? e.checked : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : null,
      selected: el.tagName === 'SELECT' ? [...(el as HTMLSelectElement).selectedOptions].map(o => o.value) : el.getAttribute('aria-selected') === 'true' ? [name] : [],
      visible: !!visible, enabled: !!enabled, editable: !!editable, expanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : null, controls: el.getAttribute('aria-controls'),
      constraints: { type, required: !!e.required, min: e.min || undefined, max: e.max || undefined, step: e.step || undefined, pattern: e.pattern || undefined, minLength: e.minLength >= 0 ? e.minLength : undefined, maxLength: e.maxLength >= 0 ? e.maxLength : undefined, valid: e.validity?.valid ?? true },
      options, actions, discovery: [el.hasAttribute('role') ? 'aria-role' : 'native-or-dom-heuristic'],
      actionable: { visible: !!visible, enabled: !!enabled, editable: !!editable, hitTarget: isInView ? !!hit && (hit === el || el.contains(hit)) : null, unknown: ['event-handler-completeness', 'business-preconditions', ...(!isInView ? ['off-viewport-hit-target'] : [])] },
    };
  });
  const gaps: { code: string; message: string; selector?: string; critical?: boolean }[] = [];
  if (!body) gaps.push({ code: 'DOM_ROOT_UNAVAILABLE', message: 'Document body is absent; the page may be navigating or rebuilding', critical: true });
  if (document.readyState === 'loading') gaps.push({ code: 'DOCUMENT_LOADING', message: 'Document parsing is still in progress', critical: true });
  for (const el of document.querySelectorAll('iframe,canvas,input[type=file]')) gaps.push({ code: `UNSUPPORTED_${el.tagName === 'INPUT' ? 'FILE_INPUT' : el.tagName}`, message: `${el.tagName} internals are outside V0.1 coverage`, selector: selector(el) });
  for (const el of document.querySelectorAll('*')) if (el.shadowRoot) gaps.push({ code: 'UNSUPPORTED_SHADOW_DOM', message: 'Shadow root contents were not collected', selector: selector(el) });
  if (all.length > controls.length) gaps.push({ code: 'TRUNCATED', message: `${all.length - controls.length} controls omitted`, critical: true });
  if (bodyText.length > 50000) gaps.push({ code: 'TEXT_TRUNCATED', message: 'Visible text was truncated to 50000 characters' });
  const layers = overlayCollector(controls, regions);
  return { documentId: tracker.documentId as string, url: location.href, title: document.title, text: bodyText.slice(0, 50000), controls, regions, ...layers, scroll: { x: scrollX, y: scrollY, maxY: Math.max(0, (document.documentElement?.scrollHeight ?? 0) - innerHeight) }, gaps };
}

export class BrowserAdapter implements InteractionDriver<Observation, SessionOptions> {
  browser?: Browser; context?: BrowserContext; page?: Page;
  private gaps: Gap[] = [];
  constructor(public options: SessionOptions, private evidence: EvidenceStore, private hooks: EngineHooks = {}) {}
  connected() { return !!this.page && !this.page.isClosed(); }
  async start() {
    this.browser = await chromium.launch({ headless: this.options.headless });
    this.context = await this.browser.newContext({ viewport: this.options.viewport, storageState: this.options.storageState as any, acceptDownloads: false });
    this.page = await this.context.newPage();
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
  async readDOM() {
    if (!this.page || this.page.isClosed()) throw new EngineError('BROWSER_UNAVAILABLE', 'Browser is not connected');
    // tsx preserves nested function names using a module-local helper. Supply it
    // inside the serialized closure so development and compiled execution agree.
    const source = `(() => { const __name = (fn) => fn; return (${collectDOM.toString()})(${collectOverlays.toString()}); })()`;
    return this.page.evaluate(source) as Promise<{ documentId: string; url: string; title: string; text: string; controls: Control[]; regions: Region[]; overlays: NonNullable<Observation['overlays']>; boundaries: NonNullable<Observation['boundaries']>; scroll: Observation['scroll']; gaps: Gap[] }>;
  }
  async capture(observationId: string) {
    if (!this.page) throw new EngineError('BROWSER_UNAVAILABLE', 'Browser is not connected');
    let previous = ''; let unchangedSince = Date.now(); const deadline = Date.now() + this.options.observeTimeoutMs; let stable = false;
    let dom: Awaited<ReturnType<BrowserAdapter['readDOM']>> | undefined;
    let lastError: string | undefined;
    do {
      try {
        dom = await timeout(this.readDOM(), Math.max(1, deadline - Date.now()), 'DOM capture deadline exceeded');
        lastError = undefined;
        const incomplete = dom.gaps.some(g => ['DOM_ROOT_UNAVAILABLE', 'DOCUMENT_LOADING'].includes(g.code));
        const key = JSON.stringify({ documentId: dom.documentId, url: dom.url, overlays: dom.overlays.map(o => o.key), controls: dom.controls.map(c => [c.instanceId, c.name, c.value, c.displayedText, c.checked, c.visible, c.enabled, c.expanded, c.constraints, c.rect, c.actionable.hitTarget]) });
        if (key !== previous || incomplete) { previous = key; unchangedSince = Date.now(); }
        if (!incomplete && Date.now() - unchangedSince >= this.options.settleMs) { stable = true; break; }
      } catch (error) {
        lastError = String(error); previous = ''; unchangedSince = Date.now();
        if (this.page.isClosed()) break;
      }
      if (Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, Math.min(50, Math.max(0, deadline - Date.now()))));
    } while (Date.now() < deadline);
    // Keep the last successful evidence, or an explicitly incomplete record when
    // the execution context never became readable. Never replay the action here.
    dom ??= { documentId: `unavailable:${id()}`, url: this.page.url(), title: '', text: '', controls: [], regions: [], overlays: [], boundaries: [], scroll: { x: 0, y: 0, maxY: 0 }, gaps: [] };
    const capturedAt = now(); const gaps = [...dom.gaps, ...this.gaps.splice(0)];
    if (lastError) gaps.push({ code: 'DOM_CAPTURE_FAILED', message: lastError, critical: true });
    if (!stable) gaps.push({ code: 'UNSTABLE', message: 'Page did not settle within the observation budget', critical: true });
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
    try { screenshot = `${observationId}.png`; const data = await this.page.screenshot({ timeout: this.options.actionTimeoutMs }); await this.evidence.put(screenshot, { data, mediaType: 'image/png' }); screenshotAt = now(); }
    catch (error) { gaps.push({ code: 'SCREENSHOT_FAILED', message: String(error) }); screenshot = undefined; }
    try {
      const current = await timeout(this.page.evaluate(() => ({ documentId: (window as any).__interactionEvidenceTracker?.documentId, hasBody: !!document.body })), this.options.observeTimeoutMs, 'Document verification deadline exceeded');
      if (current.documentId !== dom.documentId || !current.hasBody) { stable = false; gaps.push({ code: 'OBSERVATION_INTERRUPTED', message: 'Document changed or became unavailable between DOM and evidence collection', critical: true }); }
    } catch (error) { stable = false; gaps.push({ code: 'OBSERVATION_INTERRUPTED', message: String(error), critical: true }); }
    return { ...dom, instanceScope: dom.documentId, capturedAt, screenshotAt, screenshot, context, gaps, stable, viewport: this.options.viewport };
  }
  async execute(action: ActionCandidate, control?: Control) {
    const page = this.page!;
    if (action.kind === 'scroll') { await page.mouse.wheel(0, Number(action.value ?? 600)); return; }
    if (action.kind === 'press' && !control) { await page.keyboard.press(String(action.value || 'Escape')); return; }
    if (!control) throw new EngineError('TARGET_MISSING', 'A current control is required');
    const target = page.locator(control.selector);
    if (await target.count() !== 1) throw new EngineError('TARGET_AMBIGUOUS', 'Target is no longer unique');
    const sameInstance = await target.evaluate((el, expected) => (window as any).__interactionEvidenceTracker?.ids.get(el) === expected, control.instanceId);
    if (!sameInstance) throw new EngineError('STALE_TARGET', 'Target was rebuilt after observation');
    const clickOptions = control.actionable.clickPoint ? { position: control.actionable.clickPoint } : {};
    if (action.kind === 'fill') await target.fill(String(action.value ?? ''));
    else if (action.kind === 'select') await target.selectOption(String(action.value));
    else if (action.kind === 'check') {
      if (control.tag === 'input') await target.setChecked(Boolean(action.value), clickOptions);
      else if (control.checked !== action.value) await target.click(clickOptions);
    } else if (action.kind === 'press') await target.press(String(action.value));
    else await target.click(clickOptions);
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
      const interfaceAction = ['fill', 'select', 'check', 'scroll', 'press'].includes(kind) || c?.expanded !== null && c?.expanded !== undefined || ['menuitem', 'option', 'tab', 'link'].includes(c?.role || '') || c?.tag === 'summary';
      const risk = interfaceAction ? 'interface' : c?.constraints.type === 'submit' || c?.tag === 'button' && c.form !== 'document' ? 'submission' : 'unknown';
      const a: ActionCandidate = { id: id(), sessionId: o.sessionId, observationId: o.id, stateId: o.stateId, controlId: c?.identityId, localId: c?.localId, kind, value, label: c?.name || (kind === 'scroll' ? 'Scroll page' : 'Close overlay'), preconditions: { context: o.context, visible: true, enabled: true, identityResolved: true }, replayable: interfaceAction, risk, source: 'dom-v1', excluded: !!blocked, exclusionReason: blocked, sampleValidity };
      actions.push(constrain(a, o, session));
    };
    for (const c of o.controls.filter(c => c.visible)) {
      for (const kind of c.actions) {
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
        } else if (kind === 'select') for (const option of c.options.filter(x => !x.disabled && x.value !== c.value)) add(kind, option.value, c);
        else if (kind === 'check') { if (c.role !== 'radio' || !c.checked) add(kind, !c.checked, c); }
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
    const liveCanonical = observableCanonical({ ...current, ...live, context: current.context, gaps: current.gaps });
    if (liveCanonical !== current.canonical || live.controls.some((c, i) => c.instanceId !== current.controls[i]?.instanceId)) {
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
