import { devices, type BrowserContextOptions, type Page } from 'playwright';

/**
 * Which screen the page is crawled on. `desktop` is a common small laptop; `desktop-edge` is the
 * narrowest width the page still lays out for desktop, read from its own breakpoints; `mobile` is
 * an iPhone (touch, mobile user agent, device pixel ratio 3). A custom size is taken as given.
 */
export type ViewportPreset = 'desktop' | 'desktop-edge' | 'mobile';
export type ViewportOption = ViewportPreset | { width: number; height: number; mobile?: boolean };

export interface ResolvedViewport {
  preset?: ViewportPreset;
  width: number;
  height: number;
  mobile: boolean;
  /** How the size was chosen; `fallback` means breakpoint detection found nothing usable. */
  source: 'preset' | 'custom' | 'detected' | 'fallback';
  /** desktop-edge only: the breakpoint used and every desktop-range breakpoint the page declared. */
  breakpoint?: number;
  breakpoints?: number[];
  /** desktop-edge only: why detection fell back, or which sheets could not be read. */
  note?: string;
}

export const desktopViewport = { width: 1280, height: 800 };
/** Used for desktop-edge when the page declares no desktop breakpoint (Tailwind `lg`). */
export const desktopEdgeFallback = { width: 1024, height: 768 };
const iphone = devices['iPhone 15'];
/** Full screen of the device; its viewport is shorter by the browser chrome. */
const iphoneScreen = { width: 393, height: 852 };

/** Widths at which a desktop layout typically begins (Bootstrap/AntD 992, Tailwind 1024, …). */
const DESKTOP_RANGE: [number, number] = [900, 1440];
/** Below the desktop range: a site whose only large breakpoint is a tablet one treats that as desktop. */
const TABLET_RANGE: [number, number] = [768, 900];

export function contextOptions(viewport: ResolvedViewport): BrowserContextOptions {
  const size = { width: viewport.width, height: viewport.height };
  if (!viewport.mobile) return { viewport: size };
  return {
    viewport: size,
    screen: viewport.preset === 'mobile' ? iphoneScreen : size,
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
  };
}

/** The viewport to open the page with; desktop-edge opens at the desktop size and is narrowed after detection. */
export function initialViewport(option: ViewportOption = 'desktop'): ResolvedViewport {
  if (typeof option === 'object')
    return { width: option.width, height: option.height, mobile: option.mobile ?? false, source: 'custom' };
  if (option === 'mobile') return { preset: 'mobile', ...iphone.viewport, mobile: true, source: 'preset' };
  return { preset: option, ...desktopViewport, mobile: false, source: 'preset' };
}

/** `desktop`, `desktop-edge`, `mobile`, `1280x800` or `393x852@mobile` (CLI form). */
export function parseViewport(text: string): ViewportOption {
  if (text === 'desktop' || text === 'desktop-edge' || text === 'mobile') return text;
  const match = /^(\d{3,4})x(\d{3,4})(@mobile)?$/.exec(text.trim());
  if (!match) throw new Error(`Unknown viewport "${text}": use desktop, desktop-edge, mobile or WIDTHxHEIGHT[@mobile]`);
  return { width: Number(match[1]), height: Number(match[2]), ...(match[3] ? { mobile: true } : {}) };
}

/** Records the queries page scripts pass to matchMedia (JS-driven layouts such as AntD's grid). */
export function installMediaQueryRecorder() {
  const seen = new Set<string>();
  const original = window.matchMedia;
  (window as unknown as { __interactionMediaQueries: Set<string> }).__interactionMediaQueries = seen;
  window.matchMedia = function (query: string) {
    if (seen.size < 500) seen.add(String(query));
    return original.call(window, query);
  };
}

/** Runs in the page: media queries from readable sheets and script calls, plus the URLs of unreadable sheets. */
function readMediaQueries() {
  const queries: string[] = [];
  const unreadable: string[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) queries.push(rule.media.mediaText);
      if (rule instanceof CSSImportRule) {
        if (rule.media.mediaText) queries.push(rule.media.mediaText);
        try {
          if (rule.styleSheet) walk(rule.styleSheet.cssRules);
        } catch {
          if (rule.styleSheet?.href) unreadable.push(rule.styleSheet.href);
        }
      } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.media.mediaText) queries.push(sheet.media.mediaText);
    try {
      walk(sheet.cssRules);
    } catch {
      if (sheet.href) unreadable.push(sheet.href);
    }
  }
  const recorded = (window as unknown as { __interactionMediaQueries?: Set<string> }).__interactionMediaQueries;
  if (recorded) queries.push(...recorded);
  return { queries, unreadable };
}

/**
 * Widths (CSS px) at which a width query switches. `min-width: N` and `width >= N` switch at N;
 * `max-width: M` stops matching at the next whole pixel (991.98px → 992). em/rem are 16px.
 */
export function mediaBreakpoints(query: string): number[] {
  const px = (value: string, unit = 'px') => Number(value) * (unit === 'px' ? 1 : 16);
  const out: number[] = [];
  const num = '([\\d.]+)(px|em|rem)?';
  for (const m of query.matchAll(new RegExp(`min-width\\s*:\\s*${num}`, 'gi'))) out.push(px(m[1], m[2]));
  for (const m of query.matchAll(new RegExp(`max-width\\s*:\\s*${num}`, 'gi')))
    out.push(Math.floor(px(m[1], m[2])) + 1);
  // Range syntax, written either way round: width >= N, N <= width, width < N, …
  for (const m of query.matchAll(new RegExp(`(?<![\\w-])width\\s*(>=|>|<=|<)\\s*${num}`, 'gi'))) {
    const v = px(m[2], m[3]);
    out.push(m[1] === '>=' || m[1] === '<' ? v : Math.floor(v) + 1);
  }
  for (const m of query.matchAll(new RegExp(`${num}\\s*(>=|>|<=|<)\\s*width(?![\\w-])`, 'gi'))) {
    const v = px(m[1], m[2]);
    out.push(m[3] === '<=' || m[3] === '>' ? v : Math.floor(v) + 1);
  }
  return out.filter(v => Number.isFinite(v) && v > 0).map(v => Math.round(v));
}

const inRange = (values: number[], [low, high]: [number, number]) =>
  [...new Set(values.filter(v => v >= low && v < high))].sort((a, b) => a - b);

/** The narrowest desktop width among the page's breakpoints, or undefined when it declares none. */
export function desktopEdge(breakpoints: number[]) {
  const desktop = inRange(breakpoints, [DESKTOP_RANGE[0], DESKTOP_RANGE[1] + 1]);
  if (desktop.length) return { width: desktop[0], breakpoints: desktop };
  const tablet = inRange(breakpoints, TABLET_RANGE);
  if (tablet.length) return { width: tablet.at(-1)!, breakpoints: tablet };
  return undefined;
}

/**
 * Reads the loaded page's breakpoints and returns the desktop-edge viewport. Sheets the page cannot
 * read (cross-origin without CORS) are fetched outside the page and scanned as text.
 */
export async function detectDesktopEdge(page: Page): Promise<ResolvedViewport> {
  const base = { preset: 'desktop-edge' as const, mobile: false };
  try {
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    const { queries, unreadable } = (await page.evaluate(
      `(() => { const __name = fn => fn; return (${readMediaQueries.toString()})(); })()`,
    )) as { queries: string[]; unreadable: string[] };
    let failed = 0;
    for (const href of [...new Set(unreadable)].slice(0, 20)) {
      const text = await page
        .context()
        .request.get(href, { timeout: 3000, maxRedirects: 3 })
        .then(r => (r.ok() ? r.text() : undefined))
        .catch(() => undefined);
      if (text === undefined) failed++;
      else for (const m of text.slice(0, 5_000_000).matchAll(/@media([^{]{1,500})\{/g)) queries.push(m[1]);
      // `<link media>` and `@import … screen and (…)` are covered by the in-page read.
    }
    const edge = desktopEdge(queries.flatMap(mediaBreakpoints));
    const note = failed ? `${failed} stylesheet(s) could not be read` : undefined;
    if (edge)
      return {
        ...base,
        width: edge.width,
        height: desktopEdgeFallback.height,
        source: 'detected',
        breakpoint: edge.width,
        breakpoints: edge.breakpoints,
        ...(note ? { note } : {}),
      };
    return {
      ...base,
      ...desktopEdgeFallback,
      source: 'fallback',
      note: note ? `no desktop breakpoint found; ${note}` : 'no desktop breakpoint found',
    };
  } catch (error) {
    return {
      ...base,
      ...desktopEdgeFallback,
      source: 'fallback',
      note: `detection failed: ${String(error).slice(0, 200)}`,
    };
  }
}
