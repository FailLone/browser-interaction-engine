import type { FrontierCoverageGroup, Json } from '@interaction/core';
import type { Observation } from '@interaction/adapter-playwright';

export interface FrontierStateFact {
  key: string; label: string; field: string; value: Json; controlId?: string;
  /** Useful in the default summary; all other facts remain available for comparison. */
  primary: boolean;
}
export interface FrontierStateSummary {
  stateId: string; observationId: string; status: 'available' | 'unavailable';
  /** Response-local representative observation, verified by complete canonical
   * equality. Presentation evidence only; never a graph or execution grant. */
  strictObservationKey?: string;
  capturedAt?: string; facts: FrontierStateFact[];
}
export interface BrowserFrontierCoverageGroup extends FrontierCoverageGroup { states: FrontierStateSummary[] }

/** Project recorded observations only. Never substitute the live interface for missing history. */
export function withFrontierStates(groups: FrontierCoverageGroup[], read: (id: string) => Observation | undefined): BrowserFrontierCoverageGroup[] {
  const states = new Map<string, FrontierStateSummary>();
  const equivalentObservations = new Map<string, string>();
  return groups.map(group => ({ ...group, states: [...new Map(group.items.map(item => [JSON.stringify([item.sessionId, item.stateId, item.action.observationId]), item])).entries()].map(([key, item]) => {
    let state = states.get(key);
    if (state) return state;
    // Graph groups can contain different historical values. Facts and links
    // belong to the operation's actual source observation, never its group.
    const stateId = item.stateId, observationId = item.action.observationId;
    const o = read(observationId);
    state = { stateId, observationId, status: 'unavailable', facts: [] };
    if (o?.id === observationId && o.stateId === stateId && o.sessionId === item.sessionId) {
      state.status = 'available'; state.capturedAt = o.capturedAt;
      if (!o.gaps.some(g => g.critical)) {
        const strictKey = JSON.stringify([o.sessionId, o.ruleVersion, o.canonical]);
        if (!equivalentObservations.has(strictKey)) equivalentObservations.set(strictKey, o.id);
        state.strictObservationKey = equivalentObservations.get(strictKey)!;
      }
      const add = (key: string, label: string, field: string, value: Json, primary = false, controlId?: string) => state!.facts.push({ key, label, field, value, primary, controlId });
      add('url', '页面地址', 'url', o.url);
      add('scroll', '滚动位置', 'scroll', o.scroll);
      add('boundaries', '打开的弹层', 'boundaries', (o.boundaries || []).map(b => b.name), !!o.boundaries?.length);
      for (const c of o.controls) {
        const key = c.identityId || c.stableKey || c.localId;
        const name = c.label || (c.name.length <= 80 ? c.name : c.role === 'generic' ? '页面内容' : c.stableKey || c.role) || '未命名控件';
        const addControl = (field: string, suffix: string, value: Json, primary = false) => add(`${key}:${field}`, `${name}${suffix}`, field, value, primary, c.identityId);
        if (c.actions.includes('fill') || c.actions.includes('select') || c.editable) addControl('value', '', c.value, c.visible);
        if (c.checked !== null) addControl('checked', '', c.checked, c.visible);
        if (c.displayedText && !['input', 'textarea', 'select'].includes(c.tag)) addControl('displayedText', '', c.displayedText, c.visible && c.displayedText.length <= 100 && c.expanded !== null && c.displayedText.trim() !== name.trim());
        addControl('visible', ' · 可见', c.visible);
        addControl('enabled', ' · 可用', c.enabled);
        addControl('editable', ' · 可编辑', c.editable);
        if (c.expanded !== null) addControl('expanded', ' · 展开', c.expanded);
        if (c.selected.length > 1 || c.selected.length && !c.actions.includes('select')) addControl('selected', ' · 已选择', c.selected);
        for (const [field, value] of Object.entries(c.constraints)) {
          const labels: Record<string, string> = { type: '类型', required: '必填', min: '最小值', max: '最大值', step: '步长', pattern: '格式', minLength: '最短长度', maxLength: '最长长度', valid: '校验通过' };
          if (value !== undefined) addControl(`constraints.${field}`, ` · ${labels[field] || field}`, value);
        }
      }
    }
    states.set(key, state); return state;
  }) }));
}
