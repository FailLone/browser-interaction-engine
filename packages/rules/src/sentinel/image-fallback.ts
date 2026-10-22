import { z } from 'zod';
import { defineSentinelRule, exempt, pass, rendered, review, targetSchema, unknown } from './core.js';

export const fallbackEvidenceSchema = z
  .object({
    identityRequired: z.boolean(),
    intendedEntity: z.string().min(1),
    fallbackKind: z.enum(['neutral', 'entity', 'none']),
    fallbackEntity: z.string().min(1).optional(),
    textAlternative: targetSchema.optional(),
    textIdentifiesEntity: z.boolean().optional(),
    layoutStable: z.boolean().optional(),
  })
  .strict();
export const imageFallbackRule = defineSentinelRule(
  {
    id: 'UIK-R005',
    name: '缺图替代表达审查',
    kind: 'review',
    description: '确认图片缺失或加载失败后，审查身份与布局是否清楚；不规定统一占位图。',
  },
  fallbackEvidenceSchema,
  (c, d) => {
    if (!d.identityRequired) return exempt('The image is not needed for identity');
    const image = c.node.image;
    if (!image?.resource) return unknown('Native image resource state is unavailable');
    if (!image.complete) return unknown('Loading or lazy loading is not a confirmed missing-image state');
    if (image.naturalWidth > 0 && image.naturalHeight > 0) return exempt('The current image resource is available');
    if (image.resource.hasSource && image.resource.event !== 'error')
      return unknown('Image unavailability has not been confirmed');
    if (d.fallbackKind === 'entity' && d.fallbackEntity && d.fallbackEntity !== d.intendedEntity)
      return review(
        'The replacement depicts another bound entity; review whether it misrepresents the intended identity',
      );
    const text = d.textAlternative && c.resolve(d.textAlternative);
    const readable = !!text?.text?.trim() && rendered(c.page, text);
    if (
      readable &&
      d.textIdentifiesEntity &&
      d.layoutStable === true &&
      (d.fallbackKind !== 'entity' || d.fallbackEntity === d.intendedEntity)
    )
      return pass('The missing image has a bound textual identity and stable layout without a misleading substitute');
    if (d.layoutStable === undefined || d.textIdentifiesEntity === undefined)
      return unknown('Textual identity, layout and fallback semantics need observation');
    return review(
      'The missing-image state has uncertain identity or changed layout; inspect its actual alternative expression',
    );
  },
);
