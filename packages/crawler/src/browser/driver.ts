import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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
import type { BrowserComponent, Control, DomEvidence, EvidenceOptions, Gap, Overlay, Region, RuntimeEvidence, ScrollContainer, StructuralListCandidate } from './types.js';

export interface DriverOptions {
  url: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Playwright default timeout for clicks, fills and waits. */
  actionTimeoutMs?: number;
}

/** One capture of the current page. `dom` is present only for a detailed capture. */
export interface DOMSnapshot {
  documentId: string; url: string; title: string; text: string;
  controls: Control[]; regions: Region[]; overlays: Overlay[]; components?: BrowserComponent[];
  structuralLists?: StructuralListCandidate[]; scrollContainers?: ScrollContainer[];
  scroll: { x: number; y: number; maxY: number }; gaps: Gap[]; dom?: DomEvidence;
}

export type DriverAction = { kind: 'click' | 'hover' | 'check' | 'press'; value?: boolean | string };

/** Bounds for the detailed DOM evidence that UI rule plugins read. */
export const detailOptions: EvidenceOptions = {
  enabled: true, maxNodes: 5000, maxTextLength: 20000, maxHtmlLength: 2_000_000, maxDomCharacters: 4_000_000,
  maxAttributeLength: 4000, maxRuntimeEntries: 200, styles: 'essential', accessibility: false, fullPageScreenshot: false,
};

/** A Chromium page with the in-page capture and the few dispatches the crawler needs. */
export class BrowserDriver {
  browser?: Browser; context?: BrowserContext; page?: Page;
  private recorder = new RuntimeRecorder(detailOptions.maxRuntimeEntries, detailOptions.maxTextLength);
  constructor(readonly options: DriverOptions) {}

  async start() {
    this.browser = await chromium.launch({ headless: this.options.headless ?? true });
    this.context = await this.browser.newContext({ viewport: this.options.viewport ?? { width: 1440, height: 900 }, acceptDownloads: false });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.options.actionTimeoutMs ?? 2000);
    this.recorder.attach(this.page);
    await this.page.addInitScript(`(() => { const __name = fn => fn; (${installImageResourceEvidence.toString()})(); })()`);
    // Native dialogs (alert/confirm) would block the page; downloads are never taken.
    this.page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    this.page.on('download', download => void download.cancel().catch(() => {}));
    await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' });
  }

  /** Capture the page; `detailed` adds the full DOM evidence (styles, layout, text geometry). */
  async readDOM(detailed = false): Promise<DOMSnapshot> {
    const page = this.page!;
    // tsx preserves nested function names with a module-local __name helper; supply it in the
    // serialized closure so development and compiled builds agree.
    const source = `(() => { const __name = (fn) => fn; return JSON.stringify((${collectDOM.toString()})(${[collectOverlays, collectActionEvidence, collectIdentityContexts, collectPopupRelations, collectComponents, collectScrollContainers, discoverStructuralLists, describeStructuralLists].map(f => f.toString()).join(', ')}, ${detailed ? collectEvidence.toString() : 'undefined'}, ${JSON.stringify(detailOptions)})); })()`;
    const raw = JSON.parse(await page.evaluate(source) as string) as DOMSnapshot & { detailDom?: DomEvidence };
    const { detailDom, ...snapshot } = raw;
    return detailDom ? { ...snapshot, dom: detailDom } : snapshot;
  }

  /** Network, console and error records collected so far (bounded). */
  runtime(): RuntimeEvidence { return this.recorder.snapshot(this.page!); }

  async execute(action: DriverAction, control: Control) {
    const target = this.page!.locator(control.selector);
    if (await target.count() !== 1) throw new Error('Target is no longer unique');
    const same = await target.evaluate(new Function('el', 'expected', 'return window.__interactionEvidenceTracker && window.__interactionEvidenceTracker.ids.get(el) === expected') as (el: Element, expected: string) => boolean, control.instanceId);
    if (!same) throw new Error('Target was rebuilt after capture');
    const position = control.actionable.clickPoint ? { position: control.actionable.clickPoint } : {};
    if (action.kind === 'hover') await target.hover(position);
    else if (action.kind === 'check') {
      if (control.tag === 'input') await target.setChecked(Boolean(action.value), position);
      else if (control.checked !== action.value) await target.click(position);
    } else if (action.kind === 'press') await target.press(String(action.value ?? 'Escape'));
    else await target.click(position);
  }

  async close() { await this.browser?.close(); }
}
