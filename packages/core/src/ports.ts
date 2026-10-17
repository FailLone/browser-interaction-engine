import type { ActionCandidate, Context, Control, Diff, EngineEvent, EngineHooks, InteractionScope, Observation, Predicate, Session, SessionOptions } from './types.js';

export interface Evidence { data: Uint8Array; mediaType: string }
export interface EvidenceRetentionPolicy { mode: 'transient' | 'cache' | 'persistent'; ttlMs: number; maxBytes: number; maxObservations: number }
export interface EvidenceAvailability {
  status: 'available' | 'not_retained' | 'expired' | 'evicted' | 'released' | 'storage_failed' | 'missing';
  mode?: EvidenceRetentionPolicy['mode']; bytes?: number; expiresAt?: string; reason?: string;
  durability?: 'process' | 'persistent' | 'unknown';
}
export interface EvidenceStore {
  put(key: string, evidence: Evidence): Promise<void>;
  get(key: string): Promise<Evidence | undefined>;
  readonly durability?: 'process' | 'persistent';
  delete?(key: string): Promise<void>;
  /** Remove logical artifacts in one collection pass. May partially remove keys
   * on failure; callers must retain unavailable evidence explicitly, never infer
   * that a rejected deletion preserved every artifact. */
  deleteMany?(keys: string[]): Promise<void>;
  availability?(key: string): Promise<EvidenceAvailability>;
  beginObservation?(context: { sessionId: string; observationId: string; policy?: EvidenceRetentionPolicy }): Promise<void>;
  endObservation?(observationId: string, committed: boolean): Promise<void>;
  pin?(keys: string[], owner: string, options?: { expiresAt: number }): Promise<void>;
  unpin?(owner: string): Promise<void>;
  flush?(): Promise<void>;
}
/** A bounded hint for invalidating cached facts; not a database snapshot. */
export interface EntityChanges {
  /** Opaque, scoped cursor; valid only for the originating store instance. */
  token: string;
  /** Reload the complete kind/session listing, including removals. */
  reset: boolean;
  /** IDs to reread, never entity values or proof that an action remains allowed. */
  ids: string[];
  /** A transaction-local read may be used after a full scan, but no cursor or
   * facts may be reused by the next query. Absent means normal cursor checks. */
  cacheable?: false;
}
/** Synchronous atomic record transactions; asynchronous binary evidence is separate. */
export interface Persistence {
  readonly evidence: EvidenceStore;
  /** Optional value-isolation guarantee for get/require/list/listByObservation.
   * Every returned record (including nested objects/arrays) is detached from
   * stored state and all other read results. Callers may mutate it without
   * affecting storage or another read. Missing means unknown, not detached.
   * This is neither a freshness/snapshot guarantee nor execution authority.
   * Decorators or overrides must withdraw it if their reads return aliases. */
  readonly recordReadIsolation?: 'detached';
  transaction<T>(fn: () => T): T;
  put<T extends { id: string; sessionId?: string }>(kind: string, value: T): void;
  get<T>(kind: string, id: string): T | undefined;
  require<T>(kind: string, id: string): T;
  list<T>(kind: string, sessionId?: string): T[];
  /** Optional observation-scoped read, equivalent to filtering list(kind,
   * sessionId) by observationId, with the same ordering and value isolation.
   * Unsupported/corrupt stored encodings must not be silently excluded by an
   * index projection. This is a fresh read, not execution authorization. */
  listByObservation?<T>(kind: string, sessionId: string, observationId: string): T[];
  /** Optional bounded change hints for cached navigation facts. Missing support,
   * reset, or an unknown cursor requires a full list. Read the cursor before
   * reading records and check it again afterwards; a concurrent change requires
   * retrying. The feed is not an atomic snapshot or execution authorization. */
  entityChanges?(kind: string, sessionId: string, sinceToken?: string): EntityChanges;
  event(sessionId: string, type: string, data: unknown): EngineEvent;
  events(sessionId: string, after?: number, limit?: number): EngineEvent[];
  request(sessionId: string, requestId: string): { attemptId: string; payload: string } | undefined;
  recordRequest(sessionId: string, requestId: string, attemptId: string, payload: string): void;
  close(): void;
}
export type HookInvoker = <T>(name: string, fn: () => T | Promise<T>) => Promise<{ value?: T; error?: string }>;
export type ObservationData<O extends Observation> = Omit<O, 'id' | 'sessionId' | 'stateId' | 'stateGrouping' | 'visitId' | 'fingerprint' | 'canonical' | 'ruleVersion' | 'cause'>;
export type PreflightResult = 'valid' | 'stale' | 'context_changed'
  | { status: 'stale'; scopeKey: string; evidence: string[] };
/** Read-only source facts for post-action observation. The driver may wait for
 * this operation's dependencies, but must never repeat the action or certify
 * its outcome. The adapter and engine still validate the resulting observation. */
export interface CaptureContext<O extends Observation> {
  afterAction?: { action: ActionCandidate; before: O };
}
export interface InteractionDriver<O extends Observation, S extends SessionOptions> {
  start(): Promise<void>;
  connected(): boolean;
  capture(observationId: string, context?: CaptureContext<O>): Promise<ObservationData<O>>;
  discover(observation: O, session: Session<S>, invoke: HookInvoker): Promise<ActionCandidate[]>;
  preflight(observation: O, action?: ActionCandidate, reviewTargetLocalIds?: string[]): Promise<PreflightResult>;
  validate(action: ActionCandidate, control?: O['controls'][number]): Promise<void>;
  execute(action: ActionCandidate, control?: O['controls'][number]): Promise<void>;
  reopen(): Promise<void>;
  close(): Promise<void>;
}
export interface ScopeStart { name: string; region: string }
export interface ExplorationCase { key: string; policy: string; evidence: string[] }
export interface RestorationStep { action: ActionCandidate; expectedCanonical: string; evidence: string[] }
/** Platform evidence for a retained position; no UI or operation equivalence. */
export interface ObservedSourcePosition {
  status: 'reached' | 'returnable' | 'unavailable' | 'unknown';
  reason: string;
  checks: import('./types.js').ReachResult['checks'];
}
/** Platform policy lives behind this port. The engine does not interpret action kinds. */
export interface InteractionAdapter<O extends Observation = Observation, S extends SessionOptions = SessionOptions> {
  readonly ruleVersion: string;
  parseOptions(input: unknown): S;
  createDriver(options: S, evidence: EvidenceStore): InteractionDriver<O, S>;
  signature(control: O['controls'][number]): string;
  /** Extra binding evidence used to reject stale external identity judgments. */
  reviewBinding?(control: O['controls'][number]): unknown;
  /** Explicit, observation-bound experiments; never added to automatic discovery. */
  probeAction?(kind: string, control: O['controls'][number], observation: O, session: Session<S>, parameters?: ActionCandidate['value']): ActionCandidate;
  normalize(observation: O): string;
  /** Non-authorizing graph index. normalize() retains exact observed facts. */
  stateGrouping?(observation: O, session: Session<S>): import('./types.js').StateGrouping | undefined;
  compare(before: O, after: O, region?: string): Diff;
  constrain(action: ActionCandidate, observation: O, session: Session<S>): ActionCandidate;
  testPredicate(predicate: Predicate, observation: O): 'pass' | 'fail' | 'unknown';
  replayMatches(candidate: ActionCandidate, recorded: ActionCandidate): boolean;
  scopeBefore?(action: ActionCandidate, observation: O): ScopeStart | undefined;
  scopeAfter?(action: ActionCandidate, before: O, after: O): { start?: ScopeStart; anchors: string[] };
  scopeClosed?(scope: InteractionScope, observation: O): boolean;
  returnAction?(actions: ActionCandidate[], observation: O): ActionCandidate | undefined;
  entryAction?(observation: O, session: Session<S>): ActionCandidate;
  /** Native return to an observed source; full checkpoint equality remains separately verified. */
  returnToObservation?(target: O, current: O, session: Session<S>): ActionCandidate | undefined;
  /** Verify exact source position and whether a single native return is available.
   * Implementations must not infer arrival from URL or UI similarity alone. */
  observedSourcePosition?(target: O, current: O): ObservedSourcePosition;
  /** Explicit sampling policy. This is not a state equivalence or independence claim. */
  explorationCase?(action: ActionCandidate, observation: O, session: Session<S>): ExplorationCase | undefined;
  /** Decode explicitly supported historical representative sampling policies.
   * Sources must be retained observations, never substituted live facts. These
   * keys only verify old scope membership; current explorationCase must also
   * succeed, and this port grants no identity, execution, coverage or replay. */
  legacyExplorationCases?(action: ActionCandidate, observation: O, session: Session<S>): ExplorationCase[];
  /** Required with legacyExplorationCases for once-per-version source audits. */
  readonly explorationCaseRevision?: string;
  /** Portable observation evidence, without asserting logical identity or permission. */
  controlCorrespondence?(control: O['controls'][number]): import('./coverage-reconciliation.js').CorrespondenceHint | undefined;
  /** Optional operation-specific evidence. Does not change control identity or persisted keys. */
  operationCorrespondenceHint?(control: O['controls'][number], kind: string, observation: O): import('./coverage-reconciliation.js').CorrespondenceHint | undefined;
  /** Portable operation equivalence for correspondence and coverage reconciliation.
   * May be stricter than explorationCase queue sampling; undefined never falls
   * back to that broader sample when this contract is implemented. */
  correspondenceCase?(action: ActionCandidate, observation: O, session: Session<S>): ExplorationCase | undefined;
  /** Relevant, portable UI preconditions for target arrival, separate from whole-page equality. */
  explorationTargetConditions?(action: ActionCandidate, observation: O): ExplorationCase | undefined;
  /** Current target readiness; a ready sibling never proves this operation ready. */
  explorationTargetReady?(action: ActionCandidate, observation: O): boolean;
  /** A known mechanical obstruction may be addressed by the existing recovery strategies.
   * This grants no execution permission and never treats unsettled evidence as failure. */
  explorationTargetRecoverable?(action: ActionCandidate, observation: O, blockers: import('./execution-readiness.js').ExecutionBlocker[]): boolean;
  /** Optional structural scope for representative depth budgets; raw visit depth is retained. */
  explorationScope?(observation: O): string;
  /** Partial captures must establish readiness for the dispatched operation itself. */
  actionObservationReady?(action: ActionCandidate, before: O, after: O): boolean;
  /** A bounded DOM dependency scope; undefined means global validation. */
  validationScope?(action: ActionCandidate, observation: O): string | undefined;
  /** Groups repeated operations for an upper-layer traversal decision. Does not alter their capabilities or risk. */
  explorationGroups?(actions: ActionCandidate[], observation: O, session: Session<S>, known: import('./types.js').ExplorationGroup[]): import('./types.js').ExplorationGroupProposal[];
  /** Only explicitly declared reversible operations may produce local restoration steps. */
  restorationStep?(target: O, current: O, session: Session<S>): RestorationStep | undefined;
  /** An explicitly configured environment reset, executed through the normal action ledger. */
  resetAction?(observation: O, session: Session<S>): ActionCandidate | undefined;
  inRegion?(control: O['controls'][number], region: string, observation: O): boolean;
}
export interface EngineOptions<O extends Observation = Observation, S extends SessionOptions = SessionOptions> {
  adapter: InteractionAdapter<O, S>;
  persistence: Persistence;
  hooks?: EngineHooks<O, S>;
}
