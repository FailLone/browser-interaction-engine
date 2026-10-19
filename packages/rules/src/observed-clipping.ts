import { z } from 'zod';
import type { Json } from './types.js';
import { ObservedControlTracker } from './observed-control.js';
import { clippedControlOptionsSchema, clippedControlRule } from './clipped-control.js';

export const observedClippingOptionsSchema = z
  .object({
    rule: clippedControlOptionsSchema.prefault({}),
    maxTracked: z.number().int().min(1).max(1000).default(500),
  })
  .strict();
export type ObservedClippingOptions = z.input<typeof observedClippingOptionsSchema>;
export const observedClippingRule = {
  id: 'observed-clipping',
  version: '1.0.0',
  name: 'Clipping across exploration observations',
  effects: 'read-history' as const,
  description:
    'Track clipping evidence for the same control and scope without performing or waiting for scrolling. Missing or changed bindings never resolve an issue.',
  optionsSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(observedClippingOptionsSchema)),
};
/** Feed one session's saved inspections in sequence. No browser operations exist here. */
export class ClippedControlTracker extends ObservedControlTracker {
  constructor(input: ObservedClippingOptions = {}) {
    const options = observedClippingOptionsSchema.parse(input);
    super({
      rule: clippedControlRule,
      maxTracked: options.maxTracked,
      selection: { ruleId: clippedControlRule.id, ruleVersion: clippedControlRule.version, options: options.rule },
      report: { ...observedClippingRule, options: JSON.parse(JSON.stringify(options)) as Record<string, Json> },
      codes: {
        measurable: [
          'CONTROL_BOX_UNCLIPPED',
          'SCROLL_CLIP_RECHECK_PENDING',
          'CONTROL_CLIPPING_SUSPECTED',
          'CONTROL_UNREACHABLE_BY_SCROLLING',
          'CLIPPING_REQUIREMENT_FAILED',
        ],

        pending: ['SCROLL_CLIP_RECHECK_PENDING'],
        unavailable: 'CLIPPING_RECHECK_UNAVAILABLE',
        baseline: 'CLIPPING_BASELINE_CHANGED',
        resolved: 'CLIPPING_NO_LONGER_OBSERVED',
        unobserved: 'CLIPPING_TARGET_UNOBSERVED',
      },
    });
  }
}
