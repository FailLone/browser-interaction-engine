import type { BoundaryExitCandidate } from './boundary-exit.js';
import type { Overlay } from './types.js';

/** Geometry suggestions only. No inferred dismissal permission and no DOM mutation. */
export function collectBoundaryExits(overlays: Overlay[], instance: (el: Element) => string, selector: (el: Element) => string): BoundaryExitCandidate[] {
  const active = overlays.at(-1);
  if (!active) return [];
  const panel = document.querySelector(active.selector), parent = overlays.length > 1 ? document.querySelector(overlays.at(-2)!.selector) : undefined;
  if (!panel) return [];
  const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const bounds = rect(panel), result: BoundaryExitCandidate[] = [];
  const boundaryStack = overlays.map(o => { const el = document.querySelector(o.selector); return {
    key: o.key, kind: o.kind, parentKey: o.parentKey, parentRegion: o.parentRegion, instanceId: el ? instance(el) : undefined,
    controlIds: o.controlIds, exitControlIds: o.exitControlIds,
  }; });
  const points = [
    [bounds.x - 16, bounds.y + bounds.height / 2], [bounds.x + bounds.width + 16, bounds.y + bounds.height / 2],
    [bounds.x + bounds.width / 2, bounds.y - 16], [bounds.x + bounds.width / 2, bounds.y + bounds.height + 16],
    ...[0.2, 0.5, 0.8].flatMap(x => [0.2, 0.5, 0.8].map(y => [innerWidth * x, innerHeight * y])),
  ];
  const interactive = 'a[href],button,input,textarea,select,summary,iframe,video,audio,canvas,[contenteditable]:not([contenteditable=false]),[role=button],[role=link],[role=option],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=combobox],[aria-expanded],[aria-haspopup],[onclick],[tabindex]';
  for (const [rawX, rawY] of points) {
    const x = Math.round(rawX), y = Math.round(rawY);
    if (x < 2 || y < 2 || x >= innerWidth - 2 || y >= innerHeight - 2 || x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height) continue;
    const el = document.elementFromPoint(x, y);
    if (!el || panel.contains(el) || el.closest(interactive) || el.closest('[inert]') || parent && !parent.contains(el)) continue;
    const r = rect(el), style = getComputedStyle(el);
    if (!r.width || !r.height || style.visibility !== 'visible' || style.cursor === 'pointer') continue;
    const attributes = Object.fromEntries([...el.attributes].filter(a => /^(id|class|role|aria-|data-|on)/.test(a.name)).map(a => [a.name, a.value]));
    // Explicit handlers are not passive outside targets. Delegated handlers remain unknown to the caller.
    if (el.hasAttribute('onclick') || typeof (el as HTMLElement).onclick === 'function') continue;
    const id = `${instance(el)}:outside:${x}:${y}`;
    if (result.some(c => c.id === id)) continue;
    result.push({ id, kind: 'outside-click', boundaryKey: active.key, boundaryInstanceId: instance(panel), selector: selector(el),
      instanceId: instance(el), parentInstanceId: el.parentElement ? instance(el.parentElement) : '', tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160), attributes, rect: r, point: { x, y },
      viewport: { width: innerWidth, height: innerHeight }, boundaryRect: bounds,
      scroll: { x: scrollX, y: scrollY }, boundaryStack,
      ...(parent ? { parentBoundaryInstanceId: instance(parent) } : {}),
      evidence: ['Visible hit-tested point outside the current panel', 'No observed interactive target at the point', 'Delegated event effects are unknown; caller review is required'] });
    if (result.length >= 8) break;
  }
  return result;
}
