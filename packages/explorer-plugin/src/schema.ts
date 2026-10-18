import {routeURLSchema} from '@interaction/browser';
import { z } from 'zod';
export const scopeSchema = z.object({landmark:z.enum(['banner','navigation']).optional(),stableKey:z.string().min(1).optional(),targetBinding:z.string().regex(/^browser-target-binding:v1:[a-f0-9]{64}$/).describe('Exact SDK-captured semantic owner/binding hint; not an identity, selector or execution grant').optional(),url:z.url().optional(),region:z.string().min(1).describe('Exact observed region display label, not its key or selector').optional(),label:z.string().min(1).describe('Exact observed action label or accessible control name').optional(),role:z.string().min(1).optional(),kind:z.enum(['click','fill','select','check','scroll','press','hover','focus','navigate','history']).describe('Executable operation kind, never a control type or a desired state').optional(),value:z.union([z.string(),z.boolean(),z.number()]).describe('Actual operation input or option value, not an expected result').optional()}).strict();
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
export const coverageContractSchema=z.object({programNavigation:z.literal('public-navigation-v1').optional(),version:z.literal(1),mode:z.enum(['exhaustive','targeted']),
  urlMatching:z.enum(['exact','origin-path']).optional(),
  routes:z.array(routeURLSchema.extend({scope:scopeSchema.omit({url:true})})).max(100).optional(),
  roots:z.array(scopeSchema).min(1).max(100),
  exclusions:z.array(z.object({scope:scopeSchema,instruction:z.string().trim().min(1)}).strict()).max(100),
  allowedOperations:z.array(z.enum(['click','fill','select','check','scroll','press','hover','focus','navigate','history','dismiss'])).min(1).max(11),
}).strict().superRefine((value,ctx)=>{
  if(value.mode==='exhaustive'&&value.routes?.some(route=>Object.keys(route.scope).length))ctx.addIssue({code:'custom',message:'Exhaustive route scopes must cover whole declared pages'});
  if(value.mode==='exhaustive'&&value.roots.some(root=>Object.keys(root).some(key=>key!=='url')))ctx.addIssue({code:'custom',message:'Exhaustive roots must cover whole declared pages; restricted roots require targeted mode'});
  if(value.mode==='targeted'&&value.roots.some(root=>Object.keys(root).length===0))ctx.addIssue({code:'custom',message:'Targeted roots must explicitly identify a page, region, control or operation'});
});
export const createTaskSchema = z.object({goal:z.string().trim().max(20000).default(''),url:z.url().refine(v=>['http:','https:'].includes(new URL(v).protocol)),
  coverageContract:coverageContractSchema.optional(),
  coverageMode:z.enum(['all','representative']).default('all'),
  budget:budgetSchema.prefault({}),
  evidenceBudget:z.object({maxBytes:z.number().int().min(1024*1024).max(16*1024**3).default(1024**3),maxObservations:z.number().int().min(10).max(10000).default(1000)}).strict().prefault({}),
  sessionOptions:z.object({coveragePolicy:z.literal('finite-ui-v1').optional(),localSimulation:z.object({url:z.url().refine(v=>['127.0.0.1','localhost','[::1]'].includes(new URL(v).hostname))}).strict().optional(),executionPolicy:z.enum(['interface-only','observed-ui']).optional(),headless:z.boolean().optional(),maxDepth:z.number().int().min(1).max(100).optional(),settleMs:z.number().int().min(0).max(5000).optional(),observeTimeoutMs:z.number().int().min(1).max(30000).optional(),actionTimeoutMs:z.number().int().min(1).max(60000).optional(),maxActions:z.number().int().min(1).max(10000).optional()}).strict().default({}),
}).strict();
export const limitationAcceptanceSchema=z.object({codes:z.array(z.string().regex(/^(UNSUPPORTED_.+|.+_UNSUPPORTED)$/)).min(1).max(100),reason:z.string().trim().min(1).max(2000)}).strict();
export const commandSchema = z.object({command:z.enum(['start','pause','resume','stop','replan','continue-scope','extend-budget','accept-limitations']),limitations:limitationAcceptanceSchema.optional(),coverageMode:z.enum(['all','representative']).optional(),budget:budgetSchema.optional(),goal:z.string().trim().max(20000).optional(),itemIds:z.array(z.string()).min(1).max(100).optional(),items:z.array(plannedScopeSchema).min(1).max(100).optional()}).strict();
export const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string,unknown>;
