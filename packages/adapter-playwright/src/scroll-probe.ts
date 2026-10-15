import { z } from 'zod';

const coordinate = z.number().finite().min(-100000000).max(100000000);
export const scrollProbeSchema = z.object({
  documentId: z.string().min(1), containerNodeId: z.string().min(1),
  left: coordinate, top: coordinate,
  expectedLeft: coordinate, expectedTop: coordinate,
}).strict();
export type ScrollProbeOptions = z.infer<typeof scrollProbeSchema>;

/** Executed in the page. Only a bound target's scroll ancestor may be changed. */
export function scrollProbeInPage(target: Element, input: { options: ScrollProbeOptions; instanceId: string; boundarySelector?: string; perform: boolean }) {
  const tracker = (window as any).__interactionEvidenceTracker;
  const o = input.options;
  if (!tracker || tracker.documentId !== o.documentId || tracker.ids.get(target) !== input.instanceId || !target.isConnected) throw new Error('SCROLL_PROBE_STALE_TARGET');
  let container: Element | null = target.parentElement;
  while (container && tracker.ids.get(container) !== o.containerNodeId) container = container.parentElement;
  if (!container) throw new Error('SCROLL_PROBE_NOT_ANCESTOR');
  if (input.boundarySelector) {
    const roots = document.querySelectorAll(input.boundarySelector);
    if (roots.length !== 1 || !roots[0].contains(container)) throw new Error('SCROLL_PROBE_OUTSIDE_BOUNDARY');
  }
  const style = getComputedStyle(container);
  if (style.writingMode !== 'horizontal-tb' || style.direction !== 'ltr') throw new Error('SCROLL_PROBE_UNSUPPORTED_WRITING_MODE');
  const root = container === document.scrollingElement;
  const body = document.body ? getComputedStyle(document.body) : undefined;
  const overflowX = root && style.overflowX === 'visible' ? body?.overflowX ?? 'visible' : style.overflowX;
  const overflowY = root && style.overflowY === 'visible' ? body?.overflowY ?? 'visible' : style.overflowY;
  const xAllowed = root ? !['hidden', 'clip'].includes(overflowX) : ['auto', 'scroll'].includes(overflowX);
  const yAllowed = root ? !['hidden', 'clip'].includes(overflowY) : ['auto', 'scroll'].includes(overflowY);
  if (Math.abs(container.scrollLeft - o.expectedLeft) > 0.5 || Math.abs(container.scrollTop - o.expectedTop) > 0.5) throw new Error('SCROLL_PROBE_POSITION_CHANGED');
  if ((!xAllowed && Math.abs(o.left - container.scrollLeft) > 0.5) || (!yAllowed && Math.abs(o.top - container.scrollTop) > 0.5)) throw new Error('SCROLL_PROBE_AXIS_NOT_SCROLLABLE');
  if (o.left < 0 || o.top < 0 || o.left > Math.max(0, container.scrollWidth - container.clientWidth) + 0.5 || o.top > Math.max(0, container.scrollHeight - container.clientHeight) + 0.5) throw new Error('SCROLL_PROBE_POSITION_OUT_OF_RANGE');
  if (input.perform) container.scrollTo({ left: o.left, top: o.top, behavior: 'instant' });
}
