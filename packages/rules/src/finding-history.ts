import type { Json } from '@interaction/adapter-playwright';
import type { RuleCheck } from './types.js';

/** A bounded, immutable copy of the actual finding, independent of whether the
 * next capture can recheck it. Never recursively copy tracker bookkeeping. */
export function findingSnapshot(check: RuleCheck, captureId: string, label: string): Json {
  return JSON.parse(JSON.stringify({ captureId, label, ...check })) as Json;
}

export function currentCaptureOnly(check: RuleCheck): RuleCheck {
  return { ...check, facts: { ...check.facts, identityId: null, tracking: 'current-capture-only', trackingReason: 'IDENTITY_UNCERTAIN' } };
}

/** Observation and compliance are independent: an observed warning may still
 * have an unknown verdict because no product requirement has been supplied.
 * Historical findings retain their original evidence without requesting a
 * revisit or implying that a closed scope has recovered. */
export function observationStatus(currentFinding: boolean, hasFinding: boolean) {
  return currentFinding ? 'current' : hasFinding ? 'historical' : 'unavailable';
}
