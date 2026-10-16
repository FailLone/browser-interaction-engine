import type { ActionAttempt, BrowserEngine, SessionOptions } from '@interaction/browser';
import type { NavigationPosition } from './navigation-state.js';
import type { ObligationProjection, RouteRetryLedger } from './obligation-lifecycle.js';
import type { ObligationSchedule } from './obligation-scheduler.js';

/** Only documented public operations. Never a browser handle or engine persistence. */
export type ExplorerHost = Pick<BrowserEngine, 'operationCoverageCandidates' | 'actionAvailability' | 'operationCorrespondences' | 'explorationSnapshot' | 'controlInterpretationSnapshot' | 'boundaryState' | 'interactionTransition' | 'navigationIsolation' | 'recoveryAssessment' | 'sessions' | 'session' | 'createSession' | 'observation' | 'observe' | 'actions' | 'execute' | 'command' | 'getFrontier' | 'report' | 'list' | 'regionReviewMaterial' | 'explorationReviewMaterial' | 'controlClassificationMaterial' | 'controlReviewMaterial' | 'purposeReviewMaterial' | 'discoveryScanMaterial' | 'createCheckpoint' | 'reachCheckpoint' | 'pause' | 'stop' | 'events' | 'pinEvidence' | 'unpinEvidence'> & Partial<Pick<BrowserEngine,'boundaryExitMaterial'|'probeAvailability'|'classificationCorrespondences'|'explorationTargetCorrespondences'|'reachExplorationTarget'|'repetitionAssessment'>>;
export type TaskStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'blocked' | 'budget_exhausted' | 'configuration_required';
export interface Budget { rounds: number; actions: number; durationMs: number; modelRequests: number }
export interface EvidenceRef { sessionId: string; observationId: string; attemptId?: string }
/** Exact semantic constraints; no old session control IDs or arbitrary selectors. */
export interface Scope { stableKey?: string; /** Captured semantic owner/binding hint; never an identity or coverage grant. */ targetBinding?: string; url?: string; region?: string; label?: string; role?: string; kind?: string; value?: string | boolean | number }
export interface ScopeExclusion { scope: Scope; instruction: string }
/** Executable task meaning, separate from natural-language intent and the changing coverage ledger. */
export type TaskIntent =
  | { version:1; mode:'exhaustive'; source:'default'|'jev'|'llm'; boundary:'current-page'; url:string; exclusions:ScopeExclusion[] }
  | { version:1; mode:'targeted'; source:'llm'|'user' }
  | { version:1; mode:'unsupported'; source:'jev'|'llm'; reason:string };
export interface PlanItem {
  id: string; title: string; scope: Scope; prerequisites: Scope[]; completion: string;
  /** Scheduling revision only; SDK evidence still decides coverage equivalence. */
  operationConditionKey?: string;
  operationConditionPolicy?: 'browser-operation-key-v2';
  /** Scheduling-only upgrade audit; never execution or historical coverage. */
  conditionMigration?: { version?: 2; status: 'migrated' | 'invalidated' | 'split'; fromKey: string; toKey?: string; reason: string;
    sources: (EvidenceRef & { actionId: string })[];
    children?: { itemId: string; kind: 'condition' | 'unverified-source'; scope: Scope; required: boolean; dispatchScope: boolean; operationConditionKey?: string; sources: EvidenceRef[] }[];
    unverifiedSources?: { source: EvidenceRef; reason: string }[];
    previousInvalidation?: { reason: string; sources: (EvidenceRef & { actionId: string })[] };
    /** Missing or inconsistent children restore an explicit gap, never success. */
    integrityFailure?: string };
  conditionLineage?: { parentItemId: string; policy: 'operation-condition-split-v1'; kind: 'condition' | 'unverified-source'; fromKey: string };
  status: 'pending' | 'succeeded' | 'blocked' | 'unresolved' | 'untested' | 'excluded' | 'superseded';
  required: boolean; reason: string; evidence: EvidenceRef[]; resolvedBy?: EvidenceRef;
  /** Classification evidence closes a review obligation, never an executed action. */
  reviewResolvedBy?: EvidenceRef & {classificationId:string;classification:'display'|'container'};
  /** SDK-verified historical member coverage; no execution occurred for this row. */
  coverageResolvedBy?: {observation:EvidenceRef; relatedItemIds:string[]};
  /** An obligation or gap is not execution authority. Only accepted plan scopes authorize dispatch. */
  dispatchScope?: boolean;
  attempts: { roundId: string; outcome: string; evidence?: EvidenceRef }[];
}
export interface EntryRoute {
  entry:Scope; targets:Scope[]; context:string;
  evidence:EvidenceRef & {beforeId:string};
  /** Retained source revision only; never an identity, reachability or replay grant. */
  sourceConditionKey?:string;
  sourcePolicy?:{replayable:boolean;risk:ActionAttempt['action']['risk'];basisKey:string;effectsAssessment?:ActionAttempt['effectsAssessment'];executionProfile?:ActionAttempt['executionProfile']};
  /** Captured expectation only; repeat permission is freshly assessed by the SDK. */
  expected?: {url:string;boundaryKeys:string[];boundaryConditionKey?:string};
}
export interface Frame { checkpointId: string; observationId: string; stateId: string; used: string[]; remaining: Scope[]; path: Scope[]; recoveryTried?: boolean; recoveryConditionVersion?: string;
  recoveryFailure?: {status:'unreachable'|'invalidated';reason:string;conditionVersion:string;targets:Scope[]};
}
export interface Round {
  id: string; number: number; sessionId: string; startedAt: string; endedAt?: string;
  status: 'running' | 'paused' | 'finished'; reason?: string; actions: number;
  stack: Frame[]; entryPath: Scope[]; reentries: string[]; tried: string[]; reviewed: string[]; lastProgress?: string; noProgress: number;
  /** Current browser position, independent of durable work and historical frames. */
  position?: NavigationPosition;
  repetitionDeferrals?: string[];
  evidenceRefreshes?: string[];
  /** No repeated LLM interpretation of the same target and evidence within a round. */
  semanticReviews?: string[];
  /** Unresolved purpose evidence only. These entries never carry an execution grant. */
  unresolvedPurposeReviews?: Record<string,{decisionId:string;observationId:string}>;
  /** A freshly observed boundary visit may need its own exit despite historical coverage. */
  boundaryVisit?: {key:string;instanceScope:string;observationId:string;scopeId?:string};
  /** Bound repeated entry despite changing uncompleted labels; saved across restart. */
  reentryProgress?: Record<string,{attempts:number;completedScopes:string[];notified?:boolean;revalidationNotified?:boolean}>;
  /** Verified revealed targets; historical tasks may lack route proof. */
  entryRoutes?: EntryRoute[];
  routeDeferrals?: string[];
  /** Immutable retained attempts already examined for legacy route recovery. */
  routeEvidenceChecked?: string[];
  policyVersion?: string;
}
/** Versioned projection of immutable observations for legacy hint migration only.
 * Contains no identity, review or execution grants. Missing sources are not cached.
 */
export interface ScopeMigrationIndex {
  version:1|2; keys:string[];
  sources:Record<string,{sessionId:string;observationId:string;examinedKeys:number;matches:{stableKey:string;scope:Scope;key:string}[]}>;
}
export interface Task {
  id: string; goal: string; url: string; createdAt: string; updatedAt: string; revision: number;
  scopeMigrationIndex?:ScopeMigrationIndex;
  status: TaskStatus; reason?: string; budget: Budget; usage: Budget; activeSince?: number;
  /** Durable stop intent, recorded before awaiting in-flight work; not a settled time. */
  pauseRequestedAt?: number;
  /** Crash recovery charges only through persisted activity. Additional active
   * duration is in [0, additionalMsUpperBound]; null means no trustworthy bound.
   * Budgets use usage.durationMs, a lower bound, not a strict wall-time guarantee. */
  durationUncertainty?: { interruptions: number; additionalMsUpperBound: number | null; budgetBasis: 'persisted-activity-lower-bound' };
  sessionOptions: Partial<SessionOptions>; plan: PlanItem[]; rounds: Round[];
  obligations?: ObligationProjection;
  routeRetries?: RouteRetryLedger;
  /** Durable target rotation and route hints; never an execution/coverage grant. */
  scheduling?: ObligationSchedule;
  /** Per-session retained artifacts; no protected evidence is discarded to make room. */
  evidenceBudget?: {maxBytes:number;maxObservations:number};
  sampleExcluded: string[];
  pendingDispatch?: { sessionId:string; requestId:string; decisionId?:string; itemIds:string[]; observationId:string } &
    ({actionId:string;probe?:never}|{actionId?:never;probe:{localId:string;kind:'hover'|'focus';scope:Scope}});
  /** Isolated navigation failures remain unresolved and must never be replayed by later rounds. */
  unverifiedNavigations?: {sourceUrl:string;targetUrl:string;evidence:EvidenceRef}[];
  /** Recovery has no pendingDispatch; retain its unknown source across restarts/rounds.
   * Only the source host's verified continuation can release these attempt IDs. */
  unverifiedRecoveries?: {sessionId:string;observationId?:string;attemptIds:string[];sourceUnavailable?:boolean}[];
  exhaustive: false;
  /** Absent on historical tasks; their saved scopes remain authoritative. */
  intent?: TaskIntent;
  /** Only a user setting permits representative sampling. Missing on older tasks means all. */
  coverageMode?: 'all' | 'representative';
  /** Explicit user acceptance of observed noncritical unsupported content; never tested coverage. */
  acceptedLimitations?: {code:string;reason:string;at:string}[];
}
export type DecisionKind = 'choice' | 'noul' | 'checklist' | 'generate';
export type DecisionPolicy = 'ranking'|'discovery'|'coverage'|'classification'|'identity'|'evidence-gate'|'planning-gate'|'recovery'|'grouping'|'task-intent';
export interface ModelRequest { id: string; triggeredBy?: string; purpose: string; kind: DecisionKind; instructions: string; state: unknown; options?: Record<string, unknown>; schema?: Record<string, unknown>; policy?: DecisionPolicy; fallbackOption?: string; allowedReductions?: string[]; blockedOptions?: string[]; checks?: Record<string, {instructions:string}> }
export interface ModelAnswer { value: unknown; model: string; confidence?: number; probability?: number; probabilities?: Record<string, number>; usage?: Record<string, number>; response?: Record<string, unknown> }
export interface Provider { name: string; model: string; requestBody?(request: ModelRequest): Record<string, unknown>; decide(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer> }
export interface Providers {
  jev?: Provider; llm?: Provider;
  /** Legacy defaults; groupingThreshold is retained for source compatibility but no longer used. */
  choiceThreshold?: number; groupingThreshold?: number; noulLow?: number; noulHigh?: number; timeoutMs?: number;
  thresholds?: Partial<Record<'classification'|'identity'|'evidence'|'planning',number>>;
  operationProbability?: {low:number;high:number};
}
export interface Decision {
  id: string; taskId: string; revision: number; roundId?: string; sessionId?: string; observationId?: string;
  actor: 'jev' | 'llm'; purpose: string; provider: string; model: string; request: ModelRequest;
  triggeredBy?: string;
  input?: Record<string, unknown>; output?: Record<string, unknown>;
  resolution?: {source:'program'|'jev';value:unknown;reason:string;threshold?:number;bounds?:{low:number;high:number};policy?:DecisionPolicy;policyVersion?:string};
  status: 'requested' | 'returned' | 'applied' | 'rejected' | 'stale' | 'cancelled' | 'failed';
  startedAt: string; elapsedMs?: number; answer?: ModelAnswer; reason?: string; fallbackFrom?: string;
}
export interface ExplorerEvent { sequence: number; taskId: string; at: string; actor: 'program' | 'jev' | 'llm' | 'engine'; type: string; sessionId?: string; observationId?: string; decisionId?: string; attemptId?: string; data: unknown }
export interface TaskView { task: Task; decisions: Decision[]; events: ExplorerEvent[] }
export class ExplorerError extends Error { constructor(public code: string, message = code, public response?: Record<string, unknown>) { super(message); } }
