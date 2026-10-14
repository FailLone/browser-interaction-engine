import { z } from 'zod';
export const contextSchema = z.record(z.string(), z.object({ value: z.json(), status: z.enum(['known', 'unknown']), source: z.string() }));
export const sessionSchema = z.object({
  maxActions: z.number().int().positive().max(10000).default(100),
  maxDepth: z.number().int().positive().max(100).default(10),
  maxDurationMs: z.number().int().positive().max(86400000).default(600000),
  context: z.record(z.string(), z.json()).default({}),
});
