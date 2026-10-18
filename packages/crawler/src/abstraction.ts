import type { Control, Overlay, Region } from '@interaction/adapter-playwright';

/** Minimal capture the crawler needs; produced by the adapter's DOM collector. */
export interface Snapshot {
  url: string; title: string; text?: string; controls: Control[]; overlays?: Overlay[]; regions?: Region[];
}

/** Live values (prices, times, percentages, counts) never make a new state or component. */
export function maskVolatile(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[-+]?[\d₀-₉][\d₀-₉.,:%/]*/g, '#').slice(0, 80);
}

/** Region/script locale prefixes (/zh-hans/, /en-au/) are the same page in another language. */
const localePrefix = /^\/[a-z]{2}-(?:[a-z]{2}|hans|hant)(?=\/|$)/i;

export function pagePath(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname.replace(localePrefix, '').replace(/\/+$/, ''); } catch { return url; }
}

/**
 * Page template: the path with its last segment replaced, so /convert/usd-to-btc
 * and /convert/btc-to-pkr are the same template. The entry page stays itself.
 */
export function pageTemplate(url: string): string {
  try { const u = new URL(url), parts = u.pathname.replace(localePrefix, '').replace(/\/+$/, '').split('/'); if (parts.length > 2) parts[parts.length - 1] = '*'; return u.origin + parts.join('/'); }
  catch { return url; }
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
const modeRoles = new Set(['tab', 'radio', 'menuitemradio', 'option', 'switch']);

/** A list member's class: one entry per (list owner, template slot), not per row. */
function listClass(c: Control): string | undefined {
  if (modeRoles.has(c.role)) return;
  return c.structuralItem ? `list:${c.structuralItem.template}:${c.structuralItem.slot}` : c.list ? `list:${c.list.selector}:${c.role}` : undefined;
}

/** Component class, stable across live-value changes and list membership. */
export function controlClass(c: Control): string {
  const name = c.name || c.label || c.displayedText || '';
  // Mode labels are short and static ("1h", "24h", "1W"); masking digits would merge them.
  return listClass(c) || [c.landmark || '', c.role, c.tag, modeRoles.has(c.role) && name.length <= 24 ? name : maskVolatile(name)].join('|');
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
  return JSON.stringify([pagePath(s.url), overlay ? `${overlay.kind}:${maskVolatile(overlay.name)}` : '', [...classes].sort()]);
}
