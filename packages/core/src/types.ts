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
  region: string; visible: boolean; enabled: boolean;
}
export interface Observation<C extends Control = Control> {
  id: ID; sessionId: ID; capturedAt: string;
  instanceScope: string; controls: C[]; regions: Region[]; context: Context;
  boundaries?: InteractionBoundary[];
  gaps: Gap[]; stable: boolean;
  stateId: ID; visitId: ID; fingerprint: string; canonical: string; ruleVersion: string;
  cause: 'initial' | 'action' | 'inspection' | 'recovery' | 'external';
}
export interface UIState { id: ID; sessionId: ID; fingerprint: string; canonical: string; ruleVersion: string; observationIds: ID[]; context: Context }
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
  purpose: 'exploration' | 'external' | 'recovery'; reason?: string; diff?: Diff; transitionId?: ID;
}
export interface Transition { id: ID; sessionId: ID; from: ID; to: ID; attemptId: ID; replayable: boolean }
export interface Visit { id: ID; sessionId: ID; stateId: ID; observationId: ID; parentId?: ID; viaAttemptId?: ID; depth: number; at: string; explorationScope?: string; explorationDepth?: number }
export interface Change { controlId?: ID; kind: 'appeared' | 'disappeared' | 'rebuilt' | 'changed' | 'context'; field?: string; before?: unknown; after?: unknown }
export interface Diff { beforeId: ID; afterId: ID; changes: Change[]; gaps: Gap[]; attribution: 'observed_during_interval'; region?: string }
export interface InteractionScope { id: ID; sessionId: ID; name: string; region: string; beforeId: ID; afterId?: ID; attemptIds: ID[]; status: 'open' | 'closed' | 'interrupted'; automatic: boolean; anchors: string[]; boundaryKey?: string; parentScopeId?: ID; baseline?: 'before_entry' | 'already_open'; diff?: Diff }
export interface FrontierItem {
  id: ID; sessionId: ID; key: string; stateId: ID; contextKey: string; action: ActionCandidate;
  status: 'pending' | 'deferred' | 'executing' | 'executed' | 'blocked' | 'unknown' | 'needs_revalidation' | 'superseded';
  /** Scheduling only: neither control identity nor execution permission. */
  explorationGroups?: { groupId: ID; memberKey?: string }[];
  reason?: string; unblock?: string; attempts: ID[]; depth: number;
  /** Sampling groups observations, not equivalent states or successful executions. */
  sampling?: { policy: string; evidence: string[]; observationIds: ID[] };
  recovery?: { resultId: ID; diagnostics: RecoveryDiagnostics };
}
/** Read-time coverage metadata. Scheduling status/reason apply to this case, not its control. */
export interface FrontierItemView extends FrontierItem {
  coverage: {
    groupId: string;
    unit: 'input_sample' | 'action_case';
    /** Last recorded attempt outcome; unknown also covers missing historical attempts. */
    executionStatus: ActionAttempt['status'] | 'not_attempted';
  };
}
/** Groups one logical control and operation; items follow the session coverage policy. */
export interface FrontierCoverageGroup {
  id: string; controlId?: ID; kind: ActionKind; label: string;
  coverageStatus: 'not_attempted' | 'attempted' | 'partial' | 'complete';
  /** Complete means all discovered cases under the selected policy are executed, not exhaustive coverage. */
  counts: { total: number; executed: number; blocked: number; notAttempted: number };
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
}
export interface ReachResult { id: ID; sessionId: ID; checkpointId: ID; status: ReachStatus; observationId?: ID; reason: string; attemptIds: ID[]; checks: { name: string; result: 'pass' | 'fail' | 'unknown' }[]; remainingFrontier: number; diagnostics?: RecoveryDiagnostics }
export interface SessionOptions { maxActions: number; maxDepth: number; maxDurationMs: number; context: Record<string, Json>; exploration?: 'controls' | 'representative' | 'stateful'; evidenceRetention?: import('./ports.js').EvidenceRetentionPolicy }
export interface Session<S extends SessionOptions = SessionOptions> { id: ID; options: S; createdAt: string; status: 'idle' | 'running' | 'paused' | 'stopped' | 'finished'; currentObservationId?: ID; actionCount: number; elapsedMs: number; stopReason?: string; mode: 'manual' | 'dfs'; dirty: boolean; dirtyAttemptIds?: ID[] }
export interface EngineEvent { sequence: number; sessionId: ID; type: string; at: string; data: unknown }
export interface Issue { id: ID; sessionId: ID; observationId: ID; source: string; severity: 'info' | 'warning' | 'error'; message: string; evidence?: string[] }
export interface Graph { states: UIState[]; transitions: Transition[]; visits: Visit[] }
export interface HookContext<O extends Observation = Observation, S extends SessionOptions = SessionOptions> { session: Readonly<Session<S>>; observation: Readonly<O> }
/** Adapter-proposed structural similarity, not proof of equal business effects. */
export interface ExplorationGroupProposal {
  key: string; kind: 'similar-list'; label: string; actionIds: ID[]; traversalActionIds: ID[]; evidence: ActionEvidence[];
}
export type ExplorationGroupDecision = { source: string; evidence: string[] } & (
  { mode: 'all' | 'defer'; memberKeys?: never } | { mode: 'sample'; memberKeys: string[] }
);
export interface ExplorationGroup {
  id: ID; sessionId: ID; key: string; proposalKey: string; kind: 'similar-list'; label: string; membership: 'observed-action-cases';
  instanceScope: string; contextKey: string; observationId: ID; revision: number;
  status: 'pending' | 'decided'; evidence: ActionEvidence[];
  /** Observed members only. A virtual list may contain undiscovered entries. */
  members: { key: string; actionId: ID; observationId: ID; localId?: ID; label: string; kind: string; value?: Json; risk: ActionCandidate['risk']; excluded: boolean }[];
  decisions: { revision: number; at: string; decision: ExplorationGroupDecision }[];
}
export interface EngineHooks<O extends Observation = Observation, S extends SessionOptions = SessionOptions> {
  context?: (ctx: HookContext<O, S>) => Promise<Context> | Context;
  actions?: (actions: ActionCandidate[], ctx: HookContext<O, S>) => Promise<ActionCandidate[]> | ActionCandidate[];
  choose?: (items: FrontierItemView[], ctx: HookContext<O, S>) => Promise<ID | null> | ID | null;
  /** Called once per newly detected group. Return undefined to decide asynchronously via the durable event/command API. */
  explorationGroup?: (group: ExplorationGroup, ctx: HookContext<O, S>) => Promise<ExplorationGroupDecision | undefined> | ExplorationGroupDecision | undefined;
  identity?: (hypothesis: IdentityHypothesis, ctx: HookContext<O, S>) => Promise<{ identityId: ID; source: string; evidence: string[] } | undefined> | { identityId: ID; source: string; evidence: string[] } | undefined;
  verify?: (checkpoint: Checkpoint, ctx: HookContext<O, S>) => Promise<{ result: 'pass' | 'fail' | 'unknown'; evidence: string[] }> | { result: 'pass' | 'fail' | 'unknown'; evidence: string[] };
  accept?: (checkpoint: Checkpoint, ctx: HookContext<O, S>) => Promise<{ accepted: boolean; evidence: string[] }> | { accepted: boolean; evidence: string[] };
  reset?: (session: Readonly<Session<S>>) => Promise<{ reset: boolean; evidence: string[] }>;
  check?: (attempt: ActionAttempt, ctx: HookContext<O, S>) => Promise<Omit<Issue, 'id' | 'sessionId' | 'observationId'>[]> | Omit<Issue, 'id' | 'sessionId' | 'observationId'>[];
}
export class EngineError extends Error { constructor(public code: string, message: string, public details?: unknown) { super(message); this.name = 'EngineError'; } }
