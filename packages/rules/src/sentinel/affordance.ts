import { z } from 'zod';
import { defineSentinelRule, exempt, pass, review, unknown } from './core.js';

export const affordanceEvidenceSchema = z
  .object({
    actual: z.enum(['enabled', 'disabled', 'static', 'selected', 'scrollable', 'unknown']),
    perceived: z.enum(['enabled', 'disabled', 'static', 'selected', 'scrollable', 'unknown']),
    alternativeCue: z.boolean(),
    intentionalStaticLabel: z.boolean(),
  })
  .strict();
export const affordanceRule = defineSentinelRule(
  {
    id: 'UIK-R009',
    name: '交互状态暗示审查',
    kind: 'review',
    description: '对照可信可用性事实与观察到的视觉暗示，允许静态标签和清楚的替代线索。',
  },
  affordanceEvidenceSchema,
  (_c, d) => {
    if (d.intentionalStaticLabel && d.actual === 'static' && d.perceived === 'static')
      return exempt('The bound object is an intentionally static informational label');
    if (d.actual === 'unknown' || d.perceived === 'unknown')
      return unknown('Both actual availability and perceived state must be observed');
    if (d.actual === d.perceived || d.alternativeCue)
      return pass('The observed appearance or an explicit alternative communicates the bound state');
    return review('Observed visual affordance differs from the established interaction state', {
      actual: d.actual,
      perceived: d.perceived,
    });
  },
);
