import { z } from 'zod';
import { asJson, defineSentinelRule, exempt, pass, review, unknown } from './core.js';

export const scrollCueEvidenceSchema = z
  .object({
    purpose: z.enum(['scroll-cue', 'decoration', 'unknown']),
    orderKnown: z.boolean(),
    positionsComplete: z.boolean(),
    samples: z
      .array(
        z
          .object({
            /** Logical start-to-end coordinates normalized by the host, also for RTL and reverse order. */
            position: z.number().nonnegative(),
            maximum: z.number().nonnegative(),
            cues: z.array(z.enum(['start', 'end'])).max(2),
            obscuresRequiredContent: z.boolean(),
            evidence: z.string().min(1),
          })
          .strict(),
      )
      .min(2)
      .max(100),
  })
  .strict();
export const scrollCueRule = defineSentinelRule(
  {
    id: 'UIK-R011',
    name: '滚动边缘提示审查',
    kind: 'review',
    description: '按真实阅读顺序和可达范围审查已有边缘提示，不规定渐隐固定出现在顶部或底部。',
  },
  scrollCueEvidenceSchema,
  (_c, d) => {
    if (d.purpose === 'decoration') return exempt('The gradient is decorative and does not imply additional content');
    if (d.purpose === 'unknown' || !d.orderKnown || !d.positionsComplete || d.samples.some(s => s.position > s.maximum))
      return unknown('The cue intent, reading direction and complete normalized scroll observations are required');
    if (!d.samples.some(s => s.cues.length)) return exempt('There is no edge cue to review; a fade is not mandatory');
    const misleading = d.samples.filter(
      s =>
        s.obscuresRequiredContent ||
        (s.cues.includes('start') && s.position <= 1) ||
        (s.cues.includes('end') && s.maximum - s.position <= 1),
    );
    const facts = { samples: asJson(d.samples) };
    return misleading.length
      ? review('An observed edge cue suggests unavailable content or obscures required reading', facts)
      : pass('The recorded cues point toward available content and preserve required reading', facts);
  },
);
