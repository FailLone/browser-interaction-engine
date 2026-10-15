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

export const textRequirementProposalSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal('proposed'),
  ruleId: z.literal('text-truncation'), ruleVersion: z.literal('1.0.0'),
  target: requirementTargetSchema,
  requirement: z.enum(['full-text-inline', 'allow-elision', 'full-text-via-alternative']),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('project-specification'), reference: z.string().trim().min(1).max(2000) }).strict(),
    z.object({ kind: z.literal('agent-judgment'), agentId: z.string().trim().min(1).max(200), basis: z.enum(['cited-specification', 'inference']) }).strict(),
  ]),
  reason: z.string().trim().min(1).max(4000),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(32),
}).strict();
export type TextRequirementProposal = z.infer<typeof textRequirementProposalSchema>;

export interface RuleRequirementQuery {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly target: Readonly<RequirementTarget>;
  /** Historical assessment, not a browser handle or trusted page instructions. */
  readonly assessment: Readonly<RuleCheck>;
}
export interface RuleRequirementProvider<TProposal> {
  readonly id: string;
  readonly version: string;
  propose(query: RuleRequirementQuery, signal: AbortSignal): Promise<readonly TProposal[]>;
}
export type TextRequirementProvider = RuleRequirementProvider<TextRequirementProposal>;

// No provider registry, document reader, model invocation, conflict resolver or
// acceptance evaluator is supplied in v1. RuleRunner never calls this interface.
