import type { Control } from '@interaction/adapter-playwright';
import { pagePath } from './abstraction.js';

export type CrawlKind = 'click' | 'hover' | 'check' | 'press' | 'fill';

export interface CrawlPolicy {
  /** Same-origin pathname patterns the crawler may navigate to. Entry path is always allowed. */
  allowedPaths: RegExp[];
  /** Labels never dispatched: authentication, trading, submission, identity claims. */
  forbiddenLabel: RegExp;
}

export const defaultForbiddenLabel = /登录|注册|登陆|购买|卖出|买入|下单|确认|提交|充值|提现|身份认证|居住|地区|国家|下载|log\s*in|sign\s*(in|up)|register|buy|sell|place order|confirm|submit|deposit|withdraw|verify|country|residen|download|install/i;

export function defaultPolicy(entry: string): CrawlPolicy {
  return { allowedPaths: [new RegExp(`^${escape(new URL(entry).pathname.replace(/\/+$/, ''))}/?$`)], forbiddenLabel: defaultForbiddenLabel };
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a click would navigate, if the control is a link. */
export function linkTarget(c: Control, base: string): string | undefined {
  const href = c.reviewBinding?.attributes.href ?? c.purposeBinding?.attributes.href;
  if (c.tag !== 'a' || !href || /^(javascript:|#)/i.test(href)) return;
  try { return new URL(href, base).href; } catch { return; }
}

export type Placement = 'stay' | 'navigate' | 'outside';

/** Classify a link by destination: same page (stay), allowed page (navigate), or out of scope. */
export function placement(c: Control, current: string, entry: string, policy: CrawlPolicy): Placement {
  const target = linkTarget(c, current);
  if (!target) return 'stay';
  const t = new URL(target), e = new URL(entry);
  if (pagePath(target) === pagePath(current)) return 'stay';
  if (t.origin !== e.origin || c.reviewBinding?.attributes.target === '_blank') return 'outside';
  // Switching site language re-renders everything already covered; not new UI.
  if (pagePath(target) === pagePath(entry)) return 'stay';
  return policy.allowedPaths.some(p => p.test(t.pathname)) ? 'navigate' : 'outside';
}

/** Single-layer safety check; anything else is fair game for a crawler. */
export function allowed(c: Control, kind: CrawlKind, policy: CrawlPolicy): boolean {
  if (!c.visible || !c.enabled) return false;
  if (policy.forbiddenLabel.test(`${c.name} ${c.label}`)) return false;
  if (c.formOwner && c.tag === 'button' && /submit|^$/.test(c.constraints.type)) return false;
  if (kind === 'check') return c.role === 'checkbox' || c.role === 'switch' || c.role === 'radio';
  return true;
}
