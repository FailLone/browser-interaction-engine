import { z } from 'zod';
import { defineSentinelRule, exempt, pass, review, targetSchema, unknown } from './core.js';

export const feedbackEvidenceSchema = z
  .object({
    activated: z.boolean(),
    actualState: z.enum(['loading', 'empty', 'disabled', 'ready', 'unknown']),
    stateEvidence: z.string().min(1),
    feedback: z.array(targetSchema).max(50),
    explainedByContext: z.boolean().nullable(),
    feedbackAccurate: z.boolean().nullable(),
  })
  .strict();
export const feedbackRule = defineSentinelRule(
  {
    id: 'UIK-R006',
    name: '等待与不可操作说明审查',
    kind: 'review',
    description: '关联已激活区域的真实状态与反馈，不从空 DOM 推断零结果，不引入统一等待时限。',
  },
  feedbackEvidenceSchema,
  (c, d) => {
    if (!d.activated || d.actualState === 'ready')
      return exempt('The region is inactive or completed without a waiting-state obligation');
    if (d.actualState === 'unknown') return unknown('The actual asynchronous/availability state is not established');
    for (const target of d.feedback) c.resolve(target);
    if (d.feedback.length > 0 && d.feedbackAccurate === false)
      return review(
        'The observed feedback contradicts the established state, even if surrounding context is available',
      );
    if (d.explainedByContext === true || (d.feedback.length > 0 && d.feedbackAccurate === true))
      return pass('The active state is explained by observed feedback or sufficient context');
    if (d.explainedByContext === null || d.feedbackAccurate === null)
      return unknown('The explanation and its correspondence to the actual state remain unverified');
    return review('The activated loading, empty or unavailable state lacks a clear accurate explanation');
  },
);
