import { scrollProbeSchema } from './scroll-probe.js';
import { inspectionOptionsSchema } from './inspection-contract.js';
import { listPurposeReviewSchema, revokePurposeReviewSchema } from './purpose-review.js';
import { controlReviewSchema, revokeControlReviewSchema, reuseControlReviewsSchema } from './control-review.js';
import { classifyControlsSchema, revokeControlClassificationSchema } from './control-classification.js';
import { supplementDiscoverySchema } from './discovery-scan.js';
import { z } from 'zod';
import { boundaryExitReviewSchema } from './boundary-exit.js';
import { evidenceRetentionSchema, componentDescriptionSchema, explorationGroupDecisionSchema, explorationGroupResolutionsSchema } from '@interaction/core';
export const contextSchema = z.record(z.string(), z.object({ value: z.json(), status: z.enum(['known', 'unknown']), source: z.string() }));
const match = z.object({ role: z.string().optional(), name: z.string().optional(), stableKey: z.string().optional(), kind: z.enum(['click', 'fill', 'select', 'check', 'scroll', 'press', 'hover', 'focus', 'navigate', 'history', 'dismiss']).optional(), urlIncludes: z.string().optional() }).strict();
export const evidenceOptionsSchema = z.object({
    enabled: z.boolean().default(true), maxNodes: z.number().int().min(1).max(50000).default(5000),
    maxTextLength: z.number().int().min(1).max(100000).default(20000), maxHtmlLength: z.number().int().min(1).max(10000000).default(2000000),
    maxDomCharacters: z.number().int().min(1000).max(20000000).default(4000000),
    maxAttributeLength: z.number().int().min(1).max(100000).default(4000), maxRuntimeEntries: z.number().int().min(1).max(5000).default(200),
    styles: z.enum(['none', 'essential', 'all']).default('essential'), accessibility: z.boolean().default(true), fullPageScreenshot: z.boolean().default(false),
  }).strict().prefault({});
export const regionReviewSchema = z.object({
  observationId: z.string().min(1), source: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1),
  regions: z.array(z.object({ key: z.string().trim().min(1), label: z.string().trim().min(1), candidateIds: z.array(z.string().min(1)).min(1), controlIds: z.array(z.string().min(1)).optional(), pageTraversal: z.boolean().default(false), reuse: z.object({ binding: z.literal('same-url-context'), businessScope: z.string().trim().min(1) }).strict().optional() }).strict()).max(500),
  rejectedCandidateIds: z.array(z.string().min(1)).optional(),
  update: z.object({ baseReviewId: z.string().min(1), removeRegionKeys: z.array(z.string().min(1)).max(500).default([]) }).strict().optional(),
}).strict();
export const reuseRegionReviewsSchema = z.object({
  observationId: z.string().min(1), baseReviewId: z.string().min(1), source: z.string().trim().min(1), businessScope: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1).max(100),
  regions: z.array(z.object({reviewId:z.string().min(1),regionKey:z.string().min(1),conditionKey:z.string().min(1)}).strict()).min(1).max(500),
}).strict();
export const revokeRegionReuseSchema = z.object({reviewId:z.string().min(1),regionKey:z.string().min(1),source:z.string().trim().min(1),reason:z.string().trim().min(1)}).strict();
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
  regionExploration: z.enum(['off', 'review']).default('off'),
  decisionScopes: z.array(z.enum(['region', 'branch', 'input-space'])).default([]),
  interfaceActions: z.array(match).default([]), reversible: z.array(match).default([]),
  environmentReset: z.enum(['none', 'document-reload']).default('none'),
  contextRules: z.array(z.object({ key: z.string().min(1), selector: z.string().min(1), attribute: z.string().optional(), required: z.boolean().optional() })).default([]),
  storageState: z.union([z.string(), z.object({ cookies: z.array(z.unknown()), origins: z.array(z.unknown()) })]).optional(),
}).strict().refine(o => o.regionExploration !== 'review' || !o.decisionScopes.some(s => s === 'region' || s === 'branch'), 'Reviewed regions replace optional region/branch producers; select one scope granularity');
export const predicateSchema = z.object({ target: z.enum(['url', 'context', 'control']), key: z.string().optional(), identityId: z.string().optional(), field: z.enum(['value', 'checked', 'visible', 'enabled']).optional(), equals: z.json() }).strict();
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scrollProbe'), observationId: z.string().min(1), localId: z.string().min(1), options: scrollProbeSchema, requestId: z.string().trim().min(1) }).strict(),
  z.object({type:z.literal('supplementDiscovery'),scan:supplementDiscoverySchema}).strict(),
  z.object({type:z.literal('classifyControls'),classification:classifyControlsSchema}).strict(),
  z.object({type:z.literal('revokeControlClassification'),revocation:revokeControlClassificationSchema}).strict(),
  z.object({type:z.literal('reviewControls'),review:controlReviewSchema}).strict(),
  z.object({type:z.literal('reuseControlReviews'),review:reuseControlReviewsSchema}).strict(),
  z.object({type:z.literal('revokeControlReview'),revocation:revokeControlReviewSchema}).strict(),
  z.object({ type: z.literal('reviewBoundaryExit'), review: boundaryExitReviewSchema }).strict(),
  z.object({ type: z.literal('reviewRegions'), review: regionReviewSchema }).strict(),
  z.object({ type: z.literal('reuseRegionReviews'), review: reuseRegionReviewsSchema }).strict(),
  z.object({ type: z.literal('revokeRegionReuse'), revocation: revokeRegionReuseSchema }).strict(),
  z.object({ type: z.literal('reviewListPurpose'), review: listPurposeReviewSchema }).strict(),
  z.object({ type: z.literal('revokePurposeReview'), revocation: revokePurposeReviewSchema }).strict(),
  z.object({ type: z.literal('probe'), observationId: z.string().min(1), localId: z.string().min(1), kind: z.enum(['hover', 'focus']), requestId: z.string().trim().min(1) }).strict(),
  componentDescriptionSchema.extend({ type: z.literal('describeComponent') }),
  z.object({ type: z.literal('observe') }),
  z.object({ type: z.literal('inspect'), region: z.string() }),
  z.object({ type: z.literal('execute'), actionId: z.string(), requestId: z.string().min(1), value: z.union([z.string(), z.boolean(), z.number()]).optional() }),
  z.object({ type: z.literal('explore') }), z.object({ type: z.literal('pause') }), z.object({ type: z.literal('resume') }), z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('resolveIdentity'), hypothesisId: z.string(), identityId: z.string(), source: z.string().trim().min(1), evidence: z.array(z.string().trim().min(1)).min(1), guard: z.object({ observationId: z.string().min(1), revision: z.number().int().nonnegative(), scope: z.literal('historical').optional() }).strict().optional() }),
  z.object({ type: z.literal('decideExplorationGroups'), resolutions: explorationGroupResolutionsSchema }).strict(),
  z.object({ type: z.literal('decideExplorationGroup'), groupId: z.string().min(1), revision: z.number().int().positive(), decision: explorationGroupDecisionSchema }).strict(),
  z.object({ type: z.literal('openScope'), name: z.string().min(1), region: z.string() }),
  z.object({ type: z.literal('closeScope'), scopeId: z.string() }),
  z.object({ type: z.literal('createCheckpoint'), name: z.string().min(1), predicates: z.array(predicateSchema).default([]), acceptable: z.array(predicateSchema).default([]), retainEvidence: z.boolean().optional() }),
  z.object({ type: z.literal('reachCheckpoint'), checkpointId: z.string() }),
]);
export type Command = z.infer<typeof commandSchema>;
export const domQuerySchema = z.object({ fields: z.preprocess(v => typeof v === 'string' ? (v ? v.split(',') : []) : v, z.array(z.enum(['tag', 'text', 'attributes', 'rect', 'styles', 'properties', 'relations', 'layout', 'textLayout'])).max(9).optional()), rootId: z.string().min(1).optional(), depth: z.coerce.number().int().min(0).max(100).default(20), offset: z.coerce.number().int().min(0).max(50000).default(0), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).strict();
export const artifactKindSchema = z.enum(['screenshot', 'fullPageScreenshot', 'details']);
