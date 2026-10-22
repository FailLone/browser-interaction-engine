import { z } from 'zod';
import { asJson, defineSentinelRule, exempt, fail, pass, unknown } from './core.js';

export const selectionEvidenceSchema = z
  .object({
    selectionKnown: z.boolean(),
    selected: z.boolean(),
    neededForOrientation: z.boolean(),
    selectionKey: z.string().min(1),
    cuesComplete: z.boolean(),
    cues: z
      .array(
        z
          .object({
            kind: z.enum(['underline', 'background', 'text', 'icon', 'native', 'alternative']),
            visible: z.boolean().nullable(),
            evidence: z.string().min(1),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export const selectionRule = defineSentinelRule(
  {
    id: 'UIK-D007',
    name: '选中状态表达',
    kind: 'defect',
    description: '可信选择事实已经生效且需要定位时，保留至少一种可识别的选中线索。',
  },
  selectionEvidenceSchema,
  (_c, d) => {
    if (!d.selectionKnown) return unknown('The actual selected value is not known; names do not establish a default');
    if (!d.selected || !d.neededForOrientation)
      return exempt('The target is not selected or selection is not needed for orientation');
    const facts = { selectionKey: d.selectionKey, cues: asJson(d.cues) };
    if (d.cues.some(cue => cue.visible === true))
      return pass('A visible selection cue remains, even if another cue changed', facts);
    if (!d.cuesComplete || d.cues.some(cue => cue.visible === null))
      return unknown('Not all alternative visual selection cues have been inspected', facts);
    return fail('The selected target has no recognizable selection cue after all alternatives were inspected', facts);
  },
);
