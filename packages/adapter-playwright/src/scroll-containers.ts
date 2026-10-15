import { z } from 'zod';
import type { Overlay, ScrollContainer } from './types.js';
import { scrollProbeSchema } from './scroll-probe.js';

export const traversalScrollSchema = scrollProbeSchema.extend({
  width: z.number().positive(), height: z.number().positive(),
  maxLeft: z.number().nonnegative(), maxTop: z.number().nonnegative(),
}).strict();

/** Read-only, serialized collector. Includes only visibly reachable scroll surfaces. */
export function collectScrollContainers(overlays: Overlay[]) {
  const tracker = (window as any).__interactionEvidenceTracker;
  const instance = (el: Element): string => {
    if (!tracker.ids.has(el)) tracker.ids.set(el, `${tracker.documentId}:${++tracker.counter}`);
    return tracker.ids.get(el);
  };
  const selector = (el: Element): string => {
    if (el === document.documentElement) return 'html';
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) {
      let n = 1; for (let s = p.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === p.tagName) n++;
      parts.unshift(`${p.tagName.toLowerCase()}:nth-of-type(${n})`);
    }
    return `html > ${parts.join(' > ')}`;
  };
  const all = [...document.querySelectorAll('*')];
  const containers: ScrollContainer[] = [];
  let unsupported = false;
  for (const el of all.slice(0, 5000)) {
    const style = getComputedStyle(el); const root = el === document.scrollingElement;
    if (style.display === 'none' || style.visibility !== 'visible' || el.closest('[hidden],[inert]')) continue;
    const body = root && document.body ? getComputedStyle(document.body) : undefined;
    const overflowX = root && style.overflowX === 'visible' ? body?.overflowX ?? 'visible' : style.overflowX;
    const overflowY = root && style.overflowY === 'visible' ? body?.overflowY ?? 'visible' : style.overflowY;
    const x = root ? !['hidden', 'clip'].includes(overflowX) : ['auto', 'scroll'].includes(overflowX);
    const y = root ? !['hidden', 'clip'].includes(overflowY) : ['auto', 'scroll'].includes(overflowY);
    const maxLeft = x ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;
    const maxTop = y ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
    if ((!maxLeft && !maxTop) || !el.clientWidth || !el.clientHeight) continue;
    if (style.writingMode !== 'horizontal-tb' || style.direction !== 'ltr') { unsupported = true; continue; }
    const r = el.getBoundingClientRect();
    let left = root ? 0 : Math.max(0, r.left), top = root ? 0 : Math.max(0, r.top);
    let right = root ? innerWidth : Math.min(innerWidth, r.right), bottom = root ? innerHeight : Math.min(innerHeight, r.bottom);
    for (let p = el.parentElement; p && !root; p = p.parentElement) {
      const s = getComputedStyle(p), b = p.getBoundingClientRect();
      if (['auto', 'scroll', 'hidden', 'clip'].includes(s.overflowX)) { left = Math.max(left, b.left); right = Math.min(right, b.right); }
      if (['auto', 'scroll', 'hidden', 'clip'].includes(s.overflowY)) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
    }
    if (right <= left || bottom <= top) continue;
    const reachable = [[.5, .5], [.1, .1], [.9, .1], [.1, .9], [.9, .9]].some(([x, y]) => {
      const hit = document.elementFromPoint(left + (right - left) * x, top + (bottom - top) * y);
      return hit && el.contains(hit);
    });
    if (!reachable) continue;
    const boundary = [...overlays].reverse().find(o => document.querySelector(o.selector)?.contains(el));
    containers.push({ nodeId: instance(el), selector: selector(el), name: root ? 'page' : (el.getAttribute('aria-label') || el.id || 'container').slice(0, 100),
      root, boundaryKey: boundary?.key, left: el.scrollLeft, top: el.scrollTop,
      maxLeft, maxTop, width: el.clientWidth, height: el.clientHeight });
    if (containers.length === 128) break;
  }
  return { containers, truncated: all.length > 5000 || containers.length === 128, unsupported };
}

/** Guard and perform the one selected container action, without moving the pointer. */
export function traversalScrollInPage(container: Element, input: { options: z.infer<typeof traversalScrollSchema>; boundarySelector?: string; perform: boolean }) {
  const tracker = (window as any).__interactionEvidenceTracker, o = input.options;
  if (!tracker || tracker.documentId !== o.documentId || tracker.ids.get(container) !== o.containerNodeId || !container.isConnected) throw new Error('SCROLL_CONTAINER_REPLACED');
  if (input.boundarySelector) {
    const roots = document.querySelectorAll(input.boundarySelector);
    if (roots.length !== 1 || !roots[0].contains(container)) throw new Error('SCROLL_OUTSIDE_BOUNDARY');
  }
  const s = getComputedStyle(container), root = container === document.scrollingElement;
  const body = root && document.body ? getComputedStyle(document.body) : undefined;
  const ox = root && s.overflowX === 'visible' ? body?.overflowX ?? 'visible' : s.overflowX;
  const oy = root && s.overflowY === 'visible' ? body?.overflowY ?? 'visible' : s.overflowY;
  const x = root ? !['hidden', 'clip'].includes(ox) : ['auto', 'scroll'].includes(ox);
  const y = root ? !['hidden', 'clip'].includes(oy) : ['auto', 'scroll'].includes(oy);
  if (s.writingMode !== 'horizontal-tb' || s.direction !== 'ltr') throw new Error('SCROLL_WRITING_MODE_CHANGED');
  if (Math.abs(container.scrollLeft - o.expectedLeft) > .5 || Math.abs(container.scrollTop - o.expectedTop) > .5) throw new Error('SCROLL_POSITION_CHANGED');
  if (container.clientWidth !== o.width || container.clientHeight !== o.height ||
    (x ? Math.max(0, container.scrollWidth - container.clientWidth) : 0) !== o.maxLeft ||
    (y ? Math.max(0, container.scrollHeight - container.clientHeight) : 0) !== o.maxTop) throw new Error('SCROLL_RANGE_CHANGED');
  if ((!x && o.left !== container.scrollLeft) || (!y && o.top !== container.scrollTop) ||
    (x && (o.left < 0 || o.left > o.maxLeft)) || (y && (o.top < 0 || o.top > o.maxTop))) throw new Error('SCROLL_DESTINATION_INVALID');
  if (input.perform) container.scrollTo({ left: o.left, top: o.top, behavior: 'instant' });
}
