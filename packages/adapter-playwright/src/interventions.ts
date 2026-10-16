import type { z } from 'zod';
import type { continuationSchema, interventionResponseSchema } from './schema.js';
import type { Observation } from './types.js';

export type InterventionResponseInput = z.input<typeof interventionResponseSchema>;
export type ContinueExplorationInput = z.input<typeof continuationSchema>;
export interface Intervention {
  id: string; conditionKey: string;
  kind: 'observation' | 'boundary' | 'region' | 'control' | 'exploration' | 'identity' | 'recovery' | 'environment' | 'discovery' | 'execution' | 'budget';
  title: string; reason: string; status: 'awaiting_decision' | 'deferred' | 'skipped' | 'blocked' | 'failed';
  current: boolean; blocking: 'session' | 'work' | 'none'; priority: number;
  dependsOn: string[];
  affected: { frontierIds: string[]; controlIds: string[]; groupIds: string[]; attemptIds: string[] };
  evidence: { observationIds: string[]; recordIds: string[]; messages: string[] };
  /** Existing protocols remain authoritative. No option grants permission by itself. */
  options: { command: string; label: string; effect: string }[];
  material: { resource: string; subjectId?: string }[];
  /** Exact source IDs for binding responses; never a guessed semantic identity. */
  subject: { groupId?: string; localIds?: string[]; hypothesisId?: string; checkpointId?: string; boundaryKey?: string; resultId?: string };
}
export interface InterventionMaterial {
  version: 'interventions/v1'; sessionId: string; observationId: string; revision: string;
  items: Intervention[]; readyIds: string[]; sessionBlockerIds: string[];
  changes: { added: string[]; changed: string[]; retired: string[] };
  limitation: string;
}
export interface InterventionResponseRecord {
  id: string; sessionId: string; requestId: string; input: InterventionResponseInput;
  at: string; finishedAt?: string; observationId?: string;
  status: 'queued' | 'applying' | 'applied' | 'rejected' | 'interrupted';
  outcome?: { recordIds: string[]; status?: string };
  error?: { code: string; message: string };
}
export interface ContinuationRecord {
  /** UI-state verification never certifies effects excluded from the exploration contract. */
  verificationScope?: 'observed-ui';
  id: string; sessionId: string; requestId: string; input: ContinueExplorationInput; at: string;
  status: 'queued' | 'verifying' | 'started' | 'needs_review' | 'failed' | 'interrupted';
  beforeId: string; afterId?: string; finishedAt?: string; started: boolean;
  checks: { name: string; result: 'pass' | 'fail' | 'unknown'; evidence?: string[] }[];
  changes?: { document: boolean; url: boolean; context: boolean; added: string[]; changed: string[]; retired: string[] };
  verifiedRecovery?: { attemptIds: string[]; boundaryResultId?: string; evidence: string[] };
  error?: { code: string; message: string };
}
export interface ExternalRecoveryVerification {
  request: ContinueExplorationInput;
  before: Observation;
  /** Includes interrupted operations; a pass confirms a safe continuation basis,
   * not the success of those operations or permission to replay them. */
  attemptIds: string[];
  boundaryResultId?: string;
}
