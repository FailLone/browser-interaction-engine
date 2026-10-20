import { withoutLanguage } from './language.js';
import type { Control, Overlay, Region } from './browser/types.js';

/** Minimal capture the crawler needs; produced by the adapter's DOM collector. */
export interface Snapshot {
  url: string;
  title: string;
  text?: string;
  /** Short visible text of live regions (role=status / alert, aria-live, output). */
  status?: string[];
  controls: Control[];
  overlays?: Overlay[];
  regions?: Region[];
  /** Adapter document identity; changes on every full page load. */
  documentId?: string;
  /** The full capture this projection came from (for plugins). */
  capture?: import('./browser/driver.js').DOMSnapshot;
}

/** Live values (prices, times, percentages, counts) never make a new state or component. */
export function maskVolatile(text: string, max = 80): string {
  return (
    text
      .replace(/\s+/g, ' ')
      .trim()
      // Digits of any script; thousands grouped by , . ' or a space ("1 234,56" in fr / ru).
      .replace(/[-+]?[\p{Nd}₀-₉][\p{Nd}₀-₉.,:%/']*(?: (?=\p{Nd}{3}(?!\p{Nd}))[\p{Nd}.,:%/']+)*/gu, '#')
      .slice(0, max)
  );
}

/**
 * The page a URL shows, from the URL alone: a leading language segment with a script or region
 * (/zh-hans/, /en-au/, /es-419/) is taken off. Pages that declare their language versions are
 * matched exactly by `LanguageVersions`, which the crawler uses for navigation decisions.
 */
export function pagePath(url: string): string {
  return withoutLanguage(url);
}

/**
 * Page template: the path with its last segment replaced, so /convert/usd-to-btc
 * and /convert/btc-to-pkr are the same template. The entry page stays itself.
 */
export function pageTemplate(url: string): string {
  try {
    const u = new URL(url),
      parts = new URL(withoutLanguage(url)).pathname.split('/');
    if (parts.length > 2) parts[parts.length - 1] = '*';
    return u.origin + parts.join('/');
  } catch {
    return url;
  }
}

/** The innermost open overlay owns interaction; everything beneath a modal is masked. */
export function activeOverlay(s: Snapshot): Overlay | undefined {
  const visible = new Set(s.controls.filter(c => c.visible).map(c => c.localId));
  // Collector order lists parents before their children.
  return (s.overlays || []).filter(o => o.controlIds.some(id => visible.has(id))).at(-1);
}

/**
 * Mode selectors (tabs, radios, segmented options) look like repeated rows but
 * each one switches to different content: every member is its own component.
 */
export const modeRoles = new Set(['tab', 'radio', 'menuitemradio', 'option', 'switch']);

/**
 * The mode group a selector belongs to (its tablist/radiogroup/row), independent
 * of document instance IDs: same page path, role and parent selector.
 */
export function modeGroup(
  c: Control,
  url: string,
  siblings?: (parentInstanceId: string) => string[],
): string | undefined {
  // Segmented controls are often plain buttons in a row: short, label-only names
  // ("1h", "24h", "1W") sharing a parent behave as one mode group.
  // Outside ASCII a short label is often a whole word ("登录"), so it needs a number ("24ч", "7天").
  const short = (c.name || '').trim();
  const segmented =
    c.role === 'button' &&
    !c.landmark &&
    (/^[\w.%+-]{1,4}$/.test(short) || /^(?=.*\p{Nd})[\p{L}\p{N}.%+-]{1,4}$/u.test(short));
  if (!modeRoles.has(c.role) && !segmented) return;
  // The parent element groups the row. Its instance ID changes with every document,
  // so the group is keyed by the parent's member names, which are stable across reloads.
  const parent = c.domAncestry?.instanceIds[0];
  const owner = parent && siblings ? siblings(parent).join('|') : c.selector.replace(/\s*>\s*[^>]+$/, '');
  return `${pagePath(url)}|${segmented ? 'segment' : c.role}|${owner}`;
}

/** A list member's class: one entry per (list owner, template slot), not per row. */
export function listClass(c: Control): string | undefined {
  if (modeRoles.has(c.role)) return;
  return c.structuralItem
    ? `list:${c.structuralItem.template}:${c.structuralItem.slot}`
    : c.list
      ? `list:${c.list.selector}:${c.role}`
      : undefined;
}

/** Component class, stable across live-value changes and list membership. */
export function controlClass(c: Control): string {
  const own = c.name || c.label || c.displayedText || '';
  // Two amount fields both named by a "0" placeholder, or two unnamed icons, differ by what
  // is around them (the currency selector beside a field, the sentence beside an icon).
  const field = ['input', 'textarea'].includes(c.tag);
  const name = (field || !own) && c.neighborhood ? `${own}@${maskVolatile(c.neighborhood)}` : own;
  // Short labels are static ("1h", "24h", "1Y", "2Y"); masking their digits would merge them.
  const short = name.trim().length <= 4 || (modeRoles.has(c.role) && name.length <= 24);
  return listClass(c) || [c.landmark || '', c.role, c.tag, short ? name : maskVolatile(name)].join('|');
}

/**
 * Abstract state: page path + active overlay + the set of visible interactive
 * component classes. Values and list sizes are ignored, so a ticking price or a
 * longer list is the same state; a newly opened menu or tab panel is not.
 */
export function stateKey(s: Snapshot): string {
  const overlay = activeOverlay(s);
  // Visible named content counts too: a hover card or expanded answer adds text, not always controls.
  const classes = new Set(s.controls.filter(c => c.visible && (c.actions.length || c.name)).map(controlClass));
  // Status messages (empty results, errors, alerts) are states even when they add no controls.
  // Live regions say so by structure, in any language; page lines worded like a status in English
  // or Chinese are taken too, for pages that show them without a live region.
  const worded = (s.text || '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(
      line =>
        /^(no |nothing|not found|没有|暂无|无结果|未找到)|result|empty|error|failed|错误|失败/i.test(line) &&
        line.length <= 80,
    );
  const status = [...(s.status || []), ...worded].map(line => maskVolatile(line)).sort();
  return JSON.stringify([
    pagePath(s.url),
    overlay ? `${overlay.kind}:${maskVolatile(overlay.name)}` : '',
    [...classes].sort(),
    [...new Set(status)],
  ]);
}

/** Names of mode controls under each parent, for keying mode groups within one snapshot. */
export function modeSiblings(s: Snapshot): (parentInstanceId: string) => string[] {
  const byParent = new Map<string, string[]>();
  for (const c of s.controls) {
    const parent = c.domAncestry?.instanceIds[0];
    if (!parent || !c.visible) continue;
    const list = byParent.get(parent) || [];
    list.push(`${c.role}:${c.name}`);
    byParent.set(parent, list);
  }
  return parent => (byParent.get(parent) || []).slice(0, 12);
}
