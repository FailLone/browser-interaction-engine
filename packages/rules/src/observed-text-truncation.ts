import { z } from 'zod';
import type { Json } from './types.js';
import type { RuleCheck } from './types.js';
import { ObservedControlTracker } from './observed-control.js';
import { textTruncationOptionsSchema, textTruncationRule } from './text-truncation.js';

export const observedTextTruncationOptionsSchema = z
  .object({
    rule: textTruncationOptionsSchema.prefault({}),
    maxTracked: z.number().int().min(1).max(1000).default(500),
  })
  .strict();
export type ObservedTextTruncationOptions = z.input<typeof observedTextTruncationOptionsSchema>;
export const observedTextTruncationRule = {
  id: 'observed-text-truncation',
  version: '1.0.0',
  name: 'Label text across exploration observations',
  effects: 'read-history' as const,
  description:
    'Recheck the same control, DOM label and text using saved exploration captures. No scrolling, requirement providers or agent calls.',
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(observedTextTruncationOptionsSchema)),
};
const ids = (check: RuleCheck, key: string): string[] => {
  const value = check.facts?.[key];
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
};

/** One session per tracker. A text replacement establishes a new baseline; it
 * cannot prove that the preceding label became fully visible. */
export class TextTruncationTracker extends ObservedControlTracker {
  constructor(input: ObservedTextTruncationOptions = {}) {
    const options = observedTextTruncationOptionsSchema.parse(input);
    super({
      rule: textTruncationRule,
      maxTracked: options.maxTracked,
      selection: { ruleId: textTruncationRule.id, ruleVersion: textTruncationRule.version, options: options.rule },
      report: { ...observedTextTruncationRule, options: JSON.parse(JSON.stringify(options)) as Record<string, Json> },
      codes: {
        measurable: [
          'DOM_TEXT_BOXES_FIT',
          'TEXT_HARD_CLIP_SUSPECTED',
          'TEXT_SCROLL_RECHECK_PENDING',
          'TEXT_ELISION_OBSERVED',
        ],
        unavailable: 'TEXT_RECHECK_UNAVAILABLE',
        baseline: 'TEXT_BASELINE_CHANGED',
        resolved: 'TEXT_CLIPPING_NO_LONGER_OBSERVED',
        unobserved: 'TEXT_TARGET_UNOBSERVED',
      },
      relatedNodeIds: (check, dom) => {
        const nodes = new Map(dom.nodes.map(n => [n.id, n]));
        return [
          ...ids(check, 'textRootIds'),
          ...ids(check, 'textNodeIds').flatMap(id => {
            const parent = nodes.get(id)?.parentId;
            return parent ? [parent] : [];
          }),
        ];
      },
      binding: (_control, dom, check) => {
        const nodes = new Map(dom.nodes.map(n => [n.id, n]));
        return [
          ids(check, 'textRootIds'),
          ids(check, 'textNodeIds').map(id => {
            const n = nodes.get(id);
            return [id, n?.parentId, n?.text];
          }),
        ];
      },
    });
  }
}
