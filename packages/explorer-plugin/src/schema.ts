import { z } from 'zod';
export const scopeSchema = z.object({stableKey:z.string().min(1).optional(),url:z.url().optional(),region:z.string().min(1).describe('Exact observed region display label, not its key or selector').optional(),label:z.string().min(1).describe('Exact observed action label or accessible control name').optional(),role:z.string().min(1).optional(),kind:z.enum(['click','fill','select','check','scroll','press','hover','focus','navigate','history']).describe('Executable operation kind, never a control type or a desired state').optional(),value:z.union([z.string(),z.boolean(),z.number()]).describe('Actual operation input or option value, not an expected result').optional()}).strict();
export const plannedScopeSchema = z.object({title:z.string().min(1),scope:scopeSchema,prerequisites:z.array(scopeSchema).max(30).describe('Executable prerequisite operations, not assertions about enabled/disabled states'),completion:z.string().min(1),required:z.boolean(),reason:z.string()}).strict();
export const planSchema = z.object({items:z.array(plannedScopeSchema).min(1).max(100)}).strict();
export const initialTaskSchema = z.discriminatedUnion('mode',[
  z.object({mode:z.literal('exhaustive'),boundary:z.literal('current-page'),exclusions:z.array(z.object({
    scope:scopeSchema.refine(scope=>Object.keys(scope).some(key=>key!=='url'),'An exclusion must identify a control, region or operation, not the entire page'),
    instruction:z.string().trim().min(1).describe('Exact quote of the user instruction that explicitly excludes this scope'),
  }).strict()).max(100)}).strict(),
  z.object({mode:z.literal('targeted'),items:z.array(plannedScopeSchema).min(1).max(100).refine(items=>items.some(i=>i.required),'At least one target must be required')}).strict(),
  z.object({mode:z.literal('unsupported'),reason:z.string().trim().min(1)}).strict(),
]);
export const budgetSchema=z.object({rounds:z.number().int().min(1).max(100).default(3),actions:z.number().int().min(1).max(10000).default(300),durationMs:z.number().int().min(100).max(86400000).default(1800000),modelRequests:z.number().int().min(1).max(10000).default(300)});
export const createTaskSchema = z.object({goal:z.string().trim().max(20000).default(''),url:z.url().refine(v=>['http:','https:'].includes(new URL(v).protocol)),
  coverageMode:z.enum(['all','representative']).default('all'),
  budget:budgetSchema.prefault({}),
  evidenceBudget:z.object({maxBytes:z.number().int().min(1024*1024).max(16*1024**3).default(1024**3),maxObservations:z.number().int().min(10).max(10000).default(1000)}).strict().prefault({}),
  sessionOptions:z.object({headless:z.boolean().optional(),maxDepth:z.number().int().min(1).max(100).optional(),settleMs:z.number().int().min(0).max(5000).optional(),observeTimeoutMs:z.number().int().min(1).max(30000).optional(),actionTimeoutMs:z.number().int().min(1).max(60000).optional(),maxActions:z.number().int().min(1).max(10000).optional()}).strict().default({}),
}).strict();
export const commandSchema = z.object({command:z.enum(['start','pause','resume','stop','replan','continue-scope','extend-budget']),coverageMode:z.enum(['all','representative']).optional(),budget:budgetSchema.optional(),goal:z.string().trim().max(20000).optional(),itemIds:z.array(z.string()).min(1).max(100).optional(),items:z.array(plannedScopeSchema).min(1).max(100).optional()}).strict();
export const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string,unknown>;
