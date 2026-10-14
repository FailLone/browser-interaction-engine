import type { BrowserFrontierCoverageGroup, FrontierItemView, FrontierStateFact, FrontierStateSummary, Json } from '@interaction/browser';

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalized(value)]));
  return value;
}
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
export const sampleText = (value: Json | undefined) => value === undefined ? '未提供' : JSON.stringify(value);
export function factText(value: Json | undefined, field?: string): string {
  if (value === undefined) return '未出现';
  if (value === '') return '空';
  if (typeof value === 'boolean') return field === 'checked' ? value ? '选中' : '未选中' : value ? '是' : '否';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
export interface StateDifference { key: string; label: string; field?: string; before?: Json; after?: Json }
export function stateDifferences(before?: FrontierStateSummary, after?: FrontierStateSummary): StateDifference[] {
  if (before?.status !== 'available' || after?.status !== 'available') return [];
  const left = new Map(before.facts.map(f => [f.key, f])); const right = new Map(after.facts.map(f => [f.key, f]));
  const leftControls = new Set(before.facts.map(f => f.controlId)); const rightControls = new Set(after.facts.map(f => f.controlId));
  const missingControls = new Set<string>(); const differences: StateDifference[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key); const b = right.get(key); const fact = (b || a)!;
    if (sameValue(a?.value, b?.value)) continue;
    // One readable appearance/disappearance, instead of one row per missing property.
    if (fact.controlId && (!leftControls.has(fact.controlId) || !rightControls.has(fact.controlId))) {
      if (missingControls.has(fact.controlId)) continue;
      missingControls.add(fact.controlId);
    }
    differences.push({ key, label: fact.label, field: fact.field, before: a?.value, after: b?.value });
  }
  return differences;
}
export function referenceFor(group: BrowserFrontierCoverageGroup, item: FrontierItemView, selected: string) {
  const executed = group.items.filter(f => f.status === 'executed');
  if (selected !== 'auto') return executed.find(f => f.id === selected);
  const sameSample = executed.filter(f => sameValue(f.action.value, item.action.value));
  const state = group.states.find(s => s.stateId === item.stateId);
  return (sameSample.length ? sameSample : executed).slice().sort((a, b) => {
    const score = (f: FrontierItemView) => {
      if (f.stateId === item.stateId) return 0;
      const other = group.states.find(s => s.stateId === f.stateId);
      return state?.status === 'available' && other?.status === 'available' ? stateDifferences(other, state).length + 1 : Infinity;
    };
    return score(a) - score(b);
  })[0];
}
/** Long text differences retain the changed section instead of clipping it off the end. */
export function differenceText(value: Json | undefined, other: Json | undefined, field?: string) {
  const text = factText(value, field); const comparison = factText(other, field);
  if (text.length <= 100) return text;
  let prefix = 0;
  while (prefix < text.length && prefix < comparison.length && text[prefix] === comparison[prefix]) prefix++;
  const start = Math.max(0, Math.min(prefix - 24, text.length - 80));
  return `${start ? '…' : ''}${text.slice(start, start + 100)}${start + 100 < text.length ? '…' : ''}`;
}
export function summaryFacts(state?: FrontierStateSummary): FrontierStateFact[] {
  return state?.facts.filter(f => f.primary) || [];
}
