import { inspectionOptionsSchema } from './inspection-contract.js';
import { listPurposeReviewSchema, revokePurposeReviewSchema } from './purpose-review.js';
import { z } from 'zod';
import { evidenceRetentionSchema, explorationGroupDecisionSchema } from '@interaction/core';
export const contextSchema = z.record(z.string(), z.object({ value: z.json(), status: z.enum(['known', 'unknown']), source: z.string() }));
const match = z.object({ role: z.string().optional(), name: z.string().optional(), stableKey: z.string().optional(), kind: z.enum(['click', 'fill', 'select', 'check', 'scroll', 'press', 'hover', 'navigate', 'history']).optional(), urlIncludes: z.string().optional() }).strict();
export const evidenceOptionsSchema = z.object({
    enabled: z.boolean().default(true), maxNodes: z.number().int().min(1).max(50000).default(5000),
    maxTextLength: z.number().int().min(1).max(100000).default(20000), maxHtmlLength: z.number().int().min(1).max(10000000).default(2000000),
    maxDomCharacters: z.number().int().min(1000).max(20000000).default(4000000),
    maxAttributeLength: z.number().int().min(1).max(100000).default(4000), maxRuntimeEntries: z.number().int().min(1).max(5000).default(200),
    styles: z.enum(['none', 'essential', 'all']).default('essential'), accessibility: z.boolean().default(true), fullPageScreenshot: z.boolean().default(false),
  }).strict().prefault({});
export const sessionSchema = z.object({
  url: z.url().refine(v => ['http:', 'https:'].includes(new URL(v).protocol), 'Only HTTP(S) URLs are supported'),
  headless: z.boolean().default(false), viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(240).max(2160) }).default({ width: 1440, height: 900 }),
  maxActions: z.number().int().positive().max(10000).default(100), maxDepth: z.number().int().positive().max(100).default(10), maxDurationMs: z.number().int().positive().max(86400000).default(600000),
  actionTimeoutMs: z.number().int().positive().max(60000).default(10000), settleMs: z.number().int().min(0).max(5000).default(200), observeTimeoutMs: z.number().int().positive().max(30000).default(2000),
  evidence: evidenceOptionsSchema,
  inspection: inspectionOptionsSchema.optional(),
  evidenceRetention: evidenceRetentionSchema.optional(),
  exclude: z.array(match).default([]), replayable: z.array(match).default([]), context: z.record(z.string(), z.json()).default({}),
  exploration: z.enum(['controls', 'representative', 'stateful']).default('controls'),
  listExploration: z.enum(['review', 'all']).default('review'),
  pageExploration: z.enum(['review', 'all']).default('review'),
  decisionScopes: z.array(z.enum(['region', 'branch', 'input-space'])).default([]),
  interfaceActions: z.array(match).default([]), reversible: z.array(match).default([]),
  environmentReset: z.enum(['none', 'document-reload']).default('none'),
  contextRules: z.array(z.object({ key: z.string().min(1), selector: z.string().min(1), attribute: z.string().optional(), required: z.boolean().optional() })).default([]),
  storageState: z.union([z.string(), z.object({ cookies: z.array(z.unknown()), origins: z.array(z.unknown()) })]).optional(),
}).strict();
export const predicateSchema = z.object({ target: z.enum(['url', 'context', 'control']), key: z.string().optional(), identityId: z.string().optional(), field: z.enum(['value', 'checked', 'visible', 'enabled']).optional(), equals: z.json() }).strict();
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reviewListPurpose'), review: listPurposeReviewSchema }).strict(),
  z.object({ type: z.literal('revokePurposeReview'), revocation: revokePurposeReviewSchema }).strict(),
  z.object({ type: z.literal('observe') }),
  z.object({ type: z.literal('inspect'), region: z.string() }),
  z.object({ type: z.literal('execute'), actionId: z.string(), requestId: z.string().min(1), value: z.union([z.string(), z.boolean(), z.number()]).optional() }),
  z.object({ type: z.literal('explore') }), z.object({ type: z.literal('pause') }), z.object({ type: z.literal('resume') }), z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('resolveIdentity'), hypothesisId: z.string(), identityId: z.string(), source: z.string().min(1), evidence: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('decideExplorationGroup'), groupId: z.string().min(1), revision: z.number().int().positive(), decision: explorationGroupDecisionSchema }).strict(),
  z.object({ type: z.literal('openScope'), name: z.string().min(1), region: z.string() }),
  z.object({ type: z.literal('closeScope'), scopeId: z.string() }),
  z.object({ type: z.literal('createCheckpoint'), name: z.string().min(1), predicates: z.array(predicateSchema).default([]), acceptable: z.array(predicateSchema).default([]), retainEvidence: z.boolean().optional() }),
  z.object({ type: z.literal('reachCheckpoint'), checkpointId: z.string() }),
]);
export type Command = z.infer<typeof commandSchema>;
export const domQuerySchema = z.object({ fields: z.preprocess(v => typeof v === 'string' ? (v ? v.split(',') : []) : v, z.array(z.enum(['tag', 'text', 'attributes', 'rect', 'styles', 'properties', 'relations', 'layout'])).max(8).optional()), rootId: z.string().min(1).optional(), depth: z.coerce.number().int().min(0).max(100).default(20), offset: z.coerce.number().int().min(0).max(50000).default(0), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).strict();
export const artifactKindSchema = z.enum(['screenshot', 'fullPageScreenshot', 'details']);
