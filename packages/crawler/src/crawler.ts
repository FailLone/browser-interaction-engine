import { BrowserDriver, type DOMSnapshot } from './browser/driver.js';
import type { Control, Rect } from './browser/types.js';
import { initialViewport, type ResolvedViewport, type ViewportOption } from './browser/viewport.js';
import {
  composeSessions,
  type PreparedSession,
  type SessionCheck,
  type SessionKeys,
  type SessionProvider,
  sessionKeys,
} from './session.js';
import {
  activeOverlay,
  controlClass as baseClass,
  listClass,
  maskVolatile,
  modeGroup,
  modeSiblings,
  pagePath,
  pageTemplate,
  stateKey,
  type Snapshot,
} from './abstraction.js';
import {
  SAFETY_RULES,
  allowed,
  defaultPolicy,
  linkTarget,
  placement,
  submitsForm,
  type CrawlKind,
  type CrawlPolicy,
} from './policy.js';
import {
  findingKey,
  type CheckInfo,
  type CheckSummary,
  type CrawlPlugin,
  type CrawlStateContext,
  type Finding,
  type FindingTarget,
  type PluginResult,
} from './plugin.js';
import type { Judge, Question } from './judge.js';
import { excludedAreas, GoalPursuit, GoalRelevance, planGoal, type GoalPlan } from './goal.js';
import { metered, type ProviderMeter } from './meter.js';
import {
  defaultSweep,
  restore,
  show,
  sweep,
  type SweepMemory,
  type SweptSurface,
  type SweepOptions,
  type SweepResult,
} from './sweep.js';
import type { CrawlLedger } from './store.js';
import {
  classifyInput,
  inputSamples,
  judgeInputKind,
  readInputFacts,
  readSearchScope,
  type InputKind,
} from './inputs.js';
import type { Provider } from './providers.js';

export interface CrawlOptions {
  url: string;
  headless?: boolean;
  /** Screen to crawl on: `desktop` (default), `desktop-edge`, `mobile` or a custom size. */
  viewport?: ViewportOption;
  /**
   * Browser state to restore and keep checking: a logged-in account, an experiment variant, or
   * several combined (e.g. `[login, experiment]`); they must not set the same cookie or header.
   */
  session?: SessionProvider | SessionProvider[];
  durationMs?: number;
  maxActions?: number;
  /** Samples per action class; list members default to `listSamples`. */
  samples?: number;
  listSamples?: number;
  /** Distinct pages visited per page template (e.g. /convert/*); only with `followNavigation`. */
  pageSamples?: number;
  /** Actions spent on any non-entry page before it is left for other work; only with `followNavigation`. */
  pageActions?: number;
  /**
   * Default false: the crawler tests the current page only. Every document navigation away from
   * it is intercepted (the request is aborted, the current document and its state stay intact)
   * and recorded as an outgoing link. Same-document URL changes (hash, history.pushState) are
   * recorded and undone; with `inPageRoutes` 'explore' (default) they are re-run once all other
   * in-page work is done, with 'skip' never.
   */
  followNavigation?: boolean;
  inPageRoutes?: 'explore' | 'skip';
  settleMs?: number;
  policy?: CrawlPolicy;
  /** Model plugin for questions the program cannot settle (weak controls, invisible effects). */
  judge?: Judge;
  /** JEV used to classify input fields whose structure does not settle their kind. */
  inputJudge?: Provider;
  /**
   * Goal mode: site-wide areas (header, navigation, footer) the plan leaves out are not acted on;
   * JEV prunes the remaining action classes irrelevant to the goal; relevant ones run first.
   */
  relevance?: GoalRelevance;
  /**
   * Goal mode with a question: the LLM looks at every new state, steers toward the action most
   * likely to answer it, and the crawl stops once the page answers it. When the LLM sees no
   * promising action, the crawler keeps exploring the scope, which reveals hidden content.
   */
  pursuit?: GoalPursuit;
  /**
   * Goal mode from a prompt: once the page is open (in its session), the LLM plans scope and a
   * question from the entry page's visible controls, then `relevance` and `pursuit` are built from
   * that plan. Plan paths are added to the policy; a plan that leaves the page follows navigation.
   */
  goal?: { text: string; llm: Provider; jev: Provider };
  /** Resume: work recorded by an earlier run of the same target is not repeated. */
  ledger?: CrawlLedger;
  /** Aborting stops the crawl after the current action; the summary is still produced. */
  signal?: AbortSignal;
  /** Called with a viewport screenshot (WebP) of every newly discovered state. */
  onScreenshot?: (state: string, image: Buffer) => void | Promise<void>;
  /** Plugins (UI rules, checks) that observe each newly discovered state; composed by the host. */
  plugins?: CrawlPlugin[];
  /**
   * Scroll each new state to the end (the page, then each scrolling container) so content below
   * the first screen or rendered only while scrolled near is explored and checked. `false` acts
   * on the first screen as captured; clicks still scroll their own target into view.
   */
  sweep?: Partial<SweepOptions> | false;
  /** Called once per newly discovered abstract state, after checks. */
  onState?: (state: CrawlState, page: import('playwright').Page) => Promise<void> | void;
  log?: (event: CrawlEvent) => void;
}

export interface CrawlState {
  key: string;
  url: string;
  overlay?: string;
  firstSeenAt: number;
  controls: number;
}
export interface Step {
  kind: CrawlKind;
  classKey: string;
  label: string;
  value?: string;
  purpose?: string;
  /** A second try at a target that was covered by another element the first time. */
  retry?: boolean;
  /** Page the step was taken on; used to rewind past a whole page when backtracking. */
  from?: string;
  /** Page after the step; differs from `from` when the step navigated. */
  to?: string;
  /** Abstract state the step was taken in. */
  state?: string;
  /** Visible page (state + masked text) before / after the step; equal ends mark a removable loop. */
  sigBefore?: string;
  sigAfter?: string;
  /**
   * The step only revealed text (a tooltip, an answer) and left the structural state as it was.
   * A replay can skip it when no later step depends on it; see `trimReplay`.
   */
  textOnly?: boolean;
  /** Structural state after the step: what a replay must land on. */
  stateAfter?: string;
}
export type CrawlEvent =
  /** The viewport the crawl runs in, emitted once the page is open. */
  | { type: 'viewport'; at: number; viewport: ResolvedViewport }
  /** The session restored into the browser, and each check of it. */
  | { type: 'session'; at: number; provider: string; session: Record<string, unknown>; check?: SessionCheck }
  | {
      type: 'state';
      at: number;
      state: CrawlState;
      path: number;
      /** Scroll offset and viewport when the state's screenshot was taken, to place marks on it. */
      view?: { scroll: { x: number; y: number }; viewport: { width: number; height: number } };
      /** The action that revealed this state as text or a typed value; it is announced right after it. */
      revealedBy?: string;
    }
  | {
      type: 'action';
      at: number;
      step: Step;
      url: string;
      overlay?: string;
      tier: string;
      outcome: 'ok' | 'failed' | 'no_change';
      error?: string;
      newState: boolean;
      after: string;
      /**
       * Where the target was on screen when the action ran: its box in viewport pixels, the
       * page's scroll offset and the viewport size. Lets a screenshot of that moment mark it.
       */
      target?: { box: Rect; scroll: { x: number; y: number }; viewport: { width: number; height: number } };
      /**
       * A screenshot taken just before the action, when the state's own screenshot was taken at
       * another scroll position and so cannot show where the target is.
       */
      shot?: string;
    }
  | { type: 'backtrack'; at: number; reason: string; url: string }
  | { type: 'finding'; at: number; plugin: string; finding: Finding; state: string; url: string }
  | { type: 'plugin_error'; at: number; plugin: string; state: string; error: string }
  /**
   * A new state scrolled to the end: per surface (the page, or a container's selector), how many
   * screens and how it ended. 'endless' is an infinite feed: it is sampled, not exhausted, and not
   * scrolled again on this page. `revealed` counts controls that were not in the first capture.
   */
  | {
      type: 'sweep';
      at: number;
      ms: number;
      surfaces: Omit<SweptSurface, 'grew'>[];
      /** Surfaces not swept again: nothing beyond the first screen changed since their last sweep. */
      skipped?: string[];
      revealed: number;
    }
  /** The checks a plugin runs, named once at the start so inspections carry only ids. */
  | { type: 'checks'; at: number; plugin: string; checks: CheckInfo[] }
  /**
   * One plugin's pass over the state announced just before (its key is not repeated, it runs to
   * several KB): how long it took (`captureMs` of that for the detailed capture, when this plugin
   * took it) and what each check concluded. `repeated` lists findings seen again here that were
   * reported on an earlier state, by their order among the run's findings, with where the
   * element is in this state. `reasons` explains the result codes used here for the first time
   * in the run.
   */
  | {
      type: 'inspection';
      at: number;
      plugin: string;
      ms: number;
      captureMs?: number;
      checks?: CheckSummary[];
      repeated?: { finding: number; target?: FindingTarget }[];
      reasons?: Record<string, string>;
    }
  /** A navigation the action triggered: intercepted document load, same-document route change, or popup. */
  | {
      type: 'navigation';
      at: number;
      kind: 'document' | 'same-document' | 'popup';
      from: string;
      to: string;
      action: string;
      outcome: 'intercepted' | 'kept' | 'reverted' | 'followed';
    }
  | {
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
    }
  /** Goal pursuit: what the LLM concluded on a state, and which action (if any) it chose. */
  | {
      type: 'pursuit';
      at: number;
      state: string;
      url: string;
      answered: boolean;
      /** The answer quotes the page; an answer from absence waits for the rest of the scope. */
      found: boolean;
      answer: string;
      next?: string;
      reason: string;
    }
  /** Goal mode: the plan the LLM made from the prompt and the entry page. */
  | { type: 'goal'; at: number; plan: GoalPlan }
  | { type: 'stop'; at: number; reason: StopReason };

/**
 * Why a crawl ended: the page answered the goal's question (goal_answered), everything
 * reachable was tested (scope_exhausted), the page kept
 * reopening something without progress (no_progress), a limit was reached, the caller
 * stopped it, the session's check failed (session_invalid), or it failed.
 */
export type StopReason =
  | 'goal_answered'
  | 'scope_exhausted'
  | 'no_progress'
  | 'time_limit'
  | 'action_limit'
  | 'stopped'
  | 'session_invalid'
  | 'error';

interface Candidate {
  control: Control;
  kind: CrawlKind;
  classKey: string;
  tier: number;
  tierName: string;
  value?: string;
  relevance?: number;
  /** For fill: which sample of the input's kind (e.g. existing / empty search). */
  purpose?: string;
  /** A second try at a target that was covered the first time. */
  retry?: boolean;
}

// Everything that stays on the current page (including site-chrome menus) runs
// before any navigation; otherwise the entry page's own UI waits behind other pages.
const TIERS = ['overlay', 'body', 'in-page-disclosure', 'chrome', 'navigate', 'route'] as const;
/** Unnamed icons hovered per state, at most; each icon kind is hovered once per crawl. */
const ICONS_PER_STATE = 3;
/** A small, unnamed element that only signals interactivity through its pointer cursor. */
function isHintIcon(c: Control) {
  const r = c.rect;
  return (
    !(c.name || c.label || c.displayedText) &&
    !!r &&
    r.width > 0 &&
    r.height > 0 &&
    r.width <= 32 &&
    r.height <= 32 &&
    !!c.interactionHints?.some(h => h.rule === 'pointer-cursor/v1')
  );
}

/**
 * Crawljax-style sampled crawler: abstract states, action classes sampled k
 * times, overlays first, in-scope pages only, backtracking by replay from the
 * entry URL. No per-action proofs; an action that fails is recorded and skipped.
 */
export class SampledCrawler {
  readonly states = new Map<string, CrawlState>();
  /** Executions per action class (state independent): the sampling budget. */
  readonly classCounts = new Map<string, number>();
  readonly failedClasses = new Set<string>();
  /**
   * Classes whose target was covered by another element when tried, with the state it was
   * covered in. A cover is often temporary (a closing menu, an animation), so the class gets one
   * more try later, ranked after everything else, in any other state.
   */
  private readonly covered = new Map<string, string>();
  private stopReason?: StopReason;
  /** Prepared sessions not yet released, with whether every check of each passed so far. */
  private sessions: { provider: SessionProvider; session: PreparedSession; verified: boolean; lastCheck: number }[] =
    [];
  private get providers() {
    const session = this.options.session;
    return session ? (Array.isArray(session) ? session : [session]) : [];
  }
  /** Verification per provider, kept after release for the summary. */
  private readonly sessionResults = new Map<string, boolean>();
  /**
   * Mode groups (tab rows, radio groups) whose first sampled member revealed
   * nothing new: the rest only redraw something we cannot inspect (e.g. a canvas chart).
   */
  readonly flatModeGroups = new Set<string>();
  /** Mode groups with at least one member executed. */
  private readonly sampledModeGroups = new Map<string, boolean>();
  /** Distinct concrete pages entered per page template. */
  readonly templatePages = new Map<string, Set<string>>();
  /** Actions executed per concrete page. */
  readonly pageCounts = new Map<string, number>();
  /** Distinct visible members seen per list class, to show how much sampling skipped. */
  readonly listMembers = new Map<string, Set<string>>();
  readonly events: CrawlEvent[] = [];
  readonly findings = new Map<string, Finding & { plugin: string; url: string; state: string }>();
  /** Each reported finding's order among the run's findings, by key. */
  private readonly findingOrder = new Map<string, number>();
  /** Result codes already explained in this run, per plugin. */
  private readonly explained = new Map<string, Set<string>>();
  private adapter!: BrowserDriver;
  private path: Step[] = [];
  /** Document of the entry page currently loaded; route changes keep it, a page load replaces it. */
  private entryDocument?: string;
  /** Document navigation intercepted during the current dispatch. */
  private intercepted?: string;
  /** Popup opened during the current dispatch. */
  private popup?: string;
  /** Outgoing navigations recorded per (page, target page). */
  readonly links = new Map<
    string,
    { from: string; to: string; kind: 'document' | 'same-document' | 'popup'; action: string; count: number }
  >();
  /** Backtracks served by browser history instead of replay. */
  private historyBacks = 0;
  /** Backtracks that loaded the last page by URL and replayed only its in-page steps. */
  private directLoads = 0;
  /** Replay steps skipped because they only revealed text, and replays that stopped short. */
  private trimmedSteps = 0;
  private brokenReplays = 0;
  /** Backtracks done in place (pointer moved away, Escape) without reloading. */
  private inPlaceBacks = 0;
  /**
   * Cookies and web storage as they were once the entry page had loaded. Sites remember choices
   * (currency, language) there, so a reload after such a choice is not the page the crawl started
   * from; restoring this first makes every replay start from the same page.
   */
  private initialStorage?: Awaited<ReturnType<import('playwright').BrowserContext['storageState']>> & {
    session: { origin: string; entries: [string, string][] }[];
  };
  /** Reloads that restored the initial storage first. */
  private storageRestores = 0;
  /** Where the current action's target was on screen, measured just before it ran. */
  private lastTarget?: Extract<CrawlEvent, { type: 'action' }>['target'];
  /** Scroll position of each state's screenshot, to tell whether it shows where an action happens. */
  private readonly shotScroll = new Map<string, { x: number; y: number }>();
  /** The state the current action runs in, while its target may still need a screenshot. */
  private shootFor?: string;
  /** Screenshot taken just before the current action, when its state's screenshot does not show it. */
  private actionShot?: string;
  private actionShots = 0;
  /** Page text at the last dispatch, used to pick search terms that should match. */
  private lastText = '';
  /** True from dispatch until the post-action settle completes. */
  private dispatching = false;
  private readonly started = Date.now();
  private readonly options: Required<
    Omit<
      CrawlOptions,
      | 'onState'
      | 'log'
      | 'judge'
      | 'relevance'
      | 'pursuit'
      | 'goal'
      | 'inputJudge'
      | 'ledger'
      | 'signal'
      | 'onScreenshot'
      | 'session'
    >
  > &
    Pick<
      CrawlOptions,
      | 'onState'
      | 'log'
      | 'judge'
      | 'relevance'
      | 'pursuit'
      | 'goal'
      | 'inputJudge'
      | 'ledger'
      | 'signal'
      | 'onScreenshot'
      | 'session'
    >;
  /** Weak controls the judge confirmed as interactive, by component class. */
  private readonly confirmed = new Set<string>();
  /** Input kind per input component class: structural, judged by JEV, or defaulted. */
  readonly inputKinds = new Map<string, { kind: InputKind; source: 'structure' | 'jev' | 'default' }>();
  /** Candidate class keys each state offered when last seen. */
  private readonly pending = new Map<string, string[]>();
  private lastCandidates: string[] = [];
  /** Replay steps removed because they formed a loop with no visible effect. */
  private prunedSteps = 0;
  /** Fill placeholder keys ('...|first') whose input kind and samples are now known. */
  private readonly resolvedFills = new Set<string>();
  /** List classes the judge found to hold different kinds of things: members are classed individually. */
  private readonly splitLists = new Set<string>();
  /** List classes already asked about. */
  private readonly askedLists = new Set<string>();

  /**
   * The list a member belongs to, for the same-kind question: template plus the owner's member
   * names (instance IDs change per document), so two lists sharing a template stay apart.
   */
  private ownerNames = new Map<string, string>();
  private listOf(c: Control) {
    const list = listClass(c),
      owner = c.structuralItem?.ownerInstanceId;
    return list && `${list}@${owner ? (this.ownerNames.get(owner) ?? '') : ''}`;
  }

  /** Component class, with judged-heterogeneous lists split into their members. */
  private classOf = (c: Control) => {
    const list = this.listOf(c);
    return list && this.splitLists.has(list)
      ? `${list}|${maskVolatile(c.name || c.label || c.displayedText || '')}`
      : baseClass(c);
  };

  /** Action classes whose effect was a same-document route change; ranked last. */
  private readonly routeClasses = new Set<string>();
  /** Action classes JEV judged irrelevant to the goal. */
  private readonly pruned = new Set<string>();
  /** Goal mode: control classes skipped because they sit in a site-wide area outside the plan. */
  private readonly offArea = new Set<string>();
  /** Form submit controls left alone, by label. */
  private readonly submitsSkipped = new Set<string>();
  /** Weak control classes already asked about. */
  private readonly asked = new Set<string>();

  constructor(options: CrawlOptions) {
    this.options = {
      headless: true,
      viewport: 'desktop',
      durationMs: 240_000,
      maxActions: 200,
      samples: 1,
      listSamples: 2,
      pageSamples: 2,
      pageActions: 20,
      followNavigation: false,
      inPageRoutes: 'explore',
      settleMs: 600,
      policy: defaultPolicy(options.url),
      plugins: [],
      ...options,
      sweep: options.sweep ?? {},
    };
  }
  /** Everything a later run needs to continue where this one stopped. */
  ledger(): CrawlLedger {
    return {
      classCounts: [...this.classCounts],
      failedClasses: [...this.failedClasses],
      confirmed: [...this.confirmed],
      asked: [...this.asked],
      splitLists: [...this.splitLists],
      askedLists: [...this.askedLists],
      inputKinds: [...this.inputKinds],
      flatModeGroups: [...this.flatModeGroups],
      resolvedFills: [...this.resolvedFills],
      states: [...this.states.keys()],
    };
  }

  private restore(ledger: CrawlLedger) {
    for (const [k, v] of ledger.classCounts) this.classCounts.set(k, v);
    for (const k of ledger.failedClasses) this.failedClasses.add(k);
    for (const k of ledger.confirmed) this.confirmed.add(k);
    for (const k of ledger.asked) this.asked.add(k);
    for (const k of ledger.splitLists) this.splitLists.add(k);
    for (const k of ledger.askedLists) this.askedLists.add(k);
    for (const [k, v] of ledger.inputKinds)
      this.inputKinds.set(k, v as { kind: InputKind; source: 'structure' | 'jev' | 'default' });
    for (const k of ledger.flatModeGroups) this.flatModeGroups.add(k);
    for (const k of ledger.resolvedFills) this.resolvedFills.add(k);
    // Known states stay known (not re-announced or re-checked), stamped as found before this run.
    for (const k of ledger.states) this.states.set(k, { key: k, url: this.options.url, firstSeenAt: -1, controls: 0 });
  }

  private emit(event: CrawlEvent) {
    this.events.push(event);
    this.options.log?.(event);
  }
  private now() {
    return Date.now() - this.started;
  }
  private get page() {
    return this.adapter.page!;
  }

  async run() {
    if (this.options.ledger) this.restore(this.options.ledger);
    const target = { url: this.options.url, viewport: initialViewport(this.options.viewport) };
    try {
      // Prepared in order; one that fails releases those before it (an account lock, say).
      for (const provider of this.providers)
        this.sessions.push({ provider, session: await provider.prepare(target), verified: false, lastCheck: 0 });
      const composed = composeSessions(this.sessions.map(s => ({ id: s.provider.id, session: s.session })));
      this.adapter = new BrowserDriver({
        url: this.options.url,
        headless: this.options.headless,
        viewport: this.options.viewport,
        actionTimeoutMs: 2000,
        ...(this.sessions.length ? composed : {}),
      });
      await this.adapter.start();
    } catch (error) {
      await this.releaseSessions();
      await this.adapter?.close();
      throw error;
    }
    this.emit({ type: 'viewport', at: this.now(), viewport: this.adapter.viewport });
    for (const { provider, session } of this.sessions)
      this.emit({ type: 'session', at: this.now(), provider: provider.id, session: session.describe });
    for (const plugin of this.options.plugins) {
      const checks = plugin.checks?.();
      if (checks?.length) this.emit({ type: 'checks', at: this.now(), plugin: plugin.id, checks });
    }
    // Document navigations are decided before they happen. Aborting with 'aborted' cancels the
    // load and leaves the current document, its DOM and its state untouched (no error page).
    // Popups (window.open, target=_blank) are stopped before they load. Page routes take
    // precedence over context routes, so popups are the only navigations this one sees.
    await this.adapter.context!.route('**/*', async route => {
      const request = route.request();
      if (!request.isNavigationRequest()) return route.fallback();
      // A popup's first request is issued before its frame exists.
      let frame: ReturnType<typeof request.frame> | undefined;
      try {
        frame = request.frame();
      } catch {
        frame = undefined;
      }
      if (frame && frame.page() === this.page) return route.fallback();
      if (this.dispatching) this.popup = request.url();
      return route.abort('aborted');
    });
    // Registered after the adapter's own page route, so it runs first for the main frame.
    await this.page.route('**/*', async route => {
      const request = route.request();
      if (!request.isNavigationRequest() || request.frame() !== this.page.mainFrame()) return route.fallback();
      const target = request.url(),
        current = this.page.url();
      // A different path, or the same page under another locale prefix (re-renders everything).
      const leaving = pagePath(target) !== pagePath(current) || rawPath(target) !== rawPath(current);
      const intercept =
        this.dispatching &&
        (placementOfUrl(target, this.options) === 'outside' || (leaving && !this.options.followNavigation));
      if (intercept) {
        this.intercepted = target;
        return route.abort('aborted');
      }
      // Outside an action (initial load, explicit backtrack) only out-of-scope loads are refused.
      if (!this.dispatching && placementOfUrl(target, this.options) === 'outside') return route.abort('aborted');
      return route.fallback();
    });
    // Popups (window.open, target=_blank) are recorded and closed; the current page is unaffected.
    this.adapter.context!.on('page', popup => {
      if (popup === this.page) return;
      if (this.dispatching && !this.popup && popup.url() !== 'about:blank') this.popup = popup.url();
      void popup.close();
    });
    let actions = 0,
      idleBacktracks = 0,
      stop: StopReason = 'time_limit';
    try {
      await this.settle();
      // A crawl never runs on a page whose session check failed: it would test the login page.
      if (!(await this.checkSession(true))) stop = 'session_invalid';
      else {
        await this.saveInitialStorage();
        await this.applyGoal();
      }
      while (stop !== 'session_invalid' && this.now() < this.options.durationMs && actions < this.options.maxActions) {
        if (this.options.signal?.aborted) {
          stop = 'stopped';
          break;
        }
        if (!this.page.url().startsWith('http')) {
          await this.restoreInitialStorage();
          await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await this.settle();
          this.path = [];
        }
        if (!(await this.checkSession())) {
          stop = 'session_invalid';
          break;
        }
        let snapshot = await this.snapshot();
        if (pagePath(snapshot.url) === pagePath(this.options.url)) this.entryDocument = snapshot.documentId;
        this.swept = false;
        await this.visit(snapshot);
        if (this.swept) {
          this.swept = false;
          const fresh = await this.snapshot();
          // What scrolling loaded makes another state: announce and check it before acting.
          if (stateKey(fresh) !== stateKey(snapshot)) continue;
          snapshot = fresh;
        }
        await this.reviewWeakControls(snapshot);
        await this.assessRelevance(snapshot);
        if (await this.pursue(snapshot)) {
          stop = 'goal_answered';
          break;
        }
        const candidate = this.choose(snapshot);
        this.pending.set(stateKey(snapshot), this.lastCandidates);
        if (!candidate) {
          // Every action spends class budget, so action loops end; backtracks spend none.
          // A page that keeps reopening an overlay or redirecting must not spin until the deadline.
          // Each backtrack rewinds the path, so a run of them ends at the entry page; the cap
          // only guards pages that keep reopening an overlay or redirecting.
          if (++idleBacktracks <= 8 && (await this.backtrack(snapshot, 'state_exhausted'))) continue;
          stop = idleBacktracks > 8 ? 'no_progress' : 'scope_exhausted';
          break;
        }
        actions++;
        idleBacktracks = 0;
        await this.act(snapshot, candidate);
      }
      if (stop === 'time_limit' && actions >= this.options.maxActions) stop = 'action_limit';
    } catch (error) {
      stop = 'error';
      throw error;
    } finally {
      for (const plugin of this.options.plugins) {
        try {
          if (plugin.onEnd) this.report(plugin.id, await plugin.onEnd(), this.page?.url() ?? this.options.url, '');
        } catch (error) {
          this.emit({
            type: 'plugin_error',
            at: this.now(),
            plugin: plugin.id,
            state: '',
            error: String(error).slice(0, 300),
          });
        }
      }
      this.stopReason = stop;
      this.emit({ type: 'stop', at: this.now(), reason: stop });
      await this.releaseSessions();
      await this.adapter.close();
    }
    return this.summary();
  }

  /** Goal planning's LLM spend, when the goal came as a prompt. */
  private planning?: ProviderMeter;

  /** Goal mode from a prompt: plan on the open entry page, as the run's session shows it. */
  private async applyGoal() {
    const goal = this.options.goal;
    if (!goal) return;
    const planner = metered(goal.llm);
    this.planning = planner.meter;
    const dom = await this.adapter.readDOM();
    const plan = await planGoal(
      planner,
      goal.text,
      this.options.url,
      dom.controls.filter(c => c.visible),
    );
    for (const pattern of plan.allowedPaths) this.options.policy.allowedPaths.push(new RegExp(pattern));
    if (!plan.stayOnPage) this.options.followNavigation = true;
    this.options.relevance = new GoalRelevance(goal.jev, plan);
    // A goal that asks something of the page is pursued step by step until the page answers it.
    if (plan.question) this.options.pursuit = new GoalPursuit(goal.llm, plan);
    this.emit({ type: 'goal', at: this.now(), plan });
  }

  /** Run each session's check now (`force`) or when its recheck interval has passed; false stops the crawl. */
  private async checkSession(force = false) {
    for (const entry of this.sessions) {
      const { provider, session } = entry;
      if (!session.check) {
        entry.verified = true;
        continue;
      }
      if (!force && this.now() - entry.lastCheck < (session.recheckMs ?? 60_000)) continue;
      entry.lastCheck = this.now();
      const check = await session.check(this.page).catch(
        (error): SessionCheck => ({
          ok: false,
          reason: 'check_error',
          facts: { error: String(error).slice(0, 300) },
        }),
      );
      entry.verified = check.ok && (force || entry.verified);
      this.emit({ type: 'session', at: this.now(), provider: provider.id, session: session.describe, check });
      if (!check.ok) return false;
    }
    return true;
  }

  /** Hand every session back exactly once (unlock the account, remove temporary files). */
  private async releaseSessions() {
    const sessions = this.sessions;
    this.sessions = [];
    const keys = sessions.map(s => sessionKeys(s.session));
    for (const [i, { provider, session, verified }] of sessions.entries()) {
      this.sessionResults.set(provider.id, verified);
      // What the other sessions put in, so a session saving storage does not take it along.
      const foreign: SessionKeys = {
        cookies: keys.filter((_, j) => j !== i).flatMap(k => k.cookies),
        localStorage: keys.filter((_, j) => j !== i).flatMap(k => k.localStorage),
      };
      await session.release({ context: this.adapter?.context, verified, foreign }).catch(error =>
        this.emit({
          type: 'plugin_error',
          at: this.now(),
          plugin: provider.id,
          state: '',
          error: String(error).slice(0, 300),
        }),
      );
    }
  }

  summary() {
    const origin = new URL(this.options.url).origin;
    const offSite = (l: { kind: string; to: string }) => {
      try {
        return l.kind === 'popup' || new URL(l.to).origin !== origin;
      } catch {
        return true;
      }
    };
    const actions = this.events.filter((e): e is Extract<CrawlEvent, { type: 'action' }> => e.type === 'action');
    const entry = pagePath(this.options.url);
    return {
      elapsedMs: this.now(),
      stopReason: this.stopReason,
      viewport: this.adapter?.viewport,
      ...(this.providers.length
        ? {
            sessions: this.providers.map(p => ({
              provider: p.id,
              verified: this.sessionResults.get(p.id) ?? this.sessions.find(s => s.provider === p)?.verified ?? false,
              checks: this.events.filter(e => e.type === 'session' && e.check && e.provider === p.id).length,
            })),
          }
        : {}),
      actions: actions.length,
      states: [...this.states.values()].filter(st => st.firstSeenAt >= 0).length,
      resumedStates: [...this.states.values()].filter(st => st.firstSeenAt < 0).length,
      onEntryPage: actions.filter(a => pagePath(a.url) === entry).length,
      inOverlay: actions.filter(a => a.overlay).length,
      failed: actions.filter(a => a.outcome === 'failed').length,
      byTier: Object.fromEntries(TIERS.map(t => [t, actions.filter(a => a.tier === t).length])),
      maxPerClass: Math.max(0, ...this.classCounts.values()),
      backtracks: this.events.filter(e => e.type === 'backtrack').length,
      historyBacks: this.historyBacks,
      prunedSteps: this.prunedSteps,
      // The rules in force for this run, and what each one kept the crawler from doing.
      // Off-site: another origin or a new window; the rest are other pages of this site.
      safety: SAFETY_RULES.map(rule => ({
        ...rule,
        skipped:
          rule.id === 'form-submit'
            ? [...this.submitsSkipped]
            : rule.id === 'goal-area'
              ? this.offArea.size
              : rule.id === 'leave-page' || rule.id === 'outside-site'
                ? [...this.links.values()].filter(
                    l => l.kind !== 'same-document' && (rule.id === 'outside-site') === offSite(l),
                  ).length
                : undefined,
      })),
      trimmedSteps: this.trimmedSteps,
      brokenReplays: this.brokenReplays,
      inPlaceBacks: this.inPlaceBacks,
      storageRestores: this.storageRestores,
      navigations: {
        intercepted: [...this.links.values()].filter(l => l.kind !== 'same-document').length,
        sameDocument: [...this.links.values()]
          .filter(l => l.kind === 'same-document')
          .map(l => ({ from: l.from, to: l.to, action: l.action })),
        outgoingPages: [
          ...new Set([...this.links.values()].filter(l => l.kind !== 'same-document').map(l => pagePath(l.to))),
        ].length,
      },
      directLoads: this.directLoads,
      judge: this.options.judge?.stats,
      models: modelCost(
        [this.options.judge?.stats.jev, this.options.relevance?.meter],
        [this.options.judge?.stats.llm, this.planning, this.options.pursuit?.meter],
      ),
      weakControlsConfirmed: this.confirmed.size,
      splitLists: this.splitLists.size,
      inputs: {
        classes: this.inputKinds.size,
        kinds: Object.fromEntries(
          [...this.inputKinds.values()].reduce(
            (m, k) => m.set(`${k.kind}:${k.source}`, (m.get(`${k.kind}:${k.source}`) || 0) + 1),
            new Map<string, number>(),
          ),
        ),
        filled: actions
          .filter(a => a.step.kind === 'fill')
          .map(a => ({
            label: a.step.label,
            purpose: a.step.purpose,
            value: a.step.value?.slice(0, 20),
            outcome: a.outcome,
            newState: a.newState,
          })),
      },
      hovers: actions.filter(a => a.step.kind === 'hover').length,
      modeGroups: { sampled: this.sampledModeGroups.size, flat: this.flatModeGroups.size },
      coverage: this.coverageReport(),
      pursuit: this.options.pursuit && {
        question: this.options.pursuit.plan.question,
        answered: !!this.options.pursuit.result,
        // An answer from absence stands once the scope is exhausted; any other stop leaves it open.
        settled:
          !!this.options.pursuit.result &&
          (!this.options.pursuit.result.provisional || this.stopReason === 'scope_exhausted'),
        result: this.options.pursuit.result,
        llmCalls: this.options.pursuit.meter.calls,
        costUsd: this.options.pursuit.meter.costUsd,
        steeredActions: this.options.pursuit.steered,
      },
      goal: this.options.relevance && {
        plan: this.options.relevance.plan,
        jevCalls: this.options.relevance.calls,
        prunedClasses: this.pruned.size,
        excludedAreas: excludedAreas(this.options.relevance.plan),
        offAreaClasses: this.offArea.size,
      },
      lists: {
        classes: this.listMembers.size,
        membersSeen: [...this.listMembers.values()].reduce((n, m) => n + m.size, 0),
        executed: [...this.listMembers.keys()].reduce((n, k) => n + (this.classCounts.get(k) || 0), 0),
      },
      pages: [...new Set([...this.states.values()].map(st => pagePath(st.url)))].length,
      findings: Object.fromEntries(
        [...new Set([...this.findings.values()].map(f => `${f.plugin}/${f.rule}`))].map(rule => [
          rule,
          [...this.findings.values()].filter(f => `${f.plugin}/${f.rule}` === rule).length,
        ]),
      ),
    };
  }

  private async settle() {
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForTimeout(this.options.settleMs);
  }

  /**
   * Text-derived names grow when a trigger reveals a tooltip inside itself ("24h low" becomes
   * "24h lowThe lowest price..."). Within one document, an element keeps the name it was first
   * seen with, so the same trigger is not taken for a new control.
   */
  private readonly firstNames = new Map<string, string>();

  private async snapshot(): Promise<Snapshot> {
    const dom = await this.adapter.readDOM();
    const byOwner = new Map<string, string[]>();
    for (const c of dom.controls as Control[])
      if (c.structuralItem) {
        const list = byOwner.get(c.structuralItem.ownerInstanceId) || [];
        list.push(maskVolatile(c.name));
        byOwner.set(c.structuralItem.ownerInstanceId, list);
      }
    this.ownerNames = new Map([...byOwner].map(([owner, names]) => [owner, names.slice(0, 3).join('|')]));
    for (const c of dom.controls as Control[]) {
      const first = this.firstNames.get(c.instanceId);
      if (first === undefined) this.firstNames.set(c.instanceId, c.name);
      else if (first && c.name !== first && c.name.startsWith(first) && !c.label) c.name = first;
    }
    return {
      url: dom.url,
      title: dom.title,
      text: dom.text,
      controls: dom.controls as Control[],
      overlays: dom.overlays,
      regions: dom.regions,
      documentId: dom.documentId,
      capture: dom,
    };
  }

  /** A page is worth entering if it is the entry, already known, or its template has budget left. */
  private pageAllowed(url: string) {
    if (pagePath(url) === pagePath(this.options.url)) return true;
    const pages = this.templatePages.get(pageTemplate(url));
    return !pages || pages.has(pagePath(url)) || pages.size < this.options.pageSamples;
  }

  /**
   * Coverage per page: every actionable component class ever seen (visible), and
   * every text block ever shown, versus what was executed / revealed by actions.
   */
  private readonly coverage = new Map<string, { seen: Set<string>; text: Set<string>; initialText: Set<string> }>();

  private observeCoverage(s: Snapshot) {
    const page = pagePath(s.url);
    let row = this.coverage.get(page);
    const blocks = textBlocks(s.text || '');
    if (!row) {
      row = { seen: new Set(), text: new Set(), initialText: new Set(blocks) };
      this.coverage.set(page, row);
    }
    for (const c of s.controls)
      if (c.visible && (c.actions.length || this.confirmed.has(this.classOf(c))))
        for (const kind of kindsFor(c, this.confirmed, this.classOf)) row.seen.add(`${kind}|${this.classOf(c)}`);
    for (const b of blocks) row.text.add(b);
  }

  /** Per-page coverage and the discovery curve (new states per minute). */
  coverageReport() {
    const executed = new Map<string, Set<string>>();
    for (const e of this.events)
      if (e.type === 'action' && e.outcome !== 'failed') {
        const set = executed.get(pagePath(e.url)) || new Set();
        set.add(e.step.kind === 'fill' ? e.step.classKey.slice(0, e.step.classKey.lastIndexOf('|')) : e.step.classKey);
        executed.set(pagePath(e.url), set);
      }
    const pages = [...this.coverage.entries()].map(([page, row]) => {
      const done = executed.get(page) || new Set();
      const sampledLists = [...row.seen].filter(k => k.includes('|list:')).length;
      const executedClasses = [...row.seen].filter(k => done.has(k)).length;
      return {
        page,
        classesSeen: row.seen.size,
        classesExecuted: executedClasses,
        classCoverage: row.seen.size ? +(executedClasses / row.seen.size).toFixed(2) : 0,
        listClasses: sampledLists,
        textBlocksSeen: row.text.size,
        textBlocksRevealedByActions: [...row.text].filter(t => !row.initialText.has(t)).length,
      };
    });
    const minutes = Math.max(1, Math.ceil(this.now() / 60000));
    const fresh = [...this.states.values()].filter(st => st.firstSeenAt >= 0);
    const curve = Array.from(
      { length: minutes },
      (_, m) => fresh.filter(st => st.firstSeenAt < (m + 1) * 60000).length,
    );
    const last = [...this.states.values()].reduce((t, st) => Math.max(t, st.firstSeenAt), 0);
    return { pages, statesPerMinute: curve, lastNewStateAtMs: last };
  }

  private stateSequence = 0;

  /** Explanations of the codes these summaries use for the first time in this run. */
  private newReasons(plugin: CrawlPlugin, checks: CheckSummary[] | undefined, found: Finding[]) {
    const known = plugin.reasons?.();
    if (!known) return;
    const explained = this.explained.get(plugin.id) ?? new Set<string>();
    this.explained.set(plugin.id, explained);
    const fresh: Record<string, string> = {};
    const codes = [...(checks ?? []).flatMap(c => c.codes ?? []).map(r => r.code), ...found.map(f => f.code)];
    for (const code of codes)
      if (code && known[code] && !explained.has(code)) {
        explained.add(code);
        fresh[code] = known[code];
      }
    return Object.keys(fresh).length ? fresh : undefined;
  }

  /** Reports new findings; returns the order of those already reported earlier. */
  private report(plugin: string, found: Finding[], url: string, state: string) {
    const repeated: { finding: number; target?: FindingTarget }[] = [];
    for (const finding of found) {
      const key = findingKey(plugin, finding);
      const known = this.findingOrder.get(key);
      if (known !== undefined) {
        if (this.findings.get(key)?.state !== state)
          repeated.push({ finding: known, ...(finding.target ? { target: finding.target } : {}) });
        continue;
      }
      this.findingOrder.set(key, this.findings.size);
      this.findings.set(key, { ...finding, plugin, url, state });
      this.emit({ type: 'finding', at: this.now(), plugin, finding, state, url });
    }
    return repeated;
  }

  /**
   * Announces a state the first time it is seen: event, screenshot, plugins. `key` overrides the
   * structural key for a state an action revealed as text only (a tooltip, an answer).
   */
  private async visit(s: Snapshot, key = stateKey(s), revealedBy?: Step) {
    const template = pageTemplate(s.url),
      pages = this.templatePages.get(template) || new Set<string>();
    pages.add(pagePath(s.url));
    this.templatePages.set(template, pages);
    this.observeCoverage(s);
    if (this.states.has(key)) return false;
    const overlay = activeOverlay(s);
    const state: CrawlState = {
      key,
      url: s.url,
      overlay: overlay && `${overlay.kind}:${maskVolatile(overlay.name)}`,
      firstSeenAt: this.now(),
      controls: s.controls.filter(c => c.visible).length,
    };
    this.states.set(key, state);
    const view = this.options.onScreenshot
      ? ((await this.page.evaluate(viewInPage).catch(() => undefined)) as
          | Extract<CrawlEvent, { type: 'state' }>['view']
          | undefined)
      : undefined;
    this.emit({
      type: 'state',
      at: this.now(),
      state,
      path: this.path.length,
      ...(view ? { view } : {}),
      ...(revealedBy ? { revealedBy: revealedBy.classKey } : {}),
    });
    if (view) this.shotScroll.set(key, view.scroll);
    if (this.options.onScreenshot) {
      // WebP at this quality is about a third of a PNG and still sharp enough to read page text.
      const image = await this.page.screenshot({ type: 'webp', quality: 80, timeout: 3000 }).catch(() => undefined);
      if (image) await this.options.onScreenshot(key, image);
    }
    if (this.options.plugins.length) {
      let detail: Promise<DOMSnapshot> | undefined;
      const sequence = ++this.stateSequence;
      // Taken before sweeping: scrolling can load content the state as announced does not have.
      const first = (async () => {
        const t = performance.now();
        const capture = await this.adapter.readDOM(true);
        return { capture, ms: Math.round(performance.now() - t) };
      })();
      await first;
      const swept = await this.sweep(s, true);
      for (const plugin of this.options.plugins) {
        const started = performance.now();
        let captureMs: number | undefined;
        const context: CrawlStateContext = {
          state: key,
          sequence,
          url: s.url,
          snapshot: s.capture!,
          page: this.page,
          // Taken once per state and shared by every plugin.
          detail: () =>
            (detail ??= first.then(f => {
              captureMs = f.ms;
              return f.capture;
            })),
          views: () => swept?.views ?? [],
          unchanged: () => swept?.skipped ?? [],
          shoot: async view => {
            if (!this.options.onScreenshot) return;
            await show(this.page, view, this.sweepOptions.settleMs);
            const image = await this.page
              .screenshot({ type: 'webp', quality: 80, timeout: 3000 })
              .catch(() => undefined);
            if (!image) return;
            const id = `view:${++this.actionShots}`;
            await this.options.onScreenshot(id, image);
            return id;
          },
          runtime: () => this.adapter.runtime(),
          reportError: message =>
            this.emit({
              type: 'plugin_error',
              at: this.now(),
              plugin: plugin.id,
              state: key,
              error: message.slice(0, 300),
            }),
        };
        try {
          const result = await plugin.onState(context);
          const repeated = this.report(plugin.id, findingsOf(result), s.url, key);
          const checks = Array.isArray(result) ? undefined : result.checks;
          const reasons = this.newReasons(plugin, checks, findingsOf(result));
          this.emit({
            type: 'inspection',
            at: this.now(),
            plugin: plugin.id,
            ms: Math.round(performance.now() - started),
            ...(captureMs !== undefined ? { captureMs } : {}),
            ...(checks?.length ? { checks } : {}),
            ...(repeated.length ? { repeated } : {}),
            ...(reasons ? { reasons } : {}),
          });
        } catch (error) {
          this.emit({
            type: 'plugin_error',
            at: this.now(),
            plugin: plugin.id,
            state: key,
            error: String(error).slice(0, 300),
          });
        }
      }
      // Screenshots of views scrolled the page again.
      if (swept) await restore(this.page, swept).catch(() => {});
    } else await this.sweep(s, false);
    await this.options.onState?.(state, this.page);
    return true;
  }

  private get sweepOptions(): SweepOptions {
    return { ...defaultSweep, ...(this.options.sweep || {}) };
  }

  /**
   * Set when a new state was scrolled to the end. Scrolling can load content (lazy sections,
   * feeds), so the capture taken before is stale: the walk re-reads the page before acting, or the
   * loaded content would be credited to the next action.
   */
  private swept = false;
  /** Surfaces found to be infinite feeds, per page: sampled once, never scrolled to the end again. */
  private readonly endless = new Map<string, Set<string>>();
  /** What sweeps saw, per page and open overlay. */
  private readonly sweepMemory = new Map<string, SweepMemory>();

  /** Scroll a new state to the end, page then containers, and record what that showed. */
  private async sweep(s: Snapshot, detailed: boolean): Promise<SweepResult | undefined> {
    if (this.options.sweep === false || !s.capture) return;
    const page = pagePath(s.url),
      overlay = activeOverlay(s)?.key;
    const skip = this.endless.get(page) ?? new Set<string>();
    const memoryKey = `${page}|${overlay ?? ''}`;
    const seen = this.sweepMemory.get(memoryKey) ?? {
      extents: new Map(),
      classes: new Set(),
      checked: new Set(),
      reached: 0,
    };
    this.sweepMemory.set(memoryKey, seen);
    const result = await sweep(this.page, this.adapter, s.capture, {
      ...this.sweepOptions,
      detailed,
      overlay,
      skip,
      seen,
    }).catch(() => undefined);
    if (!result?.surfaces.length && !result?.skipped.length) return result;
    this.swept = true;
    for (const surface of result.surfaces) if (surface.end === 'endless') skip.add(surface.surface);
    this.endless.set(page, skip);
    const known = new Set(s.controls.map(c => c.instanceId));
    const revealed = new Set(
      result.views.flatMap(v => v.capture.controls.filter(c => !known.has(c.instanceId)).map(c => c.instanceId)),
    );
    this.emit({
      type: 'sweep',
      at: this.now(),
      ms: result.ms,
      surfaces: result.surfaces.map(({ grew: _, ...surface }) => surface),
      ...(result.skipped.length ? { skipped: result.skipped } : {}),
      revealed: revealed.size,
    });
    return result;
  }

  /** Ask the judge about visible controls that only have weak interaction hints. */
  private async reviewWeakControls(s: Snapshot) {
    const judge = this.options.judge;
    if (!judge) return;
    const overlay = activeOverlay(s),
      scope = overlay && new Set(overlay.controlIds);
    const offAreas = this.options.relevance ? excludedAreas(this.options.relevance.plan) : [];
    // Controls the goal leaves out are never acted on, so there is nothing to ask about them.
    const outOfScope = (c: Control) =>
      (scope && !scope.has(c.localId)) || (!scope && !!c.landmark && offAreas.includes(c.landmark));
    const batch: { cls: string; label: string; question: Question }[] = [];
    for (const c of s.controls) {
      if (!c.visible || c.actions.length || !c.interactionHints?.length || c.actionable.occludedBy || outOfScope(c))
        continue;
      const name = c.name || c.displayedText;
      if (!name) continue;
      const cls = this.classOf(c);
      if (this.asked.has(cls)) continue;
      this.asked.add(cls);
      batch.push({
        cls,
        label: name.slice(0, 60),
        question: {
          kind: 'interactive',
          control: {
            tag: c.tag,
            role: c.role,
            name: maskVolatile(name),
            hints: c.interactionHints.map(h => h.rule),
            text: maskVolatile(c.displayedText || ''),
            context:
              [c.landmark, s.regions?.find(r => r.key === c.region)?.label]
                .filter(Boolean)
                .map(x => maskVolatile(String(x)))
                .join(' / ') || undefined,
          },
        },
      });
    }
    // Lists whose members look different ask whether they are one kind of thing (same batch).
    const lists = new Map<string, Control[]>();
    for (const c of s.controls) {
      const list = this.listOf(c);
      if (!list || !c.visible || !c.actions.length || this.askedLists.has(list) || outOfScope(c)) continue;
      const members = lists.get(list) || [];
      members.push(c);
      lists.set(list, members);
    }
    const listBatch: { list: string; question: Question }[] = [];
    for (const [list, members] of lists) {
      const names = [
        ...new Set(members.map(c => maskVolatile(c.name || c.label || c.displayedText || '')).filter(Boolean)),
      ].slice(0, 12);
      if (names.length < 2 || !distinctNames(names)) continue;
      this.askedLists.add(list);
      listBatch.push({ list, question: { kind: 'same-kind', role: members[0].role, members: names } });
    }
    if (!batch.length && !listBatch.length) return;
    const all = [...batch.map(b => b.question), ...listBatch.map(b => b.question)];
    const results = judge.askAll ? await judge.askAll(all) : await Promise.all(all.map(q => judge.ask(q)));
    const answers = results.slice(0, batch.length);
    listBatch.forEach(({ list, question }, i) => {
      const answer = results[batch.length + i];
      this.emit({
        type: 'judgement',
        at: this.now(),
        question: 'same-kind',
        label: (question as { members: string[] }).members.slice(0, 4).join(' / ').slice(0, 60),
        verdict: answer.verdict,
        source: answer.source,
        probability: answer.probability,
      });
      // Only a confident "different functions" splits the list; uncertain keeps sampling it as one.
      if (answer.verdict === 'no') this.splitLists.add(list);
    });
    batch.forEach(({ cls, label }, i) => {
      const answer = answers[i];
      this.emit({
        type: 'judgement',
        at: this.now(),
        question: 'interactive',
        label,
        verdict: answer.verdict,
        source: answer.source,
        probability: answer.probability,
      });
      // Uncertain weak controls are tried once: a click is cheaper and more accurate than an LLM.
      if (answer.verdict !== 'no') this.confirmed.add(cls);
    });
  }

  private budget(classKey: string) {
    return classKey.startsWith('list:') ? this.options.listSamples : this.options.samples;
  }

  /** All currently executable, still-unsampled candidates, ranked by tier. */
  candidates(s: Snapshot, applyGoal = true, sampled = true): Candidate[] {
    const overlay = activeOverlay(s);
    const scope = overlay ? new Set(overlay.controlIds) : undefined;
    const siblings = modeSiblings(s);
    const rows: Candidate[] = [];
    let icons = 0;
    const plan = applyGoal ? this.options.relevance?.plan : undefined;
    const offAreas = plan ? excludedAreas(plan) : [];
    for (const c of s.controls) {
      // Goal scope: site-wide areas the goal is not about are left alone, links included.
      // An open overlay is still handled (it may have to be closed), wherever it was rendered.
      if (c.landmark && offAreas.includes(c.landmark) && !scope?.has(c.localId)) {
        if (c.visible) this.offArea.add(this.classOf(c));
        continue;
      }
      // A small unnamed icon with a pointer cursor often shows a tooltip on hover (an info icon).
      // Hovering is safe; one per icon kind and a few per state keep it cheap.
      if (
        c.visible &&
        !c.actions.length &&
        isHintIcon(c) &&
        !c.actionable.occludedBy &&
        (!scope || scope.has(c.localId))
      ) {
        const classKey = `hover|${this.classOf(c)}`;
        if (icons < ICONS_PER_STATE && !this.failedClasses.has(classKey) && !(this.classCounts.get(classKey) || 0)) {
          icons++;
          const tierName = scope ? 'overlay' : c.landmark ? 'chrome' : 'in-page-disclosure';
          rows.push({ control: c, kind: 'hover', classKey, tier: TIERS.indexOf(tierName), tierName });
        }
        continue;
      }
      if (!c.visible || (!c.actions.length && !this.confirmed.has(this.classOf(c)))) continue;
      // An open overlay masks the page beneath it: never fight the backdrop.
      if (scope && !scope.has(c.localId)) continue;
      if (!scope && c.actionable.occludedBy) continue;
      const where = placement(c, s.url, this.options.url, this.options.policy);
      // Testing the current page only: a link's destination is recorded, never visited, so a
      // link elsewhere needs no click at all (its href is already the record).
      if (where === 'outside' || (where === 'navigate' && !this.options.followNavigation)) {
        if (where === 'navigate' || where === 'outside') this.noteLink(c, s.url);
        continue;
      }
      if (where === 'navigate' && !this.pageAllowed(linkTarget(c, s.url)!)) continue;
      for (const kind of kindsFor(c, this.confirmed, this.classOf)) {
        if (!allowed(c, kind)) {
          if (c.visible && submitsForm(c))
            this.submitsSkipped.add((c.name || c.label || c.reviewBinding?.attributes.alt || c.tag).slice(0, 60));
          continue;
        }
        const classKey = `${kind}|${this.classOf(c)}`;
        if (classKey.includes('|list:')) {
          const seen = this.listMembers.get(classKey) || new Set();
          seen.add(`${pagePath(s.url)}|${c.name}`);
          this.listMembers.set(classKey, seen);
        }
        const coveredIn = this.covered.get(classKey);
        const retry = coveredIn !== undefined;
        // A covered target is retried once, and not in the state where it was covered.
        if (retry && coveredIn === stateKey(s)) continue;
        if (
          kind !== 'fill' &&
          !retry &&
          (this.failedClasses.has(classKey) ||
            (sampled && (this.classCounts.get(classKey) || 0) >= this.budget(classKey)))
        )
          continue;
        const group = kind === 'click' ? modeGroup(c, s.url, siblings) : undefined;
        // A flat group's members are skipped as redundant; a retry was never tried, so it still goes.
        if (sampled && group && !retry && this.flatModeGroups.has(group)) continue;
        const disclosure =
          c.expanded !== null ||
          ['tab', 'menuitem', 'option', 'combobox'].includes(c.role) ||
          kind === 'hover' ||
          kind === 'fill';
        if (this.routeClasses.has(classKey) && this.options.inPageRoutes === 'skip') continue;
        const tierName = scope
          ? 'overlay'
          : this.routeClasses.has(classKey)
            ? 'route'
            : where === 'navigate'
              ? 'navigate'
              : c.landmark
                ? 'chrome'
                : disclosure
                  ? 'in-page-disclosure'
                  : 'body';
        const relevance = applyGoal ? this.options.relevance : undefined;
        // An open overlay must still be handled even when its contents are off-goal.
        if (sampled && relevance && !scope && !relevance.relevant(classKey)) continue;
        const row = {
          control: c,
          kind,
          classKey,
          tier: TIERS.indexOf(tierName),
          tierName,
          value: kind === 'check' ? String(!c.checked) : undefined,
          relevance: relevance?.score(classKey),
          ...(retry ? { retry: true } : {}),
        };
        if (kind !== 'fill') {
          rows.push(row);
          continue;
        }
        // Each sample purpose of an input is its own class; its kind is settled at first use.
        const inputKind = this.inputKinds.get(this.classOf(c))?.kind;
        for (const purpose of inputKind ? inputSamples(inputKind, emptyFacts, '').map(x => x.purpose) : ['first']) {
          const sampleKey = `${classKey}|${purpose}`;
          if (this.failedClasses.has(sampleKey) || (sampled && (this.classCounts.get(sampleKey) || 0) >= 1)) continue;
          rows.push({ ...row, classKey: sampleKey, purpose });
        }
      }
    }
    // Stable ranking: tier, then reading order (top-left first).
    // Within a mode group, try an unselected member first: it is the one that can switch content.
    const isSelected = (r: Candidate) =>
      Number(r.control.selected.length > 0 || r.control.checked === true || r.control.pressed === true);
    // Goal mode ranks by relevance inside the overlay-first rule; otherwise tier then reading order.
    const goal = (r: Candidate) => (r.tierName === 'overlay' ? 2 : (r.relevance ?? 0.5));
    // Retries of covered targets come after everything else: they are a second chance, not new work.
    return rows.sort(
      (a, b) =>
        Number(!!a.retry) - Number(!!b.retry) ||
        (applyGoal && this.options.relevance ? goal(b) - goal(a) : 0) ||
        a.tier - b.tier ||
        isSelected(a) - isSelected(b) ||
        a.control.rect.y - b.control.rect.y ||
        a.control.rect.x - b.control.rect.x,
    );
  }

  /** Goal mode: score this state's new action classes in one JEV batch. */
  private async assessRelevance(s: Snapshot) {
    const relevance = this.options.relevance;
    if (!relevance) return;
    const rows = this.candidates(s, false);
    await relevance.assess(rows.map(r => ({ classKey: r.classKey, description: describe(r) })));
    for (const r of rows)
      if (!relevance.relevant(r.classKey) && !this.pruned.has(r.classKey)) {
        this.pruned.add(r.classKey);
        this.emit({
          type: 'judgement',
          at: this.now(),
          question: 'relevance',
          label: r.control.name.slice(0, 60),
          verdict: 'no',
          source: 'jev',
          probability: relevance.score(r.classKey),
        });
      }
  }

  /** Goal pursuit: the control and action the LLM picked for this state. */
  private steer?: { state: string; row: Candidate };
  /** Goal pursuit: specific actions already run; never offered again. */
  private readonly picked = new Set<string>();

  /** Goal pursuit: look at this state once; true when the page answered the question. */
  private async pursue(s: Snapshot) {
    const pursuit = this.options.pursuit;
    if (!pursuit || !pursuit.plan.question) return false;
    const key = stateKey(s);
    // One option per control, not per class, and regardless of sampling budgets or relevance
    // pruning: the answer may sit behind the one list member the sampler would skip.
    const rows = [
      ...new Map(
        this.candidates(s, true, false)
          .filter(r => !this.picked.has(pick(r)))
          .map(r => [pick(r), r]),
      ).values(),
    ];
    const options = rows.map(r => ({ classKey: pick(r), description: describe(r) }));
    const before = pursuit.meter.calls;
    const decision = await pursuit.decide(key, s.text || '', options);
    if (!decision) return false;
    if (pursuit.meter.calls > before)
      this.emit({
        type: 'pursuit',
        at: this.now(),
        state: key,
        url: s.url,
        answered: decision.answered,
        found: decision.found,
        answer: decision.answer.slice(0, 500),
        next: decision.next,
        reason: decision.reason.slice(0, 300),
      });
    if (decision.answered) {
      // Absence is only proven by exhausting the scope: keep exploring, keep the answer as provisional.
      pursuit.result = { ...decision, state: key, url: s.url, at: this.now(), provisional: !decision.found };
      if (decision.found) return true;
    } else if (pursuit.result?.provisional) pursuit.result = undefined;
    const row = decision.next ? rows.find(r => pick(r) === decision.next) : undefined;
    this.steer = row && { state: key, row };
    return false;
  }

  private choose(s: Snapshot): Candidate | undefined {
    // A secondary page with its budget spent: only overlays (to close them) or a way back.
    const page = pagePath(s.url),
      spent = page !== pagePath(this.options.url) && (this.pageCounts.get(page) || 0) >= this.options.pageActions;
    if (spent && !activeOverlay(s)) {
      this.lastCandidates = [];
      return;
    }
    const rows = this.candidates(s);
    this.lastCandidates = rows.map(r => r.classKey);
    // Goal pursuit: the action the LLM picked for this state goes first.
    if (this.steer?.state === stateKey(s)) {
      const picked = this.steer.row;
      this.steer = undefined;
      this.picked.add(pick(picked));
      this.options.pursuit!.steered++;
      return picked;
    }
    const overlay = activeOverlay(s);
    // Inside an overlay, explore its content before its exits so it is not dismissed early.
    if (overlay) {
      const exits = new Set(overlay.exitControlIds);
      return rows.find(r => !exits.has(r.control.localId)) || rows[0];
    }
    return rows[0];
  }

  private async act(before: Snapshot, c: Candidate) {
    this.lastText = before.text || '';
    this.pageCounts.set(pagePath(before.url), (this.pageCounts.get(pagePath(before.url)) || 0) + 1);
    const beforeKey = stateKey(before),
      overlay = activeOverlay(before);
    let outcome: 'ok' | 'failed' | 'no_change' = 'ok',
      error: string | undefined;
    this.intercepted = undefined;
    this.popup = undefined;
    const urlBefore = this.page.url();
    this.lastTarget = undefined;
    this.actionShot = undefined;
    this.shootFor = this.options.onScreenshot ? beforeKey : undefined;
    this.dispatching = true;
    try {
      await this.dispatch(c);
      await this.settle();
    } catch (e) {
      outcome = 'failed';
      error = String(e).slice(0, 200);
      // Covered on the first try: try once more later. Any other failure, or a failed retry, is final.
      if (!c.retry && /Target not actionable: covered by/.test(error)) this.covered.set(c.classKey, beforeKey);
      else this.failedClasses.add(c.classKey);
    } finally {
      if (c.retry) this.covered.delete(c.classKey);
      this.dispatching = false;
    }
    // Fill resolves its sample (value, purpose, class key) during dispatch; count the final key.
    this.classCounts.set(c.classKey, (this.classCounts.get(c.classKey) || 0) + 1);
    const step: Step = {
      kind: c.kind,
      classKey: c.classKey,
      label: (c.control.name || c.control.label || c.control.role).slice(0, 60),
      value: c.value,
      purpose: c.purpose,
      ...(c.retry ? { retry: true } : {}),
      from: pagePath(before.url),
      state: beforeKey,
    };
    // Navigations are recorded, never followed by default. Set asynchronously during dispatch.
    const intercepted = this.intercepted as string | undefined,
      popup = this.popup as string | undefined;
    if (intercepted) this.recordLink('document', before.url, intercepted, step.label, 'intercepted');
    if (popup) this.recordLink('popup', before.url, popup, step.label, 'intercepted');
    // A navigation is the expected result of a link: it worked, so it is not a failure.
    if ((intercepted || popup) && outcome === 'failed' && /aborted|ERR_ABORTED/.test(error || '')) {
      outcome = 'ok';
      error = undefined;
    }
    const urlAfter = this.page.url();
    let routeChanged = false;
    if (urlAfter !== urlBefore && !this.routeClasses.has(c.classKey) && (await this.sameDocument(before))) {
      // Same document, new URL: hash change or history.pushState (SPA route).
      // Recorded on discovery and undone (history back, same document). The class then ranks
      // last; with inPageRoutes 'explore' it is re-run once all other in-page work is done.
      routeChanged = true;
      this.recordLink('same-document', urlBefore, urlAfter, step.label, 'reverted');
      await this.page.goBack({ timeout: 2000 }).catch(() => {});
      await this.settle();
      if (this.options.inPageRoutes === 'explore' && !this.routeClasses.has(c.classKey))
        this.classCounts.set(c.classKey, (this.classCounts.get(c.classKey) || 1) - 1);
    }
    if (!this.page.url().startsWith('http')) {
      await this.backtrack(before, 'capture_failed', true);
      return;
    }
    let after: Snapshot;
    try {
      after = await this.snapshot();
    } catch {
      await this.backtrack(before, 'capture_failed', true);
      return;
    }
    let afterKey = stateKey(after);
    // An input's effect is usually on other fields' values (a conversion result), not on structure.
    if (outcome === 'ok' && afterKey === beforeKey && c.kind === 'fill') {
      const values = (x: Snapshot) =>
        x.controls
          .filter(k => k.visible && k.localId !== c.control.localId && ['input', 'textarea'].includes(k.tag))
          .map(k => k.value)
          .join('\u0000');
      if (values(before) !== values(after)) afterKey = `${afterKey}|value:${c.classKey}`;
    }
    if (outcome === 'ok' && afterKey === beforeKey) {
      outcome = 'no_change';
      // Structure is unchanged; content may not be (chart range, panel text). Ask once per action class.
      const textBefore = before.text || '',
        textAfter = after.text || '';
      // Text that appeared (tooltips, expanded answers, popovers without dialog semantics),
      // as whole lines with live numbers masked; lines that only moved or ticked are ignored.
      const shown = new Set(textBlocks(textBefore)),
        appeared = textBlocks(textAfter).filter(line => !shown.has(line));
      if (textBefore && appeared.length) {
        // Without a judge, a text change beyond live numbers (e.g. an empty-result message) is new content.
        let changed = true;
        if (this.options.judge) {
          const answer = await this.options.judge.ask({
            kind: 'effect',
            action: `${c.kind} ${step.label}`,
            before: excerpt(textBefore, textAfter),
            after: appeared.slice(0, 12).join('\n'),
          });
          this.emit({
            type: 'judgement',
            at: this.now(),
            question: 'effect',
            label: step.label,
            verdict: answer.verdict,
            source: answer.source,
            probability: answer.probability,
            ...(answer.unrelated !== undefined ? { unrelated: answer.unrelated } : {}),
          });
          // Text did appear; only a confident "no" (live data drift, same content, or the page
          // changing by itself) rejects it.
          changed = answer.verdict !== 'no';
        }
        // The new state is keyed by what appeared, so the same tooltip reached twice is one state.
        if (changed) {
          outcome = 'ok';
          afterKey = `${afterKey}|content:${appeared.slice(0, 6).join('|')}`;
        }
      }
    }
    step.to = pagePath(after.url);
    if (outcome === 'ok') {
      step.sigBefore = pageSignature(before, beforeKey);
      step.sigAfter = pageSignature(after, afterKey);
      step.stateAfter = stateKey(after);
      // Revealed text only: structure (controls, overlay, URL) is where it was. A value typed into
      // a field is not text-only: later steps may read it.
      if (step.stateAfter === beforeKey && c.kind !== 'fill' && c.kind !== 'check' && step.to === step.from)
        step.textOnly = true;
      this.pushStep(step);
    }
    const isNew = !this.states.has(afterKey);
    // The first member of a mode group decides whether the rest are worth sampling.
    const group = c.kind === 'click' ? modeGroup(c.control, before.url, modeSiblings(before)) : undefined;
    // Clicking the already-selected member proves nothing about the others.
    const selected = c.control.selected.length > 0 || c.control.checked === true || c.control.pressed === true;
    if (group && !selected && !this.sampledModeGroups.has(group)) {
      this.sampledModeGroups.set(group, isNew);
      if (!isNew && outcome !== 'failed') this.flatModeGroups.add(group);
    }
    // Revealed text and typed values are states of their own. They are announced after the action
    // that produced them (below), like a structural state reached by it, while the page still shows them.
    const revealed = isNew && /\|(content|value):/.test(afterKey);
    this.emit({
      type: 'action',
      at: this.now(),
      step,
      url: before.url,
      overlay: overlay && `${overlay.kind}:${maskVolatile(overlay.name)}`,
      tier: c.tierName,
      outcome,
      error,
      newState: isNew,
      after: pagePath(after.url),
      ...(this.lastTarget ? { target: this.lastTarget } : {}),
      ...(this.actionShot ? { shot: this.actionShot } : {}),
    });
    if (revealed) await this.visit(after, afterKey, step);
    this.options.pursuit?.note(`${describe(c)} -> ${outcome}${isNew ? ', revealed new content' : ', nothing new'}`);
    if (routeChanged) this.routeClasses.add(c.classKey);
    // Left the allowed scope anyway (server redirect, followed navigation): return to entry.
    // A same-document route change (kept) is still the entry page's document, not a departure.
    const departed =
      !this.options.followNavigation &&
      pagePath(after.url) !== pagePath(this.options.url) &&
      after.documentId !== this.entryDocument;
    if (placementOfUrl(after.url, this.options) === 'outside' || departed) {
      this.failedClasses.add(c.classKey);
      await this.backtrack(after, 'left_scope');
    }
  }

  private async dispatch(c: Candidate) {
    await this.ensureActionable(c.control);
    if (c.kind === 'fill') return this.fill(c);
    await this.adapter.execute(
      { kind: c.kind, value: c.kind === 'check' ? c.value === 'true' : c.kind === 'press' ? 'Escape' : undefined },
      c.control,
    );
  }

  /** Static links are recorded from their href without clicking (once per destination page). */
  private noteLink(c: Control, base: string) {
    const target = linkTarget(c, base);
    if (target)
      this.recordLink(
        c.reviewBinding?.attributes.target === '_blank' ? 'popup' : 'document',
        base,
        target,
        (c.name || c.label).slice(0, 60),
        'intercepted',
      );
  }

  private recordLink(
    kind: 'document' | 'same-document' | 'popup',
    from: string,
    to: string,
    action: string,
    outcome: 'intercepted' | 'kept' | 'reverted' | 'followed',
  ) {
    const key = `${kind === 'same-document' ? kind : 'leave'}|${pagePath(from)}|${kind === 'same-document' ? to : pagePath(to)}`;
    const row = this.links.get(key);
    if (row) {
      row.count++;
      return;
    }
    this.links.set(key, { from: pagePath(from), to, kind, action, count: 1 });
    this.emit({ type: 'navigation', at: this.now(), kind, from, to, action, outcome });
  }

  /** True when the document that produced `before` is still loaded (no full page load happened). */
  private async sameDocument(before: Snapshot) {
    const id = await this.page
      .evaluate('window.__interactionEvidenceTracker && window.__interactionEvidenceTracker.documentId')
      .catch(() => undefined);
    return !!id && id === before.documentId;
  }

  /**
   * Fail in milliseconds instead of waiting for Playwright's actionability timeout when
   * the target is hidden, zero-sized, or covered at its click point by another element.
   */
  private async ensureActionable(control: Control) {
    const target = this.page.locator(control.selector);
    if ((await target.count()) !== 1) throw new Error('Target is no longer unique');
    await target.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    this.lastTarget = (await target.evaluate(measureInPage).catch(() => undefined)) as typeof this.lastTarget;
    await this.shootIfUnseen();
    const blocker = await target.evaluate(hitTestInPage).catch(() => 'detached');
    if (blocker) throw new Error(`Target not actionable: ${blocker}`);
  }

  /**
   * During an action (not a replay), screenshot the page as it is about to be acted on when the
   * state's own screenshot was taken at another scroll position: there the target cannot be shown.
   */
  private async shootIfUnseen() {
    const state = this.shootFor,
      target = this.lastTarget;
    this.shootFor = undefined;
    if (!state || !target || !this.options.onScreenshot) return;
    const seen = this.shotScroll.get(state);
    if (seen && Math.abs(seen.x - target.scroll.x) <= 1 && Math.abs(seen.y - target.scroll.y) <= 1) return;
    const image = await this.page.screenshot({ type: 'webp', quality: 80, timeout: 3000 }).catch(() => undefined);
    if (!image) return;
    this.actionShot = `action:${++this.actionShots}`;
    await this.options.onScreenshot(this.actionShot, image);
  }

  /** Classify the input (structure first, then JEV once per input class) and type one sample. */
  private async fill(c: Candidate) {
    const facts = await readInputFacts(this.page, c.control);
    if (!facts) throw new Error('Input target is no longer unique');
    const cls = this.classOf(c.control);
    let known = this.inputKinds.get(cls);
    if (!known) {
      const structural = classifyInput(facts);
      if (structural) known = { kind: structural, source: 'structure' };
      else if (this.options.inputJudge) {
        try {
          known = {
            kind: await judgeInputKind(
              this.options.inputJudge,
              facts,
              maskVolatile(c.control.displayedText || this.lastText.slice(0, 400)),
            ),
            source: 'jev',
          };
        } catch {
          known = { kind: 'text', source: 'default' };
        }
      } else known = { kind: 'text', source: 'default' };
      this.inputKinds.set(cls, known);
      this.emit({
        type: 'judgement',
        at: this.now(),
        question: 'input-kind',
        label: (facts.placeholder || facts.name || c.control.name).slice(0, 60),
        verdict: 'yes',
        source: known.source,
        probability: undefined,
        detail: known.kind,
      });
    }
    // Only the matching search term depends on the box; other samples skip the extra read.
    const scope = known.kind === 'search' && c.purpose !== 'empty' ? await readSearchScope(this.page, c.control) : [];
    const samples = inputSamples(known.kind, facts, this.lastText, scope);
    const sample = samples.find(x => x.purpose === c.purpose) || samples[0];
    c.value = sample.value;
    c.purpose = sample.purpose;
    // Re-key the first sample under its real purpose so the remaining samples stay pending.
    if (c.classKey.endsWith('|first')) {
      this.resolvedFills.add(c.classKey);
      c.classKey = c.classKey.replace(/\|first$/, `|${sample.purpose}`);
    }
    const target = this.page.locator(c.control.selector);
    await target.click({ timeout: 2000 });
    await target.fill(sample.value, { timeout: 2000 });
    // Search boxes commonly need Enter; only searches are submitted.
    if (known.kind === 'search') await target.press('Enter', { timeout: 2000 });
  }

  /** Return to the entry page and replay the recorded path minus its last step. */
  private async backtrack(current: Snapshot, reason: string, restore = false): Promise<boolean> {
    // An open overlay with nothing left: close it in place first.
    if (!restore && activeOverlay(current)) {
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.settle();
      const after = await this.snapshot();
      if (stateKey(after) !== stateKey(current)) {
        this.path.pop();
        this.emit({ type: 'backtrack', at: this.now(), reason: `${reason}:escape`, url: current.url });
        return true;
      }
    }
    if (!restore && !this.path.length && pagePath(current.url) === pagePath(this.options.url)) return false;

    // Restoring replays the whole path back to `current`. Otherwise drop the last step; on a
    // secondary page with nothing left, drop every step taken on it and the step that entered it,
    // so the replay does not land on the same exhausted page again.
    let replay = restore ? this.path : this.path.slice(0, -1);
    // Jump straight to the deepest state on the path that still has work, instead of stepping
    // back one replay at a time. A state's pending candidates are those it offered when last
    // seen, minus everything sampled or failed since. Landing on path[i] means replaying i steps.
    if (!restore) {
      let land = replay.length;
      while (land > 0 && !this.hasPendingWork(this.path[land].state)) land--;
      if (land === 0 && !this.hasPendingWork(this.path[0]?.state)) {
        // Nothing left anywhere on this path, the entry page included.
        if (!this.options.followNavigation && pagePath(current.url) === pagePath(this.options.url)) return false;
      }
      replay = this.path.slice(0, land);
    }
    const page = pagePath(current.url);
    if (!restore && page !== pagePath(this.options.url)) {
      let end = this.path.length;
      while (end > 0 && this.path[end - 1].from === page) end--;
      replay = this.path.slice(0, Math.max(0, end - 1));
    }
    this.emit({ type: 'backtrack', at: this.now(), reason, url: current.url });
    // Fast path: the replay target ends where an earlier page was entered and nothing was done
    // on that page since, so the browser history already holds it. Go back instead of replaying.
    if (await this.historyBack(replay)) return true;
    // Cheaper still: the state to return to may be one gesture away (a hover to leave, a popup to
    // close). Try that in place and keep it only if the page is in exactly that state.
    if (!restore && (await this.undoInPlace(replay))) return true;
    // Every page here was reached by an ordinary link, so its URL loads it directly. Start the
    // replay from the last page boundary in the kept path; only that page's in-page steps remain.
    let start = replay.length;
    while (start > 0 && replay[start - 1].to === replay[start - 1].from) start--;
    const resume = start > 0 ? replay[start - 1].to! : pagePath(this.options.url);
    await this.restoreInitialStorage();
    await this.page.goto(start > 0 ? resume : this.options.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.settle();
    if (start > 0 && pagePath(this.page.url()) !== resume) {
      // Redirected or blocked: fall back to the full replay from the entry.
      start = 0;
      await this.restoreInitialStorage();
      await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await this.settle();
    }
    if (start > 0) this.directLoads++;
    const steps = replay.slice(start);
    const trimmed = trimReplay(steps);
    // A replay cannot always reach its old state: a step may have changed something the site keeps
    // across loads (a chosen currency or language). Wherever it lands, the crawl carries on from
    // there, as it always has; replaying again would only land in the same place.
    this.trimmedSteps += steps.length - trimmed.length;
    if (!(await this.replaySteps(replay.slice(0, start), trimmed))) this.brokenReplays++;
    return true;
  }

  /** Cookies, localStorage and sessionStorage once the entry page has loaded. */
  private async saveInitialStorage() {
    const context = this.adapter.context;
    if (!context) return;
    try {
      const state = await context.storageState();
      const session = (await this.page.evaluate(
        'Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])',
      )) as [string, string][];
      this.initialStorage = { ...state, session: [{ origin: new URL(this.page.url()).origin, entries: session }] };
    } catch {
      /* Without a snapshot, reloads keep whatever the site stored, as before. */
    }
  }

  /**
   * Puts cookies and web storage back as they were at the start, before a reload, so a choice
   * made during the crawl does not carry over. Storage is written from the page still loaded,
   * which is on the entry's origin; the next document then starts from the saved values. Cookies
   * a session pins stay pinned: the driver re-adds them on every response.
   */
  private async restoreInitialStorage() {
    const context = this.adapter.context,
      initial = this.initialStorage;
    if (!context || !initial) return;
    try {
      await context.clearCookies();
      if (initial.cookies.length) await context.addCookies(initial.cookies);
      const origin = new URL(this.page.url()).origin;
      const local = initial.origins.find(o => o.origin === origin)?.localStorage.map(e => [e.name, e.value]) ?? [];
      const session = initial.session.find(o => o.origin === origin)?.entries ?? [];
      await this.page.evaluate(writeStorageInPage, [local, session] as [string[][], string[][]]);
      this.storageRestores++;
    } catch {
      /* A failed restore leaves the reload as it was before this existed. */
    }
  }

  /**
   * Reaches the end state of `replay` without reloading: move the pointer off whatever it hovers,
   * then press Escape, checking the state after each. Only an exact match of the structural
   * state counts; anything else leaves the reload and replay to do the work.
   */
  private async undoInPlace(replay: Step[]): Promise<boolean> {
    const target = replay.length ? replay.at(-1)?.stateAfter : this.path[0]?.state;
    if (!target) return false;
    const quick = Math.min(this.options.settleMs, REPLAY_SETTLE_MS);
    const gestures = [() => this.page.mouse.move(0, 0), () => this.page.keyboard.press('Escape')];
    for (const gesture of gestures) {
      await gesture().catch(() => {});
      await this.page.waitForTimeout(quick);
      if (stateKey(await this.snapshot()) === target) {
        this.path = [...replay];
        this.inPlaceBacks++;
        return true;
      }
    }
    return false;
  }

  /**
   * Replays steps from the current page; false when a step could not be found or performed. A
   * replayed step is a known action: it waits briefly, and the full settle time only when the next
   * step's target is not there yet.
   */
  private async replaySteps(kept: Step[], steps: Step[]): Promise<boolean> {
    this.path = [...kept];
    const quick = Math.min(this.options.settleMs, REPLAY_SETTLE_MS);
    for (const step of steps) {
      // A stopped replay loses its place on the path, so a target that is not there yet (a late
      // widget, a slow reload) is waited for, a few seconds at most.
      let candidate = this.candidatesForReplay(await this.snapshot(), step);
      for (let waited = 0; !candidate && waited < REPLAY_WAIT_MS; waited += this.options.settleMs) {
        await this.page.waitForTimeout(this.options.settleMs);
        candidate = this.candidatesForReplay(await this.snapshot(), step);
      }
      if (!candidate) return false;
      try {
        await this.dispatch(candidate);
        await this.page.waitForLoadState('domcontentloaded').catch(() => {});
        await this.page.waitForTimeout(quick);
        this.path.push(step);
      } catch {
        return false;
      }
    }
    // The last step's effect is the state to work in: give it the full settle time.
    await this.page.waitForTimeout(Math.max(0, this.options.settleMs - quick));
    return true;
  }

  /**
   * Browser back replaces replay when the dropped steps only left the target page: one
   * history entry per navigating step, and in-page steps on pages being left need no undo.
   * Leaving drops in-page state on the target too, so the kept path is trimmed to match.
   * The landing page is verified; anything unexpected falls back to replay from the entry.
   */
  /**
   * Append a step, then cut any loop it closes: if the page after this step looks exactly like
   * the page before some earlier step (same state, same masked text), the steps in between
   * (e.g. open a menu, close it) left nothing a replay needs to reproduce. Loops containing
   * input, check or navigation are kept: their effects (field values, URLs) are not fully
   * visible in the signature. Sampling counts are separate, so nothing tested is forgotten.
   */
  private pushStep(step: Step) {
    this.path.push(step);
    for (let i = this.path.length - 1; i >= 0; i--) {
      if (this.path[i].sigBefore !== step.sigAfter) continue;
      const loop = this.path.slice(i);
      if (loop.some(x => x.kind === 'fill' || x.kind === 'check' || x.from !== x.to)) return;
      this.path.splice(i);
      this.prunedSteps += loop.length;
      return;
    }
  }

  /** Whether a state still offers a candidate that has not been sampled or failed. */
  private hasPendingWork(state?: string) {
    if (!state) return true;
    const keys = this.pending.get(state);
    if (!keys) return true;
    return keys.some(key => {
      // A fill's placeholder key ('|first') is resolved to its real sample keys at dispatch.
      if (key.endsWith('|first')) return !this.resolvedFills.has(key);
      return (
        (this.covered.has(key) && this.covered.get(key) !== state) ||
        (!this.failedClasses.has(key) &&
          (this.classCounts.get(key) || 0) < (key.startsWith('fill|') ? 1 : this.budget(key)))
      );
    });
  }

  private async historyBack(replay: Step[]): Promise<boolean> {
    const dropped = this.path.slice(replay.length);
    const target = replay.length ? replay.at(-1)!.to : pagePath(this.options.url);
    const navigations = dropped.filter(step => step.to && step.to !== step.from).length;
    if (!target || !navigations || navigations > 3 || dropped.some(step => !step.to)) return false;
    // A dropped in-page step on the target itself would be state that back cannot undo.
    if (dropped.some(step => step.from === target && step.to === target)) return false;
    for (let i = 0; i < navigations; i++) {
      const ok = await this.page
        .goBack({ waitUntil: 'domcontentloaded', timeout: 5000 })
        .then(r => !!r)
        .catch(() => false);
      if (!ok) return false;
    }
    await this.settle();
    if (pagePath(this.page.url()) !== target) return false;
    let kept = replay.length;
    while (kept > 0 && replay[kept - 1].from === target && replay[kept - 1].to === target) kept--;
    this.path = replay.slice(0, kept);
    this.historyBacks++;
    return true;
  }

  private candidatesForReplay(s: Snapshot, step: Step): Candidate | undefined {
    for (const c of s.controls) {
      if (!c.visible) continue;
      // Fill keys carry a sample purpose suffix; replay types the recorded sample again.
      const base = step.kind === 'fill' ? step.classKey.slice(0, step.classKey.lastIndexOf('|')) : step.classKey;
      const kinds =
        isHintIcon(c) && !c.actions.length ? (['hover'] as CrawlKind[]) : kindsFor(c, this.confirmed, this.classOf);
      for (const kind of kinds)
        if (
          kind === step.kind &&
          `${kind}|${this.classOf(c)}` === base &&
          (c.name || c.label || c.role).slice(0, 60) === step.label
        )
          return {
            control: c,
            kind,
            classKey: step.classKey,
            tier: 0,
            tierName: 'replay',
            value: step.value,
            purpose: step.purpose,
          };
    }
  }
}

/** Wait after each replayed step; replays are known actions, and a miss falls back to the full settle. */
const REPLAY_SETTLE_MS = 150;
/** How long a replay waits for a step's target to appear before it stops. */
const REPLAY_WAIT_MS = 3000;

/**
 * The steps a replay needs. Left out:
 * - a step that only revealed text (a tooltip, an answer): the structural state is where it was,
 *   so the next step clicks the same place;
 * - typing into a field that the next step types into again: only the last value stays in it.
 * The last step always stays: its effect is the state to reach.
 */
export function trimReplay(steps: Step[]): Step[] {
  const field = (step: Step) => step.classKey.slice(0, step.classKey.lastIndexOf('|'));
  return steps.filter((step, i) => {
    if (i === steps.length - 1) return true;
    if (step.textOnly) return false;
    const next = steps[i + 1];
    return !(step.kind === 'fill' && next.kind === 'fill' && field(next) === field(step));
  });
}

// Built with new Function so the bundler cannot inject helpers into the serialized source.
const writeStorageInPage = new Function(
  'args',
  `const [local, session] = args;
  try { localStorage.clear(); for (const [k, v] of local) localStorage.setItem(k, v); } catch {}
  try { sessionStorage.clear(); for (const [k, v] of session) sessionStorage.setItem(k, v); } catch {}`,
) as (args: [string[][], string[][]]) => void;

// Built with new Function so the bundler cannot inject helpers into the serialized source.
const viewInPage = new Function(
  'return { scroll: { x: scrollX, y: scrollY }, viewport: { width: innerWidth, height: innerHeight } };',
) as () => unknown;

// Built with new Function so the bundler cannot inject helpers into the serialized source.
const measureInPage = new Function(
  'el',
  `const r = el.getBoundingClientRect();
  return { box: { x: r.left, y: r.top, width: r.width, height: r.height }, scroll: { x: scrollX, y: scrollY },
    viewport: { width: innerWidth, height: innerHeight } };`,
) as (el: Element) => unknown;

// Built with new Function so the bundler cannot inject helpers into the serialized source.
const hitTestInPage = new Function(
  'el',
  `const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  if (r.width < 1 || r.height < 1 || s.visibility === 'hidden' || s.display === 'none') return 'hidden';
  const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
  const hit = document.elementFromPoint(x, y);
  if (!hit || el === hit || el.contains(hit) || hit.contains(el)) return '';
  return 'covered by ' + hit.tagName.toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ')[0] : '');`,
) as (el: Element) => string;

const emptyFacts = {
  type: '',
  inputmode: '',
  placeholder: '',
  pattern: '',
  autocomplete: '',
  ariaAutocomplete: '',
  ariaHaspopup: '',
  role: '',
  name: '',
  min: '',
  max: '',
  step: '',
  value: '',
};

function kindsFor(
  c: Control,
  confirmed?: ReadonlySet<string>,
  classOf: (c: Control) => string = baseClass,
): CrawlKind[] {
  const basis = c.actionBasis || ({} as NonNullable<Control['actionBasis']>);
  const kinds: CrawlKind[] = [];
  if (c.actions.includes('fill') && c.editable && ['input', 'textarea'].includes(c.tag)) return ['fill'];
  if (c.actions.includes('check')) kinds.push('check');
  else if (c.actions.includes('click') || confirmed?.has(classOf(c))) kinds.push('click');
  // Hover only where the page declares a hover-driven disclosure.
  // Hover where the page declares or hints at a hover-driven disclosure (menus, tooltips).
  const popup =
    c.reviewBinding?.attributes['aria-haspopup'] ||
    c.reviewBinding?.attributes['aria-describedby'] ||
    c.reviewBinding?.attributes.title;
  if (
    c.actions.includes('hover') &&
    (basis.hover?.status === 'supported' ||
      c.expanded !== null ||
      c.controls ||
      popup ||
      (basis.hover?.status === 'tentative' && c.landmark))
  )
    kinds.push('hover');
  return kinds;
}

function placementOfUrl(url: string, options: { url: string; policy: CrawlPolicy }) {
  try {
    const u = new URL(url),
      e = new URL(options.url);
    if (pagePath(url) === pagePath(options.url)) return 'stay';
    return u.origin === e.origin && options.policy.allowedPaths.some(p => p.test(u.pathname)) ? 'navigate' : 'outside';
  } catch {
    return 'outside';
  }
}

/** The differing middle of two page texts, bounded for a model question. */
function excerpt(text: string, other: string, size = 600) {
  let start = 0;
  while (start < text.length && text[start] === other[start]) start++;
  return text.slice(Math.max(0, start - 100), start - 100 + size);
}

/** Combined JEV / LLM spend for the run summary. */
function modelCost(jev: (ProviderMeter | undefined)[], llm: (ProviderMeter | undefined)[]) {
  const sum = (meters: (ProviderMeter | undefined)[]) =>
    meters
      .filter((m): m is ProviderMeter => !!m)
      .reduce(
        (t, m) => ({
          calls: t.calls + m.calls,
          failures: t.failures + m.failures,
          judgments: t.judgments + m.judgments,
          inputTokens: t.inputTokens + m.inputTokens,
          outputTokens: t.outputTokens + m.outputTokens,
          costUsd: t.costUsd + m.costUsd,
          unpricedCalls: t.unpricedCalls + m.unpricedCalls,
          avgMs: 0,
          elapsedMs: t.elapsedMs + m.elapsedMs,
        }),
        {
          calls: 0,
          failures: 0,
          judgments: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          unpricedCalls: 0,
          avgMs: 0,
          elapsedMs: 0,
        },
      );
  const withAvg = (t: ReturnType<typeof sum>) => ({ ...t, avgMs: t.calls ? Math.round(t.elapsedMs / t.calls) : 0 });
  return { jev: withAvg(sum(jev)), llm: withAvg(sum(llm)) };
}

/** One specific action on one specific control, as the model picks it. */
const pick = (r: Candidate) => `${r.kind}|${r.control.localId}|${r.purpose ?? ''}`;

/** A candidate action as a model reads it. */
function describe(r: Candidate) {
  const c = r.control;
  return `${r.kind} ${c.role} "${maskVolatile(c.name || c.label)}"${c.landmark ? ` in site ${c.landmark}` : ''}`;
}

/** Visible text split into comparable blocks, live numbers masked, tiny fragments dropped. */
function textBlocks(text: string) {
  return [
    ...new Set(
      text
        .split(/\n+/)
        .map(line => maskVolatile(line, 200))
        .filter(line => line.length >= 3),
    ),
  ];
}

/** What a replay must reproduce: the abstract state plus the visible text with live numbers masked. */
function pageSignature(s: Snapshot, key: string) {
  return `${key}\u0000${maskVolatile(s.text || '', Infinity)}`;
}

/**
 * Members worth asking about: names that are not variants of one pattern. Records of one kind
 * usually share words (e.g. "BTC to PKR", "BTC to EUR"); different functions usually share none.
 */
function distinctNames(names: string[]) {
  const words = names.map(
    n =>
      new Set(
        n
          .toLowerCase()
          .split(/[^\p{L}\p{N}#]+/u)
          .filter(w => w.length > 1),
      ),
  );
  let shared = 0,
    pairs = 0;
  for (let i = 0; i < words.length; i++)
    for (let j = i + 1; j < words.length; j++) {
      pairs++;
      if ([...words[i]].some(w => words[j].has(w))) shared++;
    }
  return pairs > 0 && shared / pairs < 0.5;
}

/** Pathname without trailing slash, locale prefix kept. */
function rawPath(url: string) {
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

const findingsOf = (result: PluginResult) => (Array.isArray(result) ? result : result.findings);
