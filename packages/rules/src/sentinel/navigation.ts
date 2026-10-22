import { z } from 'zod';
import { asJson, defineSentinelRule, exempt, pass, review, unknown } from './core.js';

export const navigationEvidenceSchema = z
  .object({
    contextNeeded: z.boolean(),
    pathComplete: z.boolean(),
    from: z.string().min(1),
    current: z.string().min(1),
    expectedDestination: z.string().min(1),
    observedDestination: z.string().min(1).optional(),
    contextIdentifiable: z.boolean().nullable(),
    directionPredictable: z.boolean().nullable(),
    alternativePathClear: z.boolean(),
  })
  .strict();
export const navigationRule = defineSentinelRule(
  {
    id: 'UIK-R007',
    name: '导航与上下文审查',
    kind: 'review',
    description: '用实际进入和离开路径审查上下文与方向，不要求每页都有返回键或每组都有 All。',
  },
  navigationEvidenceSchema,
  (_c, d) => {
    if (!d.contextNeeded) return exempt('The task is self-explanatory without another navigation affordance');
    if (!d.pathComplete || !d.observedDestination || d.contextIdentifiable === null || d.directionPredictable === null)
      return unknown('The navigation path, actual destination and contextual observations are incomplete');
    const facts = { navigation: asJson(d) };
    if (
      d.observedDestination === d.expectedDestination &&
      d.contextIdentifiable &&
      (d.directionPredictable || d.alternativePathClear)
    )
      return pass(
        'Observed destinations and contextual/alternative cues make the bound navigation understandable',
        facts,
      );
    return review(
      'The observed direction or context differs from the established expectation; review available alternatives',
      facts,
    );
  },
);
