import { z } from 'zod';
import { canonical } from '@interaction/core';
import type { ActionCandidate, Control, Observation, Rect } from './types.js';

export interface BoundaryExitCandidate {
  id: string; kind: 'outside-click'; boundaryKey: string; boundaryInstanceId: string;
  selector: string; instanceId: string; parentInstanceId: string; tag: string; text: string;
  attributes: Record<string, string>; rect: Rect; point: { x: number; y: number };
  viewport: { width: number; height: number }; boundaryRect: Rect; parentBoundaryInstanceId?: string;
  scroll: { x: number; y: number };
  boundaryStack: { key: string; kind: string; parentKey?: string; parentRegion: string; instanceId?: string; controlIds: string[]; exitControlIds: string[] }[];
  evidence: string[];
}
const text = z.string().trim().min(1);
export const boundaryExitReviewSchema = z.object({
  observationId: text, boundaryKey: text, source: text, evidence: z.array(text).min(1).max(100),
  decision: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('attempt'), candidateId: text, preserveControlIds: z.array(text).max(100).default([]) }).strict(),
    z.object({ mode: z.literal('defer') }).strict(),
  ]),
}).strict();
export type BoundaryExitReviewInput = z.input<typeof boundaryExitReviewSchema>;
export interface BoundaryExitReviewRecord {
  id: string; sessionId: string; observationId: string; episodeId: string; at: string;
  source: string; evidence: string[]; boundaryKey: string; decision: z.output<typeof boundaryExitReviewSchema>['decision'];
  status: 'approved' | 'deferred' | 'attempted' | 'invalidated';
  candidate?: BoundaryExitCandidate; preserved?: { localId: string; facts: string }[];
}
export interface BoundaryExitResult {
  id: string; sessionId: string; reviewId: string; attemptId: string; beforeId: string; afterId?: string;
  dispatched: string; closed: boolean; parentReady: boolean; preserved: boolean;
  status: 'verified' | 'not_closed' | 'changed' | 'unverified'; evidence: string[];
}
export interface BoundaryExitMaterial {
  sessionId: string; observationId: string; episodeId?: string; boundary?: NonNullable<Observation['overlays']>[number];
  candidates: (BoundaryExitCandidate & { attempted: boolean })[];
  exits: { actionId: string; label: string; kind: string; blockers: string[] }[];
  attempts: { id: string; label: string; status: string; afterId?: string; closed: boolean }[];
  results: BoundaryExitResult[]; review?: BoundaryExitReviewRecord;
  limitation: string;
}
export function preservedControlFacts(c: Control | undefined) {
  return c && canonical({ instance: c.instanceId, tag: c.tag, role: c.role, name: c.name, binding: c.reviewBinding,
    constraints: c.constraints, value: c.value, checked: c.checked, selected: c.selected, enabled: c.enabled, visible: c.visible });
}
export function exitCandidateKey(c: BoundaryExitCandidate) {
  // Prose labels are evidence; exact geometry, attributes and node ownership bind dispatch.
  const { text: _text, evidence: _evidence, attempted: _attempted, ...binding } = c as BoundaryExitCandidate & { attempted?: boolean };
  return canonical(binding);
}
export function dismissalReference(a: ActionCandidate) {
  return a.kind === 'dismiss' ? a.basis?.evidence.find(e => e.rule === 'reviewed-boundary-dismissal/v1') : undefined;
}
export function hasReviewedDismissal(a: ActionCandidate, o: Observation) {
  const ref = dismissalReference(a), candidate = o.boundaryExitCandidates?.find(c => c.id === ref?.facts.candidateId);
  return !!candidate && a.source === 'boundary-exit-review' && a.risk === 'interface' && !a.replayable
    && !a.localId && !a.controlId && a.value === candidate.id && a.basis?.status === 'supported'
    && ref?.facts.documentId === o.documentId && ref.facts.url === o.url && ref.facts.observationId === o.id && ref.facts.boundaryKey === o.boundaries?.at(-1)?.key
    && ref.facts.binding === exitCandidateKey(candidate) && typeof ref.facts.reviewId === 'string';
}
