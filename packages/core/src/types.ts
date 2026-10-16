export type ID = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Context = Record<string, { value: Json; status: 'known' | 'unknown'; source: string }>;
export interface Gap { code: string; message: string; reference?: string; critical?: boolean }
export interface Region { key: string; label: string; role: string; parentKey?: string }
/** Ordered outermost to innermost. Only the last boundary accepts interaction. */
export interface InteractionBoundary { key: string; name: string; parentKey?: string; region: string; evidence: string[] }
export interface ActionBlocker { code: string; boundaryKey?: string; evidence: string[]; unblock: string }
/** Evidence supporting an operation, independent of its availability or observed effect. */
export interface ActionEvidence { source: string; rule: string; facts: Record<string, Json> }
export interface ActionBasis { status: 'supported' | 'tentative'; evidence: ActionEvidence[] }
export type ActionKind = string;
/** A logical interaction target; platform-specific evidence belongs in an extension. */
export interface Control {
  localId: ID; instanceId: ID; identityId?: ID; hypothesisId?: ID;
  role: string; name: string; label: string; stableKey?: string;
  /** Weak evidence may identify only this current node, never a rebuilt historical target. */
  identityScope?: 'instance';
  /** Adapter-observed semantic scope/binding, never a node index or coordinate. */
  identityContext?: { scope?: string; binding?: string; evidence: string[] };
  region: string; visible: boolean; enabled: boolean;
}
export interface Observation<C extends Control = Control> {
  id: ID; sessionId: ID; capturedAt: string;
  instanceScope: string; controls: C[]; regions: Region[]; context: Context;
  components?: InteractionComponent[];
  boundaries?: InteractionBoundary[];
  gaps: Gap[]; stable: boolean;
  stateId: ID; visitId: ID; fingerprint: string; canonical: string; ruleVersion: string;
  /** Present when stateId is a non-authorizing graph group rather than exact observed equality. */
  stateGrouping?: string;
  cause: 'initial' | 'action' | 'inspection' | 'recovery' | 'external';
}
/** A graph index projection only. Equal groups never certify arrival, coverage or replay permission. */
export interface StateGrouping { policy: string; canonical: string; evidence: string[] }
export interface UIState {
  id: ID; sessionId: ID;
  /** Exact facts of the first retained observation, not an assertion about all group members. */
  fingerprint: string; canonical: string; ruleVersion: string;
  /** Complete for exact legacy states; first/latest only when grouping.memberReferences is present.
   * Full membership remains available from immutable observations by stateId. */
  observationIds: ID[]; context: Context;
  grouping?: StateGrouping & { fingerprint: string; observationCount: number; memberReferences: 'first-and-latest' };
}
export interface ControlIdentity<C extends Control = Control> {
  id: ID; sessionId: ID; createdAt: string; signature: string; stableKey?: string;
  occurrences: { observationId: ID; localId: ID; instanceId: ID; context: Context; evidence: string[] }[];
  status: 'present' | 'not_observed' | 'removed' | 'unknown'; lastControl: C;
}
export interface IdentityHypothesis {
  id: ID; sessionId: ID; observationId: ID; localId: ID;
  provisionalIdentityId: ID; candidateIds: ID[]; evidence: string[]; conflicts: string[];
  status: 'pending' | 'resolved'; revisions: { identityId: ID; source: string; evidence: string[]; at: string }[];
}
/** Optimistic guard for an external judgment; independent of its author. */
export interface IdentityReviewGuard { observationId: ID; revision: number; scope?: 'historical' }
export interface ComponentMember { localId: ID; role: string; name?: string; value?: Json; selected?: boolean }
/** An observed grouping, not a merger of its members' identities. IDs are instance-scoped. */
export interface InteractionComponent {
  id: ID; kind: string; name: string; parentId?: ID;
  members: ComponentMember[]; basis: ActionBasis;
}
export interface EvidenceReference { observationId: ID; localId?: ID; componentId?: ID }
export interface ComponentDescriptionInput {
  observationId: ID; componentId: ID; kind: string; name?: string;
  members: ComponentMember[]; source: string; reason: string; evidence: EvidenceReference[];
}
/** External interpretation retained separately from immutable observed facts. */
export interface ComponentDescription extends ComponentDescriptionInput { id: ID; sessionId: ID; createdAt: string }
export interface ActionCandidate {
  id: ID; sessionId: ID; observationId: ID; stateId: ID; controlId?: ID; localId?: ID;
  kind: ActionKind; label: string; value?: Json;
  preconditions: { context: Context; visible: boolean; enabled: boolean; identityResolved: boolean; targetResolved?: boolean; blockers?: ActionBlocker[] };
  boundary?: { key: string; intent: 'interact' | 'exit' };
  /** Current-observation execution binding; does not resolve historical logical identity. */
  target?: { kind: 'instance'; instanceScope: string; instanceId: string; evidence: string[] };
  /** Absent on legacy records. Tentative operations require explicit external execution. */
  basis?: ActionBasis;
  replayable: boolean; risk: 'interface' | 'submission' | 'unknown'; source: string;
  excluded: boolean; exclusionReason?: string; sampleValidity: 'shape_only' | 'known' | 'unknown';
}
export interface ActionAttempt {
  id: ID; sessionId: ID; requestId: string; action: ActionCandidate; startedAt: string; finishedAt?: string;
  beforeId: ID; afterId?: ID; status: 'executing' | 'succeeded' | 'failed' | 'blocked' | 'unknown';
  executionProfile?: import('./execution-readiness.js').DispatchGuard['profile'];
  repetitionSource?: { sessionId: ID; attemptId: ID };
  /** UI operation observed; external/business effects are not certified. */
  effectsAssessment?: 'not-assessed';
  purpose: 'exploration' | 'external' | 'recovery'; reason?: string; diff?: Diff; transitionId?: ID;
  /** Route-ranking evidence only. Neither action success nor target/checkpoint arrival proof. */
  recoverySegment?: {
    recordedAttemptId: ID; conditionKey: string; durationMs: number;
    mode: 'target' | 'checkpoint';
    outcome: 'matched' | 'no_progress' | 'diverged' | 'unknown' | 'unverified';
  };
}
export interface Transition { id: ID; sessionId: ID; from: ID; to: ID; attemptId: ID; replayable: boolean }
export interface Visit { id: ID; sessionId: ID; stateId: ID; observationId: ID; parentId?: ID; viaAttemptId?: ID; depth: number; at: string; explorationScope?: string; explorationDepth?: number }
export interface Change { controlId?: ID; kind: 'appeared' | 'disappeared' | 'rebuilt' | 'changed' | 'context'; field?: string; before?: unknown; after?: unknown }
export interface Diff { beforeId: ID; afterId: ID; changes: Change[]; gaps: Gap[]; attribution: 'observed_during_interval'; region?: string }
export interface InteractionScope { id: ID; sessionId: ID; name: string; region: string; beforeId: ID; afterId?: ID; attemptIds: ID[]; status: 'open' | 'closed' | 'interrupted'; automatic: boolean; anchors: string[]; boundaryKey?: string; instanceScope?: string; parentScopeId?: ID; baseline?: 'before_entry' | 'already_open'; diff?: Diff }
export interface FrontierItem {
  id: ID; sessionId: ID; key: string; stateId: ID; contextKey: string; action: ActionCandidate;
  status: 'pending' | 'deferred' | 'skipped' | 'executing' | 'executed' | 'blocked' | 'unknown' | 'needs_revalidation' | 'superseded';
  /** Scheduling only: neither control identity nor execution permission. */
  explorationGroups?: { groupId: ID; memberKey?: string }[];
  reason?: string; unblock?: string; attempts: ID[]; depth: number;
  /** Sampling groups observations, not equivalent states or successful executions. */
  sampling?: { policy: string; evidence: string[]; observationIds: ID[]; revision?: string };
  /** Accounting expansion of retained source observations; never execution or coverage. */
  samplingMigration?: {
    version: 'retained-sampling-sources/v1'; sourceKey: string;
    sources: { observationId: ID; actionId?: ID; childId?: ID; reason?: string }[];
    children: { frontierId: ID; key: string; policy: string }[];
    audit?: { revision: string; sourceSignature: string; childrenSignature: string };
  };
  /** Source lineage survives refreshing a derived case against the live page. */
  samplingParents?: { frontierId: ID; observationIds: ID[]; actionIds: ID[] }[];
  recovery?: { resultId: ID; diagnostics: RecoveryDiagnostics };
}
/** Read-time coverage metadata. Scheduling status/reason apply to this case, not its control. */
export interface FrontierItemView extends FrontierItem {
  coverage: {
    groupId: string;
    unit: 'input_sample' | 'action_case';
    /** Last recorded attempt outcome; unknown also covers missing historical attempts. */
    executionStatus: ActionAttempt['status'] | 'not_attempted';
    /** Equivalent sampled operation evidence, without claiming this case was dispatched. */
    equivalentTo?: import('./coverage-reconciliation.js').EquivalentCoverage;
    /** Verified accounting replacement, not a successful operation sample. */
    migratedTo?: ID[];
  };
}
/** Groups one logical control and operation; items follow the session coverage policy. */
export interface FrontierCoverageGroup {
  id: string; controlId?: ID; kind: ActionKind; label: string;
  coverageStatus: 'not_attempted' | 'attempted' | 'partial' | 'complete';
  /** Complete means all discovered cases have execution or equivalent sample evidence, not exhaustive coverage. */
  counts: { total: number; executed: number; blocked: number; notAttempted: number; coveredEquivalent: number };
  items: FrontierItemView[];
}
export interface Predicate { target: string; key?: string; identityId?: ID; field?: string; equals: Json }
export interface Checkpoint {
  id: ID; sessionId: ID; name: string; observationId: ID; stateId: ID; context: Context;
  predicates: Predicate[]; acceptable: Predicate[]; path: ID[]; createdAt: string;
  /** Additional retained evidence explicitly required by this checkpoint. */
  evidenceKeys?: string[];
}
export type ReachStatus = 'REACHED_VERIFIED' | 'REACHED_ACCEPTABLE' | 'PRECONDITIONS_CHANGED' | 'UNREACHABLE' | 'UNVERIFIED';
export interface RecoveryDiagnostics {
  strategies: string[];
  dirtyActions: { attemptId: ID; label: string; risk: ActionCandidate['risk'] }[];
  resetAvailable: boolean;
  verificationScope?: 'observed-ui';
  unassessedEffectAttemptIds?: ID[];
}
export interface ReachResult { verificationScope?: 'observed-ui'; id: ID; sessionId: ID; checkpointId: ID; status: ReachStatus; observationId?: ID; reason: string; attemptIds: ID[]; checks: { name: string; result: 'pass' | 'fail' | 'unknown' }[]; remainingFrontier: number; diagnostics?: RecoveryDiagnostics }
/** Historical observed work, whether or not it was executed. Never a coverage proof. */
export interface ExplorationTargetReference { sessionId: ID; observationId: ID; actionId: ID }
export interface ExplorationTargetCorrespondence {
  equivalent: boolean; reason: string; policy?: string; conditionKey?: string; evidence: string[];
  source: ExplorationTargetReference; target: ExplorationTargetReference;
  invalidatedBy: string[]; identityAuthorized: false; replayAuthorized: false; currentExecution: false;
}
export interface ReachExplorationTargetInput {
  checkpointId: ID;
  /** Historical observation and candidate IDs defining the desired operations. */
  observationId: ID; actionIds: ID[];
  /** Optional optimistic guard for the browser cursor before recovery begins. */
  currentObservationId?: ID;
}
/** Return only to a retained source position, never restore its UI state or replay its path. */
export interface ReturnToObservedSourceInput {
  observationId: ID;
  currentObservationId?: ID;
}
/** Position arrival leaves all control, boundary, review and execution gates intact. */
export interface ObservedSourceReturnResult {
  verificationScope?: 'observed-ui';
  id: ID; sessionId: ID; sourceObservationId: ID; observationId?: ID;
  status: 'SOURCE_REACHED' | 'PRECONDITIONS_CHANGED' | 'UNREACHABLE' | 'UNVERIFIED';
  reason: string; attemptIds: ID[]; checks: ReachResult['checks'];
  diagnostics: { unassessedEffectAttemptIds: ID[] };
  checkpointVerified: false; currentExecution: false; executionAuthorized: false; sourceStateRestored: false;
}
/** Target arrival is neither checkpoint equality nor successful execution/coverage. */
export interface ExplorationTargetReachResult extends Omit<ReachResult, 'status'> {
  status: 'TARGET_REACHED' | 'PRECONDITIONS_CHANGED' | 'UNREACHABLE' | 'UNVERIFIED';
  targetObservationId: ID; targetActionIds: ID[]; matchedActionIds: ID[];
  matches: ExplorationTargetCorrespondence[]; checkpointVerified: false; currentExecution: false;
  /** Arrival leaves review/dispatch gates intact; this is the current separate execution assessment. */
  dispatchAvailability?: import('./execution-readiness.js').ActionAvailability;
  executionAuthorized: false;
}
export interface RepetitionAssessment {
  repeatable: boolean; reason: string; conditionKey: string; evidence: string[];
  source: { sessionId: ID; attemptId: ID }; target: ExplorationTargetReference;
  /** Read-time assessment only; dispatch must revalidate the current observation. */
  dispatchRevalidationRequired: true;
}
export interface SessionOptions { executionPolicy?: 'interface-only' | 'observed-ui'; maxActions: number; maxDepth: number; maxDurationMs: number; context: Record<string, Json>; exploration?: 'controls' | 'representative' | 'stateful'; evidenceRetention?: import('./ports.js').EvidenceRetentionPolicy }
export interface ValidationFailure { scopeKey: string; count: number; observationIds: ID[]; evidence: string[] }
export interface Session<S extends SessionOptions = SessionOptions> { id: ID; options: S; createdAt: string; status: 'idle' | 'running' | 'paused' | 'stopped' | 'finished'; currentObservationId?: ID; actionCount: number; elapsedMs: number; stopReason?: string; mode: 'manual' | 'dfs'; dirty: boolean; dirtyAttemptIds?: ID[]; /** Not a successful business-state verification or replay grant. */ unassessedEffectAttemptIds?: ID[]; validationFailures?: ValidationFailure[]; observationFailures?: { count: number; kind: 'incomplete' | 'stale'; observationIds: ID[] } }
export interface EngineEvent { sequence: number; sessionId: ID; type: string; at: string; data: unknown }
export interface Issue { id: ID; sessionId: ID; observationId: ID; source: string; severity: 'info' | 'warning' | 'error'; message: string; evidence?: string[] }
export interface Graph { states: UIState[]; transitions: Transition[]; visits: Visit[] }
export interface HookContext<O extends Observation = Observation, S extends SessionOptions = SessionOptions> { session: Readonly<Session<S>>; observation: Readonly<O> }
/** Review organization only: never shared identity, business behavior or inherited permission. */
export interface ExplorationCollection { key: string; label: string; evidence: ActionEvidence[] }
export interface ExplorationGroupResolution { groupId: ID; revision: number; decision: ExplorationGroupDecision }
export interface ExplorationReviewMaterial {
  sessionId: ID; observationId: ID;
  /** All non-invalidated groups, including earlier pages; membership is observed, not exhaustive. */
  groups: ExplorationGroup[];
  collections: (ExplorationCollection & { groupIds: ID[] })[];
  overlaps: { groupIds: ID[]; caseKeys: string[] }[];
  /** New scopes in this notification. Read-only queries leave this empty. */
  requestedGroupIds: ID[];
  /** Pending identity decisions tied to recorded work. Scope IDs may refer to archived groups.
   * Current-instance execution remains possible; these are not automatic dispatch blockers. */
  identityReviews: { hypothesisId: ID; observationId: ID; localId: ID; provisionalIdentityId: ID;
    candidateIds: ID[]; frontierIds: ID[]; groupIds: ID[]; currentLocalIds: ID[] }[];
}
/** Observed exploration scope, not proof of equal business effects or permission to execute. */
export interface ExplorationGroupProposal {
  collection?: ExplorationCollection;
  /** Context-bound scheduling scopes survive document changes; they grant no target or replay permission. */
  binding?: 'instance' | 'context';
  key: string; kind: string; label: string; actionIds: ID[]; traversalActionIds: ID[]; evidence: ActionEvidence[];
  /** Stable key identifies the scope; changing these conditions requires a fresh decision. */
  conditions?: Json;
  /** Producers with independent collection evidence may lower the initial list threshold; explicit 1 also permits an empty list with traversal. */
  minimumMembers?: number;
}
export type ExplorationGroupDecision = { source: string; evidence: string[] } & (
  { mode: 'all' | 'defer' | 'skip'; memberKeys?: never } | { mode: 'sample'; memberKeys: string[] }
);
export interface ExplorationGroup {
  collection?: ExplorationCollection;
  binding?: 'instance' | 'context';
  id: ID; sessionId: ID; key: string; proposalKey: string; kind: string; label: string; membership: 'observed-action-cases';
  instanceScope: string; contextKey: string; observationId: ID; revision: number;
  status: 'pending' | 'decided' | 'invalidated'; evidence: ActionEvidence[]; conditions?: Json;
  invalidation?: { observationId: ID; reason: string };
  /** Observed traversal cases are gated too, but cannot be selected as samples. */
  traversalKeys?: string[];
  /** Observed members only. A virtual list may contain undiscovered entries. */
  members: { key: string; actionId: ID; observationId: ID; localId?: ID; label: string; kind: string; value?: Json; risk: ActionCandidate['risk']; excluded: boolean }[];
  decisions: { revision: number; at: string; decision: ExplorationGroupDecision;
    reusedFrom?: { reviewId: string; conditionKey: string };
    invalidation?: { observationId: string; reason: string; at: string } }[];
}
export interface EngineHooks<O extends Observation = Observation, S extends SessionOptions = SessionOptions> {
  context?: (ctx: HookContext<O, S>) => Promise<Context> | Context;
  actions?: (actions: ActionCandidate[], ctx: HookContext<O, S>) => Promise<ActionCandidate[]> | ActionCandidate[];
  choose?: (items: FrontierItemView[], ctx: HookContext<O, S>) => Promise<ID | null> | ID | null;
  /** Propose scopes over current actions on each capture; may include a single branch or operation. */
  explorationScopes?: (actions: ActionCandidate[], ctx: HookContext<O, S>) => Promise<ExplorationGroupProposal[]> | ExplorationGroupProposal[];
  /** One review per capture with new scopes. Takes precedence over the individual decision hooks. */
  explorationReview?: (material: ExplorationReviewMaterial, ctx: HookContext<O, S>) => Promise<ExplorationGroupResolution[] | undefined> | ExplorationGroupResolution[] | undefined;
  /** General decision hook. Takes precedence over the compatibility explorationGroup hook. */
  explorationDecision?: (group: ExplorationGroup, ctx: HookContext<O, S>) => Promise<ExplorationGroupDecision | undefined> | ExplorationGroupDecision | undefined;
  /** Called once per newly detected group. Return undefined to decide asynchronously via the durable event/command API. */
  explorationGroup?: (group: ExplorationGroup, ctx: HookContext<O, S>) => Promise<ExplorationGroupDecision | undefined> | ExplorationGroupDecision | undefined;
  identity?: (hypothesis: IdentityHypothesis, ctx: HookContext<O, S>) => Promise<{ identityId: ID; source: string; evidence: string[] } | undefined> | { identityId: ID; source: string; evidence: string[] } | undefined;
  verify?: (checkpoint: Checkpoint, ctx: HookContext<O, S>) => Promise<{ result: 'pass' | 'fail' | 'unknown'; evidence: string[] }> | { result: 'pass' | 'fail' | 'unknown'; evidence: string[] };
  accept?: (checkpoint: Checkpoint, ctx: HookContext<O, S>) => Promise<{ accepted: boolean; evidence: string[] }> | { accepted: boolean; evidence: string[] };
  reset?: (session: Readonly<Session<S>>) => Promise<{ reset: boolean; evidence: string[] }>;
  check?: (attempt: ActionAttempt, ctx: HookContext<O, S>) => Promise<Omit<Issue, 'id' | 'sessionId' | 'observationId'>[]> | Omit<Issue, 'id' | 'sessionId' | 'observationId'>[];
}
export class EngineError extends Error { constructor(public code: string, message: string, public details?: unknown) { super(message); this.name = 'EngineError'; } }
