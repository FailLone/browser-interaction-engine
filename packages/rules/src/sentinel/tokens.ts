import { z } from 'zod';
import { canonical } from '../util.js';
import { asJson, defineSentinelRule, exempt, fail, pass, unknown } from './core.js';

const contextSchema = z
  .object({
    environment: z.enum(['runtime', 'design-file']),
    version: z.string().min(1),
    mode: z.string().min(1),
    scope: z.string().min(1),
    normalization: z.string().min(1),
  })
  .strict();
export const tokenEvidenceSchema = z
  .object({
    definitionContext: contextSchema,
    consumerContext: contextSchema,
    token: z.string().min(1),
    consumerToken: z.string().min(1),
    overrideAllowed: z.boolean(),
    definitions: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ id: z.string().min(1), kind: z.literal('value'), value: z.json() }).strict(),
          z.object({ id: z.string().min(1), kind: z.literal('alias'), to: z.string().min(1) }).strict(),
        ]),
      )
      .min(1)
      .max(500),
    /** Normalized resolved value, not the composited screenshot color. */
    consumerValue: z.json(),
  })
  .strict();
export const tokenRule = defineSentinelRule(
  {
    id: 'UIK-D011',
    name: '设计变量解析一致性',
    kind: 'defect',
    description: '同一版本、主题、作用域和规范化上下文中的同一变量，应解析到相同有效值。',
  },
  tokenEvidenceSchema,
  (_c, d) => {
    if (
      d.overrideAllowed ||
      d.token !== d.consumerToken ||
      canonical(d.definitionContext) !== canonical(d.consumerContext)
    )
      return exempt(
        'The consumer has an authorized override, uses another variable, or has a different resolution context',
      );
    const definitions = new Map(d.definitions.map(t => [t.id, t]));
    if (definitions.size !== d.definitions.length) return unknown('Token definitions are ambiguous');
    const visited = new Set<string>();
    let id = d.token;
    while (!visited.has(id)) {
      visited.add(id);
      const definition = definitions.get(id);
      if (!definition) return unknown('An alias or effective token definition is missing', { chain: [...visited] });
      if (definition.kind === 'alias') {
        id = definition.to;
        continue;
      }
      const facts = {
        context: asJson(d.definitionContext),
        chain: [...visited],
        expectedValue: definition.value,
        actualValue: d.consumerValue,
      };
      return canonical(definition.value) === canonical(d.consumerValue)
        ? pass('The consumer resolves to the same normalized effective token value', facts)
        : fail('The consumer resolves to a different value in the exact same token context', facts);
    }
    return unknown('The token alias chain contains a cycle', { chain: [...visited] });
  },
);
