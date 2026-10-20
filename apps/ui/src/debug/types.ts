export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Scroll offset and viewport of a screenshot, or of the page when an action ran. */
export interface ScreenView {
  scroll: { x: number; y: number };
  viewport: { width: number; height: number };
}

/** Run records and the slim events the debug API returns (state keys are short ids). */
export interface Run {
  id: string;
  url: string;
  status: 'running' | 'finished' | 'failed' | 'interrupted';
  summary?: Summary;
  error?: string;
  createdAt: string;
  options: {
    resumeFrom?: string;
    plugins?: string[];
    durationMs?: number;
    viewport?: ViewportOption;
    models?: boolean;
    goal?: string;
  };
}
export type ViewportPreset = 'desktop' | 'desktop-edge' | 'mobile';
export type ViewportOption = ViewportPreset | { width: number; height: number; mobile?: boolean };
export interface ResolvedViewport {
  preset?: ViewportPreset;
  width: number;
  height: number;
  mobile: boolean;
  source: 'preset' | 'custom' | 'detected' | 'fallback';
  breakpoints?: number[];
  note?: string;
}
export type StopReason =
  | 'goal_answered'
  | 'scope_exhausted'
  | 'no_progress'
  | 'time_limit'
  | 'action_limit'
  | 'stopped'
  | 'session_invalid'
  | 'error';
export interface ModelMeter {
  calls: number;
  costUsd: number;
  elapsedMs?: number;
  failures?: number;
  unpricedCalls?: number;
}
export interface Summary {
  elapsedMs: number;
  stopReason?: StopReason;
  viewport?: ResolvedViewport;
  actions: number;
  states: number;
  resumedStates?: number;
  failed: number;
  backtracks?: number;
  onEntryPage: number;
  models?: { jev: ModelMeter; llm: ModelMeter };
  navigations?: { intercepted: number; sameDocument: unknown[] };
  /** Goal mode with a question: whether the page answered it. */
  pursuit?: {
    question: string;
    answered: boolean;
    /** An answer from absence only stands once the scope was exhausted. */
    settled: boolean;
    result?: { answer: string; found: boolean; provisional: boolean; url: string; at: number; reason: string };
    llmCalls: number;
    costUsd: number;
    steeredActions: number;
  };
  goal?: { plan: GoalPlan; prunedClasses: number; offAreaClasses: number };
  coverage?: {
    pages: { page: string; classesExecuted: number; classesSeen: number; textBlocksRevealedByActions: number }[];
    statesPerMinute: number[];
  };
}
/** What the LLM made of a goal prompt; areas are ARIA landmarks. */
export interface GoalPlan {
  goal: string;
  stayOnPage: boolean;
  allowedPaths: string[];
  areas: ('banner' | 'navigation' | 'contentinfo')[];
  focus: string[];
  tasks: string[];
  question: string;
}
/** One look the LLM took at a state while pursuing the goal's question. */
export type PursuitEvent = {
  seq: number;
  type: 'pursuit';
  at: number;
  /** State id. */
  state: string;
  url: string;
  answered: boolean;
  found: boolean;
  answer: string;
  next?: string;
  reason: string;
};
export interface Step {
  kind: string;
  classKey: string;
  label: string;
  value?: string;
  purpose?: string;
  /** A second try at a target that was covered by another element the first time. */
  retry?: boolean;
  from?: string;
  to?: string;
  /** Id of the state the step was taken in. */
  state?: string;
}
export type ActionEvent = {
  seq: number;
  type: 'action';
  at: number;
  step: Step;
  url: string;
  tier: string;
  outcome: 'ok' | 'failed' | 'no_change';
  newState: boolean;
  overlay?: string;
  error?: string;
  after?: string;
  /** Where the target was on screen when the action ran (viewport pixels). */
  target?: ScreenView & { box: Box };
  /** Screenshot id taken just before the action, when the state's own screenshot cannot show the target. */
  shot?: string;
};
export type JudgementEvent = {
  seq: number;
  type: 'judgement';
  at: number;
  question: string;
  label: string;
  verdict: 'yes' | 'no' | 'uncertain';
  source: string;
  probability?: number;
  detail?: string;
  /** Effect questions: how sure JEV was that the text came from the page itself, not the action. */
  unrelated?: number;
};
export type NavigationEvent = {
  seq: number;
  type: 'navigation';
  at: number;
  kind: string;
  from?: string;
  to: string;
  action: string;
  outcome: string;
};
export type BacktrackEvent = { seq: number; type: 'backtrack'; at: number; reason: string; url?: string };
export type FindingEvent = {
  seq: number;
  type: 'finding';
  at: number;
  plugin: string;
  state: string;
  url: string;
  finding: {
    rule: string;
    severity: 'info' | 'warning' | 'error';
    selector: string;
    text: string;
    detail: string;
    /** Result code; older runs only have it at the start of `detail`. */
    code?: string;
    /** Where the element was on screen in this state; `shot` when measured further down the page. */
    target?: FindingTarget;
  };
};
/** Where an element was on screen, and the picture it was measured on when not the state's own. */
export type FindingTarget = ScreenView & { box: Box; shot?: string };
export type PluginErrorEvent = {
  seq: number;
  type: 'plugin_error';
  at: number;
  plugin: string;
  state: string;
  error: string;
};
/** What one check concluded on a state, in counts (see the crawler's CheckSummary). */
export interface CheckSummary {
  id: string;
  verdict: 'pass' | 'fail' | 'unknown' | 'not-applicable';
  targets: number;
  counts?: Partial<Record<CheckSummary['verdict'], number>>;
  ms: number;
  /** Why targets did not pass: the most frequent codes per verdict, with how many targets each covers. */
  codes?: { code: string; verdict: Exclude<CheckSummary['verdict'], 'pass'>; count: number }[];
}
export interface CheckInfo {
  id: string;
  name: string;
  description?: string;
}
export type ChecksEvent = { seq: number; type: 'checks'; at: number; plugin: string; checks: CheckInfo[] };
/**
 * One plugin's pass over the state announced just before it. `repeated`: earlier findings seen
 * again, by their order among findings.
 */
export type InspectionEvent = {
  seq: number;
  type: 'inspection';
  at: number;
  plugin: string;
  ms: number;
  captureMs?: number;
  checks?: CheckSummary[];
  repeated?: { finding: number; target?: FindingTarget }[];
  /** Explanations of result codes used here for the first time in the run. */
  reasons?: Record<string, string>;
};
/**
 * A new state scrolled to the end, announced right after it: per surface (the page, or a container's
 * selector) the screens looked at and how it ended. 'endless' is an infinite feed, not exhausted.
 */
export type SweepEvent = {
  seq: number;
  type: 'sweep';
  at: number;
  ms: number;
  surfaces: {
    surface: string;
    screens: number;
    end: 'end' | 'endless' | 'repeats' | 'budget';
    ms?: number;
    revealed?: number;
    /** Controls of a class not seen before: what the sweep added to exploration. */
    newClasses?: number;
  }[];
  /** Surfaces not swept again: nothing beyond the first screen changed since their last sweep. */
  skipped?: string[];
  /** Controls that were not in the first capture of the state. */
  revealed: number;
};
export type Event =
  | { seq: number; type: 'viewport'; at: number; viewport: ResolvedViewport }
  | { seq: number; type: 'session'; at: number; provider: string }
  | {
      seq: number;
      type: 'state';
      at: number;
      state: { key: string; url: string; overlay?: string; controls: number };
      view?: ScreenView;
      /**
       * Revealed by an action (text or a typed value) rather than reached by structure, and whether
       * it is announced right after that action (newer runs) or right before it (older runs).
       */
      revealed?: 'after' | 'before';
    }
  | ActionEvent
  | NavigationEvent
  | JudgementEvent
  | BacktrackEvent
  | { seq: number; type: 'goal'; at: number; plan: GoalPlan }
  | PursuitEvent
  | { seq: number; type: 'stop'; at: number; reason: string }
  | FindingEvent
  | PluginErrorEvent
  | ChecksEvent
  | InspectionEvent
  | SweepEvent;

export interface ModelCallSummary {
  id: number;
  at: number;
  ms: number;
  provider: 'jev' | 'llm';
  model: string;
  purpose: string;
  kind: string;
  items: number;
  subject: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}
export interface ModelCall extends ModelCallSummary {
  request: {
    instructions: string;
    state: unknown;
    checks?: Record<string, { instructions: string }>;
    options?: Record<string, unknown>;
  };
  answer?: { value: unknown; probability?: number; confidence?: number; probabilities?: Record<string, number> };
}
