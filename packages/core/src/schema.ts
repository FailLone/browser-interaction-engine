import { z } from 'zod';
export const explorationGroupDecisionSchema = z.intersection(z.object({ source: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1) }), z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all'), memberKeys: z.never().optional() }),
  z.object({ mode: z.literal('defer'), memberKeys: z.never().optional() }),
  z.object({ mode: z.literal('skip'), memberKeys: z.never().optional() }),
  z.object({ mode: z.literal('sample'), memberKeys: z.array(z.string().min(1)).min(1).max(10000) }),
]));
export const explorationGroupResolutionsSchema = z.array(z.object({ groupId: z.string().min(1), revision: z.number().int().positive(), decision: explorationGroupDecisionSchema }).strict()).min(1).max(1000);
export const explorationGroupProposalSchema = z.object({
  binding: z.enum(['instance', 'context']).optional(),
  collection: z.object({ key: z.string().trim().min(1), label: z.string().trim().min(1), evidence: z.array(z.object({ source: z.string().min(1), rule: z.string().min(1), facts: z.record(z.string(), z.json()) })).min(1) }).strict().optional(),
  key: z.string().trim().min(1), kind: z.string().trim().min(1), label: z.string().trim().min(1),
  actionIds: z.array(z.string().min(1)), traversalActionIds: z.array(z.string().min(1)),
  conditions: z.json().optional(),
  minimumMembers: z.number().int().min(1).max(100).optional(),
  evidence: z.array(z.object({ source: z.string().min(1), rule: z.string().min(1), facts: z.record(z.string(), z.json()) })).min(1),
}).strict();
export const evidenceRetentionSchema = z.preprocess(input => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  return { ttlMs: value.mode === 'transient' ? 30000 : value.mode === 'cache' ? 300000 : 0, ...value };
}, z.object({ mode: z.enum(['transient', 'cache', 'persistent']), ttlMs: z.number().int().min(0).max(86400000 * 365), maxBytes: z.number().int().min(1024).max(1024 ** 4).default(64 * 1024 ** 2), maxObservations: z.number().int().min(1).max(100000).default(100) }).strict().refine(p => p.mode === 'persistent' || p.ttlMs > 0, 'Transient and cache modes require a finite positive TTL'));
export const contextSchema = z.record(z.string(), z.object({ value: z.json(), status: z.enum(['known', 'unknown']), source: z.string() }));
export const actionBasisSchema = z.object({ status: z.enum(['supported', 'tentative']), evidence: z.array(z.object({ source: z.string().min(1), rule: z.string().min(1), facts: z.record(z.string(), z.json()) })).min(1) });
export const componentDescriptionSchema = z.object({
  observationId: z.string().min(1), componentId: z.string().min(1), kind: z.string().trim().min(1).max(100), name: z.string().max(500).optional(),
  members: z.array(z.object({ localId: z.string().min(1), role: z.string().trim().min(1).max(100), name: z.string().max(500).optional(), value: z.json().optional(), selected: z.boolean().optional() }).strict()).min(1).max(1500),
  source: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(4000),
  evidence: z.array(z.object({ observationId: z.string().min(1), localId: z.string().min(1).optional(), componentId: z.string().min(1).optional() }).strict()).min(1).max(100),
}).strict();
export const sessionSchema = z.object({
  executionPolicy: z.enum(['interface-only', 'observed-ui']).optional(),
  maxActions: z.number().int().positive().max(10000).default(100),
  maxDepth: z.number().int().positive().max(100).default(10),
  maxDurationMs: z.number().int().positive().max(86400000).default(600000),
  context: z.record(z.string(), z.json()).default({}),
  exploration: z.enum(['controls', 'representative', 'stateful']).default('stateful'),
  evidenceRetention: evidenceRetentionSchema.optional(),
});
