import { z } from 'zod';
import { defineSentinelRule, exempt, fail, intersects, pass, targetSchema, unknown } from './core.js';

export const overlapEvidenceSchema = z
  .object({
    other: targetSchema,
    coexist: z.boolean(),
    intentionalOverlay: z.boolean(),
    /** A visual/interaction observation of the overlap, not a rectangle-intersection guess. */
    informationReadable: z.boolean().optional(),
    operationReachable: z.boolean().optional(),
  })
  .strict();
export const overlapRule = defineSentinelRule(
  {
    id: 'UIK-D002',
    name: '必要内容重叠',
    kind: 'defect',
    description: '应同时可见的必要内容保持可辨认和可操作；矩形相交只用于筛查。',
  },
  overlapEvidenceSchema,
  (c, d) => {
    const other = c.resolve(d.other);
    if (!d.coexist || d.intentionalOverlay)
      return exempt('These objects need not coexist, or the overlay is intentional');
    if (!c.node.rect || !other.rect) return unknown('Both rendered bounds are required');
    const overlap = intersects(c.node.rect, other.rect);
    if (!overlap)
      return d.informationReadable === true && d.operationReachable === true
        ? pass('The bound coexisting objects are observed readable and operable without overlapping bounds')
        : unknown('Disjoint DOM boxes alone do not certify overflowing text or painted children');
    if (d.informationReadable === false || d.operationReachable === false)
      return fail('The unintended overlap hides required information or prevents the bound operation', { overlap });
    if (d.informationReadable === true && d.operationReachable === true)
      return pass('The overlapping objects remain readable and operable', { overlap });
    return unknown('Intersecting rectangles alone do not establish destructive overlap', { overlap });
  },
);
