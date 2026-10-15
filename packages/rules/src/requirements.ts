import { z } from 'zod';
import type { RuleCheck } from './types.js';

/** Future integration contract only. Providers propose; the host must separately
 * verify authority, scope, binding and conflicts before accepting a requirement. */
export const requirementTargetSchema = z.object({
  sessionId: z.string().min(1), observationId: z.string().min(1), captureId: z.string().min(1),
  documentId: z.string().min(1), nodeId: z.string().min(1), instanceId: z.string().min(1),
  identityId: z.string().min(1).optional(), scopeId: z.string().min(1).optional(),
}).strict();
export type RequirementTarget = z.infer<typeof requirementTargetSchema>;

/** A source is a claim to be verified, not an authority or execution grant. */
export const requirementSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project-specification'), reference: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('agent-judgment'), agentId: z.string().trim().min(1).max(200), basis: z.enum(['cited-specification', 'inference']) }).strict(),
]);
export type RequirementSource = z.infer<typeof requirementSourceSchema>;

/** Common envelope only; a complete proposal also needs a supported rule/version
 * and that rule's requirement. Parsing this shape never accepts the requirement. */
export const requirementProposalBaseSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal('proposed'),
  target: requirementTargetSchema,
  source: requirementSourceSchema,
  reason: z.string().trim().min(1).max(4000),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(32),
}).strict();
export type RequirementProposalBase = z.infer<typeof requirementProposalBaseSchema>;

/** The history rule owns this contract. The one-point sampled-occlusion rule
 * does not establish a five-point requirement or a cross-observation failure. */
export const occlusionRequirementProposalSchema = requirementProposalBaseSchema.extend({
  ruleId: z.literal('observed-occlusion'), ruleVersion: z.literal('1.0.0'),
  requirement: z.literal('sampled-pointer-at-observed-position'),
}).strict();
export type OcclusionRequirementProposal = z.infer<typeof occlusionRequirementProposalSchema>;

export const clippingRequirementProposalSchema = requirementProposalBaseSchema.extend({
  ruleId: z.literal('clipped-control'), ruleVersion: z.literal('1.0.0'),
  requirement: z.literal('unclipped-by-nonscroll-container'),
}).strict();
export type ClippingRequirementProposal = z.infer<typeof clippingRequirementProposalSchema>;

// Keep the existing text proposal's wire format and export names compatible.
export const textRequirementProposalSchema = requirementProposalBaseSchema.extend({
  ruleId: z.literal('text-truncation'), ruleVersion: z.literal('1.0.0'),
  requirement: z.enum(['full-text-inline', 'allow-elision', 'full-text-via-alternative']),
}).strict();
export type TextRequirementProposal = z.infer<typeof textRequirementProposalSchema>;

/** Built-in proposals only. The discriminant prevents cross-rule requirements
 * and unknown versions from being silently reinterpreted. */
export const ruleRequirementProposalSchema = z.discriminatedUnion('ruleId', [
  occlusionRequirementProposalSchema, clippingRequirementProposalSchema, textRequirementProposalSchema,
]);
export type RuleRequirementProposal = z.infer<typeof ruleRequirementProposalSchema>;

export interface RuleRequirementQuery {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly target: Readonly<RequirementTarget>;
  /** Historical assessment, not a browser handle or trusted page instructions. */
  readonly assessment: Readonly<RuleCheck>;
}
export interface RuleRequirementProvider<TProposal = RuleRequirementProposal> {
  readonly id: string;
  readonly version: string;
  propose(query: RuleRequirementQuery, signal: AbortSignal): Promise<readonly TProposal[]>;
}
export type OcclusionRequirementProvider = RuleRequirementProvider<OcclusionRequirementProposal>;
export type ClippingRequirementProvider = RuleRequirementProvider<ClippingRequirementProposal>;
export type TextRequirementProvider = RuleRequirementProvider<TextRequirementProposal>;

// No provider registry, document reader, model invocation, conflict resolver or
// acceptance evaluator is supplied in v1. Neither RuleRunner nor a tracker calls
// providers or converts proposals into their existing explicit requirements.
