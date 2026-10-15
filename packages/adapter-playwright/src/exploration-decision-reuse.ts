import { z } from 'zod';
import type { ExplorationGroupDecision, Json, RegionReuseConditions } from './types.js';
const text = z.string().trim().min(1);
export const reviewExplorationDecisionReuseSchema = z.object({ observationId: text, groupId: text, revision: z.number().int().positive(), businessScope: text, source: text, evidence: z.array(text).min(1) }).strict();
export const reuseExplorationDecisionsSchema = z.object({ observationId: text, businessScope: text, source: text, evidence: z.array(text).min(1),
  decisions: z.array(z.object({ reviewId: text, groupId: text, revision: z.number().int().positive(), conditionKey: text }).strict()).min(1).max(1000) }).strict();
export const revokeExplorationDecisionReuseSchema = z.object({ reviewId: text, source: text, reason: text }).strict();
export type ReviewExplorationDecisionReuseInput = z.infer<typeof reviewExplorationDecisionReuseSchema>;
export type ReuseExplorationDecisionsInput = z.infer<typeof reuseExplorationDecisionsSchema>;
export type RevokeExplorationDecisionReuseInput = z.infer<typeof revokeExplorationDecisionReuseSchema>;
export interface ExplorationDecisionConditions {
  version: 'exploration-decision-reuse/v1'; region: RegionReuseConditions;
  operations: { signature: string; descriptor: Json }[];
}
export interface ExplorationDecisionReuseRecord {
  id: string; sessionId: string; observationId: string; at: string; source: string; evidence: string[]; businessScope: string;
  groupId: string; decisionRevision: number; decision: ExplorationGroupDecision; regionReviewId: string; regionKey: string;
  conditions: ExplorationDecisionConditions;
  members: { signature: string; actionId: string; memberKey?: string }[];
  parentReviewId?: string; revocation?: { source: string; reason: string; at: string };
}
export interface ExplorationDecisionReuseCandidate {
  reviewId: string; groupId: string; revision: number; conditionKey: string; businessScope: string;
  decision: ExplorationGroupDecision; conditions: ExplorationDecisionConditions;
  mapping: { signature: string; previousActionId: string; previousMemberKey?: string; actionId: string; memberKey?: string; label: string; kind: string; value?: Json; selected: boolean }[];
}
export interface ExplorationDecisionReuseMaterial {
  sessionId: string; observationId: string; candidates: ExplorationDecisionReuseCandidate[];
  unavailable: { groupId: string; reviewId?: string; reason: string; next: 'fresh_decision' | 'review_region' | 'review_purpose' }[];
  /** Registration is separate from a one-time depth decision. */
  reusableGroupIds: string[];
}
export interface ExplorationDecisionReuseApplication {
  id: string; sessionId: string; observationId: string; groupId: string; decisionRevision: number;
  reviewId: string; conditionKey: string; conditions: ExplorationDecisionConditions; members: { signature: string; actionId: string }[]; at: string; source: string; evidence: string[];
}
