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
  availability?(key: string): Promise<EvidenceAvailability>;
  beginObservation?(context: { sessionId: string; observationId: string; policy?: EvidenceRetentionPolicy }): Promise<void>;
  endObservation?(observationId: string, committed: boolean): Promise<void>;
  pin?(keys: string[], owner: string, options?: { expiresAt: number }): Promise<void>;
  unpin?(owner: string): Promise<void>;
  flush?(): Promise<void>;
}
/** Synchronous atomic record transactions; asynchronous binary evidence is separate. */
export interface Persistence {
  readonly evidence: EvidenceStore;
  transaction<T>(fn: () => T): T;
  put<T extends { id: string; sessionId?: string }>(kind: string, value: T): void;
  get<T>(kind: string, id: string): T | undefined;
  require<T>(kind: string, id: string): T;
  list<T>(kind: string, sessionId?: string): T[];
  event(sessionId: string, type: string, data: unknown): EngineEvent;
  events(sessionId: string, after?: number, limit?: number): EngineEvent[];
  request(sessionId: string, requestId: string): { attemptId: string; payload: string } | undefined;
  recordRequest(sessionId: string, requestId: string, attemptId: string, payload: string): void;
  close(): void;
}
export type HookInvoker = <T>(name: string, fn: () => T | Promise<T>) => Promise<{ value?: T; error?: string }>;
export type ObservationData<O extends Observation> = Omit<O, 'id' | 'sessionId' | 'stateId' | 'visitId' | 'fingerprint' | 'canonical' | 'ruleVersion' | 'cause'>;
export interface InteractionDriver<O extends Observation, S extends SessionOptions> {
  start(): Promise<void>;
  connected(): boolean;
  capture(observationId: string): Promise<ObservationData<O>>;
  discover(observation: O, session: Session<S>, invoke: HookInvoker): Promise<ActionCandidate[]>;
  preflight(observation: O, targetLocalIds?: string[]): Promise<'valid' | 'stale' | 'context_changed'>;
  validate(action: ActionCandidate, control?: O['controls'][number]): Promise<void>;
  execute(action: ActionCandidate, control?: O['controls'][number]): Promise<void>;
  reopen(): Promise<void>;
  close(): Promise<void>;
}
export interface ScopeStart { name: string; region: string }
export interface ExplorationCase { key: string; policy: string; evidence: string[] }
export interface RestorationStep { action: ActionCandidate; expectedCanonical: string; evidence: string[] }
/** Platform policy lives behind this port. The engine does not interpret action kinds. */
export interface InteractionAdapter<O extends Observation = Observation, S extends SessionOptions = SessionOptions> {
  readonly ruleVersion: string;
  parseOptions(input: unknown): S;
  createDriver(options: S, evidence: EvidenceStore): InteractionDriver<O, S>;
  signature(control: O['controls'][number]): string;
  normalize(observation: O): string;
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
  /** Explicit sampling policy. This is not a state equivalence or independence claim. */
  explorationCase?(action: ActionCandidate, observation: O, session: Session<S>): ExplorationCase | undefined;
  /** Optional structural scope for representative depth budgets; raw visit depth is retained. */
  explorationScope?(observation: O): string;
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
