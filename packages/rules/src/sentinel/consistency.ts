import { z } from 'zod';
import { canonical } from '../util.js';
import { asJson, defineSentinelRule, exempt, pass, rendered, review, targetSchema, unknown } from './core.js';

const equivalenceSchema = z
  .object({
    role: z.string().min(1),
    state: z.string().min(1),
    variant: z.string().min(1),
    density: z.string().min(1),
    platform: z.string().min(1),
    breakpoint: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();
export const consistencyEvidenceSchema = z
  .object({
    context: equivalenceSchema,
    peers: z
      .array(z.object({ target: targetSchema, context: equivalenceSchema }).strict())
      .min(1)
      .max(100),
    allowedDifferences: z.array(z.string().min(1)).max(50),
  })
  .strict();
function consistency(id: string, name: string, description: string, properties: string[]) {
  return defineSentinelRule({ id, name, description, kind: 'review' }, consistencyEvidenceSchema, (c, d) => {
    const peers = d.peers
      .map(p => ({ node: c.resolve(p.target), context: p.context }))
      .filter(p => canonical(p.context) === canonical(d.context) && p.node.id !== c.node.id);
    if (!peers.length) return exempt('No peers share the verified semantic role, state, variant and display context');
    const compared = properties.filter(p => !d.allowedDifferences.includes(p));
    if (!compared.length) return exempt('All measured differences are explicitly allowed');
    const nodes = [c.node, ...peers.map(p => p.node)];
    if (nodes.some(n => !rendered(c.page, n)))
      return unknown('A bound peer is not currently rendered; it cannot establish visual consistency');
    if (nodes.some(n => !n.styles || compared.some(p => n.styles![p] === undefined)))
      return unknown('A required computed style is missing; missing values cannot establish consistency');
    const differences = compared
      .filter(p => new Set(nodes.map(n => n.styles![p])).size > 1)
      .map(property => ({ property, values: nodes.map(n => ({ nodeId: n.id, value: n.styles![property] })) }));
    const facts = { context: asJson(d.context), properties: compared, differences: asJson(differences) };
    return differences.length
      ? review(
          'Equivalent instances have unexplained visual differences; review their semantic impact and design intent',
          facts,
        )
      : pass('The measured styles agree among the bound equivalent instances', facts);
  });
}
export const typographyRule = consistency(
  'UIK-R001',
  '字体层次审查',
  '在等价文字角色和有效变体内比较字体表达，不把全页标题归为同一层级。',
  ['font-family', 'font-size', 'font-weight', 'line-height'],
);
export const componentConsistencyRule = consistency(
  'UIK-R002',
  '组件一致性审查',
  '只比较同角色、同状态、同密度、同平台断点和版本的组件实例。',
  [
    'color',
    'background-color',
    'font-size',
    'font-weight',
    'border-top-width',
    'border-top-style',
    'border-top-color',
    'border-top-left-radius',
    'cursor',
  ],
);
