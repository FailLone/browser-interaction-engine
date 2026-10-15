import { z } from 'zod';
import { hash } from '@interaction/core';
import type { ActionCandidate, Control, Observation } from './types.js';

const text = z.string().trim().min(1);
export const listPurposeReviewSchema = z.object({
  groupId: text, revision: z.number().int().positive(), observationId: text, conditionKey: text,
  purpose: text, businessScope: text, source: text, evidence: z.array(text).min(1),
  risk: z.literal('interface'), reuse: z.literal('matching-list-members'),
}).strict();
export type ListPurposeReviewInput = z.infer<typeof listPurposeReviewSchema>;
export const revokePurposeReviewSchema = z.object({ reviewId: text, source: text, reason: text }).strict();
export type RevokePurposeReviewInput = z.infer<typeof revokePurposeReviewSchema>;

/** Equality of these observed conditions is necessary, never proof of a business purpose. */
export function purposeConditions(a: ActionCandidate, c: Control, o: Observation) {
  if (!c.list || !c.purposeBinding || o.gaps.some(g => g.critical) || Object.values(o.context).some(v => v.status !== 'known')) return;
  const selection = c.list.role === 'select' && a.kind === 'select';
  const option = c.list.role === 'listbox' && a.kind === 'click' && ['button', 'option'].includes(c.role);
  const basis = c.actionBasis?.[a.kind];
  if ((!selection && !option) || a.boundary?.intent === 'exit' || a.risk === 'submission' || basis?.status !== 'supported'
    || basis.evidence.some(e => e.facts.submitsForm === true || e.rule === 'hyperlink/v1')) return;
  const regions: { key: string; role: string; label: string; parentKey?: string }[] = [];
  let region = o.regions.find(r => r.key === c.region);
  while (region && !regions.some(r => r.key === region!.key)) {
    regions.push({ key: region.key, role: region.role, label: region.label, parentKey: region.parentKey });
    region = o.regions.find(r => r.key === region!.parentKey);
  }
  const { valid: _valid, ...constraints } = c.constraints;
  return {
    scope: { url: o.url, instanceScope: o.instanceScope, context: o.context, owner: c.list },
    structure: { kind: a.kind, tag: c.tag, role: c.role, form: c.form, regions, constraints, readOnly: c.readOnly,
      binding: c.purposeBinding, basis, boundaries: o.boundaries?.map(b => ({ key: b.key, name: b.name })) || [] },
  };
}
export type PurposeConditions = NonNullable<ReturnType<typeof purposeConditions>>;
export const purposeConditionKey = (conditions: PurposeConditions) => hash(conditions);
export interface PurposeReviewMaterial {
  sessionId: string; groupId: string; revision: number; observationId: string;
  variations: ['member-instance', 'option-label', 'option-value'];
  conditions: { key: string; conditions: PurposeConditions; members: { actionId: string; localId: string; label: string; value?: ActionCandidate['value']; risk: ActionCandidate['risk']; excluded: boolean }[] }[];
}
export interface PurposeReview extends ListPurposeReviewInput {
  id: string; sessionId: string; at: string; status: 'active' | 'invalidated' | 'revoked' | 'superseded';
  conditions: PurposeConditions; sourceActionIds: string[];
  replacedBy?: string;
  invalidation?: { at: string; observationId: string; reason: string };
  revocation?: { at: string; source: string; reason: string };
}
