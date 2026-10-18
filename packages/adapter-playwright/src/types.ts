import type { Control as CoreControl, Observation as CoreObservation, Session as CoreSession, EngineHooks as CoreHooks, HookContext as CoreHookContext, ControlIdentity as CoreIdentity } from '@interaction/core';
import type { ID, Context, ActionKind, ActionBasis, ActionEvidence, Gap as CoreGap, Json, InteractionComponent } from '@interaction/core';
import type { BrowserEvidenceManifest, EvidenceOptions } from './evidence-types.js';
export * from './evidence-types.js';
export * from '@interaction/core';
export interface Rect { x: number; y: number; width: number; height: number }
export interface Gap extends CoreGap {
  /** Current captured DOM scope only; no claim about hidden JS dependencies. */
  coverageScope?:{version:'dom-subtree-v1';documentId:string;rootInstanceId:string;ancestorInstanceIds:string[];affectedControlIds:string[];complete:boolean;landmark?:'banner'|'navigation'};
}
export interface Region { key: string; instanceId?: string; label: string; role: string; selector: string; parentKey?: string; rect: Rect; text: string }
export interface Overlay { key: string; name: string; kind: 'modal' | 'dialog' | 'popover' | 'menu' | 'listbox'; selector: string; parentKey?: string; parentRegion: string; evidence: string[]; controlIds: string[]; exitControlIds: string[] }
/** Browser navigation evidence; not a claim that the page/business state is equal. */
export interface BrowserHistory {
  browserSessionId: string; currentIndex: number;
  entries: { id: number; url: string; method?: string }[];
}
export interface BrowserComponent extends InteractionComponent { rootNodeId: string; rect: Rect }
/** Bounds on raw capture, never permission to omit dependencies from a proof. */
export interface OwnerDependencyLimits { nodes: number; references: number; bytes: number; depth: number }
export interface OwnerDependencyNode {
  id: string; parentId: string; tag: string; attributes: Record<string, string>;
  /** False for ancestor-only nodes or an incomplete child inventory. */
  childrenComplete: boolean;
  children?: ({ nodeId: string } | { text: string })[];
  /** Native properties may differ from their serialized HTML attributes. */
  live?: { value?: string; checked?: boolean; indeterminate?: boolean; selected?: boolean; disabled?: boolean; readOnly?: boolean; multiple?: boolean };
  /** Explicit native association inventories; empty formId/labelIds mean none,
   * rather than an omitted capture. Associated targets also have reference edges. */
  associations?: { formId?: string; labelIds?: string[] };
  resolved?: { href?: string; src?: string; action?: string; formAction?: string };
  complete: boolean; reasons: string[];
}
export interface OwnerDependencyReference {
  sourceId: string; attribute: string; token: string;
  status: 'unique' | 'missing' | 'ambiguous'; targetIds: string[];
  lookup?: { scope: 'document-light-dom'; documentId: string; matches: number };
}
export interface OwnerDependencyClosure {
  id: string; subtreeId: string; nodeIds: string[]; referenceIds: number[];
  /** All subtree roots, including transitive external IDREF targets. Ancestors
   * contribute their own attributes/references but not unrelated child trees. */
  subtreeIds: string[];
  complete: boolean; reasons: string[];
}
export interface OwnerDependencyRoot {
  localId: string; instanceId: string; ownerId: string; closureId: string;
  complete: boolean; reasons: string[];
}
/** Raw native field evidence only; never a logical control or action target. */
export type OwnerDependencyNativeRoot = Omit<OwnerDependencyRoot, 'localId'>;
/** Immutable raw DOM projection. A complete graph describes this bounded capture
 * contract, not arbitrary JavaScript/business state. Missing legacy evidence is
 * unknown. It never changes logical identity or grants coverage/replay/dispatch. */
export interface OwnerDependencies {
  version: 'browser-owner-dependencies-v1' | 'browser-owner-dependencies-v2'; documentId: string; baseURI: string;
  /** Complete inventory from retained controls, including hidden/unknown modes. */
  selectorIds: string[];
  /** Root/selector membership was retained in full. Unlike complete, this does
   * not require unrelated target roots to have complete local captures. */
  inventoryComplete: boolean;
  /** Required by v2: all light-DOM input/select/textarea instances, including
   * fields omitted from the action/control inventory. V1 proved no such omissions. */
  nativeInputIds?: string[];
  /** V2 roots only for native fields absent from controls. No identity grant. */
  nativeRoots?: OwnerDependencyNativeRoot[];
  roots: OwnerDependencyRoot[]; closures: OwnerDependencyClosure[];
  nodes: OwnerDependencyNode[]; references: OwnerDependencyReference[];
  limits: OwnerDependencyLimits;
  /** Summary of all roots; consumers must inspect each required root/closure. */
  complete: boolean; reasons: string[];
  ancestry?: 'node-bounded-v1';
}
/** IDs index a string dictionary, not necessarily a captured node. */
export type CompactOwnerDependencyNode = [number, number, string, Record<string, string>, boolean,
  (number | string)[] | null, OwnerDependencyNode['live'] | null, OwnerDependencyNode['resolved'] | null,
  [number | null, number[] | null] | null, boolean, string[]];
export type CompactOwnerDependencyRoot = [number, number, number, number, boolean, string[]];
export type CompactOwnerDependencyNativeRoot = [number, number, number, boolean, string[]];
export type CompactOwnerDependencyClosure = [number, number, number[], number[], number[], boolean, string[]];
export type CompactOwnerDependencyReference = [number, string, string, 0 | 1 | 2, number[], [number, number]?];
/** Compact transport only; decoding restores v2 raw dependency semantics. */
export interface CompactOwnerDependencies {
  version: 'browser-owner-dependencies-v3'; semanticVersion: 2; documentId: string; baseURI: string;
  inventoryComplete: boolean; complete: boolean; reasons: string[]; ancestry?: 'node-bounded-v1';
  limits: OwnerDependencyLimits; ids: string[]; selectorIds: number[]; nativeInputIds: number[];
  nodes: CompactOwnerDependencyNode[]; roots: CompactOwnerDependencyRoot[]; nativeRoots: CompactOwnerDependencyNativeRoot[];
  closures: CompactOwnerDependencyClosure[]; references: CompactOwnerDependencyReference[];
}
export type OwnerDependencySnapshot = OwnerDependencies | CompactOwnerDependencies;
/** Current-document navigation readiness only. Full bounded DOM bindings remain
 * evidence; this is neither portable identity nor permission to execute. */
export interface NavigationScopeSnapshot {
  rootId: string; controlIds: string[]; complete: boolean; reasons: string[];
  binding?: { markup: string; ancestors: {id:string;tag:string;attributes:Record<string,string>}[];
    references: {id:string;instanceId:string;markup:string}[] };
}
/** Last bounded DOM sample immediately before a native control command. This
 * binds retained source evidence to a dispatch, not an atomic input transaction
 * or an execution/replay grant. Missing legacy witnesses cannot be reconstructed. */
export interface OwnerDependencyDispatch {
  version: 'browser-owner-dispatch-v1';
  sessionId: string; beforeId: string; actionId: string; actionKey: string;
  graphKey: string; contextKey: string; documentId: string; instanceScope: string;
  browserSessionId: string; url: string; capturedAt: string;
}
export interface ScrollContainer {
  nodeId: string; selector: string; name: string; root: boolean; boundaryKey?: string;
  left: number; top: number; maxLeft: number; maxTop: number; width: number; height: number;
}
export interface Control extends CoreControl {
  /** Structural header/navigation containment, not a page label or logical identity. */
  landmark?:'banner'|'navigation';
  /** Current document ancestry for dependency checks, never portable identity. */
  domAncestry?:{documentId:string;instanceIds:string[];complete:boolean};
  /** Actual native HTML readOnly property. Missing in legacy observations;
   * aria-readonly alone never proves a noneditable native output. */
  nativeReadOnly?: boolean;
  localId: ID; instanceId: ID; identityId?: ID; hypothesisId?: ID;
  tag: string; role: string; name: string; label: string; stableKey?: string;
  region: string; regionInstanceId?: string; form: string; selector: string; rect: Rect;
  /** Comparison-only projection. Original names/text and all snapshots remain intact. */
  liveContent?: { name: string; text: string; evidence: ActionEvidence[] };
  /** Native form ownership, including fields associated through the form attribute. */
  formOwner?: { key: string; instanceId: string; action: string; method: string; target: string; isolated: boolean };
  /** Capture can be complete for independent operations while this target remains unsettled. */
  readiness?: { status: 'unstable'; reason: string };
  value: string; displayedText: string; checked: boolean | null; selected: string[];
  visible: boolean; enabled: boolean; editable: boolean; readOnly?: boolean;
  pressed?: boolean | 'mixed' | null;
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
  purposeBinding?: { attributes: Record<string, string>; runtimeEvents?: ActionEvidence[]; form?: { instanceId: string; action: string; method: string; target: string } };
  /** Exact control-review binding, independent of list-purpose similarity. */
  reviewBinding?: { parentInstanceId: string; attributes: Record<string, string>; runtimeEvents?: ActionEvidence[]; form?: { instanceId: string; action: string; method: string; target: string } };
  /** Conservative structural evidence for explicitly reusing a purpose in a new document. */
  reviewReuseBinding?: { ancestors: { tag: string; selector: string; attributes: Record<string, string>; label: string }[] };
  /** Bounded subtree evidence for classifying weak candidates; truncation prevents negative classification. */
  classificationBinding?: { nodes: { instanceId: string; parentInstanceId: string; tag: string; attributes: Record<string, string> }[]; text: string; truncated: boolean;
    /** Captured IDREF targets. Missing targets are explicit facts, not omitted evidence. */
    references?: {id:string;missing?:true;ambiguous?:true;targetInstanceId?:string;target?:{nodes:{instanceId:string;parentInstanceId:string;tag:string;attributes:Record<string,string>}[];text:string;truncated:boolean}}[] };
  structuralItem?: { ownerInstanceId:string; template:string; slot:string; rowInstanceId:string; recordKey?:string; recordEvidence?:ActionEvidence[] };
  /** Page-declared binding attributes, separate from generated identity metadata. */
  reviewAttributes?: Record<string, string>;
  actionable: { visible: boolean; enabled: boolean; editable: boolean; hitTarget: boolean | null; clickPoint?: { x: number; y: number }; occludedBy?: string; outsideScrollableArea?: boolean; unknown: string[] };
}
export interface RegionCandidate {
  id: string; label: string; selector: string; parentId?: string; controlIds: string[]; rect: Rect;
  basis: 'heading' | 'semantic' | 'layout' | 'document'; suggested?: boolean; binding: Json; evidence: ActionEvidence[];
  /** Bounded, instance-independent evidence; absent means no reusable partition proof. */
  reuseBinding?: Json;
}
export interface StructuralListCandidate {
  ownerInstanceId:string; ownerSelector:string; label:string; template:string; binding:Json;
  members:{localId:string;rowInstanceId:string;slot:string;recordKey?:string;recordEvidence?:ActionEvidence[]}[];
  traversalLocalIds:string[]; evidence:ActionEvidence[];
}
export interface RegionReusePolicy { binding: 'same-url-context'; businessScope: string }
export interface RegionReuseConditions { version: 'region-review-reuse/v1' | 'region-review-reuse/v2'; url: string; context: Context; anchors: { binding: Json; selectedIndices: number[] }[]; pageTraversal: boolean }
export interface ReuseRegionReviewsInput {
  observationId: string; baseReviewId: string; source: string; businessScope: string; evidence: string[];
  regions: { reviewId: string; regionKey: string; conditionKey: string }[];
}
export interface RevokeRegionReuseInput { reviewId: string; regionKey: string; source: string; reason: string }
export interface RegionReuseCandidate {
  reviewId: string; regionKey: string; label: string; businessScope: string; conditionKey: string; conditions: RegionReuseConditions;
  candidateIds: string[]; controlIds: string[]; pageTraversal: boolean;
}
export interface RegionReviewInput {
  observationId: string; source: string; evidence: string[];
  regions: { key: string; label: string; candidateIds: string[]; controlIds?: string[]; pageTraversal?: boolean; reuse?: RegionReusePolicy }[];
  rejectedCandidateIds?: string[];
  /** Omit for a full replacement. A patch explicitly replaces/removes only named regions. */
  update?: { baseReviewId: string; removeRegionKeys?: string[] };
}
export interface RegionReviewRecord {
  id: string; sessionId: string; observationId: string; instanceScope: string; url: string; contextKey: string; at: string;
  source: string; evidence: string[]; status: 'active' | 'invalidated' | 'superseded'; rejectedCandidateIds: string[];
  baseReviewId?: string;
  regions: { key: string; label: string; controlIds: string[]; pageTraversal: boolean; anchors: { id: string; fingerprint: string }[]; reviewId?: string; reuse?: RegionReusePolicy; reuseConditions?: RegionReuseConditions; reusedFrom?: { reviewId: string; regionKey: string; conditionKey: string; evidence: string[] }; reuseRevocation?: { source: string; reason: string; at: string }; status: 'active' | 'invalidated'; invalidation?: { observationId: string; reason: string } }[];
}
export interface RegionReviewDelta {
  baseReviewId: string; canUpdate: boolean; unchangedRegionKeys: string[];
  changedRegions: { key: string; label: string; reason: string; baselineAvailable: boolean;
    addedControlIds: string[]; removedControlIds: string[]; changedControlIds: string[];
    changedCandidateIds: string[]; missingCandidateIds: string[] }[];
}
export interface RegionReviewMaterial {
  sessionId: string; observationId: string; enabled: boolean; candidates: RegionCandidate[];
  controls: { localId: string; label: string; role: string; actionKinds: string[] }[];
  review?: RegionReviewRecord; delta?: RegionReviewDelta; reuseCandidates?: RegionReuseCandidate[]; unassignedControlIds: string[]; unassignedPageTraversal: boolean;
}
export interface Observation extends CoreObservation<Control> {
  coveragePolicy?: 'finite-ui-v1';
  id: ID; sessionId: ID; capturedAt: string; screenshotAt?: string;
  url: string; title: string; text: string; viewport: { width: number; height: number }; scroll: { x: number; y: number; maxY: number };
  documentId: string; controls: Control[]; regions: Region[]; context: Context;
  ownerDependencies?: OwnerDependencySnapshot;
  navigationScopes?: NavigationScopeSnapshot[];
  ownerDependencyDispatch?: OwnerDependencyDispatch;
  components?: BrowserComponent[];
  scrollContainers?: ScrollContainer[];
  overlays?: Overlay[];
  boundaryExitCandidates?: import('./boundary-exit.js').BoundaryExitCandidate[];
  navigation?: BrowserHistory;
  regionCandidates?: RegionCandidate[];
  structuralLists?: StructuralListCandidate[];
  discoveryScan?: import('./discovery-scan.js').DiscoverySnapshot;
  actionDiscovery?: { version: 'dom-actions-v2'; documentHints: ActionEvidence[] };
  /** Two complete DOM samples of the committed document; other controls may remain unready. */
  navigationCapture?:{version:1;beforeId:string;actionId:string;sourceDocumentId:string;documentId:string;sourceUrl:string;requestedUrl:string;observedUrl:string;samples:number;settledMs:number};
  screenshot?: string; gaps: Gap[]; stable: boolean;
  evidence?: BrowserEvidenceManifest;
  stateId: ID; visitId: ID; fingerprint: string; canonical: string; ruleVersion: 'observable-v1' | 'observable-v2' | 'observable-v3' | 'observable-v3-live-v1' | 'observable-v3-live-v2' | 'observable-v4' | 'observable-v5' | 'observable-v6' | 'observable-v7' | 'observable-v8';
  cause: 'initial' | 'action' | 'inspection' | 'recovery' | 'external';
}
export interface ContextRule { key: string; selector: string; attribute?: string; required?: boolean }
export interface MatchRule { role?: string; name?: string; stableKey?: string; kind?: ActionKind; urlIncludes?: string }
export type BrowserURLRule = {url:string;match:'exact'|'origin-path'} | {origin:string;pathnamePattern:string;match:'route'};
export interface BrowserExecutionBoundary {
  /** Explicit bounded navigation authority; effects remain unassessed. */
  programNavigation?:'public-navigation-v1';
  /** Caller-authorized exact accessible names of native notice checkboxes to check on once. */
  noticePreferences?:string[];
  version:1; allowedOperations:string[];
  urls:BrowserURLRule[];
  exclusions:{url?:string;region?:string;landmark?:'banner'|'navigation';label?:string;role?:string;stableKey?:string;targetBinding?:string;kind?:string;value?:string|boolean|number}[];
}
export interface SessionOptions {
  /** Caller-owned upper bound; applies to direct commands, probes and replay. */
  executionBoundary?:BrowserExecutionBoundary;
  coveragePolicy?: 'finite-ui-v1';
  localSimulation?: { url: string };
  /** Explicit authorization to explore captured UI operations without certifying business effects. */
  executionPolicy?: 'interface-only' | 'observed-ui';
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
  /** Caller-owned verifier for externally restored business state. The engine
   * still verifies live UI expectations and never rewrites historical outcomes. */
  verifyExternalRecovery?: (material: import('./interventions.js').ExternalRecoveryVerification, ctx: HookContext) => Promise<{ result: 'pass' | 'fail' | 'unknown'; evidence: string[] }> | { result: 'pass' | 'fail' | 'unknown'; evidence: string[] };
  explorationDecisionReuse?: (material: import('./exploration-decision-reuse.js').ExplorationDecisionReuseMaterial, ctx: HookContext) => Promise<import('./exploration-decision-reuse.js').ReuseExplorationDecisionsInput | undefined> | import('./exploration-decision-reuse.js').ReuseExplorationDecisionsInput | undefined;
  boundaryExitReview?: (material: import('./boundary-exit.js').BoundaryExitMaterial, ctx: HookContext) => Promise<import('./boundary-exit.js').BoundaryExitReviewInput | undefined> | import('./boundary-exit.js').BoundaryExitReviewInput | undefined;
  controlClassification?: (material: import('./control-classification.js').ControlClassificationMaterial, ctx: HookContext) => Promise<import('./control-classification.js').ClassifyControlsInput | undefined> | import('./control-classification.js').ClassifyControlsInput | undefined;
  controlReview?: (material: import('./control-review.js').ControlReviewMaterial, ctx: HookContext) => Promise<import('./control-review.js').ControlReviewInput | undefined> | import('./control-review.js').ControlReviewInput | undefined;
  regionReview?: (material: RegionReviewMaterial, ctx: HookContext) => Promise<RegionReviewInput | undefined> | RegionReviewInput | undefined;
  samples?: (control: Control, ctx: HookContext) => Promise<(string | boolean)[] | undefined> | (string | boolean)[] | undefined;
}
