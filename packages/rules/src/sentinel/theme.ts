import { z } from 'zod';
import { asJson, defineSentinelRule, exempt, pass, review, unknown } from './core.js';

export const themeEvidenceSchema = z
  .object({
    currentTheme: z.string().min(1),
    referenceTheme: z.string().min(1),
    sameContent: z.boolean(),
    identityRequired: z.boolean(),
    currentCaptureId: z.string().min(1),
    referenceEvidence: z.string().min(1),
    /** Observed recognizability, not whether the two themes use the same colors. */
    currentRecognizable: z.boolean().nullable(),
    referenceRecognizable: z.boolean().nullable(),
  })
  .strict();
export const themeRule = defineSentinelRule(
  {
    id: 'UIK-R004',
    name: '主题辨识性审查',
    kind: 'review',
    description: '在相同内容状态下比较支持的主题，检查信息辨识性而非强制颜色或资产相同。',
  },
  themeEvidenceSchema,
  (c, d) => {
    if (!d.identityRequired || d.currentTheme === d.referenceTheme)
      return exempt('No required cross-theme identity comparison is triggered');
    if (
      !d.sameContent ||
      d.currentCaptureId !== c.page.capture.id ||
      d.currentRecognizable === null ||
      d.referenceRecognizable === null
    )
      return unknown(
        'Comparable content, capture bindings and recognizability observations for both themes are required',
      );
    const facts = { comparison: asJson(d) };
    return d.currentRecognizable && d.referenceRecognizable
      ? pass(
          'The required identity is recognizable in both observed themes, including intentional asset/color variants',
          facts,
        )
      : review(
          'Required identity is hard to recognize in an observed theme; review the actual background and asset intent',
          facts,
        );
  },
);
