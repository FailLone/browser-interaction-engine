import { z } from 'zod';
export const scopeSchema = z.object({stableKey:z.string().min(1).optional(),url:z.url().optional(),region:z.string().min(1).optional(),label:z.string().min(1).optional(),role:z.string().min(1).optional(),kind:z.string().min(1).optional(),value:z.union([z.string(),z.boolean(),z.number()]).optional()}).strict();
export const plannedScopeSchema = z.object({title:z.string().min(1),scope:scopeSchema,prerequisites:z.array(scopeSchema).max(30),completion:z.string().min(1),required:z.boolean(),reason:z.string()}).strict();
export const planSchema = z.object({items:z.array(plannedScopeSchema).min(1).max(100)}).strict();
export const budgetSchema=z.object({rounds:z.number().int().min(1).max(100).default(3),actions:z.number().int().min(1).max(10000).default(300),durationMs:z.number().int().min(100).max(86400000).default(1800000),modelRequests:z.number().int().min(1).max(10000).default(300)});
export const createTaskSchema = z.object({goal:z.string().trim().min(1).max(20000),url:z.url().refine(v=>['http:','https:'].includes(new URL(v).protocol)),
  budget:budgetSchema.prefault({}),
  sessionOptions:z.object({headless:z.boolean().optional(),maxDepth:z.number().int().min(1).max(100).optional(),settleMs:z.number().int().min(0).max(5000).optional(),observeTimeoutMs:z.number().int().min(1).max(30000).optional(),actionTimeoutMs:z.number().int().min(1).max(60000).optional(),maxActions:z.number().int().min(1).max(10000).optional()}).strict().default({}),
}).strict();
export const commandSchema = z.object({command:z.enum(['start','pause','resume','stop','replan','continue-scope','extend-budget']),budget:budgetSchema.optional(),goal:z.string().trim().min(1).max(20000).optional(),itemIds:z.array(z.string()).min(1).max(100).optional(),items:z.array(plannedScopeSchema).min(1).max(100).optional()}).strict();
export const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string,unknown>;
