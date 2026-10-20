import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { collectDOM } from './capture.js';
import { collectOverlays } from './overlays.js';
import { collectActionEvidence } from './action-evidence.js';
import { collectIdentityContexts } from './identity-context.js';
import { collectPopupRelations } from './popup-relations.js';
import { collectComponents } from './components.js';
import { collectScrollContainers } from './scroll-containers.js';
import { describeStructuralLists, discoverStructuralLists } from './structural-lists.js';
import { collectEvidence } from './collect-evidence.js';
import { installImageResourceEvidence } from './image-resource-evidence.js';
import { RuntimeRecorder } from './runtime-evidence.js';
import { hostMatches, type ScopedHeaders, type SessionCookie } from '../session.js';
import {
  contextOptions,
  detectDesktopEdge,
  initialViewport,
  installMediaQueryRecorder,
  type ResolvedViewport,
  type ViewportOption,
} from './viewport.js';
import type {
  BrowserComponent,
  Control,
  DomEvidence,
  EvidenceOptions,
  Gap,
  Overlay,
  Region,
  RuntimeEvidence,
  ScrollContainer,
  StructuralListCandidate,
} from './types.js';

export interface DriverOptions {
  url: string;
  headless?: boolean;
  /** A preset or a custom size; defaults to the `desktop` preset. */
  viewport?: ViewportOption;
  /** Playwright default timeout for clicks, fills and waits. */
  actionTimeoutMs?: number;
  /** Extra context options (a restored session's storage and device); the viewport size is kept. */
  context?: BrowserContextOptions;
  /** Scripts run before page scripts in every document. */
  initScripts?: string[];
  /** Request headers added only for matching hosts. */
  headers?: ScopedHeaders[];
  /** Cookies held at their value: restored when a response or page script changes them, rewritten on the wire. */
  pinnedCookies?: SessionCookie[];
}

/** One capture of the current page. `dom` is present only for a detailed capture. */
export interface DOMSnapshot {
  documentId: string;
  url: string;
  title: string;
  text: string;
  /** Short visible text of live regions (role=status / alert, aria-live, output). */
  status?: string[];
  controls: Control[];
  regions: Region[];
  overlays: Overlay[];
  components?: BrowserComponent[];
  structuralLists?: StructuralListCandidate[];
  scrollContainers?: ScrollContainer[];
  scroll: { x: number; y: number; maxY: number };
  gaps: Gap[];
  dom?: DomEvidence;
}

export type DriverAction = { kind: 'click' | 'hover' | 'check' | 'press'; value?: boolean | string };

/** Bounds for the detailed DOM evidence that UI rule plugins read. */
export const detailOptions: EvidenceOptions = {
  enabled: true,
  maxNodes: 20000,
  maxTextLength: 20000,
  maxHtmlLength: 2_000_000,
  maxDomCharacters: 40_000_000,
  maxAttributeLength: 4000,
  maxRuntimeEntries: 200,
  styles: 'essential',
  accessibility: false,
  fullPageScreenshot: false,
};

/** A Chromium page with the in-page capture and the few dispatches the crawler needs. */
export class BrowserDriver {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  /** The viewport the page runs in; final once `start()` resolves. */
  viewport: ResolvedViewport;
  private recorder = new RuntimeRecorder(detailOptions.maxRuntimeEntries, detailOptions.maxTextLength);
  constructor(readonly options: DriverOptions) {
    this.viewport = initialViewport(options.viewport);
  }

  async start() {
    this.browser = await chromium.launch({ headless: this.options.headless ?? true });
    const own = contextOptions(this.viewport);
    this.context = await this.browser.newContext({
      ...own,
      ...this.options.context,
      viewport: own.viewport,
      acceptDownloads: false,
    });
    for (const script of this.options.initScripts ?? []) await this.context.addInitScript(script);
    await this.installScopedState();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.options.actionTimeoutMs ?? 2000);
    this.recorder.attach(this.page);
    await this.page.addInitScript(
      `(() => { const __name = fn => fn; (${installImageResourceEvidence.toString()})(); })()`,
    );
    // Native dialogs (alert/confirm) would block the page; downloads are never taken.
    this.page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    this.page.on('download', download => void download.cancel().catch(() => {}));
    const edge = this.viewport.preset === 'desktop-edge';
    if (edge)
      await this.page.addInitScript(
        `(() => { const __name = fn => fn; (${installMediaQueryRecorder.toString()})(); })()`,
      );
    await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' });
    if (!edge) return;
    // Breakpoints are read from the loaded page; it is then reloaded at that width, so layouts
    // chosen once at startup (from innerWidth or matchMedia) are chosen for the new width too.
    this.viewport = await detectDesktopEdge(this.page);
    await this.page.setViewportSize({ width: this.viewport.width, height: this.viewport.height });
    await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' });
  }

  /**
   * Scoped headers and pinned cookies. Both go through one context route, registered before the
   * crawler's own routes so it runs last and sees the request as it will be sent. Pinned cookies
   * are also kept in the jar (re-added after a response sets them) and guarded against
   * `document.cookie` and `cookieStore` writes, so the page reads the pinned value too.
   */
  private async installScopedState() {
    const context = this.context!;
    const scoped = this.options.headers ?? [],
      pinned = this.options.pinnedCookies ?? [];
    if (!scoped.length && !pinned.length) return;
    if (pinned.length) {
      await context.addCookies(pinned);
      await context.addInitScript(
        `(${guardCookies.toString()})(${JSON.stringify([...new Set(pinned.map(c => c.name))])})`,
      );
      context.on('response', async response => {
        const host = hostOf(response.url());
        const reset = (await response.headersArray().catch(() => [] as { name: string; value: string }[])).some(
          h =>
            h.name.toLowerCase() === 'set-cookie' &&
            pinned.some(c => h.value.trimStart().startsWith(`${c.name}=`) && hostMatches(host, [c.domain])),
        );
        if (reset) void context.addCookies(pinned).catch(() => {});
      });
    }
    await context.route('**/*', async route => {
      const request = route.request();
      const host = hostOf(request.url());
      const extra = Object.assign({}, ...scoped.filter(s => hostMatches(host, s.domains)).map(s => s.headers));
      const pins = pinned.filter(c => hostMatches(host, [c.domain]));
      if (!Object.keys(extra).length && !pins.length) return route.fallback();
      const headers = { ...(await request.allHeaders()), ...extra };
      if (pins.length) {
        const names = new Set(pins.map(c => c.name));
        headers.cookie = [
          ...(headers.cookie ?? '').split(/;\s*/).filter((part: string) => part && !names.has(part.split('=')[0]!)),
          ...pins.map(c => `${c.name}=${c.value}`),
        ].join('; ');
      }
      return route.fallback({ headers });
    });
  }

  /** Capture the page; `detailed` adds the full DOM evidence (styles, layout, text geometry). */
  async readDOM(detailed = false): Promise<DOMSnapshot> {
    const page = this.page!;
    // tsx preserves nested function names with a module-local __name helper; supply it in the
    // serialized closure so development and compiled builds agree.
    const source = `(() => { const __name = (fn) => fn; return JSON.stringify((${collectDOM.toString()})(${[collectOverlays, collectActionEvidence, collectIdentityContexts, collectPopupRelations, collectComponents, collectScrollContainers, discoverStructuralLists, describeStructuralLists].map(f => f.toString()).join(', ')}, ${detailed ? collectEvidence.toString() : 'undefined'}, ${JSON.stringify(detailOptions)})); })()`;
    const raw = JSON.parse((await page.evaluate(source)) as string) as DOMSnapshot & { detailDom?: DomEvidence };
    const { detailDom, ...snapshot } = raw;
    return detailDom ? { ...snapshot, dom: detailDom } : snapshot;
  }

  /** Network, console and error records collected so far (bounded). */
  runtime(): RuntimeEvidence {
    return this.recorder.snapshot(this.page!);
  }

  async execute(action: DriverAction, control: Control) {
    const target = this.page!.locator(control.selector);
    if ((await target.count()) !== 1) throw new Error('Target is no longer unique');
    const same = await target.evaluate(
      new Function(
        'el',
        'expected',
        'return window.__interactionEvidenceTracker && window.__interactionEvidenceTracker.ids.get(el) === expected',
      ) as (el: Element, expected: string) => boolean,
      control.instanceId,
    );
    if (!same) throw new Error('Target was rebuilt after capture');
    const position = control.actionable.clickPoint ? { position: control.actionable.clickPoint } : {};
    if (action.kind === 'hover') await target.hover(position);
    else if (action.kind === 'check') {
      if (control.tag === 'input') await target.setChecked(Boolean(action.value), position);
      else if (control.checked !== action.value) await target.click(position);
    } else if (action.kind === 'press') await target.press(String(action.value ?? 'Escape'));
    else await target.click(position);
  }

  async close() {
    await this.browser?.close();
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** In-page: writes to the named cookies from page scripts are ignored. Serialized into an init script. */
function guardCookies(names: string[]) {
  const blocked = (text: string) => names.includes(String(text).split('=')[0]!.trim());
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (descriptor?.set && descriptor.get) {
    const { get, set } = descriptor;
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get() {
        return get.call(this);
      },
      set(value: string) {
        if (!blocked(value)) set.call(this, value);
      },
    });
  }
  const store = (
    globalThis as unknown as { CookieStore?: { prototype: Record<string, (...args: unknown[]) => unknown> } }
  ).CookieStore;
  if (!store) return;
  for (const method of ['set', 'delete']) {
    const original = store.prototype[method];
    if (!original) continue;
    store.prototype[method] = function (this: unknown, ...args: unknown[]) {
      const first = args[0] as string | { name?: string };
      const name = typeof first === 'string' ? first : first?.name;
      return name && names.includes(name) ? Promise.resolve() : original.apply(this, args);
    };
  }
}
