import { z } from 'zod';
import { asJson, contains, defineSentinelRule, exempt, fail, pass, rectSchema, targetSchema, unknown } from './core.js';

export const decorationEvidenceSchema = z
  .object({
    owner: targetSchema,
    kind: z.enum(['fill', 'watermark', 'shadow', 'focus-ring', 'popover']),
    allowBleed: z.boolean(),
    /** Effective clipping boundary established by the host, in viewport CSS pixels. */
    boundary: rectSchema,
    radius: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }).strict(),
    paintCaptureId: z.string().min(1),
    paintComplete: z.boolean(),
    /** Actual painted region tiles, not the decoration's DOM bounding box. */
    painted: z.array(rectSchema).max(1000),
  })
  .strict();
export const decorationRule = defineSentinelRule(
  {
    id: 'UIK-D009',
    name: '装饰绘制边界',
    kind: 'defect',
    description: '有明确归属与裁剪约定的填充或水印遵守有效边界；阴影、焦点环与有意外伸除外。',
  },
  decorationEvidenceSchema,
  (c, d) => {
    const owner = c.resolve(d.owner);
    if (d.allowBleed || ['shadow', 'focus-ring', 'popover'].includes(d.kind))
      return exempt('This layer is allowed to extend outside its owner');
    if (!d.paintComplete || d.paintCaptureId !== c.page.capture.id || !owner.rect)
      return unknown('Complete painted-region evidence from this capture and the owner boundary are required');
    if (!d.painted.some(r => r.width > 0 && r.height > 0))
      return exempt('The layer has no visible paint whose boundary can be checked');
    if (!contains(owner.rect, d.boundary, 1) || d.radius.x > d.boundary.width / 2 || d.radius.y > d.boundary.height / 2)
      return unknown('The effective clipping boundary or normalized corner radii do not match the owner');
    const inside = (x: number, y: number) => {
      const { boundary: b, radius: r } = d;
      if (x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height) return false;
      if (!r.x || !r.y) return true;
      const cx = Math.max(b.x + r.x, Math.min(x, b.x + b.width - r.x));
      const cy = Math.max(b.y + r.y, Math.min(y, b.y + b.height - r.y));
      return ((x - cx) / r.x) ** 2 + ((y - cy) / r.y) ** 2 <= 1 + 1e-6;
    };
    const escaped = d.painted.filter(
      r =>
        r.width > 0 &&
        r.height > 0 &&
        [
          [r.x, r.y],
          [r.x + r.width, r.y],
          [r.x, r.y + r.height],
          [r.x + r.width, r.y + r.height],
        ].some(([x, y]) => !inside(x, y)),
    );
    const facts = { boundary: asJson(d.boundary), radius: asJson(d.radius), escaped: asJson(escaped) };
    return escaped.length
      ? fail('The recorded visible decoration extends outside its declared clipping boundary', facts)
      : pass('All recorded decoration paint lies inside the declared clipping boundary', facts);
  },
);
