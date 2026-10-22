import { z } from 'zod';
import { asJson, defineSentinelRule, exempt, pass, review, unknown } from './core.js';

export const focusEvidenceSchema = z
  .object({
    styleChanged: z.boolean(),
    keyboardFocusable: z.boolean(),
    pathComplete: z.boolean(),
    visits: z
      .array(
        z
          .object({
            modality: z.enum(['keyboard', 'pointer']),
            active: z.boolean(),
            indicatorVisible: z.boolean().nullable(),
            evidence: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const focusRule = defineSentinelRule(
  {
    id: 'UIK-R010',
    name: '键盘焦点定位审查',
    kind: 'review',
    description: '焦点样式变更需要实际键盘路径与可见指示证据；点击后的默认焦点环是正常行为。',
  },
  focusEvidenceSchema,
  (_c, d) => {
    if (!d.styleChanged || !d.keyboardFocusable)
      return exempt('There is no focus-style change on a keyboard-focusable target');
    const keyboard = d.visits.filter(v => v.modality === 'keyboard');
    if (!d.pathComplete || !keyboard.length || keyboard.some(v => !v.active || v.indicatorVisible === null))
      return unknown(
        'A complete keyboard path with confirmed active-element and visual-indicator observations is required',
      );
    const facts = { visits: asJson(d.visits) };
    return keyboard.every(v => v.indicatorVisible)
      ? pass('Every recorded keyboard visit retains a visible focus indicator', facts)
      : review(
          'A recorded keyboard focus visit lacks a perceptible indicator; inspect the replacement focus style',
          facts,
        );
  },
);
