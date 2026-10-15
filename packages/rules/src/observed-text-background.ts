import { z } from 'zod';
import type { Json } from '@interaction/adapter-playwright';
import { ObservedControlTracker } from './observed-control.js';
import { textBackgroundOptionsSchema, textBackgroundRule } from './text-background.js';

export const observedTextBackgroundOptionsSchema = z.object({
  rule: textBackgroundOptionsSchema.prefault({}), maxTracked: z.number().int().min(1).max(1000).default(500),
}).strict();
export type ObservedTextBackgroundOptions = z.input<typeof observedTextBackgroundOptionsSchema>;
export const observedTextBackgroundRule = {
  id: 'observed-text-background', version: '1.0.0', name: 'Label colors across exploration captures', effects: 'read-history' as const,
  description: 'Recheck the same control and label text using saved solid-color evidence. Never changes the page or supplies a design requirement.',
};
export class TextBackgroundTracker extends ObservedControlTracker {
  constructor(input: ObservedTextBackgroundOptions = {}) {
    const options = observedTextBackgroundOptionsSchema.parse(input);
    super({ rule: textBackgroundRule, maxTracked: options.maxTracked,
      selection: { ruleId: textBackgroundRule.id, ruleVersion: textBackgroundRule.version, options: options.rule },
      report: { ...observedTextBackgroundRule, options: JSON.parse(JSON.stringify(options)) as Record<string, Json> },
      codes: { measurable: ['TEXT_BACKGROUND_MATCH', 'TEXT_BACKGROUND_REQUIREMENT_FAILED', 'TEXT_BACKGROUND_DISTINCT'],
        unavailable: 'TEXT_BACKGROUND_RECHECK_UNAVAILABLE', baseline: 'TEXT_BACKGROUND_BASELINE_CHANGED',
        resolved: 'TEXT_BACKGROUND_RESTORED', unobserved: 'TEXT_BACKGROUND_TARGET_UNOBSERVED' },
      binding: (_control, _dom, check) => [check.facts?.textRootIds, check.facts?.labelBinding],
    });
  }
}
