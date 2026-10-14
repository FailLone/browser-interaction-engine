import type { CaptureProfile, EvidenceArtifact, EvidenceAvailability, Gap, PageEnvironment } from '@interaction/adapter-playwright';
export interface EvidenceComponent {
  kind: string; schemaVersion: 1; collector: { id: string; version: 1 };
  status: 'captured' | 'partial' | 'unavailable' | 'unsupported'; capturedAt?: string;
  coverage: 'main-document-light-dom' | 'viewport' | 'session-runtime'; artifact?: EvidenceArtifact; gaps: Gap[];
}
export interface Capture {
  id: string; sessionId: string; protocolVersion: 1; observationId?: string; attemptId?: string; documentId: string;
  capturedAt: string; phase: 'settled' | 'intermediate' | 'timeout'; profile: CaptureProfile;
  /** Reserved for future sampled captures, which need not create a UIState. */
  segmentId?: string; sampleIndex?: number; timeWindow?: { from: string; to: string }; samplingGaps?: Gap[];
  environment?: PageEnvironment;
  components: EvidenceComponent[]; quality: { status: 'complete' | 'incomplete'; missingRequired: string[]; gaps: Gap[] };
  coordinates: { unit: 'css-px'; origin: 'layout-viewport'; screenshot: 'viewport-image'; consistency: 'components_have_individual_timestamps' };
}
export interface InspectionBaseline {
  role: 'previous' | 'scopeEntry' | 'actionBefore'; captureId?: string;
  comparison: 'comparable' | 'incomparable' | 'missing'; reason?: string;
}
export interface Inspection {
  id: string; sessionId: string; protocolVersion: 1; captureId: string; observationId: string; sequence: number;
  createdAt: string; reasons: ('initial' | 'scope_entered' | 'scope_exited' | 'after_action' | 'navigation' | 'observed_update' | 'manual' | 'environment_changed')[];
  focus: { regionKey: string; rootIds: string[]; scopeId?: string; kind: 'document' | 'overlay'; confidence: 'observed' | 'unknown'; relatedRegions: string[] };
  baselines: InspectionBaseline[]; requirements: CaptureProfile; quality: Capture['quality'];
}
export interface InspectionResult {
  ruleId: string; ruleVersion: string; status: 'pass' | 'fail' | 'inconclusive' | 'unsupported';
  message: string; nodeIds?: string[]; evidence?: string[];
}
export interface InspectionDelivery {
  id: string; sessionId: string; inspectionId: string; captureId: string; consumerId: string;
  status: 'pending' | 'completed' | 'expired' | 'unavailable' | 'cancelled';
  createdAt: string; leaseUntil: string; maxLeaseUntil: string; receivedAt?: string; completedAt?: string;
  reason?: string; results?: InspectionResult[]; owner: string; keys: string[];
}
export interface CaptureAvailability { kind: string; availability: EvidenceAvailability }

export interface InspectionEventData {
  'inspection.ready': { protocolVersion: 1; inspectionId: string; captureId: string; observationId: string; reasons: Inspection['reasons']; focus: Inspection['focus']; quality: Capture['quality']; deliveries: Pick<InspectionDelivery, 'consumerId' | 'status' | 'leaseUntil'>[] };
  'inspection.failed': { protocolVersion: 1; observationId: string; reason: string };
  'inspection.delivery_gap': { protocolVersion: 1; inspectionId: string; consumerId: string; status: InspectionDelivery['status']; reason?: string };
  'inspection.completed': { protocolVersion: 1; inspectionId: string; captureId: string; consumerId: string; results: InspectionResult[] };
  'inspection.cancelled': { protocolVersion: 1; inspectionId: string; consumerId: string };
}
export type InspectionEvent = { [K in keyof InspectionEventData]: Omit<import('@interaction/core').EngineEvent, 'type' | 'data'> & { type: K; data: InspectionEventData[K] } }[keyof InspectionEventData];
