import type { Control } from './browser/types.js';
import { pagePath } from './abstraction.js';

export type CrawlKind = 'click' | 'hover' | 'check' | 'press' | 'fill';

export interface CrawlPolicy {
  /** Same-origin pathname patterns the crawler may navigate to. Entry path is always allowed. */
  allowedPaths: RegExp[];
}

export function defaultPolicy(entry: string): CrawlPolicy {
  return {
    allowedPaths: [new RegExp(`^${escapeRegExp(new URL(entry).pathname.replace(/\/+$/, ''))}/?$`)],
  };
}
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a click would navigate, if the control is a link. */
export function linkTarget(c: Control, base: string): string | undefined {
  const href = c.reviewBinding?.attributes.href ?? c.purposeBinding?.attributes.href;
  if (c.tag !== 'a' || !href || /^(javascript:|#)/i.test(href)) return;
  try {
    return new URL(href, base).href;
  } catch {
    return;
  }
}

export type Placement = 'stay' | 'navigate' | 'outside';

/** Classify a link by destination: same page (stay), allowed page (navigate), or out of scope. */
export function placement(c: Control, current: string, entry: string, policy: CrawlPolicy): Placement {
  const target = linkTarget(c, current);
  if (!target) return 'stay';
  const t = new URL(target),
    e = new URL(entry);
  if (
    pagePath(target) === pagePath(current) &&
    t.pathname.replace(/\/+$/, '') === new URL(current).pathname.replace(/\/+$/, '')
  )
    return 'stay';
  if (t.origin !== e.origin || c.reviewBinding?.attributes.target === '_blank') return 'outside';
  // The same page in another language is another page: it re-renders everything.
  if (
    pagePath(target) === pagePath(entry) &&
    t.pathname.replace(/\/+$/, '') === new URL(current).pathname.replace(/\/+$/, '')
  )
    return 'stay';
  return policy.allowedPaths.some(p => p.test(t.pathname)) ? 'navigate' : 'outside';
}

/** Every rule that keeps the crawler from acting on a control, as shown to people reviewing a run. */
export const SAFETY_RULES = [
  {
    id: 'form-submit',
    title: '不提交表单',
    detail:
      '表单里的提交按钮不点击：没有 type 或 type=submit 的 <button>，以及 <input type=submit> / <input type=image>。用 div 等自定义元素做的提交按钮目前识别不了。',
  },
  {
    id: 'leave-page',
    title: '不离开当前页',
    detail:
      '指向其他页面的链接不点击，只记录目标地址；点击中触发的跳转会被拦截，页面保持原状。目标规划允许访问的页面除外。',
  },
  {
    id: 'outside-site',
    title: '不打开站外和新窗口',
    detail: '其他域名的链接、target=_blank 和弹出窗口一律拦截，只记录地址。',
  },
  {
    id: 'goal-area',
    title: '目标范围外的区域不操作',
    detail: '目标模式下，目标没有涉及的页头、导航、页脚里的控件不操作。',
  },
  {
    id: 'not-actionable',
    title: '用户操作不了的控件不操作',
    detail: '不可见、禁用、或被其他元素遮挡的控件不操作；打开弹窗时只操作弹窗内的控件。',
  },
] as const;
export type SafetyRule = (typeof SAFETY_RULES)[number]['id'];

/**
 * Single-layer safety check, by structure rather than wording (labels are in any language):
 * a native form is never submitted. Leaving the page is handled by navigation interception.
 */
export function allowed(c: Control, kind: CrawlKind): boolean {
  if (!c.visible || !c.enabled) return false;
  if (submitsForm(c)) return false;
  if (kind === 'check') return c.role === 'checkbox' || c.role === 'switch' || c.role === 'radio';
  return true;
}

/** A native submit control of a form: <button> (submit by default), <input type=submit|image>. */
export function submitsForm(c: Control): boolean {
  if (!c.formOwner) return false;
  // A <button> without a valid type attribute is a submit button.
  if (c.tag === 'button') return !/^(button|reset)$/i.test((c.reviewBinding?.attributes.type ?? '').trim());
  return c.tag === 'input' && /^(submit|image)$/.test(c.constraints.type);
}
