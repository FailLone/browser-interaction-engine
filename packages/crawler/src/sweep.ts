import type { Page } from 'playwright';
import type { BrowserDriver, DOMSnapshot } from './browser/driver.js';
import { controlClass, listClass, modeRoles } from './abstraction.js';
import type { Control } from './browser/types.js';

/**
 * What a control adds to a container sweep. A list member, or an option among others like it, is
 * one more of its list: options in a picker each carry their own name, so their class alone would
 * make every row look new. The list or option group is new once; its members are samples of it.
 *
 * A field or an unnamed icon is told apart by the text before it, which in a long list is the
 * neighbouring rows and changes on every screen. Inside a container that text says nothing about
 * the control, so only its own structure counts: role, tag and its parent element.
 */
function kindOf(c: Control) {
  const list = listClass(c);
  if (list) return list;
  const parent = c.domAncestry?.instanceIds[0];
  if (modeRoles.has(c.role) && parent) return `group:${c.role}:${parent}`;
  if (c.neighborhood) return `around:${c.role}|${c.tag}|${parent ?? ''}`;
  return controlClass(c);
}

/**
 * Whether a screen shows anything not seen before. A container is a list (rows, options,
 * cards): judged by the kinds of its controls, so more rows of the same template are nothing new.
 * The page is not a list; it is sections, each a different part of the page. A screen of the page
 * counts as new when it shows a control that has not been on any screen yet, so a long page is read
 * to its end, while a long list on it (structural list members) still counts as more of the same.
 */

/** One position a sweep looked at: which surface, where page and surface were, and what was there. */
export interface SweepView {
  /** 'page', or the selector of a scrolling container. */
  surface: string;
  page: { x: number; y: number };
  at: { x: number; y: number };
  capture: DOMSnapshot;
}

/**
 * How a sweep of one surface ended: reached the end ('end'); kept growing as it was scrolled
 * ('endless': an infinite feed); only repeated what was already seen for several screens ('repeats':
 * a long list, sampled rather than exhausted); or stopped at the screen budget ('budget').
 */
export type SweepEnd = 'end' | 'endless' | 'repeats' | 'budget';

/** One surface's sweep: how far, how it ended, what it cost and what it found. */
export interface SweptSurface {
  surface: string;
  screens: number;
  end: SweepEnd;
  grew: number;
  ms: number;
  /** Controls not in the first capture. */
  revealed: number;
  /** Of those, controls of a class not seen before: what a sweep adds to exploration. */
  newClasses: number;
}

export interface SweepResult {
  views: SweepView[];
  surfaces: SweptSurface[];
  /**
   * Surfaces not swept, or swept only where they changed: what was not looked at again is as it
   * was when an earlier state of the page was swept and checked.
   */
  skipped: string[];
  ms: number;
  /** Where page and containers were before the sweep; they are put back there. */
  origin: { page: { x: number; y: number }; containers: Record<string, { x: number; y: number }> };
}

export interface SweepOptions {
  /** Most screens for the page, and for each container: a guard, not where a sweep normally ends. */
  pageScreens: number;
  containerScreens: number;
  maxContainers: number;
  /**
   * A surface that grew this many times while being scrolled is an infinite feed. Growth is
   * counted whenever its scrollable length increases, not only at its end: a feed that loads the
   * next page before the end is reached never lets a sweep arrive there.
   */
  maxGrowth: number;
  /**
   * Screens in a row that show no control of a new class (only more members of lists already
   * met, more of the same components) before a surface counts as a long list and is left: lists
   * are sampled, not exhausted. Repeats are counted from the first new class on.
   */
  maxRepeats: number;
  /** Time after each scroll for lazy content and scroll-driven styles to settle. */
  settleMs: number;
  /** Detailed captures (style, layout, text geometry) at each position, for plugins. */
  detailed: boolean;
  /** An open overlay: only containers inside it are swept, not the page behind it. */
  overlay?: string;
  /** Surfaces already found endless on this page; not swept again. */
  skip?: Set<string>;
  /** What earlier sweeps of this page saw; unchanged surfaces are not swept again. */
  seen?: SweepMemory;
}

/**
 * What sweeps of one page have seen: each container's scrollable length when swept, the classes of
 * every control met, and for the page itself every control already looked at on a screen (by a
 * signature of what it is and how big it is) and how far down the page was read. A later state is
 * scrolled only to the controls that changed or appeared since, and to page length that is new: an
 * action that expands one answer moves everything below it, but changes only that answer.
 */
export interface SweepMemory {
  extents: Map<string, string>;
  classes: Set<string>;
  /** Signatures of page controls already looked at on a screen. */
  checked: Set<string>;
  /** Page length already read, from the top, in CSS px. */
  reached: number;
}

/** What a control is, independent of where the page has scrolled or moved it. */
const signature = (c: Control) =>
  [
    c.instanceId,
    c.name,
    Math.round(c.rect.width),
    Math.round(c.rect.height),
    c.visible,
    c.enabled,
    c.expanded,
    c.selected.length,
    c.checked,
  ].join('|');

export const defaultSweep: SweepOptions = {
  pageScreens: 40,
  containerScreens: 30,
  maxContainers: 10,
  maxGrowth: 2,
  maxRepeats: 2,
  settleMs: 250,
  detailed: false,
};

type Extent = { x: number; y: number; maxX: number; maxY: number; width: number; height: number };

/**
 * Scroll the page, then each scrolling container on it, one screen at a time to the end, and
 * capture every position: content rendered only once scrolled near (lazy sections, virtual
 * lists, carousels) is read where it appears. A surface whose end moves away as it is scrolled is
 * an infinite feed; after `maxGrowth` extensions it is left, as a list is sampled rather than
 * exhausted. Everything is put back where it was; the caller re-reads the page.
 *
 * Scrolling is the only thing done: no clicks, no keys, nothing that changes what the page is.
 */
export async function sweep(
  page: Page,
  driver: BrowserDriver,
  start: DOMSnapshot,
  options: SweepOptions = defaultSweep,
): Promise<SweepResult> {
  const started = performance.now();
  // With an overlay open, its own lists; a container is attributed to the innermost overlay holding
  // it, so one inside a nested menu column belongs to that column, not the menu: accept any of them.
  const overlays = new Set((start.overlays ?? []).map(o => o.key));
  const containers = (start.scrollContainers ?? [])
    .filter(
      c =>
        !c.root &&
        (c.maxTop > 1 || c.maxLeft > 1) &&
        (options.overlay ? !!c.boundaryKey && overlays.has(c.boundaryKey) : !c.boundaryKey),
    )
    .filter((c, i, all) => all.findIndex(o => o.selector === c.selector) === i)
    .filter(c => !options.skip?.has(c.selector))
    .slice(0, options.maxContainers);
  const seen = options.seen;
  const width = start.dom?.environment?.layoutViewport.width ?? innerSize(start).width,
    height = start.dom?.environment?.layoutViewport.height ?? innerSize(start).height;
  // Controls not wholly on the first screen; a change there is what a new sweep would show.
  const offscreen = start.controls.filter(c => !inView(c.rect, width, height));
  const changed = (surface: string, extent: string) =>
    !seen || seen.extents.get(surface) !== extent || offscreen.some(c => !seen.classes.has(kindOf(c)));
  const extentOf = (c: (typeof containers)[number]) => `${Math.round(c.maxLeft)}x${Math.round(c.maxTop)}`;
  const result: SweepResult = {
    views: [],
    surfaces: [],
    skipped: [],
    ms: 0,
    origin: {
      page: await page.evaluate(scrollOf, null),
      containers: Object.fromEntries(containers.map(c => [c.selector, { x: c.left, y: c.top }])),
    },
  };
  const read = () => driver.readDOM(options.detailed);
  // Classes already shown: on the first screen, in earlier sweeps of this page, and on screens
  // swept so far. A screen showing only these repeats.
  const known = new Set([
    ...start.controls
      .filter(c => c.visible && inView(c.rect, width, height))
      .flatMap(c => [kindOf(c), `control:${c.instanceId}`, `shown:${c.instanceId}`]),
    ...(seen?.classes ?? []),
  ]);
  const first = new Set(start.controls.map(c => c.instanceId));
  const ctx = { read, result, options, known, first, width, height };
  try {
    // The page behind an open overlay is not what the user sees; only the overlay's own lists are.
    if (!options.overlay && !options.skip?.has('page')) {
      if (seen?.reached) await revisitPage(page, start, seen, ctx);
      else await sweepSurface(page, null, options.pageScreens, ctx);
      if (seen) remember(seen, start, result, height);
    }
    for (const c of containers) {
      if (!changed(c.selector, extentOf(c))) {
        result.skipped.push(c.selector);
        continue;
      }
      seen?.extents.set(c.selector, extentOf(c));
      await restore(page, result);
      // Bring the container on screen first: some only render their rows while visible.
      await page
        .locator(c.selector)
        .first()
        .scrollIntoViewIfNeeded({ timeout: 1000 })
        .catch(() => {});
      await sweepSurface(page, c.selector, options.containerScreens, ctx);
    }
  } finally {
    await restore(page, result).catch(() => {});
    await page.waitForTimeout(options.settleMs);
  }
  if (seen)
    for (const c of [...offscreen, ...result.views.flatMap(v => v.capture.controls)]) seen.classes.add(kindOf(c));
  result.ms = Math.round(performance.now() - started);
  return result;
}

/**
 * A page swept before on an earlier state: look only at controls that changed or appeared since
 * (one more member of a list already met is a sample of it, not a change). A page that grew is
 * mostly content inserted above its end (an expanded answer moves everything below it); its end is
 * looked at once, and read on from there only when something new shows up.
 */
async function revisitPage(page: Page, start: DOMSnapshot, seen: SweepMemory, ctx: SweepContext) {
  const { result, options, height } = ctx;
  const top = start.scroll.y;
  const margin = Math.min(120, height * 0.2);
  const changed = start.controls
    .filter(c => c.visible && c.rect.height > 0 && !seen.checked.has(signature(c)))
    .filter(c => !(listClass(c) && seen.classes.has(kindOf(c))))
    .filter(c => !c.landmark || c.rect.y + top > seen.reached)
    .map(c => ({ top: c.rect.y + top, bottom: c.rect.y + top + Math.min(c.rect.height, height - margin) }))
    .sort((a, b) => a.top - b.top);
  const longer = start.scroll.maxY + height > seen.reached + 1;
  if (!changed.length && !longer) {
    result.skipped.push('page');
    return;
  }
  const started = performance.now();
  // As few screens as cover every changed control, each whole on one of them.
  const ys: number[] = [];
  for (const b of changed) {
    const last = ys.at(-1);
    if (last !== undefined && b.top >= last + margin && b.bottom <= last + height) continue;
    ys.push(Math.max(0, b.top - margin));
  }
  const bottom = start.scroll.maxY;
  if (longer && !ys.some(y => y >= bottom - margin)) ys.push(bottom);
  const revealed = new Set<string>();
  const first = new Set(start.controls.map(c => c.instanceId));
  let freshAtEnd = false;
  for (const y of ys.slice(0, options.pageScreens)) {
    await page.evaluate(scrollTo, { selector: null, x: start.scroll.x, y });
    await page.waitForTimeout(options.settleMs);
    const capture = await ctx.read();
    const now = await page.evaluate(scrollOf, null);
    result.views.push({ surface: 'page', page: now, at: now, capture });
    for (const c of capture.controls) if (!first.has(c.instanceId)) revealed.add(c.instanceId);
    // New at the end: loaded by reaching it, so there may be more below.
    if (y === bottom)
      freshAtEnd = capture.controls.some(c => !first.has(c.instanceId) && !seen.checked.has(signature(c)));
  }
  result.surfaces.push({
    surface: 'page',
    screens: Math.min(ys.length, options.pageScreens),
    end: 'end',
    grew: 0,
    ms: Math.round(performance.now() - started),
    revealed: revealed.size,
    newClasses: 0,
  });
  // Unchanged parts of the page were not looked at again.
  result.skipped.push('page');
  if (freshAtEnd) await sweepSurface(page, null, options.pageScreens, ctx, bottom);
}

/** Record what this sweep of the page looked at, for the next state of the same page. */
function remember(seen: SweepMemory, start: DOMSnapshot, result: SweepResult, height: number) {
  const views = result.views.filter(v => v.surface === 'page');
  const shown = (s: DOMSnapshot) =>
    s.controls.filter(c => c.visible && c.rect.y >= 0 && c.rect.y + c.rect.height <= height);
  for (const c of shown(start)) seen.checked.add(signature(c));
  for (const v of views) for (const c of shown(v.capture)) seen.checked.add(signature(c));
  const bottom = Math.max(start.scroll.y, ...views.map(v => v.at.y)) + height;
  seen.reached = Math.max(seen.reached, bottom);
}

type SweepContext = {
  read: () => Promise<DOMSnapshot>;
  result: SweepResult;
  options: SweepOptions;
  known: Set<string>;
  first: Set<string>;
  width: number;
  height: number;
};

/** Put page and containers back where they were before the sweep. */
export async function restore(page: Page, result: SweepResult) {
  for (const [selector, at] of Object.entries(result.origin.containers))
    await page.evaluate(scrollTo, { selector, ...at });
  await page.evaluate(scrollTo, { selector: null, ...result.origin.page });
}

/** Scroll back to a view the sweep took, e.g. to screenshot what was found there. */
export async function show(page: Page, view: SweepView, settleMs: number) {
  await page.evaluate(scrollTo, { selector: null, ...view.page });
  if (view.surface !== 'page') await page.evaluate(scrollTo, { selector: view.surface, ...view.at });
  await page.waitForTimeout(settleMs);
}

async function sweepSurface(
  page: Page,
  selector: string | null,
  budget: number,
  { read, result, options, known, first, width, height }: SweepContext,
  /** Where to start; by default the top, or the surface's own start. */
  from = 0,
) {
  const started = performance.now();
  let extent = await page.evaluate(extentOf, selector);
  if (!extent) return;
  // A container scrolls along the axis it has room on; the page vertically.
  const horizontal = !!selector && extent.maxX > extent.maxY;
  const size = (e: Extent) => (horizontal ? e.width : e.height);
  const end = (e: Extent) => (horizontal ? e.maxX : e.maxY);
  const pos = (p: { x: number; y: number }) => (horizontal ? p.x : p.y);
  // Overlap between screens, so a control on a boundary is whole in one of them.
  const step = Math.max(40, size(extent) * 0.8);
  // From the start: an action often leaves the page scrolled part way (to its own control), and
  // what lies above is as unseen as what lies below. The first screen is read again only when it
  // is not where the state was captured.
  const startAt = pos(extent);
  if (Math.abs(startAt - from) > 1) {
    await page.evaluate(scrollTo, { selector, x: horizontal ? from : extent.x, y: horizontal ? extent.y : from });
    await page.waitForTimeout(options.settleMs);
    const capture = await read();
    const now = await page.evaluate(scrollOf, selector);
    result.views.push({
      surface: selector ?? 'page',
      page: selector ? await page.evaluate(scrollOf, null) : now,
      at: now,
      capture,
    });
    extent = (await page.evaluate(extentOf, selector)) ?? extent;
  }
  // The length the surface had when the sweep began: every increase is content it loaded.
  let longest = end(extent),
    at = pos(extent),
    screens = 0,
    grew = 0,
    repeats = 0,
    newClasses = 0,
    how: SweepEnd = 'budget';
  const revealed = new Set<string>();
  const growth = () => {
    if (end(extent!) > longest + 1) {
      longest = end(extent!);
      grew++;
    }
    return grew >= options.maxGrowth;
  };
  while (screens < budget) {
    if (at >= end(extent) - 1) {
      // At the end: give lazy loading a moment, then see whether the end moved.
      await page.waitForTimeout(options.settleMs);
      extent = (await page.evaluate(extentOf, selector)) ?? extent;
      if (end(extent) <= at + 1) {
        how = 'end';
        break;
      }
    }
    if (growth()) {
      how = 'endless';
      break;
    }
    const target = Math.min(at + step, end(extent));
    await page.evaluate(scrollTo, {
      selector,
      x: horizontal ? target : extent.x,
      y: horizontal ? extent.y : target,
    });
    await page.waitForTimeout(options.settleMs);
    const now = await page.evaluate(scrollOf, selector);
    // The browser would not go further (scroll snapping, a wrapper that stops short): that is the end.
    if (pos(now) <= at + 1) {
      how = 'end';
      break;
    }
    screens++;
    const capture = await read();
    result.views.push({
      surface: selector ?? 'page',
      page: selector ? await page.evaluate(scrollOf, null) : now,
      at: now,
      capture,
    });
    // What this screen shows; the capture also holds controls elsewhere on the page.
    const shown = capture.controls.filter(c => c.visible && inView(c.rect, width, height));
    let fresh = 0;
    for (const c of capture.controls) if (!first.has(c.instanceId)) revealed.add(c.instanceId);
    for (const c of shown) {
      // On the page, a control met for the first time is new, unless it is one more member of a list.
      const cls = selector || listClass(c) ? kindOf(c) : `control:${c.instanceId}`;
      if (!known.has(cls)) {
        known.add(cls);
        fresh++;
      }
    }
    newClasses += fresh;
    at = pos(now);
    extent = (await page.evaluate(extentOf, selector)) ?? extent;
    // Only more of what was already seen: a long list or feed. Its members are sampled like any
    // list's, so there is no need to reach its end. On the page that means screens of more list
    // members; a screen of text, or of controls already passed (a sticky header), says nothing about
    // what follows and does not count. In a container every row counts.
    const more = selector ? shown.length > 0 : shown.some(c => listClass(c) && !known.has(`shown:${c.instanceId}`));
    for (const c of shown) known.add(`shown:${c.instanceId}`);
    if (fresh) repeats = 0;
    else if (more) repeats++;
    if (repeats >= options.maxRepeats && at < end(extent) - 1) {
      how = 'repeats';
      break;
    }
  }
  result.surfaces.push({
    surface: selector ?? 'page',
    screens,
    end: how,
    grew,
    ms: Math.round(performance.now() - started),
    revealed: revealed.size,
    newClasses,
  });
}

/** Whether a box (viewport CSS px) lies at least half on screen. */
function inView(r: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  if (!width || !height || r.width <= 0 || r.height <= 0) return false;
  const w = Math.min(width, r.x + r.width) - Math.max(0, r.x),
    h = Math.min(height, r.y + r.height) - Math.max(0, r.y);
  return w > 0 && h > 0 && w * h >= (r.width * r.height) / 2;
}

/** The viewport size, from the page's own scroll range when the capture has no environment. */
const innerSize = (s: DOMSnapshot) => ({
  width: s.scrollContainers?.find(c => c.root)?.width ?? 0,
  height: s.scrollContainers?.find(c => c.root)?.height ?? 0,
});

const scrollOf = new Function(
  'selector',
  `const el = selector ? document.querySelector(selector) : document.scrollingElement;
   return el ? { x: el.scrollLeft, y: el.scrollTop } : { x: scrollX, y: scrollY };`,
) as (selector: string | null) => { x: number; y: number };

const extentOf = new Function(
  'selector',
  `const el = selector ? document.querySelector(selector) : document.scrollingElement;
   if (!el) return undefined;
   return { x: el.scrollLeft, y: el.scrollTop, maxX: Math.max(0, el.scrollWidth - el.clientWidth),
     maxY: Math.max(0, el.scrollHeight - el.clientHeight), width: el.clientWidth, height: el.clientHeight };`,
) as (selector: string | null) => Extent | undefined;

const scrollTo = new Function(
  'to',
  `const el = to.selector ? document.querySelector(to.selector) : document.scrollingElement;
   if (el) el.scrollTo({ left: to.x, top: to.y, behavior: 'instant' });`,
) as (to: { selector: string | null; x: number; y: number }) => void;
