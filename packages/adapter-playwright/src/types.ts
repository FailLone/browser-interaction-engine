import type { Control as CoreControl, Observation as CoreObservation, Session as CoreSession, EngineHooks as CoreHooks, HookContext as CoreHookContext, ControlIdentity as CoreIdentity } from '@interaction/core';
import type { ID, Context, ActionKind, ActionBasis, ActionEvidence, Gap, Json } from '@interaction/core';
import type { BrowserEvidenceManifest, EvidenceOptions } from './evidence-types.js';
export * from './evidence-types.js';
export * from '@interaction/core';
export interface Rect { x: number; y: number; width: number; height: number }
export interface Region { key: string; instanceId?: string; label: string; role: string; selector: string; parentKey?: string; rect: Rect; text: string }
export interface Overlay { key: string; name: string; kind: 'modal' | 'dialog' | 'popover' | 'menu' | 'listbox'; selector: string; parentKey?: string; parentRegion: string; evidence: string[]; controlIds: string[]; exitControlIds: string[] }
/** Browser navigation evidence; not a claim that the page/business state is equal. */
export interface BrowserHistory {
  browserSessionId: string; currentIndex: number;
  entries: { id: number; url: string; method?: string }[];
}
export interface Control extends CoreControl {
  localId: ID; instanceId: ID; identityId?: ID; hypothesisId?: ID;
  tag: string; role: string; name: string; label: string; stableKey?: string;
  region: string; regionInstanceId?: string; form: string; selector: string; rect: Rect;
  value: string; displayedText: string; checked: boolean | null; selected: string[];
  visible: boolean; enabled: boolean; editable: boolean; readOnly?: boolean;
  expanded: boolean | null; controls: string | null;
  constraints: { type: string; required: boolean; min?: string; max?: string; step?: string; pattern?: string; minLength?: number; maxLength?: number; valid: boolean };
  options: { value: string; label: string; disabled: boolean }[];
  actions: ActionKind[]; discovery: string[];
  /** Native element scroll viewport; document scrolling is recorded separately. */
  scroll?: { x: number; y: number; maxX: number; maxY: number; width: number; height: number };
  /** Keyed by action kind. Optional only for observations written by older adapters. */
  actionBasis?: Record<ActionKind, ActionBasis>;
  interactionHints?: ActionEvidence[];
  /** Observed semantic list owner. Similarity is a scheduling hint, not shared business behavior. */
  list?: { instanceId: string; role: string; label: string; selector: string };
  /** Dispatch-related DOM facts used to bound an external purpose judgment. */
  purposeBinding?: { attributes: Record<string, string>; form?: { instanceId: string; action: string; method: string; target: string } };
  /** Exact control-review binding, independent of list-purpose similarity. */
  reviewBinding?: { parentInstanceId: string; attributes: Record<string, string>; form?: { instanceId: string; action: string; method: string; target: string } };
  /** Bounded subtree evidence for classifying weak candidates; truncation prevents negative classification. */
  classificationBinding?: { nodes: { instanceId: string; parentInstanceId: string; tag: string; attributes: Record<string, string> }[]; text: string; truncated: boolean };
  structuralItem?: { ownerInstanceId:string; template:string; slot:string; rowInstanceId:string; recordKey?:string };
  actionable: { visible: boolean; enabled: boolean; editable: boolean; hitTarget: boolean | null; clickPoint?: { x: number; y: number }; occludedBy?: string; outsideScrollableArea?: boolean; unknown: string[] };
}
export interface RegionCandidate {
  id: string; label: string; selector: string; parentId?: string; controlIds: string[]; rect: Rect;
  basis: 'heading' | 'semantic' | 'layout' | 'document'; suggested?: boolean; binding: Json; evidence: ActionEvidence[];
}
export interface StructuralListCandidate {
  ownerInstanceId:string; ownerSelector:string; label:string; template:string; binding:Json;
  members:{localId:string;rowInstanceId:string;slot:string;recordKey?:string}[];
  traversalLocalIds:string[]; evidence:ActionEvidence[];
}
export interface RegionReviewInput {
  observationId: string; source: string; evidence: string[];
  regions: { key: string; label: string; candidateIds: string[]; controlIds?: string[]; pageTraversal?: boolean }[];
  rejectedCandidateIds?: string[];
}
export interface RegionReviewRecord {
  id: string; sessionId: string; observationId: string; instanceScope: string; url: string; contextKey: string; at: string;
  source: string; evidence: string[]; status: 'active' | 'invalidated' | 'superseded'; rejectedCandidateIds: string[];
  regions: { key: string; label: string; controlIds: string[]; pageTraversal: boolean; anchors: { id: string; fingerprint: string }[]; status: 'active' | 'invalidated'; invalidation?: { observationId: string; reason: string } }[];
}
export interface RegionReviewMaterial {
  sessionId: string; observationId: string; enabled: boolean; candidates: RegionCandidate[];
  controls: { localId: string; label: string; role: string; actionKinds: string[] }[];
  review?: RegionReviewRecord; unassignedControlIds: string[]; unassignedPageTraversal: boolean;
}
export interface Observation extends CoreObservation<Control> {
  id: ID; sessionId: ID; capturedAt: string; screenshotAt?: string;
  url: string; title: string; text: string; viewport: { width: number; height: number }; scroll: { x: number; y: number; maxY: number };
  documentId: string; controls: Control[]; regions: Region[]; context: Context;
  overlays?: Overlay[];
  navigation?: BrowserHistory;
  regionCandidates?: RegionCandidate[];
  structuralLists?: StructuralListCandidate[];
  actionDiscovery?: { version: 'dom-actions-v2'; documentHints: ActionEvidence[] };
  screenshot?: string; gaps: Gap[]; stable: boolean;
  evidence?: BrowserEvidenceManifest;
  stateId: ID; visitId: ID; fingerprint: string; canonical: string; ruleVersion: 'observable-v1' | 'observable-v2' | 'observable-v3';
  cause: 'initial' | 'action' | 'inspection' | 'recovery' | 'external';
}
export interface ContextRule { key: string; selector: string; attribute?: string; required?: boolean }
export interface MatchRule { role?: string; name?: string; stableKey?: string; kind?: ActionKind; urlIncludes?: string }
export interface SessionOptions {
  url: string; headless: boolean; viewport: { width: number; height: number };
  maxActions: number; maxDepth: number; maxDurationMs: number;
  actionTimeoutMs: number; settleMs: number; observeTimeoutMs: number;
  evidence: EvidenceOptions;
  inspection?: import('./inspection-contract.js').InspectionOptions;
  evidenceRetention?: import('@interaction/core').EvidenceRetentionPolicy;
  exclude: MatchRule[]; replayable: MatchRule[]; context: Record<string, Json>; contextRules: ContextRule[];
  exploration?: 'controls' | 'representative' | 'stateful';
  /** New sessions defer repeated list members for an upper-layer decision. Legacy sessions without this field keep their existing policy. */
  listExploration?: 'review' | 'all';
  /** Entry page first; other pages require a scoped decision. Missing on legacy sessions means all. */
  pageExploration?: 'review' | 'all';
  /** Optional observed scopes that require upper-layer decisions before automatic exploration. */
  regionExploration?: 'off' | 'review';
  decisionScopes?: ('region' | 'branch' | 'input-space')[];
  /** Application declarations; never inferred from button labels. */
  interfaceActions?: MatchRule[];
  reversible?: MatchRule[];
  /** Caller asserts all relevant business state lives in this document. */
  environmentReset?: 'none' | 'document-reload';
  storageState?: string | { cookies: unknown[]; origins: unknown[] };
}

export type Session = CoreSession<SessionOptions>;
export type ControlIdentity = CoreIdentity<Control>;
export type HookContext = CoreHookContext<Observation, SessionOptions>;
export interface EngineHooks extends CoreHooks<Observation, SessionOptions> {
  controlClassification?: (material: import('./control-classification.js').ControlClassificationMaterial, ctx: HookContext) => Promise<import('./control-classification.js').ClassifyControlsInput | undefined> | import('./control-classification.js').ClassifyControlsInput | undefined;
  controlReview?: (material: import('./control-review.js').ControlReviewMaterial, ctx: HookContext) => Promise<import('./control-review.js').ControlReviewInput | undefined> | import('./control-review.js').ControlReviewInput | undefined;
  regionReview?: (material: RegionReviewMaterial, ctx: HookContext) => Promise<RegionReviewInput | undefined> | RegionReviewInput | undefined;
  samples?: (control: Control, ctx: HookContext) => Promise<(string | boolean)[] | undefined> | (string | boolean)[] | undefined;
}
