import { z } from 'zod';
import { hash } from '@interaction/core';
import { controlReviewConditions } from './control-review.js';
import type { ActionCandidate, Control, Observation } from './types.js';

const text = z.string().trim().min(1);
export const classificationEvidenceRefSchema=z.object({sessionId:text,observationId:text,classificationId:text,classification:z.enum(['display','container'])}).strict();
export const classifyControlsSchema = z.object({
  observationId: text, source: text,
  classifications: z.array(z.object({ localId: text,
    classification: z.enum(['interaction', 'display', 'container', 'probe_required', 'unresolved']),
    reason: text, evidence: z.array(text).min(1).max(100),
    reuseFrom: classificationEvidenceRefSchema.optional(),
  }).strict()).min(1).max(500),
}).strict();
export const revokeControlClassificationSchema = z.object({ classificationId: text, source: text, reason: text }).strict();
export type ClassifyControlsInput = z.infer<typeof classifyControlsSchema>;
export type RevokeControlClassificationInput = z.infer<typeof revokeControlClassificationSchema>;
export type ControlClassification = ClassifyControlsInput['classifications'][number];
export const isNonInteractiveClassification = (c: ControlClassification['classification']) => c === 'display' || c === 'container';

/** Instance-specific interpretation of observed material; never an execution grant. */
export function controlClassificationConditions(c: Control, o: Observation) {
  const target = controlReviewConditions(c, o, 'classification');
  if (!target) return;
  return { version: 'control-classification/v1' as const, target,
    basis: c.actionBasis, hints: c.interactionHints, structure: c.classificationBinding,
    editable: c.editable, options: c.options };
}
export const controlClassificationKey = (c: NonNullable<ReturnType<typeof controlClassificationConditions>>) => hash(c);
export interface ControlClassificationRecord extends ControlClassification {
  id: string; sessionId: string; observationId: string; source: string; at: string;
  conditions: NonNullable<ReturnType<typeof controlClassificationConditions>>; conditionKey: string;
  status: 'active' | 'invalidated' | 'revoked' | 'superseded'; replacedBy?: string;
  invalidation?: { observationId: string; reason: string; at: string };
  revocation?: { source: string; reason: string; at: string };
}
export function classificationMatches(r: ControlClassificationRecord, c: Control, o: Observation) {
  const conditions = controlClassificationConditions(c, o);
  return r.sessionId === o.sessionId && r.status === 'active' && !!conditions && r.conditionKey === controlClassificationKey(conditions);
}
export interface ControlClassificationMaterial {
  sessionId: string; observationId: string; url: string; instanceScope: string; context: Observation['context']; gaps: Observation['gaps'];
  controls: { control: Control; actions: ActionCandidate[]; classifications: ControlClassificationRecord[]; needsClassification: boolean }[];
  pendingControlIds: string[];
}
