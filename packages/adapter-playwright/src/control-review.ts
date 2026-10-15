import { z } from 'zod';
import { hash } from '@interaction/core';
import type { ActionCandidate, Control, Observation } from './types.js';

const text = z.string().trim().min(1);
export const controlJudgmentSchema = z.object({
  localId: text, kind: z.enum(['click', 'fill', 'select', 'check', 'press', 'hover']),
  risk: z.enum(['interface', 'unknown']), replayable: z.boolean().default(false),
  reason: text, evidence: z.array(text).min(1).max(100),
  samples: z.array(z.union([z.string(), z.boolean()])).min(1).max(100).optional(), exitBoundary: text.optional(),
  reuse: z.object({ binding: z.literal('same-url-context'), businessScope: text }).strict().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.samples && (['click', 'hover'].includes(v.kind) || v.samples.some(s => typeof s !== (v.kind === 'check' ? 'boolean' : 'string')))) {
    ctx.addIssue({code:'custom',message:'Samples must match the operation: check uses booleans; fill/select/press use strings'});
  }
  if (v.kind === 'press' && !v.samples?.length) ctx.addIssue({code:'custom',message:'A key operation requires explicit key samples'});
  if (v.exitBoundary && (v.kind !== 'click' || v.risk !== 'interface')) ctx.addIssue({code:'custom',message:'A boundary exit requires an interface click'});
  if (v.reuse && (v.risk !== 'interface' || v.exitBoundary)) ctx.addIssue({code:'custom',message:'Only interface purposes without boundary exit grants may be reusable'});
});
export const controlReviewSchema = z.object({observationId:text,source:text,reviews:z.array(controlJudgmentSchema).min(1).max(500)}).strict();
export const revokeControlReviewSchema = z.object({reviewId:text,source:text,reason:text}).strict();
export type ControlJudgment = z.infer<typeof controlJudgmentSchema>;
export type ControlReviewInput = z.input<typeof controlReviewSchema>;
export type RevokeControlReviewInput = z.infer<typeof revokeControlReviewSchema>;
export const reuseControlReviewsSchema = z.object({
  observationId: text, source: text, businessScope: text, evidence: z.array(text).min(1).max(100),
  reviews: z.array(z.object({ reviewId: text, localId: text, conditionKey: text }).strict()).min(1).max(500),
}).strict();
export type ReuseControlReviewsInput = z.infer<typeof reuseControlReviewsSchema>;

/** A comparison, not an identity claim. Mutable UI values still require live validation. */
export function controlReuseConditions(c: Control, o: Observation, kind: string) {
  const exact = controlReviewConditions(c, o, kind);
  if (!exact || !c.reviewReuseBinding || !c.visible || c.list || c.structuralItem || o.boundaries?.length
    || c.actionBasis?.[kind]?.evidence.some(e => e.facts.submitsForm === true)) return;
  const { instanceId: _instance, regionInstanceId: _region, binding, ...target } = exact.target;
  const { parentInstanceId: _parent, form, ...attributes } = binding;
  return { version: 'control-review-reuse/v1' as const, url: o.url, context: o.context, kind,
    target: { ...target, selector: c.selector, reviewAttributes: c.reviewAttributes || {},
      binding: { ...attributes, form: form && { action: form.action, method: form.method, target: form.target } },
      ancestry: c.reviewReuseBinding } };
}
export type ControlReuseConditions = NonNullable<ReturnType<typeof controlReuseConditions>>;

/** Exact observed target and dispatch conditions; values/selection/geometry are validated separately. */
export function controlReviewConditions(c: Control, o: Observation, kind: string, exitBoundary?: string) {
  if (!c.reviewBinding || o.gaps.some(g => g.critical) || Object.values(o.context).some(v => v.status !== 'known')) return;
  const { valid: _valid, ...constraints } = c.constraints;
  return { version: 'control-review/v1' as const, instanceScope:o.instanceScope,url:o.url,context:o.context,
    target:{instanceId:c.instanceId,tag:c.tag,role:c.role,name:c.name,label:c.label,stableKey:c.stableKey,
      region:c.region,regionInstanceId:c.regionInstanceId,form:c.form,list:c.list,structuralItem:c.structuralItem,readOnly:c.readOnly,constraints,
      binding:c.reviewBinding,basis:c.actionBasis?.[kind]},kind,exitBoundary };
}
export type ControlReviewConditions = NonNullable<ReturnType<typeof controlReviewConditions>>;
export const controlReviewKey = (c: ControlReviewConditions) => hash(c);
export interface ControlReviewRecord extends ControlJudgment {
  id:string;sessionId:string;observationId:string;source:string;at:string;
  status:'active'|'invalidated'|'revoked'|'superseded';conditions:ControlReviewConditions;conditionKey:string;
  replacedBy?:string;invalidation?:{observationId:string;reason:string;at:string};revocation?:{source:string;reason:string;at:string};
  reuseConditions?: ControlReuseConditions;
  reusedFrom?: { reviewId: string; conditionKey: string; evidence: string[] };
}
export interface ControlReviewMaterial {
  sessionId:string;observationId:string;url:string;instanceScope:string;context:Observation['context'];gaps:Observation['gaps'];
  controls:{control:Control;actions:ActionCandidate[];reviews:ControlReviewRecord[];needsReview:boolean;
    reuseCandidates?: { review: ControlReviewRecord; conditionKey: string; conditions: ControlReuseConditions }[] }[];
  pendingControlIds:string[];
}
