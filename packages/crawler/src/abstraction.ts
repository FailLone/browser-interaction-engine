import type { Control, Overlay, Region } from '@interaction/adapter-playwright';

/** Minimal capture the crawler needs; produced by the adapter's DOM collector. */
export interface Snapshot {
  url: string; title: string; text?: string; controls: Control[]; overlays?: Overlay[]; regions?: Region[];
}

/** Live values (prices, times, percentages, counts) never make a new state or component. */
export function maskVolatile(text: string, max = 80): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[-+]?[\d₀-₉][\d₀-₉.,:%/]*/g, '#').slice(0, max);
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
export const modeRoles = new Set(['tab', 'radio', 'menuitemradio', 'option', 'switch']);

/**
 * The mode group a selector belongs to (its tablist/radiogroup/row), independent
 * of document instance IDs: same page path, role and parent selector.
 */
export function modeGroup(c: Control, url: string, siblings?: (parentInstanceId: string) => string[]): string | undefined {
  // Segmented controls are often plain buttons in a row: short, label-only names
  // ("1h", "24h", "1W") sharing a parent behave as one mode group.
  const segmented = c.role === 'button' && !c.landmark && /^[\w.%+-]{1,4}$/.test((c.name || '').trim());
  if (!modeRoles.has(c.role) && !segmented) return;
  // The parent element groups the row. Its instance ID changes with every document,
  // so the group is keyed by the parent's member names, which are stable across reloads.
  const parent = c.domAncestry?.instanceIds[0];
  const owner = parent && siblings ? siblings(parent).join('|') : c.selector.replace(/\s*>\s*[^>]+$/, '');
  return `${pagePath(url)}|${segmented ? 'segment' : c.role}|${owner}`;
}

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
  // Status messages (empty results, errors, alerts) are states even when they add no controls.
  const status = (s.text || '').split(/\n+/).map(line => line.trim()).filter(line => /^(no |nothing|not found|没有|暂无|无结果|未找到)|result|empty|error|failed|错误|失败/i.test(line) && line.length <= 80).map(line => maskVolatile(line)).sort();
  return JSON.stringify([pagePath(s.url), overlay ? `${overlay.kind}:${maskVolatile(overlay.name)}` : '', [...classes].sort(), [...new Set(status)]]);
}

/** Names of mode controls under each parent, for keying mode groups within one snapshot. */
export function modeSiblings(s: Snapshot): (parentInstanceId: string) => string[] {
  const byParent = new Map<string, string[]>();
  for (const c of s.controls) {
    const parent = c.domAncestry?.instanceIds[0];
    if (!parent || !c.visible) continue;
    const list = byParent.get(parent) || []; list.push(`${c.role}:${c.name}`); byParent.set(parent, list);
  }
  return parent => (byParent.get(parent) || []).slice(0, 12);
}
