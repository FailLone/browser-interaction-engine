import { canonical } from '@interaction/core';
import type { Control, MatchRule, ActionCandidate } from './types.js';
export { canonical, hash, id, now, contextKey, timeout } from '@interaction/core';
export const signature = (c: Control) => canonical({ role: c.role, label: c.label || c.name, region: c.region, form: c.form, actions: c.actions, type: c.constraints.type });
export function ruleMatches(rule: MatchRule, a: ActionCandidate, c?: Control, url = '') {
  return (!rule.role || rule.role === c?.role) && (!rule.name || rule.name === c?.name) && (!rule.stableKey || rule.stableKey === c?.stableKey) && (!rule.kind || rule.kind === a.kind) && (!rule.urlIncludes || url.includes(rule.urlIncludes));
}
