import type { BrowserEngine, SessionOptions } from '@interaction/browser';

/** Only documented public operations. Never a browser handle or engine persistence. */
export type ExplorerHost = Pick<BrowserEngine, 'sessions' | 'session' | 'createSession' | 'observation' | 'observe' | 'actions' | 'execute' | 'command' | 'getFrontier' | 'report' | 'list' | 'regionReviewMaterial' | 'explorationReviewMaterial' | 'controlClassificationMaterial' | 'controlReviewMaterial' | 'purposeReviewMaterial' | 'discoveryScanMaterial' | 'createCheckpoint' | 'reachCheckpoint' | 'pause' | 'stop' | 'events' | 'pinEvidence' | 'unpinEvidence'>;
export type TaskStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'blocked' | 'budget_exhausted' | 'configuration_required';
export interface Budget { rounds: number; actions: number; durationMs: number; modelRequests: number }
export interface EvidenceRef { sessionId: string; observationId: string; attemptId?: string }
/** Exact semantic constraints; no old session control IDs or arbitrary selectors. */
export interface Scope { stableKey?: string; url?: string; region?: string; label?: string; role?: string; kind?: string; value?: string | boolean | number }
export interface PlanItem {
  id: string; title: string; scope: Scope; prerequisites: Scope[]; completion: string;
  status: 'pending' | 'succeeded' | 'blocked' | 'unresolved' | 'untested' | 'excluded';
  required: boolean; reason: string; evidence: EvidenceRef[]; resolvedBy?: EvidenceRef;
  /** An obligation or gap is not execution authority. Only accepted plan scopes authorize dispatch. */
  dispatchScope?: boolean;
  attempts: { roundId: string; outcome: string; evidence?: EvidenceRef }[];
}
export interface Frame { checkpointId: string; observationId: string; stateId: string; used: string[]; remaining: Scope[]; path: Scope[]; recoveryTried?: boolean }
export interface Round {
  id: string; number: number; sessionId: string; startedAt: string; endedAt?: string;
  status: 'running' | 'paused' | 'finished'; reason?: string; actions: number;
  stack: Frame[]; entryPath: Scope[]; reentries: string[]; tried: string[]; reviewed: string[]; lastProgress?: string; noProgress: number;
  evidenceRefreshes?: string[];
  policyVersion?: string;
}
export interface Task {
  id: string; goal: string; url: string; createdAt: string; updatedAt: string; revision: number;
  status: TaskStatus; reason?: string; budget: Budget; usage: Budget; activeSince?: number;
  sessionOptions: Partial<SessionOptions>; plan: PlanItem[]; rounds: Round[];
  sampleExcluded: string[]; pendingDispatch?: { sessionId: string; requestId: string; actionId: string; decisionId?: string; itemIds: string[]; observationId: string };
  exhaustive: false;
  /** Only a user setting permits representative sampling. Missing on older tasks means all. */
  coverageMode?: 'all' | 'representative';
}
export type DecisionKind = 'choice' | 'noul' | 'checklist' | 'generate';
export type DecisionPolicy = 'ranking'|'discovery'|'coverage'|'classification'|'identity'|'evidence-gate'|'planning-gate'|'recovery'|'grouping';
export interface ModelRequest { id: string; purpose: string; kind: DecisionKind; instructions: string; state: unknown; options?: Record<string, unknown>; schema?: Record<string, unknown>; policy?: DecisionPolicy; fallbackOption?: string; allowedReductions?: string[]; blockedOptions?: string[]; checks?: Record<string, {instructions:string}> }
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
  input?: Record<string, unknown>; output?: Record<string, unknown>;
  resolution?: {source:'program'|'jev';value:unknown;reason:string;threshold?:number;bounds?:{low:number;high:number};policy?:DecisionPolicy;policyVersion?:string};
  status: 'requested' | 'returned' | 'applied' | 'rejected' | 'stale' | 'cancelled' | 'failed';
  startedAt: string; elapsedMs?: number; answer?: ModelAnswer; reason?: string; fallbackFrom?: string;
}
export interface ExplorerEvent { sequence: number; taskId: string; at: string; actor: 'program' | 'jev' | 'llm' | 'engine'; type: string; sessionId?: string; observationId?: string; decisionId?: string; attemptId?: string; data: unknown }
export interface TaskView { task: Task; decisions: Decision[]; events: ExplorerEvent[] }
export class ExplorerError extends Error { constructor(public code: string, message = code, public response?: Record<string, unknown>) { super(message); } }
