import type { EvidenceAvailability, EvidenceStore } from '@interaction/core';
import type { Observation } from '@interaction/adapter-playwright';

export type EvidenceKind = 'screenshot' | 'fullPageScreenshot' | 'details';
export type ArtifactAvailability = EvidenceAvailability | { status: 'not_captured'; reason: string };
export interface ObservationEvidenceAvailability {
  observationId: string;
  /** Current storage status, not a fact about the historical page. This is not a lease. */
  checkedAt: string;
  artifacts: Record<EvidenceKind, { key?: string; capturedAt?: string; availability: ArtifactAvailability }>;
}

/** Shared by diff and evidence queries; no browser access, pinning or detail JSON hydration. */
export async function inspectObservationEvidence(store: EvidenceStore, observation: Observation): Promise<ObservationEvidenceAvailability> {
  const artifacts = {} as ObservationEvidenceAvailability['artifacts'];
  for (const kind of ['screenshot', 'fullPageScreenshot', 'details'] as const) {
    const ref = observation.evidence?.artifacts[kind];
    const key = ref?.key || (kind === 'screenshot' ? observation.screenshot : undefined);
    let availability: ArtifactAvailability;
    if (!key) availability = { status: 'not_captured', reason: `${kind} has no captured reference in this observation` };
    else {
      try {
        if (store.availability) availability = await store.availability(key);
        else {
          const evidence = await store.get(key);
          availability = evidence ? { status: 'available', bytes: evidence.data.byteLength } : { status: 'missing', reason: 'Referenced evidence was not found in the selected store' };
        }
        availability = { durability: store.durability || 'unknown', ...availability };
      } catch (error) { availability = { status: 'storage_failed', reason: String(error), durability: store.durability || 'unknown' }; }
    }
    artifacts[kind] = { key, capturedAt: ref?.capturedAt || (kind === 'screenshot' ? observation.screenshotAt : undefined), availability };
  }
  return { observationId: observation.id, checkedAt: new Date().toISOString(), artifacts };
}
