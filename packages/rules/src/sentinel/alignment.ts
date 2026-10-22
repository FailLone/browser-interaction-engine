import { z } from 'zod';
import { asJson, defineSentinelRule, exempt, pass, review, targetSchema, unknown } from './core.js';

export const alignmentEvidenceSchema = z
  .object({
    group: z.string().min(1),
    peers: z.array(targetSchema).min(1).max(100),
    intent: z.enum(['start', 'center', 'end', 'content-sized', 'optical', 'unspecified']),
    axis: z.enum(['x', 'y']),
  })
  .strict();
export const alignmentRule = defineSentinelRule(
  {
    id: 'UIK-R003',
    name: '分组对齐与空间审查',
    kind: 'review',
    description: '依据已绑定的分组关系与对齐意图比较布局，保留自适应尺寸、光学对齐和合理多行。',
  },
  alignmentEvidenceSchema,
  (c, d) => {
    const nodes = [c.node, ...d.peers.map(p => c.resolve(p))];
    if (new Set(nodes.map(n => n.id)).size !== nodes.length)
      return unknown('The comparison group contains duplicate targets');
    if (d.intent === 'content-sized' || d.intent === 'optical')
      return exempt('Content sizing or optical alignment intentionally permits geometric differences');
    if (d.intent === 'unspecified') return unknown('The group is known but its alignment intent is not');
    if (nodes.some(n => !n.rect)) return unknown('The complete group geometry is required');
    const positions = nodes.map(n => {
      const r = n.rect!;
      return (
        r[d.axis] + (d.intent === 'start' ? 0 : (d.axis === 'x' ? r.width : r.height) / (d.intent === 'center' ? 2 : 1))
      );
    });
    const spread = Math.max(...positions) - Math.min(...positions);
    const facts = { group: d.group, intent: d.intent, axis: d.axis, positions: asJson(positions), spread };
    // One CSS pixel allows capture rounding; it is not a universal spacing requirement.
    return spread > 1
      ? review(
          'The bound group differs from its declared alignment; review grouping and optical/design explanations',
          facts,
        )
      : pass('The measured group follows its declared alignment within capture rounding', facts);
  },
);
